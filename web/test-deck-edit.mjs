/**
 * Unit tests for "Ask AICO" in the deck editor (ADR 0024, deck section): the
 * pure pieces `DeckEditor.tsx` and `DeckInlineEdit.tsx` rely on to decide
 * what the person pointed at and what an accept replaces — the element under
 * a click or hover (`elementAt`, and the `data-frame` the renderer adds only
 * for the editor), the scope chips, a selection in an inspector field or on
 * the slide, the quick actions and what their wording unlocks, re-applying an
 * accepted patch to the deck the editor holds, undo, and the fit check.
 *
 * Bundles its own subjects with esbuild, so it runs on its own:
 *   node web/test-deck-edit.mjs
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aico-deck-edit-unit-'));
async function load(name) {
  const outfile = path.join(tmp, `${name}.mjs`);
  await build({ entryPoints: [path.join(here, '..', 'shared', 'ui', 'canvas', `${name}.ts`)], bundle: true, format: 'esm', platform: 'node', outfile, logLevel: 'error' });
  return import(pathToFileURL(outfile).href);
}
const S = await load('deck-scoped-edit');
const M = await load('deck-model');
const L = await load('deck-layout');
const R = await load('deck-render');
const Th = await load('deck-themes');
const deck = M.parseDeck(fs.readFileSync(path.join(here, '..', 'scripts', 'fixtures', 'inline-edit-deck.json'), 'utf8'));

let pass = 0;
let fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (err) { fail++; console.log(`  ✗ ${name}\n      ${err.message.split('\n').join('\n      ')}`); }
}

console.log('\n══ Ask AICO on slides: pointing, scopes, selections, accept ══');

test('the editor\'s slide HTML names each frame, the exported HTML does not', () => {
  const lay = L.layoutSlide(deck, 5);
  const theme = Th.deckTheme(deck.theme);
  assert.match(R.slideHtml(lay, theme, { fields: true }), /data-field="kpis" data-frame="Value 2"/);
  assert.doesNotMatch(R.slideHtml(lay, theme, {}), /data-frame/);
});

test('a hover or click names the element: a bullet by paragraph, a tile or milestone by frame', () => {
  const s3 = deck.slides[2];
  assert.equal(S.elementAt(s3, 'bullets', 'Content', 0), 'body');
  assert.equal(S.elementAt(s3, 'bullets', 'Content', 1), 'bullets.1');
  assert.equal(S.elementAt(s3, 'bullets', 'Content', 5), 'bullets.5');
  assert.equal(S.elementAt(deck.slides[3], 'bullets', 'Takeaways', 1), 'bullets.2');
  assert.equal(S.elementAt(deck.slides[5], 'kpis', 'Label 3'), 'kpis.3');
  assert.equal(S.elementAt(deck.slides[5], 'kpis', 'Card 9'), 'kpis');
  assert.equal(S.elementAt(deck.slides[8], 'timeline', 'Date 1'), 'timeline.1');
  assert.equal(S.elementAt(deck.slides[0], 'title', 'Title'), 'title');
});

test('scope chips go from the element out to the slide; notes stay notes', () => {
  assert.deepEqual(S.deckScopes(deck.slides[5], 'kpis.2').map(s => s.label), ['This tile', 'All tiles', 'Whole slide']);
  assert.deepEqual(S.deckScopes(deck.slides[2], 'title').map(s => s.label), ['Title', 'Whole slide']);
  assert.deepEqual(S.deckScopes(deck.slides[2], 'body').map(s => s.label), ['Lead line', 'Whole slide']);
  assert.deepEqual(S.deckScopes(deck.slides[2], 'notes').map(s => s.label), ['Speaker notes']);
  const cells = S.deckScopes(deck.slides[4], 'table', { r: -1, c: 1 });
  assert.deepEqual(cells.map(s => s.label), ['Column', 'Whole table', 'Whole slide'], 'a header cell: its column, not a row');
  assert.deepEqual(cells[0].target.cells, { r0: 0, r1: 3, c0: 1, c1: 1 });
});

test('a selection in the bullets box maps through the sub-point indent to its bullet', () => {
  const s = M.normalizeSlide({ layout: 'bullets', title: 'T', bullets: ['First point here', '  A sub-point with 42 in it', 'Third'] }, 'x');
  const value = 'First point here\n  A sub-point with 42 in it\nThird';
  const at = value.indexOf('42');
  const t = S.selectionTarget(s, 'bullets', { value, start: at, end: at + 2 });
  assert.equal(t.elementId, 'bullets.2');
  assert.equal(s.bullets[1].text.slice(t.range.start, t.range.end), '42');
  assert.equal(S.selectionTarget(s, 'bullets', { value: `${value}\nhalf-typed`, start: 0, end: 3 }), null, 'a box the person is still typing in does not match the slide: no guess');
  assert.equal(S.selectionTarget(s, 'bullets', { value, start: 3, end: 20 }), null, 'a selection across two bullets is not one bullet\'s');
});

test('a selection on the slide is found in the field\'s text even with marks around it', () => {
  const s = M.normalizeSlide({ layout: 'bullets', title: 'Revenue **grew 18%** this quarter', bullets: ['One'] }, 'x');
  const t = S.selectionTarget(s, 'title', { text: 'grew 18%' });
  assert.equal(t.elementId, 'title');
  assert.equal(s.title.slice(t.range.start, t.range.end), 'grew 18%', 'inside the bold: the marks stay around the new words');
  const across = S.selectionTarget(s, 'title', { text: 'Revenue grew' });
  assert.equal(s.title.slice(across.range.start, across.range.end), 'Revenue **grew 18%**', 'across a mark: widened so the bold stays whole');
});

test('quick actions: each wording unlocks what it needs, a slide\'s title action runs on the title', () => {
  const p = S.resolveDeckTarget(deck, { slideId: 's3', elementId: 'slide' }).part;
  const acts = S.deckActions(deck, p);
  const by = id => acts.find(a => a.id === id);
  assert.equal(S.deckIntentOf([by('kpi').instruction]).layout, 'kpi');
  assert.equal(S.deckIntentOf([by('timeline').instruction]).layout, 'timeline');
  assert.equal(S.deckIntentOf([by('columns').instruction]).layout, 'two-column');
  assert.ok(S.deckIntentOf([by('fit').instruction]).shorten);
  assert.ok(S.deckIntentOf([by('fewer').instruction]).fewer);
  assert.equal(by('title').target.elementId, 'title');
  assert.equal(by('notes').target.elementId, 'notes');
  assert.ok(by('translate').ask, 'Translate asks for the language');
  const chart = S.deckActions(deck, S.resolveDeckTarget(deck, { slideId: 's4', elementId: 'chart' }).part).map(a => a.id);
  assert.deepEqual(chart, ['line', 'bar', 'pie', 'chart-type']);
  assert.ok(S.deckIntentOf(['Change the chart type to a line chart.']).chartType);
});

test('accept: the patch re-applied to the deck the editor holds; undo gives it back exactly', () => {
  const p = S.resolveDeckTarget(deck, { slideId: 's7', elementId: 'left' }).part;
  const json = { heading: 'Risks', bullets: ['CRM test accounts are late', 'Hiring gap of 5 engineering roles', 'EU data residency review'] };
  const v = S.validateDeckPatch(deck, p, { kind: 'json', json }, ['Shorten the text so it fits the slide\'s layout — keep every fact and figure.']);
  assert.ok(v.ok, v.errors.join('; '));
  assert.deepEqual(v.slide.right, deck.slides[6].right, 'the other column is untouched');
  const next = S.withSlide(deck, p.index, v.slide);
  const changed = S.slideHashes(deck).filter((h, i) => h !== S.slideHashes(next)[i]);
  assert.equal(changed.length, 1);
  assert.equal(M.serializeDeck(S.withSlide(next, p.index, deck.slides[p.index])), M.serializeDeck(deck));
});

test('the fit check: nine agenda items past the limit of 8, a title past two lines', () => {
  const ag = S.resolveDeckTarget(deck, { slideId: 's2', elementId: 'bullets' }).part;
  const nine = Array.from({ length: 9 }, (_, i) => `- Item ${i + 1}`).join('\n');
  const v = S.validateDeckPatch(deck, ag, { kind: 'text', text: nine }, ['Add items for every team']);
  assert.ok(!v.ok && v.errors.some(e => /9 bullets — at most 8/.test(e)), v.errors.join('; '));
  const t = S.resolveDeckTarget(deck, { slideId: 's5', elementId: 'title' }).part;
  const w = S.validateDeckPatch(deck, t, { kind: 'text', text: 'Delivery against the plan '.repeat(9).trim() }, ['Expand the title']);
  assert.ok(!w.ok && w.fit.length > 0 && w.errors.some(e => /no longer fits/.test(e)), w.errors.join('; '));
});

test('infographics: an item by its frame, style and add-step actions, kinds that fit the items', () => {
  const d = M.deckFrom({ v: 1, aspect: '16:9', theme: 'slate', slides: [{ id: 'g', layout: 'infographic', title: 'Flow', infographic: { kind: 'cycle', items: [
    { title: 'Plan', icon: 'map' }, { title: 'Build', icon: 'hammer' }, { title: 'Measure', icon: 'gauge' }] } }] });
  const s = d.slides[0];
  assert.equal(S.elementAt(s, 'infographic', 'Segment 2'), 'infographic.2');
  assert.equal(S.elementAt(s, 'infographic', 'Icon gauge'), 'infographic');
  const p = S.resolveDeckTarget(d, { slideId: 'g', elementId: 'infographic' }).part;
  const ids = S.deckActions(d, p).map(a => a.id);
  assert.ok(ids.includes('info-style') && ids.includes('add-step'));
  const kinds = S.compatibleKinds(s.infographic);
  assert.ok(kinds.includes('process') && !kinds.includes('cycle') && !kinds.includes('rings') && !kinds.includes('swot'), kinds.join());
  assert.ok(S.ELEMENT_IDS.includes('infographic.1'));
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
