/**
 * The canvas routes — what the editor beside the chat reads and writes.
 *
 *   GET  /api/canvas/list?session=              summaries, newest first
 *   GET  /api/canvas/get?session=&id=           one document with its history
 *   POST /api/canvas/save    {session,id,tab?,content,baseVersion,note?}
 *   POST /api/canvas/restore {session,id,tab?,version,baseVersion?}
 *   POST /api/canvas/tabs    {session,id,op:'add'|'rename'|'delete',tab?,title?,content?}
 *   POST /api/canvas/settings {session,id,settings}   export setup (merged; null clears a key)
 *   GET  /api/canvas/templates                   the document types (canvas/doc-types) for "New from template"
 *   POST /api/canvas/create  {session,title,kind?,content?,tabs?,template?,settings?}  a document the person starts
 *   GET  /api/canvas/:id/comments?session=
 *   POST /api/canvas/:id/comments               {session,tabId,anchor,body,askAgent?}
 *   POST /api/canvas/:id/comments/:cid/replies  {session,body}
 *   POST /api/canvas/:id/comments/:cid/resolve  {session,resolved?}
 *   GET  /api/canvas/:id/export?session=&format=md|html|docx|pdf&tab=&toc=1&settings=<json>
 *                                                (a sheet: format=xlsx|csv&sheet=)
 *   POST /api/canvas/import  {session,name,data(base64),title?}   a .xlsx/.csv as a new sheet canvas
 *   POST /api/canvas/rename  {session,id,title}
 *
 * A save based on a stale version of its tab is a 409 carrying the current
 * document, so the editor can offer "keep mine" or "take the agent's" instead
 * of either side's work vanishing. Every write is announced on the session's
 * stream by the store's change listeners (wired in `serve`), so open editors
 * refresh live.
 *
 * A comment that addresses the agent (`@AICO`, or `askAgent`) becomes a turn
 * in the canvas's own session through `deps.askAgent` — queued behind a
 * running turn rather than refused, since the person has already moved on.
 * The contract is `docs/engineering/canvas-docs-contract.md`.
 *
 * @module server/canvas-routes
 */

import type http from 'http';
import { loadSettings } from '../settings.js';
import {
  CanvasNotFound, CanvasTabNotFound, CommentNotFound, addComment, addTab, createCanvas, deleteTab, getCanvas, isCanvasId,
  listCanvases, listComments, renameCanvas, renameTab, replyToComment, resolveComment, restoreCanvas, setDocSettings, writeCanvas,
  type CanvasComment, type CanvasContext,
} from '../canvas/store.js';
import { EXPORT_FORMATS, exportCanvas, type ExportFormat } from '../canvas/export.js';
import { workspaceImages } from '../canvas/markdown.js';
import { mergeSettings } from '../canvas/doc-settings.js';
import { DOC_TYPES, docTypeById, docTypeSummary } from '../canvas/doc-types.js';
import { pendingLine } from '../canvas/sections.js';
import { SHEET_EXPORT_FORMATS, SHEET_MEDIA, exportSheet, importSheetFile, type SheetExportFormat } from '../canvas/sheet-xlsx.js';
import { parseBook, serializeBook } from '../../shared/ui/canvas/sheet-model.js';
import { fileBase } from '../canvas/markdown.js';

/** Largest file `canvas/import` takes (the body is base64, a third larger). */
export const SHEET_IMPORT_MAX_BYTES = 25 * 1024 * 1024;

export interface CanvasRouteDeps {
  resolveCwd: (sessionId: string) => Promise<string>;
  readJson: (req: http.IncomingMessage) => Promise<unknown>;
  send: (res: http.ServerResponse, status: number, body: unknown) => void;
  /** Put a message to the agent in this session (a new turn, or queued behind the running one). */
  askAgent?: (sessionId: string, text: string) => Promise<void> | void;
}

const SESSION = /^[\w.-]{1,160}$/;
const NESTED = /^canvas\/([^/]+)\/(comments|export)(?:\/([\w-]{1,40})\/(replies|resolve))?$/;

/** The turn a comment to the agent becomes. The first sentence is the contract's wording. */
export function commentPrompt(canvasId: string, comment: CanvasComment, text: string): string {
  const quote = comment.anchor.quote.length > 400 ? `${comment.anchor.quote.slice(0, 400)}…` : comment.anchor.quote;
  return `The user commented on '${quote}': ${text}\n\n`
    + `(Canvas ${canvasId}, tab ${comment.tabId}, comment ${comment.id}. Read the canvas, make any change the comment asks for `
    + 'with Canvas edit or write_section, then answer it with Canvas reply_comment — resolve: true once it is done.)';
}

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
  const conflict = (canvas: unknown): void => {
    send(res, 409, { error: 'the canvas changed since your version', conflict: true, canvas });
  };

  try {
    if (route === 'canvas/templates' && method === 'GET') {
      send(res, 200, { templates: DOC_TYPES.map(docTypeSummary) });
      return true;
    }

    if (route === 'canvas/create' && method === 'POST') {
      const body = await deps.readJson(req) as {
        session?: string; sessionId?: string; title?: unknown; kind?: unknown; language?: unknown; content?: unknown;
        tabs?: unknown; template?: unknown; settings?: unknown; docSettings?: unknown;
      };
      const sessionId = body.session ?? body.sessionId ?? '';
      if (!SESSION.test(sessionId)) { send(res, 400, { error: 'session required' }); return true; }
      const template = body.template !== undefined ? docTypeById(body.template) : undefined;
      if (body.template !== undefined && !template) {
        send(res, 400, { error: `unknown template; one of ${DOC_TYPES.map(t => t.id).join(', ')}` });
        return true;
      }
      const docSettings = mergeSettings(template?.docSettings, body.settings ?? body.docSettings ?? {});
      // A template with no text of its own starts as its outline: the same placeholders the agent's outline writes.
      const content = typeof body.content === 'string' ? body.content
        : template ? `${[...(docSettings.toc ? ['<!-- aico:toc -->'] : []), ...template.sections.map(x => pendingLine(x))].join('\n\n')}\n` : '';
      const tabs = Array.isArray(body.tabs)
        ? (body.tabs as { title?: unknown; content?: unknown }[]).map(t => ({
          ...(typeof t?.title === 'string' ? { title: t.title } : {}), ...(typeof t?.content === 'string' ? { content: t.content } : {}),
        }))
        : undefined;
      const canvas = await createCanvas(await ctxFor(sessionId), {
        title: typeof body.title === 'string' && body.title.trim() ? body.title : template?.title ?? 'Untitled',
        kind: body.kind === 'code' || body.kind === 'sheet' ? body.kind : 'document', content, author: 'user',
        ...(typeof body.language === 'string' ? { language: body.language } : {}),
        ...(tabs?.length ? { tabs } : {}),
        ...(Object.keys(docSettings).length ? { docSettings } : {}),
      });
      send(res, 200, { canvas });
      return true;
    }

    if (route === 'canvas/import' && method === 'POST') {
      const body = await deps.readJson(req) as { session?: string; sessionId?: string; name?: unknown; data?: unknown; title?: unknown };
      const sessionId = body.session ?? body.sessionId ?? '';
      if (!SESSION.test(sessionId)) { send(res, 400, { error: 'session required' }); return true; }
      if (typeof body.name !== 'string' || typeof body.data !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(body.data)) {
        send(res, 400, { error: 'name and base64 data required' });
        return true;
      }
      const bytes = Buffer.from(body.data, 'base64');
      if (!bytes.length || bytes.length > SHEET_IMPORT_MAX_BYTES) { send(res, 400, { error: 'import a file of 1 byte to 25 MB' }); return true; }
      const book = importSheetFile(body.name, new Uint8Array(bytes));
      const canvas = await createCanvas(await ctxFor(sessionId), {
        title: typeof body.title === 'string' && body.title.trim() ? body.title : body.name.replace(/\.[^.]+$/, ''),
        kind: 'sheet', content: serializeBook(book), author: 'user', note: `Imported ${body.name.slice(0, 80)}`,
      });
      send(res, 200, { canvas });
      return true;
    }

    if (route === 'canvas/rename' && method === 'POST') {
      const body = await deps.readJson(req) as { session?: string; sessionId?: string; id?: unknown; title?: unknown };
      const sessionId = body.session ?? body.sessionId ?? '';
      if (!SESSION.test(sessionId) || !isCanvasId(body.id)) { send(res, 400, { error: 'session and id required' }); return true; }
      if (typeof body.title !== 'string' || !body.title.trim()) { send(res, 400, { error: 'title required' }); return true; }
      send(res, 200, { canvas: await renameCanvas(await ctxFor(sessionId), body.id, body.title) });
      return true;
    }

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
      // `light=1` — a card: each tab's current version only, not up to fifty copies of the text.
      const light = url.searchParams.get('light') === '1';
      send(res, 200, {
        canvas: light
          ? { ...canvas, versions: canvas.tabs.map(t => [...canvas.versions].reverse().find(v => (v.tab ?? 't1') === t.id)).filter(Boolean) }
          : canvas,
      });
      return true;
    }

    if ((route === 'canvas/save' || route === 'canvas/restore' || route === 'canvas/tabs' || route === 'canvas/settings') && method === 'POST') {
      const body = await deps.readJson(req) as {
        session?: string; sessionId?: string; id?: string; content?: unknown; baseVersion?: unknown;
        version?: unknown; note?: unknown; tab?: unknown; op?: unknown; title?: unknown; settings?: unknown;
      };
      const sessionId = body.session ?? body.sessionId ?? '';
      if (!SESSION.test(sessionId) || !isCanvasId(body.id)) { send(res, 400, { error: 'session and id required' }); return true; }
      const ctx = await ctxFor(sessionId);
      const tab = typeof body.tab === 'string' && body.tab ? body.tab : undefined;

      if (route === 'canvas/save') {
        if (typeof body.content !== 'string') { send(res, 400, { error: 'content must be a string' }); return true; }
        if (typeof body.baseVersion !== 'number') { send(res, 400, { error: 'baseVersion required' }); return true; }
        const result = await writeCanvas(ctx, body.id, {
          content: body.content, baseVersion: body.baseVersion, author: 'user', ...(tab ? { tab } : {}),
          ...(typeof body.note === 'string' && body.note.trim() ? { note: body.note.trim() } : {}),
        });
        if (!result.ok) { conflict(result.canvas); return true; }
        send(res, 200, { ok: true, changed: result.changed, canvas: result.canvas });
        return true;
      }

      if (route === 'canvas/settings') {
        if (!body.settings || typeof body.settings !== 'object') { send(res, 400, { error: 'settings object required' }); return true; }
        send(res, 200, { canvas: await setDocSettings(ctx, body.id, body.settings) });
        return true;
      }

      if (route === 'canvas/tabs') {
        const title = typeof body.title === 'string' ? body.title : undefined;
        if (body.op === 'add') {
          const { canvas, tab: made } = await addTab(ctx, body.id, {
            ...(title ? { title } : {}), content: typeof body.content === 'string' ? body.content : '', author: 'user',
          });
          send(res, 200, { canvas, tab: made });
          return true;
        }
        if (!tab) { send(res, 400, { error: 'tab required' }); return true; }
        if (body.op === 'rename') {
          if (!title?.trim()) { send(res, 400, { error: 'title required' }); return true; }
          send(res, 200, { canvas: await renameTab(ctx, body.id, tab, title) });
          return true;
        }
        if (body.op === 'delete') {
          send(res, 200, { canvas: await deleteTab(ctx, body.id, tab) });
          return true;
        }
        send(res, 400, { error: 'op must be add, rename or delete' });
        return true;
      }

      if (typeof body.version !== 'number') { send(res, 400, { error: 'version required' }); return true; }
      const result = await restoreCanvas(ctx, body.id, body.version, {
        author: 'user', ...(typeof body.baseVersion === 'number' ? { baseVersion: body.baseVersion } : {}), ...(tab ? { tab } : {}),
      });
      if (!result.ok) { conflict(result.canvas); return true; }
      send(res, 200, { ok: true, changed: result.changed, canvas: result.canvas });
      return true;
    }

    const nested = NESTED.exec(route);
    if (nested) {
      const [, id, kind, cid, verb] = nested as unknown as [string, string, 'comments' | 'export', string | undefined, 'replies' | 'resolve' | undefined];
      const body = method === 'POST'
        ? await deps.readJson(req) as { session?: string; sessionId?: string; [k: string]: unknown }
        : {};
      const sessionId = String(body.session ?? body.sessionId ?? url.searchParams.get('session') ?? '');
      if (!SESSION.test(sessionId) || !isCanvasId(id)) { send(res, 400, { error: 'session and a canvas id required' }); return true; }
      const ctx = await ctxFor(sessionId);

      if (kind === 'export' && method === 'GET' && !cid) {
        const sheetDoc = await getCanvas(ctx, id);
        if (sheetDoc?.kind === 'sheet') {
          const sf = String(url.searchParams.get('format') ?? 'xlsx').toLowerCase() as SheetExportFormat;
          if (!SHEET_EXPORT_FORMATS.includes(sf)) { send(res, 400, { error: `a sheet exports as ${SHEET_EXPORT_FORMATS.join(' or ')}` }); return true; }
          const sheet = url.searchParams.get('sheet') || undefined;
          const bytes = exportSheet(parseBook(sheetDoc.tabs[0]!.content), sf, { title: sheetDoc.title, ...(sheet ? { sheet } : {}) });
          const fileName = `${fileBase(sheetDoc.title)}.${sf}`;
          res.writeHead(200, {
            'Content-Type': SHEET_MEDIA[sf],
            'Content-Length': bytes.length,
            'Content-Disposition': `attachment; filename="${fileName}"; filename*=UTF-8''${encodeURIComponent(fileName)}`,
            'X-Content-Type-Options': 'nosniff',
            'Cache-Control': 'no-store',
            'X-AICO-Export-Warnings': '0',
          });
          res.end(bytes);
          return true;
        }
        const format = String(url.searchParams.get('format') ?? '').toLowerCase() as ExportFormat;
        if (!EXPORT_FORMATS.includes(format)) { send(res, 400, { error: `format must be one of ${EXPORT_FORMATS.join(', ')}` }); return true; }
        const doc = await getCanvas(ctx, id);
        if (!doc) throw new CanvasNotFound(id);
        const tab = url.searchParams.get('tab') || undefined;
        let settings: unknown;
        const rawSettings = url.searchParams.get('settings');
        if (rawSettings) {
          try { settings = JSON.parse(rawSettings); } catch { send(res, 400, { error: 'settings must be JSON' }); return true; }
        }
        const toc = url.searchParams.get('toc');
        const out = await exportCanvas(doc, {
          format, ...(tab ? { tab } : {}), resolveImage: workspaceImages(ctx.cwd),
          ...(settings !== undefined ? { settings } : {}), ...(toc !== null ? { toc: toc === '1' || toc === 'true' } : {}),
        });
        res.writeHead(200, {
          'Content-Type': out.mediaType,
          'Content-Length': out.bytes.length,
          'Content-Disposition': `attachment; filename="${out.fileName}"; filename*=UTF-8''${encodeURIComponent(out.fileName)}`,
          'X-Content-Type-Options': 'nosniff',
          'Cache-Control': 'no-store',
          // Blocks drawn as placeholders (no browser, or a block that does not parse).
          'X-AICO-Export-Warnings': String(out.warnings.length),
        });
        res.end(out.bytes);
        return true;
      }

      if (kind === 'comments' && !cid && method === 'GET') {
        send(res, 200, { comments: await listComments(ctx, id) });
        return true;
      }

      if (kind === 'comments' && !cid && method === 'POST') {
        const anchor = (body.anchor ?? {}) as { quote?: unknown; prefix?: unknown; suffix?: unknown };
        const { comment, canvas } = await addComment(ctx, id, {
          ...(typeof body.tabId === 'string' ? { tabId: body.tabId } : typeof body.tab === 'string' ? { tabId: body.tab } : {}),
          anchor: { quote: String(anchor.quote ?? ''), prefix: String(anchor.prefix ?? ''), suffix: String(anchor.suffix ?? '') },
          body: String(body.body ?? ''), author: 'user', askAgent: body.askAgent === true,
        });
        let asked = false;
        if (comment.askAgent && deps.askAgent) {
          await deps.askAgent(sessionId, commentPrompt(canvas.id, comment, comment.body));
          asked = true;
        }
        send(res, 200, { comment, asked });
        return true;
      }

      if (kind === 'comments' && cid && verb === 'replies' && method === 'POST') {
        const text = String(body.body ?? '');
        const { comment, reply } = await replyToComment(ctx, id, cid, { body: text, author: 'user' });
        let asked = false;
        if (/(^|[^\w@])@aico\b/i.test(text) && deps.askAgent) {
          await deps.askAgent(sessionId, commentPrompt(id, comment, text));
          asked = true;
        }
        send(res, 200, { comment, reply, asked });
        return true;
      }

      if (kind === 'comments' && cid && verb === 'resolve' && method === 'POST') {
        const { comment } = await resolveComment(ctx, id, cid, { resolved: body.resolved !== false, author: 'user' });
        send(res, 200, { comment });
        return true;
      }
    }

    send(res, 404, { error: `unknown canvas route ${route}` });
    return true;
  } catch (err) {
    if (err instanceof CanvasNotFound) { send(res, 404, { error: err.message }); return true; }
    if (err instanceof CanvasTabNotFound || err instanceof CommentNotFound) { send(res, 404, { error: err.message }); return true; }
    send(res, 400, { error: err instanceof Error ? err.message : String(err) });
    return true;
  }
}
