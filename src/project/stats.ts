/**
 * What a workspace's whole history adds up to.
 *
 * Cost and usage exist per session — `run.tokenTracker` for one that is
 * currently open, nothing at all for one that has been closed and reopened
 * later. Answering "what has this workspace cost me" means reading every
 * session's log, which is the one thing `listSessionSummaries`
 * (`src/session/persistence.ts`) already gets right: a cheap substring
 * pre-filter before any line is parsed, so a busy log full of tool chunks
 * costs almost nothing to skip. This mirrors that, and prices what it finds
 * with the same `costFor` the rest of the engine uses — a session that
 * changed models partway through is priced correctly for both halves, by
 * tracking whichever model's `request/header` came most recently before each
 * usage sample.
 *
 * @module project/stats
 */

import { readFile, readdir } from 'fs/promises';
import path from 'path';
import { getSessionDir } from '../history.js';
import { costFor } from '../tokens.js';
import type { AicoSettings } from '../settings.js';

export interface ProjectStats {
  sessions: number;
  turns: number;
  costUsd: number;
  firstActive: number | null;
  lastActive: number | null;
  /** User turns per day, oldest first, for the last 30 days only. */
  byDay: Array<{ date: string; count: number }>;
}

const NEWLINE = /\r?\n/;
const DAY_MS = 24 * 60 * 60 * 1000;

function emptyStats(): ProjectStats {
  return { sessions: 0, turns: 0, costUsd: 0, firstActive: null, lastActive: null, byDay: [] };
}

/** Totals across every session this workspace has ever had. */
export async function projectStats(cwd: string, settings?: AicoSettings): Promise<ProjectStats> {
  const dir = getSessionDir(cwd);
  let files: string[];
  try {
    files = (await readdir(dir)).filter(f => f.endsWith('.events.jsonl'));
  } catch {
    return emptyStats();
  }
  if (files.length === 0) return emptyStats();

  let turns = 0;
  let costUsd = 0;
  let firstActive: number | null = null;
  let lastActive: number | null = null;
  const byDay = new Map<string, number>();
  const cutoff = Date.now() - 30 * DAY_MS;

  await Promise.all(files.map(async (file) => {
    let text: string;
    try { text = await readFile(path.join(dir, file), 'utf8'); } catch { return; }

    // The model in force when a usage sample was reported — a request/header
    // line updates it, and it applies to every assistant/message after until
    // the next one.
    let currentModel: string | undefined;

    for (const line of text.split(NEWLINE)) {
      if (!line) continue;
      const isHeader = line.includes('"request/header"');
      const isAssistant = isHeader ? false : line.includes('"assistant/message"');
      const isUser = isHeader || isAssistant ? false : line.includes('"user/message"');
      if (!isHeader && !isAssistant && !isUser) continue;

      let event: { type?: string; timestamp?: number; data?: Record<string, unknown> };
      try { event = JSON.parse(line) as typeof event; } catch { continue; }

      if (event.type === 'request/header') {
        currentModel = (event.data?.header as { model?: string } | undefined)?.model;
      } else if (event.type === 'assistant/message') {
        const usage = event.data?.usage as
          { inputTokens?: number; outputTokens?: number; cachedTokens?: number } | undefined;
        if (usage && currentModel) costUsd += costFor(currentModel, usage, settings);
      } else if (event.type === 'user/message') {
        turns++;
        if (typeof event.timestamp === 'number') {
          if (firstActive === null || event.timestamp < firstActive) firstActive = event.timestamp;
          if (lastActive === null || event.timestamp > lastActive) lastActive = event.timestamp;
          if (event.timestamp >= cutoff) {
            const day = new Date(event.timestamp).toISOString().slice(0, 10);
            byDay.set(day, (byDay.get(day) ?? 0) + 1);
          }
        }
      }
    }
  }));

  return {
    sessions: files.length,
    turns,
    costUsd,
    firstActive,
    lastActive,
    byDay: [...byDay.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, count]) => ({ date, count })),
  };
}
