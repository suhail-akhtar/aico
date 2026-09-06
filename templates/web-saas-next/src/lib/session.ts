/**
 * A signed, HTTP-only session cookie. No session table, no JWT library.
 *
 * The cookie carries `userId.expires.signature`; the signature is an HMAC over
 * the first two parts with `SESSION_SECRET`. Rotating the secret signs every
 * user out, which is the intended lever. Pure functions here; the cookie
 * plumbing is in auth.ts so these can be tested without Next.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export const SESSION_COOKIE = 'session';
export const SESSION_DAYS = 30;

function secret(): string {
  const s = process.env.SESSION_SECRET;
  if (!s || s.length < 16) {
    throw new Error('SESSION_SECRET is missing or too short: set a long random string in .env.local (see .env.example)');
  }
  return s;
}

function sign(payload: string): string {
  return createHmac('sha256', secret()).update(payload).digest('base64url');
}

export function encodeSession(userId: number, now = Date.now()): string {
  const expires = now + SESSION_DAYS * 86_400_000;
  const payload = `${userId}.${expires}`;
  return `${payload}.${sign(payload)}`;
}

/** The user id in a valid, unexpired cookie; otherwise undefined. */
export function decodeSession(value: string | undefined, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const parts = value.split('.');
  if (parts.length !== 3) return undefined;
  const [id, expires, sig] = parts as [string, string, string];
  const expected = sign(`${id}.${expires}`);
  if (sig.length !== expected.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return undefined;
  if (Number(expires) < now) return undefined;
  const userId = Number(id);
  return Number.isInteger(userId) && userId > 0 ? userId : undefined;
}
