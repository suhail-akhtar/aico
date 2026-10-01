import crypto from 'node:crypto';

// Reference fix (grader self-test only).
const b64 = (s) => Buffer.from(s).toString('base64url');

export function signToken(payload, secret, { ttlSeconds = 3600, now = Date.now() } = {}) {
  const body = b64(JSON.stringify({ ...payload, exp: Math.floor(now / 1000) + ttlSeconds }));
  const sig = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${sig}`;
}

export function verifyToken(token, secret, { now = Date.now() } = {}) {
  if (typeof token !== 'string') return null;
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  const expected = crypto.createHmac('sha256', secret).update(body).digest();
  const given = Buffer.from(sig, 'base64url');
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
  if (sig !== given.toString('base64url')) return null;
  let payload;
  try { payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch { return null; }
  if (!payload || typeof payload.exp !== 'number' || payload.exp * 1000 <= now) return null;
  return payload;
}
