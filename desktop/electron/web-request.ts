/**
 * One `onBeforeSendHeaders` and one `onHeadersReceived` listener per session,
 * shared by everyone who needs them.
 *
 * Electron keeps a single listener per webRequest event per session: a second
 * `ses.webRequest.onBeforeSendHeaders(...)` silently replaces the first. So the
 * chat's embed Referer (protocol.ts), the browser's privacy headers and its
 * third-party-cookie rule (browser-privacy.ts) each register a handler here,
 * and the dispatcher runs them in order on the same headers.
 *
 * @module desktop/electron/web-request
 */

import type { Session } from 'electron';

type ReqDetails = Electron.OnBeforeSendHeadersListenerDetails;
type ResDetails = Electron.OnHeadersReceivedListenerDetails;
export type RequestHeaders = Record<string, string>;
export type ResponseHeaders = Record<string, string[]>;

/** Return new headers to change them, or nothing to leave them. */
export type RequestHandler = (details: ReqDetails, headers: RequestHeaders) => RequestHeaders | void;
export type ResponseHandler = (details: ResDetails, headers: ResponseHeaders | undefined) => ResponseHeaders | void;

interface Entry<H> { match: ((url: string) => boolean) | null; fn: H }
interface Hub { req: Array<Entry<RequestHandler>>; res: Array<Entry<ResponseHandler>>; reqOn: boolean; resOn: boolean }

const hubs = new WeakMap<Session, Hub>();

/** Electron's URL patterns ("https://*.openstreetmap.org/*") as a test; `*.` in a host also matches the bare domain. */
export function urlMatcher(patterns: string[] | undefined): ((url: string) => boolean) | null {
  if (!patterns?.length) return null;
  const res = patterns.map(p => new RegExp(`^${p
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    .replace(/:\/\/\*\\\./, '://\u0000')
    .replace(/\*/g, '.*')
    .replace('\u0000', '(?:[^/]*\\.)?')}$`, 'i'));
  return (url) => res.some(r => r.test(url));
}

function hubOf(ses: Session): Hub {
  let hub = hubs.get(ses);
  if (!hub) { hub = { req: [], res: [], reqOn: false, resOn: false }; hubs.set(ses, hub); }
  return hub;
}

export function onRequestHeaders(ses: Session, urls: string[] | undefined, fn: RequestHandler): void {
  const hub = hubOf(ses);
  hub.req.push({ match: urlMatcher(urls), fn });
  if (hub.reqOn) return;
  hub.reqOn = true;
  ses.webRequest.onBeforeSendHeaders((details, callback) => {
    let headers = details.requestHeaders;
    let changed = false;
    for (const e of hub.req) {
      if (e.match && !e.match(details.url)) continue;
      try {
        const next = e.fn(details, headers);
        if (next) { headers = next; changed = true; }
      } catch (err) { console.error('onBeforeSendHeaders handler failed:', err); }
    }
    callback(changed ? { requestHeaders: headers } : {});
  });
}

export function onResponseHeaders(ses: Session, urls: string[] | undefined, fn: ResponseHandler): void {
  const hub = hubOf(ses);
  hub.res.push({ match: urlMatcher(urls), fn });
  if (hub.resOn) return;
  hub.resOn = true;
  ses.webRequest.onHeadersReceived((details, callback) => {
    let headers = details.responseHeaders;
    let changed = false;
    for (const e of hub.res) {
      if (e.match && !e.match(details.url)) continue;
      try {
        const next = e.fn(details, headers);
        if (next) { headers = next; changed = true; }
      } catch (err) { console.error('onHeadersReceived handler failed:', err); }
    }
    callback(changed ? { responseHeaders: headers } : {});
  });
}
