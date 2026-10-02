/**
 * Preference learning against a real model — the one cheap live check
 * (ADR 0016). Costs a few tenths of a cent on deepseek-v4-flash.
 *
 * 1. Distillation: a correction and a 👎 note go through the real distiller
 *    (the naming model, reasoning off); it must propose a pnpm rule on the
 *    package-manager topic, and nothing personal.
 * 2. The eval: the same task — "add lodash; reply with only the command" —
 *    in a fresh npm project, before and after that rule is accepted. Before,
 *    the model has no reason to pick pnpm; after, it must.
 *
 * Plan mode keeps the agent read-only, so nothing is installed anywhere.
 * Run: npm run test:preferences:live [-- model]
 */

// A store of this process's own — nothing below may touch ~/.aico. Must stay first.
import './lib/test-home.mjs';
import fs from 'fs';
import os from 'os';
import path from 'path';

const T = await import('../dist-test/test-exports.js');
const MODEL = process.argv[2] ?? 'deepseek-v4-flash';

let passed = 0;
let failed = 0;
function assert(cond, name) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}`); }
}

const base = await T.loadSettings();
const settings = { ...base, model: MODEL, completionGate: { enabled: false }, cron: { enabled: false }, autoCompact: { enabled: false } };
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aico-pref-live-'));
fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'demo', version: '1.0.0', dependencies: {} }, null, 2));

console.log('\n══ 1. distillation with a real model ══');
const s = new T.Session({ id: 'pref-live-teach', cwd: dir, startedAt: Date.now() });
s.append('turn/start', { turn: 1 });
s.append('user/message', { turn: 1, content: 'Add zod to the project.', source: { kind: 'human' } });
const reply = s.append('assistant/message', { turn: 1, step: 1, content: 'Run `npm install zod` to add it.' });
s.append('user/message', { turn: 1, content: 'No, use pnpm, not npm — I always use pnpm for every project.', source: { kind: 'human' } });
s.append('turn/end', { turn: 1, reason: { kind: 'completed' } });
s.append('message/feedback', { targetSeq: reply.seq, rating: 'down', note: 'Wrong package manager. pnpm, always.' });
T.queueSignals([...T.signalsFromTurn(s, 1, dir).signals, T.feedbackSignal(s, reply.seq, 'down', 'Wrong package manager. pnpm, always.', dir)]);
const t0 = Date.now();
const out = await T.distillPending({ settings, complete: T.modelCompleter(settings, MODEL) });
console.log(`  (${out.via}, ${Date.now() - t0} ms) added: ${JSON.stringify(out.added.map(r => [r.text, r.topic, r.scope, r.category]))}; refused: ${JSON.stringify(out.refused)}`);
const pnpmRule = out.added.find(r => /pnpm/i.test(r.text));
assert(out.via === 'model', 'the model answered in the expected shape');
assert(!!pnpmRule && pnpmRule.topic === 'package-manager' && pnpmRule.status === 'proposed', 'it proposed a pnpm rule on the package-manager topic, waiting for a person');
assert(out.added.length <= 2 && out.added.every(r => r.evidence.length > 0), 'concise, with evidence');

console.log('\n══ 2. eval: does an accepted rule change the next task? ══');
const task = 'We need lodash in this project. Reply with only the single shell command you would run to add it — do not run anything.';
const ask = async (id) => {
  const session = new T.Session({ id, cwd: dir, startedAt: Date.now() });
  const answer = await T.runAgent({ task, model: MODEL, showPlan: false, autoApprove: true, verbose: false, silent: true, planMode: true, conversationHistory: [], sessionId: id, cwd: dir, settings, session });
  return String(answer).trim();
};
const before = await ask('pref-live-before');
console.log(`  before: ${JSON.stringify(before.slice(0, 120))}`);
if (pnpmRule) {
  const store = T.loadPreferenceStore();
  T.applyRuleAction(store, { action: 'accept', id: pnpmRule.id });
  T.savePreferenceStore(store);
}
const after = await ask('pref-live-after');
console.log(`  after:  ${JSON.stringify(after.slice(0, 120))}`);
assert(!/\bpnpm\b/.test(before), 'without the rule the model does not pick pnpm (the project has no pnpm lockfile)');
assert(/\bpnpm (add|install|i)\b.*lodash/.test(after), 'with the rule accepted, the next task uses pnpm');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
