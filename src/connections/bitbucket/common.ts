/**
 * Small helpers the two Bitbucket adapters share: JSON narrowing, a request wrapper that stamps
 * the call context, and the failure sentences. Nothing here knows a Bitbucket URL or shape.
 *
 * WHY a file of its own. Cloud (REST 2.0, `{values, next}` pages, `{error:{message}}` errors) and
 * Data Center (REST 1.0, `{values, isLastPage, nextPageStart}` pages, `{errors:[{message}]}`
 * errors) share a vendor name and nothing else, so each keeps its own adapter and fold; what is
 * genuinely the same (how a failure is worded, that an id is digits, that text from a stranger is
 * sanitised and text AICO writes carries no attribution) lives here once.
 *
 * What it does not do: build URLs, fold responses, or decide anything about merging.
 *
 * @module connections/bitbucket/common
 */

import type { AdapterCtx } from '../adapter.js';
import { ConnectionError, type ConnRequest, type ConnResponse } from '../http.js';
import { sanitizeLine } from '../sanitize.js';

export interface Obj { [k: string]: unknown }
export const asObj = (x: unknown): Obj => (x && typeof x === 'object' && !Array.isArray(x) ? x as Obj : {});
export const asArr = (x: unknown): unknown[] => (Array.isArray(x) ? x : []);
export const enc = encodeURIComponent;
export const str = (x: unknown, max = 200): string => sanitizeLine(typeof x === 'string' ? x : '', max);

/** A Bitbucket pull request or issue id: digits only, so it can never carry a path or a query. */
export function numId(id: string, what: string): number {
  if (!/^\d{1,9}$/.test(id)) throw new ConnectionError(`"${id.slice(0, 40)}" is not a Bitbucket ${what} number.`, 'config');
  return Number(id);
}

export function commitSha(s: string): string {
  if (!/^[0-9a-f]{7,64}$/i.test(s)) throw new ConnectionError('That is not a commit SHA.', 'config');
  return s;
}

export function call(ctx: AdapterCtx, req: ConnRequest): Promise<ConnResponse> {
  return ctx.client.request({
    ...req,
    ...(ctx.signal ? { signal: ctx.signal } : {}),
    ...(ctx.project ? { project: ctx.project } : {}),
  });
}

/** Cloud's `{type:'error', error:{message, detail}}` and Data Center's `{errors:[{message}]}`, whichever came back. */
export function bbMessage(res: ConnResponse): string {
  const j = asObj(res.json);
  const cloud = asObj(j.error);
  const dc = asObj(asArr(j.errors)[0]);
  const text = typeof cloud.message === 'string' ? cloud.message : typeof dc.message === 'string' ? dc.message : typeof j.message === 'string' ? j.message : '';
  return sanitizeLine(text, 240);
}

/**
 * A response that is not a success, as an error the person can act on. Never mentions a header.
 * `needs` names the permission a write wants, in the provider's own words.
 */
export function failure(res: ConnResponse, what: string, needs?: string, product = 'Bitbucket'): ConnectionError {
  const msg = bbMessage(res);
  const s = res.status;
  if (s === 404) return new ConnectionError(`${what} was not found, or the token cannot see it.${needs ? ` (Changing it needs ${needs}.)` : ''}`, 'not-found', 404);
  if (s === 403) {
    return new ConnectionError(
      needs ? `The token lacks permission for ${what}: it needs ${needs}.${msg ? ` ${product} says: ${msg}` : ''}`
        : `${product} refused access to ${what} (403).${msg ? ` ${msg}` : ''}`,
      'http', 403);
  }
  if (s === 409) return new ConnectionError(`${what}: ${msg || 'the request conflicts with the current state.'}`, 'conflict', 409);
  if (s === 400 || s === 422) return new ConnectionError(`${product} rejected ${what}: ${msg || 'the request was not valid.'}`, 'http', s);
  return new ConnectionError(`${product} answered ${s} for ${what}.${msg ? ` ${msg}` : ''}`, 'http', s);
}

/** For optional reads: a 403/404 means "this token cannot see it", anything else is a real failure. */
export function optional(e: unknown): undefined {
  if (e instanceof ConnectionError && (e.status === 403 || e.status === 404)) return undefined;
  throw e;
}

/** A free-text value that goes into a query filter: no quotes, backslashes or control characters. */
export function filterValue(v: string, what: string): string {
  if (/["\\\u0000-\u001f]/.test(v)) throw new ConnectionError(`${what} contains a character that cannot be used in a Bitbucket filter.`, 'config');
  return v;
}
