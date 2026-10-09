/**
 * Being a polite client: a token bucket per connection, backoff with jitter, and the
 * ETag cache that makes an unchanged poll free.
 *
 * WHY. The engine has no public address, so it polls (ADR 0039 section 1). A board open on a
 * busy repository can ask for the same list every minute; without limits that burns the
 * token's hourly quota and, on GitHub, trips the secondary limits that return 403/429. Three
 * things keep it cheap and quiet:
 *
 *  - **Token bucket** per connection: a burst is allowed, the sustained rate is not. A request
 *    that would exceed it waits (up to a bound) instead of failing.
 *  - **Retry-After / rate-limit reset**: when the provider says "wait until T", every request on
 *    that connection fails fast with a `rate-limited` state; nothing hammers through.
 *  - **Conditional requests**: `If-None-Match` with the last ETag. A 304 costs no quota on
 *    GitHub and Gitea, and the cached body is returned to the caller.
 *
 * Pure of the network: the HTTP client (http.ts) consults and updates this state. The clock is
 * injectable so tests run in microseconds.
 *
 * @module connections/ratelimit
 */

export interface Clock { now(): number; sleep(ms: number, signal?: AbortSignal): Promise<void> }

export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms, signal) => new Promise<void>((resolve, reject) => {
    if (signal?.aborted) { reject(new Error('aborted')); return; }
    const onAbort = (): void => { clearTimeout(t); reject(new Error('aborted')); };
    const t = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  }),
};

export interface BucketOptions { capacity: number; refillPerSec: number }

/** Default sustained 5 requests per second with a burst of 20: well under every provider's limits. */
export const DEFAULT_BUCKET: BucketOptions = { capacity: 20, refillPerSec: 5 };

export class RateLimitError extends Error {
  constructor(message: string, readonly until: number) {
    super(message);
    this.name = 'RateLimitError';
  }
}

export class TokenBucket {
  private tokens: number;
  private last: number;
  constructor(private readonly opts: BucketOptions = DEFAULT_BUCKET, private readonly clock: Clock = systemClock) {
    this.tokens = opts.capacity;
    this.last = clock.now();
  }

  private refill(): void {
    const now = this.clock.now();
    this.tokens = Math.min(this.opts.capacity, this.tokens + ((now - this.last) / 1000) * this.opts.refillPerSec);
    this.last = now;
  }

  /** Milliseconds until a token is available (0 when one is). */
  waitMs(): number {
    this.refill();
    if (this.tokens >= 1) return 0;
    return Math.ceil(((1 - this.tokens) / this.opts.refillPerSec) * 1000);
  }

  /** Take a token, waiting if need be. Rejects if `maxWaitMs` would be exceeded. */
  async take(maxWaitMs = 30_000, signal?: AbortSignal): Promise<void> {
    const wait = this.waitMs();
    if (wait > maxWaitMs) throw new RateLimitError(`This connection is sending too fast; try again in ${Math.ceil(wait / 1000)} s.`, this.clock.now() + wait);
    if (wait > 0) await this.clock.sleep(wait, signal);
    this.refill();
    this.tokens -= 1;
  }
}

/** Seconds to wait from a `Retry-After` header (delta-seconds or an HTTP date), or undefined. */
export function retryAfterMs(header: string | undefined, now: number): number | undefined {
  if (!header) return undefined;
  const t = header.trim();
  if (/^\d+$/.test(t)) return Math.min(Number(t) * 1000, 3_600_000);
  const at = Date.parse(t);
  return Number.isFinite(at) ? Math.min(Math.max(0, at - now), 3_600_000) : undefined;
}

/**
 * When a response says the quota is spent: `Retry-After`, or `X-RateLimit-Remaining: 0` with
 * `X-RateLimit-Reset` (epoch seconds). Returns the epoch ms to wait until, or undefined.
 */
export function rateLimitUntil(status: number, headers: Record<string, string | string[] | undefined>, now: number): number | undefined {
  const h = (k: string): string | undefined => { const v = headers[k]; return Array.isArray(v) ? v[0] : v; };
  const ra = retryAfterMs(h('retry-after'), now);
  if (ra !== undefined && (status === 429 || status === 403 || status === 503)) return now + ra;
  if ((status === 403 || status === 429) && h('x-ratelimit-remaining') === '0') {
    const reset = Number(h('x-ratelimit-reset'));
    if (Number.isFinite(reset) && reset > 0) return Math.min(reset * 1000, now + 3_600_000);
  }
  if (status === 429) return now + 60_000;
  return undefined;
}

/** Exponential backoff with full jitter: attempt 0 up to 1 s, 1 up to 2 s ... capped. `rand` is injectable. */
export function backoffMs(attempt: number, opts: { base?: number; cap?: number; rand?: () => number } = {}): number {
  const base = opts.base ?? 1000;
  const cap = opts.cap ?? 300_000;
  const rand = opts.rand ?? Math.random;
  return Math.floor(rand() * Math.min(cap, base * 2 ** Math.max(0, attempt)));
}

// ── conditional requests ──────────────────────────────────────────────────

export interface CachedResponse { etag: string; status: number; body: Buffer; headers: Record<string, string> }

/** A small LRU of the last response per URL, for `If-None-Match`. Bodies are bounded. */
export class EtagCache {
  private readonly map = new Map<string, CachedResponse>();
  constructor(private readonly max = 200, private readonly maxBytes = 2 * 1024 * 1024) {}
  get(key: string): CachedResponse | undefined {
    const v = this.map.get(key);
    if (v) { this.map.delete(key); this.map.set(key, v); }
    return v;
  }
  set(key: string, value: CachedResponse): void {
    if (value.body.length > this.maxBytes) return;
    this.map.delete(key);
    this.map.set(key, value);
    while (this.map.size > this.max) this.map.delete(this.map.keys().next().value as string);
  }
  clear(): void { this.map.clear(); }
}
