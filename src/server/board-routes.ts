/**
 * Design board routes (ADR 0037) — what the board viewer needs beyond the
 * file route the Artifacts panel already has.
 *
 *   GET  /api/boards/get?session=&path=          the board, normalised, with its problems
 *   GET  /api/boards/export?session=&path=&format=png|pdf|zip[&frame=]
 *                                                 a screen's PNG, the board as PDF, or its folder zipped
 *   POST /api/boards/notes {session, path, notes} the person's sticky notes, replaced as a set
 *
 * `path` is the board's `board.json` (or its folder) relative to the chat's
 * artifacts folder, exactly as `artifacts/list` names it. It is resolved with
 * the same containment check as `artifacts/file` (after following links), so
 * a board outside the chat's folder is a 404. The screens themselves are
 * fetched through `artifacts/file`; nothing here serves model-written HTML.
 *
 * Why notes are a route of their own and not a generic file write: the person
 * may only change the notes. Sections, frames and screens are the agent's
 * (through `DesignBoard`), and a client that could rewrite `board.json` could
 * point a frame anywhere. The notes are validated by the same `parseBoard`.
 *
 * @module server/board-routes
 */

import type http from 'http';
import path from 'path';
import { stat } from 'fs/promises';
import { loadSettings } from '../settings.js';
import { getWorkspaceInfo } from '../workspace.js';
import { insideArtifacts } from './artifact-routes.js';
import { readBoardAt, writeBoardAt } from '../canvas/board-tool.js';
import { BOARD_EXPORT_FORMATS, exportBoard, type BoardExportFormat } from '../canvas/board-export.js';
import { BOARD_FILE, parseBoard } from '../../shared/ui/board/board-model.js';

export interface BoardRouteDeps {
  resolveCwd: (sessionId: string) => Promise<string>;
  readJson: (req: http.IncomingMessage) => Promise<unknown>;
  send: (res: http.ServerResponse, status: number, body: unknown) => void;
}

const SESSION = /^(?!.*\.\.)[\w-][\w.-]{0,159}$/;

/** The board folder for `rel` (its board.json or the folder) in this chat's artifacts, or undefined. */
async function boardFolder(sessionId: string, rel: string, deps: BoardRouteDeps): Promise<string | undefined> {
  const settings = await loadSettings();
  const root = getWorkspaceInfo({ settings, cwd: await deps.resolveCwd(sessionId), sessionId }).artifactsDir;
  if (!root || !rel) return undefined;
  const file = rel.endsWith(BOARD_FILE) ? rel : `${rel.replace(/\/+$/, '')}/${BOARD_FILE}`;
  const real = await insideArtifacts(root, file);
  if (!real || !(await stat(real).then(s => s.isFile(), () => false))) return undefined;
  return path.dirname(real);
}

export async function handleBoardRoute(
  route: string, req: http.IncomingMessage, res: http.ServerResponse, url: URL, deps: BoardRouteDeps,
): Promise<boolean> {
  if (!route.startsWith('boards/')) return false;
  const { send } = deps;
  const method = req.method ?? 'GET';
  try {
    if (route === 'boards/get' && method === 'GET') {
      const sessionId = url.searchParams.get('session') ?? '';
      if (!SESSION.test(sessionId)) { send(res, 400, { error: 'session required' }); return true; }
      const dir = await boardFolder(sessionId, url.searchParams.get('path') ?? '', deps);
      if (!dir) { send(res, 404, { error: 'no such board in this chat\'s artifacts' }); return true; }
      send(res, 200, await readBoardAt(dir));
      return true;
    }

    if (route === 'boards/export' && method === 'GET') {
      const sessionId = url.searchParams.get('session') ?? '';
      const format = (url.searchParams.get('format') ?? '') as BoardExportFormat;
      if (!SESSION.test(sessionId) || !BOARD_EXPORT_FORMATS.includes(format)) { send(res, 400, { error: `session and format (${BOARD_EXPORT_FORMATS.join(', ')}) required` }); return true; }
      const dir = await boardFolder(sessionId, url.searchParams.get('path') ?? '', deps);
      if (!dir) { send(res, 404, { error: 'no such board in this chat\'s artifacts' }); return true; }
      const { board } = await readBoardAt(dir);
      const frame = url.searchParams.get('frame') ?? '';
      const result = await exportBoard(dir, board, { format, ...(frame ? { frame } : {}) });
      res.writeHead(200, {
        'Content-Type': result.mediaType,
        'Content-Length': String(result.bytes.length),
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'no-store',
        'Content-Disposition': `attachment; filename="${result.fileName.replace(/[^\w.() -]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(result.fileName)}`,
        'Content-Security-Policy': "default-src 'none'; sandbox",
        ...(result.warnings.length ? { 'X-Aico-Warnings': encodeURIComponent(result.warnings.join('; ').slice(0, 1000)) } : {}),
      });
      res.end(result.bytes);
      return true;
    }

    if (route === 'boards/notes' && method === 'POST') {
      const body = await deps.readJson(req) as { session?: string; path?: unknown; notes?: unknown };
      const sessionId = body.session ?? '';
      if (!SESSION.test(sessionId) || typeof body.path !== 'string' || !Array.isArray(body.notes)) { send(res, 400, { error: 'session, path and notes required' }); return true; }
      const dir = await boardFolder(sessionId, body.path, deps);
      if (!dir) { send(res, 404, { error: 'no such board in this chat\'s artifacts' }); return true; }
      const { board } = await readBoardAt(dir);
      // Only the notes change; they are read back through the same parser as the rest of the board.
      const next = parseBoard({ ...board, notes: body.notes }).board;
      board.notes = next.notes;
      await writeBoardAt(dir, board);
      send(res, 200, { notes: board.notes });
      return true;
    }

    send(res, 404, { error: `unknown boards route ${route}` });
    return true;
  } catch (err) {
    send(res, 400, { error: err instanceof Error ? err.message : String(err) });
    return true;
  }
}
