/**
 * Recall search: words and meaning, fused, then weighed by age, importance
 * and use (ADR 0018).
 *
 * HYBRID BY RANK, NOT BY SCORE. BM25 scores and cosine similarities live on
 * different scales that move with the corpus and the model, so they are not
 * added. Each list is ranked and the ranks are fused with reciprocal rank
 * fusion (k = 60): an item near the top of either list rises, one near the
 * top of both rises most. With no embedding model there is one list, and the
 * same code ranks by words alone.
 *
 * THEN THE WEIGHTS. Fused rank × recency (episodes only: half-life 30 days,
 * floored so an old session that is the only match still shows) × importance
 * (pinned memories, profile confidence) × a small bonus for having been
 * useful before. A memory the person wrote does not decay: "deploys are on
 * Fridays" is not less true for being old.
 *
 * A THRESHOLD, because "the best of nothing" is still nothing. Fusion always
 * produces a top item; injecting it when it shares one stray word with a long
 * request would put irrelevant text in front of the model on every turn. An
 * item must share enough of the query's terms (one for a short query someone
 * typed on purpose, two for a longer one and always for the per-turn recall),
 * or be semantically close enough, to be returned at all.
 *
 * Scope is a filter, never a weight: another project's memory or another
 * chat's session memory is the wrong answer, not a weak one.
 *
 * @module recall/search
 */

import { disabledIn } from '../registry-state.js';
import { memoryKey, type MemoryScope } from '../memory/store.js';
import { recallDb, rowToItem, getItem, normProject, ITEM_COLUMNS, type RecallItem, type RecallKind } from './store.js';
import { nearest, type Embedder } from './embed.js';
import { ftsQuery, jaccard, matchedTerms, normalizeText, queryTerms } from './text.js';

export const RRF_K = 60;
export const EPISODE_HALF_LIFE_DAYS = 30;
/** Cosine at or above this counts as "about the same thing" on its own. */
export const SEMANTIC_MIN = 0.35;
const CANDIDATES = 60;
const DAY = 24 * 60 * 60 * 1000;

export interface RecallQuery {
  query: string;
  kinds?: readonly RecallKind[];
  limit?: number;
  /** Whose project and session memories are visible. Default: none but global. */
  cwd?: string;
  sessionId?: string;
  /** Restrict to these item ids (the per-turn memory recall). */
  onlyIds?: ReadonlySet<string>;
  /** Include archived rows (weighted down). The Recall tool does; the prompt does not. */
  includeArchived?: boolean;
  embedder?: Embedder;
  /** A query vector already computed (tests, or a caller embedding once for several searches). */
  queryVector?: Float32Array;
  minSemantic?: number;
  /** Query terms an item must share to pass on words. Default 1 for a query of up to three terms, else 2. */
  minMatched?: number;
  now?: number;
  signal?: AbortSignal;
}

export interface RecallHit {
  item: RecallItem;
  score: number;
  /** 1-based rank in the words list, if it was there. */
  lexicalRank?: number;
  /** Cosine similarity, if it was in the meaning list. */
  semantic?: number;
  /** Query terms the item contains. */
  matched: number;
}

export interface RecallResult {
  hits: RecallHit[];
  mode: 'words' | 'hybrid';
  /** Why meaning was not used this time, when an embedder was offered and failed. */
  note?: string;
}

/** Whether a row may be shown to a run in `cwd` / `sessionId`. */
export function visibleTo(item: RecallItem, cwd: string | undefined, sessionId: string | undefined): boolean {
  if (item.kind === 'memory') {
    if (item.scope === 'global') return true;
    if (item.scope === 'project') return Boolean(cwd && item.project === normProject(cwd));
    if (item.scope === 'session') return Boolean(sessionId && item.project === `session:${sessionId.replace(/[^\w.-]/g, '-')}`)
      || Boolean(sessionId && item.project === `session:${sessionId}`);
    return false;
  }
  if (item.kind === 'knowledge') return item.scope === 'global' || Boolean(cwd && item.project === normProject(cwd));
  return true;
}

function memoryEnabled(item: RecallItem, disabled: ReadonlySet<string>): boolean {
  if (item.kind !== 'memory') return true;
  const id = typeof item.meta.memoryId === 'string' ? item.meta.memoryId : item.title;
  return !disabled.has(memoryKey(item.scope as MemoryScope, id));
}

/** Recency weight for an episode `ageDays` old: halves every 30 days, never below 0.1. */
export function recencyWeight(kind: RecallKind, ageDays: number): number {
  if (kind !== 'episode') return 1;
  return Math.max(0.1, 0.5 ** (Math.max(0, ageDays) / EPISODE_HALF_LIFE_DAYS));
}

export async function searchRecall(q: RecallQuery): Promise<RecallResult> {
  const now = q.now ?? Date.now();
  const limit = Math.max(1, Math.min(50, q.limit ?? 8));
  const kinds = q.kinds?.length ? new Set(q.kinds) : undefined;
  const statuses = q.includeArchived ? ['active', 'archived'] : ['active'];
  const disabled = disabledIn('memories');
  const admit = (item: RecallItem): boolean =>
    statuses.includes(item.status)
    && (!kinds || kinds.has(item.kind))
    && (!q.onlyIds || q.onlyIds.has(item.id))
    && visibleTo(item, q.cwd, q.sessionId)
    && memoryEnabled(item, disabled);

  const items = new Map<string, RecallItem>();

  // ── words ──
  const lexical: string[] = [];
  const match = ftsQuery(q.query);
  if (match) {
    const rows = recallDb().prepare(
      `SELECT ${ITEM_COLUMNS.split(', ').map(c => `items.${c}`).join(', ')}, bm25(items_fts, 3.0, 1.0) AS rank
       FROM items_fts JOIN items ON items.n = items_fts.rowid
       WHERE items_fts MATCH ? ORDER BY rank LIMIT 400`,
    ).all(match) as unknown as Parameters<typeof rowToItem>[0][];
    for (const r of rows) {
      const item = rowToItem(r);
      if (!admit(item)) continue;
      items.set(item.id, item);
      lexical.push(item.id);
      if (lexical.length >= CANDIDATES) break;
    }
  }

  // ── meaning ──
  const semantic = new Map<string, number>();
  const semanticOrder: string[] = [];
  let note: string | undefined;
  let mode: RecallResult['mode'] = 'words';
  if (q.embedder || q.queryVector) {
    try {
      const vector = q.queryVector ?? (await q.embedder!.embed([q.query], q.signal))[0];
      const model = q.embedder?.model;
      if (vector && model) {
        mode = 'hybrid';
        for (const { id, score } of nearest(model, vector, CANDIDATES * 4)) {
          const item = items.get(id) ?? getItem(id);
          if (!item || !admit(item)) continue;
          items.set(id, item);
          semantic.set(id, score);
          semanticOrder.push(id);
          if (semanticOrder.length >= CANDIDATES) break;
        }
      }
    } catch (err) {
      note = `searched by words only: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  // ── fuse, threshold, weigh ──
  const terms = queryTerms(q.query);
  // A short query is someone searching on purpose: one shared term is evidence.
  // A long one (a whole request, in the per-turn recall) needs two.
  const needed = Math.min(q.minMatched ?? (terms.length <= 3 ? 1 : 2), terms.length);
  const minSemantic = q.minSemantic ?? SEMANTIC_MIN;
  const lexRank = new Map(lexical.map((id, i) => [id, i + 1]));
  const semRank = new Map(semanticOrder.map((id, i) => [id, i + 1]));
  const hits: RecallHit[] = [];
  for (const [id, item] of items) {
    const lr = lexRank.get(id);
    const sr = semRank.get(id);
    const matched = matchedTerms(terms, `${item.title} ${item.text}`);
    const sem = semantic.get(id);
    // FTS matched it, so at least one term is there even when the JS stemmer disagrees with porter.
    const lexicalOk = lr !== undefined && Math.max(matched, 1) >= needed;
    const semanticOk = sem !== undefined && sem >= minSemantic;
    if (!lexicalOk && !semanticOk) continue;
    let score = (lr ? 1 / (RRF_K + lr) : 0) + (sr ? 1 / (RRF_K + sr) : 0);
    const ageDays = (now - (item.updated || item.created)) / DAY;
    score *= recencyWeight(item.kind, ageDays);
    score *= item.importance > 0 ? item.importance : 1;
    score *= 1 + 0.05 * Math.min(item.uses, 10);
    if (item.status === 'archived') score *= 0.5;
    hits.push({ item, score, ...(lr ? { lexicalRank: lr } : {}), ...(sem !== undefined ? { semantic: sem } : {}), matched });
  }
  hits.sort((a, b) => b.score - a.score || a.item.id.localeCompare(b.item.id));

  // ── dedupe: the same words twice (a memory and a profile fact, a fork's episode) is one result ──
  const kept: RecallHit[] = [];
  for (const h of hits) {
    const norm = normalizeText(h.item.text);
    if (kept.some(k => normalizeText(k.item.text) === norm || jaccard(k.item.text, h.item.text) >= 0.85)) continue;
    kept.push(h);
    if (kept.length >= limit) break;
  }
  return { hits: kept, mode, ...(note ? { note } : {}) };
}
