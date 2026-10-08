/**
 * The `security` check: shift-left for the code AICO writes for people.
 *
 * The completion gate already refuses "done" while a project's own typecheck
 * or tests are red (checks.ts). Nothing refused a turn that hard-coded an API
 * key into a config file, built a SQL query by string interpolation, or turned
 * TLS verification off to make an error go away — all things a model does
 * when it is optimising for "the error went away". Asking in the prompt holds
 * until the model is confident; this is checked in the loop instead
 * (AGENTS.md §4.6), as one more check RunChecks runs and the gate reads.
 *
 * What runs, on the files this turn wrote:
 *   - **secrets** in the added lines (or the whole file when there is no git
 *     history to diff against): the same high-confidence shapes the
 *     repository's own pre-push hook refuses (shared/security/rules.mjs).
 *   - **code rules** for JS/TS, Python, Go, Java, PHP and C# — command and SQL
 *     injection, eval, TLS off, unsanitised HTML, hard-coded credentials, unsafe
 *     deserialisation, weak password hashes, weak randomness for secrets, secrets
 *     in logs. Only findings on lines this turn added count, so a model is never
 *     blocked by code it did not write.
 *   - **dependency audit** when a manifest or lockfile changed, through the
 *     ecosystem's own auditor (tools/dependency-audit.ts). New high/critical
 *     advisories fail; a missing auditor is a note, not a failure.
 *   - **semgrep / bandit / gosec** only when already installed on PATH (and
 *     semgrep only with the project's own config: `--config auto` would fetch
 *     rules and send metrics). Never installed, never required.
 *
 * Fails on secrets and high-severity findings; medium ones are reported and
 * pass, because a gate that blocks on a heuristic is a gate people disable.
 * A line is waived with `security-allow: <rule> — reason`, which the report
 * tells the model, so a deliberate choice is stated rather than argued.
 *
 * Deliberately not here: a taint engine or anything that downloads. Those are
 * CodeQL's and the user's CI's job; this is the cheap net that runs every turn.
 *
 * {@link scanWrittenFiles} is the structured half (secrets + code rules on added
 * lines), shared with the turn-end change-safety gate (`change-safety.ts`,
 * ADR 0033), which runs it even in a project that defines no other checks.
 *
 * @module security/project-scan
 */

import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { scanCode, findSecrets, languageOf, type CodeFinding } from '../../shared/security/rules.mjs';
import { auditOne, detectEcosystems } from '../tools/dependency-audit.js';

export interface SecurityCheckResult {
  passed: boolean;
  /** The report RunChecks shows and the gate quotes. */
  output: string;
  counts: { secrets: number; high: number; medium: number; advisories: number };
}

const MANIFEST = /(?:^|[\\/])(?:package(?:-lock)?\.json|pnpm-lock\.yaml|yarn\.lock|requirements[^\\/]*\.txt|pyproject\.toml|poetry\.lock|Pipfile(?:\.lock)?|Cargo\.(?:toml|lock)|go\.(?:mod|sum)|[^\\/]+\.(?:csproj|fsproj|vbproj)|packages\.lock\.json|pom\.xml|build\.gradle(?:\.kts)?|gradle\.lockfile|composer\.(?:json|lock))$/i;
/** Source in languages the code rules do not cover (Kotlin, Ruby): said aloud, never silently passed. */
const UNCOVERED = /\.(?:kt|kts|rb)$/i;
const SKIP = /[\\/](?:node_modules|\.git|dist|build|\.next|coverage|vendor|\.venv|venv|__pycache__|target|obj|\.gradle)[\\/]/;
const MAX_FILE = 2 * 1024 * 1024;

function run(cmd: string, args: string[], cwd: string, timeoutMs: number, signal?: AbortSignal): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise(resolve => {
    execFile(cmd, args, { cwd, timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, windowsHide: true, signal }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : null) : 0;
      resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
    });
  });
}

/**
 * Lines this turn added, per file, from `git diff` against HEAD. `null` for a
 * file git does not track yet (all of it is new) or when there is no git.
 */
async function addedLines(root: string, files: string[], signal?: AbortSignal): Promise<Map<string, Set<number> | null>> {
  const out = new Map<string, Set<number> | null>(files.map(f => [f, null]));
  const head = await run('git', ['rev-parse', '--verify', '--quiet', 'HEAD'], root, 10_000, signal);
  if (head.code !== 0) return out;
  const tracked = await run('git', ['ls-files', '-z', '--', ...files.map(f => path.relative(root, f))], root, 20_000, signal);
  const trackedSet = new Set(tracked.stdout.split('\0').filter(Boolean).map(f => path.resolve(root, f)));
  const diff = await run('git', ['diff', '--no-color', '--unified=0', 'HEAD', '--', ...files.filter(f => trackedSet.has(f)).map(f => path.relative(root, f))], root, 30_000, signal);
  if (diff.code !== 0) return out;
  for (const f of trackedSet) out.set(f, new Set());
  let current: Set<number> | undefined;
  for (const line of diff.stdout.split('\n')) {
    const file = /^\+\+\+ b\/(.*)$/.exec(line);
    if (file) { current = out.get(path.resolve(root, file[1]!)) ?? undefined; continue; }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (hunk && current) {
      const start = Number(hunk[1]); const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
      for (let i = 0; i < count; i++) current.add(start + i);
    }
  }
  return out;
}

async function onPath(cmd: string, root: string): Promise<boolean> {
  const r = await run(cmd, ['--version'], root, 10_000);
  return r.code === 0;
}

/** Optional external scanners, only when the person already has them. */
async function externalScanners(root: string, files: string[], signal?: AbortSignal): Promise<{ lines: string[]; high: number }> {
  const lines: string[] = [];
  let high = 0;
  const py = files.filter(f => /\.py$/i.test(f));
  if (py.length && await onPath('bandit', root)) {
    const r = await run('bandit', ['-q', '-f', 'json', '-ll', ...py], root, 120_000, signal);
    try {
      const results = (JSON.parse(r.stdout) as { results?: Array<{ issue_severity: string; issue_confidence: string; filename: string; line_number: number; test_id: string; issue_text: string }> }).results ?? [];
      for (const x of results.slice(0, 20)) {
        const isHigh = x.issue_severity === 'HIGH' && x.issue_confidence !== 'LOW';
        if (isHigh) high++;
        lines.push(`  ${isHigh ? 'HIGH ' : 'warn '} bandit ${x.test_id} ${path.relative(root, x.filename)}:${x.line_number} — ${x.issue_text}`);
      }
    } catch { lines.push('  note  bandit ran but its output could not be read'); }
  }
  const goDirs = [...new Set(files.filter(f => /\.go$/i.test(f)).map(f => path.dirname(f)))];
  if (goDirs.length && await onPath('gosec', root)) {
    const r = await run('gosec', ['-fmt', 'json', '-quiet', ...goDirs.map(d => `./${path.relative(root, d).replace(/\\/g, '/') || '.'}`)], root, 180_000, signal);
    try {
      const issues = (JSON.parse(r.stdout) as { Issues?: Array<{ severity: string; confidence: string; file: string; line: string; rule_id: string; details: string }> }).Issues ?? [];
      for (const x of issues.slice(0, 20)) {
        const isHigh = x.severity === 'HIGH' && x.confidence !== 'LOW';
        if (isHigh) high++;
        lines.push(`  ${isHigh ? 'HIGH ' : 'warn '} gosec ${x.rule_id} ${path.relative(root, x.file)}:${x.line} — ${x.details}`);
      }
    } catch { lines.push('  note  gosec ran but its output could not be read'); }
  }
  const semgrepConfig = ['.semgrep.yml', '.semgrep.yaml', '.semgrep'].find(c => fs.existsSync(path.join(root, c)));
  if (semgrepConfig && await onPath('semgrep', root)) {
    const r = await run('semgrep', ['scan', '--config', semgrepConfig, '--metrics=off', '--json', '--quiet', ...files.map(f => path.relative(root, f))], root, 180_000, signal);
    try {
      const results = (JSON.parse(r.stdout) as { results?: Array<{ check_id: string; path: string; start: { line: number }; extra: { severity: string; message: string } }> }).results ?? [];
      for (const x of results.slice(0, 20)) {
        const isHigh = x.extra.severity === 'ERROR';
        if (isHigh) high++;
        lines.push(`  ${isHigh ? 'HIGH ' : 'warn '} semgrep ${x.check_id} ${x.path}:${x.start.line} — ${x.extra.message.split('\n')[0]}`);
      }
    } catch { lines.push('  note  semgrep ran but its output could not be read'); }
  }
  return { lines, high };
}

/** One thing the scan found on a line this turn added. */
export interface ScanFinding {
  kind: 'secret' | 'code';
  /** `secret` for a secret, else the code rule's id. */
  rule: string;
  severity: 'high' | 'medium';
  /** Project-relative, forward slashes. */
  file: string;
  line: number;
  /** For a secret: what it looks like (the pattern name and length — never the value). */
  message: string;
  fix: string;
  /** A secret's pattern name, for the evidence record. */
  pattern?: string;
  length?: number;
}

/**
 * Secrets and code-rule findings on the lines this turn added, per file written.
 *
 * Structured on purpose: `securityCheck` formats it as a report, the turn-end
 * change-safety gate nudges from it and records it. `files` are the absolute
 * paths actually scanned (inside the project, not vendored, readable, text).
 */
export async function scanWrittenFiles(root: string, written: readonly string[], signal?: AbortSignal): Promise<{ files: string[]; findings: ScanFinding[] }> {
  const files = [...new Set(written.map(f => path.resolve(root, f)))]
    .filter(f => !SKIP.test(f) && path.relative(root, f) && !path.relative(root, f).startsWith('..'))
    .filter(f => { try { const s = fs.statSync(f); return s.isFile() && s.size <= MAX_FILE; } catch { return false; } });
  const added = await addedLines(root, files, signal);
  const findings: ScanFinding[] = [];
  for (const file of files) {
    let text: string;
    try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
    if (text.slice(0, 8000).includes('\0')) continue;
    const rel = path.relative(root, file).replace(/\\/g, '/');
    const lines = added.get(file);
    const counts_ = (line: number): boolean => lines == null || lines.has(line);
    for (const s of findSecrets(text)) {
      if (!counts_(s.line)) continue;
      findings.push({
        kind: 'secret', rule: 'secret', severity: 'high', file: rel, line: s.line,
        message: `looks like a ${s.name} (${s.preview}, ${s.length} chars)`,
        fix: 'Move it to an environment variable or the credential vault; never commit it.',
        pattern: s.name, length: s.length,
      });
    }
    if (!languageOf(file)) continue;
    for (const f of scanCode(rel, text).filter(x => counts_(x.line))) {
      findings.push({ kind: 'code', rule: f.rule, severity: f.severity === 'high' ? 'high' : 'medium', file: rel, line: f.line, message: f.message, fix: f.fix });
    }
  }
  return { files, findings };
}

/**
 * Run the security check over the files a turn wrote.
 *
 * @param root  the project root (where manifests and git live)
 * @param written  files this turn wrote, absolute or relative to root
 */
export async function securityCheck(root: string, written: readonly string[], opts: { signal?: AbortSignal; external?: boolean } = {}): Promise<SecurityCheckResult> {
  const { files, findings } = await scanWrittenFiles(root, written, opts.signal);
  const report: string[] = [];
  const counts = { secrets: 0, high: 0, medium: 0, advisories: 0 };

  for (const f of findings) {
    if (f.kind === 'secret') {
      counts.secrets++;
      report.push(`  HIGH  secret ${f.file}:${f.line} — ${f.message}. ${f.fix}`);
    } else {
      if (f.severity === 'high') counts.high++; else counts.medium++;
      report.push(`  ${f.severity === 'high' ? 'HIGH ' : 'warn '} ${f.rule} ${f.file}:${f.line} — ${f.message}. Fix: ${f.fix}`);
    }
  }

  // Dependencies, when this turn changed what the project depends on.
  if (files.some(f => MANIFEST.test(f))) {
    for (const eco of detectEcosystems(root)) {
      try {
        const audit = await auditOne(eco, root, opts.signal);
        const serious = audit.advisories.filter(a => a.severity === 'critical' || a.severity === 'high');
        counts.advisories += serious.length;
        for (const a of serious.slice(0, 10)) {
          report.push(`  HIGH  dependency ${a.pkg}${a.version ? '@' + a.version : ''} — ${a.severity}: ${a.title} (${a.id})${a.fix ? `; fixed in ${a.fix}` : ''}`);
        }
        if (audit.status !== 'ok' && audit.message) report.push(`  note  ${eco} audit (${audit.status}): ${audit.message}`);
      } catch (err) {
        report.push(`  note  ${eco} audit could not run: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  // Honest coverage: the rules are language-scoped. Kotlin and Ruby files get the secret scan and the
  // dependency audit, but no code rules, and a clean pass must not read as "reviewed".
  const uncovered = files.filter(f => UNCOVERED.test(f));
  const notes: string[] = [];
  if (uncovered.length) {
    notes.push(`  note  ${uncovered.length} Kotlin/Ruby file(s) written: secrets and dependencies were checked, but there are no code rules for those languages here. Rely on the project's own analysis (detekt, RuboCop/Brakeman) and CodeQL.`);
  }

  if (opts.external !== false && files.length) {
    const ext = await externalScanners(root, files, opts.signal);
    counts.high += ext.high;
    report.push(...ext.lines);
  }

  const passed = counts.secrets === 0 && counts.high === 0 && counts.advisories === 0;
  const head = passed
    ? `security: ${files.length} file(s) checked; no secrets or high-severity findings${counts.medium ? `, ${counts.medium} warning(s)` : ''}.`
    : `security: ${counts.secrets} secret(s), ${counts.high} high-severity finding(s), ${counts.advisories} high/critical advisory(ies) in what this turn wrote.`;
  const tail = report.length
    ? '\nIf a finding is deliberate and safe, say why on that line: `security-allow: <rule> — reason`.'
    : '';
  return { passed, output: [head, ...report.slice(0, 40), ...notes].join('\n') + tail, counts };
}
