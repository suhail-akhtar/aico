/**
 * The request helpers every REST adapter after GitHub needs, parameterised by the provider's
 * name and the way it words an error (GitLab, Gitea/Forgejo and GitBucket use this; the GitHub
 * adapter keeps its own copy, written first, and is deliberately not refactored to share it).
 *
 * WHY a module and not a copy per adapter: the four rules below are the ones that, when one
 * adapter gets them subtly wrong, turn into a silent bug at the board.
 *
 *  - **A non-2xx page is an error, never an empty list.** The client hands 403/404 back as
 *    values; a list read as `[]` after a 403 looks like "nothing to import" and closes the
 *    tasks that were imported (sync.ts treats absence as "closed upstream").
 *  - **Every message names the provider and what to do**, never a header, never the token.
 *  - **Optional reads** (a token may lack the right to see checks or protection) swallow
 *    exactly 403/404 and nothing else; a 5xx or a rate limit still fails the call.
 *  - **Pagination follows `Link: rel=next`** within the same origin, bounded, and reports
 *    `notModified` only when EVERY page came from the ETag cache, so a changed second page can
 *    never be hidden behind a cached first one.
 *
 * What it does not do: know any provider's URLs or shapes, or sanitise remote text (adapters do).
 *
 * @module connections/rest
 */

import type { AdapterCtx } from './adapter.js';
import { ConnectionError, nextLink, type ConnRequest, type ConnResponse } from './http.js';

export interface Obj { [k: string]: unknown }
export const asObj = (x: unknown): Obj => (x && typeof x === 'object' && !Array.isArray(x) ? x as Obj : {});
export const asArr = (x: unknown): unknown[] => (Array.isArray(x) ? x : []);
export const enc = encodeURIComponent;

export interface Rest {
  call(ctx: AdapterCtx, req: ConnRequest): Promise<ConnResponse>;
  failure(res: ConnResponse, what: string, needs?: string): ConnectionError;
  getJson(ctx: AdapterCtx, req: ConnRequest, what: string): Promise<{ res: ConnResponse; json: unknown }>;
  paged<T>(ctx: AdapterCtx, first: ConnRequest, pick: (json: unknown) => T[], what: string, maxPages?: number): Promise<{ items: T[]; notModified: boolean; more: boolean }>;
  write(ctx: AdapterCtx, req: ConnRequest, what: string, needs: string): Promise<ConnResponse>;
}

/** For optional reads: a 403/404 means "this token cannot see it"; anything else is a real failure. */
export function optional(e: unknown): undefined {
  if (e instanceof ConnectionError && (e.status === 403 || e.status === 404)) return undefined;
  throw e;
}

export function makeRest(opts: { name: string; message: (res: ConnResponse) => string }): Rest {
  const { name, message } = opts;

  function call(ctx: AdapterCtx, req: ConnRequest): Promise<ConnResponse> {
    return ctx.client.request({
      ...req,
      ...(ctx.signal ? { signal: ctx.signal } : {}),
      ...(ctx.project ? { project: ctx.project } : {}),
    });
  }

  function failure(res: ConnResponse, what: string, needs?: string): ConnectionError {
    const msg = message(res);
    const s = res.status;
    if (s === 404) return new ConnectionError(`${what} was not found, or the token cannot see it.${needs ? ` (Changing it needs ${needs}.)` : ''}`, 'not-found', 404);
    if (s === 403) {
      return new ConnectionError(
        needs ? `The token lacks permission for ${what}: it needs ${needs}.${msg ? ` ${name} says: ${msg}` : ''}` : `${name} refused access to ${what} (403).${msg ? ` ${msg}` : ''}`,
        'http', 403);
    }
    if (s === 409) return new ConnectionError(`${what}: ${msg || 'the request conflicts with the current state.'}`, 'conflict', 409);
    if (s === 422 || s === 400) return new ConnectionError(`${name} rejected ${what}: ${msg || 'the request was not valid.'}`, 'http', s);
    return new ConnectionError(`${name} answered ${s} for ${what}.${msg ? ` ${msg}` : ''}`, 'http', s);
  }

  async function getJson(ctx: AdapterCtx, req: ConnRequest, what: string): Promise<{ res: ConnResponse; json: unknown }> {
    const res = await call(ctx, req);
    if (res.status < 200 || res.status >= 300) throw failure(res, what);
    return { res, json: res.json };
  }

  async function paged<T>(ctx: AdapterCtx, first: ConnRequest, pick: (json: unknown) => T[], what: string, maxPages = 5): Promise<{ items: T[]; notModified: boolean; more: boolean }> {
    const items: T[] = [];
    let req: ConnRequest = first;
    let allCached = true;
    for (let page = 0; page < maxPages; page++) {
      const res = await call(ctx, req);
      if (res.status < 200 || res.status >= 300) throw failure(res, what);
      if (!res.notModified) allCached = false;
      items.push(...pick(res.json));
      const next = nextLink(res.headers);
      if (!next) return { items, notModified: allCached, more: false };
      const { query: _q, ...rest } = first;
      void _q;
      req = { ...rest, path: next };
    }
    return { items, notModified: allCached, more: true };
  }

  async function write(ctx: AdapterCtx, req: ConnRequest, what: string, needs: string): Promise<ConnResponse> {
    const res = await call(ctx, req);
    if (res.status < 200 || res.status >= 300) throw failure(res, what, needs);
    return res;
  }

  return { call, failure, getJson, paged, write };
}

/** The pieces of a base URL the adapters compare against: origin, host (with port), host name, and path without a trailing slash. */
export function baseOf(baseUrl: string): { origin: string; host: string; hostname: string; pathname: string } | undefined {
  try {
    const u = new URL(baseUrl);
    return { origin: u.origin, host: u.host.toLowerCase(), hostname: u.hostname.toLowerCase(), pathname: u.pathname.replace(/\/+$/, '') };
  } catch { return undefined; }
}

/** The web or clone address of a repository, rebuilt from the connection's base URL (never copied from a response). */
export function webUrl(baseUrl: string, fullName: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/${fullName}`;
}

const SEGMENT = /^[A-Za-z0-9_.-]+$/;

/**
 * `https://h[/prefix]/a/b(.git)`, `git@h:a/b(.git)`, `ssh://git@h[:port][/prefix]/a/b(.git)` as path segments,
 * or undefined when the host is not the base URL's. `prefix` is the base URL's own path (a server mounted under
 * `/gitlab`), removed from https remotes. `min`/`max` bound the number of segments (GitLab nests, Gitea does not).
 */
export function parseRemoteSegments(url: string, baseUrl: string, bounds: { min: number; max: number }): string[] | undefined {
  const base = baseOf(baseUrl);
  if (!base) return undefined;
  const sameHost = (hostname: string, host?: string): boolean => {
    const h = hostname.toLowerCase();
    // https keeps its port in the comparison; ssh ports differ from the web port by design.
    return host !== undefined ? host.toLowerCase() === base.host || (host.toLowerCase() === base.hostname && !/:\d+$/.test(base.host)) : h === base.hostname;
  };
  const finish = (pathPart: string, prefix: string): string[] | undefined => {
    let p = pathPart.replace(/^\/+/, '/');
    if (prefix) {
      if (!(p === prefix || p.startsWith(`${prefix}/`))) return undefined;
      p = p.slice(prefix.length);
    }
    const segs = p.replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '').split('/');
    if (segs.length < bounds.min || segs.length > bounds.max) return undefined;
    if (!segs.every(s => SEGMENT.test(s) && s !== '.' && s !== '..')) return undefined;
    return segs;
  };
  const t = url.trim();
  const scp = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/\/)([^\s]+)$/.exec(t);
  if (scp && !/^[a-z][a-z0-9+.-]*:\/\//i.test(t)) return sameHost(scp[1]!) ? finish(scp[2]!.replace(/^\/?/, '/'), '') : undefined;
  let u: URL;
  try { u = new URL(t); } catch { return undefined; }
  if (!['https:', 'http:', 'ssh:', 'git:'].includes(u.protocol)) return undefined;
  const web = u.protocol === 'https:' || u.protocol === 'http:';
  if (!sameHost(u.hostname, web ? u.host : undefined)) return undefined;
  // ssh remotes of a server under a prefix usually have no prefix (git@host:group/project), so only web remotes strip it.
  return finish(u.pathname, web ? base.pathname : '');
}

export interface ItemQueryText { labels: string[]; assignee?: string; author?: string; state?: 'open' | 'closed'; text: string }

/**
 * A work-item query typed the way the page suggests (`is:open label:bug assignee:ana crash on login`) into the parts
 * a REST list can use: labels, assignee, author, state, and the free text left over. Quotes are not interpreted and
 * an unknown `word:` stays free text, so nothing a person typed is dropped silently. Pure.
 */
export function parseItemQuery(input: string): ItemQueryText {
  const out: ItemQueryText = { labels: [], text: '' };
  const rest: string[] = [];
  for (const tok of input.split(/\s+/).filter(Boolean)) {
    const m = /^(label|labels|assignee|author|is|state):(.+)$/i.exec(tok);
    if (!m) { rest.push(tok); continue; }
    const key = m[1]!.toLowerCase();
    const val = m[2]!;
    if (key === 'label' || key === 'labels') out.labels.push(...val.split(',').filter(Boolean));
    else if (key === 'assignee') out.assignee = val.replace(/^@/, '');
    else if (key === 'author') out.author = val.replace(/^@/, '');
    else if ((key === 'is' || key === 'state') && /^(open|opened|closed)$/i.test(val)) out.state = /^closed$/i.test(val) ? 'closed' : 'open';
    else rest.push(tok);
  }
  out.text = rest.join(' ');
  return out;
}
