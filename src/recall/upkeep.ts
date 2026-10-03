/**
 * Nightly upkeep for Recall: merge duplicates, archive what nobody uses,
 * catch up embeddings, compact the file (ADR 0018).
 *
 * NOTHING IS DELETED. Duplicates are marked `superseded` (memories in their
 * own file, through memory/store; episodes in the index), stale episodes are
 * marked `archived` and stay searchable through the Recall tool at half
 * weight. Memories, knowledge and About-you facts are never archived: the
 * person wrote or confirmed those, and age is not a reason to stop believing
 * them.
 *
 * NO MODEL. Merging is by normalized text and word overlap, the same test the
 * write path uses (memory/store `findNearDuplicate`). Rewording merged entries
 * with the background model was considered and left out: it would rewrite the
 * person's own words for a saving of a few lines.
 *
 * WHEN. Its own quiet hourly timer, the brief service's pattern (one unref'd
 * interval, nothing at start-up): it runs once a day between 02:00 and 06:00
 * local time, or whenever two days have passed without a run (a laptop that
 * sleeps at night). `AICO_RECALL_UPKEEP=off` disables it.
 *
 * @module recall/upkeep
 */

import { parseMemoryFile, markSuperseded, NEAR_DUPLICATE, type MemoryScope } from '../memory/store.js';
import { loadSettings } from '../settings.js';
import { embedderFromSettings, embedPending, type Embedder } from './embed.js';
import { closeRecall, getMeta, listItems, recallDb,setItemStatus, setMeta, syncAll, syncMemories, type SyncReport } from './store.js';
import { jaccard, normalizeText } from './text.js';

/** An episode nobody has recalled for this long is archived. */
export const ARCHIVE_AFTER_DAYS = 120;
const DAY = 24 * 60 * 60 * 1000;
const TICK_MS = 60 * 60 * 1000;

export interface UpkeepReport {
  synced: SyncReport;
  mergedMemories: number;
  mergedEpisodes: number;
  archived: number;
  embedded: number;
  embedError?: string;
  ms: number;
}

export async function runRecallUpkeep(opts: { now?: number; embedder?: Embedder; projectRoots?: string[] } = {}): Promise<UpkeepReport> {
  const started = Date.now();
  const now = opts.now ?? Date.now();
  const synced = syncAll({ budgetMs: 60_000, now, ...(opts.projectRoots ? { projectRoots: opts.projectRoots } : {}) });

  // ── memories: near-duplicates in one scope collapse onto the newest ──
  let mergedMemories = 0;
  const groups = new Map<string, ReturnType<typeof listItems>>();
  for (const it of listItems({ kind: 'memory', status: 'active' })) {
    const key = `${it.scope}\0${it.project ?? ''}`;
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(it);
  }
  for (const group of groups.values()) {
    const newestFirst = group.sort((a, b) => b.updated - a.updated).slice(0, 2_000);
    const gone = new Set<string>();
    for (let i = 0; i < newestFirst.length; i++) {
      const keep = newestFirst[i]!;
      if (gone.has(keep.id)) continue;
      for (let j = i + 1; j < newestFirst.length; j++) {
        const older = newestFirst[j]!;
        if (gone.has(older.id)) continue;
        const same = normalizeText(keep.text) === normalizeText(older.text) || jaccard(keep.text, older.text) >= NEAR_DUPLICATE;
        if (!same) continue;
        const file = parseMemoryFile(older.sourceRef, older.scope as MemoryScope);
        if (!file) continue;
        markSuperseded(file, typeof keep.meta.memoryId === 'string' ? keep.meta.memoryId : keep.title);
        gone.add(older.id);
        mergedMemories++;
      }
    }
  }
  if (mergedMemories) syncMemories();

  // ── episodes: a fork's untouched copy says the same thing as its source ──
  let mergedEpisodes = 0;
  const byText = new Map<string, string>();
  for (const ep of listItems({ kind: 'episode', status: 'active' }).sort((a, b) => b.updated - a.updated)) {
    const norm = normalizeText(ep.text);
    const newer = byText.get(norm);
    if (newer) { setItemStatus(ep.id, 'superseded', newer); mergedEpisodes++; }
    else byText.set(norm, ep.id);
  }

  // ── archive: old episodes nobody recalls ──
  let archived = 0;
  for (const ep of listItems({ kind: 'episode', status: 'active' })) {
    if (ep.pinned || ep.importance > 1) continue;
    const touched = Math.max(ep.lastUsed ?? 0, ep.updated);
    if (now - touched > ARCHIVE_AFTER_DAYS * DAY) { setItemStatus(ep.id, 'archived'); archived++; }
  }

  // ── embeddings the day's syncs left without a vector ──
  let embedded = 0; let embedError: string | undefined;
  if (opts.embedder) {
    const r = await embedPending(opts.embedder, { budgetMs: 60_000, max: 5_000 });
    embedded = r.embedded; embedError = r.error;
  }

  // ── compact ──
  try {
    const db = recallDb();
    db.exec(`INSERT INTO items_fts(items_fts) VALUES ('optimize')`);
    db.exec('PRAGMA optimize');
    db.exec('VACUUM');
  } catch { /* another process holds the file: compaction waits for tomorrow */ }

  setMeta('lastUpkeep', String(now));
  return {
    synced, mergedMemories, mergedEpisodes, archived, embedded, ...(embedError ? { embedError } : {}), ms: Date.now() - started,
  };
}

/** Whether upkeep should run at `now`, given when it last ran. */
export function upkeepDue(now: number, lastRun: number | undefined): boolean {
  if (!lastRun) return new Date(now).getHours() >= 2 && new Date(now).getHours() < 6;
  const since = now - lastRun;
  if (since >= 2 * DAY) return true;
  const hour = new Date(now).getHours();
  return since >= 20 * 60 * 60 * 1000 && hour >= 2 && hour < 6;
}

let timer: ReturnType<typeof setInterval> | undefined;
let running = false;

async function tick(): Promise<void> {
  if (running) return;
  const last = Number(getMeta('lastUpkeep') ?? 0) || undefined;
  if (!upkeepDue(Date.now(), last)) return;
  running = true;
  try {
    const settings = await loadSettings();
    const embedder = embedderFromSettings(settings, settings.model ?? '');
    await runRecallUpkeep(embedder ? { embedder } : {});
  } finally {
    running = false;
  }
}

export function startRecallUpkeep(): void {
  if (timer || process.env.AICO_RECALL_UPKEEP === 'off') return;
  timer = setInterval(() => { void tick().catch(() => { /* retried next hour */ }); }, TICK_MS);
  timer.unref?.();
}

export function stopRecallUpkeep(): void {
  if (timer) clearInterval(timer);
  timer = undefined;
  closeRecall();
}
