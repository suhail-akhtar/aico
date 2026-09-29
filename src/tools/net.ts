/**
 * The small amount of plumbing every keyless data tool shares.
 *
 * `Places`, `Weather`, `CurrencyRates` and `GenerateImage` each talk to someone
 * else's public service. Those services publish usage policies — a named
 * User-Agent, no hammering, a timeout on our side rather than theirs — and the
 * policies are the same shape everywhere, so they live here once instead of
 * being re-remembered (or forgotten) per tool.
 *
 * `fetch` is injectable so the tests can drive every tool without a network:
 * the harness swaps in a function that answers from fixtures, and the code
 * under test cannot tell the difference.
 *
 * @module tools/net
 */

import { createRequire } from 'module';

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

let injected: FetchLike | undefined;

/** Replace the network for these tools. Pass nothing to restore the real one. */
export function setNetFetch(fn?: FetchLike): void {
  injected = fn;
}

function net(): FetchLike {
  return injected ?? ((url, init) => globalThis.fetch(url, init));
}

let version: string | undefined;

/**
 * The User-Agent every request carries.
 *
 * Nominatim's policy requires one that identifies the application, and the
 * others ask for it; a generic browser string is how a client gets blocked
 * without anyone knowing why. The version is read from `package.json` beside
 * the bundle, with a fallback — a desktop build that moved the file must not
 * fail a weather lookup over it.
 */
export function userAgent(): string {
  if (version === undefined) {
    try {
      version = (createRequire(import.meta.url)('../package.json') as { version?: string }).version ?? 'dev';
    } catch {
      version = 'dev';
    }
  }
  return `AICO/${version} (+https://github.com/suhail-akhtar/aico)`;
}

/** An HTTP failure, carrying the status so a caller can decide to fall back. */
export class NetError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = 'NetError';
  }
}

export interface RequestOptions {
  /** What is being asked, for the error a person reads: "Nominatim search". */
  what: string;
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/**
 * Make one request and hand back the response, or a sentence saying why not.
 *
 * Three different failures, three different sentences: the service did not
 * answer in time, it could not be reached at all, or it answered with an
 * error. A model told only "fetch failed" retries; a model told "timed out
 * after 15 s" can tell the person the service is slow.
 */
export async function request(url: string, opts: RequestOptions): Promise<Response> {
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onOuterAbort = (): void => controller.abort();
  opts.signal?.addEventListener('abort', onOuterAbort, { once: true });
  let response: Response;
  try {
    response = await net()(url, {
      method: opts.method ?? 'GET',
      headers: { 'User-Agent': userAgent(), Accept: 'application/json', ...opts.headers },
      ...(opts.body !== undefined ? { body: opts.body } : {}),
      signal: controller.signal as AbortSignal,
      redirect: 'follow',
    });
  } catch (err) {
    if (controller.signal.aborted && !opts.signal?.aborted) {
      throw new NetError(`${opts.what} did not answer within ${Math.round(timeoutMs / 1000)} s — the service may be slow or down; try again shortly.`);
    }
    const host = safeHost(url);
    throw new NetError(`${opts.what} could not be reached (${host}): ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onOuterAbort);
  }
  if (!response.ok) {
    let detail = '';
    try { detail = readableError(await response.text()); } catch { /* no body */ }
    throw new NetError(`${opts.what} answered HTTP ${response.status}${detail ? `: ${detail}` : ''}`, response.status);
  }
  return response;
}

/** {@link request}, parsed as JSON. */
export async function requestJson<T>(url: string, opts: RequestOptions): Promise<T> {
  const response = await request(url, opts);
  const text = await response.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new NetError(`${opts.what} answered with something that is not JSON: ${text.slice(0, 120)}`);
  }
}

/**
 * The useful part of an error body.
 *
 * Services under load answer with an HTML error page, and three hundred
 * characters of doctype are no use to a model deciding what to tell a person.
 */
export function readableError(body: string): string {
  let text = body;
  if (/^\s*</.test(text)) {
    const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(text)?.[1];
    const main = text
      .replace(/<head[\s\S]*?<\/head>/gi, ' ')
      .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<[^>]+>/g, ' ');
    text = [title, main].filter(Boolean).join(' — ');
  }
  return text.replace(/&[a-z]+;/gi, ' ').replace(/\s+/g, ' ').trim().slice(0, 240);
}

function safeHost(url: string): string {
  try { return new URL(url).host; } catch { return url.slice(0, 60); }
}

/**
 * A short-lived memo of answers.
 *
 * Brief on purpose: weather moves and places open, so this exists to spare a
 * service the same question twice in one conversation — a model that asks for
 * the forecast, then the same forecast in Fahrenheit, then once more to be
 * sure — not to serve stale answers.
 */
export class TtlCache<V> {
  private readonly entries = new Map<string, { value: V; at: number }>();
  constructor(private readonly ttlMs: number, private readonly max = 100, private readonly now: () => number = Date.now) {}

  get(key: string): V | undefined {
    const hit = this.entries.get(key);
    if (!hit) return undefined;
    if (this.now() - hit.at > this.ttlMs) {
      this.entries.delete(key);
      return undefined;
    }
    return hit.value;
  }

  set(key: string, value: V): void {
    this.entries.delete(key);
    this.entries.set(key, { value, at: this.now() });
    while (this.entries.size > this.max) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  clear(): void { this.entries.clear(); }
}

export interface SpacerClock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

const realClock: SpacerClock = {
  now: () => Date.now(),
  sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
};

/**
 * Run tasks one at a time, each starting at least `intervalMs` after the last.
 *
 * Nominatim's usage policy is an absolute maximum of one request per second and
 * no parallel requests. Tools run up to eight at once, so two `Places` calls in
 * one step would break both halves of that without this. Serialised rather than
 * merely spaced: a slow request finishing late must not let the next start in
 * the same second as its reply.
 */
export class RequestSpacer {
  private chain: Promise<unknown> = Promise.resolve();
  private last = Number.NEGATIVE_INFINITY;

  constructor(private readonly intervalMs: number, private readonly clock: SpacerClock = realClock) {}

  run<T>(task: () => Promise<T>): Promise<T> {
    const next = this.chain.then(async () => {
      const wait = this.last + this.intervalMs - this.clock.now();
      if (wait > 0) await this.clock.sleep(wait);
      this.last = this.clock.now();
      try {
        return await task();
      } finally {
        // Measured from the end as well as the start, so a request that took
        // longer than the interval still leaves a full gap before the next.
        this.last = this.clock.now();
      }
    });
    this.chain = next.catch(() => undefined);
    return next;
  }
}

/** A value as JSON inside a fenced block, ready to paste. */
export function fencedBlock(language: string, value: unknown): string {
  return `\`\`\`${language}\n${JSON.stringify(value)}\n\`\`\``;
}

/** Round to a fixed number of decimals without trailing noise. */
export function round(value: number, decimals: number): number {
  const f = 10 ** decimals;
  return Math.round(value * f) / f;
}
