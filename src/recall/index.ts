/**
 * Recall's public face: what other modules and the server use (ADR 0018).
 *
 * The profile learner (src/profile) indexes About-you facts through
 * `upsertProfileItems` / `removeProfileItem` and registers itself with
 * `registerProfileSource` so a rebuilt index gets them back. The server
 * exposes search and rebuild at `/api/recall/*`, authenticated like every
 * other API route by the server's own token check before this is reached.
 *
 * @module recall
 */

import { loadSettings } from '../settings.js';
import { embedderFromSettings } from './embed.js';
import { rebuildRecall, syncAll, countItems, recordUse, type RecallKind } from './store.js';
import { searchRecall } from './search.js';

export {
  upsertProfileItems, removeProfileItem, registerProfileSource, rebuildRecall, syncAll, closeRecall,
  type ProfileItemInput, type RecallItem, type RecallKind,
} from './store.js';
export { searchRecall, type RecallHit, type RecallQuery } from './search.js';

const KINDS: readonly RecallKind[] = ['memory', 'knowledge', 'episode', 'profile'];

/** `/api/recall/search` (GET) and `/api/recall/rebuild` (POST). Undefined for any other route. */
export async function handleRecallRoute(
  route: string, method: string, query: URLSearchParams, cwd: string,
): Promise<{ status: number; body: unknown } | undefined> {
  switch (route) {
    case 'recall/search': {
      if (method !== 'GET') return { status: 405, body: { error: 'GET only' } };
      const q = (query.get('q') ?? '').trim();
      if (!q) return { status: 400, body: { error: 'q required' } };
      const kinds = (query.get('kinds') ?? '').split(',').map(s => s.trim()).filter((k): k is RecallKind => (KINDS as string[]).includes(k));
      const limit = Number(query.get('limit')) || 10;
      const sessionId = query.get('session') ?? undefined;
      const settings = await loadSettings();
      const embedder = embedderFromSettings(settings, settings.model ?? '');
      syncAll({ projectRoots: [cwd], budgetMs: 4_000 });
      const res = await searchRecall({
        query: q, ...(kinds.length ? { kinds } : {}), limit, cwd, ...(sessionId ? { sessionId } : {}),
        includeArchived: true, ...(embedder ? { embedder } : {}), signal: AbortSignal.timeout(15_000),
      });
      recordUse(res.hits.map(h => h.item.id));
      return {
        status: 200,
        body: {
          mode: res.mode, ...(res.note ? { note: res.note } : {}),
          hits: res.hits.map(h => ({
            id: h.item.id, kind: h.item.kind, scope: h.item.scope, project: h.item.project, title: h.item.title,
            text: h.item.text, updated: h.item.updated, status: h.item.status, score: h.score,
            ...(typeof h.item.meta.sessionId === 'string' ? { sessionId: h.item.meta.sessionId } : {}),
          })),
        },
      };
    }
    case 'recall/rebuild': {
      if (method !== 'POST') return { status: 405, body: { error: 'POST only' } };
      const report = rebuildRecall({ projectRoots: [cwd] });
      return { status: 200, body: { ok: true, ...report } };
    }
    case 'recall/stats': {
      if (method !== 'GET') return { status: 405, body: { error: 'GET only' } };
      return { status: 200, body: { counts: countItems() } };
    }
    default:
      return undefined;
  }
}
