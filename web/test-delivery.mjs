/**
 * Unit tests for the Delivery board's pure logic: column grouping and order,
 * which moves a person may make (and the reason shown when not), review-queue
 * risk order, dependency phrasing, time/money formatting, unified-diff parsing
 * and the light highlighter; and the rules behind releases (note grouping, version
 * validation, what blocks a release or a deploy), batch review (who may be ticked,
 * selection order, the words after a batch), "needs you" (which route answers a
 * wait, floating, optimistic clearing), `sessionOf`, tab-strip keys and the diff of
 * two attention snapshots that decides which desktop notifications fire.
 *
 * Bundles its own subjects with esbuild, so it runs on its own:
 *   node web/test-delivery.mjs
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aico-delivery-unit-'));
async function load(name) {
  const outfile = path.join(tmp, `${name}.mjs`);
  await build({ entryPoints: [path.join(here, 'src', `${name}.ts`)], bundle: true, format: 'esm', platform: 'node', outfile, logLevel: 'error' });
  return import(pathToFileURL(outfile).href);
}
const M = await load('delivery-model');
const D = await load('delivery-diff');

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; } catch (e) { console.error(`FAIL ${name}\n`, e); process.exitCode = 1; }
}

const task = (id, over = {}) => ({
  id, project: '/p', title: `Task ${id}`, body: '', acceptance: [], status: 'backlog', priority: 3,
  dependsOn: [], labels: [], createdAt: 1000, updatedAt: 1000, ...over,
});

// ── grouping ─────────────────────────────────────────────────────────
test('groups by status and keeps empty columns', () => {
  const g = M.groupTasks([task('1'), task('2', { status: 'ready' }), task('3', { status: 'merged' })]);
  assert.equal(g.backlog.length, 1);
  assert.equal(g.ready.length, 1);
  assert.equal(g.running.length, 0);
  assert.equal(g.merged.length, 1);
});

test('backlog sorts by priority then age', () => {
  const g = M.groupTasks([
    task('a', { priority: 3, createdAt: 1 }), task('b', { priority: 1, createdAt: 5 }), task('c', { priority: 3, createdAt: 0 }),
  ]);
  assert.deepEqual(g.backlog.map(t => t.id), ['b', 'c', 'a']);
});

test('ready follows the dispatcher queue, then priority', () => {
  const g = M.groupTasks([
    task('a', { status: 'ready', priority: 1 }), task('b', { status: 'ready', priority: 4 }), task('c', { status: 'ready', priority: 2 }),
  ], ['b', 'c']);
  assert.deepEqual(g.ready.map(t => t.id), ['b', 'c', 'a']);
});

test('merged shows most recent first', () => {
  const g = M.groupTasks([task('a', { status: 'merged', updatedAt: 1 }), task('b', { status: 'merged', updatedAt: 9 })]);
  assert.deepEqual(g.merged.map(t => t.id), ['b', 'a']);
});

test('query matches title, label and short id; label filter narrows', () => {
  const ts = [task('T-3', { title: 'Add login', labels: ['auth'] }), task('T-4', { title: 'Fix css', labels: ['ui'] })];
  assert.deepEqual(M.groupTasks(ts, [], { query: 'login' }).backlog.map(t => t.id), ['T-3']);
  assert.deepEqual(M.groupTasks(ts, [], { query: 'UI' }).backlog.map(t => t.id), ['T-4']);
  assert.deepEqual(M.groupTasks(ts, [], { query: '#4' }).backlog.map(t => t.id), ['T-4']);
  assert.deepEqual(M.groupTasks(ts, [], { label: 'auth' }).backlog.map(t => t.id), ['T-3']);
});

test('unknown status is dropped rather than throwing', () => {
  const g = M.groupTasks([task('x', { status: 'weird' })]);
  assert.equal(Object.values(g).flat().length, 0);
});

// ── transitions ──────────────────────────────────────────────────────
test('a person may move among backlog, ready, blocked, cancelled', () => {
  assert.equal(M.checkMove({ status: 'backlog' }, 'ready').ok, true);
  assert.equal(M.checkMove({ status: 'ready' }, 'backlog').ok, true);
  assert.equal(M.checkMove({ status: 'ready' }, 'blocked').ok, true);
  assert.equal(M.checkMove({ status: 'blocked' }, 'ready').ok, true);
  assert.equal(M.checkMove({ status: 'backlog' }, 'cancelled').ok, true);
  assert.equal(M.checkMove({ status: 'cancelled' }, 'backlog').ok, true);
});

test('cancelled can only come back through backlog', () => {
  const r = M.checkMove({ status: 'cancelled' }, 'ready');
  assert.equal(r.ok, false);
  assert.match(r.reason, /Backlog/);
});

test('agent-owned statuses cannot be dragged, and say why', () => {
  for (const s of ['running', 'review', 'changes', 'merged']) {
    const r = M.checkMove({ status: s }, 'backlog');
    assert.equal(r.ok, false, s);
    assert.ok(r.reason.length > 10, s);
  }
  assert.match(M.checkMove({ status: 'review' }, 'backlog').reason, /Approve/);
});

test('dropping into agent columns is refused; landing is explained', () => {
  assert.equal(M.checkMove({ status: 'ready' }, 'running').ok, false);
  assert.match(M.checkMove({ status: 'ready' }, 'merged').reason, /Approve and land/);
  assert.equal(M.checkMove({ status: 'ready' }, 'ready').ok, false);
});

test('allowedTargets lists exactly the legal drops', () => {
  assert.deepEqual(M.allowedTargets({ status: 'backlog' }), ['ready', 'blocked', 'cancelled']);
  assert.deepEqual(M.allowedTargets({ status: 'cancelled' }), ['backlog']);
  assert.deepEqual(M.allowedTargets({ status: 'running' }), []);
});

// ── review order ─────────────────────────────────────────────────────
test('review sorts high risk first, then score, then longest wait', () => {
  const mk = (id, level, score, updatedAt) => task(id, { status: 'review', risk: { level, score, reasons: [] }, updatedAt });
  const sorted = M.sortForReview([
    mk('low1', 'low', 10, 1), mk('hi-new', 'high', 70, 9), mk('hi-old', 'high', 70, 2), mk('hi-big', 'high', 90, 5), mk('med', 'medium', 40, 1),
  ]);
  assert.deepEqual(sorted.map(t => t.id), ['hi-big', 'hi-old', 'hi-new', 'med', 'low1']);
});

test('unassessed risk ranks as medium, and non-review tasks are excluded', () => {
  const a = task('a', { status: 'review' });
  const b = task('b', { status: 'review', risk: { level: 'low', score: 1, reasons: [] } });
  const c = task('c', { status: 'review', risk: { level: 'high', score: 80, reasons: [] } });
  const d = task('d', { status: 'running' });
  assert.deepEqual(M.sortForReview([a, b, c, d]).map(t => t.id), ['c', 'a', 'b']);
});

// ── dependencies, ids, formatting ────────────────────────────────────
test('shortId reads numeric suffixes and falls back to a prefix', () => {
  assert.equal(M.shortId('T-3'), '#3');
  assert.equal(M.shortId('task_12'), '#12');
  assert.equal(M.shortId('7'), '#7');
  assert.equal(M.shortId('9f3c2a1b-xxxx'), '#9f3c2a');
});

test('unmet dependencies are everything not merged, including unknown ids', () => {
  const byId = new Map([task('1', { status: 'merged' }), task('2', { status: 'review' })].map(t => [t.id, t]));
  const t = task('3', { dependsOn: ['1', '2', 'ghost'] });
  assert.deepEqual(M.unmetDeps(t, byId), ['2', 'ghost']);
  assert.equal(M.waitsForLabel(['T-2']), 'waits for #2');
  assert.equal(M.waitsForLabel(['T-2', 'T-3', 'T-4', 'T-5']), 'waits for #2, #3 +2');
  assert.equal(M.waitsForLabel([]), null);
});

test('makeRef numbers tasks in creation order and falls back for unknown ids', () => {
  const ts = [task('c3d4e5f6', { createdAt: '2026-01-02T00:00:00Z' }), task('a1b2c3d4', { createdAt: '2026-01-01T00:00:00Z' })];
  const ref = M.makeRef(ts);
  assert.equal(ref('a1b2c3d4'), '#1');
  assert.equal(ref('c3d4e5f6'), '#2');
  assert.equal(ref('ffffffff'), '#ffffff');
  assert.equal(M.waitsForLabel(['a1b2c3d4'], ref), 'waits for #1');
  assert.deepEqual(M.groupTasks(ts, [], { query: '#2', ref }).backlog.map(t => t.id), ['c3d4e5f6']);
});

test('elapsed reads like a stopwatch and never goes negative', () => {
  assert.equal(M.elapsed(0, 42_000), '42s');
  assert.equal(M.elapsed(0, 184_000), '3m 04s');
  assert.equal(M.elapsed(0, 4_320_000), '1h 12m');
  assert.equal(M.elapsed(10_000, 5_000), '0s');
  assert.equal(M.elapsed('2026-01-01T00:00:00Z', Date.parse('2026-01-01T00:01:05Z')), '1m 05s');
});

test('money and age', () => {
  assert.equal(M.formatUsd(undefined), '$0.00');
  assert.equal(M.formatUsd(0.004), '<$0.01');
  assert.equal(M.formatUsd(1.234), '$1.23');
  assert.equal(M.ago(0, 5), '');
  assert.equal(M.ago(1000, 1000 + 5 * 60_000), '5m ago');
  assert.equal(M.ago(1000, 1000 + 3 * 3600_000), '3h ago');
});

test('checksSummary takes the first non-empty line and clips', () => {
  assert.equal(M.checksSummary({}), null);
  assert.equal(M.checksSummary({ evidence: { md: '', summary: '\n  tests 12/12 pass\nmore' } }), 'tests 12/12 pass');
  assert.equal(M.checksSummary({ evidence: { md: '', summary: 'x'.repeat(200) } }, 20).length, 20);
});

test('countTasks and labelsOf', () => {
  const c = M.countTasks([task('1'), task('2', { status: 'merged' }), task('3', { status: 'cancelled' })]);
  assert.equal(c.total, 3);
  assert.equal(c.open, 1);
  assert.deepEqual(M.labelsOf([task('1', { labels: ['b', 'a'] }), task('2', { labels: ['a'] })]), ['a', 'b']);
});

test('normaliseBoard fills defaults and rejects garbage', () => {
  assert.equal(M.normaliseBoard(null), null);
  assert.equal(M.normaliseBoard({ nope: 1 }), null);
  const b = M.normaliseBoard({ project: '/p', tasks: [{ id: '1', title: 't', status: 'backlog', priority: 9 }] });
  assert.equal(b.dispatcher, 'idle');
  assert.equal(b.settings.trunk, 'main');
  assert.equal(b.tasks[0].priority, 3);
  assert.deepEqual(b.tasks[0].acceptance, []);
});

// ── diff ─────────────────────────────────────────────────────────────
const SAMPLE = [
  'diff --git a/src/a.ts b/src/a.ts',
  'index 111..222 100644',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -1,4 +1,5 @@',
  ' import x from "x";',
  '-const a = 1;',
  '+const a = 2; // changed',
  '+const b = 3;',
  ' export {};',
  '\\ No newline at end of file',
  'diff --git a/new.txt b/new.txt',
  'new file mode 100644',
  '--- /dev/null',
  '+++ b/new.txt',
  '@@ -0,0 +1,2 @@',
  '+one',
  '+two',
  'diff --git a/gone.md b/gone.md',
  'deleted file mode 100644',
  '--- a/gone.md',
  '+++ /dev/null',
  '@@ -1 +0,0 @@',
  '-bye',
  'diff --git a/old.js b/renamed.js',
  'similarity index 90%',
  'rename from old.js',
  'rename to renamed.js',
  'diff --git a/logo.png b/logo.png',
  'Binary files a/logo.png and b/logo.png differ',
  '',
].join('\n');

test('parses files, statuses, counts and line numbers', () => {
  const files = D.parseUnifiedDiff(SAMPLE);
  assert.deepEqual(files.map(f => [f.path, f.status]), [
    ['src/a.ts', 'modified'], ['new.txt', 'added'], ['gone.md', 'deleted'], ['renamed.js', 'renamed'], ['logo.png', 'modified'],
  ]);
  const a = files[0];
  assert.equal(a.added, 2);
  assert.equal(a.removed, 1);
  assert.equal(a.hunks.length, 1);
  assert.deepEqual(a.hunks[0].lines.map(l => l.kind), ['ctx', 'del', 'add', 'add', 'ctx', 'note']);
  assert.equal(a.hunks[0].lines[1].oldNo, 2);
  assert.equal(a.hunks[0].lines[2].newNo, 2);
  assert.equal(a.hunks[0].lines[4].newNo, 4);
  assert.equal(files[3].oldPath, 'old.js');
  assert.equal(files[4].binary, true);
  assert.deepEqual(D.diffTotals(files), { files: 5, added: 4, removed: 2 });
});

test('a deleted file keeps its path; a headerless single-file diff parses', () => {
  const g = D.parseUnifiedDiff(SAMPLE).find(f => f.status === 'deleted');
  assert.equal(g.path, 'gone.md');
  const bare = D.parseUnifiedDiff('--- a/x.py\n+++ b/x.py\n@@ -1 +1 @@\n-a\n+b\n');
  assert.equal(bare.length, 1);
  assert.equal(bare[0].path, 'x.py');
  assert.equal(bare[0].added, 1);
});

test('CRLF diffs and empty input', () => {
  assert.deepEqual(D.parseUnifiedDiff(''), []);
  const f = D.parseUnifiedDiff('diff --git a/a b/a\r\n--- a/a\r\n+++ b/a\r\n@@ -1 +1 @@\r\n-x\r\n+y\r\n');
  assert.equal(f[0].hunks[0].lines[1].text, 'y');
});

test('a removed line that starts with dashes is a deletion, not a header', () => {
  const f = D.parseUnifiedDiff('diff --git a/a.sql b/a.sql\n--- a/a.sql\n+++ b/a.sql\n@@ -1,2 +1,1 @@\n--- comment\n ok\n');
  assert.equal(f[0].removed, 1);
  assert.equal(f[0].hunks[0].lines[0].text, '-- comment');
});

// ── highlighter ──────────────────────────────────────────────────────
test('highlights keywords, strings, numbers and trailing comments', () => {
  const t = D.highlightLine('const a = "hi"; // note', 'ts');
  const kinds = t.map(x => x.kind ?? 'plain');
  assert.deepEqual(kinds.filter(k => k !== 'plain'), ['kw', 'str', 'com']);
  assert.equal(t.map(x => x.text).join(''), 'const a = "hi"; // note');
  assert.equal(D.highlightLine('x = 42  # n', 'py').some(x => x.kind === 'num'), true);
});

test('unknown languages stay plain and text always round-trips', () => {
  assert.deepEqual(D.highlightLine('anything here', 'zzz'), [{ text: 'anything here' }]);
  for (const line of ['if (a) { return "x\\"y"; }', 'let n = 0x1F + 2.5;', '/* open', "'unterminated"]) {
    assert.equal(D.highlightLine(line, 'ts').map(x => x.text).join(''), line);
  }
  assert.equal(D.extOf('a/b/c.test.TSX'), 'tsx');
});

// ── the chat behind a task ───────────────────────────────────────────
test('sessionOf is the real chat, never the run id', () => {
  assert.equal(M.sessionOf(task('a', { claim: { runId: 'run-1', sessionId: 'chat-1', leaseUntil: 'x' }, sessionId: 'chat-0' })), 'chat-1');
  assert.equal(M.sessionOf(task('a', { sessionId: 'chat-0' })), 'chat-0');
  assert.equal(M.sessionOf(task('a', { claim: { runId: 'run-1', leaseUntil: 'x' } })), undefined, 'a fallback-runner run has no chat');
  assert.equal(M.sessionOf(task('a')), undefined);
  assert.equal(M.sessionOf(task('a', { sessionId: '  ' })), undefined);
});

// ── a run that waits for a person ────────────────────────────────────
const need = (kind, over = {}) => ({ kind, prompt: 'Which database should I use?', since: '2026-10-09T10:00:00Z', ...over });

test('needControls picks the existing route for each kind and says why when it cannot', () => {
  assert.equal(M.needControls(task('a')), null);
  const q = M.needControls(task('a', { needs: need('question'), claim: { runId: 'r', sessionId: 's1', leaseUntil: 'x' } }));
  assert.deepEqual(q, { ok: true, kind: 'question', sessionId: 's1' });
  const p = M.needControls(task('a', { needs: need('permission', { ref: 'perm1' }), sessionId: 's2' }));
  assert.deepEqual(p, { ok: true, kind: 'permission', sessionId: 's2', ref: 'perm1' });
  const ap = M.needControls(task('a', { needs: need('approval', { ref: 'act9' }) }));
  assert.deepEqual(ap, { ok: true, kind: 'approval', ref: 'act9' }, 'a parked call needs no chat');
  assert.equal(M.needControls(task('a', { needs: need('question') })).ok, false, 'no chat, no answer box');
  assert.equal(M.needControls(task('a', { needs: need('permission'), sessionId: 's' })).ok, false, 'a permission without its id cannot be answered');
  assert.equal(M.needControls(task('a', { needs: need('approval') })).ok, false);
});

test('needs float to the top of their column without reordering the rest', () => {
  const g = M.groupTasks([
    task('a', { priority: 1 }), task('b', { priority: 2, needs: need('question') }), task('c', { priority: 3 }), task('d', { priority: 4, needs: need('permission') }),
  ]);
  assert.deepEqual(g.backlog.map(t => t.id), ['b', 'd', 'a', 'c']);
  assert.deepEqual(M.needsFirst([{ id: 1 }, { id: 2, needs: 1 }, { id: 3 }]).map(x => x.id), [2, 1, 3]);
});

test('needingYou lists open waiting tasks, longest wait first; the chip pluralises', () => {
  const ts = [
    task('a', { status: 'running', needs: need('question', { since: '2026-10-09T10:05:00Z' }) }),
    task('b', { status: 'running', needs: need('permission', { since: '2026-10-09T10:01:00Z' }) }),
    task('c', { status: 'merged', needs: need('question') }),
    task('d', { status: 'running' }),
  ];
  assert.deepEqual(M.needingYou(ts).map(t => t.id), ['b', 'a']);
  assert.equal(M.needsChipLabel(1), '1 needs you');
  assert.equal(M.needsChipLabel(3), '3 need you');
});

test('an answered wait disappears at once, a new wait does not', () => {
  const t1 = task('a', { status: 'running', needs: need('question') });
  const t2 = task('b', { status: 'running', needs: need('question', { since: '2026-10-09T11:00:00Z' }) });
  const out = M.withoutAnswered([t1, t2], { a: M.needKey(t1.needs), b: 'question::an-older-wait' });
  assert.equal(out[0].needs, undefined);
  assert.ok(out[1].needs, 'a different wait is not hidden by an old answer');
  const list = [t1];
  assert.equal(M.withoutAnswered(list, {}), list, 'nothing answered returns the same array');
  assert.ok(t1.needs, 'the input is not mutated');
});

test('clipText collapses whitespace and clips with an ellipsis', () => {
  assert.equal(M.clipText('  a   b\n c ', 20), 'a b c');
  assert.equal(M.clipText('abcdefghij', 5), 'abcd…');
  assert.equal(M.clipText('short', 5), 'short');
});

// ── batch review ─────────────────────────────────────────────────────
const rv = (id, level, over = {}) => task(id, { status: 'review', risk: level ? { score: 10, level, reasons: [] } : undefined, ...over });

test('only low-risk review tasks that nobody is waiting on can be ticked', () => {
  assert.equal(M.batchCheck(rv('a', 'low')).ok, true);
  for (const t of [rv('b', 'medium'), rv('c', 'high'), rv('d', undefined)]) {
    const c = M.batchCheck(t);
    assert.equal(c.ok, false);
    assert.match(c.hint, /Open it to approve on its own/);
    assert.ok(c.reason.length > 10);
  }
  const waiting = M.batchCheck(rv('e', 'low', { needs: need('question') }));
  assert.equal(waiting.ok, false);
  assert.match(waiting.hint, /Waiting on you/);
  assert.equal(M.batchCheck(task('f', { status: 'running', risk: { score: 1, level: 'low', reasons: [] } })).ok, false);
});

test('select all low risk never reaches a medium, high or unassessed row', () => {
  const list = M.sortForReview([rv('h', 'high'), rv('l1', 'low'), rv('m', 'medium'), rv('l2', 'low'), rv('u', undefined)]);
  assert.deepEqual(M.selectAllLow(list).sort(), ['l1', 'l2']);
});

test('selection toggles, stays in display order, and drops what is no longer eligible', () => {
  const list = [rv('a', 'low'), rv('b', 'low'), rv('c', 'medium'), rv('d', 'low')];
  let sel = M.toggleSelection([], 'd', list);
  sel = M.toggleSelection(sel, 'a', list);
  assert.deepEqual(sel, ['a', 'd'], 'display order, not click order');
  assert.deepEqual(M.toggleSelection(sel, 'a', list), ['d']);
  assert.deepEqual(M.toggleSelection(sel, 'c', list), ['a', 'd'], 'a medium row cannot be ticked');
  assert.deepEqual(M.toggleSelection(sel, 'zzz', list), ['a', 'd']);
  // b turns risky, d leaves review, a gets a question
  const later = [rv('a', 'low', { needs: need('question') }), rv('b', 'low'), rv('c', 'medium')];
  assert.deepEqual(M.pruneSelection(['a', 'b', 'd'], later), ['b']);
  assert.deepEqual(M.orderSelection(['d', 'b', 'a'], list), ['a', 'b', 'd']);
});

test('the batch button names the count', () => {
  assert.equal(M.batchButtonLabel(2), 'Approve and land 2');
  assert.equal(M.batchButtonLabel(2, true), 'Landing 2…');
});

test('a batch result says how many landed and why each other was skipped', () => {
  const ref = M.makeRef([task('a1', { createdAt: 1 }), task('b2', { createdAt: 2 }), task('c3', { createdAt: 3 })]);
  const titles = { b2: 'Round prices', c3: 'Search' };
  const all = M.summariseBatch({ landed: ['a1', 'b2'], skipped: [] }, ref, id => titles[id]);
  assert.equal(all.tone, 'ok');
  assert.equal(all.headline, 'Landed 2 tasks on the trunk.');
  const part = M.summariseBatch({ landed: ['a1'], skipped: [{ id: 'b2', reason: 'sent back: the trunk moved' }, { id: 'c3', reason: 'checks are red' }] }, ref, id => titles[id]);
  assert.equal(part.tone, 'partial');
  assert.equal(part.headline, 'Landed 1 task. 2 were skipped.');
  assert.deepEqual(part.skipped.map(s => [s.label, s.title, s.reason]), [['#2', 'Round prices', 'sent back: the trunk moved'], ['#3', 'Search', 'checks are red']]);
  const none = M.summariseBatch({ landed: [], skipped: [{ id: 'b2', reason: 'no' }] });
  assert.equal(none.tone, 'none');
  assert.equal(none.headline, 'Nothing landed. 1 was skipped.');
  assert.equal(M.summariseBatch({ landed: [], skipped: [] }).headline, 'Nothing landed.');
});

// ── releases ─────────────────────────────────────────────────────────
test('release notes group by kind with breaking changes first', () => {
  const ts = [
    { id: '1', title: 'Docs', kind: 'docs', breaking: false },
    { id: '2', title: 'Fix rounding', kind: 'fix', breaking: false },
    { id: '3', title: 'New search', kind: 'feat', breaking: false },
    { id: '4', title: 'Drop v1 API', kind: 'feat', breaking: true },
    { id: '5', title: 'Faster cart', kind: 'perf', breaking: false },
    { id: '6', title: 'Tidy', kind: 'refactor', breaking: false },
    { id: '7', title: 'CI', kind: 'chore', breaking: false },
    { id: '8', title: 'Tests', kind: 'test', breaking: false },
  ];
  const g = M.groupReleaseTasks(ts);
  assert.deepEqual(g.map(x => x.section), ['Breaking changes', 'Added', 'Fixed', 'Changed', 'Other']);
  assert.deepEqual(g.map(x => x.tasks.map(t => t.id)), [['4'], ['3'], ['2'], ['5', '6'], ['1', '7', '8']]);
  assert.deepEqual(M.groupReleaseTasks([ts[1]]).map(x => x.section), ['Fixed'], 'empty sections are left out');
  assert.deepEqual(M.groupReleaseTasks([]), []);
});

test('versions: parse, compare, normalise and validate', () => {
  assert.deepEqual(M.parseVersion('1.3.0'), [1, 3, 0]);
  assert.equal(M.parseVersion('1.3'), null);
  assert.equal(M.parseVersion('v1.3.0'), null);
  assert.equal(M.parseVersion('1.3.0-beta'), null);
  assert.ok(M.compareVersions('1.10.0', '1.9.9') > 0, 'numeric, not lexical');
  assert.equal(M.compareVersions('2.0.0', '2.0.0'), 0);
  assert.equal(M.normaliseVersionInput('  v1.4.0 '), '1.4.0');
  assert.equal(M.validateVersion('1.4.0', '1.2.0'), null);
  assert.equal(M.validateVersion('v1.4.0', '1.2.0'), null);
  assert.match(M.validateVersion('', '1.2.0'), /Enter a version/);
  assert.match(M.validateVersion('1.4', '1.2.0'), /three numbers/);
  assert.match(M.validateVersion('1.2.0', '1.2.0'), /higher than 1\.2\.0/);
  assert.match(M.validateVersion('1.1.9', '1.2.0'), /higher than 1\.2\.0/);
  assert.equal(M.validateVersion('0.0.1'), null, 'with no base any version is fine');
});

const plan = (over = {}) => ({
  trunk: 'main', versionFiles: ['package.json'], tasks: [], other: [], commitCount: 3, notes: '', blockers: [],
  next: { version: '1.3.0', bump: 'minor', reason: '2 new features' },
  deploy: { available: true, source: 'setting', command: 'node deploy.mjs' }, ...over,
});

test('creating a release is disabled with the reason, in words', () => {
  assert.equal(M.releaseCreateState(plan()).enabled, true);
  const blocked = M.releaseCreateState(plan({ blockers: ['Nothing has landed on main since v1.2.0.'] }));
  assert.equal(blocked.enabled, false);
  assert.equal(blocked.reason, 'Nothing has landed on main since v1.2.0.');
  assert.equal(M.releaseCreateState(plan({ blockers: ['a.', 'b.'] })).reason, 'a. b.');
  assert.equal(M.releaseCreateState(plan({ next: undefined })).enabled, false);
  assert.equal(M.releaseCreateState(null).enabled, false);
  assert.equal(M.releaseCreateState(plan(), 'Must be higher than 1.2.0.').reason, 'Must be higher than 1.2.0.');
});

test('deploy is offered with the engine reason when it is not available', () => {
  assert.deepEqual(M.deployAction(plan(), {}), { label: 'Deploy', enabled: true });
  assert.equal(M.deployAction(plan(), { deploy: { state: 'failed' } }).label, 'Retry deploy');
  assert.equal(M.deployAction(plan(), { deploy: { state: 'ok' } }).label, 'Deploy again');
  const running = M.deployAction(plan(), { deploy: { state: 'running' } });
  assert.equal(running.enabled, false);
  assert.equal(running.label, 'Deploying…');
  const none = M.deployAction(plan({ deploy: { available: false, source: 'none', why: 'Set a deploy command in Delivery settings.' } }), {});
  assert.equal(none.enabled, false);
  assert.equal(none.reason, 'Set a deploy command in Delivery settings.');
  assert.equal(M.deployAction(plan({ deploy: { available: false, source: 'none' } }), {}).reason.length > 0, true);
  assert.equal(M.deployAction(null, {}).enabled, false);
});

// ── notifications ────────────────────────────────────────────────────
const snap = (...tasks) => ({ boards: [{ project: '/p', name: 'shop', tasks: tasks.map(t => ({ id: t[0], title: `Task ${t[0]}`, status: t[1], needs: Boolean(t[2]), ...(t[2] ? { kind: t[2] } : {}) })) }] });

test('the first snapshot is a baseline: nothing is announced', () => {
  assert.deepEqual(M.attentionEvents(null, snap(['a', 'review', 'question'])), []);
  assert.deepEqual(M.attentionEvents(undefined, snap(['a', 'review'])), []);
});

test('attentionEvents: needs, review, merged and running->blocked, most pressing first', () => {
  const prev = snap(['a', 'running'], ['b', 'running'], ['c', 'running'], ['d', 'review'], ['e', 'ready']);
  const next = snap(['a', 'running', 'question'], ['b', 'blocked'], ['c', 'review'], ['d', 'merged'], ['e', 'ready']);
  const ev = M.attentionEvents(prev, next);
  assert.deepEqual(ev.map(e => [e.kind, e.taskId]), [['needs', 'a'], ['failed', 'b'], ['review', 'c'], ['merged', 'd']]);
  assert.equal(ev[0].needKind, 'question');
  assert.equal(ev[0].name, 'shop');
});

test('attentionEvents does not repeat what was already true, and one task gives one event', () => {
  const s = snap(['a', 'running', 'question'], ['b', 'review']);
  assert.deepEqual(M.attentionEvents(s, s), []);
  // a task that needs you AND just reached review is one event, the pressing one
  const ev = M.attentionEvents(snap(['a', 'running']), snap(['a', 'review', 'permission']));
  assert.deepEqual(ev.map(e => e.kind), ['needs']);
  // the wait changed kind: announce again
  assert.equal(M.attentionEvents(snap(['a', 'running', 'question']), snap(['a', 'running', 'permission'])).length, 1);
  // blocked from ready is not a failed run
  assert.deepEqual(M.attentionEvents(snap(['a', 'ready']), snap(['a', 'blocked'])), []);
  // a board that was not there before is not news
  assert.deepEqual(M.attentionEvents({ boards: [] }, snap(['a', 'review', 'question'])), []);
  // a task that appears already waiting is news (the question is real)
  assert.deepEqual(M.attentionEvents(snap(['z', 'ready']), snap(['z', 'ready'], ['a', 'running', 'question'])).map(e => e.taskId), ['a']);
});

test('describeAttention maps needs to the attention switch and the rest to background', () => {
  const needs = M.describeAttention({ kind: 'needs', project: '/p', name: 'shop', taskId: 'a', title: 'Add rate limiting', needKind: 'question' });
  assert.equal(needs.pref, 'attention');
  assert.equal(needs.title, 'An agent has a question');
  assert.equal(M.describeAttention({ kind: 'needs', project: '/p', name: 'shop', taskId: 'a', title: 't', needKind: 'permission' }).title, 'An agent needs your permission');
  assert.equal(M.describeAttention({ kind: 'needs', project: '/p', name: 'shop', taskId: 'a', title: 't', needKind: 'approval' }).title, 'A call is waiting for your approval');
  for (const kind of ['review', 'merged', 'failed']) {
    assert.equal(M.describeAttention({ kind, project: '/p', name: 'shop', taskId: 'a', title: 't' }).pref, 'background');
  }
  assert.equal(M.describeAttention({ kind: 'review', project: '/p', name: 'shop', taskId: 'a', title: 'T' }, true).body, 'T (shop)');
  assert.equal(M.describeAttention({ kind: 'review', project: '/p', name: 'shop', taskId: 'a', title: 'T' }, false).body, 'T');
});

test('tab strips wrap with the arrows and jump with Home and End', () => {
  assert.equal(M.nextTabIndex(3, 0, 'ArrowRight'), 1);
  assert.equal(M.nextTabIndex(3, 2, 'ArrowRight'), 0);
  assert.equal(M.nextTabIndex(3, 0, 'ArrowLeft'), 2);
  assert.equal(M.nextTabIndex(3, 1, 'Home'), 0);
  assert.equal(M.nextTabIndex(3, 1, 'End'), 2);
  assert.equal(M.nextTabIndex(3, 1, 'Enter'), null);
  assert.equal(M.nextTabIndex(0, 0, 'ArrowRight'), null);
  assert.equal(M.nextTabIndex(3, -1, 'ArrowRight'), 1, 'no selection counts as the first tab');
});

test('the "need you" filter keeps only waiting tasks', () => {
  const ts = [task('a', { status: 'running', needs: need('question') }), task('b', { status: 'running' }), task('c', { needs: need('approval', { ref: 'x' }) })];
  const g = M.groupTasks(ts, [], { onlyNeeds: true });
  assert.deepEqual([...g.running, ...g.backlog].map(t => t.id).sort(), ['a', 'c']);
  assert.equal(M.groupTasks(ts, [], { onlyNeeds: false }).running.length, 2);
});

test('release wording: why, what it is made of, empty states, files and effect', () => {
  assert.equal(M.whyLine(plan()), 'Why a minor bump: 2 new features.');
  assert.equal(M.whyLine(plan({ baseVersion: '1.2.0' })), 'Why a minor bump from 1.2.0: 2 new features.');
  assert.equal(M.whyLine(plan({ next: { version: '0.1.0', bump: 'none', reason: 'the first release (no tag and no version file yet)' } })), 'Why this version: the first release (no tag and no version file yet).');
  assert.equal(M.whyLine(plan({ next: undefined })), null);

  const t = { id: '1', title: 'x', kind: 'feat', breaking: false };
  assert.equal(M.releaseSummaryLine({ tasks: [t, t, t], other: [{ sha: 'a', subject: 's' }], lastTag: 'v1.2.0', trunk: 'main' }), '3 merged tasks and 1 other commit since v1.2.0');
  assert.equal(M.releaseSummaryLine({ tasks: [t], other: [], lastTag: undefined, trunk: 'main' }), '1 merged task on main');
  assert.equal(M.releaseSummaryLine({ tasks: [], other: [], lastTag: 'v1.2.0', trunk: 'main' }), 'Nothing new since v1.2.0');

  assert.equal(M.releaseEmpty({ tasks: [t], other: [], lastTag: 'v1' }, 1), null);
  assert.deepEqual(M.releaseEmpty({ tasks: [], other: [], lastTag: 'v1.2.0' }, 1), { title: 'Nothing new since v1.2.0', body: 'Land some tasks, then release them here.' });
  assert.equal(M.releaseEmpty({ tasks: [], other: [], lastTag: undefined }, 0).title, 'No releases yet');

  assert.deepEqual(M.releaseFiles({ versionFiles: ['package.json'] }, true), ['package.json', 'CHANGELOG.md']);
  assert.deepEqual(M.releaseFiles({ versionFiles: ['package.json'] }, false), ['package.json']);
  assert.deepEqual(M.releaseFiles({ versionFiles: [] }, false), []);
  assert.equal(M.releaseEffect('main', ['package.json']), 'Makes a commit and a local tag on main. Nothing is pushed.');
  assert.match(M.releaseEffect('main', []), /^Makes a local tag on the latest commit of main/);
});

console.log(`delivery: ${passed} passed`);
