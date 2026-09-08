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
import { aicoHome } from '../../home.js';
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

// ── app-plan ──────────────────────────────────────────────────────────

/** A templated app, so the skill has an AICO.md to read instead of asking about the stack. */
const APP_FILES = {
  'AICO.md': '# Invoice Desk\n\nA Hono JSON API on node:sqlite. Resource pattern: one file per resource in src/ (type, parse, repo, routes). Tests: vitest in memory. Checks: npm run typecheck, npm test.\n',
  'package.json': '{ "name": "invoice-desk", "scripts": { "typecheck": "tsc --noEmit", "test": "vitest run", "dev": "tsx watch src/index.ts" } }\n',
  'docs/EXTENDING.md': '# Extending\n\nCopy src/items.ts for a new resource; mount it in src/app.ts; document it in src/openapi.ts; test it in test/.\n',
  'src/items.ts': "export interface Item { id: number; name: string }\nexport function parseItem(b: unknown) { return { value: { name: String((b as any).name) } }; }\n",
  '.aico/backlog.md': '# Backlog\n\n## Iteration 0 — from the template\n\n- [x] items resource.\n      Done when: npm test passes.\n',
};

const PLAN_1: EvalTask = {
  id: 'app-plan/backlog-from-brief',
  skill: 'app-plan',
  split: 'val',
  args: 'A small studio sends invoices to customers. Invoices have line items, a due date and a status (draft, sent, paid, overdue). The owner mostly opens it to see who has not paid and to mark invoices paid. Done means: an invoice can be created with line items, sent, and marked paid, and the list shows overdue ones first.',
  files: APP_FILES,
  checks: [
    { kind: 'file-exists', path: 'docs/PRD.md', weight: 2, why: 'No PRD was written; the plan is the deliverable.' },
    { kind: 'file-matches', path: 'docs/PRD.md', pattern: String.raw`done when`, flags: 'i', why: 'The PRD has no "Done when" statements — nothing checkable.' },
    { kind: 'file-matches', path: 'docs/PRD.md', pattern: String.raw`overdue`, flags: 'i', why: 'The status lifecycle from the brief (overdue) did not make it into the data section.' },
    { kind: 'file-matches', path: '.aico/backlog.md', pattern: String.raw`## Iteration 1`, weight: 2, why: 'No new iteration was appended to the backlog.' },
    { kind: 'file-matches', path: '.aico/backlog.md', pattern: String.raw`- \[ \] [^\n]+\n\s+Done when:`, weight: 2, why: 'Stories lack the "Done when" line, so nothing decides when one is finished.' },
    { kind: 'file-matches', path: '.aico/backlog.md', pattern: String.raw`(mark(ed)? (an? invoice )?paid|paid)`, flags: 'i', why: 'The primary action — marking paid — is not a story.' },
    { kind: 'file-matches', path: '.aico/backlog.md', pattern: String.raw`## Iteration 0[\s\S]*\[x\] items resource`, why: 'The existing iteration was rewritten instead of appended to.' },
    { kind: 'output-lacks', pattern: String.raw`\b(express|fastify|next\.js|postgres)\b`, why: 'The plan proposed a stack the app does not have; AICO.md said Hono and node:sqlite.' },
    { kind: 'max-tool-calls', limit: 14, why: 'Planning five files should not take more than fourteen tool calls.' },
  ],
};

const PLAN_2: EvalTask = {
  id: 'app-plan/asks-before-guessing',
  skill: 'app-plan',
  args: 'Build me something for my team.',
  files: APP_FILES,
  checks: [
    { kind: 'output-matches', pattern: String.raw`\?`, weight: 2, why: 'A brief with no user, no action and no done-state was not questioned.' },
    { kind: 'output-lacks', pattern: String.raw`(react|vue|angular|postgres|mongodb|which (stack|framework|language))`, flags: 'i', why: 'It asked about the stack, which AICO.md already settles.' },
    { kind: 'no-file-changed', weight: 2, why: 'Files were written before the brief was clear enough to plan from.' },
    { kind: 'max-tool-calls', limit: 6, why: 'Asking three questions should not take six tool calls.' },
  ],
};

// ── app-architecture ─────────────────────────────────────────────────

const ARCH_1: EvalTask = {
  id: 'app-architecture/place-a-feature',
  skill: 'app-architecture',
  split: 'val',
  args: 'Add customers to this API: a customer has a name and an email, and an item belongs to a customer.',
  files: {
    ...APP_FILES,
    'src/app.ts': "import { Hono } from 'hono';\nimport { itemRoutes } from './items.js';\nexport function createApp(db: any) { const app = new Hono(); app.route('/items', itemRoutes(db)); return app; }\n",
    'src/db.ts': "const MIGRATIONS = [\n  `CREATE TABLE IF NOT EXISTS items (id INTEGER PRIMARY KEY, name TEXT NOT NULL)`,\n];\nexport { MIGRATIONS };\n",
    'test/items.test.ts': "import { it } from 'vitest';\nit('lists', () => {});\n",
    '.aico/decisions.md': '# Decisions\n\n- Hono over Express — Web-standard Request/Response.\n',
  },
  checks: [
    { kind: 'output-matches', pattern: String.raw`customers?[^\n]*\b(table|migration|CREATE TABLE)\b|\b(table|migration|CREATE TABLE)\b[^\n]*customers?`, flags: 'i', weight: 2, why: 'The data model was not named first.' },
    { kind: 'output-matches', pattern: String.raw`(customer_id|REFERENCES customers|foreign key)`, flags: 'i', why: 'The relation from items to customers was not stated as a constraint.' },
    { kind: 'output-matches', pattern: String.raw`src/customers\.ts`, weight: 2, why: 'The new resource was not placed on the worked pattern (one file per resource).' },
    { kind: 'output-matches', pattern: String.raw`(src/app\.ts|mount)`, flags: 'i', why: 'Where the routes get mounted was not said.' },
    { kind: 'output-matches', pattern: String.raw`test/customers\.test\.ts`, why: 'No test location was named.' },
    { kind: 'output-lacks', pattern: String.raw`\b(models?/|services?/|controllers?/)\b`, flags: 'i', why: 'Proposed layer folders the codebase does not use.' },
    { kind: 'output-lacks', pattern: String.raw`\b(prisma|typeorm|sequelize|mongoose)\b`, flags: 'i', why: 'Reached for an ORM the project does not have.' },
    { kind: 'output-matches', pattern: String.raw`decisions\.md`, flags: 'i', why: 'The decision was not recorded (or the file not mentioned).' },
    { kind: 'max-tool-calls', limit: 12, why: 'Placing one resource in a nine-file project should not take more than twelve tool calls.' },
  ],
};

const ARCH_2: EvalTask = {
  id: 'app-architecture/reuse-before-write',
  skill: 'app-architecture',
  args: 'Add a money formatting helper for the invoice totals shown in the API responses.',
  files: {
    ...APP_FILES,
    'src/format.ts': "export function money(cents: number, currency = 'USD'): string { return new Intl.NumberFormat('en', { style: 'currency', currency }).format(cents / 100); }\n",
    'src/items.ts': "import { money } from './format.js';\nexport function label(cents: number) { return money(cents); }\n",
  },
  checks: [
    { kind: 'output-matches', pattern: String.raw`src/format\.ts|\bmoney\(`, weight: 2, why: 'The existing helper was not found; a second one was proposed.' },
    { kind: 'output-lacks', pattern: String.raw`(create|add|new)[^\n]{0,30}(src/(utils|helpers|lib)/|formatMoney|currency\.ts)`, flags: 'i', weight: 2, why: 'Proposed a new helper beside an existing one.' },
    { kind: 'no-file-changed', why: 'Placement is a decision, not an edit; nothing needed writing to say "use src/format.ts".' },
    { kind: 'max-tool-calls', limit: 8, why: 'A Grep for money/format is enough; eight tool calls is generous.' },
  ],
};

// ── app-ship ──────────────────────────────────────────────────────────

const SHIP_1: EvalTask = {
  id: 'app-ship/env-and-health',
  skill: 'app-ship',
  split: 'val',
  args: 'Get this service ready to deploy with Docker.',
  files: {
    'package.json': '{ "name": "notes-api", "scripts": { "start": "node src/index.js", "test": "node --test" }, "dependencies": { "hono": "^4.7.0", "@hono/node-server": "^1.14.0" } }\n',
    'package-lock.json': '{ "name": "notes-api", "lockfileVersion": 3, "packages": {} }\n',
    'src/index.js': [
      "import { serve } from '@hono/node-server';",
      "import { Hono } from 'hono';",
      'const app = new Hono();',
      "const token = process.env.API_TOKEN;",
      "const dbPath = process.env.DATABASE_PATH || './notes.sqlite';",
      "app.get('/notes', c => c.json([]));",
      'serve({ fetch: app.fetch, port: 3000 });',
      '',
    ].join('\n'),
    '.gitignore': 'node_modules\n',
    'README.md': '# notes-api\n\nA notes service.\n',
  },
  checks: [
    { kind: 'file-exists', path: 'Dockerfile', weight: 2, why: 'No Dockerfile was written.' },
    { kind: 'file-matches', path: 'Dockerfile', pattern: String.raw`FROM [^\n]+ AS \w+[\s\S]*FROM `, why: 'The Dockerfile is not multi-stage.' },
    { kind: 'file-matches', path: 'Dockerfile', pattern: String.raw`USER `, why: 'The image runs as root.' },
    { kind: 'file-matches', path: 'Dockerfile', pattern: String.raw`HEALTHCHECK`, why: 'No HEALTHCHECK in the image.' },
    { kind: 'file-exists', path: '.env.example', weight: 2, why: 'No .env.example; the variables the code reads are undocumented.' },
    { kind: 'file-matches', path: '.env.example', pattern: String.raw`API_TOKEN`, why: 'API_TOKEN is read by the code but not in .env.example.' },
    { kind: 'file-matches', path: '.env.example', pattern: String.raw`DATABASE_PATH`, why: 'DATABASE_PATH is read by the code but not in .env.example.' },
    { kind: 'file-matches', path: 'src/index.js', pattern: String.raw`healthz`, weight: 2, why: 'No health route was added.' },
    { kind: 'file-matches', path: 'src/index.js', pattern: String.raw`process\.env\.PORT`, why: 'The port is still hard-coded; it must come from PORT.' },
    { kind: 'file-matches', path: 'README.md', pattern: String.raw`(?:docker build|docker compose|docker run)`, why: 'The README does not say the deploy command.' },
    { kind: 'output-lacks', pattern: String.raw`(?:aws-sdk|@aws-sdk|firebase-admin|vault)`, flags: 'i', why: 'A cloud SDK or secrets manager was added; config is env only.' },
    { kind: 'max-tool-calls', limit: 30, why: 'Shipping a four-file service should not take more than thirty tool calls.' },
  ],
};

// ── app-quality ───────────────────────────────────────────────────────

const QUALITY_1: EvalTask = {
  id: 'app-quality/report-what-was-verified',
  skill: 'app-quality',
  args: 'The invoices page should let me mark an invoice paid and show overdue ones first. Verify it.',
  files: {
    ...APP_FILES,
    'src/invoices.ts': "export function sortInvoices(rows: { status: string; due: string }[]) { return rows.sort((a, b) => a.due.localeCompare(b.due)); }\nconsole.log('debug');\n",
    'test/invoices.test.ts': "import { it, expect } from 'vitest';\nimport { sortInvoices } from '../src/invoices.js';\nit('sorts', () => { expect(sortInvoices([]).length).toBe(0); });\n",
  },
  checks: [
    { kind: 'output-matches', pattern: String.raw`RunChecks|typecheck|npm test|vitest`, why: 'The project’s own checks were not run or mentioned.' },
    { kind: 'output-matches', pattern: String.raw`mark(ed)?[^\n]{0,20}paid`, flags: 'i', weight: 2, why: 'The requirement "mark an invoice paid" was not named as a check.' },
    { kind: 'output-matches', pattern: String.raw`overdue`, flags: 'i', why: 'The requirement "overdue first" was not named as a check.' },
    { kind: 'output-matches', pattern: String.raw`(?:PASS|FAIL|not verified|could not)`, weight: 2, why: 'No per-requirement result was reported.' },
    { kind: 'output-lacks', pattern: String.raw`everything works|all good|works as expected`, flags: 'i', why: 'A blanket claim instead of named checks.' },
    { kind: 'file-matches', path: 'src/invoices.ts', pattern: String.raw`^(?![\s\S]*console\.log\('debug'\))`, why: 'The stray console.log was left in.' },
    { kind: 'max-tool-calls', limit: 20, why: 'Verifying a two-file feature should not take more than twenty tool calls.' },
  ],
};

// ── app-design ────────────────────────────────────────────────────────

const DESIGN_1: EvalTask = {
  id: 'app-design/invoices-page-professional',
  skill: 'app-design',
  args: 'The invoices page looks like an admin panel. Make it look like a product a studio would pay for.',
  files: {
    ...APP_FILES,
    'src/app/globals.css': '@theme { --color-brand: #2f5df6; --color-ink: #16181d; --color-ink-muted: #5b6270; --color-surface: #fff; --color-surface-alt: #f5f7fb; --color-line: #e2e6ee; --color-danger: #b42318; }\n',
    'src/app/invoices/page.tsx': "export default function Invoices({ rows }: { rows: { id: number; number: string; total: number; status: string }[] }) {\n  return (\n    <div>\n      <p style={{ color: '#888' }}>Placeholder eyebrow</p>\n      <h1>Invoices</h1>\n      {rows.length === 0 ? <div>No results</div> : (\n        <table>{rows.map(r => <tr key={r.id}><td>{r.number}</td><td>{r.total}</td><td style={{ color: r.status === 'paid' ? 'green' : 'red' }}>{r.status}</td></tr>)}</table>\n      )}\n    </div>\n  );\n}\n",
  },
  checks: [
    { kind: 'file-matches', path: 'src/app/invoices/page.tsx', pattern: String.raw`^(?![\s\S]*Placeholder eyebrow)`, weight: 2, why: 'Placeholder copy was shipped.' },
    { kind: 'file-matches', path: 'src/app/invoices/page.tsx', pattern: String.raw`^(?![\s\S]*#[0-9a-fA-F]{3,6}\b)`, why: 'A raw hex colour is still in the component instead of a token.' },
    { kind: 'file-matches', path: 'src/app/invoices/page.tsx', pattern: String.raw`^(?![\s\S]*>No results<)`, why: 'The empty state still says nothing about what the list is for.' },
    { kind: 'file-matches', path: 'src/app/invoices/page.tsx', pattern: String.raw`tabular-nums|text-right`, why: 'Money is not right-aligned in the table.' },
    { kind: 'output-matches', pattern: String.raw`390|responsive|phone|mobile`, flags: 'i', why: 'The narrow viewport was not considered or mentioned.' },
    { kind: 'output-matches', pattern: String.raw`empty state|no invoices yet|first invoice`, flags: 'i', why: 'The empty state was not designed.' },
    { kind: 'max-tool-calls', limit: 16, why: 'Restyling one page should not take more than sixteen tool calls.' },
  ],
};

export const BUILTIN_CORPUS: readonly EvalTask[] = [
  SEC_1, SEC_2, REV_1, REV_2, COMMIT_1, INIT_1, PLAN_1, PLAN_2, ARCH_1, ARCH_2, SHIP_1, QUALITY_1, DESIGN_1,
];

/** Where a user's own tasks live. */
export function userCorpusDir(skill: string): string {
  return path.join(aicoHome(), 'skill-evals', skill);
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
