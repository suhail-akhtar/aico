/**
 * Structural search and rewrite through ast-grep.
 *
 * ## Why ast-grep
 *
 * `Grep` matches text, so "every call to `formatPrice` with one argument"
 * also matches a comment, a string, `formatPriceRange(` and a call split over
 * three lines it then fails to see. ast-grep matches syntax trees with a
 * pattern written as code (`formatPrice($A)`), across ~25 languages, from a
 * prebuilt binary — the shape of tool a bulk mechanical change needs and
 * `Edit` is not. The dependency decision is ADR 0013.
 *
 * ## How it is found
 *
 * The project's own install first (its version is the one its team chose),
 * then AICO's (`@ast-grep/cli` is an optional dependency), then `ast-grep` on
 * PATH. Never `sg`: on Linux that name is shadow-utils' `sg`, a different
 * program entirely. When none is found the tool says how to install it rather
 * than failing obscurely.
 *
 * ## The rewrite is computed here, not by `--update-all`
 *
 * ast-grep reports each match's replacement and byte range as JSON; the new
 * file text is built from that in memory. So the dry run and the apply are the
 * same computation, the apply goes through the run's file writer, checkpoint
 * and write-scope rules like every other write, and nothing lands on disk
 * until the plan has been shown (`refactor/plan`).
 *
 * @module refactor/ast-grep
 */

import { execFile } from 'child_process';
import { existsSync } from 'fs';
import { readFile } from 'fs/promises';
import { createRequire } from 'module';
import path from 'path';
import { dominantEol, toEol } from '../tools/eol.js';
import type { FileChange } from './plan.js';

/** One match, as `ast-grep run --json` reports it (the fields used here). */
interface SgMatch {
  file: string;
  text: string;
  lines: string;
  range: { byteOffset: { start: number; end: number }; start: { line: number; column: number } };
  replacement?: string;
  replacementOffsets?: { start: number; end: number };
}

const EXE = process.platform === 'win32' ? 'ast-grep.exe' : 'ast-grep';

const found = new Map<string, string | null>();

function runFile(bin: string, args: string[], opts: { cwd: string; signal?: AbortSignal; timeoutMs?: number }): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(bin, args, {
      cwd: opts.cwd, maxBuffer: 256 * 1024 * 1024, windowsHide: true,
      timeout: opts.timeoutMs ?? 120_000, ...(opts.signal ? { signal: opts.signal } : {}),
    }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : -1) : 0;
      resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') || (err && code === -1 ? err.message : '') });
    });
  });
}

/** Where `@ast-grep/cli` puts its binary inside a package directory. */
function binaryIn(pkgDir: string): string | undefined {
  const candidate = path.join(pkgDir, EXE);
  return existsSync(candidate) ? candidate : undefined;
}

/** The ast-grep binary for `root`, or null with nothing found. Cached per root. */
export async function findAstGrep(root: string): Promise<string | null> {
  const cached = found.get(root);
  if (cached !== undefined) return cached;
  const candidates: string[] = [];
  const projectPkg = path.join(root, 'node_modules', '@ast-grep', 'cli');
  const own = binaryIn(projectPkg);
  if (own) candidates.push(own);
  try {
    const mine = path.dirname(createRequire(import.meta.url).resolve('@ast-grep/cli/package.json'));
    const bin = binaryIn(mine);
    if (bin) candidates.push(bin);
  } catch { /* not installed with AICO (optional dependency): try PATH */ }
  candidates.push('ast-grep');
  for (const bin of candidates) {
    const probe = await runFile(bin, ['--version'], { cwd: root, timeoutMs: 15_000 });
    if (probe.code === 0 && /ast-grep/i.test(probe.stdout)) {
      found.set(root, bin);
      return bin;
    }
  }
  found.set(root, null);
  return null;
}

export const AST_GREP_MISSING =
  'ast-grep is not available here: it was not found in this project\'s node_modules, in AICO\'s own install '
  + '(@ast-grep/cli is an optional dependency and may have been skipped), or on PATH as "ast-grep". '
  + 'Install it with `npm i -D @ast-grep/cli` in the project (or `brew install ast-grep` / `cargo install ast-grep --locked`). '
  + 'Until then use Grep to find sites and Edit to change them — or, for TypeScript/JavaScript, the Refactor tool, which does not need ast-grep.';

export interface SgQuery {
  pattern: string;
  lang: string;
  /** Paths relative to `root` (already validated by the caller). Default: the whole root. */
  paths: string[];
  rewrite?: string;
  root: string;
  signal?: AbortSignal;
}

async function query(q: SgQuery): Promise<{ matches: SgMatch[]; warning?: string }> {
  const bin = await findAstGrep(q.root);
  if (!bin) throw new Error(AST_GREP_MISSING);
  const args = ['run', '--pattern', q.pattern, '--lang', q.lang, '--json=compact'];
  if (q.rewrite !== undefined) args.push('--rewrite', q.rewrite);
  args.push('--', ...(q.paths.length ? q.paths : ['.']));
  const r = await runFile(bin, args, { cwd: q.root, ...(q.signal ? { signal: q.signal } : {}) });
  // 1 is "no match", which is an answer; anything else non-zero is a refusal.
  if (r.code !== 0 && r.code !== 1) {
    throw new Error(`ast-grep refused the query: ${(r.stderr || r.stdout).trim().split('\n').slice(0, 6).join(' ')}`);
  }
  let matches: SgMatch[] = [];
  try { matches = JSON.parse(r.stdout || '[]') as SgMatch[]; } catch {
    throw new Error(`ast-grep returned output that is not JSON: ${r.stdout.slice(0, 200)}`);
  }
  const warning = r.stderr.trim() ? r.stderr.trim().split('\n').slice(0, 3).join(' ') : undefined;
  return { matches, ...(warning ? { warning } : {}) };
}

/** Matches, grouped and capped, as the model reads them. */
export async function codeSearch(q: Omit<SgQuery, 'rewrite'>, maxMatches = 200): Promise<string> {
  const { matches, warning } = await query(q);
  if (matches.length === 0) {
    return `No match for ${q.lang} pattern \`${q.pattern}\`.` + (warning ? `\nast-grep: ${warning}` : '')
      + '\nA pattern is code with $NAME for one node and $$$ for many, e.g. `formatPrice($A)` or `import { $$$ } from "./money"`.';
  }
  const files = new Set(matches.map(m => m.file));
  const lines = [`${matches.length} match(es) in ${files.size} file(s) for \`${q.pattern}\`:`];
  for (const m of matches.slice(0, maxMatches)) {
    lines.push(`${m.file.split(path.sep).join('/')}:${m.range.start.line + 1}: ${m.lines.trim().slice(0, 200)}`);
  }
  if (matches.length > maxMatches) lines.push(`… ${matches.length - maxMatches} more — narrow the pattern or the paths.`);
  if (warning) lines.push(`ast-grep: ${warning}`);
  return lines.join('\n');
}

/**
 * The changes a rewrite would make, file by file.
 *
 * Replacements are spliced into each file's bytes from the end backwards, so
 * earlier offsets stay valid; an overlapping match (ast-grep can report a node
 * inside a node it already rewrote) is skipped and counted, never half-applied.
 * A replacement spanning lines takes the file's own line endings.
 */
export async function rewriteChanges(q: SgQuery & { rewrite: string }): Promise<{ changes: FileChange[]; notes: string[] }> {
  const { matches, warning } = await query(q);
  const byFile = new Map<string, SgMatch[]>();
  for (const m of matches) {
    if (m.replacement === undefined) continue;
    const list = byFile.get(m.file) ?? [];
    list.push(m);
    byFile.set(m.file, list);
  }
  const changes: FileChange[] = [];
  let overlapped = 0;
  for (const [file, list] of byFile) {
    const abs = path.resolve(q.root, file);
    const before = await readFile(abs, 'utf8');
    const eol = dominantEol(before);
    let bytes = Buffer.from(before, 'utf8');
    const ordered = list
      .map(m => ({ m, start: m.replacementOffsets?.start ?? m.range.byteOffset.start, end: m.replacementOffsets?.end ?? m.range.byteOffset.end }))
      .sort((a, b) => b.start - a.start);
    let floor = Infinity;
    let edits = 0;
    for (const { m, start, end } of ordered) {
      if (end > floor) { overlapped++; continue; }
      bytes = Buffer.concat([bytes.subarray(0, start), Buffer.from(toEol(m.replacement!, eol), 'utf8'), bytes.subarray(end)]);
      floor = start;
      edits++;
    }
    changes.push({ file: abs, before, after: bytes.toString('utf8'), edits });
  }
  const notes: string[] = [];
  if (overlapped) notes.push(`${overlapped} nested match(es) skipped — they sat inside a match already rewritten. Run the rewrite again after applying to reach them.`);
  if (warning) notes.push(`ast-grep: ${warning}`);
  return { changes, notes };
}

/** For tests: forget which binary was found. */
export function resetAstGrepCache(): void {
  found.clear();
}
