/**
 * Phase 3 of the agents/skills/tools design (docs/engineering/design/
 * agents-skills-tools.md §10): agents v2, tested as the promises the format
 * makes and the run keeps.
 *
 * The acceptance items, each a block below: the engine's "what this agent can
 * do" summary equals what the run is offered and what dispatch accepts (one
 * fixture, all three); a Claude Code agent file imports with
 * `permissionMode: bypassPermissions` ignored and warned; budget stops fire
 * at the configured limits; talking to an agent and delegating to it resolve
 * identically. Around them: the `.md` format and legacy JSON, save-time
 * validation, write paths, the autonomy ceiling, the delegate rule, and the
 * two built-in examples that replace the retired role team.
 *
 * Offline: a scripted provider stands in for the model. Everything is written
 * under this process's own AICO_HOME and temp directories.
 */

// A store of this process's own — nothing below may touch ~/.aico. Must stay first.
import './lib/test-home.mjs';
import fs from 'fs';
import os from 'os';
import path from 'path';

const T = await import(process.env.AICO_TEST_EXPORTS ?? '../dist-test/test-exports.js');

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

// No MCP servers or hooks from the copied settings: this suite is about agents.
fs.writeFileSync(path.join(process.env.AICO_HOME, 'settings.json'), '{}');
await T.skillRegistry.load({});

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aico-phase3-'));
const startCwd = process.cwd();
process.chdir(tmp);
process.on('exit', () => {
  try { process.chdir(startCwd); } catch { /* best effort */ }
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
});

// ── A scripted model ────────────────────────────────────────────────────
function mock(steps, opts = {}) {
  let i = 0;
  return {
    id: 'mock', displayName: 'Mock', toolSchemas: [],
    async *chat(o) {
      this.toolSchemas.push((o.tools ?? []).map(t => t.name));
      if (opts.delayMs) await new Promise(r => setTimeout(r, opts.delayMs));
      const step = typeof steps === 'function' ? steps(i++) : steps[Math.min(i++, steps.length - 1)];
      for (const ev of step) yield ev;
    },
  };
}
const calls = (...list) => [
  ...list.map(([name, input], n) => [{ type: 'tool_call', id: `c-${n}-${name}`, name, input }, { type: 'finish', reason: 'tool_calls' }]),
  [{ type: 'text', content: 'done' }, { type: 'finish', reason: 'stop' }],
];
const answerOnly = () => [[{ type: 'text', content: 'done' }, { type: 'finish', reason: 'stop' }]];
const SETTINGS = { completionGate: { enabled: false }, cron: { enabled: false }, repeatGuard: { enabled: false }, deferTools: false };

let runs = 0;
/** One turn as a named agent, the way the server runs a persona. */
async function personaTurn(name, steps, extra = {}) {
  const persona = await T.personaFor(name, tmp);
  const session = new T.Session({ id: `phase3-${++runs}`, cwd: tmp, startedAt: Date.now() });
  const provider = extra.provider ?? mock(steps);
  const final = await T.runAgent({
    task: 'go', model: 'mock-model', showPlan: false, autoApprove: true, verbose: false, silent: true,
    conversationHistory: [], sessionId: session.header.id, session, provider, settings: SETTINGS, cwd: tmp,
    ...(persona.persona ? { agentPersona: persona.persona } : {}),
    ...(persona.tools?.length ? { agentSpecTools: persona.tools } : {}),
    ...(persona.canDelegate === false ? { canDelegate: false } : {}),
    ...(persona.bounds ? { agentBounds: persona.bounds } : {}),
    ...extra,
  });
  const results = session.events.filter(e => e.type === 'tool/result').map(e => JSON.stringify(e.data));
  return { final, provider, offered: provider.toolSchemas[0] ?? [], results, persona };
}
const manage = (input) => T.executeAgentManage(input);

await block('Format: built-ins, Claude files, round trip', async () => {
  for (const [name, text] of Object.entries(T.BUILTIN_AGENT_FILES)) {
    const p = T.parseAgentMarkdown(text);
    assert(p.spec?.name === name && p.errors.length === 0, `built-in ${name} parses with no errors (${p.errors.join('; ')})`);
    const ctx = await T.validationContext(tmp);
    const v = T.validateAgentDef(p.spec, ctx);
    assert(v.errors.length === 0, `built-in ${name} validates (${v.errors.join('; ')})`);
    assert(p.spec.budget && p.spec.budget.maxUsd > 0 && p.spec.budget.maxIterations > 0, `${name} carries a budget (certification-ready)`);
  }
  const reviewer = T.parseAgentMarkdown(T.BUILTIN_AGENT_FILES['security-reviewer']).spec;
  assert(!reviewer.tools.some(t => ['Write', 'Edit', 'Bash', 'MultiEdit'].includes(t)) && reviewer.delegate === 'none',
    'security-reviewer is read-only and cannot delegate');
  const author = T.parseAgentMarkdown(T.BUILTIN_AGENT_FILES['test-author']).spec;
  assert(author.paths?.write?.includes('**/*.test.*') && author.autonomy === 'L2', 'test-author is bound to test paths at L2');

  const listed = (await T.listAgentSpecs(tmp)).filter(s => s.source === 'builtin').map(s => s.name).sort();
  assert(JSON.stringify(listed) === '["security-reviewer","test-author"]', `the role team is retired; built-ins are the two examples (${listed.join(', ')})`);

  const claude = [
    '---',
    'name: claude-helper',
    'description: >-',
    '  Helps with git history questions. Use when someone asks who changed',
    '  a line or why.',
    'tools: Read, Grep, Bash(git log:*), NotebookRead',
    'model: sonnet',
    'permissionMode: bypassPermissions',
    'color: blue',
    '---',
    'You answer questions about history.',
  ].join('\n');
  const p = T.parseAgentMarkdown(claude);
  assert(p.errors.length === 0 && p.spec.description.startsWith('Helps with git history'), 'a Claude block-scalar description parses');
  assert(!p.spec.autonomy, 'bypassPermissions does not set any autonomy level');
  assert(p.warnings.some(w => /bypassPermissions/.test(w) && /never raises/.test(w)), 'and is warned about');
  assert(!p.spec.tools.some(t => t.startsWith('Bash')), 'a Bash(prefix) entry is dropped, not widened to Bash');
  assert(p.warnings.some(w => /Bash\(git log:\*\)/.test(w)), 'with a warning naming it');
  assert(!p.spec.model && p.warnings.some(w => /sonnet/.test(w)), 'a Claude model alias becomes the session model, with a warning');
  assert(T.parseAgentMarkdown('---\nname: x\ndescription: y\npermissionMode: plan\n---\n').spec.autonomy === 'L0', 'permissionMode: plan maps down to L0');

  const md = T.agentToMarkdown(p.spec, claude);
  assert(/color: blue/.test(md), 'a rewrite keeps keys AICO does not manage');
  assert(!/permissionMode/.test(md), 'and drops the ignored permissionMode');
  const again = T.parseAgentMarkdown(md).spec;
  assert(JSON.stringify({ ...again, format: 0 }) === JSON.stringify({ ...p.spec, format: 0 }), 'parse → write → parse round-trips');
});

await block('Validation: unknown names are save-time errors that name the fix', async () => {
  const ctx = await T.validationContext(tmp);
  const v = T.validateAgentDef({
    name: 'bad-agent', description: 'Checks things for the phase 3 suite when asked to',
    tools: ['Read', 'Raed', 'custom:nope', 'mcp__ghost__*'], skills: ['no-such-skill'], mcpServers: ['ghost'],
    autonomy: 'L4', paths: { write: ['/etc/**', '../up/**'] },
  }, ctx);
  const e = v.errors.join('\n');
  assert(/"Raed" is not a tool AICO knows/.test(e), 'an unknown built-in name is an error');
  assert(/no custom tool called "nope"/.test(e), 'an unknown custom:<name> is an error');
  assert(/no MCP server called "ghost"/.test(e), 'an unknown MCP server is an error');
  assert(/no-such-skill/.test(e), 'an unknown skill is an error');
  assert(/absolute/.test(e) && /climbs out/.test(e), 'absolute and ".." write paths are errors');
  assert(v.warnings.some(w => /certification/.test(w)), 'L4 warns that certification is not available yet');

  const refused = await manage({ action: 'create', name: 'bad-agent', description: 'Checks things for the phase 3 suite when asked', tools: ['Raed'] });
  assert(/^Not saved/.test(refused) && /Raed/.test(refused), `create refuses on errors (${refused.slice(0, 80)})`);
  assert(!(await T.getAgentSpec('bad-agent', tmp)), 'and writes nothing');
  const live = JSON.parse(await manage({ action: 'validate', name: 'draft-x', description: 'Drafts for the suite to validate live', tools: ['Read'] }));
  assert(live.ok === true && live.summary?.tools?.includes('Read'), 'validate returns ok, warnings and the summary without saving');
});

await block('Legacy JSON still loads, and migrates to .md when saved', async () => {
  const dir = path.join(process.env.AICO_HOME, 'agents');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'legacy-one.json'), JSON.stringify({
    name: 'legacy-one', description: 'An old JSON agent kept for compatibility checks', role: 'old reviewer',
    goals: ['look'], skills: [], tools: ['Read', 'Grep'], canDelegate: true, reportFormat: 'short',
  }));
  const spec = await T.getAgentSpec('legacy-one', tmp);
  assert(spec?.format === 'json' && spec.tools.join() === 'Read,Grep', 'a legacy JSON agent loads');
  assert(spec.delegate === 'readonly', 'canDelegate:true reads as delegate readonly (never wider)');
  const up = await manage({ action: 'update', name: 'legacy-one', description: 'An old JSON agent, now edited once' });
  assert(/Updated/.test(up), `update works (${up.slice(0, 60)})`);
  assert(fs.existsSync(path.join(dir, 'legacy-one.md')) && !fs.existsSync(path.join(dir, 'legacy-one.json')), 'and rewrites it as .md, removing the .json');
  const after = await T.getAgentSpec('legacy-one', tmp);
  assert(after.format === 'md' && /old reviewer/.test(after.instructions ?? ''), 'its role survives as instructions');
  await manage({ action: 'delete', name: 'legacy-one' });
});

// The fixture for the summary/offered/dispatch acceptance test.
const FIX = 'scoped-writer';
await manage({ action: 'delete', name: FIX });
const made = await manage({
  action: 'create', name: FIX, scope: 'user',
  description: 'Writes documentation pages under docs/ for the phase 3 suite',
  instructions: 'You write docs.',
  tools: ['Read', 'Grep', 'Glob', 'Write', 'Edit'], disallowedTools: ['Edit'],
  delegate: 'none', autonomy: 'L3', budget: { maxUsd: 1, maxIterations: 20 }, paths: { write: ['docs/**'] },
});

await block('Acceptance: the summary equals what the run is offered and what dispatch accepts', async () => {
  assert(/Created agent/.test(made), `the fixture is created (${made.slice(0, 80)})`);
  const spec = await T.getAgentSpec(FIX, tmp);
  const summary = await T.summarizeAgent(spec, tmp);
  const { offered, results } = await personaTurn(FIX, calls(['Edit', { file_path: 'docs/a.md', old_string: 'a', new_string: 'b' }]));
  const sort = (a) => [...a].sort().join(',');
  assert(sort(summary.tools) === sort(offered), `summary tools = offered (${sort(summary.tools)} vs ${sort(offered)})`);

  const scope = T.agentRunScope({ agentSpecTools: spec.tools, agentBounds: T.boundsOf(spec), cwd: tmp });
  const accepted = T.toolDefinitions.map(d => d.name).concat(['Task', 'Investigate'])
    .filter(n => !T.scopeDenial(scope, n));
  assert(sort(accepted) === sort(summary.tools), `dispatch accepts exactly the summary's tools (${sort(accepted)})`);
  assert(!offered.includes('Edit') && results.length === 1 && /outside what this agent may use|unknown tool|not available/i.test(results[0]),
    `a disallowed tool is not offered, and refused when called anyway (${results[0]?.slice(0, 90)})`);
  assert(/disallowedTools/.test(T.scopeDenial(scope, 'Edit') ?? ''), 'the dispatch guard names the bound that refused it');
  assert(/Cannot:.*delegate/.test(summary.text) && /docs\/\*\*/.test(summary.writes), 'the summary says it cannot delegate and where it may write');
});

await block('Write paths: AICO file tools are bound, deny-only', async () => {
  fs.mkdirSync(path.join(tmp, 'docs'), { recursive: true });
  const { results } = await personaTurn(FIX, calls(
    ['Write', { file_path: path.join(tmp, 'src', 'evil.ts'), content: 'x' }],
    ['Write', { file_path: path.join(tmp, 'docs', 'ok.md'), content: '# ok' }],
  ));
  assert(results.some(r => /outside what the scoped-writer agent may write/.test(r)), 'a write outside paths.write is refused with the reason');
  assert(!fs.existsSync(path.join(tmp, 'src', 'evil.ts')), 'and nothing is written there');
  assert(fs.existsSync(path.join(tmp, 'docs', 'ok.md')), 'a write inside paths.write goes through');
  assert(T.globToRegExp('**/*.test.*').test('src/a/b.test.ts') && !T.globToRegExp('docs/**').test('docsx/a'), 'globs match by segment');
  assert(T.writeRefusal([{ label: 'x', root: tmp, globs: ['docs/**'] }], path.join(tmp, 'docs', '..', 'src', 'a'), tmp), '".." in a target cannot escape the bound');
});

await block('Autonomy ceiling: lowered by the agent, never raised', async () => {
  await manage({ action: 'delete', name: 'asker' });
  await manage({ action: 'create', name: 'asker', scope: 'user', description: 'Asks before changing anything, for the phase 3 suite',
    instructions: 'Careful.', tools: ['Read', 'Write', 'Bash'], delegate: 'none', autonomy: 'L1', budget: { maxIterations: 10 } });
  const asked = [];
  const { results } = await personaTurn('asker', calls(
    ['Read', { file_path: path.join(tmp, 'docs', 'ok.md') }],
    ['Write', { file_path: path.join(tmp, 'w.txt'), content: 'x' }],
  ), { onApprovalRequired: async (tool) => { asked.push(tool); return false; } });
  assert(!asked.includes('Read'), 'at L1 a read is not asked about');
  assert(asked.includes('Write') && !fs.existsSync(path.join(tmp, 'w.txt')), 'at L1 a write in an auto session asks the person, and a "no" stops it');
  assert(results.some(r => /denied/i.test(r)), 'the model is told it was denied');

  await manage({ action: 'update', name: 'asker', autonomy: 'L2' });
  const asked2 = [];
  await personaTurn('asker', calls(
    ['Write', { file_path: path.join(tmp, 'w2.txt'), content: 'x' }],
    ['Bash', { command: 'echo hi' }],
  ), { onApprovalRequired: async (tool) => { asked2.push(tool); return false; } });
  assert(fs.existsSync(path.join(tmp, 'w2.txt')) && !asked2.includes('Write'), 'at L2 an edit runs without asking');
  assert(asked2.includes('Bash'), 'at L2 a command asks');

  await manage({ action: 'update', name: 'asker', autonomy: 'L0' });
  const plan = await personaTurn('asker', answerOnly());
  assert(!plan.offered.includes('Write') && !plan.offered.includes('Bash') && plan.offered.includes('Read'), `at L0 only reading is offered (${plan.offered.join(', ')})`);

  await manage({ action: 'update', name: 'asker', autonomy: 'L4' });
  const nobody = [];
  await personaTurn('asker', calls(['Write', { file_path: path.join(tmp, 'w4.txt'), content: 'x' }]), {
    autoApprove: false, onPermissionRequest: async (tool) => { nobody.push(tool); return false; },
  });
  assert(nobody.includes('Write') && !fs.existsSync(path.join(tmp, 'w4.txt')), 'an L4 agent in an ask session still asks — a ceiling never raises');
  await manage({ action: 'delete', name: 'asker' });
});

await block('Acceptance: budget stops fire at the configured limits', async () => {
  await manage({ action: 'delete', name: 'budgeted' });
  await manage({ action: 'create', name: 'budgeted', scope: 'user', description: 'Loops on purpose so the phase 3 budget stops can fire',
    instructions: 'Loop.', tools: ['Read'], delegate: 'none', budget: { maxIterations: 3 } });
  const loop = (i) => [{ type: 'tool_call', id: `r${i}`, name: 'Read', input: { file_path: path.join(tmp, 'docs', 'ok.md') } }, { type: 'finish', reason: 'tool_calls' }];
  const it = await personaTurn('budgeted', loop);
  assert(it.provider.toolSchemas.length === 3 && /Paused after 3 steps/.test(it.final), `maxIterations: 3 stops after 3 model requests (${it.provider.toolSchemas.length})`);

  await manage({ action: 'update', name: 'budgeted', budget: { maxUsd: 0.01 } });
  const tracker = T.createTokenTracker();
  const spend = (i) => [{ type: 'usage', inputTokens: 2_000_000, outputTokens: 10 }, ...loop(i)];
  const usd = await personaTurn('budgeted', spend, { tokenTracker: tracker, model: 'deepseek-v4-flash' });
  assert(usd.provider.toolSchemas.length === 1 && /budget reached/.test(usd.final), `maxUsd stops before the next paid request (${usd.provider.toolSchemas.length} requests: ${usd.final.slice(0, 90)})`);

  await manage({ action: 'update', name: 'budgeted', budget: { maxMinutes: 0.005 } });
  const slow = mock(loop, { delayMs: 150 });
  const started = Date.now();
  const mins = await personaTurn('budgeted', null, { provider: slow }).catch(err => ({ final: String(err?.message ?? err) }));
  assert(Date.now() - started < 5_000 && /time budget|cancelled|budget/i.test(mins.final), `maxMinutes stops the run (${String(mins.final).slice(0, 90)})`);
  await manage({ action: 'delete', name: 'budgeted' });
});

await block('Acceptance: talking to an agent and delegating to it resolve identically', async () => {
  const persona = await T.personaFor(FIX, tmp);
  const resolved = await T.resolveAgent(FIX, tmp);
  assert(JSON.stringify(persona.bounds) === JSON.stringify(resolved.bounds), 'personaFor and resolveAgent (Task) carry the same bounds');
  assert(persona.persona.instructions === resolved.instructions, 'and the same instructions');

  const children = [];
  const ctx = T.createContext('phase3');
  let n = 0;
  let parentModel = mock(calls(['Task', { description: 'docs', prompt: 'write docs', agent_name: FIX, acceptance_criteria: ['written'] }]));
  ctx.provide('llm', { resolve: () => (++n === 1 ? parentModel : (children.push(mock(answerOnly())), children.at(-1))), detect: () => 'mock' });
  const session = new T.Session({ id: `phase3-deleg-${++runs}`, cwd: tmp, startedAt: Date.now() });
  await T.runAgent({ task: 'delegate', model: 'mock-model', showPlan: false, autoApprove: true, verbose: false, silent: true,
    conversationHistory: [], sessionId: session.header.id, session, settings: SETTINGS, context: ctx, cwd: tmp });
  const childTools = children[0]?.toolSchemas[0] ?? [];
  const talked = await personaTurn(FIX, answerOnly());
  const sort = (a) => [...a].sort().join(',');
  assert(children.length === 1 && sort(childTools) === sort(talked.offered), `a Task child of ${FIX} is offered what talking to it offers (${sort(childTools)})`);
  await ctx.dispose();
});

await block('Delegate rule: a list names the only agents; readonly children cannot write', async () => {
  await manage({ action: 'delete', name: 'lead' });
  await manage({ action: 'create', name: 'lead', scope: 'user', description: 'Hands documentation work to scoped-writer only, for the suite',
    instructions: 'Lead.', tools: ['Read'], delegate: [FIX], budget: { maxIterations: 10 } });
  const r = await personaTurn('lead', calls(['Task', { description: 'x', prompt: 'do it', agent_name: 'security-reviewer', acceptance_criteria: ['done'] }]));
  assert(r.offered.includes('Task') && r.results.some(x => /may delegate only to: scoped-writer/.test(x)), 'Task to an agent off the list is refused');

  await manage({ action: 'update', name: 'lead', delegate: 'readonly', tools: ['Read', 'Write'] });
  const children = [];
  const ctx = T.createContext('phase3-ro');
  let n = 0;
  const parentModel = mock(calls(['Task', { description: 'x', prompt: 'write', agent_spec: { tools: 'all' }, acceptance_criteria: ['done'] }]));
  ctx.provide('llm', { resolve: () => (++n === 1 ? parentModel : (children.push(mock(answerOnly())), children.at(-1))), detect: () => 'mock' });
  const persona = await T.personaFor('lead', tmp);
  const session = new T.Session({ id: `phase3-ro-${++runs}`, cwd: tmp, startedAt: Date.now() });
  await T.runAgent({ task: 'go', model: 'mock-model', showPlan: false, autoApprove: true, verbose: false, silent: true,
    conversationHistory: [], sessionId: session.header.id, session, settings: SETTINGS, context: ctx, cwd: tmp,
    agentPersona: persona.persona, agentSpecTools: persona.tools, agentBounds: persona.bounds });
  const child = children[0]?.toolSchemas[0] ?? [];
  assert(child.includes('Read') && !child.includes('Write') && !child.includes('Bash'), `delegate: readonly — the child cannot write or run commands (${child.join(', ')})`);
  await ctx.dispose();
  await manage({ action: 'delete', name: 'lead' });
});

await block('Acceptance: a Claude Code agent file imports with bypassPermissions ignored and warned', async () => {
  const dir = path.join(tmp, '.claude', 'agents');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'history-helper.md'), [
    '---', 'name: history-helper',
    'description: Answers questions about git history and blame. Use when asked who changed something.',
    'tools: Read, Grep, NotebookRead', 'permissionMode: bypassPermissions', 'model: inherit',
    '---', 'Answer from the history.', '',
  ].join('\n'));
  fs.mkdirSync(path.join(tmp, '.github', 'agents'), { recursive: true });
  fs.writeFileSync(path.join(tmp, '.github', 'agents', 'planner.agent.md'), [
    '---', 'description: Plans work before it starts. Use for planning a feature.', 'tools: [codebase, search]', '---', 'Plan it.', '',
  ].join('\n'));
  const out = await manage({ action: 'import', path: dir });
  assert(/Imported: history-helper/.test(out), `the Claude file imports (${out.split('\n')[0]})`);
  assert(/bypassPermissions/.test(out) && /never raises/.test(out), 'bypassPermissions is ignored and warned');
  assert(/NotebookRead/.test(out), 'an unknown tool is dropped and named');
  const spec = await T.getAgentSpec('history-helper', tmp);
  assert(!spec.autonomy && spec.tools.join() === 'Read,Grep', 'it carries no raised autonomy and only tools that exist here');
  const copilot = await manage({ action: 'import', path: path.join(tmp, '.github', 'agents') });
  assert(/Skipped: planner/.test(copilot) && /none of its tools exist here/.test(copilot), 'a Copilot agent whose tools all differ is skipped with the reason, not widened');
  await manage({ action: 'delete', name: 'history-helper' });
});

await block('Duplicate and effective', async () => {
  const dup = await manage({ action: 'duplicate', name: 'security-reviewer', newName: 'my-reviewer' });
  assert(/Duplicated "security-reviewer" as "my-reviewer"/.test(dup), 'a built-in can be duplicated as yours');
  const eff = await manage({ action: 'effective', name: 'my-reviewer' });
  assert(/Can, without asking: .*Read/.test(eff) && /Cannot: .*change files.*run shell commands/.test(eff), `effective says what it can and cannot do (${eff.split('\n')[1]})`);
  await manage({ action: 'delete', name: 'my-reviewer' });
});

await manage({ action: 'delete', name: FIX });

console.log(`\nPhase 3 agents: ${passed} passed, ${failed} failed`);
if (failed) { console.log(failures.map(f => `  - ${f}`).join('\n')); process.exit(1); }
process.exit(0);
