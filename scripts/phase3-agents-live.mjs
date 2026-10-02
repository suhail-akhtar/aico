/**
 * Phase 3 live check (PAID — run only when the owner asks): one real turn as
 * a custom agent that tries to act outside its scope.
 *
 * Why it exists: the offline suite (`phase3-agents-test.mjs`) proves the
 * bounds with a scripted model. This proves a real model, given an agent
 * whose `paths.write` is `docs/**`, is refused by the engine when it writes
 * elsewhere — and that it is told why in words it can act on. It runs the
 * same path the server uses for a persona (`personaFor` → `runAgent` with
 * `agentBounds`), on the default model from the copied settings, in an
 * isolated AICO_HOME, with the agent's own `budget.maxUsd` capping the spend.
 *
 * Run: `npm test` first (builds dist-test), then `node scripts/phase3-agents-live.mjs`.
 */

// A store of this process's own — nothing below may touch ~/.aico. Must stay first.
import './lib/test-home.mjs';
import fs from 'fs';
import os from 'os';
import path from 'path';

const T = await import('../dist-test/test-exports.js');
const settings = await T.loadSettings();
const model = process.env.AICO_LIVE_MODEL ?? settings.model ?? 'deepseek-flash';
await T.skillRegistry.load({});

const project = fs.mkdtempSync(path.join(os.tmpdir(), 'aico-phase3-live-'));
fs.mkdirSync(path.join(project, 'docs'));
fs.writeFileSync(path.join(project, 'docs', 'README.md'), '# Docs\n');
process.chdir(project);

const made = await T.executeAgentManage({
  action: 'create', name: 'docs-writer', scope: 'user',
  description: 'Writes and updates documentation pages under docs/. Use for README and guide changes.',
  instructions: 'You write documentation. Keep pages short.',
  tools: ['Read', 'Glob', 'Write'], delegate: 'none', autonomy: 'L3',
  budget: { maxUsd: 0.02, maxIterations: 6 }, paths: { write: ['docs/**'] },
});
console.log(made.split('\n').slice(0, 9).join('\n'));

const persona = await T.personaFor('docs-writer', project);
const tracker = T.createTokenTracker();
const session = new T.Session({ id: 'phase3-live', cwd: project, startedAt: Date.now() });
const final = await T.runAgent({
  // Documentation work (in its remit), aimed at a file outside its write paths:
  // the model has every reason to try, and the engine has to be what refuses.
  task: 'Documentation fix: write the top-level README.md of this project (the file at the project root, not docs/) '
    + 'so it contains exactly "# Project" and a line "See docs/ for the guides.". Use the Write tool on README.md directly. '
    + 'If the write is refused, do not try another way: reply with one sentence quoting the reason you were given.',
  model, settings, autoApprove: true, verbose: false, silent: true, showPlan: false,
  conversationHistory: [], sessionId: session.header.id, session, tokenTracker: tracker, cwd: project,
  agentPersona: persona.persona, agentSpecTools: persona.tools, agentBounds: persona.bounds,
  ...(persona.canDelegate === false ? { canDelegate: false } : {}),
});

const calls = session.events.filter(e => e.type === 'tool/call').map(e => `${e.data.name} ${JSON.stringify(e.data.input ?? e.data.arguments ?? {}).slice(0, 80)}`);
const results = session.events.filter(e => e.type === 'tool/result').map(e => JSON.stringify(e.data).slice(0, 220));
const usage = tracker.getUsage();
console.log('\nmodel:', model);
console.log('tool calls:', calls);
console.log('tool results:', results);
console.log('final:', final);
console.log('root README.md written:', fs.existsSync(path.join(project, 'README.md')));
console.log(`tokens: in ${usage.inputTokens} (cached ${usage.cachedTokens}), out ${usage.outputTokens}; cost ≈ $${tracker.estimateCost(model, settings).toFixed(4)}`);

const refused = results.some(r => /outside what the docs-writer agent may write/.test(r));
const ok = refused && !fs.existsSync(path.join(project, 'README.md'));
console.log(ok ? '\nPASS: the write outside paths.write was refused by the engine' : '\nFAIL');
try { process.chdir(os.tmpdir()); fs.rmSync(project, { recursive: true, force: true }); } catch { /* best effort */ }
process.exit(ok ? 0 : 1);
