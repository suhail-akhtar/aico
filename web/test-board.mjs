/**
 * Unit tests for the design board viewer's pure logic (shared/ui/board,
 * ADR 0037): the canvas layout (sections stacked, frames in a row, the same
 * every time), the camera (zoom keeps the point under the pointer, fit shows
 * everything, steps), which frames get a live page, hit testing, Play's
 * scale, and screen composition (inlined assets, the navigation script, no
 * reading outside the board).
 *
 * Bundles its own subjects with esbuild, so it runs on its own:
 *   node web/test-board.mjs
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aico-board-unit-'));
async function load(name) {
  const outfile = path.join(tmp, `${name}.mjs`);
  await build({ entryPoints: [path.join(here, '..', 'shared', 'ui', 'board', `${name}.ts`)], bundle: true, format: 'esm', platform: 'node', outfile, logLevel: 'error' });
  return import(pathToFileURL(outfile).href);
}
const M = await load('board-model');
const C = await load('board-compose');

let passed = 0;
const failures = [];
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ok    ${name}`); } catch (err) { failures.push(name); console.log(`  FAIL  ${name}\n        ${err.message.split('\n').join('\n        ')}`); }
}

const { board } = M.parseBoard({
  title: 'Notes',
  sections: [
    { title: 'Today', frames: [{ id: 'a', title: 'A', file: 'A.html', device: 'desktop' }, { id: 'b', title: 'B', file: 'B.html', device: 'mobile', note: 'empty state' }] },
    { title: 'Workspace', frames: [{ id: 'c', title: 'C', file: 'C.html', device: 'laptop' }] },
  ],
});

console.log('\n── Layout ──');
await test('frames sit in a row per section, sections stack, top edges align', () => {
  const L = M.layoutBoard(board);
  const [a, b, c] = L.frames;
  assert.equal(a.y, b.y);
  assert.equal(b.x, a.x + a.w + M.LAYOUT.gap);
  assert.ok(c.y > a.y + a.h, 'the next section starts below the tallest frame');
  assert.equal(L.sections.length, 2);
  assert.ok(L.sections[1].y >= L.sections[0].y + L.sections[0].h + M.LAYOUT.sectionGap);
  assert.ok(L.bounds.w >= a.w + b.w + M.LAYOUT.gap && L.bounds.h >= c.y + c.h);
});
await test('a section with notes reserves room for them', () => {
  const L = M.layoutBoard(board);
  assert.ok(L.sections[0].h >= M.LAYOUT.heading + M.LAYOUT.label + 900 + M.LAYOUT.noteSpace);
});
await test('deterministic: the same board lands in the same place', () => {
  assert.deepEqual(M.layoutBoard(board), M.layoutBoard(JSON.parse(JSON.stringify(board))));
});
await test('reading order is section by section, left to right', () => {
  assert.equal(M.orderedFrames(board).map(f => f.id).join(), 'a,b,c');
});

console.log('\n── Camera ──');
await test('toWorld inverts toScreen', () => {
  const cam = { x: 300, y: -40, k: 0.37 };
  const [sx, sy] = M.toScreen(cam, 1200, 800, 512, 77);
  const [wx, wy] = M.toWorld(cam, 1200, 800, sx, sy);
  assert.ok(Math.abs(wx - 512) < 1e-9 && Math.abs(wy - 77) < 1e-9);
});
await test('zoomAt keeps the world point under the pointer', () => {
  const cam = { x: 100, y: 100, k: 0.5 };
  const before = M.toWorld(cam, 1000, 600, 830, 120);
  const next = M.zoomAt(cam, 1000, 600, 830, 120, 1.5);
  const after = M.toWorld(next, 1000, 600, 830, 120);
  assert.equal(next.k, 1.5);
  assert.ok(Math.abs(before[0] - after[0]) < 1e-9 && Math.abs(before[1] - after[1]) < 1e-9);
});
await test('zoom is clamped', () => {
  assert.equal(M.zoomAt({ x: 0, y: 0, k: 1 }, 100, 100, 50, 50, 99).k, M.ZOOM_MAX);
  assert.equal(M.zoomAt({ x: 0, y: 0, k: 1 }, 100, 100, 50, 50, 0).k, M.ZOOM_MIN);
});
await test('stepZoom walks the fixed levels both ways', () => {
  assert.equal(M.stepZoom(0.25, 1), 0.33);
  assert.equal(M.stepZoom(0.25, -1), 0.15);
  assert.equal(M.stepZoom(0.3, 1), 0.33);
  assert.equal(M.stepZoom(4, 1), M.ZOOM_MAX);
});
await test('fitRect shows the whole board inside the view and never zooms past 100%', () => {
  const L = M.layoutBoard(board);
  const cam = M.fitRect(L.bounds, 1440, 860, 56, 1);
  const v = M.viewRect(cam, 1440, 860);
  assert.ok(v.x <= L.bounds.x && v.y <= L.bounds.y && v.x + v.w >= L.bounds.x + L.bounds.w && v.y + v.h >= L.bounds.y + L.bounds.h);
  assert.equal(M.fitRect({ x: 0, y: 0, w: 10, h: 10 }, 1000, 1000).k, 1);
});
await test('panBy moves the view with the pointer', () => {
  const cam = M.panBy({ x: 0, y: 0, k: 0.5 }, 100, -50);
  assert.deepEqual([cam.x, cam.y], [-200, 100]);
});

console.log('\n── Which frames are live, hit testing, Play ──');
await test('only frames in or near the view are mounted, nearest first, capped', () => {
  const L = M.layoutBoard(board);
  const a = L.frames[0];
  const close = M.framesToMount(L, { x: a.x + a.w / 2, y: a.y + a.h / 2, k: 1 }, 800, 600);
  assert.equal(close[0], 'a');
  assert.ok(!close.includes('c'), 'the next section, far below at 100%, stays a placeholder');
  const all = M.framesToMount(L, M.fitRect(L.bounds, 1400, 900), 1400, 900);
  assert.equal(all.length, 3);
  assert.equal(M.framesToMount(L, M.fitRect(L.bounds, 1400, 900), 1400, 900, 2).length, 2);
});
await test('a 40-screen board mounts at most twelve pages', () => {
  const big = M.parseBoard({ title: 'Big', sections: Array.from({ length: 4 }, (_, s) => ({ title: `S${s}`, frames: Array.from({ length: 10 }, (_, i) => ({ id: `f${s}-${i}`, title: `F${i}`, file: `F${s}-${i}.html`, device: 'mobile' })) })) }).board;
  const L = M.layoutBoard(big);
  assert.equal(M.orderedFrames(big).length, 40);
  assert.equal(M.framesToMount(L, M.fitRect(L.bounds, 1400, 900), 1400, 900).length, 12);
});
await test('frameAt finds the frame under a point, and nothing between frames', () => {
  const L = M.layoutBoard(board);
  const b = L.frames[1];
  assert.equal(M.frameAt(L, b.x + 5, b.y + 5), 'b');
  assert.equal(M.frameAt(L, b.x - M.LAYOUT.gap / 2, b.y + 5), undefined);
});
await test('playScale fits a screen into the stage and never enlarges it', () => {
  assert.equal(M.playScale(390, 844, 1400, 900), 1);
  assert.ok(Math.abs(M.playScale(1440, 900, 1200, 800) - 1200 / 1440) < 1e-9);
});

console.log('\n── Composition ──');
const files = {
  'styles.css': '@import "base.css"; body{background:url(img/bg.png)}',
  'base.css': ':root{--accent:#0a7}',
  'img/bg.png': 'PNG',
  'img/logo.svg': '<svg/>',
  'app.js': 'window.x=1;</script><script>alert(1)',
  'screens/A.html': '<!doctype html><html><head><link rel="stylesheet" href="../styles.css"><script src="../app.js"></script></head><body><img src="../img/logo.svg"><a href="../B.html">B</a></body></html>',
};
const asked = [];
const reader = {
  text: async (p) => { asked.push(p); return files[p]; },
  dataUrl: async (p) => { asked.push(p); return files[p] === undefined ? undefined : `data:${C.boardMime(p)};base64,${Buffer.from(files[p]).toString('base64')}`; },
};
await test('stylesheets (and one @import), scripts and pictures are inlined from paths relative to the screen', async () => {
  const doc = await C.composeScreen(files['screens/A.html'], 'screens/A.html', reader, { navigation: true, csp: true });
  assert.ok(doc.includes('--accent:#0a7') && doc.includes('url("data:image/png;base64,'));
  assert.ok(doc.includes('<img src="data:image/svg+xml;base64,'));
  assert.ok(!/<script src=/.test(doc) && doc.includes('window.x=1;<\\/script>'), 'an inlined script cannot close its own tag');
  assert.ok(doc.includes("aicoBoard:'nav'") && doc.indexOf("aicoBoard:'nav'") < doc.lastIndexOf('</body>'));
  assert.ok(/<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' https:\/\/cdnjs/.test(doc));
});
await test('nothing outside the board is ever asked for', async () => {
  asked.length = 0;
  await C.composeScreen('<link rel="stylesheet" href="../../x.css"><img src="/etc/passwd"><img src="https://x.io/a.png"><script src="//cdn.x/a.js"></script>', 'A.html', reader, { navigation: false, csp: false });
  assert.deepEqual(asked, []);
});
await test('a fragment becomes a document; a download has no script or CSP added', async () => {
  const doc = await C.composeScreen('<p>Hi</p>', 'A.html', reader, { navigation: false, csp: false });
  assert.ok(/^<!doctype html><html><head><meta charset="utf-8">/.test(doc) && !/script|Content-Security/.test(doc));
});
await test('a missing stylesheet leaves a comment, not a broken page', async () => {
  const doc = await C.composeScreen('<html><head><link rel="stylesheet" href="nope.css"></head><body></body></html>', 'A.html', reader, { navigation: false, csp: false });
  assert.ok(doc.includes('<!-- missing stylesheet: nope.css -->'));
});
await test('bytesToBase64 matches Buffer for large inputs', () => {
  const bytes = new Uint8Array(100_000).map((_, i) => (i * 31) & 255);
  assert.equal(C.bytesToBase64(bytes), Buffer.from(bytes).toString('base64'));
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
