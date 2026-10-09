/**
 * How risky a finished task is to land, in one number and the reasons for it.
 *
 * WHY. Review is the only gate between an agent's branch and the trunk (ADR 0038), so
 * the reviewer's attention is the scarce resource. The score tells them where to spend
 * it: a ten-line change to one leaf file with its test is skimmed; a wide change that
 * reaches many dependents, weakens a test or contains something that looks like a
 * secret is read line by line. It is also the only input to the optional auto-land of
 * low-risk work (`autoLandLowRisk`, off by default), so it errs towards medium/high:
 * every signal below only ever ADDS risk, nothing subtracts, and an analysis that
 * cannot run adds a reason saying so rather than quietly scoring low.
 *
 * Signals, all computed from the diff against the trunk with existing engine analysis:
 *  - **size**: lines and files changed;
 *  - **blast radius**: files that depend on the changed ones (code graph, two layers);
 *  - **tests**: a test file deleted, its assertions removed, skips or weak matchers
 *    added (`test-tamper`); source changed with no test touched;
 *  - **change safety**: secrets and high-severity code rules on the ADDED lines
 *    only (`shared/security/rules`), so old code in a touched file is not the task's fault;
 *  - **sensitive paths**: manifests and lockfiles, CI workflows, containers, auth /
 *    crypto / security / migration code.
 *
 * Deliberately not a model's opinion: the score is deterministic, so it can be tested
 * and the same diff always reads the same.
 *
 * @module delivery/risk
 */

import fs from 'node:fs';
import path from 'node:path';
import { findSecrets, scanCode, languageOf } from '../../shared/security/rules.mjs';
import { isTestFile, compareTest, type TamperFinding } from '../security/test-tamper.js';
import { changedFiles, diffText, git, showFile } from './git.js';
import type { RiskLevel, Task } from './types.js';

export interface RiskInput {
  project: string;
  worktree: string;
  /** The commit the branch is measured against (the trunk it was rebased onto). */
  base: string;
  /** Lines added and removed per file, from git. */
  stats: Array<{ path: string; added: number; removed: number }>;
}

const SENSITIVE: Array<{ re: RegExp; why: string }> = [
  { re: /(^|\/)(package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|Cargo\.toml|Cargo\.lock|go\.mod|go\.sum|pyproject\.toml|requirements[\w.-]*\.txt|Gemfile(\.lock)?|composer\.(json|lock)|pom\.xml|build\.gradle(\.kts)?)$/i, why: 'changes dependencies or build configuration' },
  { re: /(^|\/)\.github\/workflows\//, why: 'changes a CI workflow' },
  { re: /(^|\/)(Dockerfile|docker-compose[\w.-]*\.ya?ml)$/i, why: 'changes container configuration' },
  { re: /(auth|crypto|secur|permission|password|token|credential|session|migration|schema)/i, why: 'touches authentication, security or data-schema code' },
];

export function levelOf(score: number): RiskLevel { return score < 25 ? 'low' : score < 55 ? 'medium' : 'high'; }

/** `git diff --numstat` against the base, per file. */
export async function numstat(dir: string, base: string): Promise<RiskInput['stats']> {
  const r = await git(['diff', '--numstat', '--no-renames', base, 'HEAD'], dir);
  if (!r.ok) return [];
  const out: RiskInput['stats'] = [];
  for (const line of r.out.split('\n')) {
    const m = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line);
    if (m) out.push({ path: m[3]!, added: m[1] === '-' ? 0 : Number(m[1]), removed: m[2] === '-' ? 0 : Number(m[2]) });
  }
  return out;
}

/** Added line numbers per file from a unified diff. */
function addedLines(diff: string): Map<string, Set<number>> {
  const out = new Map<string, Set<number>>();
  let file: string | undefined;
  let next = 0;
  for (const l of diff.split('\n')) {
    const f = /^\+\+\+ (?:b\/)?(.*)$/.exec(l);
    if (f) { file = f[1] === '/dev/null' ? undefined : f[1]!.replace(/\r$/, ''); if (file && !out.has(file)) out.set(file, new Set()); continue; }
    const h = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(l);
    if (h) { next = Number(h[1]); continue; }
    if (!file) continue;
    if (l.startsWith('+') && !l.startsWith('+++')) { out.get(file)!.add(next); next++; }
    else if (!l.startsWith('-') && !l.startsWith('\\')) next++;
  }
  return out;
}

export async function assessRisk(input: RiskInput): Promise<NonNullable<Task['risk']>> {
  const reasons: string[] = [];
  let score = 0;
  /** Some findings are never "low" however small the change: they set a floor under the score. */
  let floor = 0;
  const add = (n: number, why: string): void => { score += n; reasons.push(`${why} (+${n})`); };

  const files = input.stats.map(s => s.path.replace(/\\/g, '/'));
  const lines = input.stats.reduce((n, s) => n + s.added + s.removed, 0);

  // Size.
  const sizePts = Math.min(25, Math.floor(lines / 12));
  if (sizePts > 0) add(sizePts, `${lines} lines changed across ${files.length} file${files.length === 1 ? '' : 's'}`);
  const filePts = Math.min(10, Math.max(0, files.length - 2));
  if (filePts > 0) add(filePts, `${files.length} files touched`);

  // Blast radius, from the project's code graph.
  try {
    const { getCodeGraph } = await import('../codegraph/index.js');
    const { impactLayers } = await import('../codegraph/analyze.js');
    const g = await getCodeGraph(input.project);
    const byPath = new Map(g.files.map(f => [f.path.replace(/\\/g, '/'), f.id]));
    const seeds = files.map(f => byPath.get(f)).filter((x): x is number => x !== undefined);
    if (seeds.length > 0) {
      const dependents = new Set<number>();
      for (const layer of impactLayers(g, seeds, 2)) for (const id of layer.files) dependents.add(id);
      for (const s of seeds) dependents.delete(s);
      const pts = Math.min(30, Math.round(dependents.size * 1.5));
      if (pts > 0) add(pts, `${dependents.size} other file${dependents.size === 1 ? '' : 's'} depend on what changed`);
    }
  } catch {
    reasons.push('blast radius not analysed (the code graph could not be read)');
  }

  // Tests.
  const changed = await changedFiles(input.worktree, input.base);
  const tamper: TamperFinding[] = [];
  for (const c of changed) {
    if (!isTestFile(c.path)) continue;
    const before = c.status === 'A' ? null : await showFile(input.worktree, input.base, c.path);
    let after: string | null = null;
    if (c.status !== 'D') { try { after = fs.readFileSync(path.join(input.worktree, c.path), 'utf8'); } catch { after = null; } }
    if (before === null && after === null) continue;
    tamper.push(...compareTest(c.path, before, after));
  }
  const hard = tamper.filter(t => t.kind === 'test-file-deleted' || t.kind === 'assertions-removed' || t.kind === 'skip-marker-added');
  const soft = tamper.filter(t => !hard.includes(t));
  if (hard.length > 0) floor = Math.max(floor, 25);
  if (hard.length > 0) add(Math.min(40, 20 * hard.length), `weakened tests: ${hard.slice(0, 3).map(t => t.detail).join('; ')}`);
  if (soft.length > 0) add(Math.min(15, 8 * soft.length), `test expectations loosened: ${soft.slice(0, 2).map(t => t.detail).join('; ')}`);
  const sourceChanged = changed.some(c => !isTestFile(c.path) && /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|cs|php|rb|swift|c|cc|cpp|h)$/i.test(c.path));
  if (sourceChanged && !changed.some(c => isTestFile(c.path))) add(10, 'source changed and no test was added or changed');

  // Change safety, on the added lines only.
  try {
    const diff = await diffText(input.worktree, input.base);
    const added = addedLines(diff);
    let secrets = 0;
    const where: string[] = [];
    let high = 0;
    let medium = 0;
    for (const [rel, set] of added) {
      if (set.size === 0 || /(^|\/)(node_modules|dist|build|vendor)\//.test(rel)) continue;
      let text = '';
      try { text = fs.readFileSync(path.join(input.worktree, rel), 'utf8'); } catch { continue; }
      if (text.slice(0, 8000).includes('\0')) continue;
      for (const s of findSecrets(text)) if (set.has(s.line)) { secrets++; if (where.length < 2) where.push(`${rel}:${s.line} ${s.name}`); }
      if (!languageOf(rel)) continue;
      for (const f of scanCode(rel, text)) {
        if (!set.has(f.line)) continue;
        if (f.severity === 'high') { high++; if (where.length < 2) where.push(`${rel}:${f.line} ${f.rule}`); } else medium++;
      }
    }
    if (secrets > 0) floor = Math.max(floor, 55);
    if (secrets > 0) add(40, `${secrets} possible secret${secrets === 1 ? '' : 's'} in the added lines (${where.join(', ')})`);
    if (high > 0) floor = Math.max(floor, 25);
    if (high > 0) add(Math.min(40, 20 * high), `${high} high-severity code finding${high === 1 ? '' : 's'} in the added lines`);
    if (medium > 0) add(Math.min(6, medium * 2), `${medium} medium-severity code finding${medium === 1 ? '' : 's'}`);
  } catch {
    reasons.push('change-safety scan did not run');
  }

  // Sensitive places.
  const seen = new Set<string>();
  let sens = 0;
  for (const f of files) {
    for (const s of SENSITIVE) {
      if (s.re.test(f) && !seen.has(s.why)) { seen.add(s.why); sens += 8; reasons.push(`${f} ${s.why} (+8)`); }
    }
  }
  score += Math.min(20, sens);

  score = Math.max(floor, Math.min(100, Math.round(score)));
  if (reasons.length === 0) reasons.push('a small change with no risk signal');
  return { score, level: levelOf(score), reasons };
}
