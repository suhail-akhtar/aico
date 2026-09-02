/**
 * Tasks with known answers, for the four skills that ship.
 *
 * Small on purpose. SkillOpt's benchmarks are hundreds of tasks; ours are a
 * handful per skill, because every task costs a model run per optimisation
 * step and this is meant to be run by a person, on their own account, on
 * purpose. What matters is that each task plants something specific and checks
 * for exactly that — a score here means "named the injection in db.js", never
 * "sounded thorough".
 *
 * ## Where user tasks go
 *
 * `~/.aico/skill-evals/<skill>/*.json`, one `EvalTask` per file, merged with the
 * built-ins. A user who has been burned by a particular class of mistake can
 * plant it and let the optimiser train against it — which is the whole point of
 * the loop existing outside the shipped corpus.
 *
 * @module skills/eval/corpus
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import type { EvalTask } from './types.js';

const NOT_FILLER = {
  kind: 'output-lacks' as const,
  pattern: String.raw`\b(as an ai|i cannot|i can't help|apologi[sz]e)\b`,
  why: 'The reply hedged or refused instead of doing the audit.',
};

const UNCHANGED = {
  kind: 'no-file-changed' as const,
  weight: 2,
  why: 'The skill edited the code it was asked to review. A review changes nothing.',
};

// ── security-review ───────────────────────────────────────────────────

const SEC_1: EvalTask = {
  id: 'security-review/sqli-and-secret',
  skill: 'security-review',
  split: 'val',
  args: '',
  files: {
    'package.json': '{ "name": "shop", "version": "1.0.0", "dependencies": { "express": "^4.18.0", "pg": "^8.11.0" } }\n',
    'src/db.js': [
      "const { Pool } = require('pg');",
      'const pool = new Pool();',
      '',
      'async function findUser(req, res) {',
      '  const id = req.query.id;',
      "  const rows = await pool.query(\"SELECT * FROM users WHERE id = '\" + id + \"'\");",
      '  res.json(rows.rows);',
      '}',
      '',
      'module.exports = { findUser };',
      '',
    ].join('\n'),
    'src/config.js': [
      'module.exports = {',
      "  awsAccessKeyId: 'AKIAIOSFODNN7EXAMPLE',",
      "  awsSecretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',",
      '  region: "us-east-1",',
      '};',
      '',
    ].join('\n'),
  },
  checks: [
    { kind: 'output-matches', pattern: String.raw`db\.js`, why: 'The SQL injection in src/db.js was not located.' },
    { kind: 'output-matches', pattern: String.raw`sql\s*injection|injection`, why: 'String-concatenated SQL was not named as injection.' },
    { kind: 'output-matches', pattern: String.raw`config\.js`, why: 'The file holding hard-coded AWS credentials was not located.' },
    { kind: 'output-matches', pattern: String.raw`hard-?coded|secret|credential`, why: 'The committed AWS keys were not called out.' },
    { kind: 'output-matches', pattern: String.raw`\b(critical|high)\b`, why: 'No severity was assigned; the skill promises severity scoring.' },
    UNCHANGED,
    NOT_FILLER,
    { kind: 'max-tool-calls', limit: 20, why: 'Three files should not take more than twenty tool calls to audit.' },
  ],
};

const SEC_2: EvalTask = {
  id: 'security-review/eval-and-shell',
  skill: 'security-review',
  split: 'train',
  args: 'src/',
  files: {
    'requirements.txt': 'flask==3.0.0\n',
    'src/app.py': [
      'from flask import Flask, request',
      'import subprocess',
      '',
      'app = Flask(__name__)',
      '',
      "@app.route('/calc')",
      'def calc():',
      "    expr = request.args.get('expr', '')",
      '    return str(eval(expr))',
      '',
      "@app.route('/ping')",
      'def ping():',
      "    host = request.args.get('host', '')",
      "    out = subprocess.check_output('ping -c 1 ' + host, shell=True)",
      '    return out',
      '',
    ].join('\n'),
    'src/util.py': 'def add(a, b):\n    return a + b\n',
  },
  checks: [
    { kind: 'output-matches', pattern: String.raw`\beval\b`, why: 'eval() on request input was not reported.' },
    { kind: 'output-matches', pattern: String.raw`command\s*injection|shell=True|os command`, why: 'shell=True with user input was not named as command injection.' },
    { kind: 'output-matches', pattern: String.raw`app\.py`, why: 'Findings were not tied to the file they are in.' },
    { kind: 'output-lacks', pattern: String.raw`util\.py[^\n]*(vulnerab|injection|critical)`, why: 'A clean file was reported as vulnerable — a false positive.' },
    UNCHANGED,
    NOT_FILLER,
    { kind: 'max-tool-calls', limit: 20, why: 'Two files should not take more than twenty tool calls to audit.' },
  ],
};

// ── review ────────────────────────────────────────────────────────────

const REV_1: EvalTask = {
  id: 'review/off-by-one-and-null',
  skill: 'review',
  split: 'train',
  args: 'src/pager.ts',
  files: {
    'src/pager.ts': [
      'export interface Page<T> { items: T[]; next?: number }',
      '',
      'export function pageOf<T>(all: T[], size: number, index: number): Page<T> {',
      '  const start = index * size;',
      '  const items: T[] = [];',
      '  for (let i = start; i <= start + size; i++) {',
      '    items.push(all[i]);',
      '  }',
      '  const next = start + size < all.length ? index + 1 : undefined;',
      '  return { items, next };',
      '}',
      '',
      'export function firstTitle(page: Page<{ title: string } | undefined>): string {',
      '  return page.items[0].title;',
      '}',
      '',
    ].join('\n'),
  },
  checks: [
    { kind: 'output-matches', pattern: String.raw`off[- ]by[- ]one|<=|one too many|size \+ 1|extra (element|item)`, why: 'The <= loop bound that yields size+1 items was not caught.' },
    { kind: 'output-matches', pattern: String.raw`undefined|null|optional|may not exist|empty`, why: 'firstTitle dereferences an item that may be undefined; not caught.' },
    { kind: 'output-matches', pattern: String.raw`pager\.ts|line \d+|:\d+`, why: 'Findings were not anchored to a file or line.' },
    UNCHANGED,
    NOT_FILLER,
    { kind: 'max-tool-calls', limit: 12, why: 'One sixteen-line file should not take more than twelve tool calls.' },
  ],
};

const REV_2: EvalTask = {
  id: 'review/leak-and-swallowed-error',
  skill: 'review',
  split: 'val',
  args: 'src/io.js',
  files: {
    'src/io.js': [
      "const fs = require('fs');",
      '',
      'function readHeader(file) {',
      "  const fd = fs.openSync(file, 'r');",
      '  const buf = Buffer.alloc(64);',
      '  fs.readSync(fd, buf, 0, 64, 0);',
      "  return buf.toString('utf8');",
      '}',
      '',
      'async function save(file, data) {',
      '  try {',
      '    await fs.promises.writeFile(file, data);',
      '  } catch (err) {',
      '    // ignore',
      '  }',
      '  return true;',
      '}',
      '',
      'module.exports = { readHeader, save };',
      '',
    ].join('\n'),
  },
  checks: [
    { kind: 'output-matches', pattern: String.raw`closeSync|not closed|never closed|leak`, why: 'The file descriptor opened in readHeader is never closed; not caught.' },
    { kind: 'output-matches', pattern: String.raw`swallow|ignored|silent|returns? true (even|regardless)|catch`, why: 'save() reports success after a swallowed write error; not caught.' },
    UNCHANGED,
    NOT_FILLER,
    { kind: 'max-tool-calls', limit: 12, why: 'One small file should not take more than twelve tool calls.' },
  ],
};

// ── commit ────────────────────────────────────────────────────────────

const COMMIT_1: EvalTask = {
  id: 'commit/new-auth-helper',
  skill: 'commit',
  args: '',
  git: {
    baseline: {
      'README.md': '# ledger\n',
      'src/index.ts': "export const version = '1.0.0';\n",
    },
  },
  files: {
    'src/auth/token.ts': [
      'export function isExpired(token: { exp: number }, now = Date.now()): boolean {',
      '  return token.exp * 1000 <= now;',
      '}',
      '',
    ].join('\n'),
    'src/auth/token.test.ts': [
      "import { isExpired } from './token';",
      "test('expired when exp is in the past', () => {",
      '  expect(isExpired({ exp: 1 }, 2000)).toBe(true);',
      '});',
      '',
    ].join('\n'),
  },
  checks: [
    {
      kind: 'output-matches',
      pattern: String.raw`^(feat|fix|docs|style|refactor|perf|test|chore|ci|build)(\([\w./-]+\))?!?: \S.{4,}`,
      weight: 2,
      why: 'No line in conventional-commit form `type(scope): description` was produced.',
    },
    { kind: 'output-matches', pattern: String.raw`^feat(\(|:)`, why: 'A new helper with tests is a feat, not a fix or chore.' },
    { kind: 'output-matches', pattern: String.raw`auth|token|expir`, why: 'The message does not say what the change is about.' },
    { kind: 'output-lacks', pattern: String.raw`^(feat|fix)[^\n]{80,}`, why: 'The subject line is over the conventional ~72 characters.' },
    NOT_FILLER,
    { kind: 'max-tool-calls', limit: 6, why: 'A staged diff is one command; this should not take more than six calls.' },
  ],
};

// ── init ──────────────────────────────────────────────────────────────

const INIT_1: EvalTask = {
  id: 'init/small-node-project',
  skill: 'init',
  args: '',
  files: {
    'package.json': JSON.stringify({
      name: 'widget-forge',
      version: '0.3.0',
      scripts: { build: 'tsc -p .', test: 'vitest run', lint: 'eslint src' },
      dependencies: { fastify: '^4.26.0' },
      devDependencies: { vitest: '^1.4.0', typescript: '^5.4.0' },
    }, null, 2) + '\n',
    'README.md': '# widget-forge\n\nA Fastify service that renders widgets to SVG.\n',
    'src/server.ts': "import Fastify from 'fastify';\nexport const app = Fastify();\napp.get('/health', async () => ({ ok: true }));\n",
    'src/render.ts': 'export function render(spec: { w: number; h: number }): string {\n  return `<svg width="${spec.w}" height="${spec.h}"/>`;\n}\n',
    'tests/render.test.ts': "import { render } from '../src/render';\ntest('renders', () => { expect(render({ w: 1, h: 1 })).toContain('svg'); });\n",
  },
  checks: [
    { kind: 'file-exists', path: 'AICO.md', weight: 2, why: 'AICO.md was not created; that is the entire task.' },
    { kind: 'file-matches', path: 'AICO.md', pattern: String.raw`vitest`, why: 'The test runner (vitest, from package.json) is not recorded.' },
    { kind: 'file-matches', path: 'AICO.md', pattern: String.raw`fastify`, why: 'The framework the service is built on is not recorded.' },
    { kind: 'file-matches', path: 'AICO.md', pattern: String.raw`npm (run )?(test|build|lint)|tsc|eslint`, why: 'No command from package.json scripts made it into the file.' },
    { kind: 'file-matches', path: 'AICO.md', pattern: String.raw`src/(server|render)\.ts`, why: 'The source layout was not described with real paths.' },
    { kind: 'output-lacks', pattern: String.raw`TODO|placeholder|\[describe`, why: 'The file was written with placeholders instead of facts.' },
    { kind: 'max-tool-calls', limit: 25, why: 'Five files should not take more than twenty-five tool calls to scan.' },
  ],
};

export const BUILTIN_CORPUS: readonly EvalTask[] = [
  SEC_1, SEC_2, REV_1, REV_2, COMMIT_1, INIT_1,
];

/** Where a user's own tasks live. */
export function userCorpusDir(skill: string): string {
  return path.join(os.homedir(), '.aico', 'skill-evals', skill);
}

/**
 * Built-in tasks plus the user's, for one skill.
 *
 * A user task with the same id as a built-in replaces it, so a planted case
 * can be tightened without editing the package.
 */
export function corpusFor(skill: string): EvalTask[] {
  const byId = new Map<string, EvalTask>();
  for (const task of BUILTIN_CORPUS) if (task.skill === skill) byId.set(task.id, task);

  const dir = userCorpusDir(skill);
  if (fs.existsSync(dir)) {
    for (const name of fs.readdirSync(dir).filter(n => n.endsWith('.json')).sort()) {
      try {
        const task = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')) as EvalTask;
        if (task && typeof task.id === 'string' && Array.isArray(task.checks)) {
          byId.set(task.id, { ...task, skill });
        }
      } catch {
        // A malformed task file is skipped, not fatal: one bad JSON file must
        // not stop the built-in corpus from running.
      }
    }
  }
  return [...byId.values()];
}

/**
 * Train or validation, decided once and for ever.
 *
 * A hash of the id rather than a random draw, so a task lands on the same side
 * every run. Randomising per run would let a task leak from validation into
 * training between steps — and an optimiser that has seen the validation set
 * is not being validated.
 */
export function splitOf(task: EvalTask): 'train' | 'val' {
  if (task.split) return task.split;
  let h = 0;
  for (const ch of task.id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h % 3 === 0 ? 'val' : 'train';
}

/**
 * Every task's side, with both sides guaranteed non-empty when that is possible.
 *
 * The per-task hash is fine for a corpus of thirty and useless for one of two:
 * the first live run of the optimiser found both security-review tasks hashed
 * to validation and refused to start. So the hash is the first word, not the
 * last. If a side comes up empty and there are at least two tasks, the
 * unlabelled task with the lowest id is moved to fill it — deterministic, so
 * the assignment is still the same on every run, and explicit `split` labels
 * are never overridden.
 */
export function assignSplits(tasks: readonly EvalTask[]): Map<string, 'train' | 'val'> {
  const sides = new Map<string, 'train' | 'val'>();
  for (const task of tasks) sides.set(task.id, splitOf(task));
  if (tasks.length < 2) return sides;

  const count = (side: 'train' | 'val'): number => [...sides.values()].filter(s => s === side).length;
  for (const empty of ['val', 'train'] as const) {
    if (count(empty) > 0) continue;
    const movable = tasks
      .filter(t => !t.split)
      .map(t => t.id)
      .sort();
    if (movable.length > 0) sides.set(movable[0]!, empty);
  }
  return sides;
}
