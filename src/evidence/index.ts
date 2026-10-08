/**
 * Where the change packet gets its inputs, for every way of asking for it.
 *
 * Three callers — the `Evidence` tool (the live log of the run asking), the
 * `aico evidence` command and `GET /api/evidence` (a persisted log read back
 * from disk) — share one assembly step, so a packet means the same thing
 * whichever door it came through. `packet.ts` is the pure fold; this is the
 * part that touches git, the project's check list and the session store.
 *
 * @module evidence
 */

import { gateChecks } from '../tools/run-checks.js';
import { isValidSessionId, listSessionSummaries, loadEventLog } from '../session/persistence.js';
import type { SessionEvent } from '../session/events.js';
import type { AicoSettings } from '../settings.js';
import { buildEvidence, gatherGit, type EvidencePacket } from './packet.js';

export { buildEvidence, gatherGit, type EvidencePacket } from './packet.js';
export { render, renderJson, renderMarkdown, renderShort, type EvidenceFormat } from './render.js';

export interface EvidenceRequest {
  /** The project root (the directory the work was done in). */
  root: string;
  /** Diff against this ref instead of the merge base with the default branch. */
  base?: string;
  settings?: AicoSettings;
}

/** Assemble a packet from events already in hand (the live log of a run). */
export async function packetFromEvents(events: readonly SessionEvent[], req: EvidenceRequest & { sessionId?: string }): Promise<EvidencePacket> {
  const git = await gatherGit(req.root, req.base);
  let projectChecks: string[] | undefined;
  try { projectChecks = gateChecks(req.root).map(c => c.name); } catch { /* checks unknown: the packet then does not claim any are unrun */ }
  return buildEvidence(events, {
    root: req.root,
    ...(req.sessionId ? { sessionId: req.sessionId } : {}),
    ...(projectChecks ? { projectChecks } : {}),
    ...(git ? { git } : {}),
    ...(req.settings ? { settings: req.settings } : {}),
  });
}

/**
 * Assemble a packet from a persisted session: the one named, else the project's
 * most recently used conversation.
 */
export async function packetFromDisk(req: EvidenceRequest & { sessionId?: string }): Promise<{ ok: true; packet: EvidencePacket } | { ok: false; error: string }> {
  let id = req.sessionId;
  if (id !== undefined && !isValidSessionId(id)) return { ok: false, error: 'invalid session id' };
  if (!id) {
    const rows = (await listSessionSummaries(req.root)).filter(r => (r.events ?? 0) > 0 && !r.archived);
    id = rows[0]?.id;
    if (!id) return { ok: false, error: 'This project has no session with recorded events.' };
  }
  const session = await loadEventLog(id, req.root);
  if (!session) return { ok: false, error: `No session log for ${id} in this project.` };
  return { ok: true, packet: await packetFromEvents(session.events, { ...req, sessionId: id }) };
}
