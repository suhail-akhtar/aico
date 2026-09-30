/**
 * Where the vault's master key lives when AICO is not running.
 *
 * The master key is 32 random bytes and is never written anywhere in the
 * clear. A {@link KeyProvider} seals it; the sealed form goes in
 * `vault/key.json`. Four ways to seal, chosen by who is hosting the engine:
 *
 *  - **injected** — AICO Desktop's main process owns the key (sealed with
 *    Electron's safeStorage) and hands it to the engine over its private
 *    message channel at runtime. Never through an environment variable: every
 *    child process inherits the environment, and the agent's Bash is a child
 *    process. See `host-channel.ts`.
 *  - **OS keyring** for a standalone engine — Windows DPAPI (a PowerShell
 *    child calling `ProtectedData`), macOS `security`, Linux `secret-tool`.
 *    The key travels over the child's stdin/stdout, never its argv, because
 *    argv is visible to every process on the machine.
 *  - **passphrase** — scrypt-derived key-encryption key, with lock, unlock
 *    and idle auto-lock (the idle timer lives in the store).
 *  - **memory** — for tests. Holds keys in this process only.
 *
 * If nothing can seal, the vault refuses to store secrets and says why. There
 * is no plaintext fallback, because a fallback nobody chose is how a vault
 * becomes a text file.
 *
 * Honest limit: a same-user process with a shell can ask DPAPI, the keychain
 * or the secret service for the same key AICO can. The guard in `guard.ts`
 * blocks the obvious ways the agent's shell would do that; it is defence in
 * depth, not a boundary.
 *
 * @module vault/keys
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import {
  newScryptParams, scryptKey, unwrap, wrap, type ScryptParams, type Wrapped,
} from './crypto.js';
import { VaultError, VaultLockedError, VaultUnavailableError } from './types.js';

export type KeyProviderKind = 'injected' | 'dpapi' | 'macos-keychain' | 'secret-tool' | 'passphrase' | 'memory';

/** What `key.json` holds. Never the key itself. */
export interface KeyDescriptor {
  provider: KeyProviderKind;
  /** Key-check value of the master key, so a wrong key is named as such. */
  kcv?: string;
  /** DPAPI / memory: the sealed blob (base64). */
  sealed?: string;
  /** Keychain / secret-service item coordinates. */
  service?: string;
  account?: string;
  /** Passphrase: KDF parameters and the wrapped master key. */
  scrypt?: ScryptParams;
  wrapped?: Wrapped;
  /**
   * Standalone human-grant passphrase verifier (keyring modes only; in
   * passphrase mode the vault passphrase itself is the verifier).
   */
  grant?: { scrypt: ScryptParams; check: Wrapped };
}

export interface SealContext {
  /** Stable per-vault identity, so two AICO homes never share a keyring item. */
  vaultId: string;
  passphrase?: string;
}

export interface KeyProvider {
  readonly kind: KeyProviderKind;
  /** Needs a human-typed passphrase to unseal. */
  readonly interactive: boolean;
  /** Whether this provider can seal on this machine now. */
  available(): Promise<boolean>;
  /**
   * The master key to use for a new vault, when the provider dictates it
   * (injected: the host's key). Otherwise a random one is generated.
   */
  providedMaster?(): Buffer | undefined;
  seal(master: Buffer, ctx: SealContext): Promise<Omit<KeyDescriptor, 'provider' | 'kcv'>>;
  unseal(desc: KeyDescriptor, ctx: SealContext): Promise<Buffer>;
}

// ── child-process helper: secret over stdin, result over stdout ──────

function runWithStdin(command: string, args: string[], input: string, timeoutMs = 20_000): Promise<string> {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    } catch {
      reject(new VaultUnavailableError(`${command} could not be started.`));
      return;
    }
    let out = '';
    let err = '';
    const timer = setTimeout(() => { child.kill(); reject(new VaultUnavailableError(`${command} did not answer in time.`)); }, timeoutMs);
    timer.unref?.();
    child.stdout.on('data', (b: Buffer) => { out += b.toString('utf8'); });
    // stderr is kept only to report *that* it failed; it never carries the key.
    child.stderr.on('data', (b: Buffer) => { err += b.toString('utf8'); });
    child.on('error', () => { clearTimeout(timer); reject(new VaultUnavailableError(`${command} is not available on this machine.`)); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new VaultUnavailableError(`${command} failed (exit ${code})${err.trim() ? `: ${err.trim().split('\n')[0]!.slice(0, 160)}` : ''}.`));
    });
    child.stdin.end(input);
  });
}

// ── injected ─────────────────────────────────────────────────────────

let injected: Buffer | undefined;
const injectedWaiters: Array<() => void> = [];

/**
 * Hand the engine its master key. Called by the host channel only — this is
 * the single entry point, so the key cannot arrive by any route the agent
 * could also use.
 */
export function injectMasterKey(key: Buffer): void {
  if (key.length !== 32) throw new VaultError('invalid', 'An injected vault key must be 32 bytes.');
  injected = Buffer.from(key);
  for (const w of injectedWaiters.splice(0)) w();
}

/** Forget the injected key (host lock / shutdown). */
export function clearInjectedKey(): void {
  injected?.fill(0);
  injected = undefined;
}

export function hasInjectedKey(): boolean { return injected !== undefined; }

export const injectedKeyProvider: KeyProvider = {
  kind: 'injected',
  interactive: false,
  async available() { return injected !== undefined; },
  providedMaster() { return injected ? Buffer.from(injected) : undefined; },
  async seal() { return {}; },
  async unseal() {
    if (!injected) throw new VaultLockedError('The vault key is held by AICO Desktop and has not been handed to this engine yet.');
    return Buffer.from(injected);
  },
};

// ── Windows DPAPI ────────────────────────────────────────────────────

const DPAPI_ENTROPY = 'aico-vault';

function dpapiScript(op: 'Protect' | 'Unprotect'): string {
  // Input and output are base64 over stdin/stdout; nothing sensitive in argv.
  return [
    '$ErrorActionPreference = "Stop"',
    'Add-Type -AssemblyName System.Security',
    '$in = [Console]::In.ReadToEnd().Trim()',
    '$bytes = [Convert]::FromBase64String($in)',
    `$ent = [Text.Encoding]::UTF8.GetBytes('${DPAPI_ENTROPY}')`,
    '$scope = [System.Security.Cryptography.DataProtectionScope]::CurrentUser',
    `$out = [System.Security.Cryptography.ProtectedData]::${op}($bytes, $ent, $scope)`,
    '[Console]::Out.Write([Convert]::ToBase64String($out))',
  ].join('; ');
}

async function dpapi(op: 'Protect' | 'Unprotect', input: Buffer): Promise<Buffer> {
  const encoded = Buffer.from(dpapiScript(op), 'utf16le').toString('base64');
  const out = await runWithStdin('powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
    input.toString('base64'));
  const result = Buffer.from(out.trim(), 'base64');
  if (!result.length) throw new VaultUnavailableError('DPAPI returned nothing.');
  return result;
}

export const dpapiKeyProvider: KeyProvider = {
  kind: 'dpapi',
  interactive: false,
  async available() { return process.platform === 'win32'; },
  async seal(master) { return { sealed: (await dpapi('Protect', master)).toString('base64') }; },
  async unseal(desc) {
    if (!desc.sealed) throw new VaultError('format', 'The vault key file has no DPAPI blob.');
    return dpapi('Unprotect', Buffer.from(desc.sealed, 'base64'));
  },
};

// ── macOS keychain ───────────────────────────────────────────────────

const KEYCHAIN_SERVICE = 'AICO credential vault';

export const macKeychainProvider: KeyProvider = {
  kind: 'macos-keychain',
  interactive: false,
  async available() { return process.platform === 'darwin' && fs.existsSync('/usr/bin/security'); },
  async seal(master, ctx) {
    // `security -i` reads the command from stdin, keeping the value out of argv.
    await runWithStdin('/usr/bin/security', ['-i'],
      `add-generic-password -U -a ${ctx.vaultId} -s "${KEYCHAIN_SERVICE}" -w ${master.toString('hex')}\n`);
    return { service: KEYCHAIN_SERVICE, account: ctx.vaultId };
  },
  async unseal(desc, ctx) {
    const out = await runWithStdin('/usr/bin/security',
      ['find-generic-password', '-a', desc.account ?? ctx.vaultId, '-s', desc.service ?? KEYCHAIN_SERVICE, '-w'], '');
    return Buffer.from(out.trim(), 'hex');
  },
};

// ── Linux secret service ─────────────────────────────────────────────

export const secretToolProvider: KeyProvider = {
  kind: 'secret-tool',
  interactive: false,
  async available() {
    if (process.platform !== 'linux') return false;
    return new Promise<boolean>((resolve) => {
      const child = spawn('secret-tool', [], { stdio: 'ignore' });
      child.on('error', () => resolve(false));
      // Usage exit (non-zero) still means it is installed.
      child.on('close', () => resolve(Boolean(process.env.DBUS_SESSION_BUS_ADDRESS)));
    });
  },
  async seal(master, ctx) {
    await runWithStdin('secret-tool',
      ['store', `--label=${KEYCHAIN_SERVICE}`, 'service', 'aico-vault', 'account', ctx.vaultId],
      master.toString('hex'));
    return { service: 'aico-vault', account: ctx.vaultId };
  },
  async unseal(desc, ctx) {
    const out = await runWithStdin('secret-tool',
      ['lookup', 'service', desc.service ?? 'aico-vault', 'account', desc.account ?? ctx.vaultId], '');
    return Buffer.from(out.trim(), 'hex');
  },
};

// ── passphrase ───────────────────────────────────────────────────────

const MASTER_LABEL = 'aico-vault:master';

export const passphraseKeyProvider: KeyProvider = {
  kind: 'passphrase',
  interactive: true,
  async available() { return true; },
  async seal(master, ctx) {
    if (!ctx.passphrase) throw new VaultError('invalid', 'A passphrase is required to create a passphrase-sealed vault.');
    if (ctx.passphrase.length < 8) throw new VaultError('invalid', 'The vault passphrase must be at least 8 characters.');
    const scrypt = newScryptParams();
    return { scrypt, wrapped: wrap(scryptKey(ctx.passphrase, scrypt), master, MASTER_LABEL) };
  },
  async unseal(desc, ctx) {
    if (!desc.scrypt || !desc.wrapped) throw new VaultError('format', 'The vault key file has no wrapped key.');
    if (!ctx.passphrase) throw new VaultLockedError();
    const key = unwrap(scryptKey(ctx.passphrase, desc.scrypt), desc.wrapped, MASTER_LABEL);
    if (!key) throw new VaultError('wrong-passphrase', 'Wrong vault passphrase.');
    return key;
  },
};

// ── memory (tests) ───────────────────────────────────────────────────

/**
 * A provider that seals into this process's memory. For tests: it touches no
 * keyring and no disk, and a vault sealed with it is unreadable once the
 * process exits — which is exactly what an isolated test store should be.
 */
export function memoryKeyProvider(): KeyProvider {
  const held = new Map<string, Buffer>();
  return {
    kind: 'memory',
    interactive: false,
    async available() { return true; },
    async seal(master) {
      const id = crypto.randomBytes(8).toString('hex');
      held.set(id, Buffer.from(master));
      return { sealed: id };
    },
    async unseal(desc) {
      const key = desc.sealed ? held.get(desc.sealed) : undefined;
      if (!key) throw new VaultLockedError('This test vault key is not held by this process.');
      return Buffer.from(key);
    },
  };
}

// ── selection ────────────────────────────────────────────────────────

export const BUILTIN_PROVIDERS: Readonly<Record<Exclude<KeyProviderKind, 'memory'>, KeyProvider>> = {
  injected: injectedKeyProvider,
  dpapi: dpapiKeyProvider,
  'macos-keychain': macKeychainProvider,
  'secret-tool': secretToolProvider,
  passphrase: passphraseKeyProvider,
};

/**
 * The provider a *new* vault should be sealed with.
 *
 * An existing vault always reopens with the provider named in its key file;
 * this only decides the first one. `AICO_VAULT_KEY_PROVIDER` is how AICO
 * Desktop asks for `injected` — naming a provider is not secret, only the key
 * is, so an environment variable is fine for this and never for that.
 */
export async function defaultKeyProvider(preference?: string): Promise<KeyProvider> {
  const want = process.env.AICO_VAULT_KEY_PROVIDER?.trim() || preference || 'auto';
  if (want !== 'auto') {
    const named = BUILTIN_PROVIDERS[want as keyof typeof BUILTIN_PROVIDERS];
    if (!named) throw new VaultError('invalid', `Unknown vault key provider "${want}".`);
    return named;
  }
  for (const p of [dpapiKeyProvider, macKeychainProvider, secretToolProvider]) {
    if (await p.available()) return p;
  }
  return passphraseKeyProvider;
}

// ── standalone human-grant passphrase ────────────────────────────────

const GRANT_LABEL = 'aico-vault:grant-check';

export function makeGrantVerifier(passphrase: string): NonNullable<KeyDescriptor['grant']> {
  if (passphrase.length < 8) throw new VaultError('invalid', 'The grant passphrase must be at least 8 characters.');
  const scrypt = newScryptParams();
  return { scrypt, check: wrap(scryptKey(passphrase, scrypt), Buffer.from(GRANT_LABEL), GRANT_LABEL) };
}

export function checkGrantVerifier(verifier: NonNullable<KeyDescriptor['grant']>, passphrase: string): boolean {
  return unwrap(scryptKey(passphrase, verifier.scrypt), verifier.check, GRANT_LABEL) !== undefined;
}
