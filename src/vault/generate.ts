/**
 * Making credentials nobody has to know.
 *
 * The owner's scenario is an agent that stands up a service and creates its
 * admin account itself. The password is generated here, stored in the vault,
 * and used from there; the user never needs to see it and the model never
 * does. Only the non-secret half comes back: the username, an SSH *public*
 * key, a fingerprint.
 *
 * Randomness is `crypto.randomInt` / `randomBytes` only — `randomInt` is
 * uniform without modulo bias, which a hand-rolled `% alphabet.length` is not.
 *
 * SSH keys are ed25519 in OpenSSH's own private-key format
 * (`openssh-key-v1`), written out here rather than via PKCS#8 because
 * `ssh` and `ssh-keygen` read that format everywhere without conversion.
 *
 * @module vault/generate
 */

import crypto from 'node:crypto';
import { VaultError } from './types.js';

export interface PasswordOptions {
  /** Default 24, minimum 8, maximum 256. */
  length?: number;
  lower?: boolean;
  upper?: boolean;
  digits?: boolean;
  /** Default true. Some services reject symbols; set false for those. */
  symbols?: boolean;
  /** Symbols to draw from. Defaults to a set that survives shells, URLs and config files. */
  symbolSet?: string;
  /** Leave out look-alikes (0/O, 1/l/I). Default true. */
  excludeAmbiguous?: boolean;
}

const LOWER = 'abcdefghijklmnopqrstuvwxyz';
const UPPER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const DIGITS = '0123456789';
/** No quotes, backslash, `$`, backtick, `%`, `&`, `#` or space: nothing that needs escaping somewhere. */
const SAFE_SYMBOLS = '-_.~!@^*+=:,';
const AMBIGUOUS = /[0O1lI]/g;

/** A random password with at least one character from every enabled class. */
export function generatePassword(opts: PasswordOptions = {}): string {
  const length = opts.length ?? 24;
  if (!Number.isInteger(length) || length < 8 || length > 256) throw new VaultError('invalid', 'Password length must be 8–256.');
  const strip = (s: string): string => (opts.excludeAmbiguous === false ? s : s.replace(AMBIGUOUS, ''));
  const classes = [
    opts.lower !== false ? strip(LOWER) : '',
    opts.upper !== false ? strip(UPPER) : '',
    opts.digits !== false ? strip(DIGITS) : '',
    opts.symbols !== false ? (opts.symbolSet ?? SAFE_SYMBOLS) : '',
  ].filter(Boolean);
  if (!classes.length) throw new VaultError('invalid', 'At least one character class must be enabled.');
  const all = classes.join('');
  const chars = classes.map(c => c[crypto.randomInt(c.length)]!);
  while (chars.length < length) chars.push(all[crypto.randomInt(all.length)]!);
  // Fisher–Yates, so the guaranteed characters are not always at the front.
  for (let i = chars.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j]!, chars[i]!];
  }
  return chars.join('');
}

/** A random token: `bytes` of entropy, base64url (default) or hex. */
export function generateToken(bytes = 32, encoding: 'base64url' | 'hex' = 'base64url'): string {
  if (!Number.isInteger(bytes) || bytes < 16 || bytes > 512) throw new VaultError('invalid', 'Token size must be 16–512 bytes.');
  return crypto.randomBytes(bytes).toString(encoding);
}

// ── SSH ──────────────────────────────────────────────────────────────

function sshString(data: Buffer | string): Buffer {
  const body = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  const len = Buffer.alloc(4);
  len.writeUInt32BE(body.length);
  return Buffer.concat([len, body]);
}

function uint32(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n >>> 0);
  return b;
}

export interface SshKeyPair {
  /** `ssh-ed25519 AAAA… comment` — safe to show and to install in authorized_keys. */
  publicKey: string;
  /** OpenSSH-format private key (PEM armour). Secret. */
  privateKey: string;
  /** `SHA256:…`, as `ssh-keygen -lf` prints it. */
  fingerprint: string;
}

/** A new ed25519 key pair, private key unencrypted (the vault is its encryption). */
export function generateSshKeyPair(comment = 'aico'): SshKeyPair {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const pubJwk = publicKey.export({ format: 'jwk' }) as { x: string };
  const privJwk = privateKey.export({ format: 'jwk' }) as { d: string };
  const pub = Buffer.from(pubJwk.x, 'base64url');
  const seed = Buffer.from(privJwk.d, 'base64url');

  const pubBlob = Buffer.concat([sshString('ssh-ed25519'), sshString(pub)]);
  const check = crypto.randomBytes(4);
  let privSection = Buffer.concat([
    check, check,
    sshString('ssh-ed25519'),
    sshString(pub),
    sshString(Buffer.concat([seed, pub])),
    sshString(comment),
  ]);
  // Padding 1,2,3,… to the cipher block size (8 for "none").
  const pad: number[] = [];
  for (let i = 1; (privSection.length + pad.length) % 8 !== 0; i++) pad.push(i);
  privSection = Buffer.concat([privSection, Buffer.from(pad)]);

  const body = Buffer.concat([
    Buffer.from('openssh-key-v1\0', 'latin1'),
    sshString('none'),
    sshString('none'),
    sshString(Buffer.alloc(0)),
    uint32(1),
    sshString(pubBlob),
    sshString(privSection),
  ]);
  const b64 = body.toString('base64').match(/.{1,70}/g)!.join('\n');
  seed.fill(0);
  return {
    publicKey: `ssh-ed25519 ${pubBlob.toString('base64')}${comment ? ` ${comment}` : ''}`,
    privateKey: `-----BEGIN OPENSSH PRIVATE KEY-----\n${b64}\n-----END OPENSSH PRIVATE KEY-----\n`,
    fingerprint: sshFingerprint(pubBlob),
  };
}

/** `SHA256:<base64, no padding>` of a public key blob. */
export function sshFingerprint(pubBlob: Buffer): string {
  return `SHA256:${crypto.createHash('sha256').update(pubBlob).digest('base64').replace(/=+$/, '')}`;
}
