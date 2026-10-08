/**
 * The change packet over HTTP (ADR 0034), for the clients' "copy evidence" actions.
 *
 *   GET /api/evidence?path=&session=&format=md|json|short&base=
 *
 * `path` must be a project the server already knows (`isKnownProject`), the same
 * rule every route that takes a folder follows: without it the parameter would
 * be a way to make the engine run git in and describe any directory on the
 * machine. `session` is a session id of that project (validated as a file-name
 * safe id before it is used); omitted, the project's most recently used
 * conversation. The answer is derived text — paths, counts, check names, never
 * file contents. GET only: building the report changes nothing.
 *
 * @module server/evidence-routes
 */

import type http from 'node:http';
import path from 'node:path';
import { packetFromDisk, render, type EvidenceFormat } from '../evidence/index.js';

export interface EvidenceRouteDeps {
  send: (res: http.ServerResponse, status: number, body: unknown) => void;
  /** Whether a folder is a registered project (server/projects isKnownProject). */
  isKnownProject: (dir: string) => Promise<boolean>;
}

export interface EvidenceAnswer { status: number; body: unknown }

/** The route logic without HTTP, for tests. */
export async function evidenceAnswer(params: URLSearchParams, deps: Omit<EvidenceRouteDeps, 'send'>): Promise<EvidenceAnswer> {
  const raw = params.get('path') ?? '';
  if (!raw) return { status: 400, body: { error: 'path required' } };
  const root = path.resolve(raw);
  if (!await deps.isKnownProject(root)) return { status: 403, body: { error: 'not a registered project' } };
  const fmt = params.get('format');
  const format: EvidenceFormat = fmt === 'json' || fmt === 'short' ? fmt : 'md';
  const base = params.get('base') ?? undefined;
  if (base !== undefined && (!/^[\w./~^@{}-]{1,100}$/.test(base) || base.startsWith('-'))) return { status: 400, body: { error: 'invalid base' } };
  const session = params.get('session') ?? undefined;
  const found = await packetFromDisk({ root, ...(session ? { sessionId: session } : {}), ...(base ? { base } : {}) });
  if (!found.ok) return { status: found.error === 'invalid session id' ? 400 : 404, body: { error: found.error } };
  return { status: 200, body: { format, text: render(found.packet, format), packet: found.packet } };
}

export async function handleEvidenceRoute(route: string, req: http.IncomingMessage, res: http.ServerResponse, url: URL, deps: EvidenceRouteDeps): Promise<boolean> {
  if (route !== 'evidence') return false;
  if ((req.method ?? 'GET') !== 'GET') { deps.send(res, 405, { error: 'GET only' }); return true; }
  try {
    const answer = await evidenceAnswer(url.searchParams, deps);
    deps.send(res, answer.status, answer.body);
  } catch (err) {
    deps.send(res, 500, { error: (err as Error).message });
  }
  return true;
}
