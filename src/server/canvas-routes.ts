/**
 * The canvas routes — what the editor beside the chat reads and writes.
 *
 *   GET  /api/canvas/list?session=              summaries, newest first
 *   GET  /api/canvas/get?session=&id=           one document with its history
 *   POST /api/canvas/save    {session,id,content,baseVersion,note?}
 *   POST /api/canvas/restore {session,id,version,baseVersion?}
 *
 * A save based on a stale version is a 409 carrying the current document, so
 * the editor can offer "keep mine" or "take the agent's" instead of either
 * side's work vanishing. Every write is announced on the session's stream by
 * the store's change listener (wired in `serve`), so open editors refresh live.
 *
 * @module server/canvas-routes
 */

import type http from 'http';
import { loadSettings } from '../settings.js';
import {
  CanvasNotFound, getCanvas, isCanvasId, listCanvases, restoreCanvas, writeCanvas, type CanvasContext,
} from '../canvas/store.js';

export interface CanvasRouteDeps {
  resolveCwd: (sessionId: string) => Promise<string>;
  readJson: (req: http.IncomingMessage) => Promise<unknown>;
  send: (res: http.ServerResponse, status: number, body: unknown) => void;
}

const SESSION = /^[\w.-]{1,160}$/;

/** Handle a `canvas/*` route. Returns false for any other route. */
export async function handleCanvasRoute(
  route: string, req: http.IncomingMessage, res: http.ServerResponse, url: URL, deps: CanvasRouteDeps,
): Promise<boolean> {
  if (!route.startsWith('canvas/')) return false;
  const { send } = deps;
  const method = req.method ?? 'GET';

  const ctxFor = async (sessionId: string): Promise<CanvasContext> => ({
    settings: await loadSettings(), cwd: await deps.resolveCwd(sessionId), sessionId,
  });

  try {
    if (route === 'canvas/list' && method === 'GET') {
      const sessionId = url.searchParams.get('session') ?? '';
      if (!SESSION.test(sessionId)) { send(res, 400, { error: 'session required' }); return true; }
      send(res, 200, { canvases: await listCanvases(await ctxFor(sessionId)) });
      return true;
    }

    if (route === 'canvas/get' && method === 'GET') {
      const sessionId = url.searchParams.get('session') ?? '';
      const id = url.searchParams.get('id') ?? '';
      if (!SESSION.test(sessionId) || !isCanvasId(id)) { send(res, 400, { error: 'session and id required' }); return true; }
      const canvas = await getCanvas(await ctxFor(sessionId), id);
      if (!canvas) { send(res, 404, { error: `no canvas "${id}" in this chat` }); return true; }
      // `light=1` — a card: the current version only, not up to fifty copies of the text.
      const light = url.searchParams.get('light') === '1';
      send(res, 200, { canvas: light ? { ...canvas, versions: canvas.versions.slice(-1) } : canvas });
      return true;
    }

    if ((route === 'canvas/save' || route === 'canvas/restore') && method === 'POST') {
      const body = await deps.readJson(req) as {
        session?: string; sessionId?: string; id?: string; content?: unknown; baseVersion?: unknown;
        version?: unknown; note?: unknown;
      };
      const sessionId = body.session ?? body.sessionId ?? '';
      if (!SESSION.test(sessionId) || !isCanvasId(body.id)) { send(res, 400, { error: 'session and id required' }); return true; }
      const ctx = await ctxFor(sessionId);

      if (route === 'canvas/save') {
        if (typeof body.content !== 'string') { send(res, 400, { error: 'content must be a string' }); return true; }
        if (typeof body.baseVersion !== 'number') { send(res, 400, { error: 'baseVersion required' }); return true; }
        const result = await writeCanvas(ctx, body.id, {
          content: body.content, baseVersion: body.baseVersion, author: 'user',
          ...(typeof body.note === 'string' && body.note.trim() ? { note: body.note.trim() } : {}),
        });
        if (!result.ok) {
          send(res, 409, { error: 'the canvas changed since your version', conflict: true, canvas: result.canvas });
          return true;
        }
        send(res, 200, { ok: true, changed: result.changed, canvas: result.canvas });
        return true;
      }

      if (typeof body.version !== 'number') { send(res, 400, { error: 'version required' }); return true; }
      const result = await restoreCanvas(ctx, body.id, body.version, {
        author: 'user', ...(typeof body.baseVersion === 'number' ? { baseVersion: body.baseVersion } : {}),
      });
      if (!result.ok) {
        send(res, 409, { error: 'the canvas changed since your version', conflict: true, canvas: result.canvas });
        return true;
      }
      send(res, 200, { ok: true, changed: result.changed, canvas: result.canvas });
      return true;
    }

    send(res, 404, { error: `unknown canvas route ${route}` });
    return true;
  } catch (err) {
    if (err instanceof CanvasNotFound) { send(res, 404, { error: err.message }); return true; }
    send(res, 400, { error: err instanceof Error ? err.message : String(err) });
    return true;
  }
}
