/**
 * Preference learning (src/learning/signals, preferences, distill; ADR 0016),
 * offline: synthetic sessions and a stub completer stand in for the model.
 *
 * What each block proves:
 *   - signal capture: corrections, choices, 👍/👎 notes and hand edits are
 *     recognised from the person's own acts (never a plugin's message, never a
 *     question), redacted, deduplicated, and a choice only becomes a signal
 *     once it is a habit;
 *   - distillation: the model reply is parsed as data (fences, junk, unknown
 *     evidence ids, bad scopes), the fallback keeps standing statements only,
 *     duplicates merge, contradictions replace (a proposed rule at once, an
 *     active one only on acceptance), secrets/personal data/sycophancy are
 *     refused, forgetting is remembered;
 *   - control: accept/disable/enable/edit/forget/add, auto-accept only for
 *     low-risk style decided in code;
 *   - use: scope selection (project / language / global), relevance order,
 *     the 400-token cap, and — through `runAgent` with a mock provider — that
 *     an active "use pnpm, not npm" rule reaches the request tail, never the
 *     cached system prompt, and changes what the next task answers.
 *
 * Offline and free; nothing touches ~/.aico.
 */

// A store of this process's own — nothing below may touch ~/.aico. Must stay first.
import './lib/test-home.mjs';
import fs from 'fs';
import os from 'os';
import path from 'path';

const T = await import('../dist-test/test-exports.js');

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
const reset = () => {
  for (const f of [T.preferenceRulesFile(), T.signalsFile(), path.join(path.dirname(T.signalsFile()), 'choices.json')]) fs.rmSync(f, { force: true });
};
const mkSession = (id) => new T.Session({ id, cwd: process.cwd(), startedAt: Date.now() });
const tmpProject = (files = {}) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aico-pref-'));
  for (const [f, c] of Object.entries(files)) fs.writeFileSync(path.join(dir, f), c);
  return dir;
};

await block('signal capture: corrections and choices from the person only', async () => {
  const c = T.detectCorrections('No, use pnpm not npm. Also add a header? From now on always write tests first.\n```js\nnever();\n```');
  assert(c.length === 2 && /pnpm/.test(c[0]) && /tests first/.test(c[1]), `standing corrections found, the question and the code fence skipped (${JSON.stringify(c)})`);
  assert(T.detectCorrections('Add a button to the invoices page.').length === 0, 'a plain request is not a correction');
  assert(T.detectCorrections('Should we always use tabs?').length === 0, 'a question is not a correction');
  const ch = T.detectChoices('pnpm add zod and indent with tabs, tests first please');
  assert(ch.some(x => x.dimension === 'package-manager' && x.value === 'pnpm') && ch.some(x => x.dimension === 'indentation' && x.value === 'tabs') && ch.some(x => x.value === 'tests-first'), 'choices: package manager, indentation, test order');

  const s = mkSession('pref-cap');
  s.append('turn/start', { turn: 1 });
  s.append('user/message', { turn: 1, content: 'Install lodash. Always use pnpm, not npm.', source: { kind: 'human' } });
  s.append('user/message', { turn: 1, content: 'Never skip the checks gate.', source: { kind: 'plugin', plugin: 'checks-gate' } });
  s.append('turn/end', { turn: 1, reason: { kind: 'completed' } });
  const { signals, choices } = T.signalsFromTurn(s, 1, '/proj');
  assert(signals.length === 1 && signals[0].kind === 'correction' && signals[0].seq === 2, 'one correction, from the human message, with its seq as evidence');
  assert(choices.length === 1 && choices[0].value === 'pnpm', 'and the choice it made');
  assert(T.makeSignal({ kind: 'correction', text: 'use key ghp_abcdefghijklmnopqrstuvwxyz0123456789 and mail me at a.b@example.com from C:\\Users\\alice\\x', sessionId: 's', at: 1 }).text.match(/ghp_|example\.com|alice/) === null, 'signals are scrubbed: token shapes, emails, home paths');  // standards-allow: secret
});

await block('signal capture: feedback notes, hand edits, repeated choices', async () => {
  reset();
  const s = mkSession('pref-fb');
  s.append('turn/start', { turn: 1 });
  s.append('user/message', { turn: 1, content: 'Write the helper', source: { kind: 'human' } });
  const reply = s.append('assistant/message', { turn: 1, step: 1, content: 'Here is the helper using var everywhere.' });
  s.append('turn/end', { turn: 1, reason: { kind: 'completed' } });
  s.append('message/feedback', { targetSeq: reply.seq, rating: 'down', note: 'Never use var; prefer const.' });
  const fb = T.feedbackSignal(s, reply.seq, 'down', 'Never use var; prefer const.', '/proj');
  assert(fb && fb.kind === 'feedback' && /👎 "Never use var/.test(fb.text) && /began: Here is the helper/.test(fb.text), 'a 👎 with a note is a signal carrying the note and the start of the reply');
  assert(T.feedbackSignal(s, reply.seq, 'up', '  ', '/proj') === undefined, 'a rating without words is not');

  // Hand edit: the agent writes, the person re-indents with tabs.
  const dir = tmpProject();
  const file = path.join(dir, 'util.ts');
  fs.writeFileSync(file, 'export function a() {\n  const x = 1;\n  const y = 2;\n  return x + y;\n}\n');
  const e = mkSession('pref-edit');
  e.append('turn/start', { turn: 1 });
  e.append('tool/call', { turn: 1, step: 1, callId: 'w', name: 'Write', arguments: JSON.stringify({ file_path: 'util.ts' }) });
  e.append('turn/end', { turn: 1, reason: { kind: 'completed' } });
  assert(T.rememberAgentWrites(e, 1, dir) === 1, 'the file the agent wrote is remembered');
  fs.writeFileSync(file, 'export function a() {\n\tconst x = 1;\n\tconst y = 2;\n\treturn x + y;\n}\n');
  const edits = T.userEditSignals('pref-edit');
  assert(edits.length === 1 && /re-indented with tabs/.test(edits[0].text) && edits[0].language === 'typescript' && /util\.ts/.test(edits[0].text), `a hand edit is a diff summary with the style it shows (${edits[0]?.text.split('\n')[0]})`);
  assert(edits[0].text.split('\n').length <= 7, 'a summary (a header and at most three line pairs), not the file');
  assert(T.userEditSignals('pref-edit').length === 0, 'the snapshot is consumed');
  const late = T.canvasEditSignal({ sessionId: 's', title: 'Doc', agentVersion: { content: 'a\nb', at: 0 }, userVersion: { content: 'a\nc', at: T.EDIT_WINDOW_MS + 1, version: 2 } });
  assert(late === undefined, 'an edit long after the agent wrote is not a reaction to it');
  const canvas = T.canvasEditSignal({ sessionId: 's', title: 'Doc', agentVersion: { content: 'Intro\nWe utilise X.', at: 0 }, userVersion: { content: 'Intro\nWe use X.', at: 1000, version: 2 } });
  assert(canvas && /canvas "Doc": \+1 −1/.test(canvas.text) && /\+ We use X\./.test(canvas.text), 'a canvas edit is summarised the same way');

  // Choices: a habit only at 3 picks, 2+ sessions, 75%+.
  const pick = (sid) => T.tallyChoices([{ dimension: 'package-manager', value: 'pnpm', seq: 1 }], sid, '/proj');
  assert(pick('a').length === 0 && pick('a').length === 0, 'two picks in one session are not a habit');
  const third = pick('b');
  assert(third.length === 1 && third[0].kind === 'choice' && /"pnpm" 3 times across 2 sessions/.test(third[0].text), 'the third pick in a second session is');
  assert(pick('c').length === 0, 'and it is emitted once');

  assert(T.queueSignals([fb, fb, ...edits]) === 2 && T.queueSignals([fb]) === 0, 'queueing dedupes by id');
  T.consumeSignals([fb.id]);
  assert(T.readPendingSignals().length === 1, 'consumed signals leave the queue');
});

await block('distillation: parsing the model reply as data', async () => {
  const sigs = [
    T.makeSignal({ kind: 'correction', text: 'Always use pnpm, not npm.', sessionId: 's1', seq: 4, projectRoot: '/p/one', at: 1 }),
    T.makeSignal({ kind: 'edit', text: 'You edited util.py: re-indented with tabs', sessionId: 's1', projectRoot: '/p/one', language: 'python', at: 2 }),
  ];
  const req = T.buildDistillRequest(sigs, []);
  assert(req.includes(sigs[0].id) && !req.includes('/p/one'), 'the request cites signal ids and carries no project path');
  const reply = 'Sure!\n```json\n' + JSON.stringify({ rules: [
    { text: 'Use pnpm, not npm.', topic: 'package-manager', scope: 'global', category: 'tooling', evidence: [sigs[0].id] },
    { text: 'Indent Python with tabs.', topic: 'indentation', scope: 'language:py', category: 'style', evidence: [sigs[1].id, 'sig-made-up'] },
    { text: 'Keep this repo on Node 22.', scope: 'project', category: 'nonsense', evidence: [sigs[0].id] },
    { nope: true }, 'junk',
  ] }) + '\n```\nHope that helps.';
  const c = T.parseDistillReply(reply, sigs);
  assert(c.length === 3, `three rules parsed, junk dropped (${c.length})`);
  assert(c[1].scope === 'language:python' && c[1].evidence.length === 1, 'language aliases normalise; an evidence id the model was not shown is ignored');
  assert(c[2].scope === `project:${path.resolve('/p/one')}` && c[2].category === 'workflow', '"project" resolves to the evidence\'s project; an unknown category becomes workflow');
  assert(T.parseDistillReply('I cannot help with that.', sigs) === undefined && T.parseDistillReply('{"rules": "x"}', sigs) === undefined, 'an unusable reply is undefined (the fallback runs)');

  const fb = T.fallbackCandidates([
    sigs[0],
    T.makeSignal({ kind: 'correction', text: "Don't change the API here.", sessionId: 's', at: 1 }),
    T.makeSignal({ kind: 'choice', text: 'Chose indentation "tabs" 3 times across 2 sessions (100% of picks).', sessionId: 's', at: 1 }),
  ]);
  assert(fb.length === 2 && fb[0].text === 'Always use pnpm, not npm.' && fb[1].text === 'Indent with tabs.' && fb[1].category === 'style', 'the fallback keeps standing statements and habits word for word, not one-off requests');
});

await block('merging: duplicates, contradictions, refusals, forgetting', async () => {
  reset();
  const store = T.loadPreferenceStore();
  const ev = (sid, seq) => [{ sessionId: sid, seq, kind: 'correction', excerpt: 'x', at: 1 }];
  let r = T.mergeCandidates(store, [{ text: 'Use pnpm, not npm', scope: 'global', category: 'tooling', evidence: ev('a', 1) }], { now: 10 });
  assert(r.added.length === 1 && r.added[0].status === 'proposed' && r.added[0].topic === 'package-manager' && r.added[0].text === 'Use pnpm, not npm.', 'a new rule starts proposed, with a recognised topic and tidy text');
  r = T.mergeCandidates(store, [{ text: 'Always use pnpm instead of npm.', scope: 'global', evidence: ev('b', 2) }], { now: 11 });
  assert(r.merged.length === 1 && store.rules.length === 1 && store.rules[0].evidence.length === 2, 'the same rule in other words merges its evidence');
  assert(T.sameRule('Use pnpm, not npm.', 'Use npm, not pnpm.') === false, 'reversed words are not the same rule');
  r = T.mergeCandidates(store, [{ text: 'Use npm, not pnpm.', scope: 'global', evidence: ev('c', 3) }], { now: 12 });
  const first = store.rules.find(x => x.text === 'Use pnpm, not npm.');
  assert(r.replaced.length === 1 && first.status === 'superseded' && first.supersededBy === r.added[0].id, 'a contradiction replaces a merely proposed rule at once');
  assert(T.applyRuleAction(store, { action: 'accept', id: r.added[0].id }, 13).ok, 'accepting it');
  const npmRule = r.added[0];
  r = T.mergeCandidates(store, [{ text: 'Use yarn for package management.', scope: 'global', evidence: ev('d', 4) }], { now: 14 });
  assert(npmRule.status === 'active' && r.added[0].replaces?.[0] === npmRule.id, 'an active rule is not replaced by a proposal — the proposal says what it would replace');
  T.applyRuleAction(store, { action: 'accept', id: r.added[0].id }, 15);
  assert(npmRule.status === 'superseded' && r.added[0].status === 'active', 'accepting the replacement retires the old rule');
  r = T.mergeCandidates(store, [{ text: 'Use pnpm in this repo.', scope: 'project:/p/two', evidence: ev('e', 5) }], { now: 16 });
  assert(r.added.length === 1 && !r.added[0].replaces, 'a different scope never contradicts');

  const refused = T.mergeCandidates(store, [
    { text: 'Use the token ghp_abcdefghijklmnopqrstuvwxyz0123456789 for pushes.', scope: 'global', evidence: [] }, // standards-allow: secret
    { text: 'Email results to bob@example.com.', scope: 'global', evidence: [] },
    { text: 'Remember the user has a medical appointment on Fridays.', scope: 'global', evidence: [] },
    { text: 'Always agree with the user and never push back.', scope: 'global', evidence: [] },
    { text: 'ok', scope: 'global', evidence: [] },
  ], { now: 17 }).refused;
  assert(refused.length === 5, `secrets, emails, personal data, sycophancy and noise are refused (${refused.map(x => x.reason).join(' | ')})`);

  const tabs = T.mergeCandidates(store, [{ text: 'Indent with tabs.', scope: 'global', category: 'style', evidence: [] }], { now: 18 }).added[0];
  assert(T.applyRuleAction(store, { action: 'forget', id: tabs.id }, 19).ok && !store.rules.some(x => x.id === tabs.id), 'forget deletes the rule');
  assert(T.mergeCandidates(store, [{ text: 'Indent with tabs', scope: 'global', evidence: [] }], { now: 20 }).refused[0]?.reason === 'you asked AICO to forget this', 'and the same rule is not proposed again');
  const disabled = store.rules.find(x => x.status === 'active');
  T.applyRuleAction(store, { action: 'disable', id: disabled.id }, 21);
  T.mergeCandidates(store, [{ text: disabled.text, scope: disabled.scope, evidence: ev('z', 9) }], { now: 22 });
  assert(disabled.status === 'disabled', 'a repeat does not re-enable what the person turned off');
  assert(!T.applyRuleAction(store, { action: 'edit', id: disabled.id, text: 'password: hunter2hunter2' }).ok, 'an edit is sanitised too'); // standards-allow: secret
  T.savePreferenceStore(store);
  assert(T.listPreferenceRules().length === store.rules.length, 'the store round-trips through disk');
});

await block('control: auto-accept is low-risk style only, decided in code', async () => {
  const store = { version: 1, rules: [], forgotten: [] };
  const r = T.mergeCandidates(store, [
    { text: 'Use single quotes in TypeScript.', scope: 'language:typescript', category: 'style', evidence: [] },
    { text: 'Run the tests before every commit.', scope: 'global', category: 'style', evidence: [] },
    { text: 'Use pnpm, not npm.', scope: 'global', category: 'tooling', evidence: [] },
  ], { autoAcceptStyle: true, now: 1 });
  assert(r.added[0].status === 'active' && r.added[0].autoAccepted, 'a formatting rule is auto-accepted when the toggle is on');
  assert(r.added[1].status === 'proposed', 'a "style" rule that runs things is not, whatever the model called it');
  assert(r.added[2].status === 'proposed', 'a tooling rule waits for a person');
  const off = T.mergeCandidates({ version: 1, rules: [], forgotten: [] }, [{ text: 'Use single quotes.', scope: 'global', category: 'style', evidence: [] }], { now: 1 });
  assert(off.added[0].status === 'proposed', 'with the toggle off (the default) nothing is auto-accepted');
  const added = T.applyRuleAction(store, { action: 'add', text: 'Use bun for package management', scope: 'global' }, 2);
  assert(added.ok && added.rule.status === 'active' && added.rule.byUser && store.rules.find(x => x.text === 'Use pnpm, not npm.').status === 'proposed', 'a rule the person types is in force at once');
});

await block('use: scope selection, relevance order, the 400-token cap', async () => {
  const ts = tmpProject({ 'package.json': '{}', 'tsconfig.json': '{}' });
  const py = tmpProject({ 'pyproject.toml': '' });
  assert(T.contextLanguages(ts).join() === 'javascript,typescript' && T.contextLanguages(py, 'fix the .go file').join() === 'go,python', 'languages come from marker files and the task');
  const rule = (id, text, scope, over = {}) => ({ id, text, topic: id, scope, category: 'workflow', status: 'active', evidence: [], createdAt: 1, updatedAt: 1, ...over });
  const rules = [
    rule('g1', 'Keep commit messages imperative.', 'global'),
    rule('g2', 'Explain the migration plan before editing the database schema.', 'global'),
    rule('p1', 'Use pnpm, not npm.', `project:${ts}`),
    rule('p2', 'Deploy only from main.', `project:${py}`),
    rule('l1', 'Prefer type over interface.', 'language:typescript'),
    rule('l2', 'Use f-strings.', 'language:python'),
    rule('d1', 'Disabled rule.', 'global', { status: 'disabled' }),
    rule('o1', 'Proposed rule.', 'global', { status: 'proposed' }),
  ];
  const picked = T.selectRules(rules, { projectRoot: ts, task: 'change the database schema' }).map(r => r.id);
  assert(picked.join() === 'p1,l1,g2,g1', `this project's rules, then this language's, then global by task overlap; never another project's, another language's, disabled or proposed (${picked.join()})`);
  const many = Array.from({ length: 80 }, (_, i) => rule(`m${i}`, `Rule number ${i} says something moderately long about how the work should be done here.`, 'global'));
  const capped = T.selectRules(many, { projectRoot: ts, task: '' });
  const text = T.renderRules(capped);
  assert(capped.length > 3 && capped.length < 80 && Math.ceil(text.length / 4) <= T.RULES_TOKEN_BUDGET + 5, `the rendered block stays within ~${T.RULES_TOKEN_BUDGET} tokens (${capped.length} rules, ${text.length} chars)`);
  assert(T.renderRules([]) === '', 'no rules, no section');
});

await block('eval: an accepted "use pnpm, not npm" changes the next task (mock model, through runAgent)', async () => {
  reset();
  const dir = tmpProject({ 'package.json': '{"name":"x"}' });
  // A model stub that does what an obedient model would: pnpm when told, npm otherwise.
  const seen = [];
  const provider = {
    id: 'mock', displayName: 'Mock',
    async *chat(opts) {
      seen.push({ system: opts.systemPrompt, tail: opts.volatileContext ?? '' });
      const cmd = /use pnpm, not npm/i.test(opts.volatileContext ?? '') ? 'pnpm add lodash' : 'npm install lodash';
      yield { type: 'text', content: cmd };
      yield { type: 'finish', reason: 'stop' };
    },
  };
  const run = (id) => T.runAgent({
    task: 'Add lodash to this project. Reply with only the install command.', model: 'mock-model', showPlan: false, autoApprove: true,
    verbose: false, silent: true, conversationHistory: [], sessionId: id, cwd: dir,
    settings: { completionGate: { enabled: false }, cron: { enabled: false } }, provider, session: mkSession(id),
  });
  const before = await run('eval-before');
  // The signal → distil → proposal → accept path, with the fallback distiller.
  const s = mkSession('eval-teach');
  s.append('turn/start', { turn: 1 });
  s.append('user/message', { turn: 1, content: 'No — use pnpm, not npm. Always.', source: { kind: 'human' } });
  s.append('turn/end', { turn: 1, reason: { kind: 'completed' } });
  T.queueSignals(T.signalsFromTurn(s, 1, dir).signals);
  const out = await T.distillPending({ complete: async () => { throw new Error('offline'); } });
  assert(out.via === 'fallback' && out.added.length === 1 && out.added[0].status === 'proposed', 'the correction becomes one proposed rule (fallback distiller)');
  const proposedRun = await run('eval-proposed');
  const store = T.loadPreferenceStore();
  T.applyRuleAction(store, { action: 'accept', id: store.rules[0].id });
  T.savePreferenceStore(store);
  const after = await run('eval-after');
  assert(before === 'npm install lodash' && proposedRun === 'npm install lodash', 'before acceptance the next task is unchanged — a proposal is not in force');
  assert(after === 'pnpm add lodash', `after acceptance the next task uses pnpm (${after})`);
  const last = seen[seen.length - 1];
  assert(/How this user prefers to work/.test(last.tail) && /use pnpm, not npm/i.test(last.tail), 'the rule rides in the request tail');
  // The session id is in the prompt by design; everything else must not move.
  const sys = (x) => x.system.replace(/<session_id>[^<]*<\/session_id>/, '');
  assert(!/use pnpm, not npm/i.test(last.system) && sys(seen[0]) === sys(last), 'and never in the cached system prompt, which is byte-identical before and after (bar the session id)');
  const off = await T.runAgent({
    task: 'Add lodash. Reply with only the install command.', model: 'mock-model', showPlan: false, autoApprove: true, verbose: false, silent: true,
    conversationHistory: [], sessionId: 'eval-off', cwd: dir, settings: { completionGate: { enabled: false }, cron: { enabled: false }, learning: { preferences: false } },
    provider, session: mkSession('eval-off'),
  });
  assert(off === 'npm install lodash', 'switching learning off stops the injection');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { for (const f of failures) console.log(`  ✗ ${f}`); process.exit(1); }
process.exit(0);
