/**
 * Shared plumbing for the eng-bench tasks whose repositories are generated
 * rather than checked in (large-refactor and the five code-graph tasks:
 * next-alias-impact, py-same-name, go-request-path, ts-py-impact,
 * cochange-fix).
 *
 * Why generated: those tasks are about scale and about look-alikes (same-named
 * functions, path aliases, barrels, decoy packages). A checked-in fixture of
 * 150–250 near-identical files is unreviewable, and a fixture, its reference
 * solution and its grader's "must stay untouched" list drift apart the moment
 * one is edited by hand. Generating all three from one seeded description
 * keeps them in agreement, and makes every run start from byte-identical
 * files (and, for cochange-fix, an identical git history with fixed dates, so
 * identical commit ids).
 *
 * What it deliberately does not do: grade. Each task's grader owns its
 * checks; this module only writes trees, links the project's toolchain, and
 * gives the deterministic randomness and git plumbing every generator needs.
 */
import { spawnSync } from 'child_process';
import { runNodeTests, sh } from './util.mjs';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';

/** A seeded linear congruential generator: same seed, same fixture, every run. */
export function lcg(seed) {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 2 ** 32; };
}

export const pad = (n, w = 3) => String(n).padStart(w, '0');

/** Pick one element with a generator from `lcg`. */
export const pick = (rand, list) => list[Math.floor(rand() * list.length)];

/** Write a `Map<relativePath, text>` under `root`. */
export function writeTree(root, files) {
  for (const [rel, text] of files) {
    const file = path.join(root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  }
}

/** Read a project file, or null when it is not there. */
export function readRel(project, rel) {
  try { return fs.readFileSync(path.join(project, rel), 'utf8'); } catch { return null; }
}

export const sha = (text) => crypto.createHash('sha256').update(text).digest('hex');

/**
 * Files of `expected` (a Map) whose bytes on disk differ, or that are gone.
 * CRLF is not forgiven: the fixture is LF and a whole-file rewrite to CRLF is
 * a change a reviewer would see.
 */
export function changedFrom(project, expected, rels) {
  return rels.filter((rel) => {
    const now = readRel(project, rel);
    return now === null || sha(now) !== sha(expected.get(rel));
  });
}

/** Link AICO's own `typescript` into the project, as a real project would have it installed (no network). */
export function linkTypeScript(project, sub = '') {
  const ts = path.dirname(createRequire(import.meta.url).resolve('typescript/package.json'));
  const nm = path.join(project, sub, 'node_modules');
  fs.mkdirSync(nm, { recursive: true });
  fs.symlinkSync(ts, path.join(nm, 'typescript'), 'junction');
}

/**
 * A Node module-resolution hook for the `@/` path alias and extensionless
 * relative imports, the way Next.js or Vite projects write imports. tsc emits
 * them unchanged and plain Node cannot resolve them; a real project would use
 * a bundler or `tsx`, this repository carries the twenty lines instead so it
 * needs no network install. `ALIAS_BUILD` picks the compiled tree (the grader
 * compiles into a directory of its own).
 */
export const ALIAS_LOADER = `// Resolves the \`@/\` alias and extensionless imports in compiled output (see tsconfig paths).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)), process.env.ALIAS_BUILD ?? 'build');
const SRC = process.env.ALIAS_SRC ?? 'src';

function firstFile(base) {
  for (const c of [base, base + '.js', path.join(base, 'index.js')]) {
    try { if (fs.statSync(c).isFile()) return c; } catch { /* try the next form */ }
  }
  return null;
}

export async function resolve(specifier, context, next) {
  let base = null;
  if (specifier.startsWith('@/')) base = path.join(root, SRC, specifier.slice(2));
  else if ((specifier.startsWith('./') || specifier.startsWith('../')) && context.parentURL?.startsWith('file:')) {
    base = path.resolve(path.dirname(fileURLToPath(context.parentURL)), specifier);
  }
  const file = base && firstFile(base);
  if (file) return { url: pathToFileURL(file).href, shortCircuit: true };
  return next(specifier, context);
}
`;

export const ALIAS_REGISTER = `import { register } from 'node:module';

register('./alias-loader.mjs', import.meta.url);
`;

/** The Python on PATH the agent and the graders use (`python`, else `py -3`). */
export function pythonCommand() {
  for (const cmd of ['python', 'python3']) {
    const r = spawnSync(cmd, ['--version'], { encoding: 'utf8', windowsHide: true });
    if (r.status === 0 && /Python 3\.(1[0-9])/.test(`${r.stdout}${r.stderr}`)) return cmd;
  }
  return process.platform === 'win32' ? 'py -3' : 'python3';
}

/** The `go` binary, or null when no Go toolchain is installed. */
export function goCommand() {
  const r = spawnSync('go', ['version'], { encoding: 'utf8', windowsHide: true });
  return r.status === 0 ? 'go' : null;
}

/**
 * Git with a fixed identity, fixed dates and no autocrlf, so a generated
 * history has the same commit ids on every machine and every run.
 */
export function git(dir, args, { date } = {}) {
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1' };
  if (date) Object.assign(env, { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date });
  Object.assign(env, { GIT_AUTHOR_NAME: 'Fixture Author', GIT_AUTHOR_EMAIL: 'dev@example.com', GIT_COMMITTER_NAME: 'Fixture Author', GIT_COMMITTER_EMAIL: 'dev@example.com' });
  const r = spawnSync('git', ['-c', 'core.autocrlf=false', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=', ...args], { cwd: dir, encoding: 'utf8', windowsHide: true, env });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout.trim();
}

/** A fresh repository whose only commit is the whole tree, with a fixed date. */
export function gitInitFixed(dir, message = 'Initial import', date = '2026-06-01T09:00:00Z') {
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'core.autocrlf', 'false']);
  git(dir, ['config', 'user.email', 'dev@example.com']);
  git(dir, ['config', 'user.name', 'Fixture Author']);
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', message], { date });
}

/** Environment for every Python the graders run: no bytecode in the project, UTF-8 output. */
export const PY_ENV = { PYTHONDONTWRITEBYTECODE: '1', PYTHONIOENCODING: 'utf-8' };

/** Run a unittest file verbosely and read `name ... ok|FAIL|ERROR` lines. */
export function runPyHidden(project, source, meta, { name = 'hidden.py', pythonPath = '.' } = {}) {
  const hid = path.join(project, '.bench-hidden');
  fs.rmSync(hid, { recursive: true, force: true });
  fs.mkdirSync(hid, { recursive: true });
  fs.copyFileSync(source, path.join(hid, name));
  fs.writeFileSync(path.join(hid, 'meta.json'), JSON.stringify(meta));
  const r = sh(`${pythonCommand()} .bench-hidden/${name} -v`, {
    cwd: project, timeoutMs: 180_000,
    env: { ...PY_ENV, PYTHONPATH: path.resolve(project, pythonPath), BENCH_META: path.join(hid, 'meta.json') },
  });
  fs.rmSync(hid, { recursive: true, force: true });
  const text = `${r.out}\n${r.err}`;
  const results = {};
  for (const m of text.matchAll(/^(test_\w+) \([^)]*\)[^\n]*?\.\.\. (ok|FAIL|ERROR)/gm)) results[m[1]] = m[2] === 'ok';
  return { results, text };
}

/** First assertion message of a failed unittest, for the check's detail. */
export const failureDetail = (text, test) => (text.split(`: ${test} (`)[1] ?? '').split('\n').find((l) => /Error:|AssertionError/.test(l))?.slice(0, 300) ?? '';

/**
 * Compile a TypeScript project (`root`, using `@/` aliases) into the grader's
 * own `.bench-build`, run one hidden `node --test` file against it with the
 * alias loader, and clean up. The agent's own build output and loader are
 * never used, so editing them cannot change the grade.
 */
export function runTsHidden(root, source, meta) {
  const out = path.join(root, '.bench-build');
  const hid = path.join(root, '.bench-hidden');
  fs.rmSync(out, { recursive: true, force: true });
  fs.rmSync(hid, { recursive: true, force: true });
  const built = sh('node node_modules/typescript/bin/tsc -p tsconfig.json --outDir .bench-build', { cwd: root, timeoutMs: 180_000 });
  fs.mkdirSync(hid, { recursive: true });
  fs.writeFileSync(path.join(hid, 'alias-loader.mjs'), ALIAS_LOADER);
  fs.writeFileSync(path.join(hid, 'register.mjs'), ALIAS_REGISTER);
  const name = path.basename(source);
  fs.copyFileSync(source, path.join(hid, name));
  const r = built.code === 0
    ? runNodeTests([`.bench-hidden/${name}`], { cwd: root, timeoutMs: 120_000, env: { BENCH_META: JSON.stringify(meta), ALIAS_BUILD: '.bench-build', NODE_OPTIONS: '--import ./.bench-hidden/register.mjs' } })
    : { tests: [], raw: built.out };
  fs.rmSync(out, { recursive: true, force: true });
  fs.rmSync(hid, { recursive: true, force: true });
  return { built, r };
}

/** Check each expected hidden `node --test` result by name. */
export function checkTsHidden(check, { built, r }, names) {
  for (const name of names) {
    const t = r.tests.find((x) => x.name === `hidden: ${name}`);
    const why = t ? '' : (built.code !== 0 ? `project does not compile: ${built.out.split('\n').slice(0, 3).join(' | ')}` : 'not reported');
    check(`hidden: ${name}`, t?.ok === true, why || (t.ok ? '' : (r.raw.split(`hidden: ${name}`)[1] ?? '').match(/error: '([^']*)'/)?.[1] ?? ''));
  }
}

/** Directories graders and agents ignore: tool output, caches, build trees. */
export const IGNORE_DIRS = ['node_modules', 'build', '.bench-build', '.bench-hidden', '__pycache__', '.buruj-lens', 'graphify-out', '.venv'];

/** The `.gitignore` every generated task ships with (the graph arms' index folders included, identically in every arm). */
export const GITIGNORE = `${IGNORE_DIRS.join('\n')}\n*.pyc\n`;

/**
 * Brace-matched body of the first `func`/`function` whose header matches
 * `header` (a RegExp), or null. Good enough for generated code and for the
 * edits an agent makes to it: string and comment braces are not special-cased.
 */
export function bodyOf(text, header) {
  const m = header.exec(text);
  if (!m) return null;
  const open = text.indexOf('{', m.index + m[0].length - 1);
  if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}' && --depth === 0) return text.slice(open + 1, i);
  }
  return null;
}
