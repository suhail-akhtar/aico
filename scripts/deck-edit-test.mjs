/**
 * Inline (scoped) AI edits on presentations, offline — ADR 0024 (deck
 * section): shared/ui/canvas/deck-scoped-edit, src/canvas/deck-inline-edit,
 * the Canvas tool's `edit_part` on a deck and the `canvas/edit-part` route
 * with a slide target.
 *
 * Why it exists: "this slide element and nothing else, and the slide still
 * fits" is a promise made of code that can quietly regress — a target that
 * resolves to the wrong field, a context that grows with the deck, a
 * validator that lets a title wrap to three lines or a pitch slide take a
 * sixth bullet, a patch that touches a neighbouring field, an undo that does
 * not give the slide back. Each is asserted here, plus the retry-once loop
 * with a stub provider (no network, no keys) and a deliberately broken answer
 * that must be refused.
 *
 * Offline and free: every model is a stub; no provider is ever called.
 */

// A store of this process's own — nothing below may touch ~/.aico. Must stay first.
import './lib/test-home.mjs';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

for (const k of Object.keys(process.env)) if (/_API_KEY$/.test(k)) delete process.env[k];
fs.writeFileSync(path.join(process.env.AICO_HOME, 'settings.json'), '{}');

const T = await import(process.env.AICO_TEST_EXPORTS ?? '../dist-test/test-exports.js');
const S = T.DeckScopedEdit;
const M = T.DeckModel;
const here = path.dirname(fileURLToPath(import.meta.url));
const RAW = fs.readFileSync(path.join(here, 'fixtures', 'inline-edit-deck.json'), 'utf8');
const DECK = M.parseDeck(RAW);

let passed = 0;
let failed = 0;
const failures = [];
function assert(cond, name, detail) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; failures.push(name); console.log(`  ✗ ${name}${detail !== undefined ? ` — ${JSON.stringify(detail).slice(0, 600)}` : ''}`); }
}
async function block(title, fn) {
  console.log(`\n══ ${title} ══`);
  try { await fn(); } catch (err) { assert(false, `${title}: threw ${err?.stack ?? err}`); }
}
const part = (slideId, elementId, extra = {}) => {
  const r = S.resolveDeckTarget(DECK, { slideId, elementId, ...extra });
  if (!r.ok) throw new Error(r.error);
  return r.part;
};
const check = (p, patch, instruction) => S.validateDeckPatch(DECK, p, patch, Array.isArray(instruction) ? instruction : [instruction]);

await block('Targets resolve to the element, its readable form and its patch kind', async () => {
  const title = part('s3', 'title');
  assert(title.kind === 'text' && title.before === 'Summary' && title.index === 2 && title.fixedKind === true, 'a title: text, the exact field, a fixed kind');
  const bullets = part('s3', 'bullets');
  assert(bullets.kind === 'text' && bullets.editable.split('\n').length === 5 && bullets.editable.startsWith('- Revenue reached £4.2m'), 'the bullets: a Markdown list the model edits');
  const one = part('s3', 'bullets.2');
  assert(one.label === 'Bullet 2' && one.editable === 'Gross margin improved to 61% after the hosting migration', 'a single bullet, 1-based');
  const t = part('s5', 'table');
  assert(t.kind === 'table' && t.table.rows.length === 4 && /\| Workstream/.test(t.before), 'a table: header and rows; its Markdown is the readable form');
  const cells = part('s5', 'table', { cells: { r0: 0, r1: 3, c0: 2, c1: 2 } });
  assert(cells.kind === 'cells' && cells.label === 'Table · column “Status”', `a column of cells (${cells.label})`);
  const chart = part('s4', 'chart');
  assert(chart.kind === 'json' && JSON.parse(chart.editable).series.length === 2 && /Revenue: 2\.6/.test(chart.before), 'a chart: its {type, categories, series} as JSON');
  assert(part('s8', 'diagram').kind === 'mermaid' && part('s8', 'diagram').label === 'Diagram · flowchart', 'a diagram: its Mermaid source');
  assert(part('s6', 'kpis').kind === 'json' && part('s6', 'kpis.2').what === 'KPI tile', 'KPI tiles, and one tile');
  assert(part('s9', 'timeline.3').label === 'Milestone 3' && /Jan 2027 — Analytics dashboard/.test(part('s9', 'timeline.3').before), 'a milestone');
  assert(part('s11', 'quote').what === 'quotation' && part('s11', 'attribution').before === 'Head of Support, Fabrikam', 'the quote and its attribution');
  assert(part('s7', 'left').kind === 'json' && JSON.parse(part('s7', 'left').editable).heading === 'Risks', 'a column');
  const notes = part('s4', 'notes');
  assert(notes.kind === 'text' && notes.editable === '' && /no speaker notes yet/.test(notes.describe), 'empty speaker notes can be written; the model sees what the slide shows');
  const whole = part('s3', 'slide');
  assert(whole.kind === 'json' && JSON.parse(whole.editable).layout === 'bullets' && !/"id"/.test(whole.editable), 'the whole slide: its layout and fields, no id');
  const sel = part('s3', 'title', { range: { start: 0, end: 3 } });
  assert(sel.selection.start === 0 && sel.label === 'Selection in title', 'a selection inside a text element');
  const bad = [
    S.resolveDeckTarget(DECK, { slideId: 's99', elementId: 'title' }),
    S.resolveDeckTarget(DECK, { slideId: 's3', elementId: 'chart' }),
    S.resolveDeckTarget(DECK, { slideId: 's3', elementId: 'bullets.9' }),
    S.resolveDeckTarget(DECK, { slideId: 's3', elementId: 'wibble' }),
    S.resolveDeckTarget(DECK, { slideId: 's5', elementId: 'table', range: { start: 0, end: 3 } }),
    S.resolveDeckTarget(DECK, { slideId: 's3', elementId: 'title', range: { start: 2, end: 99 } }),
  ];
  assert(bad.every(r => !r.ok) && /no longer in the deck/.test(bad[0].error) && /no chart/.test(bad[1].error) && /5 bullets, not 9/.test(bad[2].error), 'a missing slide, element or item, a bad id, a range in a table or out of bounds: a reason, never a guess', bad.map(r => r.error));
  const planned = { ...DECK, slides: [...DECK.slides, { id: 'p1', layout: 'chart', title: 'Plan', intent: 'Growth by region' }] };
  assert(!S.resolveDeckTarget(planned, { slideId: 'p1', elementId: 'slide' }).ok && S.resolveDeckTarget(planned, { slideId: 'p1', elementId: 'title' }).ok, 'a planned slide: its title can be edited, its content is the agent\'s to write');
  assert(S.parseElement('bullet.2').field === 'bullets' && S.parseElement('caption').field === 'image' && S.parseElement('title.2') === null && S.parseElement('bullets.0') === null, 'element ids: aliases read, items only on lists, 1-based');
});

await block('Context is bounded and deterministic', async () => {
  const p = part('s5', 'table');
  const ctx = S.buildDeckEditContext(DECK, p, { title: 'Q3 board update' });
  assert(ctx.outline.length === 12 && ctx.outline[4].startsWith('→ 5. [table]'), 'the outline: every slide title, the target marked');
  assert(ctx.before.length === 2 && ctx.after.length === 2 && ctx.before[0].startsWith('Slide 3') && ctx.after[1].startsWith('Slide 7'), 'two neighbouring slides either side');
  assert(/Board update/.test(ctx.docType) && /Boardroom/.test(ctx.typeNote) && /slide 5 of 12/.test(ctx.typeNote), 'the deck type, theme and the slide\'s place');
  assert(JSON.stringify(ctx) === JSON.stringify(S.buildDeckEditContext(DECK, p, { title: 'Q3 board update' })), 'the same deck and part give the same context');
  // A long deck: the outline is a window around the target, the neighbours are clipped.
  const long = M.deckFrom({ ...DECK, slides: Array.from({ length: 80 }, (_, i) => ({ id: `x${i}`, layout: 'bullets', title: `Slide about topic ${i} ${'and more words '.repeat(12)}`, bullets: ['word '.repeat(80)] })) });
  const lp = S.resolveDeckTarget(long, { slideId: 'x70', elementId: 'title' }).part;
  const lc = S.buildDeckEditContext(long, lp, { title: 'Long' });
  const size = JSON.stringify(lc).length;
  assert(lc.outline.length === S.DECK_CONTEXT_LIMITS.outline && lc.outline.some(l => l.startsWith('→ 71.')) && lc.outline.every(l => l.length < 120), `an 80-slide deck: the outline is ${lc.outline.length} titles around the target, each clipped`);
  assert(lc.before.every(b => b.length <= S.DECK_CONTEXT_LIMITS.neighbourChars + 40) && size < 9000, `neighbours clipped; the whole context is ${size} characters`);
  const prompt = T.editPrompt(p, ctx, 'Shorten cells');
  assert(/Its limits/.test(prompt) && /at most 6 columns and 8 rows/.test(prompt) && !/"markdown"/.test(prompt) && /Instruction: Shorten cells$/.test(prompt), 'the prompt states the layout\'s limits, offers no Markdown escape, ends with the instruction');
  assert(/bullets: at most 5/.test(S.slideLimits(DECK, 2).join('\n')), 'the deck type\'s bullet limit (a board update: 5) is the one stated');
});

await block('What an instruction allows on a deck', async () => {
  const I = (t) => S.deckIntentOf([t]);
  assert(I('Shorten the text so it fits the slide\'s layout — keep every fact and figure.').shorten && I('make it fit').fit, '"fit" is a shorten');
  assert(I('Cut it to fewer bullets: keep the strongest points, merge or drop the rest.').fewer, '"fewer bullets"');
  assert(I('Turn the bullets into big numbers (layout kpi)').layout === 'kpi' && I('Turn the bullets into big numbers').layout === 'kpi', 'big numbers → kpi');
  assert(I('Turn the bullets into a timeline').layout === 'timeline' && I('Turn the bullets into two columns').layout === 'two-column', 'timeline, two columns');
  assert(I('Change the chart type to a line chart.').layout === null && I('Change the chart type to a line chart.').chartType, 'a chart-type change is not a layout change');
  assert(I('Make the title punchier').layout === null && !I('Make the title punchier').convert, 'a rewrite asks for no layout');
});

await block('Validators: text elements, scope and fit', async () => {
  const title = part('s3', 'title');
  let v = check(title, { kind: 'text', text: 'Q3 beat plan: revenue up 18%' }, 'Rewrite the slide title as a short, punchy claim that says what the slide shows — keep its figures.');
  assert(!v.ok && v.errors.some(e => /new numbers/.test(e)), 'a "punchier" title that invents figures is refused', v.errors);
  v = check(title, { kind: 'text', text: 'A strong quarter, two risks to watch' }, 'Rewrite the slide title as a short, punchy claim that says what the slide shows — keep its figures.');
  assert(v.ok && v.scopeHeld && v.slide.title === 'A strong quarter, two risks to watch' && v.after === 'A strong quarter, two risks to watch', 'a punchier title passes; scope held', v.errors);
  assert(JSON.stringify({ ...v.slide, title: 'Summary' }) === JSON.stringify(DECK.slides[2]), 'only the title changed');
  const long = 'Summary of a strong quarter in which revenue, margin and routing time all improved while hiring stayed behind plan and two delivery risks need the board to watch them closely through the winter';
  v = check(title, { kind: 'text', text: long }, 'Expand the title with more detail');
  assert(!v.ok && v.errors.some(e => /no longer fits/.test(e) && /title/.test(e)), 'a title that no longer fits two lines is refused with the layout engine\'s reason', v.errors);
  v = check(title, { kind: 'text', text: 'Summary\nof Q3' }, 'Make it two lines');
  assert(!v.ok && v.errors.some(e => /one line/.test(e)), 'a title is one line');
  const sel = part('s1', 'subtitle', { range: { start: 0, end: 'Customer Feedback Platform'.length } });
  v = check(sel, { kind: 'text', text: 'Feedback Platform' }, 'Shorten it');
  assert(v.ok && v.slide.subtitle === 'Feedback Platform: delivery, revenue and the decisions we need', 'a selection: only the selected words change', v.errors);
  const bullets = part('s3', 'bullets');
  const six = `${bullets.editable}\n- Churn fell to 2.1% (from 2.9%)`;
  v = check(bullets, { kind: 'text', text: six }, 'Add a bullet about churn falling to 2.1% from 2.9%');
  assert(!v.ok && v.errors.some(e => /6 bullets — at most 5/.test(e)), 'a sixth bullet on a board-update slide breaks the deck type\'s limit: refused', v.errors);
  v = check(bullets, { kind: 'text', text: bullets.editable.split('\n').slice(0, 4).join('\n') }, 'Fix grammar');
  assert(!v.ok && v.errors.some(e => /dropped|items/.test(e)), 'a correction that drops a bullet is refused', v.errors);
  v = check(bullets, { kind: 'text', text: bullets.editable }, 'Cut it to fewer bullets: keep the strongest points, merge or drop the rest.');
  assert(!v.ok && v.errors.some(e => /fewer bullets, but there are still 5/.test(e)), '"fewer bullets" must give fewer', v.errors);
  v = check(bullets, { kind: 'text', text: '- Revenue £4.2m, up 18%, ahead of £3.9m plan\n- Margin up to 61% after the hosting migration\n- Routing time down from 42 to 15 minutes\n- Hiring behind: 9 of 14 roles filled' }, 'Cut it to fewer bullets: keep the strongest points, merge or drop the rest.');
  assert(v.ok && v.slide.bullets.length === 4 && v.slide.body === DECK.slides[2].body, 'fewer bullets that keep the figures: passes, the lead line untouched', v.errors);
  const indented = bullets.editable.split('\n').map(l => `  ${l}`).join('\n');
  v = check(bullets, { kind: 'text', text: indented }, 'Fix grammar');
  assert(v.ok && v.slide.bullets.every(b => !b.level), 'a list indented as a whole stays top-level bullets (found live: a translation came back indented)', v.errors);
  const demoted = bullets.editable.split('\n').map((l, i) => (i === 1 ? `  ${l}` : l)).join('\n');
  v = check(bullets, { kind: 'text', text: demoted }, 'Fix grammar');
  assert(!v.ok && v.errors.some(e => /sub-points changed/.test(e)), 'a bullet turned into a sub-point nobody asked for is refused', v.errors);
  const b2 = part('s3', 'bullets.2');
  v = check(b2, { kind: 'text', text: 'Margin up to 61% after the hosting move' }, 'Make this bullet punchier — one short line, same facts and figures.');
  assert(v.ok && v.slide.bullets[1].text === 'Margin up to 61% after the hosting move' && v.slide.bullets.filter((b, i) => i !== 1).every((b, i) => b.text === DECK.slides[2].bullets.filter((_, j) => j !== 1)[i].text), 'one bullet: its siblings are untouched', v.errors);
  v = check(part('s3', 'body'), { kind: 'text', text: 'A strong quarter for the platform, with two risks to watch and **one** decision.' }, 'Expand the lead line');
  assert(!v.ok && v.errors.some(e => /formatting was added/.test(e)), 'the document checks still apply (no formatting added unasked)', v.errors);
});

await block('Validators: tables, charts, diagrams, KPIs, notes', async () => {
  const t = part('s5', 'table');
  let v = check(t, { kind: 'table', header: t.table.header, rows: t.table.rows.slice(0, 3) }, 'Shorten cells');
  assert(!v.ok && v.errors.some(e => /4 rows and now has 3/.test(e)), 'a table that loses a row is refused');
  const cells = part('s5', 'table', { cells: { r0: 2, r1: 2, c0: 2, c1: 2 } });
  v = check(cells, { kind: 'cells', cells: [['Late — escalated']] }, 'Make the status clearer');
  assert(v.ok && v.slide.table.rows[2][2] === 'Late — escalated' && JSON.stringify(v.slide.table.rows.map((r, i) => r.filter((_, j) => i !== 2 || j !== 2))) === JSON.stringify(DECK.slides[4].table.rows.map((r, i) => r.filter((_, j) => i !== 2 || j !== 2))), 'a cell edit changes that cell only', v.errors);
  const big = { kind: 'table', header: t.table.header, rows: [...t.table.rows, ...t.table.rows, ['Extra', 'A', 'B', 'C']] };
  v = check(t, big, 'Add rows for every workstream twice');
  assert(!v.ok && v.errors.some(e => /9 rows — at most 8/.test(e)), 'a table past the layout\'s 8 rows is refused by the fit check', v.errors);
  const chart = part('s4', 'chart');
  const c0 = JSON.parse(chart.editable);
  v = check(chart, { kind: 'json', json: { ...c0, type: 'line' } }, 'Fix the labels');
  assert(!v.ok && v.errors.some(e => /chart type changed/.test(e)), 'a chart type change nobody asked for is refused');
  v = check(chart, { kind: 'json', json: { ...c0, type: 'line' } }, 'Change the chart type to a line chart.');
  assert(v.ok && v.slide.chart.type === 'line' && JSON.stringify(v.slide.chart.series) === JSON.stringify(DECK.slides[3].chart.series), 'asked: the type changes, the data does not', v.errors);
  v = check(chart, { kind: 'json', json: { ...c0, type: 'line', series: [{ ...c0.series[0], values: [2.6, 3.1, 3.6, 4.2] }, c0.series[1]] } }, 'Change the chart type to a line chart.');
  assert(!v.ok && v.errors.some(e => /numbers were dropped or changed/.test(e)), 'a value that drifts (3.56 → 3.6) is refused', v.errors);
  const d = part('s8', 'diagram');
  v = check(d, { kind: 'mermaid', source: 'flowchart LR\n  WEB[Web form --> ING[Ingestion]' }, 'Simplify the diagram');
  assert(!v.ok && v.errors.some(e => /unbalanced|unclosed/.test(e)), 'a diagram that does not parse is refused');
  v = check(d, { kind: 'mermaid', source: 'flowchart TD\n  WEB[Web form] --> ING[Ingestion]\n  APP[Mobile app] --> ING\n  ING --> RT[Routing]\n  RT --> CRM[CRM]\n  RT --> DASH[Dashboard]' }, 'Lay it out top to bottom (flowchart TD) so it fits the slide.');
  assert(v.ok && /flowchart TD/.test(v.slide.diagram), 'a direction change keeps every node', v.errors);
  const k = part('s6', 'kpis');
  const k0 = JSON.parse(k.editable);
  v = check(k, { kind: 'json', json: { kpis: [...k0.kpis, { value: '92%', label: 'Retention' }] } }, 'Fix grammar');
  assert(!v.ok && v.errors.some(e => /KPI tiles were added|new numbers/.test(e)), 'a KPI tile nobody asked for, with an invented figure, is refused', v.errors);
  v = check(part('s6', 'kpis.1'), { kind: 'json', json: { value: '£4.2m', label: 'Revenue this quarter', delta: '+18% QoQ', trend: 'up' } }, 'Make the label clearer');
  assert(v.ok && v.slide.kpis[0].label === 'Revenue this quarter' && JSON.stringify(v.slide.kpis.slice(1)) === JSON.stringify(DECK.slides[5].kpis.slice(1)), 'one tile: the others untouched', v.errors);
  const wordy = `All three moved the right way for the second quarter running. ${'Revenue, margin and routing time each improved because the platform now routes feedback automatically and the hosting migration lowered costs for every customer. '.repeat(8)}`;
  v = check(part('s6', 'body'), { kind: 'text', text: wordy.trim() }, 'Expand the commentary with more detail');
  assert(!v.ok && v.errors.some(e => /no longer fits.*commentary does not fit/.test(e)), 'a commentary too long for the space under the tiles is refused by the fit check', v.errors);
  const n = part('s4', 'notes');
  v = check(n, { kind: 'text', text: 'Revenue rose every quarter, from £2.6m to £4.2m, beating plan by £0.3m. Enterprise customers are now 46% of it.' }, 'Write speaker notes for this slide: what to say, 60–120 words, from the slide\'s own content — no new facts or figures.');
  assert(v.ok && /46%/.test(v.slide.notes), 'notes from the slide\'s own figures pass', v.errors);
  v = check(n, { kind: 'text', text: 'Revenue rose to £4.2m and we expect £5.5m next quarter.' }, 'Write speaker notes for this slide');
  assert(!v.ok && v.errors.some(e => /not on the slide.*5\.5/.test(e)), 'a figure that is on no slide nearby is refused as invented', v.errors);
  v = check(n, { kind: 'blocks', markdown: '## Notes' }, 'Write speaker notes');
  assert(!v.ok && /not "markdown"/.test(v.errors[0]), 'a Markdown answer is refused: a slide element keeps its kind');
});

await block('Validators: whole slides and layout changes', async () => {
  const p = part('s3', 'slide');
  const j = JSON.parse(p.editable);
  let v = check(p, { kind: 'json', json: { ...j, layout: 'kpi' } }, 'Fix grammar');
  assert(!v.ok && v.errors.some(e => /layout changed \(bullets → kpi\)/.test(e)), 'a layout change nobody asked for is refused', v.errors);
  const kpis = { layout: 'kpi', title: 'Summary', body: j.body, notes: j.notes, kpis: [
    { value: '£4.2m', label: 'Revenue, up 18% on Q2 (plan £3.9m)' },
    { value: '61%', label: 'Gross margin after the hosting migration' },
    { value: '15 min', label: 'Routing time, down from 42 minutes' },
    { value: '9 of 14', label: 'Engineering roles filled; 3 pilots now paid' },
  ] };
  const ask = 'Turn the bullets into big numbers (layout kpi): 2–4 tiles, each a short figure from the bullets with a label — keep every figure.';
  v = check(p, { kind: 'json', json: kpis }, ask);
  assert(v.ok && v.slide.layout === 'kpi' && v.slide.kpis.length === 4 && v.slide.notes === j.notes && !v.slide.bullets, 'asked for big numbers: the slide becomes a kpi slide, every figure carried, notes kept', v.errors);
  v = check(p, { kind: 'json', json: { ...kpis, kpis: kpis.kpis.slice(0, 3) } }, ask);
  assert(!v.ok && v.errors.some(e => /figures were lost in the conversion \(9, 14\)/.test(e)), 'a conversion that loses figures is refused, naming them', v.errors);
  v = check(p, { kind: 'json', json: { ...kpis, bullets: j.bullets } }, ask);
  assert(!v.ok && v.errors.some(e => /does not draw bullets/.test(e)), 'content left in a field the new layout does not draw is refused', v.errors);
  v = check(p, { kind: 'json', json: { ...j, layout: 'timeline' } }, ask);
  assert(!v.ok && v.errors.some(e => /asked for a big numbers slide/.test(e)), 'asked for big numbers, answered with a timeline: refused', v.errors);
  const { notes: _n, ...noNotes } = j;
  v = check(p, { kind: 'json', json: noNotes }, 'Shorten the text so it fits the slide\'s layout — keep every fact and figure.');
  assert(!v.ok && v.errors.some(e => /notes were dropped|fields were removed/.test(e)), 'a whole-slide edit that drops the speaker notes is refused', v.errors);
  const img = M.deckFrom({ ...DECK, slides: [...DECK.slides, { id: 'i1', layout: 'image-text', title: 'Pilot sites', image: { src: 'data:image/png;base64,AAAA', alt: 'Map' }, bullets: ['Three sites', 'Two regions'], transition: 'fade' }] });
  const ip = S.resolveDeckTarget(img, { slideId: 'i1', elementId: 'slide' }).part;
  assert(/"\(image\)"/.test(ip.editable) && !/base64/.test(ip.editable), 'an embedded picture is never sent to the model');
  const iv = S.validateDeckPatch(img, ip, { kind: 'json', json: { ...JSON.parse(ip.editable), title: 'Our pilot sites' } }, ['Retitle the slide']);
  assert(iv.ok && iv.slide.image.src === 'data:image/png;base64,AAAA' && iv.slide.transition === 'fade', '"(image)" comes back as the same picture; the transition is kept', iv.errors);
});

await block('Infographics (ADR 0025): the infographic and one item', async () => {
  const D = M.deckFrom({ v: 1, aspect: '16:9', theme: 'slate', type: 'board-update', slides: [
    { id: 's1', layout: 'title', title: 'Feedback' },
    { id: 's2', layout: 'infographic', title: 'How feedback is handled', infographic: { kind: 'process', items: [
      { title: 'Collect', text: 'Web and app forms', icon: 'inbox' },
      { title: 'Route', text: 'To the owning team', icon: 'route' },
      { title: 'Resolve', text: 'Within 15 minutes', icon: 'check' },
    ] } },
  ] });
  const r = (el) => { const x = S.resolveDeckTarget(D, { slideId: 's2', elementId: el }); if (!x.ok) throw new Error(x.error); return x.part; };
  const V = (p, patch, ins) => S.validateDeckPatch(D, p, patch, [ins]);
  const ig = r('infographic');
  const j = JSON.parse(ig.editable);
  assert(ig.kind === 'json' && ig.label === 'Infographic · Chevron process' && j.items.length === 3 && /use one of: arrows/.test(ig.describe), 'the infographic: its kind and items as JSON; the compatible kinds are named');
  const it = r('infographic.2');
  assert(it.what === 'infographic item' && JSON.parse(it.editable).title === 'Route' && /Route: To the owning team \[route\]/.test(it.before), 'one item, 1-based');
  assert(!S.resolveDeckTarget(D, { slideId: 's2', elementId: 'infographic.9' }).ok && S.parseElement('step.2').field === 'infographic', 'a missing item is refused; "step" names an item');
  let v = V(ig, { kind: 'json', json: { ...j, kind: 'cycle' } }, 'Fix grammar');
  assert(!v.ok && v.errors.some(e => /kind changed \(process → cycle\)/.test(e)), 'a kind change nobody asked for is refused', v.errors);
  const style = S.deckActions(D, ig).find(a => a.id === 'info-style');
  v = V(ig, { kind: 'json', json: { ...j, kind: 'cycle' } }, style.instruction);
  assert(v.ok && v.slide.infographic.kind === 'cycle' && v.slide.infographic.items.length === 3, '"Change infographic style": a compatible kind, every item kept', v.errors);
  v = V(ig, { kind: 'json', json: { ...j, kind: 'swot' } }, style.instruction);
  assert(!v.ok && v.errors.some(e => /cannot draw these items|SWOT needs at least 4|kind changed/.test(e)), 'an incompatible kind is refused', v.errors);
  v = V(ig, { kind: 'json', json: { ...j, items: [j.items[0]] } }, 'Cut it down to the essentials and drop the rest');
  assert(!v.ok && v.errors.some(e => /2–8 items/.test(e)), 'fewer than two items is refused', v.errors);
  const add = S.deckActions(D, ig).find(a => a.id === 'add-step');
  v = V(ig, { kind: 'json', json: { ...j, items: [...j.items, { title: 'Learn', text: 'Trends each week', icon: 'chart-line' }] } }, add.instruction);
  assert(v.ok && v.slide.infographic.items.length === 4, '"Add a step": one more item', v.errors);
  v = V(ig, { kind: 'json', json: { ...j, items: [...j.items, { title: 'Learn', text: 'Trends each week' }] } }, 'Fix grammar');
  assert(!v.ok && v.errors.some(e => /infographic items were added/.test(e)), 'an item nobody asked for is refused', v.errors);
  v = V(it, { kind: 'json', json: { title: 'Route', text: 'To the right team', icon: 'magic-unicorn-xyz' } }, 'Make it punchier');
  assert(!v.ok && v.errors.some(e => /not in the icon set: magic-unicorn-xyz/.test(e)), 'an icon that is not in the vendored set is refused', v.errors);
  v = V(it, { kind: 'json', json: { title: 'Route', text: 'To the right team', icon: 'route' } }, 'Make it punchier');
  assert(v.ok && v.scopeHeld && v.slide.infographic.items[0].title === 'Collect' && v.slide.infographic.items[2].title === 'Resolve', 'one item: the others untouched', v.errors);
  const long = 'To the owning team, with the full context of the request, the customer history, the product area, the urgency and the agreed service level. '.repeat(3).trim();
  v = V(it, { kind: 'json', json: { title: 'Route', text: long, icon: 'route' } }, 'Expand it');
  assert(v.warnings.some(w => /item 2 has \d+ words/.test(w)), 'a wordy item: the infographic layout\'s own warning reaches the review', v.warnings);
  const R = M.deckFrom({ v: 1, aspect: '16:9', theme: 'slate', slides: [{ id: 'r1', layout: 'infographic', title: 'Adoption', infographic: { kind: 'rings', items: [
    { title: 'Web', value: '72%' }, { title: 'App', value: '54%' }, { title: 'Kiosk', value: '18%' }] } }] });
  const rp = S.resolveDeckTarget(R, { slideId: 'r1', elementId: 'infographic.3' }).part;
  v = S.validateDeckPatch(R, rp, { kind: 'json', json: { title: 'Kiosk', value: 'early days' } }, ['Update the value to say it is early days']);
  assert(!v.ok && v.errors.some(e => /no longer fits its layout: ring 3 .* needs a percentage/.test(e)), 'a ring without a percentage fails the infographic\'s own check', v.errors);
  const slideActs = S.deckActions(D, r('slide'));
  assert(slideActs.find(a => a.id === 'info-style')?.target?.elementId === 'infographic' && slideActs.find(a => a.id === 'add-step')?.target?.elementId === 'infographic', 'the slide offers both, run on the infographic');
  assert(S.elementAt(D.slides[1], 'infographic', 'Step title 2') === 'infographic.2' && S.elementAt(D.slides[1], 'infographic', 'Icon check') === 'infographic', 'pointing: a step\'s frame names its item; an icon frame does not');
  assert(S.deckScopes(D.slides[1], 'infographic.2').map(x => x.label).join() === 'This step,Whole infographic,Whole slide', 'scopes: this step, the infographic, the slide');
});

await block('Applying: only the slide changes; every other slide hashes the same; undo restores', async () => {
  const p = part('s9', 'timeline.2');
  const v = check(p, { kind: 'json', json: { date: 'Dec 2026', title: 'CRM connector live', text: 'Cases sync both ways with Contoso' } }, 'Make the title clearer');
  assert(v.ok && v.scopeHeld, 'valid, scope held', v.errors);
  const next = S.withSlide(DECK, p.index, v.slide);
  const h0 = S.slideHashes(DECK);
  const h1 = S.slideHashes(next);
  assert(h0.filter((h, i) => h !== h1[i]).length === 1 && h0[p.index] !== h1[p.index], `exactly one slide hash changed (${h0.length} hashed)`);
  const undo = S.withSlide(next, p.index, DECK.slides[p.index]);
  assert(S.stableJson(undo) === S.stableJson(DECK) && M.serializeDeck(undo) === M.serializeDeck(DECK), 'undo gives the deck back, byte for byte');
  // The editor re-applies the accepted patch to the deck it holds: the same slide results.
  const again = S.applyDeckPatch(DECK, p, { kind: 'json', json: { date: 'Dec 2026', title: 'CRM connector live', text: 'Cases sync both ways with Contoso' } });
  assert(again.ok && S.stableJson(again.slide) === S.stableJson(v.slide), 'applying the patch again gives the same slide');
  // The person edited the same slide's subtitle meanwhile: the title patch still lands on the current slide, theirs kept.
  const theirs = S.withSlide(DECK, 0, { ...DECK.slides[0], subtitle: 'Edited by the person' });
  const tp = S.resolveDeckTarget(theirs, { slideId: 's1', elementId: 'title' }).part;
  const tv = S.validateDeckPatch(theirs, tp, { kind: 'text', text: 'Q3 2026: a strong quarter' }, ['Rewrite the slide title as a short, punchy claim']);
  assert(tv.ok && tv.slide.subtitle === 'Edited by the person', 'a patch applied to the current slide keeps the person\'s other edits', tv.errors);
});

await block('The model call: the deck validator in the loop, retry once with the layout\'s reasons', async () => {
  const stub = (answers) => {
    const calls = [];
    return {
      calls,
      provider: {
        id: 'stub', displayName: 'Stub',
        async *chat(o) {
          calls.push(o);
          yield { type: 'text', content: answers[Math.min(calls.length - 1, answers.length - 1)] };
          yield { type: 'usage', inputTokens: 1800, outputTokens: 60 };
          yield { type: 'finish', reason: 'stop' };
        },
      },
    };
  };
  const settings = { providerInstances: [{ id: 'deepseek', type: 'deepseek', name: 'DeepSeek', apiKey: 'k' }] };
  const doc = { title: 'Q3 board update', tabs: [{ content: RAW }] };
  const good = JSON.stringify({ text: 'Four workstreams: one done, one at risk', note: 'A claim, not a label.' });
  const broken = JSON.stringify({ text: 'Delivery against the plan for every workstream in the programme, with each owner, status and due date, reviewed week by week by the programme office and the steering group' });
  let s = stub([good]);
  let r = await T.editDeckPart({ doc, target: { slideId: 's5', elementId: 'title' }, instruction: 'Rewrite the slide title as a short, punchy claim that says what the slide shows — keep its figures.', settings, mainModel: 'deepseek-v4-flash', provider: s.provider });
  assert(r.ok && r.attempts === 1 && r.slide.title === 'Four workstreams: one done, one at risk' && r.part.slideId === 's5', 'a good answer passes first time; the slide after the edit comes back', r.errors);
  assert(s.calls[0].systemPrompt === T.EDIT_SYSTEM && /Its limits/.test(s.calls[0].messages[0].content) && /→ 5\. \[table\]/.test(s.calls[0].messages[0].content), 'the edit role\'s fixed rules; the prompt carries the limits and the outline');
  s = stub([broken, good]);
  r = await T.editDeckPart({ doc, target: { slideId: 's5', elementId: 'title' }, instruction: 'Rewrite the slide title as a short, punchy claim that says what the slide shows — keep its figures.', settings, mainModel: 'deepseek-v4-flash', provider: s.provider });
  assert(r.ok && r.attempts === 2 && /rejected/.test(s.calls[1].messages.at(-1).content) && /no longer fits|too long/.test(s.calls[1].messages.at(-1).content), 'a title that would not fit is sent back once with the layout engine\'s reason', s.calls[1]?.messages.at(-1).content);
  s = stub([broken, broken]);
  r = await T.editDeckPart({ doc, target: { slideId: 's5', elementId: 'title' }, instruction: 'Rewrite the slide title as a short, punchy claim', settings, mainModel: 'deepseek-v4-flash', provider: s.provider });
  assert(!r.ok && r.attempts === 2 && /could not make a safe edit/.test(r.error) && !r.slide, 'broken twice: no edit, the reasons returned');
  s = stub([JSON.stringify({ markdown: '## Delivery' })]);
  r = await T.editDeckPart({ doc, target: { slideId: 's5', elementId: 'title' }, instruction: 'Fix it', settings, mainModel: 'deepseek-v4-flash', provider: s.provider });
  assert(!r.ok && r.errors.some(e => /not "markdown"/.test(e)), 'a Markdown answer is refused (twice), not applied');
  r = await T.editDeckPart({ doc, target: { slideId: 'nope' }, instruction: 'Fix it', settings, mainModel: 'deepseek-v4-flash', provider: s.provider });
  assert(!r.ok && /no longer in the deck/.test(r.error) && r.attempts === 0, 'an unknown slide: refused before any call');
});

await block('The agent: Canvas edit_part on a deck, and the route', async () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'aico-deck-edit-'));
  const settings = {};
  const ctx = { settings, cwd: project, sessionId: 'deck-edit-session' };
  const run = (fn) => T.runInContext({ cwd: project, sessionId: ctx.sessionId, settings }, fn);
  const doc = await T.createCanvas(ctx, { title: 'Q3 board update', kind: 'deck', content: M.serializeDeck(DECK), author: 'agent' });
  const err = async (fn) => { try { await fn(); return ''; } catch (e) { return e.message; } };
  let msg = await err(() => run(() => T.canvasTool({ action: 'edit_part', id: doc.id, version: 1, instruction: 'Fix grammar', part: { slide: 's6', element: 'kpis' }, content: JSON.stringify({ kpis: [{ value: '£4.2m', label: 'Revenue' }] }) })));
  assert(/NOT APPLIED/.test(msg) && /dropped/.test(msg), 'an agent replacement that drops tiles under "fix grammar" is refused with the reason', msg);
  const out = await run(() => T.canvasTool({ action: 'edit_part', id: doc.id, version: 1, instruction: 'Rewrite the slide title as a short, punchy claim', part: { slide: 3, element: 'title' }, content: 'A strong quarter, two risks to watch' }));
  const now = await T.getCanvas(ctx, doc.id);
  const after = M.parseDeck(now.tabs[0].content);
  assert(/now version 2/.test(out) && now.versions.at(-1).note === 'AICO edit: Rewrite the slide title as a short, punchy claim' && now.versions.at(-1).author === 'agent', 'a valid one is one version, noted in the history', out);
  assert(after.slides[2].title === 'A strong quarter, two risks to watch' && S.slideHashes(after).filter((h, i) => h !== S.slideHashes(DECK)[i]).length === 1, 'only that slide changed');
  msg = await err(() => run(() => T.canvasTool({ action: 'edit_part', id: doc.id, version: 1, instruction: 'Fix grammar', part: { slide: 's3', element: 'title' }, content: 'x' })));
  assert(/NOT APPLIED/.test(msg) && /version 2, not 1/.test(msg), 'a stale version is refused with the deck as it is now', msg.slice(0, 200));
  msg = await err(() => run(() => T.canvasTool({ action: 'edit_part', id: doc.id, version: 2, instruction: 'Fix grammar', part: { slide: 's42' } })));
  assert(/part\.slide/.test(msg), 'an unknown slide lists the slides', msg);
  msg = await err(() => run(() => T.canvasTool({ action: 'edit_part', id: doc.id, version: 2, instruction: 'Sort it', part: { slide: 's5', columns: ['Status'] }, content: 'x' })));
  assert(/NOT APPLIED/.test(msg), 'a column of a table is a cell range the agent may replace');
  msg = await err(() => run(() => T.canvasTool({ action: 'edit_part', id: doc.id, version: 2, part: { slide: 's3' } })));
  assert(/instruction/.test(msg), 'an instruction is required');
  assert(/edit_part \{id, version, instruction, part:\{slide/.test(T.canvasDefinition.description), 'the deck help names edit_part');

  const sent = [];
  const deps = { resolveCwd: async () => project, readJson: async (r) => r.body, send: (_res, status, body) => sent.push({ status, body }) };
  const res = { on() {}, writableEnded: false };
  const call = (body) => T.handleCanvasRoute('canvas/edit-part', { method: 'POST', body }, res, new URL('http://x/'), deps);
  await call({ session: ctx.sessionId, id: doc.id, target: { slideId: 's3', elementId: 'title' }, instruction: 'Make it punchier' });
  const last = sent.at(-1);
  assert(last.status === 200 && last.body.ok === false && /no model/.test(last.body.error) && last.body.part?.slideId === 's3' && last.body.part?.elementId === 'title', 'no model set up: a 200 with the reason and the resolved part', last);
  await call({ session: ctx.sessionId, id: doc.id, target: { slideId: '../x' }, instruction: 'x' });
  assert(sent.at(-1).status === 400, 'a malformed slide id is refused');
  await call({ session: ctx.sessionId, id: doc.id, target: { blockIds: ['k'] }, instruction: 'x' });
  assert(sent.at(-1).status === 400 && /name target\.slideId/.test(sent.at(-1).body.error), 'blocks on a deck: told to name a slide');
  assert((await T.getCanvas(ctx, doc.id)).tabs[0].version === 2, 'the route never writes');
});

await block('Pointing at the slide: elements, scopes, selections, quick actions', async () => {
  const s3 = DECK.slides[2];
  assert(S.elementAt(s3, 'bullets', 'Content', 0) === 'body' && S.elementAt(s3, 'bullets', 'Content', 2) === 'bullets.2', 'a paragraph of the content frame: the lead line, then bullet n');
  assert(S.elementAt(DECK.slides[5], 'kpis', 'Value 2') === 'kpis.2' && S.elementAt(DECK.slides[8], 'timeline', 'Milestone 4') === 'timeline.4' && S.elementAt(DECK.slides[1], 'bullets', 'Item 3') === 'bullets.3', 'a KPI tile, a milestone, an agenda item by frame');
  assert(S.deckScopes(s3, 'bullets.2').map(x => x.label).join() === 'This bullet,All bullets,Whole slide', 'a bullet: this bullet, all, the slide');
  assert(S.deckScopes(DECK.slides[4], 'table', { r: 1, c: 2 }).map(x => x.label).join() === 'This cell,Row,Column,Whole table,Whole slide', 'a table cell: cell, row, column, table, slide');
  const t = S.selectionTarget(s3, 'title', { value: 'Summary', start: 0, end: 3 });
  assert(t.elementId === 'title' && t.range.end === 3, 'a selection in the title box');
  const lines = s3.bullets.map(b => b.text).join('\n');
  const at = lines.indexOf('61%');
  const b = S.selectionTarget(s3, 'bullets', { value: lines, start: at, end: at + 3 });
  assert(b.elementId === 'bullets.2' && s3.bullets[1].text.slice(b.range.start, b.range.end) === '61%', 'a selection in the bullets box: the bullet and the range inside it');
  const st = S.selectionTarget(s3, 'bullets', { text: 'hosting migration' });
  assert(st.elementId === 'bullets.2' && s3.bullets[1].text.slice(st.range.start, st.range.end) === 'hosting migration', 'words selected on the slide itself');
  assert(S.selectionTarget(s3, 'title', { value: 'Summary', start: 0, end: 7 }).range === undefined, 'a selection of the whole field is the field');
  const acts = S.deckActions(DECK, part('s3', 'slide')).map(a => a.label);
  assert(['Shorten to fit', 'Punchier title', 'Fewer bullets', 'Bullets → big numbers', 'Bullets → timeline', 'Bullets → two columns', 'Write speaker notes', 'Translate…'].every(l => acts.includes(l)), `slide quick actions (${acts.join(', ')})`);
  const pt = S.deckActions(DECK, part('s3', 'slide')).find(a => a.id === 'title');
  assert(pt.target?.elementId === 'title', '"Punchier title" from the slide runs on the title');
  assert(S.deckActions(DECK, part('s4', 'slide')).some(a => a.id === 'chart-type') && S.deckActions(DECK, part('s8', 'slide')).some(a => a.id === 'simplify'), 'a chart slide offers a chart type change; a diagram slide, Simplify');
  // Every quick action's own wording unlocks what it needs.
  const I = (id, p) => S.deckIntentOf([S.deckActions(DECK, p).find(a => a.id === id).instruction]);
  assert(I('kpi', part('s3', 'slide')).layout === 'kpi' && I('timeline', part('s3', 'slide')).layout === 'timeline' && I('columns', part('s3', 'slide')).layout === 'two-column', 'the conversion actions name their layouts');
  assert(I('fit', part('s3', 'slide')).shorten && I('fewer', part('s3', 'slide')).fewer, 'Shorten to fit shortens; Fewer bullets asks for fewer');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) {
  console.log(failures.map(f => `  - ${f}`).join('\n'));
  process.exit(1);
}
process.exit(0);
