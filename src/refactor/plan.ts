/**
 * Plans for bulk, mechanical changes, and the one safe way to apply them.
 *
 * ## Why
 *
 * A rename across two hundred files done as two hundred `Edit` calls is two
 * hundred chances to miss one, two hundred tool results in the context, and no
 * single point at which the whole change can be seen, checked or taken back.
 * The refactor tools (`tools/refactor`) compute the whole change first — from
 * ast-grep or the TypeScript language service — and this module is what they
 * share after that: the plan, how it is shown, and how it lands.
 *
 * ## Enforced in the loop, not asked for in the prompt
 *
 * - **A plan is shown before it is applied.** An apply whose plan this run has
 *   not produced is answered with the plan, and nothing is written. An apply
 *   whose plan has changed since it was shown (a file moved under it) is
 *   answered with the new plan, again without writing. What lands is exactly
 *   what was shown, by digest.
 * - **Every apply is one checkpoint.** The files about to change are snapshot
 *   first (`checkpoint/snapshotFiles`), and also recorded into the turn's own
 *   checkpoint, so both "undo the refactor" and "undo the turn" work.
 * - **Then the project's checks run** (`RunChecks`), and on red the failures
 *   are reported with the rollback, or the rollback is performed when the call
 *   asked for it (`onFail: "rollback"`). The default is to report: a multi-step
 *   refactor is legitimately red between its steps.
 * - **Write scopes still hold.** An agent's `paths.write` guard reads the
 *   targets of a planned apply from here ({@link plannedWriteTargets}), so a
 *   bounded agent cannot reach outside its paths with one rewrite where it
 *   could not with one `Edit`.
 *
 * ## What it deliberately does not do
 *
 * - Apply partially. A write that fails midway restores what was written and
 *   reports the failure; half a rename is worse than none.
 * - Keep plans forever. A run keeps its last few; an old plan is recomputed.
 *
 * @module refactor/plan
 */

import { createHash } from 'crypto';
import { rm } from 'fs/promises';
import path from 'path';
import { structuredPatch } from 'diff';
import { runScoped } from '../run-scoped.js';
import { currentCwd } from '../run-context.js';
import { commitFile } from '../tools/file-writer.js';
import { resolveInsideWorkspace } from '../tools/path.js';
import {
  recordAfterWrite, recordBeforeWrite, restoreCheckpoint, sealSnapshot, snapshotFiles, storeCheckpoint,
  type Checkpoint,
} from '../checkpoint/index.js';
import { noteSourceChanged } from '../checks.js';
import { noteFileWritten } from '../verification.js';
import { observe } from '../tools/observation.js';

/** One file's change. `before` null: created. `after` null: deleted. */
export interface FileChange {
  /** Absolute path. */
  file: string;
  before: string | null;
  after: string | null;
  /** How many separate edits make up this change (matches, rename sites). */
  edits: number;
}

export interface RefactorPlan {
  tool: string;
  /** One line saying what the plan does. */
  title: string;
  changes: FileChange[];
  /** Said beside the plan: skipped matches, files the search could not parse. */
  notes: string[];
  /** Over every change's path, before and after — what "the same plan" means. */
  digest: string;
}

interface PlanState {
  plans: Map<string, RefactorPlan>;
  lastApply?: { checkpoint: Checkpoint; title: string };
}

const MAX_PLANS = 8;
const state = runScoped<PlanState>(() => ({ plans: new Map() }));

/** Arguments that say how to apply, not what — left out of a plan's identity. */
const HOW_KEYS = new Set(['dryRun', 'onFail', 'runChecks']);

/** Tools whose apply writes a plan's files, and whether this call is an apply. */
export function isApplyCall(tool: string, args: Record<string, unknown> | undefined): boolean {
  if (args?.dryRun !== false) return false;
  if (tool === 'CodeRewrite') return true;
  if (tool === 'Refactor') return ['rename', 'organizeImports', 'moveFile'].includes(String(args.action ?? ''));
  return false;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value as Record<string, unknown>).sort()
      .map(k => [k, canonical((value as Record<string, unknown>)[k])]));
  }
  return value;
}

/** A call's identity: the tool and what it asked for, not how it asked to apply. */
export function planKey(tool: string, args: Record<string, unknown>): string {
  const what = Object.fromEntries(Object.entries(args).filter(([k]) => !HOW_KEYS.has(k)));
  return `${tool}\0${JSON.stringify(canonical(what))}`;
}

function hash(text: string | null): string {
  return text === null ? '-' : createHash('sha256').update(text).digest('hex').slice(0, 24);
}

/** Build a plan from its changes. Files that would not change are dropped. */
export function makePlan(tool: string, title: string, changes: FileChange[], notes: string[] = []): RefactorPlan {
  const real = changes.filter(c => c.before !== c.after).sort((a, b) => a.file.localeCompare(b.file));
  const digest = createHash('sha256')
    .update(real.map(c => `${c.file}\0${hash(c.before)}\0${hash(c.after)}`).join('\n'))
    .digest('hex');
  return { tool, title, changes: real, notes, digest };
}

/** Remember a plan as shown for this call. */
export function rememberPlan(key: string, plan: RefactorPlan): void {
  const { plans } = state.get();
  plans.delete(key);
  plans.set(key, plan);
  while (plans.size > MAX_PLANS) plans.delete(plans.keys().next().value!);
}

/** The plan this run last showed for this call, if any. */
export function shownPlan(key: string): RefactorPlan | undefined {
  return state.get().plans.get(key);
}

/**
 * The files an apply call would write, for the write-paths guard.
 *
 * Undefined when the call is not an apply (it writes nothing). An apply with
 * no plan shown yet writes nothing either — it is answered with the plan — so
 * that is an empty list, and the guard looks again at the apply that follows.
 */
export function plannedWriteTargets(tool: string, args: Record<string, unknown> | undefined): string[] | undefined {
  if (!args || !isApplyCall(tool, args)) return undefined;
  return shownPlan(planKey(tool, args))?.changes.map(c => c.file) ?? [];
}

function rel(file: string): string {
  return path.relative(currentCwd(), file).split(path.sep).join('/') || file;
}

function countLines(text: string | null): number {
  return text === null || text === '' ? 0 : text.split('\n').length;
}

/**
 * The plan as the model and the person read it.
 *
 * Compact on purpose — a two-hundred-file rename must not cost two hundred
 * diffs of context. Every file is listed (to a cap) with its edit count; only
 * the first few hunks are shown, which is enough to see the shape of the change
 * and spot a wrong one.
 */
export function renderPlan(plan: RefactorPlan, opts: { maxFiles?: number; maxHunks?: number } = {}): string {
  const maxFiles = opts.maxFiles ?? 60;
  const maxHunks = opts.maxHunks ?? 6;
  if (plan.changes.length === 0) {
    return [`${plan.title}: nothing to change.`, ...plan.notes].join('\n');
  }
  const edits = plan.changes.reduce((n, c) => n + c.edits, 0);
  const lines: string[] = [
    `${plan.title}: ${plan.changes.length} file(s), ${edits} edit(s).`,
  ];
  for (const c of plan.changes.slice(0, maxFiles)) {
    const kind = c.before === null ? ' (new)' : c.after === null ? ' (deleted)' : '';
    lines.push(`  ${rel(c.file)}${kind}  ${c.edits}`);
  }
  if (plan.changes.length > maxFiles) lines.push(`  … and ${plan.changes.length - maxFiles} more file(s)`);

  const hunks: string[] = [];
  outer: for (const c of plan.changes) {
    if (c.before === null || c.after === null) continue;
    const patch = structuredPatch(rel(c.file), rel(c.file), c.before, c.after, '', '', { context: 1 });
    for (const h of patch.hunks) {
      if (hunks.length >= maxHunks) break outer;
      hunks.push([`--- ${rel(c.file)}`, `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`,
        ...h.lines.map(l => (l.length > 200 ? `${l.slice(0, 200)}…` : l))].join('\n'));
    }
  }
  if (hunks.length) lines.push('', `First ${hunks.length} hunk(s):`, ...hunks);
  if (plan.notes.length) lines.push('', ...plan.notes);
  return lines.join('\n');
}

export interface ApplyOptions {
  /** Run the project's checks after writing. Default true. */
  runChecks?: boolean;
  /** On red checks: report (default) or put the files back. */
  onFail?: 'report' | 'rollback';
  /** RunChecks, injected so this module does not pull the shell into its tests. */
  checks?: () => Promise<string>;
  /** Where to persist the checkpoint so `Checkpoint` lists it. */
  checkpointDir?: string;
}

function rollbackReport(report: { restored: string[]; removed: string[]; skipped: string[] }): string {
  const parts = [`${report.restored.length} file(s) restored`];
  if (report.removed.length) parts.push(`${report.removed.length} created file(s) removed`);
  if (report.skipped.length) {
    parts.push(`${report.skipped.length} left alone because something else changed them since: ${report.skipped.map(rel).join(', ')}`);
  }
  return parts.join(', ');
}

/** Note a written file wherever a write tool would. */
function noteWritten(file: string): void {
  noteSourceChanged(file);
  noteFileWritten(file);
  observe(file);
}

/**
 * Apply a plan: checkpoint, write, check, and roll back on request.
 *
 * Every target is resolved through the writable-roots rule first, so a plan
 * can never write where `Write` could not.
 */
export async function applyPlan(plan: RefactorPlan, opts: ApplyOptions = {}): Promise<string> {
  if (plan.changes.length === 0) return `${plan.title}: nothing to change, nothing written.`;
  for (const c of plan.changes) resolveInsideWorkspace(c.file, 'refactor target');

  const files = plan.changes.map(c => c.file);
  const checkpoint = await snapshotFiles(plan.title, files);
  for (const f of files) await recordBeforeWrite(f);

  const written: string[] = [];
  try {
    for (const c of plan.changes) {
      if (c.after === null) await rm(c.file, { force: true });
      else await commitFile(c.file, c.after, c.before);
      written.push(c.file);
    }
  } catch (err) {
    // Half a rename is worse than none: put back what landed, then say why.
    await sealSnapshot(checkpoint);
    const undo = await restoreCheckpoint({ ...checkpoint, files: checkpoint.files.filter(e => written.includes(e.file)) });
    for (const f of written) noteWritten(f);
    const reason = err instanceof Error ? err.message : String(err);
    return `NOT APPLIED — writing failed after ${written.length} of ${files.length} file(s): ${reason}\n`
      + `Rolled back: ${rollbackReport(undo)}.`;
  }

  for (const f of files) {
    await recordAfterWrite(f);
    noteWritten(f);
  }
  await sealSnapshot(checkpoint);
  const stored = opts.checkpointDir ? await storeCheckpoint(checkpoint, opts.checkpointDir) : false;
  state.get().lastApply = { checkpoint, title: plan.title };

  const edits = plan.changes.reduce((n, c) => n + c.edits, 0);
  const out: string[] = [
    `APPLIED — ${plan.title}: ${files.length} file(s), ${edits} edit(s). Checkpoint ${checkpoint.id}`
      + (stored ? ' (also listed by Checkpoint).' : '.'),
  ];

  if (opts.runChecks === false || !opts.checks) {
    out.push('Checks were not run. Run RunChecks before calling this done.');
    return out.join('\n');
  }

  const verdict = await opts.checks();
  const red = verdict.startsWith('FAILED');
  out.push('', verdict);
  if (!red) return out.join('\n');

  if (opts.onFail === 'rollback') {
    const report = await restoreCheckpoint(checkpoint);
    for (const f of files) noteWritten(f);
    state.get().lastApply = undefined;
    out.push('', `ROLLED BACK — the checks failed, so the change was undone: ${rollbackReport(report)}.`);
  } else {
    out.push('', 'The checks are red after this change. Fix forward if this is one step of a larger change, '
      + 'or undo it in one call with Refactor {"action":"rollback"}.');
  }
  return out.join('\n');
}

/** Undo the last apply this run made. */
export async function rollbackLastApply(): Promise<string> {
  const last = state.get().lastApply;
  if (!last) return 'Nothing to roll back — no refactor has been applied in this run (or it was already rolled back).';
  const report = await restoreCheckpoint(last.checkpoint);
  for (const entry of last.checkpoint.files) noteWritten(entry.file);
  state.get().lastApply = undefined;
  return `ROLLED BACK — ${last.title}: ${rollbackReport(report)}. Run RunChecks to confirm the project is back where it was.`;
}

/** For tests. */
export function resetRefactorPlans(): void {
  state.reset();
}
