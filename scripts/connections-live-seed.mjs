/**
 * Seeds a Delivery board for looking at Connections in the real app (see
 * scripts/connections-live-stack.mjs). NOT part of `npm test`; the dispatcher never starts and no
 * model is involved: the journal is the board (ADR 0038), so writing its events and making the
 * matching git state is exactly what a run would have left behind.
 *
 *   node scripts/connections-live-seed.mjs <stack.json> <connection id> <AICO_HOME of the running engine>
 *
 * Run it AFTER the engine is up and the project is mapped.
 * It adds: imported backlog tasks (one "ready on remote"), two tasks in review with real worktrees
 * and commits (approving one in PR mode pushes it to the stack's git remote and opens the pull
 * request on the mock forge), one running, one merged. Everything uses the store the environment
 * names; with none set, test-home.mjs gives it a throwaway one.
 */

import './lib/test-home.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { T } from './lib/dist.mjs';

const { DeliveryStore: S, DeliveryGit: G } = T;
const stack = JSON.parse(fs.readFileSync(path.resolve(process.argv[2]), 'utf8'));
const project = fs.realpathSync.native(stack.project);
// test-home.mjs (first import) gave this process a throwaway store; the one to seed is named explicitly.
const home = path.resolve(process.argv[4] ?? process.env.AICO_HOME);
process.env.AICO_HOME = home;
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const iso = (minutesAgo) => new Date(Date.now() - minutesAgo * 60_000).toISOString();
const write = (dir, files) => { for (const [rel, text] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text); } };

S.ensureInit(project, 'main');
let n = 0;
const id = () => (0xa1000000 + (++n) * 0x111).toString(16).padStart(8, '0');
const task = (over) => {
  const t = { id: id(), project, title: 'Task', body: '', acceptance: [], status: 'backlog', priority: 3, dependsOn: [], labels: [], createdAt: iso(300), updatedAt: iso(30), ...over };
  S.putTask(project, t);
  return t;
};

// Two local backlog tasks; the sync adds what GitHub lists (always backlog).
const a = task({ title: 'Add dark mode to the settings page', body: 'Users ask for a dark theme.', acceptance: ['A toggle switches the theme', 'The choice is remembered'], priority: 2, labels: ['ui'] });
const b = task({ title: 'CSV export drops the last row', body: 'Off by one in the exporter.', acceptance: ['The last row is exported'], priority: 1, labels: ['bug'] });

// In review, with real work on real branches.
function review(over, files, message, risk, summary) {
  const t = task({ ...over, status: 'review', updatedAt: iso(over.minutesAgo ?? 15) });
  const key = S.boardDir(project).split(path.sep).pop();
  const wt = path.join(home, 'worktrees', 'delivery', key, t.id);
  const branch = `aico/task-${t.id}`;
  fs.mkdirSync(path.dirname(wt), { recursive: true });
  git(project, 'worktree', 'add', '-q', '-b', branch, wt, 'main');
  git(wt, 'config', 'user.name', 'Octo Dev'); git(wt, 'config', 'user.email', 'octo@example.test'); git(wt, 'config', 'commit.gpgsign', 'false');
  write(wt, files);
  git(wt, 'add', '-A'); git(wt, 'commit', '-q', '-m', message);
  const changed = git(wt, 'diff', '--name-only', 'main', 'HEAD').split('\n').filter(Boolean);
  S.patchTask(project, t.id, { branch, worktree: wt, touches: { files: changed, symbols: [], predicted: false }, risk, evidence: { md: `## Task ${t.id}: ${over.title}\n\n${summary}\n\n### Checks\n\n- test: passed\n`, summary }, costUsd: 0.62 });
  return { t, wt };
}
const r1 = review({ title: 'Cache widget lookups', body: 'Repeated lookups hit the database.', acceptance: ['A second lookup does not query'], priority: 2, labels: ['src/widget.js'], minutesAgo: 12 },
  { 'src/widget-cache.js': 'const cache = new Map();\nexports.lookup = (id, load) => { if (!cache.has(id)) cache.set(id, load(id)); return cache.get(id); };\n', 'test/widget-cache.test.js': "require('node:test')('cache', () => {});\n" },
  'feat: cache widget lookups', { score: 12, level: 'low', reasons: ['2 files, 5 lines changed', 'a test was added'] }, 'Checks passed: test. 2 files, +5 -0.');
const r2 = review({ title: 'Trim whitespace in widget names', priority: 3, labels: ['src/widget.js'], minutesAgo: 30 },
  { 'src/widget.js': 'exports.widget = (name) => String(name).trim();\n' },
  'fix: trim widget names', { score: 9, level: 'low', reasons: ['1 file, 1 line changed'] }, 'Checks passed: test. 1 file, +1 -1.');
for (const { t, wt } of [r1, r2]) {
  const tree = await G.treeOf(wt);
  const trunkSha = await G.revParse(project, 'main');
  S.recordBase(project, t.id, trunkSha, tree);
  S.recordChecks(project, tree, true, [{ name: 'test', command: 'node check.js', outcome: 'passed', exitCode: 0, ms: 900 }]);
  S.queuePush(project, t.id);
}

// One merged since the start.
const m = task({ title: 'Initial widget module', status: 'merged', priority: 3, updatedAt: iso(900) });
S.patchTask(project, m.id, { evidence: { md: '## Initial widget module', summary: 'Checks passed: test.' } });
console.log(JSON.stringify({ review: [r1.t.id, r2.t.id], backlog: [a.id, b.id] }));
