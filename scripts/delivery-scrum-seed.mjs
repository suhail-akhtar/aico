/**
 * A Scrum board to look at: the Delivery seed's shop project, switched to Scrum, with two
 * closed sprints (so velocity and a default capacity exist), a running sprint half-way
 * through (so the burndown has a shape, a scope step and a pace), estimates on most of
 * the backlog and a few suggestions from "the agent". For photographing the screens
 * without a model.
 *
 *   node scripts/delivery-seed.mjs <outDir>          # the base board (git repo, tasks in every state)
 *   node scripts/delivery-scrum-seed.mjs <outDir>    # this: Scrum on top of it
 *   AICO_HOME=<outDir>/.aico node dist/index.js serve --port 7340
 *
 * WHY RAW JOURNAL LINES FOR THE PAST. The store's writers stamp events with the current
 * time, which is right for the engine and useless for a sprint that started a week ago.
 * The journal is the board (ADR 0001), so appending events with chosen `at` values is the
 * same thing history would have left behind; the fold reads them as it reads real ones.
 * Nothing here starts a run, calls a model or touches the real ~/.aico.
 *
 * @module scripts/delivery-scrum-seed
 */

import './lib/test-home.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const outDir = fs.realpathSync.native(path.resolve(process.argv[2] ?? path.join(os.tmpdir(), 'aico-delivery-live')));
const home = path.join(outDir, '.aico');
const project = path.join(outDir, 'shop');
if (!fs.existsSync(path.join(home, 'settings.json'))) throw new Error(`run scripts/delivery-seed.mjs ${outDir} first`);
process.env.AICO_HOME = home;

const { DeliveryStore: S, ScrumModel: M } = await import('../dist-test/test-exports.js');

const DAY = 86_400_000;
const today = M.dayKey(Date.now(), 0);
const at = (key, hour = 12) => `${key}T${String(hour).padStart(2, '0')}:00:00.000Z`;
const back = (key, workdays) => { let k = key; let n = 0; while (n < workdays) { k = M.addDays(k, -1); if (M.isWorkday(k)) n++; } return k; };
const forward = (key, n) => { let k = key; for (let i = 0; i < n; i++) k = M.addDays(k, 1); return k; };
const weekday = (key) => { let k = key; while (!M.isWorkday(k)) k = M.addDays(k, -1); return k; };

// The three sprints: the running one began four working days ago; the two before it ran fortnights back to back.
const s3Start = back(weekday(today), 4);
const s3End = (() => { let k = M.addDays(s3Start, 13); while (!M.isWorkday(k)) k = M.addDays(k, -1); return k; })();
const s2End = back(s3Start, 1); const s2Start = back(s2End, 9);
const s1End = back(s2Start, 1); const s1Start = back(s1End, 9);

const lines = [];
const ev = (when, e) => lines.push({ t: 'scrum', at: when, ev: e });
const base = S.boardState(project);
const byTitle = (needle) => base.tasks.find(t => t.title.includes(needle));

// ── earlier sprints: tasks that already landed, written as history ───────
const landed = (id, title, pts, when, over = {}) => ({
  t: 'task', at: at(s1Start, 8),
  task: {
    id, project, title, body: '', acceptance: [], status: 'merged', priority: 3, dependsOn: [], labels: [], createdAt: at(s1Start, 8), updatedAt: when,
    landed: { from: 'a', to: 'b', at: when, kind: 'feat', breaking: false, by: 'person' }, evidence: { md: '', summary: `Checks passed: test. ${pts} points.` }, costUsd: 0.5 + pts * 0.12, ...over,
  },
});
const history = [
  ['5a000001', 'Product listing page', 5, back(s1End, 6)], ['5a000002', 'Cart totals', 3, back(s1End, 4)], ['5a000003', 'Search by name', 5, back(s1End, 2)], ['5a000004', 'Order confirmation email', 3, back(s1End, 1)],
  ['5b000001', 'Checkout form', 8, back(s2End, 7)], ['5b000002', 'Address validation', 3, back(s2End, 5)], ['5b000003', 'Payment retry', 5, back(s2End, 3)], ['5b000004', 'Receipt PDF', 2, back(s2End, 1)],
];
for (const [id, title, pts, day] of history) lines.push(landed(id, title, pts, at(day, 15)));
// One that did not make it: carried out of sprint 2 and back into the backlog.
lines.push({ t: 'task', at: at(s1Start, 8), task: { id: '5b000009', project, title: 'Gift wrap option', body: '', acceptance: [], status: 'backlog', priority: 3, dependsOn: [], labels: [], createdAt: at(s1Start, 8), updatedAt: at(s2End, 17) } });

ev(at(back(s1Start, 2), 9), { k: 'sprint', id: '51000001', name: 'Sprint 1', goal: 'Browse and buy', start: s1Start, end: s1End });
for (const [id, , pts] of history.slice(0, 4)) ev(at(back(s1Start, 1), 10), { k: 'estimate', task: id, points: pts });
ev(at(back(s1Start, 1), 11), { k: 'commit', sprint: '51000001', add: history.slice(0, 4).map(h => h[0]), remove: [] });
ev(at(s1Start, 8), { k: 'start', sprint: '51000001' });
ev(at(s1End, 17), { k: 'close', sprint: '51000001' });

ev(at(back(s2Start, 2), 9), { k: 'sprint', id: '52000001', name: 'Sprint 2', goal: 'Checkout that does not lose orders', start: s2Start, end: s2End });
for (const [id, , pts] of history.slice(4)) ev(at(back(s2Start, 1), 10), { k: 'estimate', task: id, points: pts });
ev(at(back(s2Start, 1), 10), { k: 'estimate', task: '5b000009', points: 3 });
ev(at(back(s2Start, 1), 11), { k: 'commit', sprint: '52000001', add: [...history.slice(4).map(h => h[0]), '5b000009'], remove: [] });
ev(at(s2Start, 8), { k: 'start', sprint: '52000001' });
ev(at(s2End, 17), { k: 'close', sprint: '52000001' });

// ── the running sprint: seeded board tasks, estimated ────────────────────
const members = [
  ['Add a wishlist page', 5, at(forward(s3Start, 1), 14)], ['Fix a double charge', 5, at(forward(s3Start, 2), 11)], ['Speed up product search', 3, at(back(today, 1), 16)],
  ['Fix rounding', 2], ['Trim whitespace', 1], ['Paginate the order history', 2], ['Rotate the session token', 3], ['Handle an empty cart', 2],
  ['Persist the cart', 5], ['Validate discount codes', 3], ['Rate-limit the login', 2],
];
ev(at(back(s3Start, 2), 9), { k: 'sprint', id: '53000001', name: 'Sprint 3', goal: 'Ship a checkout customers trust', start: s3Start, end: s3End, capacityPoints: 34 });
const ids = [];
for (const [needle, pts, mergedAt] of members) {
  const t = byTitle(needle);
  if (!t) throw new Error(`seed task not found: ${needle}`);
  ids.push(t.id);
  ev(at(back(s3Start, 1), 10), { k: 'estimate', task: t.id, points: pts });
  if (mergedAt) lines.push({ t: 'patch', at: mergedAt, id: t.id, set: { landed: { ...(t.landed ?? { from: 'a', to: 'b', kind: 'feat', breaking: false, by: 'person' }), at: mergedAt } } });
}
ev(at(back(s3Start, 1), 12), { k: 'commit', sprint: '53000001', add: ids, remove: [] });
ev(at(s3Start, 8), { k: 'start', sprint: '53000001' });
// Scope that moved on day three, and a carried-over item that came back.
const stock = byTitle('Show stock level');
ev(at(forward(s3Start, 2), 9), { k: 'estimate', task: stock.id, points: 2 });
ev(at(forward(s3Start, 2), 9), { k: 'commit', sprint: '53000001', add: [stock.id], remove: [] });

// ── the rest of the backlog: sized, half-sized, and not at all ───────────
const sized = [['Add a gift-card payment method', 8], ['Localise the checkout copy', 3], ['Move to the new payments SDK', 13]];
for (const [needle, pts] of sized) ev(at(back(today, 1), 9), { k: 'estimate', task: byTitle(needle).id, points: pts });
ev(at(today, 8), { k: 'estimate', task: '5b000009', points: 3 });
const gift = byTitle('gift-card');
ev(at(today, 9), { k: 'proposal', proposal: { id: '9a000001', kind: 'estimate', taskId: byTitle('Localise').id, at: at(today, 9), status: 'open', points: 5, note: 'Strings live in four files and two need plural rules.' } });
ev(at(today, 9), { k: 'proposal', proposal: { id: '9a000002', kind: 'split', taskId: byTitle('payments SDK').id, at: at(today, 9), status: 'open', note: '13 points is more than the sprint can hold alongside other work.', parts: [
  { title: 'Wrap the new payments SDK behind our client interface', points: 5, acceptance: ['The legacy client and the SDK pass the same contract tests'] },
  { title: 'Move card payments to the new SDK', points: 5, acceptance: ['Card payments use the SDK in staging'] },
  { title: 'Remove the legacy payments client', points: 3, acceptance: ['No import of the legacy client remains'] },
] } });
ev(at(today, 9), { k: 'proposal', proposal: { id: '9a000003', kind: 'criteria', taskId: gift.id, at: at(today, 9), status: 'open', acceptance: ['A gift card code is validated against the issuer', 'A partly covered order asks for another payment method', 'A used card cannot be reused'] } });
ev(at(today, 8), { k: 'mode', mode: 'scrum' });

// Tasks the base seed left cancelled/blocked stay as they are. Append in order: history first, then the live sprint.
const file = S.journalFile(project);
fs.appendFileSync(file, lines.map(l => JSON.stringify(l)).join('\n') + '\n', 'utf8');
S.resetStoreCache();
const b = S.boardState(project);
const s3 = b.sprints.find(s => s.id === '53000001');
const bd = M.burndown(s3, b.tasks, Date.now(), 0);
console.log(`Scrum seeded: ${b.sprints.length} sprints, mode ${b.settings.mode}.`);
console.log(`  sprint 3 ${s3.start} to ${s3.end}: committed ${bd.committed}, done ${bd.done}, scope ${bd.scope}, remaining ${bd.remaining}, ${bd.status}`);
console.log(`  velocity ${JSON.stringify(M.velocity(b.sprints).rows.map(r => [r.name, r.committed, r.completed]))}`);
process.exit(0);
