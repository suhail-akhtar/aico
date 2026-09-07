/**
 * How many bytes does a quiet step cost? Measured, not estimated.
 *
 * Drives the real agent loop with a scripted provider that answers instantly
 * and records exactly what it was sent: the system prompt (the cached prefix),
 * the volatile tail (paid on every step), and the tool set. Three turns in one
 * session, against this repository's own working tree, skills and memories:
 *
 *   1. a two-step turn (one tool call, then an answer)
 *   2. a QA-shaped message — a URL and the word "test" — which used to swap the
 *      tool set out from under the cache
 *   3. a one-step "quiet" turn
 *
 * The report is per request: prefix chars, tail chars by section, tool count,
 * and whether the prefix and the tool set stayed byte-stable across the
 * session. `--out` saves it; `--compare before.json after.json` prints the
 * deltas and checks the acceptance line for the economy work: the quiet step's
 * uncached tail down by at least 60%, and no tool-set change in a session that
 * contains a QA-shaped message.
 *
 * Offline and free: no provider is called. What it cannot measure is a real
 * provider's cache hit rate; what it can measure is the thing that determines
 * it — how many bytes changed between requests.
 *
 *   npx tsup src/test-exports.ts --format esm --outDir dist-test --target node22 --silent
 *   node scripts/economy-probe.mjs --out before.json
 *   … make changes, rebuild …
 *   node scripts/economy-probe.mjs --out after.json
 *   node scripts/economy-probe.mjs --compare before.json after.json
 */

// A store of this process's own — nothing below may touch ~/.aico. Must stay first.
import './lib/test-home.mjs';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };

if (args[0] === '--compare') {
  compare(JSON.parse(fs.readFileSync(args[1], 'utf8')), JSON.parse(fs.readFileSync(args[2], 'utf8')));
  process.exit(0);
}

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const { runAgent, Session } = await import(new URL('../dist-test/test-exports.js', import.meta.url).href);

/** Split a rendered tail into its top-level sections (XML or Markdown dialect). */
function tailSections(tail) {
  const out = {};
  if (!tail) return out;
  const inner = tail.replace(/^<system_reminder>\n/, '').replace(/\n<\/system_reminder>$/, '');
  const xml = [...inner.matchAll(/^<([a-z_]+)>\n([\s\S]*?)\n<\/\1>$/gm)];
  if (xml.length) {
    for (const m of xml) if (m[1] !== 'system_reminder') out[m[1]] = m[0].length;
    return out;
  }
  const parts = tail.split(/^## /m).slice(1);
  for (const p of parts) out[p.split('\n')[0].trim().toLowerCase().replace(/\s+/g, '_')] = p.length + 3;
  return out;
}

function scripted(steps, log) {
  let i = 0;
  return {
    id: 'mock',
    displayName: 'Mock',
    async *chat(opts) {
      log.push({
        prefixChars: opts.systemPrompt.length,
        tailChars: (opts.volatileContext ?? '').length,
        tailSections: tailSections(opts.volatileContext ?? ''),
        toolCount: (opts.tools ?? []).length,
        tools: (opts.tools ?? []).map(t => t.name).sort(),
        messages: opts.messages.length,
        prefixHash: hash(opts.systemPrompt),
      });
      const step = steps[Math.min(i++, steps.length - 1)];
      for (const ev of step) yield ev;
    },
  };
}

function hash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(16);
}

const final = (text) => [
  { type: 'text', content: text },
  { type: 'usage', inputTokens: 100, outputTokens: 10 },
  { type: 'finish', reason: 'stop' },
];
const toolThenFinal = [
  [
    { type: 'text', content: 'Let me look.' },
    { type: 'tool_call', id: 'tc1', name: 'Pwd', input: {} },
    { type: 'usage', inputTokens: 100, outputTokens: 20 },
    { type: 'finish', reason: 'tool_calls' },
  ],
  final('Done.'),
];

const session = new Session({ id: 'economy-probe', cwd: process.cwd(), startedAt: Date.now() });
const settings = { completionGate: { enabled: false }, cron: { enabled: false } };
const requests = [];
const turns = [
  { label: 'two-step', task: 'Tell me where we are.', steps: toolThenFinal },
  { label: 'qa-shaped', task: 'Open http://localhost:3000 and test the login form.', steps: [final('Tested.')] },
  { label: 'quiet', task: 'Thanks, that is all.', steps: [final('You are welcome.')] },
];
for (const [turnIndex, turn] of turns.entries()) {
  const before = requests.length;
  const provider = scripted(turn.steps, requests);
  await runAgent({
    task: turn.task, model: 'mock-model', showPlan: false, autoApprove: true, verbose: false, silent: true,
    conversationHistory: [], sessionId: session.header.id, settings, provider, session,
  });
  for (let i = before; i < requests.length; i++) {
    requests[i].turn = turnIndex + 1;
    requests[i].label = turn.label;
    requests[i].step = i - before + 1;
  }
}

const quiet = requests.find(r => r.label === 'quiet');
const prefixHashes = new Set(requests.map(r => r.prefixHash));
const toolSets = new Set(requests.map(r => r.tools.join(',')));
const report = {
  at: new Date().toISOString(),
  requests: requests.map(({ tools, ...r }) => r),
  summary: {
    prefixChars: requests[0].prefixChars,
    prefixStable: prefixHashes.size === 1,
    toolSetStable: toolSets.size === 1,
    toolCount: requests[0].toolCount,
    quietTailChars: quiet.tailChars,
    quietTailTokensApprox: Math.round(quiet.tailChars / 4),
    quietTailSections: quiet.tailSections,
  },
};

console.log(`\nprefix: ${report.summary.prefixChars} chars (~${Math.round(report.summary.prefixChars / 4)} tokens), stable across the session: ${report.summary.prefixStable}`);
console.log(`tool set: ${report.summary.toolCount} tools, stable across the session: ${report.summary.toolSetStable}`);
for (const r of report.requests) {
  console.log(`  turn ${r.turn} step ${r.step} (${r.label}): tail ${r.tailChars} chars, ${r.toolCount} tools, ${r.messages} messages`);
}
console.log(`quiet step tail: ${report.summary.quietTailChars} chars (~${report.summary.quietTailTokensApprox} tokens)`);
for (const [id, chars] of Object.entries(report.summary.quietTailSections)) console.log(`    ${id.padEnd(22)} ${chars}`);

const out = flag('--out');
if (out) { fs.writeFileSync(out, JSON.stringify(report, null, 2)); console.log(`\nwritten ${out}`); }

function compare(a, b) {
  const pct = (x, y) => (x === 0 ? 'n/a' : `${Math.round(((y - x) / x) * 100)}%`);
  console.log(`\nprefix chars        ${a.summary.prefixChars} → ${b.summary.prefixChars} (${pct(a.summary.prefixChars, b.summary.prefixChars)})`);
  console.log(`quiet tail chars    ${a.summary.quietTailChars} → ${b.summary.quietTailChars} (${pct(a.summary.quietTailChars, b.summary.quietTailChars)})`);
  console.log(`tool set stable     ${a.summary.toolSetStable} → ${b.summary.toolSetStable}`);
  console.log(`prefix stable       ${a.summary.prefixStable} → ${b.summary.prefixStable}`);
  const ids = new Set([...Object.keys(a.summary.quietTailSections), ...Object.keys(b.summary.quietTailSections)]);
  for (const id of ids) {
    console.log(`    ${id.padEnd(22)} ${String(a.summary.quietTailSections[id] ?? 0).padStart(6)} → ${String(b.summary.quietTailSections[id] ?? 0).padStart(6)}`);
  }
  const reduction = 1 - b.summary.quietTailChars / a.summary.quietTailChars;
  const ok1 = reduction >= 0.6;
  const ok2 = b.summary.toolSetStable === true;
  console.log(`\n${ok1 ? '✓' : '✗'} quiet-step tail down ${Math.round(reduction * 100)}% (target ≥ 60%)`);
  console.log(`${ok2 ? '✓' : '✗'} tool set stable across a session with a QA-shaped message`);
  process.exitCode = ok1 && ok2 ? 0 : 1;
}
