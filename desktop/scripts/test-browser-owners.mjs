/**
 * Who drives which browser tab — unit tests for electron/browser-owners.ts.
 *
 * Every chat and the browser copilot reach the one built-in browser through
 * the same tools; before these rules they all drove the tab in front and
 * collided. Tested here: the copilot keeps the page in front; a chat gets its
 * own background tab and is refused the person's (or another chat's) unless
 * handed it; browser_tabs shows a chat only what it may see; leases serialise
 * two drivers (wait in line, then "busy with <chat>"); a run's end releases
 * its tabs without closing them; the person's input pauses the driver.
 *
 *   node scripts/test-browser-owners.mjs
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url));
const desktop = path.resolve(here, '..');
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'aico-desk-owners-'));

async function load(entry, name) {
  const file = path.join(out, `${name}.mjs`);
  await build({ entryPoints: [entry], bundle: true, format: 'esm', platform: 'node', outfile: file, logLevel: 'error', jsx: 'automatic', external: ['react', 'react-dom', 'electron'] });
  return import(pathToFileURL(file).href);
}

let pass = 0; let fail = 0;
function ok(cond, label, detail) {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''}`); }
}

const o = await load(path.join(desktop, 'electron/browser-owners.ts'), 'owners');
const rtabs = await load(path.join(desktop, 'renderer/src/browser/tabs.ts'), 'rtabs');

const copilot = { sessionId: 'cop', copilot: true, title: 'Copilot' };
const chatA = { sessionId: 'sa', copilot: false, title: 'Fix the login' };
const chatB = { sessionId: 'sb', copilot: false, title: 'Price research' };
const alive = new Set(['u1', 'u2']);
const world = (front = 'u1') => ({ alive: (id) => alive.has(id), front });

// ── Routing ──
console.log('\nRouting');
{
  const own = new o.TabOwners();
  ok(own.route(copilot, { intent: 'act' }, world()).kind === 'front', 'the copilot acts on the tab in front');
  ok(own.route(null, { intent: 'act' }, world()).kind === 'front', 'a call that names no chat acts on the tab in front, as before');
  ok(own.route(copilot, { intent: 'openNew' }, world()).kind === 'create', 'the copilot may open a new tab');

  const first = own.route(chatA, { intent: 'act' }, world());
  ok(first.kind === 'refuse' && /no browser tab of your own yet/.test(first.message) && /browser_open/.test(first.message), 'a chat with no tab is refused the person\'s tab, told to browser_open', first);
  ok(own.route(chatA, { intent: 'open' }, world()).kind === 'create', 'a chat\'s first browser_open makes a tab of its own');

  alive.add('a1'); own.claim('a1', chatA, 1000);
  const next = own.route(chatA, { intent: 'act' }, world());
  ok(next.kind === 'tab' && next.tabId === 'a1', 'later calls with no tab named act on the chat\'s own tab', next);
  ok(own.route(chatA, { intent: 'open' }, world()).kind === 'tab', 'browser_open again navigates the chat\'s own tab (newTab makes another)');
  ok(own.route(chatA, { intent: 'openNew' }, world()).kind === 'create', 'newTab: another tab of its own');

  const theirs = own.route(chatA, { tabId: 'u1', intent: 'act' }, world());
  ok(theirs.kind === 'refuse' && /is the user's/.test(theirs.message) && /hand this tab/.test(theirs.message), 'naming the person\'s tab is refused, saying how to get it handed over', theirs);
  const others = own.route(chatB, { tabId: 'a1', intent: 'act' }, world());
  ok(others.kind === 'refuse' && /“Fix the login”/.test(others.message), 'naming another chat\'s tab is refused, naming that chat', others);
  ok(own.route(chatB, { intent: 'act' }, world()).kind === 'refuse', 'chat B does not inherit chat A\'s tab');
  const gone = own.route(chatA, { tabId: 'zz', intent: 'act' }, world());
  ok(gone.kind === 'refuse' && /no tab "zz"/.test(gone.message), 'a tab that does not exist is named as such');

  own.grant('u2', 'sb');
  const handed = own.route(chatB, { tabId: 'u2', intent: 'act' }, world());
  ok(handed.kind === 'tab' && handed.tabId === 'u2', 'a tab the person handed to a chat may be driven by it');
  const handedDefault = own.route(chatB, { intent: 'act' }, world());
  ok(handedDefault.kind === 'tab' && handedDefault.tabId === 'u2', 'with no tab of its own, a chat\'s calls go to the tab handed to it');
  ok(own.route(chatA, { tabId: 'u2', intent: 'act' }, world()).kind === 'refuse', 'the hand-over is to that chat only');
  alive.add('a1');
  ok(own.route(copilot, { tabId: 'a1', intent: 'act' }, world()).kind === 'tab', 'the copilot may name any tab (leases still apply)');

  alive.add('a2'); own.claim('a2', chatA, 2000);
  ok(own.current('sa', world()) === 'a2', 'the newest tab a chat opened becomes its current one');
  own.use('a1', 'sa');
  ok(own.current('sa', world()) === 'a1', 'switching (browser_select_tab) makes that its current tab');
  alive.delete('a1');
  ok(own.current('sa', world()) === 'a2', 'a closed current tab falls back to the chat\'s newest live one');
  own.forget('a1');
  ok(!own.ownerOf('a1'), 'a closed tab is forgotten');
}

// ── What a chat sees ──
console.log('\nbrowser_tabs');
{
  const own = new o.TabOwners();
  own.claim('a1', chatA); own.claim('b1', chatB); own.grant('u2', 'sa');
  const ids = ['u1', 'u2', 'a1', 'b1'];
  const seen = own.visible(chatA, ids, 'u1');
  const by = Object.fromEntries(seen.map(v => [v.id, v]));
  ok(seen.length === 3 && !by.b1, 'a chat sees its tabs, those handed to it and the tab in front — not another chat\'s', seen.map(v => v.id));
  ok(by.a1.yours && !by.a1.readOnly, 'its own tab is marked yours');
  ok(by.u2.handedToYou && !by.u2.readOnly, 'a handed-over tab is marked as such');
  ok(by.u1.userFront && by.u1.readOnly, 'the person\'s tab in front is listed read-only');
  ok(own.visible(copilot, ids, 'u1').length === 4 && own.visible(copilot, ids, 'u1').find(v => v.id === 'b1').owner === 'Price research', 'the copilot sees every tab, with who opened it');
  ok(own.mayClose(chatA, 'a1') && !own.mayClose(chatA, 'u2') && !own.mayClose(chatA, 'u1') && !own.mayClose(chatA, 'b1'), 'a chat may close only tabs it opened (not one handed over, not the person\'s)');
}

// ── Released ──
console.log('\nA run ends');
{
  const own = new o.TabOwners();
  own.claim('a1', chatA);
  ok(own.activeSessions().includes('sa'), 'a chat with a live tab is active');
  ok(own.release('sa').join() === 'a1' && own.ownerOf('a1').released, 'its run ends: the tab stays, marked released');
  ok(own.release('sa').length === 0, 'releasing twice changes nothing');
  ok(!own.activeSessions().includes('sa'), 'a released chat holds no tab');
  own.use('a1', 'sa');
  ok(!own.ownerOf('a1').released, 'the chat\'s next run picks its tab up again');
  ok(own.rename('sa', 'Fix the login page') && own.ownerOf('a1').title === 'Fix the login page', 'a rename reaches the badge');
}

// ── Leases ──
console.log('\nLeases');
{
  let now = 0;
  const leases = new o.TabLeases({ idleMs: 1000, waitMs: 3000, now: () => now, sleep: async (ms) => { now += ms; await null; }, pollMs: 100 });
  const A = { sessionId: 'sa', title: 'Fix the login' };
  const B = { sessionId: 'sb', title: 'Price research' };
  const C = { sessionId: 'sc', title: 'Third' };

  const a1 = await leases.acquire('t', A);
  ok(a1.ok && leases.holder('t').sessionId === 'sa', 'the first driver takes the tab');
  const a2 = await leases.acquire('t', A);
  ok(a2.ok, 'the same chat may make another call (even in parallel)');
  a2.release();
  a1.release();
  now += 500;
  ok(leases.holder('t')?.sessionId === 'sa', 'between its calls (thinking) the chat keeps the tab');

  const t0 = now;
  const b = await leases.acquire('t', B);
  ok(b.ok && now - t0 >= 500 && now - t0 <= 700, 'a second chat waits until the first has been idle long enough, then drives', now - t0);
  ok(leases.holder('t').sessionId === 'sb', 'the lease is now the second chat\'s');

  // B holds a call open: A waits the whole time, then is told who has it.
  const t1 = now;
  const late = await leases.acquire('t', A);
  ok(!late.ok && late.busyWith.title === 'Price research' && now - t1 >= 3000, 'while a call is in flight another chat waits its bounded time, then hears "busy with" the driver', { waited: now - t1, late });
  const msg = o.busyMessage('t', late.busyWith);
  ok(/busy/.test(msg) && /“Price research”/.test(msg) && /Nothing was done/.test(msg), 'the busy answer names the chat and says nothing was done', msg);
  b.release();

  // First come, first served.
  const holdA = await leases.acquire('q', A);
  const order = [];
  const pB = leases.acquire('q', B).then(r => { order.push('B'); return r; });
  await null; await null;
  const pC = leases.acquire('q', C).then(r => { order.push('C'); return r; });
  holdA.release();
  const rB = await pB;
  ok(rB.ok && order[0] === 'B', 'waiters are served in the order they came', order);
  rB.release();
  const rC = await pC;
  ok(rC.ok && order.join() === 'B,C', 'the next waiter follows once the tab is free', order);
  rC.release();

  const r = await leases.acquire('x', A);
  leases.releaseSession('sa');
  ok(leases.holder('x')?.sessionId === 'sa', 'a run ending does not snatch a call in flight');
  r.release();
  ok(!leases.holder('x'), '…and the lease goes as soon as it finishes');
  const r2 = await leases.acquire('y', A); r2.release();
  leases.drop('y');
  ok(!leases.holder('y'), 'the person taking a tab back drops its lease');
}

// ── The person wins ──
console.log('\nThe person takes over');
{
  ok(o.personTookOver({ driving: true, held: true, agentInputAt: 0, now: 10_000 }), 'a click while an agent drives the tab pauses it');
  ok(!o.personTookOver({ driving: true, held: true, agentInputAt: 9_800, now: 10_000 }), 'the agent\'s own trusted click is not the person');
  ok(!o.personTookOver({ driving: false, held: true, agentInputAt: 0, now: 10_000 }), 'input on a tab nobody is driving pauses nothing');
  ok(!o.personTookOver({ driving: true, held: false, agentInputAt: 0, now: 10_000 }), 'nor on a tab no chat holds');
}

// ── Badges ──
console.log('\nBadges');
{
  const h = o.ownerHue('sa');
  ok(h === o.ownerHue('sa') && h >= 30 && h <= 330, 'a chat\'s colour is stable and never warning-red', h);
  const hues = new Set(['s1', 's2', 's3', 's4', 's5', 's6'].map(o.ownerHue));
  ok(hues.size >= 3, 'different chats mostly get different colours', [...hues]);
  ok(rtabs.ownerLine({ owner: { title: 'Fix the login', hue: 90 }, driver: 'Fix the login' }) === 'Opened by the chat “Fix the login” — working now', 'tooltip: who opened it, working now');
  ok(/finished/.test(rtabs.ownerLine({ owner: { title: 'X', hue: 90, released: true } })), 'tooltip: a released tab says the chat finished');
  ok(/paused/.test(rtabs.ownerLine({ owner: { title: 'X', hue: 90 }, driver: 'X', agentPaused: true })), 'tooltip: a paused tab says so');
  ok(rtabs.ownerLine({}) === '', 'the person\'s own tab has no owner line');
}

fs.rmSync(out, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
