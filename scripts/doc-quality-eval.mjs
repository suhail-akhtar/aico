/**
 * Measure what AICO Docs produces for a few document types, with a real model.
 *
 * Why this exists: the repo already shipped one piece of writing guidance (a
 * checklist-style design skill) that tripled the length of design documents
 * for no gain (`docs/engineering/agent-capability-audit.md`). Guidance for
 * documents is the same kind of change, so it is measured here before it is
 * kept: four requests (architecture design, invoice, CV, research summary)
 * run as ordinary chat turns against `aico serve`, the resulting canvas is
 * checked without a model, then graded by a fixed rubric judge.
 *
 * Model-free checks (per document, each pass/fail):
 *   - a canvas document was made, and no pending placeholder is left in it;
 *   - the sections a reader of that type expects are present (headings, by
 *     synonym — written here, independently of the doc-type catalogue, so the
 *     BEFORE run is not graded on names it was never told);
 *   - the visual blocks that carry that type's information are present, and
 *     every fenced block parses (JSON infographics, chart JSON, Mermaid head);
 *   - the length is inside the range a reader would accept;
 *   - no placeholder leakage (lorem ipsum, [Insert …], {{…}}, pending markers);
 *   - the facts given in the request appear (totals, figures);
 *   - DOCX and PDF export succeed with no visual drawn as a placeholder.
 * Judge (`deepseek-v4-pro`, a different model from the writer): five
 * criteria scored 0–2 from a fixed rubric — structure for the type, visuals
 * that carry information, professional formatting, fidelity to the given
 * data, concision — so 0–10 per document.
 *
 * Costs money (one writer turn per document plus one judge call). Not part of
 * `npm test`. Run against the built engine (`npm run build` and the test
 * exports bundle) in an isolated store; the writer is the default model in the
 * copied settings unless `--model` says otherwise.
 *
 *   npm run build && npx tsup src/test-exports.ts --format esm --outDir dist-test --target node22 --silent
 *   node scripts/doc-quality-eval.mjs --label before --budget 0.14
 *   node scripts/doc-quality-eval.mjs --label before --regrade [--no-judge]   # re-check saved docs
 *
 * Results go to `<tmp>/aico-doc-eval/<label>` (not dist-test, which `npm test`
 * cleans). The judge runs with thinking off: on `deepseek-v4-pro` the reasoning
 * otherwise used the whole token budget and left no verdict. Expect the judge
 * to sit near its ceiling and to vary (one identical invoice scored 7 and then
 * 10), so read the model-free checks and word counts first.
 *
 * @module scripts/doc-quality-eval
 */
import './lib/test-home.mjs';
import { spawn, spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback; };
const LABEL = arg('label', 'run');
const BUDGET = Number(arg('budget', '0.14'));
const JUDGE = arg('judge', 'deepseek-v4-pro');
const ONLY = arg('tasks', '');
// Not under dist-test: `npm test` rebuilds that folder with --clean, which once deleted a BEFORE run mid-measurement.
const OUT = path.resolve(arg('out', path.join(os.tmpdir(), 'aico-doc-eval', LABEL)));
fs.mkdirSync(OUT, { recursive: true });

const X = await import(pathToFileURL(path.join(repoRoot, 'dist-test', 'test-exports.js')).href);

const settingsFile = path.join(process.env.AICO_HOME, 'settings.json');
const settings = fs.existsSync(settingsFile) ? JSON.parse(fs.readFileSync(settingsFile, 'utf8')) : {};
if (arg('model', '')) settings.model = arg('model', '');
delete settings.projects;
fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2));
const MODEL = settings.model ?? '(engine default)';

// ── The four requests and what a reader of each expects ─────────────

const H = (...words) => new RegExp(`^#{1,4}\\s*(?:\\d+[.)]?\\s*)?.*\\b(?:${words.join('|')})`, 'im');
const TASKS = [
  {
    id: 'architecture',
    prompt: 'Create an architecture design document for "Shrtn", a URL-shortening service. Facts: a Node.js API behind a load balancer; '
      + 'PostgreSQL stores links; a Redis cache serves hot redirects; every click is published to Kafka and lands in ClickHouse for analytics. '
      + 'Targets: 5,000 redirects per second at peak, p99 redirect latency under 50 ms, 99.95% availability. Team of 4; launch in Q2 2027.',
    sections: [['overview', H('overview', 'introduction', 'context', 'summary', 'background')],
      ['components', H('component', 'architecture', 'system design', 'high-level')],
      ['data', H('data', 'storage', 'schema')],
      ['request flow', H('flow', 'sequence', 'request', 'redirect path')],
      ['decisions', H('decision', 'alternative', 'trade-off', 'tradeoff', 'rationale')],
      ['quality attributes / risks', H('risk', 'scalab', 'availab', 'performance', 'non-functional', 'reliab')]],
    visuals: [['≥2 Mermaid diagrams', b => b.filter(x => x.kind === 'mermaid').length >= 2], ['a table', (_b, md) => hasTable(md)]],
    words: [800, 2500],
    facts: [/5,?000/, /50\s*ms/, /99\.95/],
  },
  {
    id: 'invoice',
    prompt: 'Create invoice INV-2026-0142 from Northwind Design Ltd (14 Harbour Street, Bristol BS1 4QA, VAT no. GB123456789) to '
      + 'Acme Retail plc (Accounts Payable, 2 King Road, Leeds LS1 2AB), dated 3 October 2026, payment due within 30 days by bank transfer. '
      + 'Items: brand identity workshop, 2 days at £1,200 per day; logo design, 1 at £2,500; website mockups, 6 pages at £350 each. VAT at 20%.',
    // An invoice is laid out in tables more than headings: a "To" column or a "Description" header counts.
    sections: [['bill to', /bill(ed)? to|invoice to|\|\s*\**to\**\s*\||\bto\b\**:|client|customer/i],
      ['line items', /\|\s*\**(description|item|service)|^#{1,4}.*\b(items?|services)\b|^`{3,}(lineitems|boq|invoice|quote|pricing)\b/im],
      ['totals', /total/i], ['payment terms', /payment|due/i]],
    visuals: [['a line-item table', (b, md) => hasTable(md) || b.some(x => x.kind === 'lineitems')]],
    words: [60, 450],
    facts: [/INV-2026-0142/, /7,000/, /1,400/, /8,400/],
  },
  {
    id: 'cv',
    prompt: 'Create a CV for Priya Raman, senior data engineer, London, priya.raman@example.com. Experience: Monzo, Senior Data Engineer, '
      + '2022–present — built streaming pipelines (Kafka, Flink) processing 2 billion events a day, cut warehouse cost by 38%. Deliveroo, '
      + 'Data Engineer, 2018–2022 — migrated batch ETL to Airflow and dbt (400 models), led 3 engineers. Accenture, Analyst, 2016–2018. '
      + 'Education: MSc Computer Science, UCL, 2016. Skills: Python, SQL, Scala, Kafka, Flink, Airflow, dbt, Snowflake, AWS, Terraform. '
      + 'Certification: AWS Certified Data Analytics – Specialty (2023).',
    sections: [['profile', H('profile', 'summary', 'about')], ['experience', H('experience', 'employment', 'career')],
      ['education', H('education')], ['skills', H('skill')]],
    visuals: [['a layout or table for skills/contact', (b, md) => b.some(x => ['columns', 'keyvalue'].includes(x.kind)) || hasTable(md)]],
    words: [250, 800],
    facts: [/Monzo/, /38%/, /2 billion|2B|2bn/i, /UCL/],
  },
  {
    id: 'research',
    prompt: 'Create a research summary on whether remote work changes productivity, using only these studies. Bloom et al. 2015, a randomised '
      + 'trial at Ctrip (n=249): working from home raised performance 13% and halved attrition. Bloom, Han & Liang 2024, a randomised trial at '
      + 'Trip.com (n=1,612), published in Nature: hybrid work (2 days at home) had no effect on performance or promotion and cut attrition by a third. '
      + 'Gibbs, Mengel & Siemroth 2023, an Indian IT firm (over 10,000 staff): output was flat while hours rose 18%, so productivity per hour fell '
      + '8–19%. Emanuel & Harrington 2024, a US call centre: remote workers took 4% fewer calls per hour.',
    sections: [['summary / question', H('summary', 'question', 'overview', 'introduction')], ['method', H('method', 'approach', 'studies', 'evidence base')],
      ['findings', H('finding', 'result', 'evidence')], ['implications', H('implication', 'recommendation', 'conclusion', 'what this means')],
      ['limitations', H('limitation', 'caveat')], ['sources', H('source', 'reference', 'bibliograph')]],
    visuals: [['a table, chart or stats block', (b, md) => hasTable(md) || b.some(x => ['chart', 'stats', 'comparison'].includes(x.kind))]],
    words: [500, 1500],
    facts: [/13%/, /1,?612/, /18%/, /4%/],
  },
].filter(t => !ONLY || ONLY.split(',').includes(t.id));

function hasTable(md) { return /^\s*\|.*\|\s*\n\s*\|?\s*:?-{3,}/m.test(md); }

const MERMAID_HEAD = /^(graph|flowchart|sequenceDiagram|classDiagram|erDiagram|stateDiagram(-v2)?|gantt|journey|pie|mindmap|timeline|C4\w+|architecture-beta|block-beta|quadrantChart|xychart-beta|gitGraph)\b/;
const INFO = { stats: 'stats', kpi: 'stats', timeline: 'timeline', steps: 'steps', process: 'steps', comparison: 'comparison', callout: 'callout' };

/** Every fenced block, with whether it parses. */
function blocksOf(md) {
  const out = [];
  for (const m of md.matchAll(/^(`{3,})([^\n`]*)\n([\s\S]*?)^\1\s*$/gm)) {
    const info = m[2].trim();
    const lang = (info.split(/\s+/)[0] ?? '').toLowerCase();
    const body = m[3];
    let kind = lang; let ok = true; let why = '';
    if (['mermaid', 'diagram', 'flowchart', 'sequence', 'gantt'].includes(lang)) {
      kind = 'mermaid';
      const head = body.split('\n').map(l => l.trim()).find(l => l && !l.startsWith('%%')) ?? '';
      ok = lang !== 'mermaid' || MERMAID_HEAD.test(head);
      if (!ok) why = `mermaid starts "${head.slice(0, 30)}"`;
    } else if (lang === 'chart' || lang === 'echarts') {
      kind = 'chart';
      try { JSON.parse(body); } catch (e) { ok = false; why = `chart JSON: ${e.message}`; }
    } else if (INFO[lang]) {
      kind = INFO[lang];
      const r = X.parseInfographic(kind, body, info.split(/\s+/).slice(1).join(' '));
      ok = r.ok; if (!r.ok) why = r.error;
    } else if (lang === 'columns') {
      ok = /^\s*\+\+\+\s*$/m.test(body);
      if (!ok) why = 'columns without a +++ separator';
    } else if (DOC_BLOCKS[lang]) {
      // The round-3 document blocks (contract): JSON bodies.
      kind = DOC_BLOCKS[lang];
      try { const v = JSON.parse(body); if (kind === 'lineitems') v.totals = lineTotals(v); } catch (e) { ok = false; why = `${kind} JSON: ${e.message}`; }
    }
    out.push({ kind, ok, why, body });
  }
  return out;
}

const DOC_BLOCKS = {
  signature: 'signature', keyvalue: 'keyvalue', kv: 'keyvalue', info: 'keyvalue', details: 'keyvalue', lineitems: 'lineitems', boq: 'lineitems',
  invoice: 'lineitems', quote: 'lineitems', pricing: 'lineitems', riskmatrix: 'riskmatrix', risks: 'riskmatrix', actions: 'actions',
  'action-items': 'actions', cover: 'cover', hero: 'cover', meta: 'meta', byline: 'meta', references: 'references', footnotes: 'references',
  bibliography: 'references',
};

/** A `lineitems` block's totals as the contract computes them (subtotal, tax on the discounted subtotal, total). */
// The renderer's lenient number (shared/ui/canvas/doc-blocks `num`): "2 days" is 2, "£1,200" is 1200.
const num = (v) => (typeof v === 'number' ? v : Number(String(v ?? '').replace(/[^0-9.-]/g, '')) || 0);
function lineTotals(v) {
  const items = (Array.isArray(v) ? v : v.items ?? []).filter(i => i && !i.section);
  const subtotal = items.reduce((n, i) => n + (i.qty === undefined ? 1 : num(i.qty)) * num(i.rate ?? i.price), 0);
  const d = v.discount; const discount = typeof d === 'string' && d.endsWith('%') ? subtotal * parseFloat(d) / 100 : num(d);
  const tax = (subtotal - discount) * num(v.taxRate) / 100;
  return { subtotal, tax, total: subtotal - discount + tax };
}

/** The Markdown plus the text a JSON block shows (details, line items, computed totals), so checks read what the reader sees. */
function visibleText(md, blocks) {
  const f = (n) => n.toLocaleString('en-GB', { maximumFractionDigits: 2 });
  return md + blocks.filter(b => b.ok && ['lineitems', 'keyvalue'].includes(b.kind)).map((b) => {
    const v = JSON.parse(b.body);
    if (b.kind === 'keyvalue') {
      const items = Array.isArray(v.items) ? v.items : Object.entries(v).map(([key, value]) => ({ key, value }));
      return `\n${items.map(i => `${i.key}: ${i.value}`).join('\n')}`;
    }
    const t = lineTotals(v);
    const rows = (Array.isArray(v) ? v : v.items ?? []).map(i => i.section ?? `${i.item ?? ''} ${i.description ?? ''}`).join('\n');
    return `\n${rows}\nSubtotal ${f(t.subtotal)} Tax ${f(t.tax)} Total ${f(t.total)}`;
  }).join('');
}

// Fenced blocks are not prose and are not counted — except `columns`, whose body is the document's Markdown.
const words = (md) => md.replace(/^(`{3,})(?!columns)[^\n]*\n[\s\S]*?^\1\s*$/gm, ' ').replace(/^`{3,}(columns[^\n]*)?$/gm, ' ').replace(/<!--[\s\S]*?-->/g, ' ').replace(/[#*_|>`-]/g, ' ').split(/\s+/).filter(w => /\w/.test(w)).length;
const LEAK = /lorem ipsum|\[insert|\[your [a-z]|\{\{|aico:pending|\bXXX\b|\[placeholder\]/i;

// ── Write: all at once against one server, under one money cap ──────
//
// `--regrade` skips this: it re-reads the Markdown a previous run saved in
// --out and keeps that run's export results and spend, so a grader fix can be
// applied to BEFORE without paying to write it again.

const REGRADE = process.argv.includes('--regrade');
const previous = REGRADE ? JSON.parse(fs.readFileSync(path.join(OUT, 'report.json'), 'utf8')) : undefined;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let server; let base; let token;
const api = async (route, body) => fetch(`${base}/api/${route}`, {
  method: body ? 'POST' : 'GET', headers: { 'x-aico-token': token, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
}).then(r => r.json());
const stop = () => {
  if (!server) return;
  try { if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(server.pid), '/T', '/F']); else server.kill(); } catch { /* already gone */ }
};

console.log(`\nDOC QUALITY EVAL [${LABEL}${REGRADE ? ', regrade' : ''}] — ${TASKS.length} document(s), writer ${previous?.model ?? MODEL}, judge ${JUDGE}, budget $${BUDGET}\n`);

const runs = TASKS.map((t, i) => {
  const old = previous?.results.find(x => x.id === t.id);
  return { task: t, sessionId: old?.sessionId ?? `doceval-${LABEL}-${t.id}-${Date.now().toString(36)}${i}`, cost: old?.writerCost ?? 0,
    done: Boolean(old), seconds: old?.seconds, capped: old?.capped, old, started: Date.now() };
});
if (!REGRADE) {
  const workdir = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'aico-doc-eval-'));
  server = spawn(process.execPath, [path.join(repoRoot, 'dist', 'index.js'), 'serve', '--no-open'], { cwd: workdir, env: { ...process.env, FORCE_COLOR: '0' } });
  let serverLog = '';
  server.stderr.on('data', d => { serverLog += d.toString(); });
  const url = await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`serve never printed a URL\n${serverLog.slice(-800)}`)), 90_000);
    server.stdout.on('data', d => { const m = d.toString().match(/http:\/\/127\.0\.0\.1:\d+\/\?token=[A-Za-z0-9_-]+/); if (m) { clearTimeout(t); resolve(m[0]); } });
  });
  token = url.split('token=')[1];
  base = url.split('/?')[0];
  for (const r of runs) await api('submit', { sessionId: r.sessionId, task: r.task.prompt });
  let capped = false;
  for (let tick = 0; tick < 300 && runs.some(r => !r.done); tick++) {
    await sleep(4000);
    for (const r of runs.filter(x => !x.done)) {
      const s = await api(`session?id=${encodeURIComponent(r.sessionId)}`);
      r.cost = s.usage?.costUsd ?? r.cost;
      const answered = (s.messages ?? []).some(m => m.role === 'assistant');
      if (!s.busy && answered) { r.done = true; r.seconds = Math.round((Date.now() - r.started) / 1000); }
    }
    const spent = runs.reduce((n, r) => n + r.cost, 0);
    if (spent > BUDGET && !capped) {
      capped = true;
      console.log(`  ! writer spend $${spent.toFixed(3)} passed the $${BUDGET} cap — cancelling the turns still running`);
      for (const r of runs.filter(x => !x.done)) { await api('cancel', { sessionId: r.sessionId }); r.capped = true; }
    }
  }
}

// ── Grade ───────────────────────────────────────────────────────────

const RUBRIC = [
  'Score the document on five criteria, each 0, 1 or 2 (2 = clearly meets it, 1 = partly, 0 = not).',
  'structure: the sections, order and front matter a professional reader expects of THIS document type (e.g. an invoice has parties, number, dates, line items, totals, terms; a design doc has context, components, flows, decisions, risks).',
  'visuals: diagrams, tables, charts or layout blocks are used where they carry information that suits this type (Markdown tables and fenced blocks — ```mermaid, ```chart, ```stats, ```lineitems, ```columns, ```signature, ```keyvalue, ```riskmatrix etc. — render as designed components, not code); 0 if absent where clearly needed OR if decorative/padded.',
  'formatting: consistent, polished, professional formatting and tone (headings, numbering, emphasis, units and currency formats).',
  'fidelity: uses only the facts in the request; no invented figures, names or citations presented as real; arithmetic correct; missing information marked clearly rather than made up.',
  'concision: appropriate length for the type; no filler, repetition or generic boilerplate; tables/diagrams instead of long prose where they say it better.',
  'Reply with JSON only: {"structure":n,"visuals":n,"formatting":n,"fidelity":n,"concision":n,"note":"<one sentence on the biggest weakness>"}',
].join('\n');

async function judgeDoc(task, md) {
  const loaded = await X.loadSettings();
  const provider = X.selectProvider(JUDGE, loaded);
  const tracker = X.createTokenTracker();
  let text = '';
  // Room for the judge's reasoning: on a thinking model the reasoning tokens come out of maxTokens,
  // and 400 left nothing for the verdict (every verdict of the first BEFORE run was empty).
  // Thinking off: even at low effort a 16k-character document spent all 3,000 tokens reasoning and gave no verdict.
  await X.runInContext({ cwd: process.cwd(), effort: 'off' }, async () => {
    for await (const ev of provider.chat({
      model: JUDGE, systemPrompt: 'You are a strict, literal grader of professional documents. Judge only what is written.',
      messages: [{ role: 'user', content: `${RUBRIC}\n\nThe request:\n${task.prompt}\n\nThe document (${words(md)} words; Markdown; fenced blocks render as visuals; cut at 16,000 characters):\n${md.slice(0, 16_000)}` }],
      tools: [], maxTokens: 3000,
    })) {
      if (ev.type === 'text') text += ev.content;
      else if (ev.type === 'usage') tracker.add(ev.inputTokens, ev.outputTokens, ev.cacheReadTokens ?? 0, ev.cacheWriteTokens ?? 0);
    }
  });
  const cost = tracker.estimateCost(JUDGE, loaded);
  try {
    const j = JSON.parse(/\{[\s\S]*\}/.exec(text.replace(/```(?:json)?/g, ''))[0]);
    const keys = ['structure', 'visuals', 'formatting', 'fidelity', 'concision'];
    const parts = Object.fromEntries(keys.map(k => [k, Math.max(0, Math.min(2, Number(j[k]) || 0))]));
    return { score: keys.reduce((n, k) => n + parts[k], 0), parts, note: String(j.note ?? '').slice(0, 200), cost };
  } catch {
    return { score: 0, parts: {}, note: `judge reply unreadable: ${JSON.stringify(text.slice(0, 120))}`, cost };
  }
}

async function exportOk(sessionId, id, format) {
  const res = await fetch(`${base}/api/canvas/${id}/export?session=${encodeURIComponent(sessionId)}&format=${format}`, { headers: { 'x-aico-token': token } });
  const bytes = Buffer.from(await res.arrayBuffer());
  const magic = format === 'pdf' ? bytes.subarray(0, 4).toString() === '%PDF' : bytes.subarray(0, 2).toString() === 'PK';
  fs.writeFileSync(path.join(OUT, `${id}.${format}`), bytes);
  return { ok: res.ok && magic && bytes.length > 1000, warnings: Number(res.headers.get('x-aico-export-warnings') ?? 0), bytes: bytes.length };
}

const EXPORT_CHECKS = ['DOCX export', 'PDF export', 'no visual exported as a placeholder'];
const results = [];
let judgeCost = 0;
for (const r of runs) {
  const t = r.task;
  const checks = [];
  const check = (name, pass, detail = '') => checks.push({ name, pass: Boolean(pass), detail });
  let md = '';
  let doc;
  if (REGRADE) {
    md = fs.existsSync(path.join(OUT, `${t.id}.md`)) ? fs.readFileSync(path.join(OUT, `${t.id}.md`), 'utf8') : '';
    doc = md ? { docSettings: r.old?.docSettings ?? null } : undefined;
  } else {
    const list = (await api(`canvas/list?session=${encodeURIComponent(r.sessionId)}`)).canvases ?? [];
    const summary = list.find(c => c.kind === 'document') ?? list[0];
    if (summary) {
      doc = (await api(`canvas/get?session=${encodeURIComponent(r.sessionId)}&id=${summary.id}`)).canvas;
      md = (doc?.tabs ?? [{ content: doc?.content ?? '' }]).map(x => x.content).join('\n\n');
    }
    fs.writeFileSync(path.join(OUT, `${t.id}.md`), md);
  }
  check('a canvas document was made', Boolean(doc));
  check('no pending section left', md && !/aico:pending/.test(md));
  const blocks = blocksOf(md);
  // Read what the reader sees: a computed block's totals count as present.
  const seen = visibleText(md, blocks);
  for (const [name, re] of t.sections) check(`section: ${name}`, re.test(seen));
  for (const [name, fn] of t.visuals) check(`visual: ${name}`, fn(blocks, md));
  const bad = blocks.filter(b => !b.ok);
  check('every fenced block parses', md && bad.length === 0, bad.map(b => b.why).join('; '));
  const n = words(seen);
  check(`length ${t.words[0]}–${t.words[1]} words`, n >= t.words[0] && n <= t.words[1], `${n} words`);
  check('no placeholder leakage', md && !LEAK.test(md), (LEAK.exec(md) ?? [''])[0]);
  const missing = t.facts.filter(re => !re.test(seen));
  check('the given facts appear', md && missing.length === 0, missing.map(String).join(' '));
  if (REGRADE) {
    for (const name of EXPORT_CHECKS) { const c = r.old?.checks.find(x => x.name === name); check(name, c?.pass, c?.detail ?? ''); }
  } else if (doc) {
    const docx = await exportOk(r.sessionId, doc.id, 'docx');
    const pdf = await exportOk(r.sessionId, doc.id, 'pdf');
    check('DOCX export', docx.ok, `${docx.bytes} bytes`);
    check('PDF export', pdf.ok, `${pdf.bytes} bytes`);
    check('no visual exported as a placeholder', docx.warnings === 0 && pdf.warnings === 0, `${docx.warnings + pdf.warnings} warnings`);
  } else {
    for (const name of EXPORT_CHECKS) check(name, false);
  }
  // --no-judge (with --regrade) keeps the run's own verdict, so a grader fix does not re-roll the judge.
  const verdict = REGRADE && process.argv.includes('--no-judge') && r.old ? { ...r.old.judge, cost: 0 }
    : md ? await judgeDoc(t, md) : { score: 0, parts: {}, note: 'no document', cost: 0 };
  judgeCost += verdict.cost;
  const passed = checks.filter(c => c.pass).length;
  results.push({
    id: t.id, sessionId: r.sessionId, capped: Boolean(r.capped), seconds: r.seconds, writerCost: r.cost, words: n,
    blocks: blocks.map(b => b.kind), docSettings: doc?.docSettings ?? null, checks, modelFree: passed / checks.length, judge: verdict,
  });
  console.log(`  ${t.id.padEnd(13)} model-free ${passed}/${checks.length}  judge ${verdict.score}/10  ${n} words  blocks [${blocks.map(b => b.kind).join(',')}]  $${r.cost.toFixed(4)}${r.capped ? '  (capped)' : ''}`);
  for (const c of checks.filter(c => !c.pass)) console.log(`        ✗ ${c.name}${c.detail ? ` — ${c.detail}` : ''}`);
  console.log(`        judge: ${JSON.stringify(verdict.parts)} — ${verdict.note}`);
}

// A partial regrade keeps the other documents' results.
if (REGRADE && ONLY) for (const old of previous.results) if (!results.some(x => x.id === old.id)) results.push(old);
const writerCost = results.reduce((n, r) => n + (r.writerCost ?? 0), 0);
const mean = (f) => results.reduce((n, x) => n + f(x), 0) / Math.max(1, results.length);
const report = {
  label: LABEL, model: previous?.model ?? MODEL, judge: JUDGE, writerCost, judgeCost, totalCost: writerCost + judgeCost,
  meanModelFree: mean(x => x.modelFree), meanJudge: mean(x => x.judge.score), meanWords: mean(x => x.words), results,
};
fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));
console.log(`\n[${LABEL}] mean model-free ${(report.meanModelFree * 100).toFixed(0)}% · mean judge ${report.meanJudge.toFixed(1)}/10 · mean ${Math.round(report.meanWords)} words`
  + ` · writer $${writerCost.toFixed(4)} + judge $${judgeCost.toFixed(4)}${REGRADE ? ' (judge cost is this regrade)' : ''}\n  report ${path.join(OUT, 'report.json')}\n`);
stop();
process.exit(0);

