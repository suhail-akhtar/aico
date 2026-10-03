/**
 * Inline (scoped) AI edits against a REAL model — ADR 0024's live evidence.
 * COSTS MONEY (a few cents with deepseek-v4-flash): run only when asked.
 *
 *   npm run build && npx tsup src/test-exports.ts --format esm --outDir dist-test --target node18
 *   node scripts/inline-edit-live.mjs            (AICO_EDIT_MODEL=… to pick another model)
 *
 * Why it exists: the offline suite proves the validator and the plumbing with
 * stubs; it cannot prove that a real model, given this prompt and contract,
 * makes the edit asked for and nothing else. This runs ~15 edits of every
 * target kind on a realistic technical proposal and, for each, checks:
 *   1. scope — every block outside the part hashes the same before and after
 *      (the edit is applied with the same `applyPart` the editor uses);
 *   2. the instruction was done — a rule per case (the column exists, the
 *      chart is a line chart with the same data, the node is in the diagram…)
 *      and the judge model only where no rule can read it (tone);
 *   3. it passed the validator, and how many attempts it took.
 * Plus a stub model that answers with a deliberately broken patch, which the
 * validator must catch (free).
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
const S = T.ScopedEdit;
const here = path.dirname(fileURLToPath(import.meta.url));
const DOC = fs.readFileSync(path.join(here, 'fixtures', 'inline-edit-proposal.md'), 'utf8').replace(/\r\n/g, '\n');
const MODEL = process.env.AICO_EDIT_MODEL ?? 'deepseek-v4-flash';
const JUDGE = process.env.AICO_JUDGE_MODEL ?? 'deepseek-v4-flash';
const MAX_USD = Number(process.env.AICO_MAX_USD ?? 0.1);
const settings = await T.loadSettings();
const doc = { title: 'Technical Proposal: Customer Feedback Platform' };

let spent = 0;
const rows = [];
const key = (q) => { const r = S.findPart(DOC, q); if (!r.ok) throw new Error(r.error); return r.target; };
const parseTable = (md) => {
  const lines = md.split('\n').filter(l => l.trim().startsWith('|'));
  const cells = (l) => l.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim());
  return { header: cells(lines[0]), rows: lines.slice(2).map(cells) };
};
const fenceBody = (md) => /```\w*\n([\s\S]*?)\n```/.exec(md)?.[1] ?? '';

const CASES = [
  {
    id: 'grammar-paragraph', target: key({ kind: 'paragraph', quote: 'It dose not include' }), instruction: 'Fix spelling, grammar and punctuation only. Change nothing else.',
    check: (a, b) => [!/dose not/.test(a) && /does not/.test(a), `typo fixed (${/does not/.test(a)})`, T.ScopedDiff.diffStats(T.ScopedDiff.wordDiff(b, a)).removed <= 4, 'at most a few words changed'],
  },
  {
    id: 'shorten-summary', target: key({ kind: 'paragraph', quote: 'Northwind Analytics (the "Supplier") proposes' }), instruction: 'Shorten it to about two-thirds of its length — keep every fact, figure and reference.',
    check: (a, b) => [a.length < b.length * 0.9, `shorter (${b.length} → ${a.length})`, ['15 minutes', '14 weeks', '£412,000', '[1]', 'Section 4.2'].every(x => a.includes(x)), 'figures, citation and cross-reference kept'],
  },
  {
    id: 'add-column', target: key({ kind: 'table', section: 'Responsibilities' }), instruction: 'Add an "Owner" column naming who owns each activity; use [To confirm] where the document does not say.',
    check: (a, b) => {
      const t0 = parseTable(b); const t1 = parseTable(a);
      const at = t0.header.map(h => t1.header.indexOf(h));
      return [t1.header.some(h => /owner/i.test(h)) && t1.header.length === 4, `an Owner column (${t1.header.join(' | ')})`,
        t1.rows.length === 5 && t0.rows.every((r, i) => at.every((j, k) => t1.rows[i][j] === r[k])), 'every existing cell unchanged'];
    },
  },
  {
    id: 'sort-table', target: key({ kind: 'table', section: 'Service Levels' }), instruction: 'Sort the rows alphabetically by Measure.',
    check: (a, b) => {
      const t0 = parseTable(b); const t1 = parseTable(a);
      const names = t1.rows.map(r => r[0]);
      return [JSON.stringify(names) === JSON.stringify([...names].sort((x, y) => x.localeCompare(y))), `sorted (${names.join(', ')})`,
        JSON.stringify([...t0.rows].sort()) === JSON.stringify([...t1.rows].sort()), 'the same rows, only reordered'];
    },
  },
  {
    id: 'bar-to-line', target: key({ kind: 'chart' }), instruction: 'Change it to a line chart.',
    check: (a, b) => {
      const o0 = JSON.parse(fenceBody(b)); const o1 = JSON.parse(fenceBody(a));
      return [o1.series.every(s => s.type === 'line'), 'a line chart', JSON.stringify(o1.series[0].data) === JSON.stringify(o0.series[0].data) && JSON.stringify(o1.xAxis.data) === JSON.stringify(o0.xAxis.data), 'same data and categories'];
    },
  },
  {
    id: 'add-series', target: key({ kind: 'chart' }), instruction: 'Add a data series named "Target" with the values 1500, 2000, 2500, 3000, 3500.',
    check: (a) => {
      const o = JSON.parse(fenceBody(a));
      const t = o.series.find(s => /target/i.test(s.name ?? ''));
      return [o.series.length === 2 && Boolean(t), 'a second series', JSON.stringify(t?.data) === '[1500,2000,2500,3000,3500]', `with the given values (${JSON.stringify(t?.data)})`];
    },
  },
  {
    id: 'diagram-node', target: key({ kind: 'diagram' }), instruction: 'Add a node for the in-store kiosk that feeds Ingestion.',
    check: (a, b) => {
      const src = fenceBody(a);
      return [/kiosk/i.test(src) && /-->\s*ING\b/.test(src.split('\n').find(l => /kiosk/i.test(l)) ?? '') , 'a kiosk node feeding ING',
        S.checkMermaid(src).length === 0 && S.mermaidIds(fenceBody(b)).every(id => S.mermaidIds(src).includes(id)), 'parses (syntax) and keeps every node'];
    },
  },
  {
    id: 'callout-formal', target: key({ kind: 'callout' }), instruction: 'Make it more formal.', judge: 'PASS if the answer is a formal, professional rewording of an assumption that the Client provides CRM test accounts by week 2, and that a delay moves the integration back by the same time. FAIL if it changes those facts or is not formal.',
    check: (a) => [a.startsWith('```callout warn\n'), 'still a warn callout (fence kept)', /week 2/i.test(a), 'week 2 kept'],
  },
  {
    id: 'translate', target: key({ kind: 'paragraph', section: '4.2 Ingestion' }), instruction: 'Translate it into French.',
    check: (a) => [(a.match(/\b(le|la|les|des|est|nous|une|pour|que)\b/gi) ?? []).length >= 5, 'French', a.includes('[2]') && /HTTPS/.test(a), 'citation and terms kept'],
  },
  {
    id: 'selection', target: (() => { const t = key({ kind: 'paragraph', quote: "scaled on it's own" }); const b = S.resolveTarget(DOC, t); const at = b.part.before.indexOf("on it's own"); return { ...t, range: { start: at, end: at + "on it's own".length } }; })(),
    instruction: 'Fix the grammar.',
    check: (a, b) => [a === b.replace("on it's own", 'on its own'), 'only the selected words changed'],
  },
  {
    id: 'heading', target: key({ kind: 'heading', quote: 'Delivery Plan' }), instruction: 'Make the heading more specific to what the section shows.',
    check: (a) => [a.startsWith('## 6 ') && a.split('\n').length === 1, `numbering and level kept (${a})`],
  },
  {
    id: 'section-grammar', target: { ...key({ kind: 'heading', quote: '2 Scope' }), part: 'section' }, instruction: 'Fix spelling, grammar and punctuation only.',
    check: (a) => [a.startsWith('## 2 Scope\n') && /does not/.test(a) && a.includes('```callout warn'), 'heading kept, typo fixed, callout kept', /\[docs\]\(https:\/\/api\.contoso\.example\/docs\)/.test(a), 'link kept'],
  },
  {
    id: 'cells-column', target: { ...key({ kind: 'table', section: 'Service Levels' }), cells: { r0: 0, r1: 3, c0: 2, c1: 2 } }, instruction: 'Write each value as a short phrase, e.g. "Every month".',
    check: (a, b) => {
      const t0 = parseTable(b); const t1 = parseTable(a);
      return [t1.rows.every((r, i) => r[0] === t0.rows[i][0] && r[1] === t0.rows[i][1]), 'columns 1–2 untouched', t1.rows.some((r, i) => r[2] !== t0.rows[i][2]), 'column 3 rewritten'];
    },
  },
  {
    id: 'caption', target: key({ kind: 'image' }), instruction: 'Fix the capitalisation and spelling of the caption.',
    check: (a) => [/"Dashboard mock-?up/.test(a) && a.startsWith('![Dashboard mock-up](https://example.com/dashboard.png "'), `caption fixed, image kept (${a})`],
  },
  {
    id: 'to-list', target: key({ kind: 'paragraph', quote: 'Our approach is deliberately incremental' }), instruction: 'Turn it into a bulleted list.',
    check: (a) => [/^\s*[-*] /m.test(a), 'a list', ['6', '38', '12', '14', 'Table 2'].every(x => a.includes(x)), 'every figure and the reference kept'],
  },
];

const RESULTS = [];
for (const c of CASES) {
  if (spent > MAX_USD * 0.85) { console.log(`\nStopping: $${spent.toFixed(4)} spent, cap $${MAX_USD}.`); break; }
  const t0 = Date.now();
  const r = await T.editDocPart({ doc, tab: { content: DOC }, target: c.target, instruction: c.instruction, settings, mainModel: MODEL, model: MODEL });
  spent += r.costUsd;
  const out = { id: c.id, ok: r.ok, attempts: r.attempts, ms: Date.now() - t0, cost: r.costUsd, checks: [], scope: false, error: r.error, warnings: r.warnings };
  if (r.ok && r.after !== undefined && r.part) {
    const applied = S.applyPart(DOC, r.part, r.after);
    out.scope = applied.ok && JSON.stringify(S.outsideHashes(DOC, r.part.span)) === JSON.stringify(S.outsideHashes(applied.text, { start: applied.start, end: applied.start + r.after.length }));
    try {
      const ck = c.check(r.after, r.part.before);
      for (let i = 0; i < ck.length; i += 2) out.checks.push({ pass: Boolean(ck[i]), what: ck[i + 1] });
    } catch (err) { out.checks.push({ pass: false, what: `check threw: ${err.message}` }); }
    if (c.judge && spent < MAX_USD * 0.9) {
      const v = await T.judge({ rubric: c.judge, task: c.instruction, answer: r.after, model: JUDGE, settings });
      spent += v.costUsd;
      out.checks.push({ pass: v.pass, what: `judge: ${v.reason}` });
    }
    out.after = r.after;
  }
  out.pass = out.ok && out.scope && out.checks.every(x => x.pass);
  RESULTS.push(out);
  console.log(`\n${out.pass ? '✓' : '✗'} ${c.id} — ${out.ok ? `valid after ${out.attempts} attempt(s)` : `refused: ${out.error}`} · ${(out.ms / 1000).toFixed(1)} s · $${out.cost.toFixed(5)}`);
  if (out.ok) console.log(`    scope: ${out.scope ? 'every other block byte-identical' : 'OTHER BLOCKS CHANGED'}`);
  for (const ck of out.checks) console.log(`    ${ck.pass ? '✓' : '✗'} ${ck.what}`);
  if (out.warnings?.length) console.log(`    warnings: ${out.warnings.join('; ')}`);
  if (!out.pass && out.after) console.log(`    after: ${out.after.slice(0, 400).replace(/\n/g, '\n           ')}`);
}

// The validator against a deliberately broken model answer (a stub: free).
const broken = {
  id: 'stub', displayName: 'Broken stub',
  async *chat() {
    yield { type: 'text', content: JSON.stringify({ header: ['Activity', 'Supplier'], rows: [['Requirements workshops', 'R']], note: 'dropped a column and four rows' }) };
    yield { type: 'finish', reason: 'stop' };
  },
};
const caught = await T.editDocPart({ doc, tab: { content: DOC }, target: key({ kind: 'table', section: 'Responsibilities' }), instruction: 'Fix grammar', settings, mainModel: MODEL, provider: broken, model: 'stub-model' });
console.log(`\n${!caught.ok ? '✓' : '✗'} broken stub output refused after ${caught.attempts} attempts: ${caught.errors.slice(0, 2).join(' | ')}`);

const passed = RESULTS.filter(r => r.pass).length;
const firstTry = RESULTS.filter(r => r.ok && r.attempts === 1).length;
const scoped = RESULTS.filter(r => r.ok && r.scope).length;
const valid = RESULTS.filter(r => r.ok).length;
console.log(`\n══ ${passed}/${RESULTS.length} edits passed every check · ${valid} valid (${firstTry} first time) · scope held on ${scoped}/${valid} · broken output caught: ${!caught.ok} · model ${MODEL} · spent $${spent.toFixed(4)} ══`);
const report = path.join(process.env.AICO_EVAL_OUT ?? path.join(here, '..', 'dist-test'), 'inline-edit-live.json');
try { fs.mkdirSync(path.dirname(report), { recursive: true }); fs.writeFileSync(report, JSON.stringify({ model: MODEL, spent, results: RESULTS, brokenCaught: !caught.ok }, null, 2)); console.log(`(details: ${report})`); } catch { /* the console has it */ }
process.exit(0);
