/**
 * Phase 5 of the agents/skills/tools design (docs/engineering/design/
 * agents-skills-tools.md §5.1 "Generation", §10): a generated skill is
 * measured before it is accepted.
 *
 * What each block proves:
 *   - a skill's evals/evals.json (skill-creator's shape + AICO checks) reads
 *     into scorable tasks; regex expectations become checks, prose ones are
 *     reported as unchecked, malformed checks are lint errors;
 *   - the built-in skill-author parses, passes strict validation and triggers
 *     on "make a skill" requests;
 *   - the measurement runs each task with and without the skill, reports the
 *     uplift, scores triggering on held-out queries, and tunes the description
 *     from train misses only (best-by-test);
 *   - the budget is a hard stop and the ceiling is clamped;
 *   - `register` refuses a draft whose evals were never run or describe other
 *     files, and refuses the model (not a person) when there is no uplift.
 *
 * Providers are scripted mocks: offline and free; nothing touches ~/.aico.
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

fs.writeFileSync(path.join(process.env.AICO_HOME, 'settings.json'), '{}');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aico-phase5-'));
process.on('exit', () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } });
const write = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); return file; };
await T.skillRegistry.load();

// ── fixtures ────────────────────────────────────────────────────────────

const NAME = 'changelog-entry';
const BODY = 'Write the entry under a `## Fixed` heading, one bullet, past tense, ending with the issue number in brackets like [#12]. {args}';

const TRIGGERS = [
  { query: 'write a changelog entry for the login fix', should_trigger: true },
  { query: 'add release notes for the crash fix', should_trigger: true },
  { query: 'changelog line for issue 40 please', should_trigger: true },
  { query: 'draft the changelog for the new export button', should_trigger: true },
  { query: 'summarise this release in the changelog', should_trigger: true },
  { query: 'fix the failing unit test in parser.ts', should_trigger: false },
  { query: 'rename the user service', should_trigger: false },
  { query: 'review my staged diff', should_trigger: false },
  { query: 'commit these changes', should_trigger: false },
  { query: 'explain how the cache works', should_trigger: false },
];

const EVALS = {
  skill_name: NAME,
  evals: [
    { id: 1, prompt: 'Changelog entry: fixed the crash on empty input, issue 12.', expectations: ['/^## Fixed/m', '/\\[#12\\]/', 'Reads naturally.'] },
    { id: 2, prompt: 'Changelog entry: login no longer loops, issue 7.', expectations: ['/^## Fixed/m', '/\\[#7\\]/'] },
    { id: 3, prompt: 'Changelog entry: export keeps column order, issue 3.', checks: [{ kind: 'output-matches', pattern: '\\[#3\\]', why: 'issue number missing' }] },
    { id: 4, prompt: 'Only prose here.', expectations: ['Sounds good.'] },
  ],
  triggers: TRIGGERS,
};

function draft(name, { body = BODY, description = 'Helps with writing some text for the project.', evals = EVALS } = {}) {
  const dir = path.join(T.draftsDir(), name);
  fs.rmSync(dir, { recursive: true, force: true });
  write(path.join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n${body}\n`);
  if (evals) write(path.join(dir, 'evals', 'evals.json'), JSON.stringify({ ...evals, skill_name: name }, null, 2));
  return dir;
}

/**
 * A scripted model. Trigger calls (only the Skill tool offered) open the skill
 * when its catalogue line and the request both talk about changelogs/release
 * notes; proposal calls return a sharper description; agent runs follow the
 * procedure only when it was handed over (`helps`), else answer plainly.
 */
function mockProvider({ helps = true } = {}) {
  const seen = { proposals: [], triggerCalls: 0, agentRuns: 0 };
  return {
    id: 'mock', displayName: 'Mock', seen,
    async *chat(opts) {
      const user = opts.messages.filter(m => m.role === 'user').map(m => typeof m.content === 'string' ? m.content : JSON.stringify(m.content)).join('\n');
      const tools = (opts.tools ?? []).map(t => t.name);
      if (tools.length === 1 && tools[0] === 'Skill') {
        seen.triggerCalls++;
        const line = opts.systemPrompt.split('\n').find(l => l.startsWith(`- ${NAME}`) || l.startsWith('- tuned-') || l.startsWith('- flat-')) ?? '';
        const name = /^- ([\w-]+):/.exec(line)?.[1];
        const said = line.slice(line.indexOf(':') + 1); // the description, not the name
        const fits = /changelog|release note/i.test(said) && /changelog|release note/i.test(user);
        if (fits) yield { type: 'tool_call', id: 't1', name: 'Skill', input: { name } };
        else yield { type: 'text', content: 'Sure.' };
      } else if (tools.length === 0) {
        seen.proposals.push(user);
        yield { type: 'text', content: '{"description": "Writes changelog and release-note entries in the house format. Use when asked for a changelog entry or release notes."}' };
      } else {
        seen.agentRuns++;
        const withSkill = user.includes('Skill: ');
        const issue = /issue (\d+)/.exec(user)?.[1] ?? '0';
        yield { type: 'text', content: withSkill === helps ? `## Fixed\n- Fixed it [#${issue}]` : 'I fixed it.' };
      }
      yield { type: 'usage', inputTokens: 1000, outputTokens: 50 };
      yield { type: 'finish', reason: 'stop' };
    },
  };
}

const settings = { modelPricing: { 'mock-model': { input: 1, output: 2 } } };
const base = (provider, extra = {}) => ({ model: 'mock-model', settings, provider, budgetUsd: 1, ...extra });

// ── blocks ──────────────────────────────────────────────────────────────

await block('evals.json reads into scorable tasks', async () => {
  const dir = draft('reader-1');
  write(path.join(dir, 'evals', 'triggers.json'), JSON.stringify([{ query: 'extra one', should_trigger: false }]));
  const e = T.readDraftEvals(dir, 'reader-1');
  assert(e.tasks.length === 3, `three tasks have deterministic checks (${e.tasks.length})`);
  assert(e.tasks[0].checks.length === 2 && e.tasks[0].checks[0].kind === 'output-matches', 'a /regex/ expectation becomes an output-matches check');
  assert(e.unchecked.some(u => u.expectation === 'Reads naturally.'), 'a prose expectation is carried as unchecked, not scored');
  assert(e.notes.some(n => /evals\[3\].*no deterministic check/.test(n)), 'a task with nothing to score is named and left out');
  assert(e.triggers.length === 11, 'triggers come from evals.json and triggers.json');
  assert(e.problems.length === 0, 'a well-formed file has no problems');

  const bad = draft('reader-2', { evals: { evals: [{ id: 1, prompt: 'x', checks: [{ kind: 'llm-vibes' }], files: ['../../outside.txt'] }], triggers: [{ query: 'q' }] } });
  const b = T.readDraftEvals(bad, 'reader-2');
  assert(b.problems.some(p => /unknown check kind/.test(p)), 'an unknown check kind is a lint error');
  assert(b.problems.some(p => /not inside the skill folder/.test(p)), 'a fixture path outside the skill is refused');
  assert(b.problems.some(p => /should_trigger/.test(p)), 'a trigger without should_trigger is a lint error');
  const v = T.verifySkillDir(bad);
  assert(!v.ok && v.problems.some(p => p.startsWith('evals:')), 'verify fails a draft whose evals are malformed');
  const good = T.verifySkillDir(dir);
  assert(good.ok && good.notes.some(n => /not measured yet/.test(n)), 'verify passes good evals and says they are unmeasured');
  assert(T.readDraftEvals(path.join(tmp, 'none'), 'x') === null, 'no evals → null');
});

await block('the built-in skill-author', async () => {
  const s = T.skillRegistry.lookup('skill-author');
  assert(!!s && s.isBuiltin, 'skill-author ships as a built-in');
  const raw = fs.readFileSync(s.filePath, 'utf8');
  const fm = T.parseFrontmatter(raw);
  const v = T.validateFrontmatter(fm.data, { dirName: 'skill-author', body: fm.body, strict: true });
  assert(v.errors.length === 0, `passes strict spec validation (${v.errors.join('; ')})`);
  assert(s.frontmatter.description.length <= 200, 'description within the 200-character claude.ai limit');
  assert(raw.split('\n').length < 500, 'body under 500 lines');
  const matches = (q) => T.matchingSkills(q).some(x => x.frontmatter.name === 'skill-author');
  assert(matches('make a skill for our API conventions'), 'triggers on "make a skill for our API conventions"');
  assert(matches('write me a new skill'), 'triggers on "write me a new skill"');
  assert(!matches('fix the null check in parser.ts'), 'does not trigger on an unrelated bug fix');
  assert(/action:"eval"/.test(raw) && /baseline/.test(raw), 'its procedure measures against the baseline');
});

await block('trigger split and scores', async () => {
  const q = TRIGGERS.map(t => ({ query: t.query, shouldTrigger: t.should_trigger }));
  const a = T.splitTriggers(q);
  const b = T.splitTriggers([...q].reverse());
  assert([...a].every(([k, v]) => b.get(k) === v), 'the split is stable whatever the order');
  const test = q.filter(x => a.get(x.query) === 'test');
  assert(test.some(x => x.shouldTrigger) && test.some(x => !x.shouldTrigger), 'held-out side has both kinds');
  assert(test.length === 4, `~40% held out (${test.length}/10)`);
  const s = T.scoreTriggers([
    { shouldTrigger: true, triggered: true }, { shouldTrigger: true, triggered: false },
    { shouldTrigger: false, triggered: true }, { shouldTrigger: false, triggered: false },
  ]);
  assert(s.precision === 0.5 && s.recall === 0.5 && s.accuracy === 0.5, 'precision/recall/accuracy');
  assert(T.scoreTriggers([{ shouldTrigger: false, triggered: false }]).precision === null, 'precision is n/a when it never triggers');
});

await block('measure: with vs without, triggering, description tuning', async () => {
  const dir = draft(NAME);
  const provider = mockProvider();
  const r = await T.measureSkill(dir, base(provider, { triggerRuns: 2 }));
  assert(!r.error, `measured (${r.error ?? 'ok'})`);
  assert(r.tasks.length === 3 && r.tasks.every(t => t.with && t.without), 'every scorable task ran in both arms');
  assert(r.withMean === 1 && r.withoutMean === 0 && r.uplift === 1, `uplift is with − without (${r.withMean} − ${r.withoutMean})`);
  assert(provider.seen.agentRuns === 6, `six agent runs (${provider.seen.agentRuns})`);
  assert(r.descriptionTuning?.changed === true, 'a better description was found and kept');
  assert(/^description: .*changelog/im.test(fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8')), 'the tuned description was written into SKILL.md');
  const testQueries = r.triggers.outcomes.filter(o => o.split === 'test').map(o => o.query);
  assert(provider.seen.proposals.length === 1 && testQueries.every(q => !provider.seen.proposals[0].includes(q)), 'the proposal saw train misses only, never a held-out query');
  assert(r.triggers.heldOut.length === 2 && r.triggers.heldOut[0].precision === 1, 'held-out precision scored twice, 1.0');
  assert(r.triggers.precisionSpread?.min === 1, 'spread reported across runs');
  assert(r.complete && !r.overBudget && r.costUsd > 0, `complete, within budget, costed ($${r.costUsd.toFixed(4)})`);
  assert(r.unchecked.length === 2, 'prose expectations listed as unchecked');
  const saved = T.readReport(dir);
  assert(saved && saved.hash === T.treeHash(dir), 'report saved, bound to the final tree hash');
  assert(!T.listTree(dir).includes(T.REPORT_FILE), 'the report is outside the hashed tree');
  assert(/uplift \+1\.00/.test(T.describeReport(r)), 'the words say the uplift');
});

await block('budget is a hard stop, ceiling is clamped', async () => {
  const dir = draft('budget-1');
  const r = await T.measureSkill(dir, base(mockProvider(), { budgetUsd: 0.000001 }));
  assert(r.overBudget && !r.complete, 'a tiny budget stops early and the report says so');
  const g = T.evalGate(dir, true);
  assert(!g.ok && g.person, 'an incomplete measurement does not pass the gate on its own');
  const plan = T.planMeasure(dir, base(mockProvider(), { budgetUsd: 50 }));
  assert(plan.budgetUsd === T.MAX_BUDGET_USD, `the ceiling is clamped to $${T.MAX_BUDGET_USD}`);
  assert(plan.agentRuns === 6 && plan.triggerCalls > 0 && plan.estimateUsd > 0, 'the plan states runs, calls and an estimate');
});

await block('register is gated on a fresh measurement with uplift', async () => {
  const resources = [{ path: 'evals/evals.json', content: JSON.stringify({ ...EVALS, skill_name: 'gated-skill' }) }];
  const created = await T.executeSkillManage({ action: 'create', name: 'gated-skill', description: 'Writes changelog entries in the house format. Use when asked for a changelog entry.', prompt: BODY, resources });
  assert(/Draft written/.test(created), 'create writes the draft with its evals');
  const dir = path.join(T.draftsDir(), 'gated-skill');

  let out = await T.executeSkillManage({ action: 'register', name: 'gated-skill' });
  assert(/Not registered.*never been run/s.test(out), 'unmeasured evals → refused');

  await T.measureSkill(dir, base(mockProvider({ helps: false }), { triggers: false }));
  out = await T.executeSkillManage({ action: 'register', name: 'gated-skill' });
  assert(/did not beat the no-skill baseline/.test(out), 'no uplift → the model is refused, with the numbers');
  assert(fs.existsSync(dir), 'the refused draft stays where it was');

  await T.measureSkill(dir, base(mockProvider(), { triggers: false }));
  fs.appendFileSync(path.join(dir, 'SKILL.md'), '\nOne more line.\n');
  out = await T.executeSkillManage({ action: 'register', name: 'gated-skill' });
  assert(/changed after it was measured/.test(out), 'edited after measuring → refused as stale');
  out = await T.executeSkillManage({ action: 'register', name: 'gated-skill' }, { human: true });
  assert(/Not registered/.test(out), 'a stale report is refused for a person too');

  await T.measureSkill(dir, base(mockProvider(), { triggers: false }));
  out = await T.executeSkillManage({ action: 'register', name: 'gated-skill' });
  assert(/Registered "gated-skill"/.test(out) && /uplift \+1\.00/.test(out), 'measured with uplift → registered, numbers in the reply');
  const installed = T.skillRegistry.lookup('gated-skill');
  assert(installed && T.readReport(installed.dir)?.hash === T.treeHash(installed.dir), 'the report travels with the skill and still matches');

  const flat = draft('flat-skill');
  await T.measureSkill(flat, base(mockProvider({ helps: false }), { triggers: false }));
  out = await T.executeSkillManage({ action: 'register', name: 'flat-skill' }, { human: true });
  assert(/Registered "flat-skill"/.test(out), 'a person may register one that did not beat the baseline');

  draft('no-evals-skill', { evals: null, description: 'Writes a thing in the house format. Use when asked for that thing.' });
  out = await T.executeSkillManage({ action: 'register', name: 'no-evals-skill' });
  assert(/Registered/.test(out), 'a draft without evals keeps the existing create → register flow');

  out = await T.executeSkillManage({ action: 'eval', name: 'nothing-here' });
  assert(/No draft or installed/.test(out), 'eval names a missing skill');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { for (const f of failures) console.log(`  ✗ ${f}`); process.exit(1); }
process.exit(0);
