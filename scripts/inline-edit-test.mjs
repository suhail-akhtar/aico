/**
 * Inline (scoped) AI edits, offline — ADR 0024, shared/ui/canvas/scoped-edit,
 * src/canvas/inline-edit, the Canvas tool's `edit_part` and the
 * `canvas/edit-part` route.
 *
 * Why it exists: the promise of an inline edit is "this part and nothing
 * else", and every piece of that promise is code that can quietly regress —
 * a target that resolves to the wrong span, a context that grows with the
 * document, a validator that lets a table lose a row or a chart gain an
 * invented number, an apply that lets a list swallow the next paragraph, an
 * undo that does not give the original back. Each is asserted here, plus the
 * retry-once loop with a stub provider (no network, no keys), and that a
 * deliberately broken model answer is caught.
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
const S = T.ScopedEdit;
const D = T.ScopedDiff;
const here = path.dirname(fileURLToPath(import.meta.url));
const DOC = fs.readFileSync(path.join(here, 'fixtures', 'inline-edit-proposal.md'), 'utf8').replace(/\r\n/g, '\n');

let passed = 0;
let failed = 0;
const failures = [];
function assert(cond, name) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; failures.push(name); console.log(`  ✗ ${name}`); }
}
async function block(title, fn) {
  console.log(`\n══ ${title} ══`);
  try { await fn(); } catch (err) { assert(false, `${title}: threw ${err?.stack ?? err}`); }
}

/** The key of the first block whose text matches. */
function keyOf(text, test) {
  const r = S.findPart(text, typeof test === 'string' ? { quote: test } : test);
  if (!r.ok) throw new Error(r.error);
  return r.target.blockIds[0];
}
const resolve = (text, target) => S.resolveTarget(text, target);
const must = (r) => { if (!r.ok) throw new Error(r.error); return r.part; };

await block('Targets resolve to exact spans and structured forms', async () => {
  const para = must(resolve(DOC, { blockIds: [keyOf(DOC, 'Our approach is deliberately incremental')] }));
  assert(para.kind === 'text' && para.what === 'paragraph' && DOC.slice(para.span.start, para.span.end) === para.before && para.before.startsWith('Our approach'),
    'a paragraph: kind text, its exact span');
  const h = must(resolve(DOC, { blockIds: [keyOf(DOC, { kind: 'heading', quote: 'Service Levels' })] }));
  assert(h.kind === 'text' && h.wrap.head === '## 5 ' && h.editable === 'Service Levels', 'a numbered heading: the model sees only its text; "## 5 " is kept for it');
  const sec = must(resolve(DOC, { blockIds: [keyOf(DOC, { kind: 'heading', quote: 'Scope' })], part: 'section' }));
  assert(sec.kind === 'blocks' && sec.section.heading === '2 Scope' && sec.blockKinds.join() === 'heading,paragraph,list,code', `a section: the heading and every block under it (${sec.blockKinds.join()})`);
  const tbl = must(resolve(DOC, { blockIds: [keyOf(DOC, { kind: 'table', quote: 'Requirements workshops' })] }));
  assert(tbl.kind === 'table' && tbl.table.header.join() === 'Activity,Supplier,Client' && tbl.table.rows.length === 5, 'a table: header and rows');
  const cells = must(resolve(DOC, { blockIds: [keyOf(DOC, { kind: 'table', quote: 'Requirements workshops' })], cells: { r0: 1, r1: 2, c0: 1, c1: 2 } }));
  assert(cells.kind === 'cells' && cells.label === 'Table · rows 2–3 · columns 2–3', `a cell range (${cells.label})`);
  const col = must(resolve(DOC, { blockIds: [keyOf(DOC, { kind: 'table', quote: 'Availability' })], cells: { r0: 0, r1: 3, c0: 1, c1: 1 } }));
  assert(col.label === 'Table · column “Target”', `a column (${col.label})`);
  const chart = must(resolve(DOC, { blockIds: [keyOf(DOC, { kind: 'chart' })] }));
  assert(chart.kind === 'chart' && chart.chart.series[0].type === 'bar' && chart.wrap.head === '```chart\n', 'a chart: its ECharts option; the fence is kept');
  const mer = must(resolve(DOC, { blockIds: [keyOf(DOC, { kind: 'diagram' })] }));
  assert(mer.kind === 'mermaid' && mer.label === 'Diagram · flowchart' && mer.editable.startsWith('flowchart LR'), 'a diagram: its Mermaid source');
  const cap = must(resolve(DOC, { blockIds: [keyOf(DOC, { kind: 'image' })] }));
  assert(cap.kind === 'caption' && cap.editable === 'dashboard mockup showing the routing queue', 'an image: its caption');
  const callout = must(resolve(DOC, { blockIds: [keyOf(DOC, { kind: 'callout' })] }));
  assert(callout.kind === 'text' && callout.what === 'callout' && callout.wrap.head === '```callout warn\n' && callout.editable.startsWith('**Assumption**'), 'a callout: its body; the fence line is kept');
  const k1 = keyOf(DOC, 'Our approach is deliberately');
  const k0 = keyOf(DOC, 'Northwind Analytics (the "Supplier")');
  const multi = must(resolve(DOC, { blockIds: [k1, k0] }));
  assert(multi.kind === 'blocks' && multi.blocks.to - multi.blocks.from === 2, 'two neighbouring blocks: one span, in order whatever order they were named');
  const pkey = keyOf(DOC, 'It dose not include');
  const pText = must(resolve(DOC, { blockIds: [pkey] })).before;
  const at = pText.indexOf('dose not');
  const sel = must(resolve(DOC, { blockIds: [pkey], range: { start: at, end: at + 'dose not include'.length } }));
  assert(sel.selection && sel.editable.slice(sel.selection.start, sel.selection.end) === 'dose not include' && sel.label === 'Selection in paragraph', 'a selection: a range inside the block');
  // Refusals a person can act on.
  assert(!resolve(DOC, { blockIds: ['nope'] }).ok, 'an unknown block is refused');
  assert(/not next to each other/.test(resolve(DOC, { blockIds: [k0, keyOf(DOC, 'The total first-year cost')] }).error ?? ''), 'blocks that are not contiguous are refused');
  assert(/range/.test(resolve(DOC, { blockIds: [keyOf(DOC, { kind: 'chart' })], range: { start: 3, end: 9 } }).error ?? ''), 'a text range inside a chart is refused');
  const big = `# Big\n\n${'word '.repeat(4000)}`;
  assert(/inline edit takes up to/.test(resolve(big, { blockIds: [S.findPart(big, { kind: 'paragraph' }).target.blockIds[0]] }).error ?? ''), 'a part over the size limit is refused with the reason');
});

await block('Context is bounded and deterministic', async () => {
  const part = must(resolve(DOC, { blockIds: [keyOf(DOC, 'Each part can be scaled')] }));
  const info = T.docInfo({ title: 'Technical Proposal: Customer Feedback Platform' });
  const a = S.buildEditContext(DOC, part, info);
  const b = S.buildEditContext(DOC, part, info);
  assert(JSON.stringify(a) === JSON.stringify(b), 'the same document and target give the same context');
  assert(a.before.length <= S.CONTEXT_LIMITS.neighbours && a.after.length <= S.CONTEXT_LIMITS.neighbours, `at most ${S.CONTEXT_LIMITS.neighbours} blocks either side`);
  assert([...a.before, ...a.after].every(x => x.length <= S.CONTEXT_LIMITS.neighbourChars + 5), 'each neighbour clipped');
  assert(!a.whole, 'the whole document is not sent (it is not small)');
  assert(a.outline.some(l => l.startsWith('→') && l.includes('4.1 Overview')), 'the outline marks the section holding the part');
  assert(info.docType?.startsWith('Proposal') || info.docType?.includes('roposal'), `the document type is named (${info.docType})`);
  assert(a.terms.includes('Supplier') && a.terms.includes('Client'), `defined terms found (${a.terms.join(', ')})`);
  assert(a.style.some(r => /parties by role/.test(r)) && a.style.some(r => /numbered/.test(r)), `house style read from the text (${a.style.join('; ')})`);
  const huge = `${DOC}\n\n${Array.from({ length: 300 }, (_, i) => `## Extra ${i}\n\nPara ${i} ${'x'.repeat(900)}`).join('\n\n')}`;
  const c = S.buildEditContext(huge, must(resolve(huge, { blockIds: [keyOf(huge, 'Each part can be scaled')] })), info);
  const size = JSON.stringify(c).length;
  assert(c.outline.length <= S.CONTEXT_LIMITS.outline && size < 12_000, `a document 100× larger gives a context of the same order (${size} chars)`);
  const small = '# Note\n\nOne short paragraph.\n\nAnother one.\n';
  const sc = S.buildEditContext(small, must(resolve(small, { blockIds: [keyOf(small, 'One short')] })), { title: 'Note' });
  assert(sc.whole === small && !sc.before.length, 'a small document is sent whole');
  const prompt = T.editPrompt(part, a, 'Fix grammar');
  assert(prompt.indexOf('document context') < prompt.indexOf('The part to edit') && prompt.trimEnd().endsWith('Instruction: Fix grammar'),
    'the prompt: context first (fenced as data), the part, the contract, the instruction last');
});

await block('What an instruction allows', async () => {
  const i = (s) => S.intentOf([s]);
  assert(i('Turn it into a table.').convert && !i('Make it more formal').convert, 'convert only when a new shape is asked for');
  assert(i('Add a column for Owner').columns && !i('Add a column for Owner').rows, 'add a column');
  assert(i('Change it to a line chart.').chartType && !i('Change it to a line chart.').data, 'chart type, not data');
  assert(i('Fix spelling, grammar and punctuation only. Change nothing else.').strict && !i('Fix spelling, grammar and punctuation only. Change nothing else.').data, 'a correction is strict');
  assert(i('Add a data series for 2025').data, 'a new series is a data change');
  assert(i('Shorten it — keep every fact').shorten, 'shorten');
  assert(i('Translate it into French').translate, 'translate');
  assert(S.intentOf(['Turn it into a table', 'shorter still']).convert, 'a follow-up keeps what the first instruction allowed');
});

await block('Validators: text', async () => {
  const p = must(resolve(DOC, { blockIds: [keyOf(DOC, 'It dose not include')] }));
  const fixed = p.editable.replace('dose not', 'does not').replace('which remains', 'which remain');
  let v = S.validatePatch(p, { kind: 'text', text: fixed }, ['Fix grammar']);
  assert(v.ok && v.after === fixed, 'a grammar fix passes');
  v = S.validatePatch(p, { kind: 'text', text: `${fixed}\n\nAnd a new paragraph.` }, ['Fix grammar']);
  assert(!v.ok && v.errors.some(e => /became 2 blocks/.test(e)), 'a paragraph that becomes two is refused');
  v = S.validatePatch(p, { kind: 'text', text: `- ${fixed}` }, ['Fix grammar']);
  assert(!v.ok && v.errors.some(e => /became a list/.test(e)), 'a paragraph that becomes a list is refused');
  v = S.validatePatch(p, { kind: 'text', text: fixed.replace('24 months', '36 months') }, ['Fix grammar']);
  assert(!v.ok && v.errors.some(e => /numbers were dropped/.test(e)) && v.errors.some(e => /new numbers/.test(e)), 'a changed figure is refused');
  v = S.validatePatch(p, { kind: 'text', text: fixed.replace('point-of-sale', '**point-of-sale**') }, ['Fix grammar']);
  assert(!v.ok && v.errors.some(e => /bold\/italic/.test(e)), 'formatting added by a correction is refused');
  v = S.validatePatch(p, { kind: 'text', text: 'Short.' }, ['Expand it with detail']);
  assert(!v.ok && v.errors.some(e => /not longer/.test(e)), 'asked to expand but shorter: refused');
  const exec = must(resolve(DOC, { blockIds: [keyOf(DOC, 'Northwind Analytics (the "Supplier")')] }));
  v = S.validatePatch(exec, { kind: 'text', text: exec.editable.replace(' [1]', '').replace('Section 4.2', 'the section below') }, ['Make it more formal']);
  assert(!v.ok && v.errors.some(e => /citations/.test(e)) && v.errors.some(e => /cross-references/.test(e)), 'a dropped citation and cross-reference are refused');
  const list = must(resolve(DOC, { blockIds: [keyOf(DOC, { kind: 'list', section: 'Scope' })] }));
  v = S.validatePatch(list, { kind: 'text', text: list.editable.replace(' ([docs](https://api.contoso.example/docs))', '') }, ['Simplify the wording']);
  assert(!v.ok && v.errors.some(e => /links were dropped/.test(e)), 'a dropped link is refused');
  v = S.validatePatch(list, { kind: 'text', text: list.editable.split('\n').slice(0, 3).join('\n') }, ['Fix grammar']);
  assert(!v.ok && v.errors.some(e => /had 4 items and now has 3/.test(e)), 'a correction may not drop a list item');
  const h = must(resolve(DOC, { blockIds: [keyOf(DOC, { kind: 'heading', quote: 'Service Levels' })] }));
  v = S.validatePatch(h, { kind: 'text', text: 'Service levels and targets' }, ['Make the heading clearer']);
  assert(v.ok && v.after === '## 5 Service levels and targets', 'a heading edit keeps its marks and number by construction');
  v = S.validatePatch(h, { kind: 'text', text: '## Service levels' }, ['Make the heading clearer']);
  assert(!v.ok && v.errors.some(e => /heading text only/.test(e)), 'a heading answer that repeats the marks is refused');
  const pkey = keyOf(DOC, 'It dose not include');
  const ptext = must(resolve(DOC, { blockIds: [pkey] })).before;
  const at = ptext.indexOf('dose not include');
  const sel = must(resolve(DOC, { blockIds: [pkey], range: { start: at, end: at + 16 } }));
  v = S.validatePatch(sel, { kind: 'text', text: 'does not include' }, ['Fix grammar']);
  assert(v.ok && v.after === ptext.replace('dose not include', 'does not include'), 'a selection edit changes only the selected words');
  v = S.validatePatch(sel, { kind: 'text', text: 'does not\n\ninclude' }, ['Fix grammar']);
  assert(!v.ok, 'a selection replacement with a blank line is refused');
  v = S.validatePatch(sel, { kind: 'text', text: sel.editable.slice(sel.selection.start, sel.selection.end) }, ['Fix grammar']);
  assert(v.ok && v.unchanged, 'no change is reported as unchanged, not as an error');
  // Conversion: only when asked, and into what was asked, keeping every figure.
  const sla = must(resolve(DOC, { blockIds: [keyOf(DOC, 'Our approach is deliberately')] }));
  v = S.validatePatch(sla, { kind: 'blocks', markdown: '| Milestone | Week |\n| --- | --- |\n| Pilot | 6 |' }, ['Make it more formal']);
  assert(!v.ok && v.errors.some(e => /must stay a paragraph/.test(e)), 'a type change nobody asked for is refused');
  v = S.validatePatch(sla, { kind: 'blocks', markdown: '| Milestone | Week |\n| --- | --- |\n| Pilot (two teams) | 6 |\n| Rollout (38 stores) | 12 |\n| Hand-over after four consecutive weeks on Table 2 targets | 14 |' }, ['Turn it into a table.']);
  assert(v.ok, `asked for a table: a table with every figure passes (${v.errors.join('; ')})`);
  v = S.validatePatch(sla, { kind: 'blocks', markdown: '| Milestone | Week |\n| --- | --- |\n| Pilot | 6 |' }, ['Turn it into a table.']);
  assert(!v.ok && v.errors.some(e => /figures were lost/.test(e)), 'a conversion that loses figures is refused');
});

await block('Validators: tables, cells, charts, diagrams, captions, sections', async () => {
  const raci = must(resolve(DOC, { blockIds: [keyOf(DOC, { kind: 'table', quote: 'Requirements workshops' })] }));
  const t = raci.table;
  const withOwner = { kind: 'table', header: [...t.header, 'Owner'], rows: t.rows.map((r, i) => [...r, ['Priya', 'Tom', 'Contoso IT', 'Contoso QA', 'Steering group'][i]]) };
  let v = S.validatePatch(raci, withOwner, ['Add a column for Owner']);
  assert(v.ok && /\| Owner/.test(v.after), 'adding a column passes');
  v = S.validatePatch(raci, { ...withOwner, rows: withOwner.rows.map((r, i) => (i === 1 ? ['Platform build', 'R', 'C', 'Tom'] : r)) }, ['Add a column for Owner']);
  assert(!v.ok && v.errors.some(e => /had cells changed/.test(e)), 'adding a column while changing another cell is refused');
  v = S.validatePatch(raci, withOwner, ['Fix grammar']);
  assert(!v.ok && v.errors.some(e => /3 columns and now has 4/.test(e)), 'a column nobody asked for is refused');
  v = S.validatePatch(raci, { kind: 'table', header: t.header, rows: t.rows.slice(0, 4) }, ['Fix grammar']);
  assert(!v.ok && v.errors.some(e => /5 rows and now has 4/.test(e)), 'a dropped row is refused');
  v = S.validatePatch(raci, { kind: 'table', header: t.header, rows: t.rows.map((r, i) => (i === 0 ? r.slice(0, 2) : r)) }, ['Fix grammar']);
  assert(!v.ok && v.errors.some(e => /row 1 has 2 cells/.test(e)), 'a ragged row is refused');
  v = S.validatePatch(raci, { kind: 'table', header: ['Task', 'Supplier', 'Client'], rows: t.rows }, ['Fix grammar']);
  assert(!v.ok && v.errors.some(e => /headers changed/.test(e)), 'a renamed header is refused unless asked');
  const sorted = [...t.rows].sort((a, b) => a[0].localeCompare(b[0]));
  v = S.validatePatch(raci, { kind: 'table', header: t.header, rows: sorted }, ['Sort the rows by Activity']);
  assert(v.ok, 'sorting passes: every row kept as it was');
  const sla = must(resolve(DOC, { blockIds: [keyOf(DOC, { kind: 'table', quote: 'Availability' })] }));
  v = S.validatePatch(sla, { kind: 'table', header: sla.table.header, rows: sla.table.rows.map((r, i) => (i === 0 ? ['Availability', '99.95%', 'Monthly'] : r)) }, ['Fix grammar']);
  assert(!v.ok && v.errors.some(e => /numbers/.test(e)), 'a changed SLA figure is refused');
  const cells = must(resolve(DOC, { blockIds: [keyOf(DOC, { kind: 'table', quote: 'Requirements workshops' })], cells: { r0: 0, r1: 1, c0: 0, c1: 0 } }));
  v = S.validatePatch(cells, { kind: 'cells', cells: [['Requirements workshop'], ['Platform build']] }, ['Fix grammar']);
  assert(v.ok && v.after.includes('Requirements workshop ') && v.after.includes('| User acceptance testing'), 'a cell-range edit changes only the marked cells');
  v = S.validatePatch(cells, { kind: 'cells', cells: [['a', 'b']] }, ['Fix grammar']);
  assert(!v.ok && v.errors.some(e => /exactly 2 row/.test(e)), 'cells of the wrong shape are refused');

  const chart = must(resolve(DOC, { blockIds: [keyOf(DOC, { kind: 'chart' })] }));
  const line = JSON.parse(JSON.stringify(chart.chart));
  line.series[0].type = 'line';
  v = S.validatePatch(chart, { kind: 'chart', spec: line }, ['Change it to a line chart.']);
  assert(v.ok && v.after.startsWith('```chart\n') && v.after.includes('"type": "line"'), 'bar → line when asked');
  v = S.validatePatch(chart, { kind: 'chart', spec: line }, ['Make the labels clearer']);
  assert(!v.ok && v.errors.some(e => /chart type changed/.test(e)), 'a chart type change nobody asked for is refused');
  const invented = JSON.parse(JSON.stringify(line));
  invented.series[0].data[4] = 4000;
  v = S.validatePatch(chart, { kind: 'chart', spec: invented }, ['Change it to a line chart.']);
  assert(!v.ok && v.errors.some(e => /data values/.test(e)), 'changed chart data is refused');
  const short = JSON.parse(JSON.stringify(line));
  short.series[0].data = short.series[0].data.slice(0, 4);
  assert(S.checkChart(short).some(e => /4 values but the category axis has 5/.test(e)), 'series/axis length mismatch is caught');
  assert(S.checkChart({ series: [{ type: 'barz', data: [1] }] }).some(e => /not an ECharts series type/.test(e)), 'an unknown series type is caught');

  const mer = must(resolve(DOC, { blockIds: [keyOf(DOC, { kind: 'diagram' })] }));
  const added = `${mer.editable}\n  KI[Kiosk] --> ING`;
  v = S.validatePatch(mer, { kind: 'mermaid', source: added }, ['Add a node for the in-store kiosk']);
  assert(v.ok && v.after.endsWith('KI[Kiosk] --> ING\n```'), 'adding a node passes; the fence is kept');
  v = S.validatePatch(mer, { kind: 'mermaid', source: mer.editable.replace('  DB --> DASH[Dashboard]', '') }, ['Label the arrows']);
  assert(!v.ok && v.errors.some(e => /DASH/.test(e)), 'a node lost without being asked is refused');
  assert(S.checkMermaid('flowchart LR\n  A[Start --> B').some(e => /unbalanced/.test(e)), 'unbalanced brackets are caught');
  assert(S.checkMermaid('flowhcart LR\n  A --> B').some(e => /first line/.test(e)), 'an unknown diagram header is caught');
  assert(S.checkMermaid('flowchart LR\n  A --> ').some(e => /nothing after it/.test(e)), 'a dangling arrow is caught');
  assert(S.checkMermaid('flowchart TD\n  subgraph X\n  A --> B').some(e => /not closed/.test(e)), 'an unclosed subgraph is caught');
  assert(S.checkMermaid(mer.editable).length === 0, 'the document\'s own diagram passes');
  v = S.validatePatch(mer, { kind: 'mermaid', source: 'sequenceDiagram\n  EM->>ING: mail' }, ['Simplify the diagram']);
  assert(!v.ok && v.errors.some(e => /diagram type changed/.test(e)), 'a diagram type change nobody asked for is refused');

  const cap = must(resolve(DOC, { blockIds: [keyOf(DOC, { kind: 'image' })] }));
  v = S.validatePatch(cap, { kind: 'caption', caption: 'Dashboard mock-up showing the routing queue' }, ['Fix grammar']);
  assert(v.ok && v.after === '![Dashboard mock-up](https://example.com/dashboard.png "Dashboard mock-up showing the routing queue")', 'a caption edit rewrites only the caption');

  const sec = must(resolve(DOC, { blockIds: [keyOf(DOC, { kind: 'heading', quote: 'Scope' })], part: 'section' }));
  v = S.validatePatch(sec, { kind: 'blocks', markdown: sec.before.replace('## 2 Scope', '## 2 What we will do') }, ['Fix grammar']);
  assert(!v.ok && v.errors.some(e => /heading changed/.test(e)), 'a section edit may not rename its heading unless asked');
  v = S.validatePatch(sec, { kind: 'blocks', markdown: sec.before.split('\n\n').filter(b => !b.startsWith('```')).join('\n\n') }, ['Shorten it']);
  assert(!v.ok && v.errors.some(e => /blocks were removed/.test(e)), 'a section edit may not drop its callout');
  v = S.validatePatch(sec, { kind: 'blocks', markdown: sec.before.replace('dose not', 'does not') }, ['Fix grammar']);
  assert(v.ok, 'a section grammar fix passes');
});

await block('Applying: only the span changes; merges and stale spans are refused; undo restores', async () => {
  const p = must(resolve(DOC, { blockIds: [keyOf(DOC, 'It dose not include')] }));
  const v = S.validatePatch(p, { kind: 'text', text: p.editable.replace('dose not', 'does not') }, ['Fix grammar']);
  const before = S.outsideHashes(DOC, p.span);
  const r = S.applyPart(DOC, p, v.after);
  assert(r.ok, 'applied');
  const after = S.outsideHashes(r.text, { start: r.start, end: r.start + v.after.length });
  assert(JSON.stringify(before) === JSON.stringify(after) && before.length > 20, `every other block is byte-identical (${before.length} blocks hashed)`);
  // Somebody typed elsewhere first: the part is found by its text.
  const moved = `Intro typed meanwhile.\n\n${DOC}`;
  const r2 = S.applyPart(moved, p, v.after);
  assert(r2.ok && r2.text === `Intro typed meanwhile.\n\n${r.text}`, 'a part that moved is found by its exact text');
  const gone = DOC.replace('It dose not include', 'It no longer includes');
  assert(!S.applyPart(gone, p, v.after).ok, 'a part that changed since is refused, not guessed');
  const merge = S.applyPart(DOC, p, '```\nunclosed fence');
  assert(!merge.ok && /merge/.test(merge.error), 'an edit that would swallow the blocks after it is refused');
  // Undo is the same operation backwards.
  const undo = S.applyPart(r.text, { span: { start: r.start, end: r.start + v.after.length }, before: v.after }, p.before);
  assert(undo.ok && undo.text === DOC, 'undo gives the original document back, byte for byte');
});

await block('The model call: contract, retry once, give up with reasons', async () => {
  T.resetRoleSpend();
  const part = must(resolve(DOC, { blockIds: [keyOf(DOC, { kind: 'table', quote: 'Requirements workshops' })] }));
  const ctx = S.buildEditContext(DOC, part, { title: 'Proposal' });
  const t = part.table;
  const good = JSON.stringify({ header: [...t.header, 'Owner'], rows: t.rows.map(r => [...r, 'TBC']), note: 'Added an Owner column.' });
  const broken = JSON.stringify({ header: [...t.header, 'Owner'], rows: t.rows.slice(0, 4).map(r => [...r, 'TBC']) }); // the deliberately broken output
  const stub = (answers) => {
    const calls = [];
    return {
      calls,
      provider: {
        id: 'stub', displayName: 'Stub',
        async *chat(o) {
          calls.push(o);
          yield { type: 'text', content: answers[Math.min(calls.length - 1, answers.length - 1)] };
          yield { type: 'usage', inputTokens: 2000, outputTokens: 200 };
          yield { type: 'finish', reason: 'stop' };
        },
      },
    };
  };
  const settings = { providerInstances: [{ id: 'deepseek', type: 'deepseek', name: 'DeepSeek', apiKey: 'k' }] };
  let s = stub([`\`\`\`json\n${good}\n\`\`\``]);
  let r = await T.editPart({ part, context: ctx, instruction: 'Add a column for Owner', settings, mainModel: 'deepseek-v4-flash', provider: s.provider });
  assert(r.ok && r.attempts === 1 && r.note === 'Added an Owner column.' && /\| Owner/.test(r.after), 'a good answer (even fenced) passes first time');
  assert(s.calls[0].systemPrompt === T.EDIT_SYSTEM && s.calls[0].tools.length === 0 && s.calls[0].signal instanceof AbortSignal, 'fixed system rules, no tools, a deadline');
  assert(r.model === 'deepseek-v4-flash' && r.costUsd > 0 && T.roleSpend().edit?.calls === 1, 'the edit role\'s model, costed against the edit role');
  s = stub([broken, good]);
  r = await T.editPart({ part, context: ctx, instruction: 'Add a column for Owner', settings, mainModel: 'deepseek-v4-flash', provider: s.provider });
  assert(r.ok && r.attempts === 2, 'a broken answer is caught and retried once');
  const retry = s.calls[1].messages;
  assert(retry.length === 3 && retry[1].role === 'assistant' && /rejected/.test(retry[2].content) && /5 rows and now has 4/.test(retry[2].content), 'the retry carries the validator\'s reasons');
  s = stub([broken, broken]);
  r = await T.editPart({ part, context: ctx, instruction: 'Add a column for Owner', settings, mainModel: 'deepseek-v4-flash', provider: s.provider });
  assert(!r.ok && r.attempts === 2 && /could not make a safe edit/.test(r.error) && r.errors.some(e => /rows/.test(e)), 'broken twice: no edit, the reasons are returned');
  // A reply cut off at the ceiling (thinking ate the budget) is retried with thinking off and more room.
  const effortSeen = [];
  const cut = { calls: [], provider: { id: 'cut', displayName: 'Cut', async *chat(o) {
    cut.calls.push(o);
    effortSeen.push(T.currentRunContext?.()?.effort);
    if (cut.calls.length === 1) { yield { type: 'text', content: '{"header": ["Activ' }; yield { type: 'finish', reason: 'length' }; return; }
    yield { type: 'text', content: good }; yield { type: 'finish', reason: 'stop' };
  } } };
  r = await T.editPart({ part, context: ctx, instruction: 'Add a column for Owner', settings, mainModel: 'deepseek-v4-flash', provider: cut.provider });
  assert(r.ok && r.attempts === 2 && cut.calls[1].maxTokens > cut.calls[0].maxTokens && /cut off/.test(cut.calls[1].messages.at(-1).content),
    'a cut-off answer is retried with a larger budget');
  if (T.currentRunContext) assert(effortSeen[0] === 'low' && effortSeen[1] === 'off', `effort low, then off after a cut-off (${effortSeen.join(' → ')})`);
  s = stub(['Sure! Here you go.']);
  r = await T.editPart({ part, context: ctx, instruction: 'Add a column for Owner', settings, mainModel: 'deepseek-v4-flash', provider: s.provider });
  assert(!r.ok && r.errors[0] === 'the answer was not a JSON object', 'prose instead of JSON is refused');
  // A thread: the follow-up sees the last proposal and is validated under both instructions.
  s = stub([good]);
  r = await T.editPart({ part, context: ctx, instruction: 'use TBC for every owner', history: [{ instruction: 'Add a column for Owner', patch: { kind: 'table', header: [...t.header, 'Owner'], rows: t.rows.map(x => [...x, 'TBC']) } }], settings, mainModel: 'deepseek-v4-flash', provider: s.provider });
  const m = s.calls[0].messages;
  assert(r.ok && m.length === 3 && m[1].role === 'assistant' && /keeping the same part/.test(m[2].content), 'a follow-up keeps the part and refines the proposal (the column is still allowed)');
  s = stub([good]);
  await T.editPart({ part, context: ctx, instruction: 'Add a column for Owner', history: [{ instruction: 'Add a column for Owner', patch: { kind: 'table', header: t.header, rows: t.rows } }], retryError: 'Mermaid could not parse', settings, mainModel: 'deepseek-v4-flash', provider: s.provider });
  assert(/could not be used: Mermaid could not parse/.test(s.calls[0].messages[2].content), 'an editor-side failure goes back to the model once');
  r = await T.editPart({ part, context: ctx, instruction: 'x'.repeat(3000), settings, mainModel: 'deepseek-v4-flash', provider: s.provider });
  assert(!r.ok && /characters/.test(r.error), 'an over-long instruction is refused before any call');
  r = await T.editPart({ part, context: ctx, instruction: 'Fix it', settings: {}, mainModel: '' });
  assert(!r.ok && /no model/.test(r.error), 'no model configured: a reason, not a crash');
});

await block('The edit role (ADR 0017 + 0024)', async () => {
  const ds = { providerInstances: [{ id: 'deepseek', type: 'deepseek', name: 'DeepSeek', apiKey: 'k' }] };
  const r = T.resolveRole('edit', { settings: ds, mainModel: 'deepseek-v4-pro', env: {} });
  assert(r.ok && r.model === 'deepseek-v4-pro' && r.source === 'preset', 'defaults to the work model');
  const eco = T.resolveRole('edit', { settings: { ...ds, models: { preset: 'economy' } }, mainModel: 'deepseek-v4-pro', env: {} });
  assert(eco.model === 'deepseek-v4-flash', 'economy moves it to the cheap model');
  const set = T.resolveRole('edit', { settings: { ...ds, models: { roles: { edit: 'deepseek-v4-flash' } } }, mainModel: 'deepseek-v4-pro', env: {} });
  assert(set.model === 'deepseek-v4-flash' && set.source === 'role', 'models.roles.edit chooses it');
});

await block('The agent: findPart and Canvas edit_part', async () => {
  let f = S.findPart(DOC, { kind: 'table' });
  assert(!f.ok && /2 blocks match/.test(f.error) && /Responsibilities/.test(f.error), 'an ambiguous part lists the candidates instead of guessing');
  f = S.findPart(DOC, { kind: 'table', section: 'service levels' });
  assert(f.ok, 'a section narrows it to one');
  f = S.findPart(DOC, { kind: 'table', section: 'Responsibilities', columns: ['Client'] });
  assert(f.ok && f.target.cells.c0 === 2 && f.target.cells.c1 === 2 && f.target.cells.r1 === 4, 'a column by name becomes a cell range');
  f = S.findPart(DOC, { kind: 'section', section: 'Scope' });
  assert(f.ok && f.target.part === 'section', 'a whole section');
  assert(!S.findPart(DOC, { kind: 'chart', nth: 3 }).ok, 'nth out of range is refused');

  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'aico-inline-'));
  const settings = {};
  const ctx = { settings, cwd: project, sessionId: 'inline-edit-session' };
  const run = (fn) => T.runInContext({ cwd: project, sessionId: ctx.sessionId, settings }, fn);
  const doc = await T.createCanvas(ctx, { title: 'Technical Proposal: Customer Feedback Platform', kind: 'document', content: DOC, author: 'agent' });
  const raci = must(resolve(DOC, { blockIds: [S.findPart(DOC, { kind: 'table', section: 'Responsibilities' }).target.blockIds[0]] }));
  const owner = raci.table.rows.map((r, i) => [...r, ['Priya', 'Tom', 'Contoso IT', 'Contoso QA', 'Steering group'][i]]);
  const md = S.renderPatch(raci, { kind: 'table', header: [...raci.table.header, 'Owner'], rows: owner });
  let msg = '';
  try { await run(() => T.canvasTool({ action: 'edit_part', id: doc.id, version: 1, instruction: 'Fix grammar', part: { kind: 'table', section: 'Responsibilities' }, content: md })); } catch (e) { msg = e.message; }
  assert(/NOT APPLIED/.test(msg) && /3 columns and now has 4/.test(msg), 'an agent replacement the instruction does not allow is refused with the reason');
  const out = await run(() => T.canvasTool({ action: 'edit_part', id: doc.id, version: 1, instruction: 'Add an Owner column', part: { kind: 'table', section: 'Responsibilities' }, content: md }));
  const now = await T.getCanvas(ctx, doc.id);
  assert(/now version 2/.test(out) && now.version === 2 && now.versions[1].note === 'AICO edit: Add an Owner column' && now.versions[1].author === 'agent',
    'a valid one is one version, noted in the history');
  const span = { start: raci.span.start, end: raci.span.start + md.length };
  assert(JSON.stringify(S.outsideHashes(DOC, raci.span)) === JSON.stringify(S.outsideHashes(now.content, span)), 'nothing else in the document changed');
  msg = '';
  try { await run(() => T.canvasTool({ action: 'edit_part', id: doc.id, version: 1, instruction: 'Fix grammar', part: { kind: 'paragraph', quote: 'dose not' }, content: 'x' })); } catch (e) { msg = e.message; }
  assert(/NOT APPLIED/.test(msg) && /version 2, not 1/.test(msg), 'a stale version is refused');
  msg = '';
  try { await run(() => T.canvasTool({ action: 'edit_part', id: doc.id, version: 2, part: { kind: 'chart' } })); } catch (e) { msg = e.message; }
  assert(/instruction/.test(msg), 'an instruction is required');
  assert(T.canvasDefinition.inputSchema.properties.action.enum.includes('edit_part') && /edit_part/.test(T.canvasDefinition.description), 'the action is in the tool definition');

  // The route: validation, and a reason when no model is set up (nothing is ever written).
  const sent = [];
  const deps = { resolveCwd: async () => project, readJson: async (r) => r.body, send: (_res, status, body) => sent.push({ status, body }) };
  const res = { on() {}, writableEnded: false };
  const call = (body) => T.handleCanvasRoute('canvas/edit-part', { method: 'POST', body }, res, new URL('http://x/'), deps);
  await call({ session: ctx.sessionId, id: doc.id, target: { blockIds: [] }, instruction: 'x' });
  assert(sent.at(-1).status === 400 && /blockIds/.test(sent.at(-1).body.error), 'the route refuses a request with no target');
  await call({ session: ctx.sessionId, id: doc.id, target: { blockIds: ['k'] }, instruction: '' });
  assert(sent.at(-1).status === 400, 'and one with no instruction');
  const key = S.findPart(now.content, { kind: 'paragraph', quote: 'dose not' }).target.blockIds[0];
  await call({ session: ctx.sessionId, id: doc.id, target: { blockIds: [key] }, instruction: 'Fix grammar' });
  const last = sent.at(-1);
  assert(last.status === 200 && last.body.ok === false && /no model/.test(last.body.error) && last.body.part?.kind === 'text', 'no model set up: a 200 with the reason and the resolved part');
  assert((await T.getCanvas(ctx, doc.id)).version === 2, 'the route never writes');
});

await block('Diffs for review', async () => {
  const d = D.wordDiff('It dose not include changes, which remains the job.', 'It does not include changes, which remain the job.');
  assert(d.filter(p => p.op === '-').map(p => p.text).join('|') === 'dose|remains' && d.filter(p => p.op === '+').map(p => p.text).join('|') === 'does|remain', 'word-level: only the changed words are marked');
  assert(d.map(p => (p.op === '+' ? '' : p.text)).join('') === 'It dose not include changes, which remains the job.', 'removed + kept text gives back the original');
  const s = D.diffStats(d);
  assert(s.removed === 2 && s.added === 2, 'stats count words');
  const a = { align: ['none', 'none'], header: ['A', 'B'], rows: [['x', '1'], ['y', '2']] };
  const b = { align: ['none', 'none', 'none'], header: ['A', 'B', 'Owner'], rows: [['y', '2', 'Tom'], ['x', '1', 'Ann']] };
  const t = D.tableDiff(a, b);
  assert(t.header.map(h => h.state).join() === 'same,same,added' && t.rows.every(r => r.state === 'moved') && t.rows[0].cells[2].state === 'added', 'tables: an added column, rows moved not rewritten');
  const c = D.tableDiff(a, { ...a, rows: [['x', '1'], ['y', '3']] });
  assert(c.rows[1].state === 'changed' && c.rows[1].cells[1].was === '2', 'a changed cell knows what it was');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) {
  console.log(failures.map(f => `  - ${f}`).join('\n'));
  process.exit(1);
}
process.exit(0);
