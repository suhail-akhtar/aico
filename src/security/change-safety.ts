/**
 * Change safety: what the agent's own diff contains, checked in the loop before
 * a turn may end and before a commit is made (ADR 0033).
 *
 * WHY. ADR 0026's `security` check runs inside RunChecks, and RunChecks only
 * joins a project that defines other checks; a model that wrote a key into a
 * config file in a folder with no `package.json` was never looked at. And a
 * commit made through `git commit` in a shell read none of it. A model that is
 * optimising for "the error went away" does exactly these things (hard-codes the
 * key that made the 401 disappear, turns TLS verification off, deletes the test
 * that failed), and asking it not to is a request it declines when confident
 * (AGENTS.md section 4.6). So this is checked in code:
 *
 *   - {@link changeSafetyGate}: at turn end, over the files the turn wrote.
 *     Secrets and high-severity code-rule findings (SQL by concatenation, shell
 *     built from input, eval, TLS off, hard-coded credentials, unsafe
 *     deserialisation, weak password hashes, in JS/TS, Python, Go, Java, PHP and
 *     C#) and weakened tests nudge the model with file:line and the fix. Bounded
 *     by the caller (`agent.ts` allows 2 nudges a turn); a finding already
 *     reported is never reported again, so a model that disagrees is not argued
 *     with in a loop; medium findings are recorded, not nudged.
 *   - {@link secretsInDiff}: the commit gate. A staged (or about-to-be-staged)
 *     change that adds a secret is refused by the `Git` tool, `AppManage commit`
 *     and the `change-safety-commit` guard on `git commit` in any shell tool.
 *
 * Every finding is handed to the finding sink, which appends a `safety/finding`
 * record to the session log for the change-evidence report (ADR 0034).
 *
 * Deliberately not here: dependency audits and external scanners (the
 * `security` check keeps those), a taint engine, and anything that blocks on a
 * medium finding — a gate that cries wolf gets switched off. A line is waived
 * with `security-allow: <rule> — reason`; a secret fixture is waived with
 * `standards-allow: secret`, as everywhere else.
 *
 * @module security/change-safety
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { findSecrets } from '../../shared/security/rules.mjs';
import { runScoped } from '../run-scoped.js';
import { currentRunContext } from '../run-context.js';
import { emit, type FindingSink } from './finding.js';
import { scanWrittenFiles } from './project-scan.js';
import { compareTest, isTestFile, type TamperFinding } from './test-tamper.js';

/** `completionGate.changeSafety` is on unless the person turned it off (a project can only turn it on). */
export function changeSafetyEnabled(): boolean {
  return currentRunContext()?.settings?.completionGate?.changeSafety !== false;
}

// ── Per-turn state ───────────────────────────────────────────────────

interface TurnState {
  /** Fingerprints of findings already reported this turn. */
  reported: Set<string>;
  /** Tamper the tool-call guard saw (a shell deletion), for the turn-end gate. */
  observed: TamperFinding[];
  /** What the last evaluation looked at, so an unchanged tree is not rescanned. */
  signature: string;
}

const turn = runScoped<TurnState>(() => ({ reported: new Set(), observed: [], signature: '' }));

/** Start of turn: last turn's findings are not this turn's. */
export function resetChangeSafety(): void { turn.reset(); }

/** The test-tamper guard saw something the end-of-turn comparison cannot (a deleted file). */
export function noteTamperObserved(f: TamperFinding): void {
  const s = turn.get();
  if (!s.observed.some(o => o.kind === f.kind && o.file === f.file)) s.observed.push(f);
}

// ── git helpers ──────────────────────────────────────────────────────

function git(cwd: string, args: string[], timeoutMs = 15_000): Promise<{ code: number | null; out: string }> {
  return new Promise(resolve => {
    execFile('git', args, { cwd, timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, windowsHide: true }, (err, stdout) => {
      const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : null) : 0;
      resolve({ code, out: String(stdout ?? '') });
    });
  });
}

/** A file's text at HEAD: the text, `null` when HEAD has no such file, `undefined` when there is no usable git history. */
async function headText(root: string, rel: string): Promise<string | null | undefined> {
  const head = await git(root, ['rev-parse', '--verify', '--quiet', 'HEAD']);
  if (head.code !== 0) return undefined;
  const exists = await git(root, ['cat-file', '-e', `HEAD:${rel}`]);
  if (exists.code !== 0) return null;
  const shown = await git(root, ['show', `HEAD:${rel}`]);
  return shown.code === 0 ? shown.out : undefined;
}

// ── Secrets in a diff (the commit gate) ──────────────────────────────

export interface DiffSecret { file: string; line: number; pattern: string; length: number }

/** Added lines per file from a unified diff, with their real line numbers. */
function addedByFile(diff: string): Map<string, Array<{ line: number; text: string }>> {
  const out = new Map<string, Array<{ line: number; text: string }>>();
  let file: string | undefined;
  let next = 0;
  for (const l of diff.split('\n')) {
    const f = /^\+\+\+ (?:b\/)?(.*)$/.exec(l);
    if (f) { file = f[1] === '/dev/null' ? undefined : f[1]!.replace(/\r$/, ''); if (file) out.set(file, out.get(file) ?? []); continue; }
    const h = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(l);
    if (h) { next = Number(h[1]); continue; }
    if (!file) continue;
    if (l.startsWith('+') && !l.startsWith('+++')) { out.get(file)!.push({ line: next, text: l.slice(1).replace(/\r$/, '') }); next++; }
    else if (!l.startsWith('-') && !l.startsWith('\\')) next++;
  }
  return out;
}

/** Secrets in the added lines of a unified diff. Never returns a value: a pattern name and a length. */
export function secretsInUnifiedDiff(diff: string): DiffSecret[] {
  const found: DiffSecret[] = [];
  for (const [file, lines] of addedByFile(diff)) {
    if (!lines.length) continue;
    for (const s of findSecrets(lines.map(x => x.text).join('\n'))) {
      found.push({ file: file.replace(/\\/g, '/'), line: lines[Math.min(s.line - 1, lines.length - 1)]!.line, pattern: s.name, length: s.length });
    }
  }
  return found;
}

/**
 * Secrets a commit made now would add.
 *
 * `staged` looks at the index; `tracked` at every tracked change (`git commit
 * -a`); `worktree` at those plus untracked files, for a command that stages and
 * commits in one line (`git add -A && git commit`). No usable git means nothing
 * is found: a gate must not invent a failure.
 */
export async function secretsInDiff(cwd: string, scope: 'staged' | 'tracked' | 'worktree'): Promise<DiffSecret[]> {
  const base = ['diff', '--no-color', '--unified=0', '--no-ext-diff'];
  const hasHead = (await git(cwd, ['rev-parse', '--verify', '--quiet', 'HEAD'])).code === 0;
  const tracked = scope === 'staged' ? await git(cwd, [...base, '--cached']) : await git(cwd, [...base, ...(hasHead ? ['HEAD'] : ['--cached'])]);
  if (tracked.code !== 0) return [];
  const found = secretsInUnifiedDiff(tracked.out);
  if (scope === 'worktree') {
    const others = await git(cwd, ['ls-files', '--others', '--exclude-standard', '-z']);
    for (const rel of others.out.split('\0').filter(Boolean).slice(0, 200)) {
      const abs = path.resolve(cwd, rel);
      try {
        const st = fs.statSync(abs);
        if (!st.isFile() || st.size > 1024 * 1024) continue;
        const text = fs.readFileSync(abs, 'utf8');
        if (text.slice(0, 8000).includes('\0')) continue;
        for (const s of findSecrets(text)) found.push({ file: rel.replace(/\\/g, '/'), line: s.line, pattern: s.name, length: s.length });
      } catch { /* unreadable: not scanned */ }
    }
  }
  return found;
}

/** The refusal text for a commit that would add secrets: file:line and the pattern, never the value. */
export function describeDiffSecrets(found: readonly DiffSecret[]): string {
  const list = found.slice(0, 5).map(s => `${s.file}:${s.line} (${s.pattern}, ${s.length} chars)`).join('; ');
  return `the change adds what looks like a secret — ${list}${found.length > 5 ? `; and ${found.length - 5} more` : ''}. `
    + 'Remove it from the file (read it from an environment variable or the credential vault), commit again, and tell the person to rotate it if it was ever real. '
    + 'A secret that is committed stays in history.';
}

/** Record each secret a refused commit would have added. */
export function recordRefusedCommit(found: readonly DiffSecret[], sink: FindingSink | undefined): void {
  for (const s of found) {
    emit(sink, { control: 'secret', rule: 'secret', severity: 'high', outcome: 'refused-commit', file: s.file, line: s.line, subject: s.pattern, detail: `${s.pattern}, ${s.length} chars, in a commit` });
  }
}

// ── The turn-end gate ────────────────────────────────────────────────

export interface ChangeSafetyInput {
  root: string;
  /** Every file this turn wrote (`writtenFiles()`). */
  written: readonly string[];
  /** A test check failed at some point this turn (`testCheckFailedThisTurn()`). */
  testFailedEarlier: boolean;
  /** A file's text before this turn touched it (`recordedBefore`); git HEAD is used when this knows nothing. */
  before?: (abs: string) => string | null | undefined;
  /** May this evaluation ask the model to act? False once the turn's nudges are spent: findings are still recorded. */
  nudge: boolean;
  record?: FindingSink | undefined;
  signal?: AbortSignal;
}

export interface ChangeSafetyGate {
  ok: boolean;
  message?: string;
  /** Findings reported for the first time by this call, for tests and the UI line. */
  fresh: number;
}

const fp = (...parts: Array<string | number | undefined>): string => parts.map(p => String(p ?? '')).join('|');

/**
 * May this turn end, as far as the safety of what it changed goes?
 *
 * Silent when nothing was written, when nothing is new since the last call, and
 * for a medium finding (recorded only).
 */
export async function changeSafetyGate(input: ChangeSafetyInput): Promise<ChangeSafetyGate> {
  // A review that cannot run is not a finding, and must never end a turn by throwing.
  try { return await evaluate(input); } catch { return { ok: true, fresh: 0 }; }
}

async function evaluate(input: ChangeSafetyInput): Promise<ChangeSafetyGate> {
  const s = turn.get();
  const root = path.resolve(input.root);
  const inRoot = input.written.map(f => path.resolve(root, f)).filter(f => !path.relative(root, f).startsWith('..'));
  if (inRoot.length === 0 && s.observed.length === 0) return { ok: true, fresh: 0 };

  // An unchanged tree gives the same answer: skip the scan.
  const stamp = inRoot.map(f => { try { return `${f}@${fs.statSync(f).mtimeMs}`; } catch { return `${f}@gone`; } }).sort().join(';') + `#${s.observed.length}`;
  if (stamp === s.signature) return { ok: true, fresh: 0 };
  s.signature = stamp;

  const secrets: Array<{ file: string; line: number; pattern: string; length: number }> = [];
  const high: Array<{ file: string; line: number; rule: string; message: string; fix: string }> = [];
  const medium: Array<{ file: string; line: number; rule: string; message: string }> = [];
  try {
    const scan = await scanWrittenFiles(root, inRoot, input.signal);
    for (const f of scan.findings) {
      if (f.kind === 'secret') secrets.push({ file: f.file, line: f.line, pattern: f.pattern ?? 'secret', length: f.length ?? 0 });
      else if (f.severity === 'high') high.push({ file: f.file, line: f.line, rule: f.rule, message: f.message, fix: f.fix });
      else medium.push({ file: f.file, line: f.line, rule: f.rule, message: f.message });
    }
  } catch { /* a scan that cannot run is not a finding */ }

  const tamper: TamperFinding[] = [...s.observed];
  for (const abs of inRoot) {
    const rel = path.relative(root, abs).replace(/\\/g, '/');
    if (!isTestFile(rel)) continue;
    let after: string | null;
    try { after = fs.readFileSync(abs, 'utf8'); } catch { after = null; }
    let before = input.before?.(abs);
    if (before === undefined) before = await headText(root, rel);
    if (before === undefined) continue; // no baseline: nothing to compare against
    for (const f of compareTest(rel, before, after, { testFailedEarlier: input.testFailedEarlier })) {
      if (!tamper.some(t => t.kind === f.kind && t.file === f.file)) tamper.push(f);
    }
  }

  const lines: string[] = [];
  let fresh = 0;
  let nudgeable = 0;
  const outcome = input.nudge ? 'nudged' as const : 'reported' as const;

  const secretLines: string[] = [];
  for (const x of secrets) {
    const key = fp('secret', x.file, x.pattern, x.length);
    if (s.reported.has(key)) continue;
    s.reported.add(key); fresh++; nudgeable++;
    secretLines.push(`  ${x.file}:${x.line} — looks like a ${x.pattern} (${x.length} chars)`);
    emit(input.record, { control: 'secret', rule: 'secret', severity: 'high', outcome, file: x.file, line: x.line, subject: x.pattern, detail: `${x.pattern}, ${x.length} chars, in code written this turn` });
  }
  if (secretLines.length) {
    lines.push('Secrets in what you wrote. Remove them now: read the value from an environment variable or the credential vault, never put it in a file. If it was ever real, say in your answer that it must be rotated.', ...secretLines);
  }

  const codeLines: string[] = [];
  for (const x of high) {
    const key = fp('sast', x.rule, x.file, x.message);
    if (s.reported.has(key)) continue;
    s.reported.add(key); fresh++; nudgeable++;
    codeLines.push(`  ${x.file}:${x.line} ${x.rule} — ${x.message}. Fix: ${x.fix}`);
    emit(input.record, { control: 'sast', rule: x.rule, severity: 'high', outcome, file: x.file, line: x.line, detail: `${x.message}` });
  }
  if (codeLines.length) {
    lines.push('Unsafe code in what you wrote (high severity):', ...codeLines.slice(0, 12));
    if (codeLines.length > 12) lines.push(`  …and ${codeLines.length - 12} more`);
  }
  for (const x of medium) {
    const key = fp('sast', x.rule, x.file, x.message);
    if (s.reported.has(key)) continue;
    s.reported.add(key); fresh++;
    emit(input.record, { control: 'sast', rule: x.rule, severity: 'medium', outcome: 'reported', file: x.file, line: x.line, detail: x.message });
  }

  const tamperLines: string[] = [];
  for (const t of tamper) {
    const key = fp('tamper', t.kind, t.file);
    if (s.reported.has(key)) continue;
    s.reported.add(key); fresh++; nudgeable++;
    tamperLines.push(`  ${t.detail}`);
    emit(input.record, { control: 'test-tamper', rule: t.kind, severity: t.kind === 'expected-value-changed' || t.kind === 'weak-matcher-added' ? 'medium' : 'high', outcome, file: t.file, ...(t.line ? { line: t.line } : {}), subject: t.file, detail: t.detail });
  }
  if (tamperLines.length) {
    lines.push('Tests that got weaker in this turn. A check is only evidence if the test is allowed to fail. Restore the test as it was and fix the code — or, if changing the test is genuinely right, say why to the person in your final answer so they can review it. Do not edit a test to make a check pass.', ...tamperLines);
  }

  if (!input.nudge || nudgeable === 0) return { ok: true, fresh };
  lines.push('', 'If a code finding is deliberate and safe, say why on that line: `security-allow: <rule> — reason`. If you have deliberately asked for something this rejects, say so once and stop; do not argue the point on every step.');
  return { ok: false, message: `Change-safety review of what you changed this turn:\n${lines.join('\n')}`, fresh };
}
