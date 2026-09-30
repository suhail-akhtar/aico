/**
 * SSH for the agent: run commands (`SshExec`), move files (`SshCopy`) and
 * reach a web UI bound to a server's localhost (`SshTunnel`) — with a stored
 * credential it can use and never see.
 *
 * ## Why `ssh2` and not the system `ssh`
 *
 * The system client needs the secret *outside* this process: a password only
 * reaches it through `SSH_ASKPASS` (a helper program that prints the password
 * — which is the value on a pipe to a child we then have to trust, and
 * `SSH_ASKPASS_REQUIRE` only exists on newer OpenSSH), and a key has to be a
 * file on disk. Windows' OpenSSH refuses a key file whose ACL it does not
 * like, and Node cannot set Windows ACLs, so the "0600 temp file" route is not
 * portable either. `ssh2` is pure JavaScript (its native bits are optional
 * and absent here), MIT-licensed, maintained, and takes the password or key
 * as an in-memory argument: no temp file, no argv, no helper, on every OS.
 * It also lets host-key verification be *our* code rather than a flag we
 * hope was not set to `no`. See ADR 0007.
 *
 * ## The order of a connection
 *
 *  1. The host key. A host already in `<AICO_HOME>/ops/known_hosts` must
 *     present the pinned key or nothing further happens. An unknown host is
 *     probed first (a connection that only reads the key and hangs up), so
 *     the key can be shown to a person *before* any credential is released.
 *  2. The credential, resolved through the broker for exactly this host —
 *     with `requireApproval` when the key is new or the command destructive,
 *     so the person sees the fingerprint and the command.
 *  3. The real connection, accepting only the key that was shown. The key is
 *     written to known_hosts only after that succeeds.
 *
 * Everything the far side prints goes back through the redactor (known
 * values) and the unknown-secret mask; the credential never appears in the
 * exec request, the approval, the ledger or the result.
 *
 * @module tools/ops/ssh
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Client, ClientChannel, ConnectConfig, SFTPWrapper } from 'ssh2';
import { aicoHome } from '../../home.js';
import { currentCwd } from '../../run-context.js';
import { getVault } from '../../vault/index.js';
import { isInside } from '../../vault/guard.js';
import { parsePlaceholders } from '../../vault/placeholders.js';
import { sinkRedactText, sinkStream } from '../../vault/sink.js';
import type { CredentialKind } from '../../vault/types.js';
import {
  appendCapped, captureSecret, checkRate, clampSeconds, credentialLabel, MASK_NOTE, maskUnknownSecrets, normaliseHost,
  openOp, OpsError, progressReporter, useCredential, validHost, validPort, type OpRecord,
} from './common.js';
import { classifyRemoteCommand } from './destructive.js';
import { checkHostKey, fingerprintOf, hasEntryFor, keyTypeOf, knownHostsPath, readKnownHosts, trustHostKey } from './known-hosts.js';
import { lineSafe, MarkerWatch, planRemoteCommand, type RemotePlan } from './ssh-command.js';

type Ssh2 = typeof import('ssh2');
let ssh2Loading: Promise<Ssh2> | undefined;

/**
 * Loaded on first use: most sessions never open an SSH connection.
 *
 * Bundled into an ES module — AICO Desktop's engine is one esbuild ESM file —
 * ssh2's CommonJS code reads a free `__dirname` while loading (to locate
 * Windows Pageant's helper, which AICO never uses), and ESM defines none, so
 * the import threw `ReferenceError` there and SSH was dead in the desktop app
 * while every Node test passed. A global stands in for the duration of the
 * import only; unbundled, ssh2's own module wrapper shadows it and it is inert.
 */
function loadSsh2(): Promise<Ssh2> {
  ssh2Loading ??= (async () => {
    const g = globalThis as { __dirname?: string };
    const shim = typeof g.__dirname === 'undefined';
    if (shim) g.__dirname = path.dirname(fileURLToPath(import.meta.url));
    try {
      const m = await import('ssh2');
      return ((m as unknown as { default?: Ssh2 }).default ?? m) as Ssh2;
    } finally {
      if (shim) delete g.__dirname;
    }
  })().catch((err: unknown) => { ssh2Loading = undefined; throw err; });
  return ssh2Loading;
}

const DEFAULT_TIMEOUT_S = 120;
const MAX_FOREGROUND_S = 30 * 60;
const MAX_BACKGROUND_S = 24 * 60 * 60;
const CONNECT_TIMEOUT_MS = 20_000;
/** Concurrent connections per host, across foreground calls, background runs and tunnels. */
const MAX_CONNECTIONS_PER_HOST = 6;

/**
 * AES-GCM and AES-CTR only: done by Node's own crypto. ssh2's
 * chacha20-poly1305 lazily loads an Emscripten module that reads `__dirname`
 * when first used — after the import-time shim below is gone, inside an ESM
 * bundle (AICO Desktop) that has none. Not offering it removes that path
 * rather than hoping it is never negotiated. Every OpenSSH of the last
 * fifteen years offers these.
 */
const CIPHERS = ['aes256-gcm@openssh.com', 'aes128-gcm@openssh.com', 'aes256-ctr', 'aes192-ctr', 'aes128-ctr'] as const;

const SSH_KINDS: ReadonlySet<CredentialKind> = new Set(['ssh-password', 'ssh-key', 'login', 'basic-auth', 'generic', 'winrm']);

const openPerHost = new Map<string, number>();
function claimConnection(host: string): () => void {
  const n = openPerHost.get(host) ?? 0;
  if (n >= MAX_CONNECTIONS_PER_HOST) {
    throw new OpsError(`Already ${n} SSH connections open to ${host}. Wait for a background run to finish or stop a tunnel (Supervise).`);
  }
  openPerHost.set(host, n + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    openPerHost.set(host, Math.max(0, (openPerHost.get(host) ?? 1) - 1));
  };
}

// ── approval text (pure) ─────────────────────────────────────────────

/**
 * What the person reads before a credential is released. Warnings first, so
 * they are inside the part the broker shows even if the rest is long.
 */
export function sshPurpose(p: {
  tool: string; user: string; host: string; port: number; action: string;
  destructive?: string[]; unknownKey?: { keyType: string; fingerprint: string };
}): string {
  const where = `${p.user}@${p.host}${p.port === 22 ? '' : `:${p.port}`}`;
  const parts: string[] = [];
  if (p.destructive?.length) parts.push(`DESTRUCTIVE (${p.destructive.join(', ')}).`);
  if (p.unknownKey) {
    parts.push(`FIRST CONNECTION to ${p.host}:${p.port}; it presents ${p.unknownKey.keyType} key ${p.unknownKey.fingerprint}. `
      + 'Approving also trusts this key for later connections.');
  }
  parts.push(`${p.tool} as ${where}: ${p.action}`);
  return parts.join(' ');
}

// ── connecting ───────────────────────────────────────────────────────

/** Read a server's host key without authenticating: connect, capture it in the verifier, refuse, hang up. */
export async function probeHostKey(host: string, port: number, timeoutMs = CONNECT_TIMEOUT_MS): Promise<Buffer> {
  const { Client } = await loadSsh2();
  return new Promise<Buffer>((resolve, reject) => {
    const client = new Client();
    let key: Buffer | undefined;
    let settled = false;
    const settle = (err?: Error): void => {
      if (settled) return;
      settled = true;
      try { client.end(); } catch { /* already closed */ }
      if (key) resolve(key);
      else reject(err ?? new OpsError(`${host}:${port} closed the connection before presenting a host key.`));
    };
    client.on('error', (err) => settle(connectError(err, host, port)));
    client.on('close', () => settle());
    client.connect({
      host, port, username: 'aico-hostkey-probe', readyTimeout: timeoutMs, algorithms: { cipher: [...CIPHERS] },
      hostVerifier: (k: Buffer) => { key = Buffer.from(k); return false; },
    });
  });
}

/** Explain a connection failure in terms the model can act on. Never includes a credential. */
function connectError(err: unknown, host: string, port: number): OpsError {
  const e = err as { code?: string; level?: string; message?: string };
  const msg = e?.message ?? String(err);
  if (e?.code === 'ECONNREFUSED') return new OpsError(`Nothing is listening for SSH on ${host}:${port} (connection refused).`);
  if (e?.code === 'ENOTFOUND' || e?.code === 'EAI_AGAIN') return new OpsError(`The host name ${host} does not resolve.`);
  if (e?.code === 'ETIMEDOUT' || /Timed out while waiting for handshake/i.test(msg)) {
    return new OpsError(`${host}:${port} did not answer in time (is it up, and is port ${port} open to this machine?).`);
  }
  if (e?.level === 'client-authentication' || /authentication methods failed/i.test(msg)) {
    return new OpsError(`${host} rejected the stored credential (authentication failed). Check the username, or ask the owner to update the credential.`);
  }
  if (/verification failed|Host denied/i.test(msg)) {
    return new OpsError(`The host key presented by ${host}:${port} is not the one that was approved; nothing was sent.`);
  }
  return new OpsError(`SSH to ${host}:${port} failed: ${sinkRedactText(msg).slice(0, 300)}`);
}

interface ConnectAuth { password?: string; privateKey?: string; passphrase?: string }

async function openClient(opts: {
  host: string; port: number; username: string; auth: ConnectAuth;
  accept: (blob: Buffer) => boolean; signal?: AbortSignal;
}): Promise<Client> {
  const { Client } = await loadSsh2();
  return new Promise<Client>((resolve, reject) => {
    const client = new Client();
    let settled = false;
    const onAbort = (): void => { if (!settled) { settled = true; try { client.end(); } catch { /* closed */ } reject(new OpsError('Cancelled.')); } };
    if (opts.signal?.aborted) { onAbort(); return; }
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    client.on('ready', () => {
      if (settled) return;
      settled = true;
      opts.signal?.removeEventListener('abort', onAbort);
      resolve(client);
    });
    client.on('error', (err) => {
      if (settled) return;
      settled = true;
      opts.signal?.removeEventListener('abort', onAbort);
      reject(connectError(err, opts.host, opts.port));
    });
    // Some servers only offer keyboard-interactive for passwords. Answer a
    // prompt that asks for a password with it, and anything else with nothing.
    client.on('keyboard-interactive', (_name, _instr, _lang, prompts, finish) => {
      finish(prompts.map(p => (opts.auth.password && /pass(word|code)?/i.test(p.prompt) ? opts.auth.password : '')));
    });
    const config: ConnectConfig = {
      host: opts.host,
      port: opts.port,
      username: opts.username,
      readyTimeout: CONNECT_TIMEOUT_MS,
      algorithms: { cipher: [...CIPHERS] },
      keepaliveInterval: 15_000,
      keepaliveCountMax: 4,
      hostVerifier: (k: Buffer) => opts.accept(Buffer.from(k)),
      ...(opts.auth.password ? { password: opts.auth.password, tryKeyboard: true } : {}),
      ...(opts.auth.privateKey ? { privateKey: opts.auth.privateKey } : {}),
      ...(opts.auth.passphrase ? { passphrase: opts.auth.passphrase } : {}),
    };
    client.connect(config);
  });
}

export interface SshTargetInput {
  host: string;
  port?: number;
  credential: string;
  user?: string;
}

interface Established {
  client: Client;
  host: string;
  port: number;
  user: string;
  credential: string;
  hostKey: 'known' | 'trusted-now';
  fingerprint: string;
  /** Held only until sudo asks, then dropped. */
  sudoPassword?: string;
  release: () => void;
}

/**
 * Host key → credential → connection, in that order (see module header).
 * `action` is what the person is shown; `destructive` forces an approval.
 */
async function establish(input: SshTargetInput & {
  tool: string; action: string; destructive: string[]; sudo?: boolean; sudoCredential?: string; signal?: AbortSignal;
}): Promise<Established> {
  if (!validHost(input.host)) throw new OpsError('`host` must be a host name or IP address.');
  const host = normaliseHost(input.host);
  const port = validPort(input.port, 22);
  const credential = credentialLabel(input.credential ?? '');
  checkRate(input.tool, host);

  // 1. The host key.
  const entries = readKnownHosts();
  let probed: Buffer | undefined;
  let unknownKey: { keyType: string; fingerprint: string } | undefined;
  if (!hasEntryFor(entries, host, port)) {
    probed = await probeHostKey(host, port);
    const check = checkHostKey(entries, host, port, probed);
    if (check.status === 'revoked') throw new OpsError(`${host}:${port} presented a key that is marked @revoked in ${knownHostsPath()}. Nothing was sent.`);
    unknownKey = { keyType: check.keyType, fingerprint: check.fingerprint };
  }

  // 2. The credential, for exactly this host.
  const meta = await describeCredential(input.credential);
  const user = input.user?.trim() || meta?.username;
  if (!user) throw new OpsError(`Say which user to log in as (\`user\`): the credential "${credential}" does not name one.`);
  if (meta?.username && input.user && input.user.trim() !== meta.username) {
    throw new OpsError(`The credential "${credential}" is for user "${meta.username}", not "${input.user.trim()}".`);
  }
  const purpose = sshPurpose({
    tool: input.tool, user, host, port, action: input.action,
    destructive: input.destructive, ...(unknownKey ? { unknownKey } : {}),
  });
  const secret = await useCredential(input.credential, {
    tool: input.tool, host: port === 22 ? host : `${host}:${port}`, purpose,
    requireApproval: Boolean(unknownKey) || input.destructive.length > 0,
  });
  let auth: ConnectAuth;
  let sudoPassword: string | undefined;
  try {
    if (!SSH_KINDS.has(secret.kind)) {
      throw new OpsError(`The credential "${secret.name}" is a ${secret.kind}, not something SSH can log in with.`);
    }
    const fields = secret.fields;
    if (secret.kind === 'ssh-key') {
      if (!fields.privateKey) throw new OpsError(`The credential "${secret.name}" has no private key.`);
      auth = { privateKey: fields.privateKey, ...(fields.passphrase ? { passphrase: fields.passphrase } : {}) };
    } else {
      auth = { password: secret.value() };
      if (input.sudo && !input.sudoCredential) sudoPassword = auth.password;
    }
  } finally {
    secret.release();
  }
  if (input.sudo && input.sudoCredential) {
    const sudoSecret = await useCredential(input.sudoCredential, {
      tool: input.tool, host: port === 22 ? host : `${host}:${port}`,
      purpose: `sudo password for ${user}@${host}, to run: ${input.action}`.slice(0, 2000),
    });
    try { sudoPassword = sudoSecret.value(); } finally { sudoSecret.release(); }
  }
  if (input.sudo && !sudoPassword) {
    throw new OpsError('sudo needs a password and this credential is a key. Pass `sudo_credential` naming the password credential.');
  }

  // 3. The connection, accepting only the key that was checked or shown.
  const releaseSlot = claimConnection(host);
  let presented: Buffer | undefined;
  let client: Client;
  try {
    client = await openClient({
      host, port, username: user, auth, ...(input.signal ? { signal: input.signal } : {}),
      accept: (blob) => {
        presented = blob;
        if (probed) return blob.equals(probed);
        return checkHostKey(readKnownHosts(), host, port, blob).status === 'match';
      },
    });
  } catch (err) {
    releaseSlot();
    if (presented && !probed) {
      const check = checkHostKey(readKnownHosts(), host, port, presented);
      if (check.status === 'mismatch') {
        throw new OpsError(`HOST KEY MISMATCH for ${host}:${port}: it now presents ${check.keyType} ${check.fingerprint}, but `
          + `${knownHostsPath()} pins ${check.expected.join(' / ')}. This can be a reinstalled server or someone intercepting the `
          + 'connection. Nothing was sent. Ask the owner to verify the new key and update that file; do not work around this.');
      }
    }
    throw err;
  } finally {
    // The login is done (or failed): drop our reference to it.
    auth = {};
  }
  let hostKey: Established['hostKey'] = 'known';
  if (probed) {
    trustHostKey(host, port, probed, `aico ${new Date().toISOString().slice(0, 10)}`);
    hostKey = 'trusted-now';
  }
  const fp = fingerprintOf(presented ?? probed ?? Buffer.alloc(0));
  let closed = false;
  const release = (): void => {
    if (closed) return;
    closed = true;
    try { client.end(); } catch { /* already closed */ }
    releaseSlot();
  };
  client.on('close', () => { closed = true; releaseSlot(); });
  return { client, host, port, user, credential, hostKey, fingerprint: fp, ...(sudoPassword ? { sudoPassword } : {}), release };
}

/** Username and kind of a credential, from metadata (no value), when the vault can say. */
async function describeCredential(ref: string): Promise<{ username?: string; kind: CredentialKind } | undefined> {
  try {
    const c = await getVault().get(ref);
    return { kind: c.kind, ...(c.username ? { username: c.username } : {}) };
  } catch { return undefined; }
}

// ── running a command ────────────────────────────────────────────────

interface ChannelOutcome {
  code: number | null;
  signal?: string;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  cancelled: boolean;
  sudoRejected: boolean;
}

function execChannel(client: Client, command: string): Promise<ClientChannel> {
  return new Promise((resolve, reject) => {
    client.exec(command, (err, channel) => (err ? reject(err) : resolve(channel)));
  });
}

/**
 * Drive one exec channel: feed sudo and the secret lines when asked, collect
 * output, enforce the deadline and cancellation.
 */
function runPlan(opts: {
  client: Client; plan: RemotePlan; values: string[]; sudoPassword?: string;
  timeoutMs: number; signal?: AbortSignal;
  onOutput?: (stream: 'stdout' | 'stderr', text: string) => void;
}): Promise<ChannelOutcome> {
  return new Promise<ChannelOutcome>((resolve) => {
    let stdout = '';
    let stderr = '';
    let code: number | null = null;
    let exitSignal: string | undefined;
    let timedOut = false;
    let cancelled = false;
    let sudoRejected = false;
    let settled = false;
    let channelRef: ClientChannel | undefined;
    let sudoPassword = opts.sudoPassword;
    let values: string[] | undefined = opts.values;

    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      sudoPassword = undefined;
      values = undefined;
      resolve({ code, ...(exitSignal ? { signal: exitSignal } : {}), stdout, stderr: watch.clean(stderr), timedOut, cancelled, sudoRejected });
    };
    const stop = (): void => {
      const ch = channelRef;
      if (!ch) return;
      try { ch.signal('TERM'); } catch { /* the server may not support signals */ }
      try { ch.close(); } catch { /* already closed */ }
      // A channel whose close is never acknowledged would hold the call open.
      setTimeout(finish, 2000).unref?.();
    };
    const timer = setTimeout(() => { timedOut = true; stop(); }, opts.timeoutMs);
    timer.unref?.();
    const onAbort = (): void => { cancelled = true; stop(); };
    if (opts.signal?.aborted) queueMicrotask(onAbort);
    else opts.signal?.addEventListener('abort', onAbort, { once: true });

    const watch = new MarkerWatch(opts.plan, {
      onSudoPrompt: (count) => {
        const ch = channelRef;
        if (!ch) return;
        if (count === 1 && sudoPassword !== undefined) {
          ch.write(`${sudoPassword}\n`);
          sudoPassword = undefined;
        } else {
          // Asked again: the password was wrong. Close stdin so sudo gives up.
          sudoRejected = true;
          try { ch.end(); } catch { /* closed */ }
        }
      },
      onReady: () => {
        const ch = channelRef;
        if (!ch) return;
        sudoPassword = undefined;
        for (const v of values ?? []) ch.write(`${v}\n`);
        values = undefined;
        try { ch.end(); } catch { /* closed */ }
      },
    });

    execChannel(opts.client, opts.plan.exec).then((channel) => {
      channelRef = channel;
      if (settled) { stop(); return; }
      if (!opts.plan.readyMarker) {
        // Nothing to feed: the command's stdin is empty, not a pipe it can wait on forever.
        try { channel.end(); } catch { /* closed */ }
      }
      channel.on('data', (d: Buffer) => {
        const t = d.toString('utf8');
        stdout = appendCapped(stdout, t);
        opts.onOutput?.('stdout', t);
      });
      channel.stderr.on('data', (d: Buffer) => {
        const t = d.toString('utf8');
        watch.push(t);
        stderr = appendCapped(stderr, t);
        opts.onOutput?.('stderr', watch.clean(t));
      });
      channel.on('exit', (c: number | null, s?: string) => {
        code = typeof c === 'number' ? c : null;
        if (s) exitSignal = String(s);
      });
      channel.on('close', finish);
    }, (err: unknown) => {
      stderr = `Could not start the command: ${err instanceof Error ? err.message : String(err)}`;
      finish();
    });
  });
}

export interface SshExecInput extends SshTargetInput {
  command: string;
  sudo?: boolean;
  sudo_credential?: string;
  cwd?: string;
  timeout?: number;
  background?: boolean;
  capture?: { name: string; kind?: CredentialKind; description?: string };
}

/** Resolve every `{{secret:…}}` in a command, for this host. Values leave only as stdin lines. */
async function resolvePlanValues(plan: RemotePlan, tool: string, host: string, port: number, command: string): Promise<string[]> {
  const values: string[] = [];
  for (const s of plan.secrets) {
    const secret = await useCredential(s.ref.raw, {
      tool, host: port === 22 ? host : `${host}:${port}`,
      purpose: `use in a command on ${host}: ${command}`.slice(0, 2000),
    });
    try {
      const v = secret.value(s.ref.field);
      if (!lineSafe(v)) {
        throw new OpsError(`"${secret.name}" spans several lines and cannot be passed into a command. Write it to a file with SshCopy \`content\` instead.`);
      }
      values.push(v);
    } finally {
      secret.release();
    }
  }
  return values;
}

function runsDir(): string {
  return path.join(aicoHome(), 'ops', 'runs');
}

/**
 * A log file for a background run: known values redacted as a stream (so a
 * value split across two chunks is still caught), unknown secret shapes
 * masked a whole line at a time.
 */
function openRunLog(id: string): { file: string; write(text: string): void; close(): void } {
  fs.mkdirSync(runsDir(), { recursive: true });
  const file = path.join(runsDir(), `${id.replace(/[^\w.-]/g, '_')}.log`);
  const fd = fs.openSync(file, 'a', 0o600);
  const stream = sinkStream();
  let pending = '';
  const emit = (text: string): void => {
    pending += text;
    const cut = pending.lastIndexOf('\n');
    if (cut < 0) return;
    const lines = pending.slice(0, cut + 1);
    pending = pending.slice(cut + 1);
    try { fs.writeSync(fd, maskUnknownSecrets(lines).text); } catch { /* a full disk must not kill the run */ }
  };
  return {
    file,
    write: (text) => emit(stream.push(text)),
    close: () => {
      emit(stream.flush());
      if (pending) { try { fs.writeSync(fd, maskUnknownSecrets(pending).text); } catch { /* as above */ } }
      try { fs.closeSync(fd); } catch { /* already closed */ }
    },
  };
}

function summarise(outcome: ChannelOutcome, timeoutS: number, hadSecrets: boolean): { exit: number; notes: string[] } {
  const notes: string[] = [];
  if (outcome.timedOut) notes.push(`Stopped after ${timeoutS}s. Raise \`timeout\` (max ${MAX_FOREGROUND_S}s), or use background:true for long work.`);
  if (outcome.cancelled) notes.push('Cancelled.');
  if (outcome.sudoRejected) notes.push('sudo rejected the password.');
  if (hadSecrets && outcome.code === 97) notes.push('The command did not receive its {{secret:…}} values (exit 97) — is the remote shell POSIX sh?');
  const exit = outcome.code ?? (outcome.timedOut || outcome.cancelled ? 124 : 255);
  return { exit, notes };
}

export async function sshExec(input: SshExecInput, signal?: AbortSignal): Promise<Record<string, unknown>> {
  if (typeof input.command !== 'string' || !input.command.trim()) throw new OpsError('`command` is required.');
  if (input.command.length > 100_000) throw new OpsError('The command is over 100 KB. Upload a script with SshCopy and run it.');
  const background = input.background === true;
  const timeoutS = clampSeconds(input.timeout, background ? 60 * 60 : DEFAULT_TIMEOUT_S, background ? MAX_BACKGROUND_S : MAX_FOREGROUND_S);
  const verdict = classifyRemoteCommand(input.command);
  const sudo = input.sudo === true || Boolean(input.sudo_credential);
  if (input.capture && background) throw new OpsError('`capture` works only in the foreground: the value is stored when the command finishes.');
  const plan = await planRemoteCommand(input.command, { sudo, ...(input.cwd ? { cwd: input.cwd } : {}) });

  const summary = input.command.length > 100 ? `${input.command.slice(0, 97)}…` : input.command;
  const op = openOp({ tool: 'SshExec', target: String(input.host ?? ''), credential: credentialLabel(input.credential ?? ''), summary });
  let session: Established | undefined;
  let handedOff = false;
  try {
    session = await establish({
      ...input, tool: 'SshExec', action: input.command, destructive: verdict.reasons, sudo,
      ...(input.sudo_credential ? { sudoCredential: input.sudo_credential } : {}), ...(signal ? { signal } : {}),
    });
    const values = await resolvePlanValues(plan, 'SshExec', session.host, session.port, input.command);
    const startedAt = Date.now();
    const base = {
      host: session.host, user: session.user, credential: session.credential,
      host_key: session.hostKey === 'trusted-now' ? `trusted now (${session.fingerprint})` : 'known',
      work_id: op.id,
    };

    if (background) {
      const s = session;
      const log = openRunLog(op.id);
      const controller = new AbortController();
      op.onStop(() => controller.abort());
      op.beat(`running on ${s.host}`);
      handedOff = true;
      void runPlan({
        client: s.client, plan, values, ...(s.sudoPassword ? { sudoPassword: s.sudoPassword } : {}),
        timeoutMs: timeoutS * 1000, signal: controller.signal,
        onOutput: (_stream, text) => log.write(text),
      }).then((outcome) => {
        log.close();
        s.release();
        const { exit, notes } = summarise(outcome, timeoutS, plan.secrets.length > 0);
        const tail = maskUnknownSecrets(sinkRedactText((outcome.stdout + outcome.stderr).slice(-300))).text.trim();
        const line = `exit ${exit}${notes.length ? ` — ${notes.join(' ')}` : ''}${tail ? ` · last output: ${tail}` : ''} · log: ${log.file}`;
        if (outcome.cancelled) op.fail(line, { reported: false, cancelled: true });
        else if (exit === 0) op.done(line, { reported: false });
        else op.fail(line, { reported: false });
      });
      session.sudoPassword = undefined;
      return {
        ...base,
        status: 'running in the background',
        log: log.file,
        note: `Started. Output streams to ${log.file} (redacted). Use Supervise wait/watch on "${op.id}" instead of polling; `
          + `Supervise stop ends it (the remote process may keep running if the server ignores signals).`,
      };
    }

    const progress = progressReporter(startedAt);
    let live = '';
    const outcome = await runPlan({
      client: session.client, plan, values, ...(session.sudoPassword ? { sudoPassword: session.sudoPassword } : {}),
      timeoutMs: timeoutS * 1000, ...(signal ? { signal } : {}),
      onOutput: (_stream, text) => { live = appendCapped(live, text, 64_000); progress.report(live); },
    });
    session.sudoPassword = undefined;
    progress.report(live, true);
    const { exit, notes } = summarise(outcome, timeoutS, plan.secrets.length > 0);

    let stdout = outcome.stdout;
    let captured: string | undefined;
    if (input.capture && exit === 0) {
      const value = stdout.trim();
      if (!value) throw new OpsError('`capture` found nothing on stdout to store.');
      captured = await captureSecret({
        name: input.capture.name, value, host: session.host, kind: input.capture.kind ?? 'generic',
        // Not the command text: a command can carry the very value it prints.
        description: input.capture.description ?? `Captured from a command's output on ${session.host} (${new Date().toISOString().slice(0, 16)}).`,
      });
      stdout = `(stdout captured into the vault as ${captured}; not shown)`;
    }
    const maskedOut = maskUnknownSecrets(stdout);
    const maskedErr = maskUnknownSecrets(outcome.stderr);
    if (maskedOut.masked || maskedErr.masked) notes.push(MASK_NOTE);
    const result = {
      ...base,
      exit_code: exit,
      ...(outcome.signal ? { signal: outcome.signal } : {}),
      stdout: maskedOut.text,
      stderr: maskedErr.text,
      duration_ms: Date.now() - startedAt,
      ...(captured ? { captured } : {}),
      ...(verdict.destructive ? { approved_as: `destructive: ${verdict.reasons.join(', ')}` } : {}),
      ...(notes.length ? { notes } : {}),
    };
    if (outcome.cancelled) op.fail('cancelled', { cancelled: true });
    else if (exit === 0) op.done(`exit 0 in ${result.duration_ms} ms`);
    else op.fail(`exit ${exit}`);
    return result;
  } catch (err) {
    op.fail(err instanceof Error ? err.message : String(err));
    throw err;
  } finally {
    if (session && !handedOff) session.release();
  }
}

// ── files ────────────────────────────────────────────────────────────

export interface SshCopyInput extends SshTargetInput {
  direction: 'upload' | 'download';
  remote_path: string;
  local_path?: string;
  content?: string;
  mode?: string | number;
  overwrite?: boolean;
}

const MAX_COPY_FILES = 5_000;
const MAX_CONTENT_BYTES = 5 * 1024 * 1024;

function sftpOf(client: Client): Promise<SFTPWrapper> {
  return new Promise((resolve, reject) => client.sftp((err, sftp) => (err ? reject(err) : resolve(sftp))));
}

function sftpCall<T>(fn: (cb: (err: Error | null | undefined, v?: T) => void) => void): Promise<T> {
  return new Promise((resolve, reject) => fn((err, v) => (err ? reject(err) : resolve(v as T))));
}

/** Parse `0600`/`"600"`/`384` into a mode. */
export function parseMode(mode: string | number | undefined, fallback: number): number {
  if (mode === undefined || mode === '') return fallback;
  const n = typeof mode === 'number' ? mode : parseInt(String(mode), 8);
  if (!Number.isInteger(n) || n < 0 || n > 0o7777) throw new OpsError(`"${String(mode)}" is not a file mode (use octal, e.g. "0640").`);
  return n;
}

/**
 * Local paths SshCopy must not read from or write to: the vault's own files,
 * and AICO's settings (provider keys) — uploading either to a server would be
 * the exfiltration the rest of the design prevents.
 */
export function localPathDenial(p: string, cwd: string): string | undefined {
  const vaultDir = getVault().dir;
  if (isInside(p, vaultDir, cwd)) return 'The credential vault\'s files cannot be copied anywhere.';
  const home = aicoHome();
  const abs = path.resolve(cwd, p);
  if (isInside(abs, home, cwd) && /^settings.*\.json$|^\.env/i.test(path.basename(abs))) {
    return 'AICO\'s settings hold provider keys and cannot be copied to a server.';
  }
  return undefined;
}

/** Remote paths whose change can lock the operator out, or wipe what the system trusts. */
function remotePathRisks(remote: string): string[] {
  const r: string[] = [];
  if (/sshd_config/.test(remote)) r.push('replacing the SSH daemon config (can lock you out)');
  if (/\/etc\/sudoers/.test(remote)) r.push('replacing sudoers (can lock you out)');
  if (/\/etc\/(?:passwd|shadow|group|pam\.d)\b/.test(remote)) r.push('replacing account files (can lock you out)');
  if (/authorized_keys/.test(remote)) r.push('replacing authorized_keys (can lock you out)');
  return r;
}

export async function sshCopy(input: SshCopyInput, signal?: AbortSignal): Promise<Record<string, unknown>> {
  if (input.direction !== 'upload' && input.direction !== 'download') throw new OpsError('`direction` must be "upload" or "download".');
  if (typeof input.remote_path !== 'string' || !input.remote_path.trim()) throw new OpsError('`remote_path` is required.');
  const remote = input.remote_path.trim();
  const cwd = currentCwd();
  const hasContent = typeof input.content === 'string';
  if (input.direction === 'upload' && !hasContent && !input.local_path) throw new OpsError('Upload needs `local_path` or `content`.');
  if (input.direction === 'download' && !input.local_path) throw new OpsError('Download needs `local_path`.');
  if (hasContent && Buffer.byteLength(input.content!) > MAX_CONTENT_BYTES) throw new OpsError('`content` is over 5 MB; upload a file instead.');
  if (input.local_path) {
    const denial = localPathDenial(input.local_path, cwd);
    if (denial) throw new OpsError(denial);
  }
  const contentRefs = hasContent ? parsePlaceholders(input.content!) : [];
  const mode = parseMode(input.mode, contentRefs.length ? 0o600 : 0o644);
  // A file carrying a secret must not be world-readable. Group-readable is a
  // real pattern (root:grafana 0640); world-readable never is.
  if (contentRefs.length && (mode & 0o007)) {
    throw new OpsError(`A file holding {{secret:…}} values must not be readable by everyone (mode ${mode.toString(8)}). Use 0600 or 0640.`);
  }
  const risks = input.direction === 'upload' ? remotePathRisks(remote) : [];
  const action = input.direction === 'upload'
    ? `upload ${hasContent ? `${Buffer.byteLength(input.content!)} bytes of content${contentRefs.length ? ` (with ${contentRefs.length} {{secret:…}} value(s))` : ''}` : input.local_path} to ${remote} (mode ${mode.toString(8)})`
    : `download ${remote} to ${input.local_path}`;
  const op = openOp({ tool: 'SshCopy', target: String(input.host ?? ''), credential: credentialLabel(input.credential ?? ''), summary: action });
  let session: Established | undefined;
  try {
    session = await establish({ ...input, tool: 'SshCopy', action, destructive: risks, ...(signal ? { signal } : {}) });
    // Cancellation or the deadline ends the connection, which fails a
    // transfer in flight instead of letting it run on unobserved.
    const endOnAbort = session.release;
    signal?.addEventListener('abort', endOnAbort, { once: true });
    const sftp = await sftpOf(session.client);
    const abortCheck = (): void => { if (signal?.aborted) throw new OpsError('Cancelled.'); };
    let files = 0;
    let bytes = 0;

    if (input.direction === 'upload' && hasContent) {
      let text = input.content!;
      if (contentRefs.length) {
        // Substituted here, in memory, and written straight to the remote file.
        let out = '';
        let at = 0;
        for (const ref of contentRefs) {
          const secret = await useCredential(ref.raw, {
            tool: 'SshCopy', host: session.port === 22 ? session.host : `${session.host}:${session.port}`,
            purpose: `write into ${remote} on ${session.host}`,
          });
          try { out += text.slice(at, ref.start) + secret.value(ref.field); } finally { secret.release(); }
          at = ref.end;
        }
        text = out + text.slice(at);
      }
      await writeRemoteFile(sftp, remote, Buffer.from(text, 'utf8'), mode, input.overwrite !== false);
      text = '';
      files = 1;
      bytes = Buffer.byteLength(input.content!);
    } else if (input.direction === 'upload') {
      const local = path.resolve(cwd, input.local_path!);
      const st = await fsp.stat(local).catch(() => undefined);
      if (!st) throw new OpsError(`${input.local_path} does not exist.`);
      const list = st.isDirectory() ? await walkLocal(local) : [{ abs: local, rel: '' }];
      if (list.length > MAX_COPY_FILES) throw new OpsError(`That is ${list.length} files; the limit is ${MAX_COPY_FILES}. Archive it first.`);
      for (const f of list) {
        abortCheck();
        const target = f.rel ? path.posix.join(remote, f.rel.split(path.sep).join('/')) : remote;
        if (f.rel) await mkdirpRemote(sftp, path.posix.dirname(target));
        if (input.overwrite === false && await sftpCall<unknown>(cb => sftp.stat(target, cb as never)).then(() => true, () => false)) {
          throw new OpsError(`${target} exists and overwrite is false.`);
        }
        await sftpCall<void>(cb => sftp.fastPut(f.abs, target, cb as never));
        if (input.mode !== undefined) await sftpCall<void>(cb => sftp.chmod(target, mode, cb as never));
        files++;
        bytes += (await fsp.stat(f.abs)).size;
      }
    } else {
      const local = path.resolve(cwd, input.local_path!);
      const st = await sftpCall<{ isDirectory(): boolean; size: number }>(cb => sftp.stat(remote, cb as never)).catch(() => undefined);
      if (!st) throw new OpsError(`${remote} does not exist on ${session.host}.`);
      const list = st.isDirectory() ? await walkRemote(sftp, remote) : [{ abs: remote, rel: '' }];
      if (list.length > MAX_COPY_FILES) throw new OpsError(`That is ${list.length} files; the limit is ${MAX_COPY_FILES}. Archive it first.`);
      for (const f of list) {
        abortCheck();
        const target = f.rel ? path.join(local, ...f.rel.split('/')) : local;
        const denial = localPathDenial(target, cwd);
        if (denial) throw new OpsError(denial);
        if (!input.overwrite && fs.existsSync(target)) throw new OpsError(`${target} exists. Pass overwrite:true to replace it.`);
        await fsp.mkdir(path.dirname(target), { recursive: true });
        await sftpCall<void>(cb => sftp.fastGet(f.abs, target, cb as never));
        files++;
        bytes += (await fsp.stat(target)).size;
      }
    }
    op.done(`${files} file(s), ${bytes} bytes`);
    return {
      host: session.host, user: session.user, credential: session.credential, direction: input.direction,
      remote_path: remote, ...(input.local_path ? { local_path: input.local_path } : {}),
      files, bytes, ...(input.direction === 'upload' ? { mode: `0${mode.toString(8)}` } : {}),
      host_key: session.hostKey === 'trusted-now' ? `trusted now (${session.fingerprint})` : 'known',
      work_id: op.id,
    };
  } catch (err) {
    op.fail(err instanceof Error ? err.message : String(err));
    throw err;
  } finally {
    session?.release();
  }
}

async function writeRemoteFile(sftp: SFTPWrapper, remote: string, data: Buffer, mode: number, overwrite: boolean): Promise<void> {
  if (!overwrite && await sftpCall<unknown>(cb => sftp.stat(remote, cb as never)).then(() => true, () => false)) {
    throw new OpsError(`${remote} exists and overwrite is false.`);
  }
  await mkdirpRemote(sftp, path.posix.dirname(remote));
  // Created with the mode, then chmod'ed: SFTP applies `mode` only when the
  // open creates the file, and an existing world-readable file must not stay so.
  await new Promise<void>((resolve, reject) => {
    const ws = sftp.createWriteStream(remote, { mode, flags: 'w' });
    ws.on('error', reject);
    ws.on('close', () => resolve());
    ws.end(data);
  });
  await sftpCall<void>(cb => sftp.chmod(remote, mode, cb as never));
}

async function mkdirpRemote(sftp: SFTPWrapper, dir: string): Promise<void> {
  if (!dir || dir === '/' || dir === '.') return;
  const exists = await sftpCall<unknown>(cb => sftp.stat(dir, cb as never)).then(() => true, () => false);
  if (exists) return;
  await mkdirpRemote(sftp, path.posix.dirname(dir));
  await sftpCall<void>(cb => sftp.mkdir(dir, cb as never)).catch(() => undefined);
}

async function walkLocal(root: string): Promise<Array<{ abs: string; rel: string }>> {
  const out: Array<{ abs: string; rel: string }> = [];
  const visit = async (dir: string): Promise<void> => {
    for (const e of await fsp.readdir(dir, { withFileTypes: true })) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) await visit(abs);
      else if (e.isFile()) out.push({ abs, rel: path.relative(root, abs) });
      if (out.length > MAX_COPY_FILES) return;
    }
  };
  await visit(root);
  return out;
}

async function walkRemote(sftp: SFTPWrapper, root: string): Promise<Array<{ abs: string; rel: string }>> {
  const out: Array<{ abs: string; rel: string }> = [];
  const visit = async (dir: string): Promise<void> => {
    const list = await sftpCall<Array<{ filename: string; attrs: { isDirectory(): boolean; isFile(): boolean } }>>(cb => sftp.readdir(dir, cb as never));
    for (const e of list) {
      if (e.filename === '.' || e.filename === '..') continue;
      const abs = path.posix.join(dir, e.filename);
      if (e.attrs.isDirectory()) await visit(abs);
      else if (e.attrs.isFile()) out.push({ abs, rel: path.posix.relative(root, abs) });
      if (out.length > MAX_COPY_FILES) return;
    }
  };
  await visit(root);
  return out;
}

// ── tunnels ──────────────────────────────────────────────────────────

export interface SshTunnelInput extends SshTargetInput {
  remote_port: number;
  remote_host?: string;
  local_port?: number;
  ttl_minutes?: number;
}

const tunnels = new Map<number, { id: string; forwardsTo: string }>();

/** Local ports that are the near end of an open AICO tunnel (HttpRequest may reach these on loopback). */
export function activeTunnelPorts(): number[] {
  return [...tunnels.keys()];
}

const LOCAL_NAMES = new Set(['127.0.0.1', 'localhost', '::1']);

export async function sshTunnel(input: SshTunnelInput, signal?: AbortSignal): Promise<Record<string, unknown>> {
  const remotePort = validPort(input.remote_port, 0);
  if (!remotePort) throw new OpsError('`remote_port` is required: the port on the far side to reach.');
  const remoteHost = (input.remote_host ?? '127.0.0.1').trim();
  if (!validHost(remoteHost)) throw new OpsError('`remote_host` must be a host name or IP address.');
  const localPort = input.local_port === undefined ? 0 : validPort(input.local_port, 0);
  const ttlMin = clampSeconds(input.ttl_minutes, 60, 12 * 60);
  const forwardsTo = `${remoteHost}:${remotePort}`;
  // Reaching the server's own localhost is the common case (a web UI bound to
  // 127.0.0.1). Reaching another machine *through* it is a new target, so a
  // person names it.
  const pivot = LOCAL_NAMES.has(remoteHost.toLowerCase()) ? [] : [`forwarding through the server to another machine (${forwardsTo})`];
  const action = `open a tunnel from 127.0.0.1:${localPort || 'auto'} on this machine to ${forwardsTo} as seen from the server, for ${ttlMin} min`;
  const op = openOp({ tool: 'SshTunnel', target: String(input.host ?? ''), credential: credentialLabel(input.credential ?? ''), summary: `→ ${forwardsTo}` });
  let session: Established | undefined;
  try {
    session = await establish({ ...input, tool: 'SshTunnel', action, destructive: pivot, ...(signal ? { signal } : {}) });
    const s = session;
    const sockets = new Set<net.Socket>();
    const server = net.createServer((sock) => {
      sockets.add(sock);
      sock.on('close', () => sockets.delete(sock));
      s.client.forwardOut('127.0.0.1', sock.localPort ?? 0, remoteHost, remotePort, (err, stream) => {
        if (err) { sock.destroy(); return; }
        sock.pipe(stream).pipe(sock);
        stream.on('error', () => sock.destroy());
        sock.on('error', () => stream.destroy());
      });
    });
    // Loopback only: the tunnel is for this machine, never the LAN.
    const port = await new Promise<number>((resolve, reject) => {
      server.once('error', reject);
      server.listen(localPort, '127.0.0.1', () => resolve((server.address() as net.AddressInfo).port));
    });
    tunnels.set(port, { id: op.id, forwardsTo });
    let closed = false;
    const close = (reason: string, failed = false): void => {
      if (closed) return;
      closed = true;
      clearTimeout(ttl);
      tunnels.delete(port);
      for (const sock of sockets) sock.destroy();
      server.close();
      s.release();
      if (failed) op.fail(reason, { reported: false });
      else op.done(reason, { reported: false });
    };
    const ttl = setTimeout(() => close(`closed after ${ttlMin} min (ttl)`), ttlMin * 60_000);
    ttl.unref?.();
    s.client.on('close', () => close('the SSH connection closed', true));
    op.onStop((_mode, reason) => close(`stopped: ${reason}`));
    op.beat(`127.0.0.1:${port} → ${forwardsTo}`);
    session = undefined; // owned by the tunnel now
    return {
      status: 'open',
      local: `127.0.0.1:${port}`,
      local_url: `http://127.0.0.1:${port}`,
      forwards_to: `${forwardsTo} (from ${s.host})`,
      host_key: s.hostKey === 'trusted-now' ? `trusted now (${s.fingerprint})` : 'known',
      work_id: op.id,
      note: `Open for ${ttlMin} min, listening on this machine's loopback only. HttpRequest may use http://127.0.0.1:${port}. `
        + `Close it with Supervise stop "${op.id}".`,
    };
  } catch (err) {
    op.fail(err instanceof Error ? err.message : String(err));
    throw err;
  } finally {
    session?.release();
  }
}

// ── model-facing definitions ─────────────────────────────────────────

const TARGET_PROPS = {
  host: { type: 'string', description: 'Server host name or IP, e.g. 10.0.0.5.' },
  port: { type: 'number', description: 'SSH port (default 22).' },
  credential: { type: 'string', description: 'Name of a stored credential (ssh-password, ssh-key or login), e.g. "nas-root". Never a password.' },
  user: { type: 'string', description: 'Login user, if the credential does not name one.' },
} as const;

const VALUES_NOTE = 'You never see credential values. Put {{secret:NAME}} where a stored value must go; it reaches the '
  + 'server over the encrypted channel\'s stdin, never in the command line. Unknown host keys and destructive commands '
  + '(deletes, service stops, firewall/SSH changes, drops, reboots) are shown to a person to approve first.';

export const sshExecDefinition = {
  name: 'SshExec',
  description: 'Run a command on a remote machine over SSH with a stored credential. Returns stdout, stderr and the exit '
    + 'code; output is redacted and secret-looking text masked. ' + VALUES_NOTE + ' sudo:true runs it with sudo, answering '
    + 'the password prompt from the credential (never in argv). background:true starts long work (installs, migrations) '
    + 'and returns a work id for Supervise wait/watch, with output in a redacted log file. capture stores the trimmed '
    + 'stdout in the vault (e.g. a generated admin password) instead of showing it.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      ...TARGET_PROPS,
      command: { type: 'string', description: 'The command, run by the login shell (POSIX sh when it uses sudo or {{secret:…}}).' },
      sudo: { type: 'boolean', description: 'Run with sudo; the credential\'s password answers the prompt.' },
      sudo_credential: { type: 'string', description: 'Credential whose password sudo needs, when logging in with a key.' },
      cwd: { type: 'string', description: 'Remote directory to run in.' },
      timeout: { type: 'number', description: 'Seconds, default 120, max 1800 (background: default 3600).' },
      background: { type: 'boolean', description: 'Start and return a work id instead of waiting.' },
      capture: {
        type: 'object',
        description: 'Store the command\'s trimmed stdout in the vault under this name, bound to this host.',
        properties: {
          name: { type: 'string' },
          kind: { type: 'string', enum: ['generic', 'login', 'api-token', 'database', 'ssh-password'] },
          description: { type: 'string' },
        },
        required: ['name'],
      },
    },
    required: ['host', 'credential', 'command'],
  },
};

export const sshCopyDefinition = {
  name: 'SshCopy',
  description: 'Copy files to or from a remote machine over SFTP (files or whole directories), or write `content` straight '
    + 'into a remote file — the way to put a config or env file on a server. {{secret:NAME}} in `content` is substituted '
    + 'in memory and written with mode 0600 by default; such files may not be world-readable. ' + VALUES_NOTE,
  inputSchema: {
    type: 'object' as const,
    properties: {
      ...TARGET_PROPS,
      direction: { type: 'string', enum: ['upload', 'download'] },
      remote_path: { type: 'string', description: 'Absolute remote path (a directory for directory copies).' },
      local_path: { type: 'string', description: 'Local file or directory (relative to the workspace).' },
      content: { type: 'string', description: 'Upload: text to write to remote_path instead of a local file.' },
      mode: { type: 'string', description: 'Octal mode for uploaded files, e.g. "0640". Default 0644, or 0600 when content holds secrets.' },
      overwrite: { type: 'boolean', description: 'Upload: default true. Download: default false.' },
    },
    required: ['host', 'credential', 'direction', 'remote_path'],
  },
};

export const sshTunnelDefinition = {
  name: 'SshTunnel',
  description: 'Forward a port on this machine\'s loopback (127.0.0.1) through SSH to a port on or behind the server — to '
    + 'reach a web UI or API bound to the server\'s localhost. Returns the local URL and a work id; it closes after '
    + 'ttl_minutes or with Supervise stop. Forwarding to a machine other than the server\'s own localhost needs a '
    + 'person\'s approval.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      ...TARGET_PROPS,
      remote_port: { type: 'number', description: 'Port to reach, as seen from the server.' },
      remote_host: { type: 'string', description: 'Default 127.0.0.1 (the server itself).' },
      local_port: { type: 'number', description: 'Local port (default: any free one).' },
      ttl_minutes: { type: 'number', description: 'Default 60, max 720.' },
    },
    required: ['host', 'credential', 'remote_port'],
  },
};
