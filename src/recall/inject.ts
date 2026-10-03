/**
 * Which memories ride in the cached prompt, and which are recalled per turn
 * (ADR 0018).
 *
 * SMALL STORES ARE UNTOUCHED. At or below 30 enabled memories and about
 * 1,500 tokens, every memory goes in the cached prefix exactly as before —
 * the prefix bytes do not change, so neither does the cache, and a person
 * with a dozen memories sees no difference at all.
 *
 * ABOVE THAT, RANKED. Sending two hundred memories whole on every request is
 * both expensive and noisy: most are about something else. Pinned memories
 * and global ones (the person's own standing preferences) stay in the prefix;
 * the rest are searched against the turn's request and only those above the
 * relevance threshold go into the volatile tail as `<recalled_memory>`,
 * within about 600 tokens. The tail is paid per step and invalidates nothing,
 * which is why per-turn content goes there (see agent.ts, knowledge).
 *
 * Deliberately not done: dropping a memory from the prefix because it seems
 * stale. Age is a ranking signal for episodes, never a reason to stop telling
 * the model something the person asked it to remember.
 *
 * @module recall/inject
 */

import type { StoredMemory } from '../memory/store.js';
import type { Embedder } from './embed.js';
import { recordUse, syncMemories } from './store.js';
import { searchRecall } from './search.js';
import { roughTokens } from './text.js';

export const PREFIX_MAX_MEMORIES = 30;
export const PREFIX_MAX_TOKENS = 1_500;
export const RECALLED_MAX_TOKENS = 600;

export interface MemorySplit {
  /** In the cached prefix, in the store's order. */
  prefix: StoredMemory[];
  /** Recalled per turn by relevance; empty for a small store. */
  ranked: StoredMemory[];
}

/** The memory as the prefix renders it, for the size estimate. */
const asLine = (m: StoredMemory): string =>
  `<memory id="${m.id}" scope="${m.scope}">${m.text.replace(/\s*\n+\s*/g, ' ').trim()}</memory>`;

export function splitMemories(memories: readonly StoredMemory[]): MemorySplit {
  const tokens = memories.reduce((n, m) => n + roughTokens(asLine(m)), 0);
  if (memories.length <= PREFIX_MAX_MEMORIES && tokens <= PREFIX_MAX_TOKENS) {
    return { prefix: [...memories], ranked: [] };
  }
  const prefix: StoredMemory[] = [];
  const ranked: StoredMemory[] = [];
  for (const m of memories) (m.pinned || m.scope === 'global' ? prefix : ranked).push(m);
  return { prefix, ranked };
}

/**
 * The body of the `recalled_memory` tail section for this turn, or '' when
 * nothing is relevant.
 * Never throws: recall failing must not fail a turn, it only means the turn
 * goes without the extra memories.
 */
export async function recalledMemoryBlock(
  ranked: readonly StoredMemory[],
  task: string,
  opts: { cwd: string; sessionId?: string; embedder?: Embedder; maxTokens?: number; signal?: AbortSignal } ,
): Promise<string> {
  if (!ranked.length || !task.trim()) return '';
  try {
    syncMemories();
    const ids = new Set(ranked.map(m => `memory:${m.file}`));
    const byId = new Map(ranked.map(m => [`memory:${m.file}`, m]));
    const { hits } = await searchRecall({
      query: task, kinds: ['memory'], onlyIds: ids, cwd: opts.cwd, ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
      limit: 12, minMatched: 2, ...(opts.embedder ? { embedder: opts.embedder } : {}), ...(opts.signal ? { signal: opts.signal } : {}),
    });
    const budget = opts.maxTokens ?? RECALLED_MAX_TOKENS;
    const lines: string[] = [];
    const used: string[] = [];
    let spent = 0;
    for (const h of hits) {
      const m = byId.get(h.item.id);
      if (!m) continue;
      const line = asLine(m);
      const cost = roughTokens(line);
      if (spent + cost > budget) continue;
      spent += cost;
      lines.push(line);
      used.push(h.item.id);
    }
    if (!lines.length) return '';
    recordUse(used);
    // The section id (`recalled_memory`) supplies the wrapper when rendered.
    return [
      '<!-- Remembered facts that match this request (the rest of the store was not relevant). Treat as true unless the conversation contradicts them. -->',
      ...lines,
    ].join('\n');
  } catch {
    return '';   // best effort: the prefix memories still stand, and the Recall tool can search the rest
  }
}
