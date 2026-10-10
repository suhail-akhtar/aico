/**
 * Every cryptographic primitive the control server uses, in one place.
 *
 * Why one file: the security review of a server like this is "where do secrets
 * and signatures come from", and the answer should be a single module small
 * enough to read. No dependency — `node:crypto` only (ADR 0040).
 *
 *  - Opaque tokens (sessions, refresh tokens, device codes) are random and are
 *    stored only as SHA-256 hashes, so a database read never yields a usable one.
 *  - Access tokens are EdDSA (Ed25519) JWTs. The verifier pins the algorithm:
 *    a token whose header says anything else (`none`, `HS256`) is refused
 *    before any key is touched.
 *  - Tenant secrets (an IdP client secret) are AES-256-GCM sealed under a key
 *    derived per tenant with HKDF from the master key, so one tenant's
 *    ciphertext is not decryptable with another's key even if rows are swapped.
 *  - Hash chain helpers use a canonical JSON (sorted keys) so the same record
 *    hashes the same on every run and in the verifier.
 *
 * Deliberately not here: password hashing (nothing here ever sees a password).
 *
 * @module crypto
 */

import crypto from 'node:crypto';

export const sha256hex = (s: string | Buffer): string => crypto.createHash('sha256').update(s).digest('hex');

export const b64u = (b: Buffer | string): string => Buffer.from(b).toString('base64url');

/** `bytes` of randomness as base64url. */
export const randomToken = (bytes = 32): string => crypto.randomBytes(bytes).toString('base64url');

export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/** JSON with sorted keys at every depth: the form that is hashed. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const o = value as Record<string, unknown>;
  return `{${Object.keys(o).filter(k => o[k] !== undefined).sort().map(k => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(',')}}`;
}

// ── sealing ─────────────────────────────────────────────────────────

export function tenantKey(master: Buffer, tenantId: string): Buffer {
  return Buffer.from(crypto.hkdfSync('sha256', master, Buffer.from('aico-control/v1'), Buffer.from(`tenant:${tenantId}`), 32));
}

/** AES-256-GCM; the associated data binds the ciphertext to its purpose. */
export function seal(key: Buffer, plaintext: string, aad: string): string {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(Buffer.from(aad));
  const ct = Buffer.concat([c.update(plaintext, 'utf8'), c.final()]);
  return `v1.${b64u(iv)}.${b64u(c.getAuthTag())}.${b64u(ct)}`;
}

export function open(key: Buffer, sealed: string, aad: string): string {
  const [v, iv, tag, ct] = sealed.split('.');
  if (v !== 'v1' || !iv || !tag || !ct) throw new Error('sealed value is malformed');
  const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
  d.setAAD(Buffer.from(aad));
  d.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]).toString('utf8');
}

// ── access tokens (EdDSA JWT) ───────────────────────────────────────

export interface SigningKey { kid: string; privateKey: crypto.KeyObject; publicKey: crypto.KeyObject }

export function generateSigningKey(): { key: SigningKey; privatePem: string } {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const der = publicKey.export({ type: 'spki', format: 'der' });
  return {
    key: { kid: sha256hex(der).slice(0, 16), privateKey, publicKey },
    privatePem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  };
}

export function signingKeyFromPem(pem: string): SigningKey {
  const privateKey = crypto.createPrivateKey(pem);
  const publicKey = crypto.createPublicKey(privateKey);
  return { kid: sha256hex(publicKey.export({ type: 'spki', format: 'der' })).slice(0, 16), privateKey, publicKey };
}

export function signJwt(key: SigningKey, claims: Record<string, unknown>): string {
  const head = b64u(JSON.stringify({ alg: 'EdDSA', typ: 'JWT', kid: key.kid }));
  const body = b64u(JSON.stringify(claims));
  const sig = crypto.sign(null, Buffer.from(`${head}.${body}`), key.privateKey);
  return `${head}.${body}.${b64u(sig)}`;
}

/** Claims of a valid, unexpired token, or undefined. Never throws on bad input. */
export function verifyJwt(key: SigningKey, token: string, nowSec: number): Record<string, unknown> | undefined {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return undefined;
    const [h, p, s] = parts as [string, string, string];
    const head = JSON.parse(Buffer.from(h, 'base64url').toString('utf8')) as Record<string, unknown>;
    if (head.alg !== 'EdDSA' || head.kid !== key.kid) return undefined;
    if (!crypto.verify(null, Buffer.from(`${h}.${p}`), key.publicKey, Buffer.from(s, 'base64url'))) return undefined;
    const claims = JSON.parse(Buffer.from(p, 'base64url').toString('utf8')) as Record<string, unknown>;
    if (typeof claims.exp !== 'number' || claims.exp <= nowSec) return undefined;
    return claims;
  } catch { return undefined; }
}

// ── PKCE ────────────────────────────────────────────────────────────

export const pkceChallenge = (verifier: string): string => crypto.createHash('sha256').update(verifier).digest('base64url');

// ── user codes ──────────────────────────────────────────────────────

/** No vowels (no accidental words) and no 0/O/1/I/L/5/S lookalikes. */
const CODE_ALPHABET = 'BCDFGHJKMNPQRTVWXZ2346789';

export function userCode(): string {
  const pick = (n: number): string => Array.from(crypto.randomBytes(n), b => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
  return `${pick(4)}-${pick(4)}`;
}

export const normaliseUserCode = (s: string): string => {
  const c = s.toUpperCase().replace(/[^A-Z0-9]/g, '');
  return c.length === 8 ? `${c.slice(0, 4)}-${c.slice(4)}` : c;
};
