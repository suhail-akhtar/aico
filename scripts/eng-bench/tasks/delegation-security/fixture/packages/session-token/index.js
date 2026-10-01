import crypto from 'node:crypto';

const b64 = (s) => Buffer.from(s).toString('base64url');

/** `payload` must include `sub`; `ttlSeconds` sets `exp`. */
export function signToken(payload, secret, { ttlSeconds = 3600, now = Date.now() } = {}) {
  const body = b64(JSON.stringify({ ...payload, exp: Math.floor(now / 1000) + ttlSeconds }));
  const sig = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${sig}`;
}

/** The payload of a valid token, or null. */
export function verifyToken(token, secret, { now = Date.now() } = {}) {
  if (typeof token !== 'string') return null;
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  const expected = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  if (sig !== expected) return null;
  try {
    return JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}
