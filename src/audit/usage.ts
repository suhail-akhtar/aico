/**
 * Usage and cost, summed from the same records the audit export is built from
 * (ADR 0035): `aico usage --since 2026-10-01 --by model --format csv`.
 *
 * One source of truth on purpose. A cost report that read the logs a second
 * way would disagree with the audit stream the first time somebody compared
 * them. The figures are **estimates**: token counts the providers reported,
 * multiplied by the price table (or the person's `modelPricing`), and every
 * row says so. They are not an invoice.
 *
 * `todaySpend` is what the managed policy's per-day cap is checked against, so
 * it is cached for a short while — the check runs at step boundaries and must
 * not re-read every log each time.
 *
 * @module audit/usage
 */

import type { AicoSettings } from '../settings.js';
import { collectAudit, type AuditRecord, type ExportOptions } from './export.js';
import { csvCell } from './format.js';

export type UsageBy = 'model' | 'project' | 'day';
export const USAGE_BY: readonly UsageBy[] = ['model', 'project', 'day'];

export interface UsageRow {
  key: string;
  turns: number;
  inputTokens: number;
  outputTokens: number;
  /** Estimated. */
  costUsd: number;
}

function keyOf(r: AuditRecord, by: UsageBy): string {
  if (by === 'model') return r.model || '(unknown)';
  if (by === 'project') return r.project || '(unknown)';
  return r.time.slice(0, 10);
}

/** Group `turn.end` records. Pure, for tests. */
export function summarizeUsage(records: readonly AuditRecord[], by: UsageBy): UsageRow[] {
  const rows = new Map<string, UsageRow>();
  for (const r of records) {
    if (r.kind !== 'turn.end') continue;
    const key = keyOf(r, by);
    const row = rows.get(key) ?? { key, turns: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 };
    row.turns++;
    row.inputTokens += r.inputTokens ?? 0;
    row.outputTokens += r.outputTokens ?? 0;
    row.costUsd += r.costUsd ?? 0;
    rows.set(key, row);
  }
  return [...rows.values()]
    .map(r => ({ ...r, costUsd: Math.round(r.costUsd * 1e6) / 1e6 }))
    .sort((a, b) => (by === 'day' ? (a.key < b.key ? -1 : 1) : b.costUsd - a.costUsd));
}

export async function usageReport(o: ExportOptions, by: UsageBy): Promise<UsageRow[]> {
  return summarizeUsage(await collectAudit(o), by);
}

export function usageToCsv(rows: readonly UsageRow[], by: UsageBy): string {
  const lines = [[by, 'turns', 'inputTokens', 'outputTokens', 'estimatedCostUsd'].join(',')];
  for (const r of rows) lines.push([csvCell(r.key), r.turns, r.inputTokens, r.outputTokens, r.costUsd.toFixed(4)].join(','));
  return lines.join('\r\n') + '\r\n';
}

export function usageToJson(rows: readonly UsageRow[], by: UsageBy): string {
  return JSON.stringify({ schema: 'aico.usage/1', by, estimated: true, rows }, null, 2) + '\n';
}

// ── today's spend, for the per-day cap ──────────────────────────────

let cached: { at: number; usd: number; day: string } | undefined;
const TTL_MS = 20_000;

/** Estimated spend since local midnight, across every session in the store. */
export async function todaySpend(settings?: AicoSettings, now = Date.now()): Promise<number> {
  const d = new Date(now);
  const day = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
  if (cached && cached.day === day && now - cached.at < TTL_MS) return cached.usd;
  const start = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  let usd = 0;
  try {
    for (const r of await collectAudit({ since: start, kinds: ['turn.end'], ...(settings ? { settings } : {}) })) if (r.kind === 'turn.end') usd += r.costUsd ?? 0;
  } catch { /* an unreadable store is not a reason to stop work; the session cap still applies */ }
  cached = { at: now, usd, day };
  return usd;
}

export function resetTodaySpendCache(): void { cached = undefined; }
