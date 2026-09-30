/**
 * `SnmpQuery`: read (get, walk) and change (set) SNMP values on network gear,
 * with a community string or SNMPv3 keys the agent never sees.
 *
 * SNMP's secrets are unusually easy to leak by accident: a v2c community is
 * sent in every packet (so it must only ever go to the device it belongs to),
 * and walking the wrong subtree of some devices returns their *own* configured
 * communities and keys in the output. So: the credential is resolved for the
 * exact host, results pass the redactor (which knows the community) and the
 * unknown-secret mask, and a `set` — a configuration change on a switch,
 * UPS or printer — is a person's decision every time, like any destructive
 * command.
 *
 * Library: `net-snmp` (MIT, pure JavaScript, maintained, two small MIT
 * dependencies). It also ships an SNMP agent, which is what the test suite
 * talks to — no device and no system service needed. See ADR 0007.
 *
 * v3 protocols are not secrets and are arguments: SHA-1 auth and AES-128
 * privacy by default. DES is refused rather than silently enabled through
 * OpenSSL's legacy provider.
 *
 * @module tools/ops/snmp
 */

import {
  checkRate, clampSeconds, credentialLabel, MASK_NOTE, maskUnknownSecrets, normaliseHost, openOp, OpsError, useCredential,
  validHost, validPort,
} from './common.js';

/* The slice of net-snmp's (untyped) API used here. */
interface Varbind { oid: string; type: number; value: unknown }
interface SnmpSession {
  get(oids: string[], cb: (err: Error | null, vbs?: Varbind[]) => void): void;
  subtree(oid: string, maxRepetitions: number, feed: (vbs: Varbind[]) => boolean | void, done: (err: Error | null) => void): void;
  set(vbs: Array<{ oid: string; type: number; value: unknown }>, cb: (err: Error | null, vbs?: Varbind[]) => void): void;
  close(): void;
  on(event: 'error', cb: (err: Error) => void): void;
}
interface NetSnmp {
  Version2c: number;
  Version3: number;
  SecurityLevel: Record<'noAuthNoPriv' | 'authNoPriv' | 'authPriv', number>;
  AuthProtocols: Record<string, number>;
  PrivProtocols: Record<string, number>;
  ObjectType: Record<string, number>;
  createSession(target: string, community: string, options: Record<string, unknown>): SnmpSession;
  createV3Session(target: string, user: Record<string, unknown>, options: Record<string, unknown>): SnmpSession;
  isVarbindError(vb: Varbind): boolean;
  varbindError(vb: Varbind): string;
}

let loading: Promise<NetSnmp> | undefined;
function loadSnmp(): Promise<NetSnmp> {
  // @ts-expect-error net-snmp ships no type declarations; the slice used is typed above.
  loading ??= import('net-snmp').then((m: { default?: NetSnmp }) => (m.default ?? m) as NetSnmp);
  return loading;
}

export interface SnmpQueryInput {
  host: string;
  port?: number;
  credential: string;
  action: 'get' | 'walk' | 'set';
  oids?: string[];
  oid?: string;
  set?: Array<{ oid: string; type: string; value: string | number }>;
  version?: 'v2c' | 'v3';
  auth_protocol?: 'md5' | 'sha' | 'sha224' | 'sha256' | 'sha384' | 'sha512';
  priv_protocol?: 'aes' | 'aes256b' | 'aes256r';
  max_rows?: number;
  timeout?: number;
}

const OID_RE = /^\.?\d+(?:\.\d+){1,127}$/;
const SET_TYPES = ['Integer', 'OctetString', 'ObjectIdentifier', 'IpAddress', 'Counter', 'Gauge', 'TimeTicks', 'Counter64'] as const;

/** Validate OIDs (numeric form only: MIB names would need MIB files, and a typo would walk the wrong tree). */
export function validOid(oid: unknown): oid is string {
  return typeof oid === 'string' && OID_RE.test(oid.trim());
}

/** Render a varbind value as text. OctetStrings print as text when printable, hex otherwise. Pure. */
export function renderValue(value: unknown): string {
  if (Buffer.isBuffer(value)) {
    const s = value.toString('utf8');
    return /^[\x20-\x7e\t\r\n]*$/.test(s) ? s : `0x${value.toString('hex')}`;
  }
  if (value === null || value === undefined) return '';
  return String(value);
}

function typeName(snmp: NetSnmp, type: number): string {
  for (const [name, n] of Object.entries(snmp.ObjectType)) if (n === type) return name;
  return String(type);
}

function call<T>(fn: (cb: (err: Error | null, v?: T) => void) => void, timeoutMs: number, signal?: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let done = false;
    const timer = setTimeout(() => { if (!done) { done = true; reject(new OpsError('The device did not answer in time (wrong community/keys, or UDP blocked?).')); } }, timeoutMs + 1000);
    timer.unref?.();
    const onAbort = (): void => { if (!done) { done = true; clearTimeout(timer); reject(new OpsError('Cancelled.')); } };
    signal?.addEventListener('abort', onAbort, { once: true });
    fn((err, v) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (err) reject(new OpsError(`SNMP: ${err.message.slice(0, 200)}`));
      else resolve(v as T);
    });
  });
}

export async function snmpQuery(input: SnmpQueryInput, signal?: AbortSignal): Promise<Record<string, unknown>> {
  if (!validHost(input.host)) throw new OpsError('`host` must be a host name or IP address.');
  const host = normaliseHost(input.host);
  const port = validPort(input.port, 161);
  const action = input.action;
  if (!['get', 'walk', 'set'].includes(action)) throw new OpsError('`action` must be get, walk or set.');
  const oids = action === 'get' ? (input.oids ?? (input.oid ? [input.oid] : [])) : [];
  if (action === 'get' && (!oids.length || !oids.every(validOid))) throw new OpsError('`oids` must be numeric OIDs, e.g. ["1.3.6.1.2.1.1.5.0"].');
  if (action === 'walk' && !validOid(input.oid)) throw new OpsError('`oid` must be a numeric OID to walk under, e.g. "1.3.6.1.2.1.1".');
  const sets = action === 'set' ? (input.set ?? []) : [];
  if (action === 'set') {
    if (!sets.length) throw new OpsError('`set` needs at least one {oid, type, value}.');
    for (const s of sets) {
      if (!validOid(s.oid)) throw new OpsError(`"${String(s.oid).slice(0, 40)}" is not a numeric OID.`);
      if (!(SET_TYPES as readonly string[]).includes(s.type)) throw new OpsError(`type must be one of ${SET_TYPES.join(', ')}.`);
    }
  }
  const maxRows = Math.min(Math.max(1, Math.round(Number(input.max_rows) || 500)), 5000);
  const timeoutMs = clampSeconds(input.timeout, 5, 60) * 1000;
  const target = port === 161 ? host : `${host}:${port}`;
  checkRate('SnmpQuery', host);

  const describe = action === 'set'
    ? `SET ${sets.map(s => `${s.oid}=${s.type}:${String(s.value).slice(0, 60)}`).join(', ')}`
    : action === 'walk' ? `WALK ${input.oid}` : `GET ${oids.join(', ')}`;
  const op = openOp({ tool: 'SnmpQuery', target, credential: credentialLabel(input.credential ?? ''), summary: describe });
  let session: SnmpSession | undefined;
  try {
    const snmp = await loadSnmp();
    const secret = await useCredential(input.credential, {
      tool: 'SnmpQuery', host: target,
      purpose: `${action === 'set' ? 'CHANGE DEVICE CONFIG. ' : ''}SnmpQuery ${describe} on ${target}`,
      requireApproval: action === 'set',
    });
    let version: 'v2c' | 'v3';
    try {
      if (secret.kind !== 'snmp' && secret.kind !== 'generic') throw new OpsError(`The credential "${secret.name}" is a ${secret.kind}, not an SNMP credential.`);
      const f = secret.fields;
      version = input.version ?? (f.authKey ? 'v3' : 'v2c');
      const options = { port, timeout: timeoutMs, retries: 1, transport: host.includes(':') ? 'udp6' : 'udp4' };
      if (version === 'v2c') {
        const community = f.community ?? f.value;
        if (!community) throw new OpsError(`The credential "${secret.name}" has no community string.`);
        session = snmp.createSession(host, community, { ...options, version: snmp.Version2c });
      } else {
        if (!secret.username) throw new OpsError(`SNMPv3 needs a user name on the credential "${secret.name}".`);
        const authProtocol = snmp.AuthProtocols[input.auth_protocol ?? 'sha'];
        const privProtocol = snmp.PrivProtocols[input.priv_protocol ?? 'aes'];
        if (authProtocol === undefined) throw new OpsError('Unknown auth_protocol.');
        if (privProtocol === undefined) throw new OpsError('Unknown priv_protocol (DES is not offered: it is broken and needs OpenSSL\'s legacy provider).');
        const level = f.privKey ? snmp.SecurityLevel.authPriv : f.authKey ? snmp.SecurityLevel.authNoPriv : snmp.SecurityLevel.noAuthNoPriv;
        session = snmp.createV3Session(host, {
          name: secret.username, level,
          ...(f.authKey ? { authProtocol, authKey: f.authKey } : {}),
          ...(f.privKey ? { privProtocol, privKey: f.privKey } : {}),
        }, { ...options, version: snmp.Version3 });
      }
    } finally {
      secret.release();
    }
    session.on('error', () => { /* surfaced through the request callbacks */ });
    const s = session;

    const rows: Array<{ oid: string; type: string; value: string; error?: string }> = [];
    const push = (vb: Varbind): void => {
      if (snmp.isVarbindError(vb)) rows.push({ oid: vb.oid, type: 'error', value: '', error: snmp.varbindError(vb) });
      else rows.push({ oid: vb.oid, type: typeName(snmp, vb.type), value: renderValue(vb.value) });
    };
    let truncated = false;
    if (action === 'get') {
      (await call<Varbind[]>(cb => s.get(oids.map(o => o.replace(/^\./, '')), cb), timeoutMs, signal)).forEach(push);
    } else if (action === 'walk') {
      await call<void>(cb => s.subtree(input.oid!.replace(/^\./, ''), 20, (vbs) => {
        for (const vb of vbs) {
          if (rows.length >= maxRows) { truncated = true; return true; }
          push(vb);
        }
        return undefined;
      }, (err) => cb(err)), Math.max(timeoutMs * 6, 30_000), signal);
    } else {
      const vbs = sets.map(x => ({
        oid: x.oid.replace(/^\./, ''),
        type: snmp.ObjectType[x.type]!,
        value: x.type === 'OctetString' || x.type === 'IpAddress' || x.type === 'ObjectIdentifier' ? String(x.value) : Number(x.value),
      }));
      (await call<Varbind[]>(cb => s.set(vbs, cb), timeoutMs, signal)).forEach(push);
    }

    let masked = 0;
    for (const r of rows) {
      const m = maskUnknownSecrets(r.value);
      masked += m.masked;
      r.value = m.text;
    }
    const errors = rows.filter(r => r.error).length;
    op.done(`${rows.length} row(s)${errors ? `, ${errors} error(s)` : ''}`);
    return {
      host, port, version: version!, action, credential: credentialLabel(input.credential), rows,
      ...(truncated ? { truncated: `stopped at max_rows=${maxRows}` } : {}),
      ...(action === 'set' ? { approved_as: 'device configuration change (SNMP set)' } : {}),
      ...(masked ? { notes: [MASK_NOTE] } : {}),
      work_id: op.id,
    };
  } catch (err) {
    op.fail(err instanceof Error ? err.message : String(err));
    throw err;
  } finally {
    try { session?.close(); } catch { /* closed */ }
  }
}

export const snmpQueryDefinition = {
  name: 'SnmpQuery',
  description: 'Query network devices over SNMP with a stored credential you never see (v2c community, or v3 user with '
    + 'auth/priv keys). get: numeric OIDs; walk: everything under one OID (max_rows caps it); set: change values — always '
    + 'shown to a person to approve. Results come back as a table.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      host: { type: 'string' },
      port: { type: 'number', description: 'Default 161.' },
      credential: { type: 'string', description: 'Stored snmp credential name.' },
      action: { type: 'string', enum: ['get', 'walk', 'set'] },
      oids: { type: 'array', items: { type: 'string' }, description: 'get: numeric OIDs, e.g. 1.3.6.1.2.1.1.5.0 (sysName).' },
      oid: { type: 'string', description: 'walk: the subtree root, e.g. 1.3.6.1.2.1.2.2 (interfaces).' },
      set: {
        type: 'array',
        items: {
          type: 'object',
          properties: { oid: { type: 'string' }, type: { type: 'string', enum: [...SET_TYPES] }, value: { type: ['string', 'number'] } },
          required: ['oid', 'type', 'value'],
        },
      },
      version: { type: 'string', enum: ['v2c', 'v3'], description: 'Default: v3 when the credential has an authKey.' },
      auth_protocol: { type: 'string', enum: ['md5', 'sha', 'sha224', 'sha256', 'sha384', 'sha512'], description: 'v3, default sha.' },
      priv_protocol: { type: 'string', enum: ['aes', 'aes256b', 'aes256r'], description: 'v3, default aes.' },
      max_rows: { type: 'number', description: 'walk: default 500, max 5000.' },
      timeout: { type: 'number', description: 'Seconds per request, default 5.' },
    },
    required: ['host', 'credential', 'action'],
  },
};
