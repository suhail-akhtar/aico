/**
 * Unit tests for the inline "Ask AICO" editor's own logic (ADR 0024): placing
 * a page selection in a block's Markdown (`locateSelection`), the quick
 * actions offered per kind of part, and the review diffs — the parts of
 * `InlineEdit.tsx` / `DocPage.tsx` that are pure and decide what the person
 * sees and what gets replaced.
 *
 * Bundles its own subjects with esbuild, so it runs on its own:
 *   node web/test-inline-edit.mjs
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aico-inline-unit-'));
async function load(name) {
  const outfile = path.join(tmp, `${name}.mjs`);
  await build({ entryPoints: [path.join(here, '..', 'shared', 'ui', 'canvas', `${name}.ts`)], bundle: true, format: 'esm', platform: 'node', outfile, logLevel: 'error' });
  return import(pathToFileURL(outfile).href);
}
const S = await load('scoped-edit');
const D = await load('scoped-diff');
const B = await load('blocks');

let pass = 0;
let fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (err) { fail++; console.log(`  ✗ ${name}\n      ${err.message.split('\n').join('\n      ')}`); }
}

console.log('\n══ Inline AI edit: selections, actions, diffs ══');

test('a plain selection is found exactly', () => {
  const src = 'The platform will route feedback within 15 minutes.';
  assert.deepEqual(S.locateSelection(src, 'route feedback'), { start: 18, end: 32 });
});
test('a selection across bold text maps to the source with its marks', () => {
  const src = 'Route it within **15 minutes** of arrival.';
  const r = S.locateSelection(src, 'within 15 minutes of');
  assert.equal(src.slice(r.start, r.end), 'within **15 minutes** of');
});
test('a selection that ends inside bold is widened to keep the marks whole', () => {
  const src = 'Route it within **15 minutes** of arrival.';
  const r = S.locateSelection(src, 'it within 15');
  assert.equal(src.slice(r.start, r.end), 'it within **15 minutes**');
});
test('link text selected takes the whole link', () => {
  const src = 'See the [published API](https://x.example/docs) for details.';
  const r = S.locateSelection(src, 'published API');
  assert.equal(src.slice(r.start, r.end), '[published API](https://x.example/docs)');
});
test('a selection across list items skips the markers', () => {
  const src = '- Ingest email\n- Route chat\n- Report';
  const r = S.locateSelection(src, 'Ingest email\nRoute chat');
  assert.equal(src.slice(r.start, r.end), 'Ingest email\n- Route chat');
});
test('an ambiguous or missing selection is not guessed', () => {
  assert.equal(S.locateSelection('the cat and the cat', 'the cat'), null);
  assert.equal(S.locateSelection('nothing here', 'missing words'), null);
});
test('a located selection resolves as a range target', () => {
  const doc = '# T\n\nIt dose not include **the POS** system.\n';
  const b = B.splitBlocks(doc)[1];
  const key = B.blockKeys(B.splitBlocks(doc))[1];
  const range = S.locateSelection(b.text, 'dose not include the');
  const r = S.resolveTarget(doc, { blockIds: [key], range });
  assert.equal(r.ok, true);
  assert.equal(r.part.editable.slice(r.part.selection.start, r.part.selection.end), 'dose not include **the POS**');
});

test('quick actions fit the part', () => {
  const ids = (p) => S.partActions(p).map(a => a.id).join(',');
  assert.match(ids({ kind: 'text', what: 'paragraph' }), /grammar,shorten,expand,formal,simplify,translate,table,list/);
  assert.doesNotMatch(ids({ kind: 'text', what: 'paragraph', selection: { start: 0, end: 3 } }), /table/);
  assert.match(ids({ kind: 'table', what: 'table' }), /column,row,sort/);
  assert.match(ids({ kind: 'chart', what: 'bar chart' }), /line,bar,pie,series/);
  assert.match(ids({ kind: 'mermaid', what: 'flowchart diagram' }), /simplify,node/);
  const ask = S.partActions({ kind: 'table', what: 'table' }).filter(a => a.ask).map(a => a.id);
  assert.deepEqual(ask, ['column', 'row', 'sort'], 'actions that need a word open the box prefilled');
});
test('every quick action is worded so the validator allows what it asks', () => {
  const allow = (inst, key) => S.intentOf([inst])[key];
  const t = S.partActions({ kind: 'table', what: 'table' });
  assert.ok(allow(t.find(a => a.id === 'column').instruction + 'Owner', 'columns'));
  assert.ok(allow(t.find(a => a.id === 'row').instruction + 'Q3', 'rows'));
  assert.ok(allow(t.find(a => a.id === 'sort').instruction + 'priority', 'sort'));
  assert.ok(allow(t.find(a => a.id === 'chart').instruction, 'convert'));
  const c = S.partActions({ kind: 'chart', what: 'bar chart' });
  assert.ok(allow(c.find(a => a.id === 'line').instruction, 'chartType'));
  assert.ok(!allow(c.find(a => a.id === 'line').instruction, 'data'), 'changing the type never licenses changing the data');
  assert.ok(allow(c.find(a => a.id === 'series').instruction + '2025', 'data'));
  const p = S.partActions({ kind: 'text', what: 'paragraph' });
  assert.ok(allow(p.find(a => a.id === 'grammar').instruction, 'strict'));
  assert.ok(allow(p.find(a => a.id === 'table').instruction, 'convert'));
  assert.ok(allow(p.find(a => a.id === 'shorten').instruction, 'shorten'));
});

test('word diff marks only changed words and round-trips', () => {
  const a = 'We will deliver the platform in 14 weeks.';
  const b = 'We will deliver the platform within 14 weeks.';
  const d = D.wordDiff(a, b);
  assert.deepEqual(d.filter(x => x.op !== '=').map(x => `${x.op}${x.text}`), ['-in', '+within']);
  assert.equal(d.filter(x => x.op !== '+').map(x => x.text).join(''), a);
  assert.equal(d.filter(x => x.op !== '-').map(x => x.text).join(''), b);
});
test('word diff of a large input degrades instead of hanging', () => {
  const a = Array.from({ length: 3000 }, (_, i) => `a${i}`).join(' ');
  const b = Array.from({ length: 3000 }, (_, i) => `b${i}`).join(' ');
  const t = Date.now();
  const d = D.wordDiff(a, b);
  assert.ok(Date.now() - t < 2000);
  assert.equal(d.filter(x => x.op !== '+').map(x => x.text).join(''), a);
});
test('table diff: changed cells, added rows, removed rows', () => {
  const a = { align: [], header: ['Measure', 'Target'], rows: [['Availability', '99.9%'], ['Routing', '15 min'], ['Support', '4 h']] };
  const b = { align: [], header: ['Measure', 'Target'], rows: [['Availability', '99.9%'], ['Routing', '10 min'], ['Refresh', '5 min']] };
  const d = D.tableDiff(a, b);
  assert.equal(d.rows[0].state, 'same');
  assert.equal(d.rows[1].cells[1].state, 'changed');
  assert.equal(d.rows[1].cells[1].was, '15 min');
  assert.equal(d.rows[2].state, 'changed');
  assert.deepEqual(d.removedRows, []);
  const e = D.tableDiff(a, { ...a, rows: a.rows.slice(0, 2) });
  assert.deepEqual(e.removedRows, [['Support', '4 h']]);
});

console.log(`\n${pass} passed, ${fail} failed`);
fs.rmSync(tmp, { recursive: true, force: true });
if (fail) process.exit(1);
