/**
 * Unit tests for the deck editor's pure pieces: the inspector's text forms
 * (`shared/ui/canvas/deck-edit.ts` — bullets, tables, chart data, KPIs,
 * milestones, as typed or pasted from a spreadsheet, and back), the slide
 * sorter's drop position, the card preview, present mode's keys
 * (`DeckSlide.presentKey`), and the editor's edit-replay over an agent's
 * write (`deck-model.replayDeck`).
 *
 * Bundles its own subjects with esbuild, so it runs on its own:
 *   node web/test-deck.mjs
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aico-deck-unit-'));
async function load(name, file) {
  const outfile = path.join(tmp, `${name}.mjs`);
  await build({
    entryPoints: [path.join(here, '..', 'shared', 'ui', 'canvas', file)], bundle: true, format: 'esm', platform: 'node', outfile, logLevel: 'error',
    // The slide view lazy-loads ECharts and Mermaid; only its pure helpers are tested here, so those stay unbundled.
    external: ['echarts', 'mermaid'], loader: { '.css': 'empty' },
  });
  return import(pathToFileURL(outfile).href);
}
const E = await load('deck-edit', 'deck-edit.ts');
const M = await load('deck-model', 'deck-model.ts');
const S = await load('deck-slide', 'DeckSlide.tsx');

let pass = 0;
let fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (err) { fail++; console.log(`  ✗ ${name}\n      ${err.message.split('\n').join('\n      ')}`); }
}

console.log('\n══ Deck editor ══');

test('bullets round-trip, two spaces mark a sub-point', () => {
  const b = E.textToBullets('First\n  Sub\n- Dash\n\n');
  assert.deepEqual(b, [{ text: 'First' }, { text: 'Sub', level: 1 }, { text: 'Dash' }]);
  assert.equal(E.bulletsToText(b), 'First\n  Sub\nDash');
  assert.equal(E.textToBullets('   \n'), null);
});

test('a table typed with pipes or pasted with tabs; short rows are padded', () => {
  const t = E.textToTable('Server | Role\nWFE1 | Front-end\nSQL1');
  assert.deepEqual(t, { header: ['Server', 'Role'], rows: [['WFE1', 'Front-end'], ['SQL1', '']] });
  assert.deepEqual(E.textToTable('A\tB\n1\t2').rows, [['1', '2']]);
  assert.equal(E.tableToText(t), 'Server | Role\nWFE1 | Front-end\nSQL1 | ');
  assert.equal(E.textToTable('| A | B |\n|---|---|\n| 1 | 2 |').rows[0][1], '2');
});

test('chart data: series names on the first line, numbers with commas and %', () => {
  const c = E.textToChart(' | Revenue | Cost\nQ1 | 1,200 | 800\nQ2 | 1,500 | 30%', 'column', '£');
  assert.equal(c.type, 'column');
  assert.deepEqual(c.categories, ['Q1', 'Q2']);
  assert.deepEqual(c.series.map(s => s.values), [[1200, 1500], [800, 30]]);
  assert.equal(c.unit, '£');
  assert.equal(E.chartToText(c), '| Revenue | Cost\nQ1 | 1200 | 800\nQ2 | 1500 | 30');
  assert.equal(E.textToChart('only one line', 'line'), null);
});

test('KPIs and milestones as lines; a delta sign sets the trend', () => {
  assert.deepEqual(E.textToKpis('£4.2m | Revenue | +12%\n38% | Margin | -2 pts\n7 | Sites'), [
    { value: '£4.2m', label: 'Revenue', delta: '+12%', trend: 'up' }, { value: '38%', label: 'Margin', delta: '-2 pts', trend: 'down' }, { value: '7', label: 'Sites' }]);
  assert.equal(E.kpisToText([{ value: '7', label: 'Sites' }]), '7 | Sites');
  assert.deepEqual(E.textToTimeline('Q1 | Pilot | 3 sites\nQ2 | Launch'), [{ date: 'Q1', title: 'Pilot', text: '3 sites' }, { date: 'Q2', title: 'Launch' }]);
  assert.equal(E.timelineToText([{ date: 'Q2', title: 'Launch' }]), 'Q2 | Launch');
});

test('drag-and-drop lands where the line was drawn', () => {
  assert.equal(E.dropIndex(0, 2, true), 2); // first slide dropped after the third → third position
  assert.equal(E.dropIndex(3, 0, false), 0); // fourth dropped before the first → first
  assert.equal(E.dropIndex(1, 1, false), 1); // onto itself → no move
  assert.equal(E.dropIndex(4, 1, true), 2);
});

test('the card preview counts slides and lists the first titles', () => {
  const d = JSON.stringify({ v: 1, theme: 'slate', slides: [{ id: 's1', layout: 'title', title: 'Hello **world**' }, { id: 's2', layout: 'bullets', title: 'Two' }] });
  assert.deepEqual(E.deckPreview(d, 3), ['2 slides', 'Hello world', 'Two']);
  assert.deepEqual(E.deckPreview('not json'), []);
});

test('present mode keys', () => {
  for (const k of ['ArrowRight', 'ArrowDown', 'PageDown', ' ', 'Enter', 'n']) assert.equal(S.presentKey(k), 'next', k);
  for (const k of ['ArrowLeft', 'ArrowUp', 'PageUp', 'Backspace', 'p']) assert.equal(S.presentKey(k), 'prev', k);
  assert.equal(S.presentKey(' ', true), 'prev');
  assert.equal(S.presentKey('Home'), 'first');
  assert.equal(S.presentKey('End'), 'last');
  assert.equal(S.presentKey('Escape'), 'exit');
  assert.equal(S.presentKey('b'), 'black');
  assert.equal(S.presentKey('s'), 'presenter');
  assert.equal(S.presentKey('x'), undefined);
});

test('pictures the editor may show: data URLs and the engine\'s files, never a path or a URL', () => {
  assert.equal(S.slideImageUrl('data:image/png;base64,AAAA'), 'data:image/png;base64,AAAA');
  assert.equal(S.slideImageUrl('/api/attachments/file?id=1'), '/api/attachments/file?id=1');
  assert.equal(S.slideImageUrl('assets/x.png'), undefined);
  assert.equal(S.slideImageUrl('https://example.com/x.png'), undefined);
});

test('my edits replay over the agent\'s write; one on a slide it removed is reported', () => {
  const base = M.deckFrom({ v: 1, theme: 'slate', slides: [{ id: 's1', layout: 'title', title: 'A' }, { id: 's2', layout: 'bullets', title: 'B' }] });
  const mine = [
    { op: 'set', slide: { ...base.slides[1], title: 'B, edited' } },
    { op: 'meta', patch: { theme: 'ember' } },
    { op: 'insert', at: 2, slide: { id: 's3', layout: 'closing', title: 'Thanks' } },
  ];
  const agent = M.applyDeckOp(base, { op: 'insert', at: 2, slide: { id: 's3', layout: 'quote', quote: 'Q' } });
  const r = M.replayDeck(agent, mine);
  assert.equal(r.skipped, 0);
  assert.equal(r.deck.theme, 'ember');
  assert.equal(r.deck.slides[1].title, 'B, edited');
  assert.deepEqual(r.deck.slides.map(s => s.id), ['s1', 's2', 's4', 's3'], 'my new slide gets a fresh id instead of overwriting the agent\'s s3');
  const gone = M.replayDeck(M.applyDeckOp(base, { op: 'delete', id: 's2' }), mine.slice(0, 1));
  assert.equal(gone.skipped, 1);
});

console.log(`\nDeck editor: ${pass} passed, ${fail} failed`);
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
