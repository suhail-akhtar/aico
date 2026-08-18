/**
 * One brief, three models, everything measured.
 *
 * The brief is a real single-file build with named, checkable features — not a
 * toy — so the numbers describe the harness under the kind of load it is
 * actually for. Each model gets its own empty directory and its own session, so
 * nothing one produces can help or hinder another.
 *
 * What is measured, and why each one:
 *
 *   **Tokens and cost.** The bill. Split into input, output and cache reads,
 *   because a harness that keeps its prefix stable pays a very different input
 *   price on turn six than one that does not.
 *   **Wall time and time to first token.** How long you wait, and how much of
 *   that is the model rather than the loop.
 *   **Steps and tool calls.** How the loop actually behaved — a model that
 *   takes twenty steps to write one file is telling you something.
 *   **What it produced.** Checked by reading the file, not by asking the model
 *   whether it succeeded.
 *
 * Costs real money. Not part of any suite.
 *
 *   node bench-build.mjs                    # all three
 *   node bench-build.mjs claude-sonnet-5    # one
 */
import 'dotenv/config';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  runAgent, Session, createTokenTracker, checkSessionInvariants,
  verifyApp, verifications,
} from './dist-test/test-exports.js';

const BRIEF = `Build a single-page app in one self-contained index.html file.

Design a 3D commercial space planner — for cafes, small offices, and boutique retail.

Visual Strategy:
Imagery: cafe counters, office desk clusters, retail fixtures.
Photography: documentary-style shop interiors.
Composition: floor-plan + 3D perspective side-by-side.

Color Palette:
Primary Colors: warm white, oat, charcoal.
Accent Colors: signature brand color (user-pickable).
Background: subtle blueprint grid.

Typography:
Headings: contemporary geometric sans.
Body Text: clean utility sans.
Layout: workspace with toolbars.

Page Structure:
Hero Section: a coffee shop space the user can lay out.
Templates: cafe / co-working / boutique / restaurant.
Capacity Planner: seats per square meter / fire egress.
Brand Color: apply across the room instantly.
Cost Estimator: rough furniture and fixture totals.

Interaction Details:
- Switch between top-down floor plan and 3D view with a smooth camera swing.
- Brand color picker recolors all branded elements live.
- Capacity meter ticks up/down as you place chairs.
- Egress paths animate as flowing arrows when "Show fire safety" is toggled.
- Cost estimator slides out a side panel that updates as you place items.
- Export to PDF triggers a building-up animation of the layout sheet.

Overall Vibe: practical, customizable, business-savvy, polished.

Everything must work offline from the single file — no CDN links, no external
requests. Write it to index.html in the current directory.`;

const CONTENDERS = [
  { label: 'Claude Sonnet 5', model: 'claude-sonnet-5', provider: 'anthropic' },
  { label: 'DeepSeek V4 Flash', model: 'deepseek-v4-flash', provider: 'deepseek' },
  { label: 'GPT-5.6 Luna', model: 'gpt-5.6-luna', provider: 'openai' },
];

/** Named requirements, each checked against the file rather than the model. */
const FEATURES = [
  ['single self-contained file', h => h.length > 0],
  ['no external requests', h => !/https?:\/\/(?!www\.w3\.org)/i.test(h)],
  ['3D view', h => /(perspective|rotateX|matrix3d|three|webgl|translateZ)/i.test(h)],
  ['floor plan / 3D toggle', h => /(floor ?plan|top.?down)/i.test(h) && /(3d|perspective)/i.test(h)],
  ['blueprint grid', h => /(grid|blueprint)/i.test(h)],
  ['brand colour picker', h => /type=["']color["']|colou?r.?picker/i.test(h)],
  ['templates', h => /(cafe|caf\u00e9)/i.test(h) && /(co.?working|boutique|restaurant)/i.test(h)],
  ['capacity planner', h => /capacit/i.test(h)],
  ['fire egress', h => /(egress|fire)/i.test(h)],
  ['cost estimator', h => /cost/i.test(h)],
  ['export to PDF', h => /pdf/i.test(h)],
  ['placeable items', h => /(addEventListener|onclick|onpointerdown)/i.test(h)],
];

const only = process.argv[2];
const stored = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.aico', 'settings.json'), 'utf8'));
const outRoot = 'E:/tmp/aico-bench-build';
fs.mkdirSync(outRoot, { recursive: true });

const rows = [];

for (const c of CONTENDERS) {
  if (only && c.model !== only) continue;

  const dir = path.join(outRoot, c.model.replace(/[^a-z0-9.-]/gi, '_'));
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });

  const session = new Session({
    id: `build-${c.model}-${Date.now().toString(36)}`, cwd: dir, startedAt: Date.now(),
  });
  const tracker = createTokenTracker();
  const tools = [];
  let firstChunkAt = 0;

  const settings = {
    ...stored,
    activeProvider: c.provider, provider: c.provider, model: c.model,
    autoApprove: true,
    autoCompact: { enabled: true },
    maxIterations: 40,
    agentTimeout: 20 * 60 * 1000,
    workspace: { path: path.join(dir, '.workspace') },
  };

  console.log(`\n${'═'.repeat(66)}\n  ${c.label}  (${c.model})\n${'═'.repeat(66)}`);
  const started = Date.now();
  let reply = '', failure = '';
  try {
    reply = await runAgent({
      task: BRIEF,
      model: c.model, cwd: dir, session, sessionId: session.header.id,
      tokenTracker: tracker, settings,
      autoApprove: true, verbose: false, silent: true, showPlan: false,
      conversationHistory: [],
      onChunk: () => { if (!firstChunkAt) firstChunkAt = Date.now(); },
      onToolCall: (name) => {
        tools.push(name);
        process.stdout.write(`    ${String(tools.length).padStart(2)}. ${name}\n`);
      },
    });
  } catch (err) {
    failure = err instanceof Error ? err.message : String(err);
    console.log(`    THREW: ${failure.slice(0, 120)}`);
  }

  const wall = Date.now() - started;
  const usage = tracker.getUsage();
  const steps = session.events.filter(e => e.type === 'step/start').length;
  const turnEnd = [...session.events].reverse().find(e => e.type === 'turn/end');

  const file = path.join(dir, 'index.html');
  const html = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const passed = FEATURES.filter(([, test]) => { try { return test(html); } catch { return false; } });

  // The keyword scores above are what made the first run of this benchmark
  // worthless: they awarded 12/12 to a page that threw on load. They are kept
  // only so the two numbers can be compared — the verdict below is the answer.
  let verdict = null;
  if (html) {
    try {
      verdict = await verifyApp({
        target: file,
        settleMs: 3000,
        checks: [
          { name: 'floor plan / 3D toggle', selector: 'button, [role=button]' },
          { name: 'brand colour picker', selector: 'input[type=color]' },
        ],
      });
    } catch (err) {
      verdict = { passed: false, problems: [`could not verify: ${err.message}`], rendered: {} };
    }
  }

  rows.push({
    label: c.label, model: c.model, wall,
    ttft: firstChunkAt ? firstChunkAt - started : null,
    input: usage.inputTokens, output: usage.outputTokens,
    cached: usage.cachedTokens, cacheWrite: usage.cacheWriteTokens,
    requests: usage.sessions,
    cost: tracker.estimateCost(c.model),
    steps, tools: tools.length,
    bytes: html.length,
    features: passed.length,
    missing: FEATURES.filter(f => !passed.includes(f)).map(([n]) => n),
    reason: turnEnd?.data?.reason?.kind ?? (failure ? 'threw' : 'unknown'),
    works: verdict ? verdict.passed : false,
    problems: verdict ? verdict.problems : ['no file produced'],
    verifiedItself: session.events.filter(e =>
      e.type === 'tool/call' && e.data?.name === 'VerifyApp').length,
    invariants: checkSessionInvariants(session).ok,
    failure,
    dir,
  });

  const r = rows[rows.length - 1];
  console.log(`\n    ${(r.wall / 1000).toFixed(1)}s · ${r.steps} steps · ${r.tools} tools · ended: ${r.reason}`);
  console.log(`    in ${r.input.toLocaleString()} (cached ${r.cached.toLocaleString()}) · out ${r.output.toLocaleString()} · $${r.cost.toFixed(4)}`);
  console.log(`    index.html: ${r.bytes.toLocaleString()} bytes · ${r.features}/${FEATURES.length} keyword features`);
  console.log(`    IN A BROWSER: ${r.works ? 'WORKS' : 'BROKEN'} · verified itself ${r.verifiedItself}x`);
  for (const p of r.problems.slice(0, 4)) console.log(`      - ${p}`);
}

console.log(`\n${'═'.repeat(66)}\n  RESULTS\n${'═'.repeat(66)}\n`);
const pad = (s, n) => String(s).padEnd(n);
const num = (s, n) => String(s).padStart(n);
console.log(`  ${pad('model', 20)} ${num('secs', 6)} ${num('steps', 6)} ${num('in', 9)} ${num('cached', 8)} ${num('out', 7)} ${num('cost', 9)} ${num('bytes', 8)} ${num('feat', 6)} ${num('works', 7)}`);
console.log(`  ${'-'.repeat(20)} ${'-'.repeat(6)} ${'-'.repeat(6)} ${'-'.repeat(9)} ${'-'.repeat(8)} ${'-'.repeat(7)} ${'-'.repeat(9)} ${'-'.repeat(8)} ${'-'.repeat(6)} ${'-'.repeat(7)}`);
for (const r of rows) {
  console.log(
    `  ${pad(r.label, 20)} ${num((r.wall / 1000).toFixed(0), 6)} ${num(r.steps, 6)}`
    + ` ${num(r.input.toLocaleString(), 9)} ${num(r.cached.toLocaleString(), 8)} ${num(r.output.toLocaleString(), 7)}`
    + ` ${num('$' + r.cost.toFixed(4), 9)} ${num(r.bytes.toLocaleString(), 8)} ${num(`${r.features}/${FEATURES.length}`, 6)}`
    + ` ${num(r.works ? 'yes' : 'NO', 7)}`,
  );
}
console.log('');
for (const r of rows) {
  console.log(`  ${r.label}: ended ${r.reason}, invariants ${r.invariants ? 'clean' : 'VIOLATED'}, ${r.dir}`);
  console.log(`     browser: ${r.works ? 'works' : 'BROKEN'}${r.problems.length ? ` — ${r.problems[0]}` : ''}`);
}
fs.writeFileSync(path.join(outRoot, 'results.json'), JSON.stringify(rows, null, 2));
console.log(`\n  raw: ${path.join(outRoot, 'results.json')}\n`);
process.exit(0);
