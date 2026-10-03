/**
 * Scripted HTML previews — `aico://preview/<token>/…`, the wiring (ADR 0020).
 * The rules and their tests are in `preview-core.ts`; this file connects them
 * to IPC, the protocol handler and navigation.
 *
 *   preview:register {session, path} | {html}  → { url }   (the AICO window only)
 *   aico://preview/<token>/<file>  → that file's bytes, fetched from the engine
 *                                    by main with the token, served with the
 *                                    preview CSP (no Content-Disposition, the
 *                                    engine's own headers dropped)
 *   will-frame-navigate (+ the     → a preview frame stays inside its token
 *   sub-frame request)
 *
 * The preview origin never talks to the engine itself and never sees its
 * token: main fetches `GET /api/artifacts/file` (which checks the path is
 * inside the chat's artifacts folder after following links) and returns only
 * the bytes. The window has no preload in subframes (`nodeIntegrationInSubFrames`
 * is off), so a preview frame has no `aicoDesktop` bridge either.
 *
 * @module desktop/electron/preview
 */

import crypto from 'node:crypto';
import { app, session, webContents, type WebContents } from 'electron';
import type { DesktopContext } from './context';
import type { EngineHost } from './engine-host';
import { PreviewRegistry, cdnsReferenced, previewCsp, previewMime, previewNavigationAllowed, PREVIEW_HOST } from './preview-core';

export { PREVIEW_HOST };

export const previews = new PreviewRegistry(() => crypto.randomBytes(18).toString('base64url'));

export function registerPreview(ctx: DesktopContext): void {
  ctx.handle('preview:register', (input: { session?: unknown; path?: unknown; html?: unknown } = {}) => {
    const r = typeof input.html === 'string' ? previews.registerHtml(input.html) : previews.registerFile(input.session, input.path);
    if ('error' in r) throw new Error(r.error);
    return { url: r.url };
  });
  // A preview frame navigating itself (`location = 'https://www.youtube-nocookie.com/?data'`,
  // a host the window's frame-src allows) is refused here — measured: the event fires with the
  // preview as initiator and is prevented; hosts outside frame-src never get this far.
  const guard = (wc: WebContents): void => {
    wc.on('will-frame-navigate', (details) => {
      let from: string | undefined;
      try { from = details.initiator?.url ?? undefined; } catch { /* frame already gone */ }
      if (!from) { try { from = details.frame?.url; } catch { /* frame already gone */ } }
      if (!previewNavigationAllowed(from, details.url)) details.preventDefault();
    });
  };
  for (const wc of webContents.getAllWebContents()) guard(wc);
  app.on('web-contents-created', (_e, wc) => guard(wc));
  // The same rule on the request, in case a navigation reaches the network without the event
  // (the AICO window's session; nothing else registers onBeforeRequest on it — the built-in
  // browser's partition has its own).
  session.defaultSession.webRequest.onBeforeRequest((d, cb) => {
    if (d.resourceType !== 'subFrame') { cb({}); return; }
    let from: string | undefined;
    try { from = d.frame?.url; } catch { /* frame already gone */ }
    cb(previewNavigationAllowed(from, d.url) ? {} : { cancel: true });
  });
}

function text(status: number, body: string): Response {
  return new Response(body, { status, headers: { 'content-type': 'text/plain; charset=utf-8', 'x-content-type-options': 'nosniff' } });
}

/** Serve `aico://preview/<token>/<path>`. Anything not registered, or outside the token's directory, is a 404. */
export async function previewResponse(url: URL, engine: EngineHost): Promise<Response> {
  const token = url.pathname.replace(/^\/+/, '').split('/')[0] ?? '';
  const hit = previews.resolve(url.pathname);
  if (!hit) return text(404, 'Not found');
  let bytes: Uint8Array;
  if (hit.kind === 'html') {
    bytes = new TextEncoder().encode(hit.html);
  } else {
    let endpoint;
    try { endpoint = await engine.ready(30_000); } catch (err) { return text(503, (err as Error).message); }
    const target = new URL('/api/artifacts/file', endpoint.origin);
    target.searchParams.set('session', hit.session);
    target.searchParams.set('path', hit.path);
    try {
      const res = await fetch(target, { headers: { 'x-aico-token': endpoint.token, origin: endpoint.origin }, redirect: 'manual' });
      if (!res.ok) return text(res.status === 404 ? 404 : 502, 'Not found');
      bytes = new Uint8Array(await res.arrayBuffer());
    } catch (err) {
      return text(502, `The engine did not answer: ${(err as Error).message}`);
    }
  }
  const type = previewMime(hit.name);
  const cdns = type.startsWith('text/html') ? cdnsReferenced(new TextDecoder().decode(bytes)) : [];
  return new Response(Buffer.from(bytes), {
    status: 200,
    headers: {
      'content-type': type,
      'content-security-policy': previewCsp(token, cdns),
      'x-content-type-options': 'nosniff',
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
    },
  });
}
