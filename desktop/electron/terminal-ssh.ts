/**
 * SSH terminals from the vault: an interactive shell on a server, signed in
 * with a stored credential the interface never holds.
 *
 * WHY HERE (main) and not the engine: the shell is a person's, interactive,
 * drawn in an xterm tab — main already owns the tabs, the native dialogs and
 * the private port to the engine. Putting a remote shell behind the engine's
 * HTTP API would make it reachable with the API token (ADR 0019).
 *
 * The order is the ops tools' order (src/tools/ops/ssh.ts), with the person
 * in the approval seat:
 *
 *  1. **Host key.** `<AICO_HOME>/ops/known_hosts`, read with the ops tools'
 *     own module so there is one host-key implementation. A known host must
 *     present the pinned key or nothing is sent (mismatch and @revoked are
 *     refused, naming the fingerprints — replacing a pin is the owner editing
 *     that file). An unknown host is probed without authenticating and its
 *     key type + SHA256 fingerprint shown in a native dialog; only an
 *     explicit accept continues. There is no "skip verification" path.
 *  2. **Credential**, by name, resolved by the engine's broker for exactly
 *     this host (tool `SshTerminal`) over the private port: scope, allowed
 *     tools and approval mode apply, and the use is audited.
 *  3. **Connection**, accepting only the key that was checked or shown; the
 *     key is pinned only after the login succeeds. The secret is dropped as
 *     soon as the handshake is done. Nothing here logs, emits or returns it.
 *
 * Ciphers: AES-GCM and AES-CTR only, as in the ops tools.
 *
 * Dependencies are passed in (`ssh2`, the dialog, the credential lookup) so
 * the whole path runs in the offline test against scripts/lib/ssh-test-server.mjs.
 *
 * @module desktop/electron/terminal-ssh
 */

import type { Client, ClientChannel, ConnectConfig } from 'ssh2';
import {
  checkHostKey, fingerprintOf, hasEntryFor, knownHostsPath, readKnownHosts, trustHostKey,
} from '../../src/tools/ops/known-hosts';

const CIPHERS = ['aes256-gcm@openssh.com', 'aes128-gcm@openssh.com', 'aes256-ctr', 'aes192-ctr', 'aes128-ctr'];
const CONNECT_TIMEOUT_MS = 20_000;

type Ssh2Module = { Client: new () => Client };

/** What the terminal layer drives: the same shape as a node-pty process. */
export interface ShellHandle {
  pid: number;
  onData(cb: (d: string) => void): void;
  onExit(cb: (e: { exitCode: number }) => void): void;
  write(d: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
}

/** A credential's usable parts, as the engine's fill reply carries them. Use and drop. */
export interface SshSecret { username?: string; kind?: string; fields: Record<string, string> }

export interface SshTerminalDeps {
  ssh2: Ssh2Module;
  /** Ask the person to accept an unknown host key. Must be a native dialog in production. */
  confirmHostKey(info: { host: string; port: number; keyType: string; fingerprint: string }): Promise<boolean>;
  /** Resolve the credential for this host through the broker. */
  credential(name: string, target: string, purpose: string): Promise<SshSecret>;
  /** known_hosts location (tests pass their own). */
  knownHosts?: string;
}

export interface SshTerminalRequest { host: string; port?: number; user?: string; credential: string; cols?: number; rows?: number }

export class SshTerminalError extends Error {}

const HOST_RE = /^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,62}[A-Za-z0-9])?)(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,62}[A-Za-z0-9])?)*$|^\d{1,3}(?:\.\d{1,3}){3}$|^\[?[0-9a-fA-F:]+\]?$/;

/** Host name or IP, no user@, no spaces; port 1–65535. */
export function validateTarget(r: SshTerminalRequest): { host: string; port: number } {
  const host = String(r.host ?? '').trim().toLowerCase().replace(/^\[(.*)\]$/, '$1');
  if (!host || host.length > 253 || !HOST_RE.test(host)) throw new SshTerminalError('Give a host name or IP address (no user@ or port in it).');
  const port = r.port === undefined || r.port === null || (r.port as unknown) === '' ? 22 : Number(r.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new SshTerminalError('The port must be a number from 1 to 65535.');
  if (!String(r.credential ?? '').trim()) throw new SshTerminalError('Choose a stored credential.');
  return { host, port };
}

/** Read the server's host key without authenticating. */
export function probeHostKey(ssh2: Ssh2Module, host: string, port: number): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const client = new ssh2.Client();
    let key: Buffer | undefined;
    let settled = false;
    const settle = (err?: Error): void => {
      if (settled) return;
      settled = true;
      try { client.end(); } catch { /* closed */ }
      if (key) resolve(key);
      else reject(err ?? new SshTerminalError(`${host}:${port} closed the connection before presenting a host key.`));
    };
    client.on('error', (err: Error) => settle(explain(err, host, port)));
    client.on('close', () => settle());
    client.connect({
      host, port, username: 'aico-hostkey-probe', readyTimeout: CONNECT_TIMEOUT_MS, algorithms: { cipher: CIPHERS as never },
      hostVerifier: (k: Buffer) => { key = Buffer.from(k); return false; },
    } as ConnectConfig);
  });
}

function explain(err: unknown, host: string, port: number): SshTerminalError {
  const e = err as { code?: string; level?: string; message?: string };
  const msg = e?.message ?? String(err);
  if (e?.code === 'ECONNREFUSED') return new SshTerminalError(`Nothing is listening for SSH on ${host}:${port}.`);
  if (e?.code === 'ENOTFOUND' || e?.code === 'EAI_AGAIN') return new SshTerminalError(`The host name ${host} does not resolve.`);
  if (e?.code === 'ETIMEDOUT' || /Timed out while waiting for handshake/i.test(msg)) return new SshTerminalError(`${host}:${port} did not answer in time.`);
  if (e?.level === 'client-authentication' || /authentication methods failed/i.test(msg)) return new SshTerminalError(`${host} rejected the stored credential (authentication failed).`);
  if (/verification failed|Host denied/i.test(msg)) return new SshTerminalError(`The host key presented by ${host}:${port} is not the one that was checked; nothing was sent.`);
  // Never echo a raw library message that could quote input; keep it short.
  return new SshTerminalError(`SSH to ${host}:${port} failed: ${msg.replace(/[\r\n]+/g, ' ').slice(0, 160)}`);
}

/**
 * Open an interactive shell. Host key → person → credential → connection,
 * in that order (module header).
 */
export async function openSshTerminal(deps: SshTerminalDeps, req: SshTerminalRequest): Promise<{ shell: ShellHandle; host: string; port: number; user: string; hostKey: 'known' | 'trusted-now'; fingerprint: string }> {
  const { host, port } = validateTarget(req);
  const file = deps.knownHosts ?? knownHostsPath();

  // 1. Host key.
  const entries = readKnownHosts(file);
  let probed: Buffer | undefined;
  if (!hasEntryFor(entries, host, port)) {
    probed = await probeHostKey(deps.ssh2, host, port);
    const check = checkHostKey(entries, host, port, probed);
    if (check.status === 'revoked') throw new SshTerminalError(`${host}:${port} presented a key marked @revoked in ${file}. Nothing was sent.`);
    const ok = await deps.confirmHostKey({ host, port, keyType: check.keyType, fingerprint: check.fingerprint });
    if (!ok) throw new SshTerminalError('Cancelled: the host key was not accepted. Nothing was sent.');
  }

  // 2. Credential.
  const target = port === 22 ? host : `${host}:${port}`;
  const secret = await deps.credential(req.credential.trim(), target, `interactive SSH terminal to ${target} (opened by you in AICO Desktop)`);
  const user = (req.user?.trim() || secret.username || '').trim();
  if (!user) { wipe(secret); throw new SshTerminalError(`The credential "${req.credential}" names no user; enter one.`); }
  if (secret.username && req.user?.trim() && req.user.trim() !== secret.username) {
    wipe(secret);
    throw new SshTerminalError(`The credential "${req.credential}" is for user "${secret.username}", not "${req.user.trim()}".`);
  }
  const auth: Partial<ConnectConfig> = {};
  if (secret.fields.privateKey) {
    auth.privateKey = secret.fields.privateKey;
    if (secret.fields.passphrase) auth.passphrase = secret.fields.passphrase;
  } else if (secret.fields.password) {
    auth.password = secret.fields.password;
  } else {
    wipe(secret);
    throw new SshTerminalError(`The credential "${req.credential}" has no password or private key SSH can use.`);
  }
  const password = auth.password;
  wipe(secret);

  // 3. Connection, accepting only the checked key.
  let presented: Buffer | undefined;
  const otherPrompts: string[] = [];
  let client: Client;
  try {
    client = await new Promise<Client>((resolve, reject) => {
      const c = new deps.ssh2.Client();
      let settled = false;
      c.on('ready', () => { if (!settled) { settled = true; resolve(c); } });
      c.on('error', (err: Error) => {
        if (settled) return;
        settled = true;
        reject(otherPrompts.length
          ? new SshTerminalError(`${host} asked for more than a password ("${otherPrompts[0]!.slice(0, 80)}") — a one-time code or second factor is yours to enter, and AICO never answers it with a stored secret. Sign in with your own ssh client in a terminal tab for this server.`)
          : explain(err, host, port));
      });
      // Runs after the host key was verified (key exchange comes first). The stored password answers only a
      // plain "Password:" prompt; a one-time code, passcode or anything else is the person's (keyboardInteractiveAnswers).
      c.on('keyboard-interactive', (_n: string, _i: string, _l: string, prompts: Array<{ prompt: string }>, finish: (r: string[]) => void) => {
        const r = keyboardInteractiveAnswers(prompts, password);
        if (r.forPerson.length) otherPrompts.push(...r.forPerson);
        finish(r.answers);
      });
      c.connect({
        host, port, username: user, readyTimeout: CONNECT_TIMEOUT_MS, algorithms: { cipher: CIPHERS as never },
        keepaliveInterval: 15_000, keepaliveCountMax: 4,
        hostVerifier: (k: Buffer) => {
          presented = Buffer.from(k);
          if (probed) return presented.equals(probed);
          return checkHostKey(readKnownHosts(file), host, port, presented).status === 'match';
        },
        ...(auth.password ? { tryKeyboard: true } : {}),
        ...auth,
      } as ConnectConfig);
    });
  } catch (err) {
    if (presented && !probed) {
      const check = checkHostKey(readKnownHosts(file), host, port, presented);
      if (check.status === 'mismatch') {
        throw new SshTerminalError(`HOST KEY MISMATCH for ${host}:${port}: it presents ${check.keyType} ${check.fingerprint}, but ${file} pins ${check.expected.join(' / ')}. `
          + 'This can be a reinstalled server or someone intercepting the connection. Nothing was sent. Verify the new key and edit that file if it is expected.');
      }
    }
    throw err;
  } finally {
    auth.password = undefined; auth.privateKey = undefined; auth.passphrase = undefined;
  }

  let hostKey: 'known' | 'trusted-now' = 'known';
  if (probed) {
    trustHostKey(host, port, probed, `aico-terminal ${new Date().toISOString().slice(0, 10)}`, file);
    hostKey = 'trusted-now';
  }
  const fingerprint = fingerprintOf(presented ?? probed ?? Buffer.alloc(0));

  const channel = await new Promise<ClientChannel>((resolve, reject) => {
    client.shell({ term: 'xterm-256color', cols: Math.max(20, req.cols ?? 100), rows: Math.max(5, req.rows ?? 24) }, (err, ch) => (err ? reject(err) : resolve(ch)));
  }).catch((err: unknown) => { try { client.end(); } catch { /* closed */ } throw explain(err, host, port); });

  const dataCbs: Array<(d: string) => void> = [];
  const exitCbs: Array<(e: { exitCode: number }) => void> = [];
  let exitCode = 0;
  let ended = false;
  const end = (): void => {
    if (ended) return;
    ended = true;
    try { client.end(); } catch { /* closed */ }
    for (const cb of exitCbs) cb({ exitCode });
  };
  channel.on('data', (d: Buffer) => { const s = d.toString('utf8'); for (const cb of dataCbs) cb(s); });
  channel.stderr.on('data', (d: Buffer) => { const s = d.toString('utf8'); for (const cb of dataCbs) cb(s); });
  channel.on('exit', (code: number | null) => { if (typeof code === 'number') exitCode = code; });
  channel.on('close', end);
  client.on('close', end);
  client.on('error', () => end());

  const shell: ShellHandle = {
    pid: 0,
    onData: (cb) => { dataCbs.push(cb); },
    onExit: (cb) => { exitCbs.push(cb); },
    write: (d) => { if (!ended) channel.write(d); },
    resize: (cols, rows) => { if (!ended) try { channel.setWindow(rows, cols, 0, 0); } catch { /* closing */ } },
    kill: () => { try { channel.close(); } catch { /* closed */ } end(); },
  };
  return { shell, host, port, user, hostKey, fingerprint };
}

function wipe(s: SshSecret): void {
  for (const k of Object.keys(s.fields)) s.fields[k] = '';
}


/**
 * Answers to an SSH keyboard-interactive round: the stored password goes only
 * to a prompt that is plainly a password prompt ("Password:", "password"),
 * never to "Verification code:", "Passcode:", "OTP" or a question — those are
 * a second factor or something unknown, and a stored secret must not be
 * typed into them. Those prompts are returned for the person.
 */
export function keyboardInteractiveAnswers(prompts: ReadonlyArray<{ prompt: string }>, password: string | undefined): { answers: string[]; forPerson: string[] } {
  const forPerson: string[] = [];
  const answers = prompts.map((p) => {
    if (password && /^\s*password\s*:?\s*$/i.test(p.prompt)) return password;
    forPerson.push(p.prompt.trim());
    return '';
  });
  return { answers, forPerson };
}
