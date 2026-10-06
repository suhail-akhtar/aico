/**
 * Unit tests for the morning brief card's pure logic (web/src/brief.ts): one
 * advisory across projects becomes one row, the sort the owner asked for
 * (severity, then how many projects), chip labels that tell two folders with
 * one name apart, the "Show N more" rule, and Fix all's one-line result.
 *
 * Why: the brief used to list the same GHSA once per project and lockfile
 * (source-map-js three times for one product), which buried the few things
 * that mattered. Also pins the card's wiring for "Start a fix", which looked
 * dead because the composer it filled was scrolled out of sight.
 *
 * Bundles its own subject with esbuild, so it runs on its own:
 *   node web/test-brief.mjs
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aico-brief-unit-'));
process.on('exit', () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } });
const outfile = path.join(tmp, 'brief.mjs');
await build({ entryPoints: [path.join(here, 'src', 'brief.ts')], bundle: true, format: 'esm', platform: 'node', outfile, logLevel: 'error' });
const B = await import(pathToFileURL(outfile).href);

let passed = 0;
const failures = [];
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); } catch (err) { failures.push(name); console.log(`  ✗ ${name}\n    ${err.message}`); }
}

const adv = (project, id, pkg, severity, fix, extra = {}) => ({
  key: `adv|${project}|${id}|${pkg}`, source: 'advisory', urgency: severity === 'critical' ? 'urgent' : 'soon', project, actions: [],
  title: `New ${severity} advisory in x: ${pkg} — T`, detail: `${id}${fix ? `; fix: ${fix}` : ''}`,
  advisory: { id, pkg, severity, title: 'T', ...(fix ? { fix } : {}) }, ...extra,
});

const items = [
  adv('/w/aetnic-ai', 'GHSA-68fv', 'source-map-js', 'high', '1.2.2'),
  adv('/w/aetnic-ai/web', 'GHSA-68fv', 'source-map-js', 'high', '1.2.2'),
  adv('/w/aetnic-ai/app', 'GHSA-68fv', 'source-map-js', 'high', '1.2.2'),
  adv('/w/shop', 'GHSA-wf6x', 'tinypool', 'high', '1.1.3'),
  adv('/w/aetnic-ai', 'GHSA-wf6x', 'tinypool', 'high', '1.1.3'),
  adv('/w/shop', 'GHSA-rp65', 'proxy-addr', 'critical', '2.0.7'),
  { key: 'git|1', source: 'git', urgency: 'fyi', title: '3 stale branches', project: '/w/shop', actions: [] },
];

test('one advisory across projects is one row; non-advisories stay in the rest', () => {
  const { groups, rest } = B.groupAdvisories(items);
  assert.equal(groups.length, 3);
  assert.equal(rest.length, 1);
  const sm = groups.find(g => g.pkg === 'source-map-js');
  assert.equal(sm.projects.length, 3);
  assert.equal(sm.fix, '1.2.2');
});

test('sorted by severity, then by number of projects, then name', () => {
  const { groups } = B.groupAdvisories(items);
  assert.deepEqual(groups.map(g => g.pkg), ['proxy-addr', 'source-map-js', 'tinypool']);
});

test('the same project twice in a group counts once; the worse severity wins', () => {
  const { groups } = B.groupAdvisories([adv('/p', 'G1', 'a', 'high'), adv('/p', 'G1', 'a', 'critical', '1.0.1', { key: 'other' })]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].projects.length, 1);
  assert.equal(groups[0].severity, 'critical');
  assert.equal(groups[0].fix, '1.0.1');
});

test('a brief stored before the structured field is still grouped (title and detail are read)', () => {
  const legacy = items.slice(0, 3).map(i => { const { advisory, ...rest } = i; return { ...rest, title: `New high advisory in x: source-map-js — Unbounded recursion`, detail: 'GHSA-68fv; fix: 1.2.2' }; });
  const { groups } = B.groupAdvisories(legacy);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].pkg, 'source-map-js');
  assert.equal(groups[0].fix, '1.2.2');
  assert.equal(groups[0].projects.length, 3);
});

test('by project: the most severe first, then the most advisories', () => {
  const { groups } = B.groupAdvisories(items);
  const rows = B.advisoryByProject(groups);
  assert.deepEqual(rows.map(r => r.path), ['/w/shop', '/w/aetnic-ai', '/w/aetnic-ai/app', '/w/aetnic-ai/web']);
  assert.equal(rows[0].advisories.length, 2);
  assert.equal(rows[1].advisories.length, 2);
});

test('chip labels: the folder name, with its parent only when two folders share a name', () => {
  const l = B.projectLabels(['/a/aetnic-ai', '/b/aetnic-ai', '/w/shop', 'C:\\w\\docs\\site']);
  assert.equal(l.get('/a/aetnic-ai'), 'a/aetnic-ai');
  assert.equal(l.get('/b/aetnic-ai'), 'b/aetnic-ai');
  assert.equal(l.get('/w/shop'), 'shop');
  assert.equal(l.get('C:\\w\\docs\\site'), 'site');
});

test('collapsed lists: show four, say how many are hidden, never hide a lone row', () => {
  const rows = [1, 2, 3, 4, 5, 6, 7];
  assert.deepEqual(B.visibleRows(rows, false), { rows: [1, 2, 3, 4], hidden: 3 });
  assert.deepEqual(B.visibleRows(rows, true), { rows, hidden: 0 });
  assert.deepEqual(B.visibleRows([1, 2, 3, 4, 5], false).hidden, 0, 'five rows: "Show 1 more" would hide nothing worth hiding');
});

test('Fix all says what started and what was skipped, and why', () => {
  const ok = B.fixSummary([
    { project: '/a', name: 'a', branch: 'b', status: 'started', agentId: 'x' },
    { project: '/b', name: 'b', branch: 'b', status: 'skipped', reason: '3 uncommitted changes — commit or stash them first' },
  ]);
  assert.match(ok, /Started 1 fix on their own branches/);
  assert.match(ok, /b \(3 uncommitted changes/);
  const none = B.fixSummary([{ project: '/b', name: 'b', branch: 'x', status: 'skipped', reason: 'not a git repository' }]);
  assert.match(none, /^Nothing was started: b \(not a git repository\)/);
});

test('the card wires Start a fix visibly: a status line, the composer scrolled into view and focused, errors shown', () => {
  const src = fs.readFileSync(path.join(here, 'src', 'components', 'BriefCard.tsx'), 'utf8');
  assert.match(src, /scrollIntoView/);
  assert.match(src, /Prompt ready in the composer/);
  assert.match(src, /catch \(err\) \{ say\('error'/, 'a failing action reports its reason');
  assert.match(src, /aria-busy=\{busy\.has/, 'a working button shows it');
  assert.match(src, /api\.briefFixPlan/, 'Fix all shows the plan before anything starts');
  assert.match(src, /role="dialog"/);
  assert.match(src, /Anything unusual waits for you/, 'the confirmation says what happens to anything unusual');
});

console.log(`\nbrief card: ${passed} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
