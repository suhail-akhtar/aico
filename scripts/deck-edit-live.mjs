/**
 * Inline (scoped) AI edits on a presentation against a REAL model — the live
 * evidence for ADR 0024's deck section. COSTS MONEY (well under a cent per
 * edit with deepseek-v4-flash): run only when asked.
 *
 *   npx tsup src/test-exports.ts --format esm --outDir dist-test --target node18
 *   node scripts/deck-edit-live.mjs            (AICO_EDIT_MODEL=… to pick another model)
 *
 * Why it exists: the offline suite proves the validator, the fit check and
 * the plumbing with stubs; it cannot prove that a real model, given this
 * prompt, contract and the slide's limits, makes the edit asked for and
 * nothing else — and that what it makes still fits the slide. This runs a
 * dozen edits of every target kind on a realistic board deck and, for each:
 *   1. scope — every other slide hashes the same, and every other field of
 *      the edited slide is identical (element edits);
 *   2. fit — the layout engine reports no error on the slide afterwards;
 *   3. the instruction was done — a rule per case (fewer bullets, a line
 *      chart with the same data, every figure carried into big numbers…);
 *   4. it passed the validator, and how many attempts it took.
 * Plus a stub model that answers with a deliberately broken patch (a title
 * that cannot fit), which the validator must refuse (free).
 *
 * Spend is capped: the run stops before a call that could pass MAX_USD.
 * The real settings are copied read-only into a temp store by test-home.
 */

// A store of this process's own — nothing below may touch ~/.aico. Must stay first.
import './lib/test-home.mjs';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const T = await import(process.env.AICO_TEST_EXPORTS ?? '../dist-test/test-exports.js');
const S = T.DeckScopedEdit;
const M = T.DeckModel;
const L = T.DeckLayout;
const here = path.dirname(fileURLToPath(import.meta.url));
const RAW = fs.readFileSync(path.join(here, 'fixtures', 'inline-edit-deck.json'), 'utf8');
const DECK = M.parseDeck(RAW);
const MODEL = process.env.AICO_EDIT_MODEL ?? 'deepseek-v4-flash';
const MAX_USD = Number(process.env.AICO_MAX_USD ?? 0.05);
const settings = await T.loadSettings();
const doc = { title: 'Q3 2026 board update', tabs: [{ content: RAW }] };
const slide = (id) => DECK.slides.find(s => s.id === id);
const nums = (s) => [...new Set(T.ScopedEdit.numbersIn(s))];

const CASES = [
  {
    id: 'title-punchier', target: { slideId: 's3', elementId: 'title' }, instruction: 'Rewrite the slide title as a short, punchy claim that says what the slide shows — keep its figures.',
    check: (s) => [s.title !== 'Summary' && !/\n/.test(s.title), `a new one-line title ("${s.title}")`],
  },
  {
    id: 'bullets-fit', target: { slideId: 's3', elementId: 'bullets' }, instruction: 'Shorten the text so it fits the slide\'s layout — keep every fact and figure.',
    check: (s) => {
      const before = slide('s3').bullets.map(b => b.text).join(' ');
      const after = s.bullets.map(b => b.text).join(' ');
      return [after.length < before.length, `shorter (${before.length} → ${after.length} chars)`, nums(before).every(n => after.includes(n)), `every figure kept (${nums(before).filter(n => !after.includes(n)).join(', ') || 'all'})`];
    },
  },
  {
    id: 'fewer-bullets', target: { slideId: 's3', elementId: 'bullets' }, instruction: 'Cut it to fewer bullets: keep the strongest points, merge or drop the rest.',
    check: (s) => [s.bullets.length < 5, `fewer bullets (5 → ${s.bullets.length})`],
  },
  {
    id: 'one-bullet', target: { slideId: 's3', elementId: 'bullets.4' }, instruction: 'Make this bullet punchier — one short line, same facts and figures.',
    check: (s) => [s.bullets.length === 5 && s.bullets.every((b, i) => i === 3 || b.text === slide('s3').bullets[i].text), 'only bullet 4 changed', /Contoso/.test(s.bullets[3].text) && /Fabrikam/.test(s.bullets[3].text), `names kept ("${s.bullets[3].text}")`],
  },
  {
    id: 'status-column', target: { slideId: 's5', elementId: 'table', cells: { r0: 0, r1: 3, c0: 2, c1: 2 } }, instruction: 'Make each status clearer by adding a two-word reason, e.g. "At risk — late accounts".',
    check: (s) => {
      const t0 = slide('s5').table;
      return [s.table.rows.every((r, i) => r.every((c, j) => j === 2 || c === t0.rows[i][j])) && s.table.header.join() === t0.header.join(), 'only the Status column changed',
        s.table.rows.some((r, i) => r[2] !== t0.rows[i][2]), 'the column was rewritten'];
    },
  },
  {
    id: 'chart-line', target: { slideId: 's4', elementId: 'chart' }, instruction: 'Change the chart type to a line chart.',
    check: (s) => [s.chart.type === 'line', `a line chart (${s.chart.type})`, JSON.stringify(s.chart.series) === JSON.stringify(slide('s4').chart.series) && JSON.stringify(s.chart.categories) === JSON.stringify(slide('s4').chart.categories), 'same data and categories'],
  },
  {
    id: 'diagram-td', target: { slideId: 's8', elementId: 'diagram' }, instruction: 'Lay it out top to bottom (flowchart TD) so it fits the slide.',
    check: (s) => [/^flowchart TD/.test(s.diagram.trim()), 'top to bottom', T.ScopedEdit.checkMermaid(s.diagram).length === 0 && T.ScopedEdit.mermaidIds(slide('s8').diagram).every(id => T.ScopedEdit.mermaidIds(s.diagram).includes(id)), 'parses (syntax) and keeps every node'],
  },
  {
    id: 'kpi-label', target: { slideId: 's6', elementId: 'kpis.3' }, instruction: 'Make the label clearer for a board audience — a few words.',
    check: (s) => [JSON.stringify(s.kpis.slice(0, 2)) === JSON.stringify(slide('s6').kpis.slice(0, 2)), 'tiles 1–2 untouched', s.kpis[2].value === '15 min', `the figure kept ("${s.kpis[2].value}" · "${s.kpis[2].label}")`],
  },
  {
    id: 'to-big-numbers', target: { slideId: 's3', elementId: 'slide' }, instruction: 'Turn the bullets into big numbers (layout kpi): 2–4 tiles, each a short figure from the bullets with a label — keep every figure.',
    check: (s) => {
      const before = M.slideText(slide('s3'));
      const after = S.slideView(s);
      return [s.layout === 'kpi' && (s.kpis?.length ?? 0) >= 2 && (s.kpis?.length ?? 0) <= 4, `a kpi slide (${s.layout}, ${s.kpis?.length ?? 0} tiles)`, nums(before).every(n => after.includes(n)), 'every figure carried (tiles, labels, commentary or notes)', s.notes === slide('s3').notes, 'notes kept'];
    },
  },
  {
    id: 'write-notes', target: { slideId: 's4', elementId: 'notes' }, instruction: 'Write speaker notes for this slide: what to say, 60–120 words, from the slide\'s own content — no new facts or figures.',
    check: (s) => {
      const words = (s.notes ?? '').split(/\s+/).filter(Boolean).length;
      return [words >= 40 && words <= 160, `notes written (${words} words)`];
    },
  },
  {
    id: 'translate', target: { slideId: 's10', elementId: 'bullets' }, instruction: 'Translate it into French.',
    check: (s) => [s.bullets.length === 3 && (s.bullets.map(b => b.text).join(' ').match(/\b(le|la|les|des|pour|du|de)\b/gi) ?? []).length >= 3, 'three bullets, in French', ['350', '8'].every(n => s.bullets.map(b => b.text).join(' ').includes(n)), 'figures kept'],
  },
  {
    id: 'selection', target: { slideId: 's1', elementId: 'subtitle', range: { start: 0, end: 'Customer Feedback Platform'.length } }, instruction: 'Shorten these words.',
    check: (s) => [s.subtitle.endsWith(': delivery, revenue and the decisions we need') && s.subtitle.length < slide('s1').subtitle.length, `only the selected words changed ("${s.subtitle}")`],
  },
];

let spent = 0;
const RESULTS = [];
for (const c of CASES) {
  if (spent > MAX_USD * 0.85) { console.log(`\nStopping: $${spent.toFixed(4)} spent, cap $${MAX_USD}.`); break; }
  const t0 = Date.now();
  const r = await T.editDeckPart({ doc, target: c.target, instruction: c.instruction, settings, mainModel: MODEL, model: MODEL });
  spent += r.costUsd;
  const out = { id: c.id, ok: r.ok, attempts: r.attempts, ms: Date.now() - t0, cost: r.costUsd, checks: [], scope: false, fits: false, error: r.error, errors: r.errors, warnings: r.warnings };
  if (r.ok && r.slide && r.part) {
    const next = S.withSlide(DECK, r.part.index, r.slide);
    const h0 = S.slideHashes(DECK);
    const h1 = S.slideHashes(next);
    const others = h0.every((h, i) => i === r.part.index || h === h1[i]);
    const v = S.validateDeckPatch(DECK, r.part, r.patch, [c.instruction]);
    out.scope = others && v.scopeHeld;
    const problems = L.layoutSlide(next, r.part.index).problems.filter(p => p.severity === 'error');
    out.fits = problems.length === 0;
    if (!out.fits) out.checks.push({ pass: false, what: `layout: ${problems.map(p => p.message).join('; ')}` });
    try {
      const ck = c.check(r.slide);
      for (let i = 0; i < ck.length; i += 2) out.checks.push({ pass: Boolean(ck[i]), what: ck[i + 1] });
    } catch (err) { out.checks.push({ pass: false, what: `check threw: ${err.message}` }); }
    out.before = r.part.before;
    out.after = r.after;
  }
  out.pass = out.ok && out.scope && out.fits && out.checks.every(x => x.pass);
  RESULTS.push(out);
  console.log(`\n${out.pass ? '✓' : '✗'} ${c.id} — ${out.ok ? `valid after ${out.attempts} attempt(s)` : `refused: ${out.error}`} · ${(out.ms / 1000).toFixed(1)} s · $${out.cost.toFixed(5)}`);
  if (out.ok) console.log(`    scope: ${out.scope ? 'every other slide and field identical' : 'SOMETHING ELSE CHANGED'} · fit: ${out.fits ? 'no layout errors' : 'DOES NOT FIT'}`);
  for (const ck of out.checks) console.log(`    ${ck.pass ? '✓' : '✗'} ${ck.what}`);
  if (out.warnings?.length) console.log(`    warnings: ${out.warnings.join('; ')}`);
  if (!out.ok && out.errors?.length) console.log(`    errors: ${out.errors.join(' | ')}`);
  if (out.after !== undefined) console.log(`    after: ${out.after.slice(0, 300).replace(/\n/g, '\n           ')}`);
}

// The validator against a deliberately broken model answer (a stub: free).
const broken = {
  id: 'stub', displayName: 'Broken stub',
  async *chat() {
    yield { type: 'text', content: JSON.stringify({ text: 'Delivery against the plan for every workstream in the programme, with each owner, status and due date, reviewed week by week by the programme office and the steering group until the end', note: 'too long to fit' }) };
    yield { type: 'finish', reason: 'stop' };
  },
};
const caught = await T.editDeckPart({ doc, target: { slideId: 's5', elementId: 'title' }, instruction: 'Rewrite the slide title as a short, punchy claim', settings, mainModel: MODEL, provider: broken, model: 'stub-model' });
console.log(`\n${!caught.ok ? '✓' : '✗'} broken stub output refused after ${caught.attempts} attempts: ${caught.errors.slice(0, 2).join(' | ')}`);

const passed = RESULTS.filter(r => r.pass).length;
const valid = RESULTS.filter(r => r.ok).length;
const firstTry = RESULTS.filter(r => r.ok && r.attempts === 1).length;
const scoped = RESULTS.filter(r => r.ok && r.scope).length;
const fits = RESULTS.filter(r => r.ok && r.fits).length;
console.log(`\n══ ${passed}/${RESULTS.length} edits passed every check · ${valid} valid (${firstTry} first time) · scope held on ${scoped}/${valid} · fit on ${fits}/${valid} · broken output caught: ${!caught.ok} · model ${MODEL} · spent $${spent.toFixed(4)} ══`);
const report = path.join(process.env.AICO_EVAL_OUT ?? path.join(here, '..', 'dist-test'), 'deck-edit-live.json');
try { fs.mkdirSync(path.dirname(report), { recursive: true }); fs.writeFileSync(report, JSON.stringify({ model: MODEL, spent, results: RESULTS, brokenCaught: !caught.ok }, null, 2)); console.log(`(details: ${report})`); } catch { /* the console has it */ }
process.exit(0);
