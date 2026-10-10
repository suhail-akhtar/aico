/**
 * The Delivery board as the owner found it in real use, seeded so the true-board screens can
 * be run and photographed without a model: the base seed (scripts/delivery-seed.mjs) plus
 *
 *   - an epic with children, two of them in Backlog and two READY tasks that depend on those
 *     (the board that said "starting..." forever);
 *   - a review task whose branch writes a file that also exists, different, in the project's
 *     checkout (the landing collision that showed a raw git sentence);
 *   - people and agent slots as assignees, types, due dates (one overdue), estimates, a task
 *     landed automatically, and a Review limit the column sits at.
 *
 *   npm run build && npx tsup src/test-exports.ts --format esm --outDir dist-test --target node18 --silent
 *   node scripts/delivery-seed-board.mjs <outDir>
 *   AICO_HOME=<outDir>/.aico node dist/index.js serve --port 7343
 *
 * WHY A SECOND FILE. The base seed is what every Delivery screen test starts from; extending
 * it in place would change those screens too. This runs it, then adds, so both stay true.
 *
 * Nothing here starts a run: the dispatcher is left paused by the base seed and no provider is
 * configured in the store, so no seeded task can spend anything. `live` (what the running agent
 * is doing) is derived from a live session in the engine process and cannot be journaled, so a
 * seed has no live line; screenshots of it come from a probe that adds it on the client.
 * `test-home.mjs` is imported first like every probe: the store written is `<outDir>/.aico`,
 * never `~/.aico`.
 *
 * @module scripts/delivery-seed-board
 */

import './lib/test-home.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const requested = path.resolve(process.argv[2] ?? path.join(os.tmpdir(), 'aico-delivery-board-live'));
execFileSync(process.execPath, [path.join(here, 'delivery-seed.mjs'), requested], { stdio: 'ignore' });

const outDir = fs.realpathSync.native(requested);
const home = path.join(outDir, '.aico');
const project = path.join(outDir, 'shop');
process.env.AICO_HOME = home;
const { DeliveryStore: S, DeliveryGit: G } = await import('../dist-test/test-exports.js');

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const write = (dir, files) => {
  for (const [rel, text] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text); }
};
const iso = (minutesAgo) => new Date(Date.now() - minutesAgo * 60_000).toISOString();
const day = (offset) => { const d = new Date(Date.now() + offset * 86_400_000); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

function task(over) {
  const id = S.newTaskId();
  const t = { id, project, title: 'Untitled', body: '', acceptance: [], status: 'backlog', priority: 3, dependsOn: [], labels: [], createdAt: iso(500), updatedAt: iso(30), ...over };
  S.putTask(project, t);
  return t;
}

// ── an epic and its children: Ready tasks that wait for Backlog tasks ────
const epic = task({ title: 'Harden API authentication', body: 'Everything that makes the API fail closed.', priority: 1, type: 'feature', labels: ['auth'], createdAt: iso(900) });
const failClosed = task({
  title: 'Make API authentication fail closed', body: 'A missing or unreadable key must reject the request, not allow it.', priority: 1, type: 'bug', parentId: epic.id, labels: ['auth', 'security'],
  assignee: { kind: 'person', name: 'Sam Rivera' }, dueDate: day(-2), estimate: 3, createdAt: iso(880),
  acceptance: ['A request without a key gets 401', 'An unreadable key store gets 503, never 200'],
});
const rotation = task({ title: 'Add token rotation tests', priority: 2, type: 'chore', parentId: epic.id, labels: ['auth'], assignee: { kind: 'person', name: 'Priya Nair' }, dueDate: day(3), estimate: 2, createdAt: iso(870) });
const wire = task({ title: 'Wire the auth middleware into every route', priority: 1, type: 'feature', status: 'ready', parentId: epic.id, dependsOn: [failClosed.id, rotation.id], labels: ['auth'], estimate: 5, createdAt: iso(860), updatedAt: iso(20) });
const docs = task({ title: 'Document the auth flow', priority: 3, type: 'docs', status: 'ready', parentId: epic.id, dependsOn: [failClosed.id], estimate: 1, createdAt: iso(850), updatedAt: iso(18) });
S.logActivity(project, failClosed.id, 'created', 'person', 'Created from the security review.');
S.logActivity(project, wire.id, 'moved', 'person', 'Moved to Ready.');

// ── a review task whose landing collides with a file in the checkout ─────
const collide = task({ title: 'Reject requests with an unreadable key store', body: 'Fail closed when the key store cannot be read.', priority: 1, type: 'bug', status: 'review', labels: ['auth'], assignee: { kind: 'agent', name: 'Agent C' }, updatedAt: iso(9), createdAt: iso(300), estimate: 2 });
{
  const wt = path.join(home, 'worktrees', 'delivery', S.boardDir(project).split(path.sep).pop(), collide.id);
  const branch = `aico/task-${collide.id}`;
  fs.mkdirSync(path.dirname(wt), { recursive: true });
  git(project, 'worktree', 'add', '-q', '-b', branch, wt, 'main');
  write(wt, {
    'src/server/auth-middleware.mjs': "export function requireKey(req, keys) {\n  if (!keys) throw new Error('key store unreadable');\n  return keys.has(req.key);\n}\n",
    'test/auth-middleware.test.mjs': "import test from 'node:test';\ntest('fails closed', () => {});\n",
  });
  git(wt, 'add', '-A'); git(wt, 'commit', '-q', '-m', 'fix: fail closed when the key store is unreadable');
  const changed = git(wt, 'diff', '--name-only', 'main', 'HEAD').split('\n').filter(Boolean);
  const summary = 'Checks passed: test (14). 2 files, +8 -0.';
  S.patchTask(project, collide.id, {
    branch, worktree: wt, touches: { files: changed, symbols: [], predicted: false }, costUsd: 0.62,
    risk: { score: 22, level: 'low', reasons: ['2 files, 8 lines changed', 'a test was added'] }, evidence: { md: `## ${collide.title}\n\n${summary}\n`, summary },
  });
  const tree = await G.treeOf(wt);
  S.recordBase(project, collide.id, await G.revParse(project, 'main'), tree);
  S.recordChecks(project, tree, true, [{ name: 'test', command: 'node check.js', outcome: 'passed', exitCode: 0, ms: 900, tests: { runner: 'node', passed: 14, failed: 0, skipped: 0, failures: [] } }]);
  S.queuePush(project, collide.id);
  // The person's own, different, uncommitted copy of the same path, in the checkout the landing will fast-forward.
  write(project, { 'src/server/auth-middleware.mjs': "// my local experiment, not committed yet\nexport const requireKey = () => true;\n" });
}

// ── landed automatically, and who has what ───────────────────────────────
const auto = task({ title: 'Format the README tables', priority: 4, type: 'docs', status: 'merged', assignee: { kind: 'agent', name: 'Agent A' }, createdAt: iso(400), updatedAt: iso(35), costUsd: 0.11 });
S.patchTask(project, auto.id, {
  landed: { from: 'a'.repeat(40), to: 'b'.repeat(40), at: iso(35), kind: 'docs', breaking: false, by: 'auto', decision: { autonomy: 'autonomous', risk: 'low', score: 3, evidence: 'Checks passed: test (14).', reason: 'low risk, 14 tests passed, no safety finding' } },
  evidence: { md: '## Format the README tables\n\nChecks passed: test (14).\n', summary: 'Checks passed: test (14). 1 file, +6 -6.' },
});
S.logActivity(project, auto.id, 'landed', 'system', 'Landed automatically at the autonomous level: low risk, 14 tests passed, no safety finding.');

for (const t of S.boardState(project).tasks) {
  if (t.title === 'Persist the cart across sessions') S.patchTask(project, t.id, { assignee: { kind: 'agent', name: 'Agent A' }, type: 'feature', estimate: 5 });
  else if (t.title === 'Validate discount codes') S.patchTask(project, t.id, { assignee: { kind: 'agent', name: 'Agent B' }, type: 'feature', estimate: 3 });
  else if (t.title === 'Fix rounding in order totals') S.patchTask(project, t.id, { type: 'bug', assignee: { kind: 'agent', name: 'Agent D' }, estimate: 1 });
  else if (t.title === 'Paginate the order history') S.patchTask(project, t.id, { type: 'feature', assignee: { kind: 'agent', name: 'Agent A' }, dueDate: day(1), estimate: 5 });
  else if (t.title === 'Rate-limit the login endpoint') S.patchTask(project, t.id, { type: 'feature', assignee: { kind: 'person', name: 'Sam Rivera' }, dueDate: day(5), estimate: 3 });
  else if (t.title === 'Add a gift-card payment method') S.patchTask(project, t.id, { type: 'feature', estimate: 8 });
  else if (t.title === 'Localise the checkout copy') S.patchTask(project, t.id, { type: 'chore' });
}
// Review is at its limit, so its header turns amber.
S.setSettings(project, { wip: { review: S.boardState(project).tasks.filter(t => t.status === 'review').length } });

const board = S.boardState(project);
console.log(`Seeded ${board.tasks.length} tasks (${board.tasks.filter(t => t.status === 'ready').length} ready).`);
console.log(`  project  : ${project}`);
console.log(`  AICO_HOME: ${home}`);
console.log(`  collision: ${collide.id} (review) vs the untracked src/server/auth-middleware.mjs in the project`);
process.exit(0);
