/**
 * Performance, token and cache benchmarks against real providers.
 *
 * Costs money and is not part of `npm test`. What it measures is the set of
 * claims the architecture actually makes, each of which is either true on the
 * wire or is not true at all:
 *
 *   1. **Cache.** The system prompt is held stable and everything volatile is
 *      pushed into the tail specifically so the prefix survives between turns.
 *      That is either visible as cache reads in provider usage or it is a story.
 *   2. **Weight.** What the prefix and the per-turn tail actually cost.
 *   3. **Latency.** Time to first token, and how much of a turn is model versus
 *      tools.
 *   4. **Batching.** A prompt bullet now tells the model independent lookups may
 *      go out together. Either tool calls per step went above one or it did not.
 *   5. **Autonomy.** Whether a multi-step task completes without steering, and
 *      whether the agent verified what it claimed.
 *
 *   node bench.mjs                 # all, on the cheap model
 *   node bench.mjs cache           # one bench
 *   node bench.mjs all anthropic   # pick the provider
 */
import 'dotenv/config';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  runAgent, Session,
  createTokenTracker, buildSystemPrompt, buildVolatileContext,
  renderPrompt, renderTail, PromptDocument,
  ANTHROPIC_DIALECT, OPENAI_DIALECT, DEEPSEEK_DIALECT, GEMINI_DIALECT, DEFAULT_DIALECT,
} from './dist-test/test-exports.js';

const WHICH = process.argv[2] ?? 'all';
const TARGET = process.argv[3] ?? 'deepseek';

const MODELS = {
  deepseek: 'deepseek-v4-flash',
  anthropic: 'claude-sonnet-5',
};
const MODEL = MODELS[TARGET] ?? TARGET;
const PROVIDER_FOR = { deepseek: 'deepseek', anthropic: 'anthropic', openai: 'openai' };

const results = [];
const record = (bench, metric, value, note = '') => {
  results.push({ bench, metric, value, note });
  const v = typeof value === 'number' ? value.toLocaleString() : String(value);
  console.log(`    ${metric.padEnd(34)} ${String(v).padStart(12)}  ${note}`);
};

/**
 * A scratch directory. No chdir — `runAgent` takes its own `cwd` now.
 *
 * It did not always. An earlier run of this bench spent 150 seconds and seven
 * steps searching the repo it was launched from for four files sitting in a
 * temp directory, and concluded — correctly, and uselessly — that they did not
 * exist.
 */
function scratch(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `aico-bench-${name}-`));
}

function leave(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

/** One turn, fully instrumented. Returns everything worth measuring. */
async function turn(session, task, cwd, tracker, opts = {}) {
  const startedAt = Date.now();
  let firstChunkAt = 0;
  const toolCalls = [];

  const before = tracker.getUsage();
  // There is no per-step callback, and there does not need to be: the session
  // log already records `step/start` and every `tool/call` in order, which is a
  // more trustworthy account of what happened than anything reconstructed from
  // callback timing.
  const seenEvents = session.events.length;

  await runAgent({
    task,
    model: MODEL,
    cwd,
    session,
    sessionId: session.header.id,
    tokenTracker: tracker,
    settings: { ...SETTINGS, maxIterations: opts.maxIterations ?? 12 },
    autoApprove: true,
    verbose: false,
    silent: true,
    showPlan: false,
    conversationHistory: [],
    onChunk: () => { if (!firstChunkAt) firstChunkAt = Date.now(); },
    onToolCall: (name) => { toolCalls.push(name); },
  });

  // Group tool calls by the step that dispatched them. A step holding more than
  // one call is the only direct evidence that batching happened.
  const steps = [];
  for (const event of session.events.slice(seenEvents)) {
    if (event.type === 'step/start') steps.push([]);
    if (event.type === 'tool/call') {
      if (steps.length === 0) steps.push([]);
      steps[steps.length - 1].push(String(event.data?.name ?? 'tool'));
    }
  }

  const after = tracker.getUsage();
  return {
    wallMs: Date.now() - startedAt,
    ttftMs: firstChunkAt ? firstChunkAt - startedAt : null,
    input: after.inputTokens - before.inputTokens,
    output: after.outputTokens - before.outputTokens,
    cached: after.cachedTokens - before.cachedTokens,
    cacheWrite: after.cacheWriteTokens - before.cacheWriteTokens,
    requests: after.sessions - before.sessions,
    toolCalls,
    steps,
  };
}

let sessionCounter = 0;
function newSession(dir) {
  return new Session({
    id: `bench-${Date.now()}-${++sessionCounter}`,
    cwd: dir,
    startedAt: Date.now(),
  });
}

/**
 * The user's real settings, with the two knobs this run needs pinned.
 *
 * Read from disk rather than composed here. Passing a bare object replaces the
 * whole settings document, which drops `providerInstances` — so the run falls
 * back to whatever key is in the environment, and if that one is stale you get
 * a 401 from a provider you have working credentials for.
 *
 * Compaction is off because it rewrites the prefix mid-run, which is precisely
 * the thing the cache benchmark is trying to observe.
 */
function realSettings() {
  const file = path.join(os.homedir(), '.aico', 'settings.json');
  let stored = {};
  try { stored = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* defaults */ }
  return {
    ...stored,
    // Pinned, because passing an explicit model is not on its own enough to
    // route to that model's vendor: selection reads `activeProvider` first, so
    // a DeepSeek model id against an Anthropic active provider is a 404 rather
    // than a redirect. Worth knowing when reading these numbers — the bench is
    // not exercising the default routing path, it is overriding it.
    ...(PROVIDER_FOR[TARGET] ? { activeProvider: PROVIDER_FOR[TARGET], provider: PROVIDER_FOR[TARGET] } : {}),
    model: MODEL,
    autoApprove: true,
    autoCompact: { enabled: false },
    promptCaching: { enabled: true },
  };
}
const SETTINGS = realSettings();

/* ── 1. Static weight ─────────────────────────────────────────────── */

async function benchWeight() {
  console.log('\n── 1. PROMPT WEIGHT (no API calls) ──\n');
  const doc = await buildSystemPrompt(MODEL);
  const volatile = new PromptDocument().add({ id: 'working_tree', body: await buildVolatileContext() });

  for (const [name, dialect, id] of [
    ['anthropic', ANTHROPIC_DIALECT, 'anthropic'],
    ['openai', OPENAI_DIALECT, 'openai'],
    ['deepseek', DEEPSEEK_DIALECT, 'deepseek'],
    ['gemini', GEMINI_DIALECT, 'gemini'],
  ]) {
    const r = renderPrompt(doc, dialect, id);
    const tail = renderTail(volatile, r.reprise, dialect, id);
    record('weight', `${name} system (est. tokens)`, Math.round(r.system.length / 4), `${r.system.length} chars`);
    record('weight', `${name} per-turn tail`, Math.round(tail.length / 4), `${tail.length} chars`);
  }
}

/* ── 2. Cache behaviour ───────────────────────────────────────────── */

async function benchCache() {
  console.log(`\n── 2. CACHE (${MODEL}) ──\n`);
  const dir = scratch('cache');
  const session = newSession(dir);
  const tracker = createTokenTracker();

  // Same session, three sequential turns. Each is trivial so the model spends
  // nothing; what is being measured is the prefix, not the answer.
  const asks = ['Reply with exactly: one', 'Reply with exactly: two', 'Reply with exactly: three'];
  const turns = [];
  for (const ask of asks) {
    const t = await turn(session, ask, dir, tracker, { maxIterations: 2 });
    turns.push(t);
    const pct = t.input ? Math.round((t.cached / t.input) * 100) : 0;
    record('cache', `turn ${turns.length}: input`, t.input, `cached ${t.cached} (${pct}%), write ${t.cacheWrite}`);
  }

  const later = turns.slice(1);
  const hit = later.reduce((n, t) => n + t.cached, 0);
  const total = later.reduce((n, t) => n + t.input, 0);
  record('cache', 'hit rate after first turn', total ? `${Math.round((hit / total) * 100)}%` : 'n/a',
    `${hit} of ${total} prompt tokens`);
  record('cache', 'prompt growth turn 1 → 3',
    turns[0].input ? `${Math.round(((turns[2].input - turns[0].input) / turns[0].input) * 100)}%` : 'n/a',
    `${turns[0].input} → ${turns[2].input}`);

  leave(dir);
}

/* ── 3. Latency ───────────────────────────────────────────────────── */

async function benchLatency() {
  console.log(`\n── 3. LATENCY (${MODEL}) ──\n`);
  const dir = scratch('latency');
  const tracker = createTokenTracker();
  const samples = [];

  for (let i = 0; i < 3; i++) {
    const session = newSession(dir);
    const t = await turn(session, 'Reply with exactly: ok', dir, tracker, { maxIterations: 2 });
    samples.push(t);
  }

  const ttfts = samples.map(s => s.ttftMs).filter(n => n !== null);
  const walls = samples.map(s => s.wallMs);
  const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

  record('latency', 'median time to first token', median(ttfts) ?? 'n/a', 'ms, cold session');
  record('latency', 'median turn wall time', median(walls), 'ms');
  record('latency', 'model share of wall time',
    `${Math.round((median(ttfts) / median(walls)) * 100)}%`, 'rest is streaming + tools');

  leave(dir);
}

/* ── 4. Batching ──────────────────────────────────────────────────── */

async function benchBatching() {
  console.log(`\n── 4. PARALLEL LOOKUPS (${MODEL}) ──\n`);
  const dir = scratch('batch');
  for (const [name, body] of [
    ['alpha.txt', 'alpha = 11'], ['beta.txt', 'beta = 22'],
    ['gamma.txt', 'gamma = 33'], ['delta.txt', 'delta = 44'],
  ]) fs.writeFileSync(path.join(dir, name), body);

  const session = newSession(dir);
  const tracker = createTokenTracker();
  const t = await turn(session,
    'Read alpha.txt, beta.txt, gamma.txt and delta.txt and tell me the sum of the four numbers.',
    dir, tracker, { maxIterations: 10 });

  const reads = t.steps.map(s => s.filter(n => /read/i.test(n)).length);
  const widest = Math.max(0, ...reads);
  record('batching', 'read tools dispatched', t.toolCalls.filter(n => /read/i.test(n)).length);
  record('batching', 'model steps used', t.steps.length);
  record('batching', 'widest single step', widest, widest > 1 ? 'batched' : 'serial — one read per step');
  record('batching', 'wall time', t.wallMs, 'ms');

  leave(dir);
}

/* ── 5. Autonomy ──────────────────────────────────────────────────── */

async function benchAutonomy() {
  console.log(`\n── 5. AUTONOMOUS EXECUTION (${MODEL}) ──\n`);
  const dir = scratch('autonomy');
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
    name: 'bench-fixture', version: '1.0.0', type: 'module',
    scripts: { test: 'node test.mjs' },
  }, null, 2));
  // A real defect: slice(1) drops the first element, so the sum is always short.
  fs.writeFileSync(path.join(dir, 'sum.mjs'),
    'export function sum(xs) {\n  let total = 0;\n  for (const x of xs.slice(1)) total += x;\n  return total;\n}\n');
  fs.writeFileSync(path.join(dir, 'test.mjs'),
    "import assert from 'node:assert/strict';\nimport { sum } from './sum.mjs';\n"
    + "assert.equal(sum([1, 2, 3]), 6);\nassert.equal(sum([10]), 10);\nconsole.log('all tests passed');\n");

  const session = newSession(dir);
  const tracker = createTokenTracker();
  const t = await turn(session,
    '`npm test` is failing in this project. Find out why, fix it, and make the tests pass.',
    dir, tracker, { maxIterations: 20 });

  // Did it actually work? Decided by running the tests ourselves, not by
  // reading what the agent said about them.
  let passes = false;
  try {
    const { execSync } = await import('child_process');
    execSync('node test.mjs', { cwd: dir, stdio: 'pipe' });
    passes = true;
  } catch { /* still failing */ }

  const fixed = fs.readFileSync(path.join(dir, 'sum.mjs'), 'utf8');
  const ranTests = t.toolCalls.some(n => /bash|terminal/i.test(n));
  const testUntouched = fs.readFileSync(path.join(dir, 'test.mjs'), 'utf8').includes('sum([1, 2, 3]), 6');

  record('autonomy', 'tests actually pass afterwards', passes ? 'YES' : 'NO', 'verified independently');
  record('autonomy', 'fixed the cause, not the test', testUntouched ? 'YES' : 'NO',
    testUntouched ? 'test file untouched' : 'WEAKENED THE TEST');
  record('autonomy', 'ran a command to verify', ranTests ? 'YES' : 'NO');
  record('autonomy', 'steps taken', t.steps.length);
  record('autonomy', 'tool calls', t.toolCalls.length, t.toolCalls.join(', ').slice(0, 60));
  record('autonomy', 'wall time', t.wallMs, 'ms');
  record('autonomy', 'tokens in / out', `${t.input} / ${t.output}`,
    `cached ${t.cached} (${t.input ? Math.round((t.cached / t.input) * 100) : 0}%)`);
  record('autonomy', 'still buggy?', /slice\(1\)/.test(fixed) ? 'YES — slice(1) remains' : 'no');

  leave(dir);
}

/* ── Run ──────────────────────────────────────────────────────────── */

const BENCHES = {
  weight: benchWeight,
  cache: benchCache,
  latency: benchLatency,
  batching: benchBatching,
  autonomy: benchAutonomy,
};

const chosen = WHICH === 'all' ? Object.keys(BENCHES) : [WHICH];
console.log(`\nAICO benchmark — model ${MODEL}\n${'='.repeat(64)}`);

for (const name of chosen) {
  const fn = BENCHES[name];
  if (!fn) { console.log(`unknown bench: ${name}`); continue; }
  try {
    await fn();
  } catch (err) {
    console.log(`\n  ${name} FAILED: ${err.message}\n`);
  }
}

console.log(`\n${'='.repeat(64)}`);
// The memory loader holds an fs watcher open, so this would not exit on its own.
process.exit(0);
