/**
 * HTTP plumbing for the control server: bodies, cookies, errors, headers, rate limits.
 *
 * No framework (ADR 0040: no new runtime dependency for what `node:http` does).
 * What lives here is what must be the same on every route:
 *  - bodies are size-capped before they are parsed (a route cannot forget);
 *  - every response carries the security headers (CSP `default-src 'self'`,
 *    `frame-ancestors 'none'`, `nosniff`, no referrer) and `no-store` for API
 *    replies, so a proxy never caches a token or a policy;
 *  - errors are `HttpError(status, code, message)` and become
 *    `{ error, message }` JSON — the message is for a person, never a stack;
 *  - a small fixed-window rate limiter, keyed by whatever the route chooses.
 *
 * @module http
 */

import type { IncomingMessage, ServerResponse } from 'node:http';

export class HttpError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly extra: Record<string, unknown> = {}) { super(message); this.name = 'HttpError'; }
}

export const MAX_BODY = 2 * 1024 * 1024;

export async function readBody(req: IncomingMessage, max = MAX_BODY): Promise<Buffer> {
  const declared = Number(req.headers['content-length'] ?? 0);
  if (declared > max) throw new HttpError(413, 'too_large', 'The request body is too large.');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > max) throw new HttpError(413, 'too_large', 'The request body is too large.');
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

/** JSON or `application/x-www-form-urlencoded` into a flat-ish object. */
export async function readParams(req: IncomingMessage, max = MAX_BODY): Promise<Record<string, unknown>> {
  if (req.method === 'GET' || req.method === 'HEAD') return {};
  const raw = (await readBody(req, max)).toString('utf8');
  if (!raw.trim()) return {};
  const type = String(req.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
  if (type === 'application/x-www-form-urlencoded') return Object.fromEntries(new URLSearchParams(raw));
  try {
    const v = JSON.parse(raw) as unknown;
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('not an object');
    return v as Record<string, unknown>;
  } catch { throw new HttpError(400, 'invalid_request', 'The request body must be a JSON object.'); }
}

export function cookies(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of String(req.headers.cookie ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function setCookie(res: ServerResponse, name: string, value: string, o: { secure: boolean; maxAgeS?: number }): void {
  const attrs = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', ...(o.secure ? ['Secure'] : []), ...(o.maxAgeS !== undefined ? [`Max-Age=${o.maxAgeS}`] : [])];
  const prev = res.getHeader('set-cookie');
  const list = Array.isArray(prev) ? prev : prev ? [String(prev)] : [];
  res.setHeader('set-cookie', [...list, attrs.join('; ')]);
}

export const CSP = "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

export function securityHeaders(res: ServerResponse, secure: boolean): void {
  res.setHeader('content-security-policy', CSP);
  res.setHeader('x-content-type-options', 'nosniff');
  // same-origin, not no-referrer: with no-referrer a browser sends `Origin: null` on the device page's own
  // form POST, which the CSRF check cannot tell from a sandboxed foreign page. Nothing leaves the origin either way.
  res.setHeader('referrer-policy', 'same-origin');
  res.setHeader('x-frame-options', 'DENY');
  res.setHeader('cross-origin-opener-policy', 'same-origin');
  if (secure) res.setHeader('strict-transport-security', 'max-age=31536000; includeSubDomains');
}

export function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(text), ...headers });
  res.end(text);
}

export function sendText(res: ServerResponse, status: number, type: string, text: string, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': `${type}; charset=utf-8`, 'cache-control': 'no-store', 'content-length': Buffer.byteLength(text), ...headers });
  res.end(text);
}

export function redirect(res: ServerResponse, to: string): void {
  res.writeHead(302, { location: to, 'cache-control': 'no-store' });
  res.end();
}

export const esc = (s: unknown): string => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** Only a same-origin relative path survives; anything else becomes `/`. */
export function safeNext(next: unknown): string {
  if (typeof next !== 'string' || !next.startsWith('/') || next.startsWith('//') || next.includes('\\') || /[\u0000-\u001f]/.test(next)) return '/';
  return next.slice(0, 500);
}

export class RateLimiter {
  private readonly hits = new Map<string, { n: number; reset: number }>();
  constructor(private readonly now: () => number = Date.now, private scale = 1) {}
  setScale(scale: number): void { this.scale = scale; }
  /** True while under `max` per `windowMs` for this key. */
  allow(key: string, max: number, windowMs: number): boolean {
    const t = this.now();
    if (this.hits.size > 20_000) for (const [k, v] of this.hits) if (v.reset < t) this.hits.delete(k);
    const h = this.hits.get(key);
    if (!h || h.reset < t) { this.hits.set(key, { n: 1, reset: t + windowMs }); return true; }
    h.n++;
    return h.n <= max * this.scale;
  }
}
