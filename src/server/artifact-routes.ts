/**
 * The Artifacts panel's routes — everything one chat produced or opened, in
 * one list.
 *
 *   GET  /api/artifacts/list?session=              canvases, exported/generated files, attachments
 *   GET  /api/artifacts/file?session=&path=        one file from the session's artifacts folder
 *   POST /api/artifacts/rename {session,path,name}  rename a file in that folder
 *
 * ## Why one list, assembled here
 *
 * A chat's work lives in three stores that grew separately: canvases (the
 * session's `canvas/` folder), files the agent exported or wrote to the
 * session's `artifacts/` folder (Canvas export, reports), and the attachment
 * store (what the person uploaded, images a tool generated). The person
 * thinks of them as "what this chat made", so the engine joins them, tags
 * each with a kind and a topic, and the clients only draw it. The topic ties
 * an export to the canvas it came from (`q3-plan.docx` beside "Q3 plan"), which
 * is the grouping the panel offers besides "by type".
 *
 * ## The file route reads one folder, by relative path
 *
 * Only paths inside the session's own artifacts folder, resolved and checked
 * (after following links) to still be inside it — `..`, absolute paths and a
 * link pointing out are a 404, never a read. Attachments are served by the
 * existing `attachments/file` route (by id); canvases by the canvas routes.
 * Rename keeps a file in its folder, refuses to overwrite, and refuses a name
 * with a separator.
 *
 * @module server/artifact-routes
 */

import type http from 'http';
import path from 'path';
import { readdir, readFile, realpath, rename, stat } from 'fs/promises';
import { loadSettings } from '../settings.js';
import { getWorkspaceInfo } from '../workspace.js';
import { listCanvases } from '../canvas/store.js';
import { fileBase } from '../canvas/markdown.js';
import { listAttachments } from './attachments.js';

export interface ArtifactRouteDeps {
  resolveCwd: (sessionId: string) => Promise<string>;
  readJson: (req: http.IncomingMessage) => Promise<unknown>;
  send: (res: http.ServerResponse, status: number, body: unknown) => void;
}

export type ArtifactKind = 'document' | 'sheet' | 'code' | 'image' | 'file' | 'export';

export interface Artifact {
  /** Unique in the list: `canvas:<id>`, `file:<relative path>`, `attachment:<id>`. */
  key: string;
  kind: ArtifactKind;
  source: 'canvas' | 'file' | 'attachment';
  /** Canvas id, path relative to the artifacts folder, or attachment id. */
  id: string;
  title: string;
  /** Lower-case extension without the dot, for files. */
  ext?: string;
  language?: string;
  bytes?: number;
  updatedAt: number;
  /** What it belongs to: the canvas title an export came from, else a group name. */
  topic: string;
  /** Uploaded by the person rather than made in the chat. */
  uploaded?: boolean;
}

const SESSION = /^[\w.-]{1,160}$/;
const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg']);
const MAX_FILES = 300;
const SERVED: Record<string, string> = {
  pdf: 'application/pdf', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', csv: 'text/csv; charset=utf-8',
  md: 'text/markdown; charset=utf-8', txt: 'text/plain; charset=utf-8', html: 'text/html; charset=utf-8', json: 'application/json',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
};

async function walk(root: string, rel = '', depth = 0, out: Array<{ rel: string; bytes: number; at: number }> = []): Promise<typeof out> {
  if (depth > 3 || out.length >= MAX_FILES) return out;
  let entries: import('fs').Dirent[];
  try { entries = await readdir(path.join(root, rel), { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (out.length >= MAX_FILES) break;
    if (e.name.startsWith('.') || e.name.endsWith('.tmp')) continue;
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) await walk(root, r, depth + 1, out);
    else if (e.isFile()) {
      const s = await stat(path.join(root, r)).catch(() => undefined);
      if (s) out.push({ rel: r, bytes: s.size, at: s.mtimeMs });
    }
  }
  return out;
}

/** A path inside the artifacts folder, or undefined when it is not (traversal, absolute, a link out). */
async function inside(root: string, rel: string): Promise<string | undefined> {
  if (!rel || rel.includes('\0') || path.isAbsolute(rel) || /^[a-z]:/i.test(rel)) return undefined;
  const full = path.resolve(root, rel);
  const r = path.relative(root, full);
  if (!r || r.startsWith('..') || path.isAbsolute(r)) return undefined;
  try {
    const [realRoot, realFull] = await Promise.all([realpath(root), realpath(full)]);
    const rr = path.relative(realRoot, realFull);
    if (!rr || rr.startsWith('..') || path.isAbsolute(rr)) return undefined;
    return realFull;
  } catch {
    return undefined;
  }
}

/** Everything a chat has produced or opened, newest first. */
export async function listArtifacts(input: { cwd: string; sessionId: string }): Promise<Artifact[]> {
  const settings = await loadSettings();
  const ctx = { settings, cwd: input.cwd, sessionId: input.sessionId };
  const canvases = await listCanvases(ctx);
  const out: Artifact[] = canvases.map(c => ({
    key: `canvas:${c.id}`, kind: c.kind, source: 'canvas' as const, id: c.id, title: c.title, updatedAt: c.updatedAt,
    topic: c.title, ...(c.language ? { language: c.language } : {}),
  }));
  const byBase = new Map(canvases.map(c => [fileBase(c.title), c.title]));
  const root = getWorkspaceInfo(ctx).artifactsDir;
  if (root) {
    for (const f of await walk(root)) {
      const name = path.posix.basename(f.rel);
      const ext = name.includes('.') ? name.split('.').pop()!.toLowerCase() : '';
      const base = name.replace(/\.[^.]+$/, '');
      const from = byBase.get(base);
      out.push({
        key: `file:${f.rel}`, kind: from ? 'export' : IMAGE_EXT.has(ext) ? 'image' : 'file', source: 'file', id: f.rel, title: name,
        ...(ext ? { ext } : {}), bytes: f.bytes, updatedAt: f.at, topic: from ?? 'Files',
      });
    }
  }
  for (const a of await listAttachments(ctx).catch(() => [])) {
    out.push({
      key: `attachment:${a.id}`, kind: a.image ? 'image' : 'file', source: 'attachment', id: a.id, title: a.name,
      ext: a.extension.replace(/^\./, ''), bytes: a.bytes, updatedAt: a.at,
      topic: a.origin === 'tool' ? 'Generated images' : 'Attachments', ...(a.origin === 'upload' ? { uploaded: true } : {}),
    });
  }
  return out.sort((x, y) => y.updatedAt - x.updatedAt);
}

/** Handle an `artifacts/*` route. Returns false for any other route. */
export async function handleArtifactRoute(
  route: string, req: http.IncomingMessage, res: http.ServerResponse, url: URL, deps: ArtifactRouteDeps,
): Promise<boolean> {
  if (!route.startsWith('artifacts/')) return false;
  const { send } = deps;
  const method = req.method ?? 'GET';
  try {
    if (route === 'artifacts/list' && method === 'GET') {
      const sessionId = url.searchParams.get('session') ?? '';
      if (!SESSION.test(sessionId)) { send(res, 400, { error: 'session required' }); return true; }
      send(res, 200, { artifacts: await listArtifacts({ cwd: await deps.resolveCwd(sessionId), sessionId }) });
      return true;
    }

    if (route === 'artifacts/file' && method === 'GET') {
      const sessionId = url.searchParams.get('session') ?? '';
      const rel = url.searchParams.get('path') ?? '';
      if (!SESSION.test(sessionId) || !rel) { send(res, 400, { error: 'session and path required' }); return true; }
      const settings = await loadSettings();
      const root = getWorkspaceInfo({ settings, cwd: await deps.resolveCwd(sessionId), sessionId }).artifactsDir;
      const file = root ? await inside(root, rel) : undefined;
      if (!file) { send(res, 404, { error: 'no such file in this chat\'s artifacts' }); return true; }
      const bytes = await readFile(file);
      const ext = path.extname(file).slice(1).toLowerCase();
      const name = path.basename(file);
      const image = IMAGE_EXT.has(ext) && ext !== 'svg';
      res.writeHead(200, {
        'Content-Type': SERVED[ext] ?? 'application/octet-stream',
        'Content-Length': String(bytes.length),
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'no-store',
        // Pictures display in place; everything else (HTML included) downloads rather than rendering on the engine's origin.
        'Content-Disposition': `${image ? 'inline' : 'attachment'}; filename="${name.replace(/[^\w.() -]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(name)}`,
        'Content-Security-Policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox",
      });
      res.end(bytes);
      return true;
    }

    if (route === 'artifacts/rename' && method === 'POST') {
      const body = await deps.readJson(req) as { session?: string; sessionId?: string; path?: unknown; name?: unknown };
      const sessionId = body.session ?? body.sessionId ?? '';
      if (!SESSION.test(sessionId) || typeof body.path !== 'string' || typeof body.name !== 'string') {
        send(res, 400, { error: 'session, path and name required' });
        return true;
      }
      const settings = await loadSettings();
      const root = getWorkspaceInfo({ settings, cwd: await deps.resolveCwd(sessionId), sessionId }).artifactsDir;
      const file = root ? await inside(root, body.path) : undefined;
      if (!root || !file) { send(res, 404, { error: 'no such file in this chat\'s artifacts' }); return true; }
      let name = body.name.trim();
      if (!name || /[\\/:*?"<>|\0]/.test(name) || name === '.' || name === '..' || name.length > 180) {
        send(res, 400, { error: 'a file name without \\ / : * ? " < > |' });
        return true;
      }
      // Keep the type: "Final report" for report.docx becomes "Final report.docx".
      if (!path.extname(name) && path.extname(file)) name += path.extname(file);
      const target = path.join(path.dirname(file), name);
      if (await stat(target).then(() => true, () => false)) { send(res, 409, { error: `there is already a file named "${name}"` }); return true; }
      await rename(file, target);
      const realRoot = await realpath(root);
      send(res, 200, { path: path.relative(realRoot, target).split(path.sep).join('/') });
      return true;
    }

    send(res, 404, { error: `unknown artifacts route ${route}` });
    return true;
  } catch (err) {
    send(res, 400, { error: err instanceof Error ? err.message : String(err) });
    return true;
  }
}
