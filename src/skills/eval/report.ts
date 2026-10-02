/**
 * The record a skill measurement leaves behind, and what it permits.
 *
 * Split from `measure.ts` so that `SkillManage` (which the agent loop
 * imports) can read a report and apply the register gate without importing
 * the runner, which imports the agent loop — a cycle the bundle would have to
 * untangle. See `measure.ts` for why the report is bound to the tree hash.
 *
 * @module skills/eval/report
 */

import fs from 'fs';
import path from 'path';
import { treeHash } from '../provenance.js';

export const REPORT_FILE = '.aico-eval.json';

export interface ArmResult {
  score: number;
  /** The `why` of every check that failed. */
  missed: string[];
  toolCalls: number;
  costUsd: number;
  /** The final reply, clipped — the transcript a person reads before registering. */
  output: string;
  error?: string;
}

export interface TaskComparison {
  id: string;
  prompt: string;
  with?: ArmResult;
  without?: ArmResult;
}

export interface TriggerScore {
  /** Of the queries where this skill was opened, how many should have opened it. Null when it never was. */
  precision: number | null;
  /** Of the queries that should open it, how many did. Null when none should. */
  recall: number | null;
  accuracy: number;
  n: number;
}

export interface TriggerOutcome {
  query: string;
  shouldTrigger: boolean;
  split: 'train' | 'test';
  triggered: boolean;
  /** What was opened instead, if anything. */
  picked?: string;
}

export interface SkillEvalReport {
  version: 1;
  skill: string;
  model: string;
  at: string;
  /** Tree hash (provenance.treeHash) of the folder these results describe. */
  hash: string;
  budgetUsd: number;
  costUsd: number;
  overBudget: boolean;
  /** Every task ran in every requested arm. */
  complete: boolean;
  tasks: TaskComparison[];
  withMean?: number;
  withoutMean?: number;
  /** withMean − withoutMean, over tasks that ran in both arms. */
  uplift?: number;
  triggers?: {
    description: string;
    train: TriggerScore;
    /** Held-out score of the final description, one entry per run. */
    heldOut: TriggerScore[];
    precisionSpread?: { min: number; max: number };
    outcomes: TriggerOutcome[];
  };
  descriptionTuning?: {
    before: string;
    after: string;
    changed: boolean;
    candidates: Array<{ description: string; train: TriggerScore; test: TriggerScore }>;
  };
  unchecked: Array<{ task: string; expectation: string }>;
  notes: string[];
}

export function readReport(dir: string): SkillEvalReport | undefined {
  try {
    const r = JSON.parse(fs.readFileSync(path.join(dir, REPORT_FILE), 'utf8')) as SkillEvalReport;
    return r && r.version === 1 && typeof r.hash === 'string' ? r : undefined;
  } catch {
    return undefined;
  }
}

// ── the gate, and the words ─────────────────────────────────────────────

export type GateResult =
  | { ok: true; report?: SkillEvalReport }
  /** `person`: a person may register anyway; the model may not. */
  | { ok: false; reason: string; person: boolean; report?: SkillEvalReport };

/**
 * May this folder be registered, as far as its evals go?
 *
 * No evals: yes (the existing create → verify → register flow). Evals but no
 * report, or a report for different files: no, for anyone — measure it.
 * Measured but incomplete, or no better than the baseline: not on the model's
 * say-so; a person who has read the numbers may.
 */
export function evalGate(dir: string, hasEvalsFolder: boolean): GateResult {
  if (!hasEvalsFolder) return { ok: true };
  const report = readReport(dir);
  if (!report) {
    return { ok: false, person: false, reason: 'it has evals but they have never been run. Measure it first: SkillManage action:"eval", or `aico skill eval <name> --draft`.' };
  }
  if (report.hash !== treeHash(dir)) {
    return { ok: false, person: false, report, reason: 'its files changed after it was measured, so the results describe a different skill. Measure it again.' };
  }
  if (!report.complete) {
    return { ok: false, person: true, report, reason: `its measurement is incomplete${report.overBudget ? ' (the budget ran out)' : ''}. Re-run with a higher budget, or a person can register it from the results.` };
  }
  if (report.uplift !== undefined && report.uplift <= 0) {
    return {
      ok: false, person: true, report,
      reason: `it did not beat the no-skill baseline on its own tasks (with ${report.withMean?.toFixed(2)} vs without ${report.withoutMean?.toFixed(2)}). `
        + 'A skill that does not help still costs tokens on every use. Improve it and measure again, or a person can register it anyway.',
    };
  }
  if (report.uplift === undefined) {
    return { ok: false, person: true, report, reason: 'it was measured without the baseline, so there is no evidence it helps. Measure with the baseline.' };
  }
  return { ok: true, report };
}

const pct = (n: number | null | undefined): string => (n === null || n === undefined ? 'n/a' : n.toFixed(2));

/** The report in words — what the model relays and the terminal prints. */
export function describeReport(r: SkillEvalReport): string {
  const lines = [`Measured "${r.skill}" on ${r.model} — $${r.costUsd.toFixed(4)} of a $${r.budgetUsd.toFixed(2)} ceiling${r.overBudget ? ' (STOPPED: budget)' : ''}.`];
  if (r.tasks.length) {
    lines.push('', 'Tasks (score 0–1; with the skill · without it):');
    for (const t of r.tasks) {
      const w = t.with ? t.with.score.toFixed(2) : '—';
      const wo = t.without ? t.without.score.toFixed(2) : '—';
      lines.push(`  ${t.id}: ${w} · ${wo}${t.with?.error ? `  (with: crashed — ${t.with.error})` : ''}`);
      for (const m of t.with?.missed ?? []) lines.push(`      with, missed: ${m}`);
    }
    lines.push(r.uplift !== undefined
      ? `  mean ${r.withMean!.toFixed(2)} vs ${r.withoutMean!.toFixed(2)} → uplift ${r.uplift >= 0 ? '+' : ''}${r.uplift.toFixed(2)}`
      : `  mean with the skill ${pct(r.withMean)} (no baseline)`);
  }
  if (r.triggers) {
    const h = r.triggers.heldOut;
    const first = h[0]!;
    lines.push('', `Triggering (held-out ${first.n} quer(ies)): precision ${pct(first.precision)}, recall ${pct(first.recall)}, accuracy ${first.accuracy.toFixed(2)}`
      + (h.length > 1 ? ` — over ${h.length} runs precision ${r.triggers.precisionSpread ? `${r.triggers.precisionSpread.min.toFixed(2)}–${r.triggers.precisionSpread.max.toFixed(2)}` : 'n/a'}` : ''));
    // Phase 5's bar (design §10). Not a register gate — a person decides — but said plainly.
    if (first.precision !== null && first.precision < 0.8) {
      lines.push('  below 0.8 held-out precision: the description opens it for requests it is not for — narrow its "Use when" clause.');
    }
    const wrong = r.triggers.outcomes.filter(o => o.shouldTrigger !== o.triggered);
    for (const o of wrong.slice(0, 8)) lines.push(`  ${o.shouldTrigger ? 'missed' : 'false alarm'} (${o.split}): "${o.query}"${o.picked && !o.triggered ? ` → opened ${o.picked}` : ''}`);
  }
  if (r.descriptionTuning) {
    lines.push('', r.descriptionTuning.changed
      ? `Description rewritten (better on held-out queries):\n  before: ${r.descriptionTuning.before}\n  after:  ${r.descriptionTuning.after}`
      : 'Description kept: no revision beat it on the held-out queries.');
  }
  if (r.unchecked.length) lines.push('', `${r.unchecked.length} prose expectation(s) not scored (no judge yet).`);
  for (const n of r.notes) lines.push(`note: ${n}`);
  const gate = r.complete
    ? (r.uplift !== undefined && r.uplift > 0 ? 'Verdict: it helps on its own tasks. A person can register it.' : 'Verdict: no evidence it helps — do not register as is.')
    : 'Verdict: incomplete measurement.';
  lines.push('', gate);
  return lines.join('\n');
}
