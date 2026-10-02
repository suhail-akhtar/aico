/**
 * A skill's own evals — `evals/evals.json` — read into tasks the runner can score.
 *
 * WHY. Phase 5 (design §5.1 "Generation", §10) has `skill-author` write a skill
 * *and* the tasks that prove it helps. Those tasks travel with the skill, in
 * skill-creator's `evals.json` shape so a skill moved between Claude and AICO
 * keeps them: `{ skill_name, evals: [{ id, prompt, files, expectations }] }`.
 * AICO extends a task with `checks` (the deterministic graders of
 * `eval/types.ts`) and the file with `triggers` (`[{ query, should_trigger }]`,
 * skill-creator's description-optimisation shape; also read from
 * `evals/triggers.json`).
 *
 * WHAT IS SCORED. Only deterministic checks. skill-creator's `expectations`
 * are prose for an LLM judge; there is no judge yet (Phase 4), so a prose
 * expectation is carried as "unchecked" and reported, never silently passed.
 * An expectation written as `/regex/flags` (or `!/regex/` for "must not") is a
 * check. A task with no check at all cannot be scored and is left out of the
 * measurement — and said to be.
 *
 * WHAT IT DOES NOT. Run anything. Parsing is pure so `verify` can lint the
 * file for free; `measure.ts` does the spending.
 *
 * @module skills/eval/evals-file
 */

import fs from 'fs';
import path from 'path';
import type { Check, EvalTask } from './types.js';

export interface TriggerQuery { query: string; shouldTrigger: boolean }

export interface DraftEvals {
  /** Tasks with at least one deterministic check, ready for `runTask`. */
  tasks: EvalTask[];
  /** The task prompt by task id (the runner only carries it inside `args`). */
  prompts: Record<string, string>;
  triggers: TriggerQuery[];
  /** Prose expectations nobody can grade yet, by task. */
  unchecked: Array<{ task: string; expectation: string }>;
  /** Faults that make the file unusable as written. Lint errors. */
  problems: string[];
  /** Things worth fixing that do not block. Lint warnings. */
  notes: string[];
}

const CHECK_KINDS = new Set<Check['kind']>([
  'output-matches', 'output-lacks', 'file-exists', 'file-matches', 'no-file-changed', 'max-tool-calls',
]);

/** Below these, a measurement is too thin to mean much (design §5.1 step 3). */
export const MIN_TASKS = 3;
export const MIN_TRIGGERS = 10;

export function evalsFile(dir: string): string { return path.join(dir, 'evals', 'evals.json'); }
export function triggersFile(dir: string): string { return path.join(dir, 'evals', 'triggers.json'); }

/** Whether a skill directory carries evals at all. */
export function hasEvals(dir: string): boolean {
  return fs.existsSync(evalsFile(dir)) || fs.existsSync(triggersFile(dir));
}

function compiles(pattern: string, flags?: string): boolean {
  try { new RegExp(pattern, flags ?? 'im'); return true; } catch { return false; }
}

/** `/x/i` → output-matches, `!/x/` → output-lacks; anything else is prose. */
function expectationCheck(text: string): Check | null {
  const m = /^(!?)\/(.+)\/([a-z]*)$/s.exec(text.trim());
  if (!m || !compiles(m[2]!, m[3] || undefined)) return null;
  return {
    kind: m[1] ? 'output-lacks' : 'output-matches',
    pattern: m[2]!,
    ...(m[3] ? { flags: m[3] } : {}),
    why: `Expectation not met: ${text.trim()}`,
  };
}

function validCheck(raw: unknown, where: string, problems: string[]): Check | null {
  if (!raw || typeof raw !== 'object') { problems.push(`${where}: a check must be an object.`); return null; }
  const c = raw as Record<string, unknown>;
  const kind = c.kind as Check['kind'];
  if (!CHECK_KINDS.has(kind)) {
    problems.push(`${where}: unknown check kind "${String(c.kind)}". Use one of ${[...CHECK_KINDS].join(', ')}.`);
    return null;
  }
  if ((kind === 'output-matches' || kind === 'output-lacks' || kind === 'file-matches')
    && (typeof c.pattern !== 'string' || !compiles(c.pattern, c.flags as string | undefined))) {
    problems.push(`${where}: "${kind}" needs a pattern that compiles as a regular expression.`);
    return null;
  }
  if ((kind === 'file-exists' || kind === 'file-matches') && typeof c.path !== 'string') {
    problems.push(`${where}: "${kind}" needs a path.`);
    return null;
  }
  if (kind === 'max-tool-calls' && typeof c.limit !== 'number') {
    problems.push(`${where}: "max-tool-calls" needs a numeric limit.`);
    return null;
  }
  return { ...(c as object), why: typeof c.why === 'string' && c.why ? c.why : `${kind} failed` } as Check;
}

/** skill-creator lists input files by path; AICO also takes `{ path: content }`. */
function readFiles(raw: unknown, dir: string, where: string, problems: string[]): Record<string, string> | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (Array.isArray(raw)) {
    if (raw.length === 0) return undefined;
    const out: Record<string, string> = {};
    for (const rel of raw) {
      if (typeof rel !== 'string') { problems.push(`${where}: files lists a non-path.`); continue; }
      const abs = path.resolve(dir, rel);
      if (!abs.startsWith(path.resolve(dir) + path.sep) || !fs.existsSync(abs)) {
        problems.push(`${where}: file "${rel}" is not inside the skill folder.`);
        continue;
      }
      out[path.basename(rel)] = fs.readFileSync(abs, 'utf8');
    }
    return out;
  }
  if (typeof raw === 'object') {
    const out: Record<string, string> = {};
    for (const [rel, content] of Object.entries(raw as Record<string, unknown>)) {
      if (path.isAbsolute(rel) || rel.split(/[\\/]/).includes('..') || typeof content !== 'string') {
        problems.push(`${where}: fixture file "${rel}" must be a relative path with text content.`);
        continue;
      }
      out[rel] = content;
    }
    return out;
  }
  problems.push(`${where}: files must be a list of paths or an object of path → content.`);
  return undefined;
}

function readTriggers(raw: unknown, where: string, problems: string[]): TriggerQuery[] {
  if (!Array.isArray(raw)) { problems.push(`${where}: triggers must be a list of { query, should_trigger }.`); return []; }
  const out: TriggerQuery[] = [];
  raw.forEach((t, i) => {
    const q = t as Record<string, unknown>;
    const should = q?.should_trigger ?? q?.shouldTrigger;
    if (typeof q?.query !== 'string' || !q.query.trim() || typeof should !== 'boolean') {
      problems.push(`${where}[${i}]: needs a query and should_trigger true/false.`);
      return;
    }
    out.push({ query: q.query.trim(), shouldTrigger: should });
  });
  return out;
}

function readJson(file: string, problems: string[]): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    problems.push(`${path.basename(file)} does not parse as JSON: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
}

/** Read a skill folder's evals, or null when it has none. Never throws. */
export function readDraftEvals(dir: string, skill: string): DraftEvals | null {
  if (!hasEvals(dir)) return null;
  const out: DraftEvals = { tasks: [], prompts: {}, triggers: [], unchecked: [], problems: [], notes: [] };

  if (fs.existsSync(evalsFile(dir))) {
    const doc = readJson(evalsFile(dir), out.problems) as Record<string, unknown> | undefined;
    if (doc !== undefined && (typeof doc !== 'object' || doc === null || Array.isArray(doc))) {
      out.problems.push('evals.json must be an object: { "skill_name", "evals": [...], "triggers": [...] }.');
    } else if (doc) {
      const evals = doc.evals;
      if (evals !== undefined && !Array.isArray(evals)) out.problems.push('evals.json: "evals" must be a list.');
      const ids = new Set<string>();
      (Array.isArray(evals) ? evals : []).forEach((e, i) => {
        const where = `evals.json evals[${i}]`;
        const t = e as Record<string, unknown>;
        if (!t || typeof t !== 'object' || typeof t.prompt !== 'string' || !t.prompt.trim()) {
          out.problems.push(`${where}: needs a prompt.`);
          return;
        }
        const id = `${skill}/${String(t.id ?? i + 1)}`;
        if (ids.has(id)) { out.problems.push(`${where}: duplicate id ${String(t.id)}.`); return; }
        ids.add(id);
        const checks: Check[] = [];
        for (const [j, c] of (Array.isArray(t.checks) ? t.checks : []).entries()) {
          const ok = validCheck(c, `${where}.checks[${j}]`, out.problems);
          if (ok) checks.push(ok);
        }
        for (const x of Array.isArray(t.expectations) ? t.expectations : []) {
          if (typeof x !== 'string') continue;
          const asCheck = expectationCheck(x);
          if (asCheck) checks.push(asCheck);
          else out.unchecked.push({ task: id, expectation: x });
        }
        const files = readFiles(t.files, dir, where, out.problems);
        const baseline = t.git && typeof t.git === 'object'
          ? readFiles((t.git as Record<string, unknown>).baseline, dir, `${where}.git`, out.problems)
          : undefined;
        if (checks.length === 0) {
          out.notes.push(`${where} has no deterministic check (a "checks" entry or a /regex/ expectation), so it cannot be scored and is left out.`);
          return;
        }
        out.prompts[id] = t.prompt.trim();
        out.tasks.push({
          id, skill, args: t.prompt.trim(), checks,
          ...(files ? { files } : {}),
          ...(t.git ? { git: { ...(baseline ? { baseline } : {}) } } : {}),
        });
      });
      if (doc.triggers !== undefined) out.triggers.push(...readTriggers(doc.triggers, 'evals.json triggers', out.problems));
    }
  }
  if (fs.existsSync(triggersFile(dir))) {
    const doc = readJson(triggersFile(dir), out.problems);
    if (doc !== undefined) out.triggers.push(...readTriggers(doc, 'triggers.json', out.problems));
  }

  if (out.tasks.length < MIN_TASKS) {
    out.notes.push(`${out.tasks.length} scorable task(s); at least ${MIN_TASKS} make the with/without comparison worth its cost.`);
  }
  if (out.triggers.length < MIN_TRIGGERS) {
    out.notes.push(`${out.triggers.length} trigger quer(ies); ${MIN_TRIGGERS}+ (about half should trigger) make precision and recall mean something.`);
  } else if (out.triggers.every(t => t.shouldTrigger) || out.triggers.every(t => !t.shouldTrigger)) {
    out.notes.push('Every trigger query expects the same answer; add ones that should go the other way, or precision/recall cannot be told apart.');
  }
  if (out.unchecked.length) {
    out.notes.push(`${out.unchecked.length} prose expectation(s) need a judge, which AICO does not run yet; they are reported, not scored. Write them as /regex/ to score them.`);
  }
  return out;
}
