/**
 * Sealing credential records at rest, and the file discipline around it.
 *
 * AES-256-GCM per record with a fresh random IV each write, and the record's
 * id and version bound in as additional authenticated data. Binding the AAD is
 * what makes a swap detectable: copying record A's ciphertext over record B's,
 * or replaying an older version of B, fails authentication instead of quietly
 * decrypting to the wrong thing. The policy lives *inside* the ciphertext for
 * the same reason — a same-user process that can edit the file could otherwise
 * loosen a policy without the key.
 *
 * On top of the records the file carries an HMAC over the record list, so a
 * deleted or reordered record is also detected. What this cannot stop, and
 * does not claim to: replacing the whole file with an older, genuine copy.
 * That needs a counter stored somewhere the attacker cannot write, and a
 * same-user process can write everywhere the vault can.
 *
 * Writes are atomic (temp file, fsync, rename) and serialised across processes
 * by a lock file, because the CLI and a running server share one vault.
 * `node:crypto` only — no native dependency.
 *
 * @module vault/crypto
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { VaultError, VaultTamperedError } from './types.js';

export const FILE_FORMAT = 'aico-vault';
export const FILE_VERSION = 1;
const IV_BYTES = 12;
const KEY_BYTES = 32;

/** One sealed record as stored on disk. */
export interface SealedRecord {
  id: string;
  /** Monotonic per record; bumped on every write so a replay fails the AAD. */
  v: number;
  iv: string;
  tag: string;
  ct: string;
}

/** The vault file. */
export interface VaultFile {
  format: typeof FILE_FORMAT;
  version: number;
  /** Key-check value: identifies which master key sealed this file. */
  kcv: string;
  records: SealedRecord[];
  /** HMAC over the record list (ids, versions, tags). */
  mac: string;
}

/** Subkeys derived from the master key, one per purpose. */
export interface DerivedKeys {
  enc: Buffer;
  mac: Buffer;
  kcv: string;
}

/**
 * Derive per-purpose keys, so the master key is never used directly for two
 * different jobs.
 */
export function deriveKeys(master: Buffer): DerivedKeys {
  if (master.length !== KEY_BYTES) throw new VaultError('invalid', 'The vault master key must be 32 bytes.');
  const sub = (info: string): Buffer =>
    Buffer.from(crypto.hkdfSync('sha256', master, Buffer.alloc(0), `aico-vault/${info}`, KEY_BYTES));
  return { enc: sub('enc'), mac: sub('mac'), kcv: sub('kcv').subarray(0, 8).toString('hex') };
}

/** A fresh random master key. */
export function newMasterKey(): Buffer {
  return crypto.randomBytes(KEY_BYTES);
}

function aad(id: string, version: number): Buffer {
  return Buffer.from(`${FILE_FORMAT}:v${FILE_VERSION}:${id}:${version}`, 'utf8');
}

/** Seal one record's plaintext. */
export function sealRecord(keys: DerivedKeys, id: string, version: number, plaintext: Buffer): SealedRecord {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv('aes-256-gcm', keys.enc, iv);
  cipher.setAAD(aad(id, version));
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { id, v: version, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ct: ct.toString('base64') };
}

/** Open one record; throws {@link VaultTamperedError} on any authentication failure. */
export function openRecord(keys: DerivedKeys, record: SealedRecord): Buffer {
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', keys.enc, Buffer.from(record.iv, 'base64'));
    decipher.setAAD(aad(record.id, record.v));
    decipher.setAuthTag(Buffer.from(record.tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(record.ct, 'base64')), decipher.final()]);
  } catch {
    // Deliberately says nothing about which byte was wrong or what it held.
    throw new VaultTamperedError(`Credential record ${record.id} failed authentication: it was modified, `
      + 'swapped or sealed with a different key.');
  }
}

/** MAC over the record list, so deletion and reordering are detected too. */
export function macRecords(keys: DerivedKeys, records: SealedRecord[]): string {
  const h = crypto.createHmac('sha256', keys.mac);
  h.update(`${FILE_FORMAT}:${FILE_VERSION}:${records.length}\n`);
  for (const r of records) h.update(`${r.id}:${r.v}:${r.tag}\n`);
  return h.digest('base64');
}

/** Constant-time string comparison. */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

/** Verify a file's MAC. */
export function verifyFile(keys: DerivedKeys, file: VaultFile): void {
  if (!safeEqual(file.kcv, keys.kcv)) {
    throw new VaultError('wrong-passphrase', 'This vault was sealed with a different key.');
  }
  if (!safeEqual(file.mac, macRecords(keys, file.records))) {
    throw new VaultTamperedError('The vault file failed its integrity check: records were added, removed '
      + 'or reordered outside AICO.');
  }
}

/** Parse and shape-check a vault file. Unknown future versions are refused, not guessed at. */
export function parseVaultFile(text: string): VaultFile {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { throw new VaultError('format', 'The vault file is not valid JSON.'); }
  const f = raw as Partial<VaultFile>;
  if (!f || f.format !== FILE_FORMAT || typeof f.version !== 'number' || !Array.isArray(f.records)
    || typeof f.mac !== 'string' || typeof f.kcv !== 'string') {
    throw new VaultError('format', 'This is not an AICO credential vault file.');
  }
  if (f.version > FILE_VERSION) {
    throw new VaultError('format', `The vault file is format ${f.version}, written by a newer AICO. `
      + 'Update AICO rather than let an older version rewrite it.');
  }
  for (const r of f.records) {
    if (!r || typeof r.id !== 'string' || typeof r.v !== 'number' || typeof r.iv !== 'string'
      || typeof r.tag !== 'string' || typeof r.ct !== 'string') {
      throw new VaultError('format', 'The vault file has a malformed record.');
    }
  }
  return f as VaultFile;
}

/**
 * Migrations from older formats, by source version.
 *
 * Empty while there is only one format. The shape is here so the first
 * migration lands with a backup already guaranteed by {@link migrateFile}.
 */
const MIGRATIONS: Record<number, (file: VaultFile) => VaultFile> = {};

/**
 * Bring a file to the current format, keeping a byte-for-byte backup of the
 * original first. A migration that loses a record is recoverable from the
 * backup; one without a backup is not.
 */
export function migrateFile(filePath: string, file: VaultFile): VaultFile {
  if (file.version === FILE_VERSION) return file;
  const backup = `${filePath}.bak-v${file.version}-${Date.now()}`;
  fs.copyFileSync(filePath, backup);
  let current = file;
  while (current.version < FILE_VERSION) {
    const step = MIGRATIONS[current.version];
    if (!step) throw new VaultError('format', `No migration from vault format ${current.version}. A backup is at ${backup}.`);
    current = step(current);
  }
  return current;
}

// ── Files ────────────────────────────────────────────────────────────

/**
 * Write a file atomically: temp file in the same directory, fsync, rename.
 *
 * A crash leaves either the old file or the new one, never half of either.
 * Mode 0600 on POSIX; on Windows the file inherits the user profile's ACL.
 */
export function writeFileAtomic(filePath: string, data: string | Buffer): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`);
  const fd = fs.openSync(tmp, 'w', 0o600);
  try {
    fs.writeSync(fd, typeof data === 'string' ? Buffer.from(data, 'utf8') : data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  // Windows refuses a rename over a file another process has open for a
  // moment (an antivirus scan, a concurrent reader). Brief retries turn that
  // transient refusal into a success instead of a lost write.
  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(tmp, filePath);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (attempt >= 20 || (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES')) {
        try { fs.rmSync(tmp, { force: true }); } catch { /* best effort */ }
        throw err;
      }
      sleepSync(25);
    }
  }
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** A lock older than this is presumed abandoned by a crashed process. */
const STALE_LOCK_MS = 15_000;

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Run `fn` holding a cross-process lock.
 *
 * `wx` creation is atomic on every platform Node supports, which makes the
 * lock file itself the mutex. A lock whose owner is dead, or that is older
 * than {@link STALE_LOCK_MS}, is broken rather than waited on forever — a
 * crashed CLI must not wedge the server's vault.
 */
export function withFileLock<T>(lockPath: string, fn: () => T, timeoutMs = 5_000): T {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const fd = fs.openSync(lockPath, 'wx', 0o600);
      fs.writeSync(fd, `${process.pid}:${Date.now()}`);
      fs.closeSync(fd);
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      try {
        const [pid, at] = fs.readFileSync(lockPath, 'utf8').split(':').map(Number);
        const stale = !pid || !at || Date.now() - at > STALE_LOCK_MS || !pidAlive(pid);
        if (stale) { fs.rmSync(lockPath, { force: true }); continue; }
      } catch { /* vanished between exists and read: retry */ }
      if (Date.now() > deadline) throw new VaultError('lock-timeout', 'Another AICO process is holding the vault lock.');
      sleepSync(20);
    }
  }
  try {
    return fn();
  } finally {
    try { fs.rmSync(lockPath, { force: true }); } catch { /* best effort */ }
  }
}

// ── Passphrase wrapping (used by keys.ts and export) ─────────────────

export interface ScryptParams { salt: string; N: number; r: number; p: number }

/** scrypt with parameters strong enough for an interactive unlock (~100ms). */
export function scryptKey(passphrase: string, params: ScryptParams): Buffer {
  return crypto.scryptSync(passphrase.normalize('NFKC'), Buffer.from(params.salt, 'base64'), KEY_BYTES, {
    N: params.N, r: params.r, p: params.p, maxmem: 256 * 1024 * 1024,
  });
}

export function newScryptParams(): ScryptParams {
  return { salt: crypto.randomBytes(16).toString('base64'), N: 2 ** 15, r: 8, p: 1 };
}

export interface Wrapped { iv: string; tag: string; ct: string }

/** Encrypt a small blob under a key with a purpose label as AAD. */
export function wrap(key: Buffer, plaintext: Buffer, label: string): Wrapped {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(label, 'utf8'));
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ct: ct.toString('base64') };
}

/** Reverse {@link wrap}; `undefined` when the key or label is wrong. */
export function unwrap(key: Buffer, wrapped: Wrapped, label: string): Buffer | undefined {
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(wrapped.iv, 'base64'));
    decipher.setAAD(Buffer.from(label, 'utf8'));
    decipher.setAuthTag(Buffer.from(wrapped.tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(wrapped.ct, 'base64')), decipher.final()]);
  } catch {
    return undefined;
  }
}
