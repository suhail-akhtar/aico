/**
 * The managed policy (ADR 0035): an organisation's lock above user and project
 * settings, restrict-only, enforced in code at four seams.
 *
 * Why it exists: AICO is a single-user local engine, so every setting that
 * matters for safety is one edit from off. These blocks assert what must hold
 * once a policy file is in force: precedence (user and project cannot loosen
 * it, and neither can `AICO_POLICY_FILE` loosen the system file), each
 * enforcement point (settings clamp, model/provider, the tool pipeline, MCP /
 * custom-tool creation, the autonomy ceiling, the run gate, the day budget),
 * the invalid-file rules (fail closed per key, lockdown for an unreadable
 * file, unknown keys reported), the routes, and the audit of policy and
 * settings changes. Each refusal asserted here is the case that matters.
 *
 * Offline and free: no model is called; every file is written under this
 * process's own AICO_HOME and temp directories; no system path is touched
 * (the system file is only ever simulated with `readManagedPolicyFrom`).
 */

// A store of this process's own — nothing below may touch ~/.aico. Must stay first.
import './lib/test-home.mjs';
import fs from 'fs';
import os from 'os';
import path from 'path';

for (const k of Object.keys(process.env)) if (/_API_KEY$/.test(k)) delete process.env[k];
fs.writeFileSync(path.join(process.env.AICO_HOME, 'settings.json'), '{}');

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

if (fs.existsSync(T.systemPolicyPath())) {
  console.log(`This machine has a managed policy at ${T.systemPolicyPath()}; this suite needs an unmanaged one. Skipped.`);
  process.exit(0);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aico-policy-'));
const startCwd = process.cwd();
process.on('exit', () => {
  try { process.chdir(startCwd); } catch { /* best effort */ }
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
});

const policyFile = path.join(tmp, 'policy.json');
const messages = [];
const realWarn = console.warn;
console.warn = (...a) => { messages.push(a.join(' ')); };

/** Write a policy (object → JSON, string → verbatim) and make the engine re-read it. */
function setPolicy(policy) {
  if (policy === null) { try { fs.unlinkSync(policyFile); } catch { /* none */ } }
  else fs.writeFileSync(policyFile, typeof policy === 'string' ? policy : JSON.stringify(policy));
  process.env.AICO_POLICY_FILE = policyFile;
  T.resetManagedPolicyCache();
}
const route = (model, over = {}) => ({ model, providerType: 'anthropic', local: false, ...over });

// ═════════════════════════════════════════════════════════════════════

await block('validation: invalid values take their most restrictive form, unknown keys are reported', async () => {
  const { policy, problems } = T.validatePolicy({
    version: 1, message: 'Ask IT', contact: 'it@corp.example',
    maxAutonomyLevel: 'L9', allowedModels: 'claude-*', deniedTools: 7, localOnly: 'yes',
    budget: { perSessionUsd: -3, perDayUsd: 'lots', surprise: 1 },
    mcp: { mode: 'sometimes' }, network: { mode: 'allow-list', domains: 'example.com' },
    minAicoVersion: 'new', requiredGates: ['checks', 'teleport'], telemetry: 'on',
    futureThing: { x: 1 },
  });
  assert(policy.maxAutonomyLevel === 'L0', 'a bad autonomy level becomes L0');
  assert(Array.isArray(policy.allowedModels) && policy.allowedModels.length === 0, 'a bad allow-list allows nothing');
  assert(policy.deniedTools?.[0] === '*', 'a bad deny-list denies everything');
  assert(policy.localOnly === true, 'a bad boolean restriction becomes true');
  assert(policy.budget?.perSessionUsd === 0.01 && policy.budget?.perDayUsd === 0.01, 'bad budgets become $0.01');
  assert(policy.mcp?.mode === 'forbid', 'a bad extension mode becomes forbid');
  assert(policy.network?.mode === 'allow-list' && policy.network.domains.length === 0, 'bad network domains become an empty allow-list');
  assert(policy.minAicoVersion === '999.999.999', 'a bad minimum version means no version is new enough');
  assert(policy.telemetry === 'off', 'telemetry only ever means off');
  assert(policy.requiredGates?.length === 1 && policy.requiredGates[0] === 'checks', 'unknown gates are dropped');
  const keys = problems.map(p => p.key);
  assert(keys.includes('futureThing') && keys.includes('budget.surprise'), 'unknown keys are reported, not silently accepted');
  assert(problems.some(p => p.level === 'error' && p.key === 'maxAutonomyLevel'), 'each invalid value is named as an error');
  assert(policy.message === 'Ask IT' && policy.contact === 'it@corp.example', 'message and contact are kept');
});

await block('invalid files: unreadable or non-JSON is a lockdown, never "no policy"', async () => {
  setPolicy('{ not json');
  let lp = T.managedPolicy();
  assert(lp.active && lp.lockdown, 'broken JSON locks the engine down');
  assert(lp.problems.some(p => p.level === 'error' && /not valid JSON/.test(p.message)), 'the problem says what is wrong');
  assert(!T.modelDecision(route('claude-sonnet-5'), lp).ok, 'no model call is allowed in lockdown');
  assert(!T.toolDecision('Read', lp).ok, 'no tool call is allowed in lockdown');
  assert(T.runRefusal('0.47.0', lp)?.includes('locked down'), 'a run is refused in the policy\'s own words');
  setPolicy('[1,2]');
  lp = T.managedPolicy();
  assert(lp.lockdown, 'a JSON array is not a policy: lockdown');
  setPolicy({ version: 2, maxAutonomyLevel: 'L1' });
  lp = T.managedPolicy();
  assert(!lp.lockdown && lp.problems.some(p => p.key === 'version'), 'a newer version warns and known keys still apply');
  assert(T.policyCeiling(lp) === 'L1', 'the known key applied');
  setPolicy(null);
  lp = T.managedPolicy();
  assert(!lp.active && !lp.lockdown, 'no file means not managed');
  process.env.AICO_POLICY_FILE = path.join(tmp, 'does-not-exist.json');
  T.resetManagedPolicyCache();
  lp = T.managedPolicy();
  assert(!lp.active && lp.problems.some(p => /does not exist/.test(p.message)), 'a missing override is reported and changes nothing');
});

await block('layers: AICO_POLICY_FILE can only add restrictions to the system file', async () => {
  const sys = path.join(tmp, 'system-policy.json');
  fs.writeFileSync(sys, JSON.stringify({ allowedProviders: ['anthropic'], deniedTools: ['Bash'], maxAutonomyLevel: 'L2', budget: { perDayUsd: 10 } }));
  fs.writeFileSync(policyFile, JSON.stringify({ allowedProviders: ['openai', 'anthropic'], maxAutonomyLevel: 'L4', deniedTools: [], mcp: { mode: 'any' }, budget: { perDayUsd: 1000 } }));
  const lp = T.readManagedPolicyFrom([[sys, 'system'], [policyFile, 'override']]);
  assert(lp.layers.length === 2, 'both files are layers');
  assert(T.modelDecision(route('gpt-4o', { providerType: 'openai' }), lp).ok === false, 'the override cannot admit a provider the system file does not');
  assert(T.modelDecision(route('claude-sonnet-5'), lp).ok === true, 'a provider both admit is admitted');
  assert(!T.toolDecision('Bash', lp).ok, 'the system file\'s denied tool stays denied');
  assert(T.policyCeiling(lp) === 'L2', 'the lower autonomy ceiling wins');
  assert(T.dayBudgetCap(lp) === 10, 'the smaller day cap wins');
  const stricter = path.join(tmp, 'stricter.json');
  fs.writeFileSync(stricter, JSON.stringify({ deniedTools: ['WebFetch'], maxAutonomyLevel: 'L0' }));
  const both = T.readManagedPolicyFrom([[sys, 'system'], [stricter, 'override']]);
  assert(!T.toolDecision('WebFetch', both).ok && !T.toolDecision('Bash', both).ok, 'an override adds to the denials');
  assert(T.policyCeiling(both) === 'L0', 'an override can lower the ceiling');
});

await block('precedence: managed policy beats user and project settings, which cannot loosen it', async () => {
  const project = fs.mkdtempSync(path.join(tmp, 'proj-'));
  fs.mkdirSync(path.join(project, '.aico'), { recursive: true });
  // The person's own settings loosen everything the policy will lock.
  fs.writeFileSync(path.join(process.env.AICO_HOME, 'settings.json'), JSON.stringify({
    autoApprove: true, disabledTools: ['Pwd'],
    safetyLimits: { maxCostPerSession: 100 },
    sentinel: { mode: 'off', onEscalate: 'proceed' },
    completionGate: { enabled: false, security: false },
    models: { localOnlyPersonal: false },
    mcpServers: { github: { command: 'node', args: ['x.js'] }, evil: { command: 'node', args: ['y.js'] } },
  }));
  // The project tries the same; the project policy already drops the loosening ones.
  fs.writeFileSync(path.join(project, '.aico', 'settings.json'), JSON.stringify({
    safetyLimits: { maxCostPerSession: 500 }, completionGate: { enabled: false }, sentinel: { mode: 'off' }, autoApprove: true,
  }));
  process.chdir(project);

  setPolicy(null);
  delete process.env.AICO_POLICY_FILE;
  T.resetManagedPolicyCache();
  const control = await T.loadSettings();
  assert(control.autoApprove === true && control.sentinel?.mode === 'off', 'control: without a policy the user\'s loosened values stand');

  setPolicy({
    maxAutonomyLevel: 'L2', requiredGates: ['checks', 'security'], budget: { perSessionUsd: 5 }, sentinelRequired: true,
    deniedTools: ['WebSearch', 'mcp__evil__*'], localOnly: true, mcp: { mode: 'allow-list', allow: ['github'] },
  });
  messages.length = 0;
  const merged = await T.loadSettings();
  assert(merged.autoApprove === false, 'auto-approve is off under an L2 ceiling');
  assert(merged.safetyLimits?.maxCostPerSession === 5, 'the user\'s $100 ceiling is clamped to the policy\'s $5');
  assert(merged.sentinel?.mode === 'auto' && merged.sentinel?.onEscalate === 'ask', 'the safety reviewer is back on and a person decides escalations');
  assert(merged.completionGate?.enabled === true && merged.completionGate?.security === true, 'required gates cannot be disabled');
  assert(merged.models?.localOnlyPersonal === true, 'localOnly forces data to stay local');
  assert(merged.disabledTools?.includes('WebSearch') && merged.disabledTools?.includes('Pwd'), 'denied tools are added to the user\'s own list');
  assert(!merged.disabledTools?.includes('mcp__evil__*'), 'a pattern is not written into disabledTools (the guard and the tool list apply it)');
  assert(merged.mcpServers && 'github' in merged.mcpServers && !('evil' in merged.mcpServers), 'an MCP server off the allow-list is dropped at load');
  assert(messages.some(m => /organisation's AICO policy applies/.test(m)), 'the clamp is said out loud once');

  // A stricter user value is left alone: the policy only ever tightens.
  fs.writeFileSync(path.join(process.env.AICO_HOME, 'settings.json'), JSON.stringify({ safetyLimits: { maxCostPerSession: 2 } }));
  const strict = await T.loadSettings();
  assert(strict.safetyLimits?.maxCostPerSession === 2, 'a user cap below the policy\'s stays');

  // The project layer cannot loosen either (it could not before; the policy is applied after it).
  fs.writeFileSync(path.join(project, '.aico', 'settings.local.json'), JSON.stringify({ safetyLimits: { maxCostPerSession: 1 }, completionGate: { enabled: false } }));
  const withLocal = await T.loadSettings();
  assert(withLocal.safetyLimits?.maxCostPerSession === 1 && withLocal.completionGate?.enabled !== false, 'a project may tighten; it cannot switch a required gate off');
  process.chdir(startCwd);
});

await block('model and provider: a disallowed provider fails with the policy\'s words', async () => {
  process.env.ANTHROPIC_API_KEY = 'test-anthropic-key';
  process.env.OPENAI_API_KEY = 'test-openai-key';
  setPolicy({ allowedProviders: ['anthropic', 'ollama'], deniedModels: ['*opus*'], message: 'Use approved models only.', contact: 'ai-help@corp.example' });
  let caught;
  try { T.selectProvider('gpt-4o', {}); } catch (e) { caught = e; }
  assert(caught instanceof T.PolicyError && caught.rule === 'allowedProviders', 'OpenAI is refused with a PolicyError naming the rule');
  assert(/organisation/.test(caught?.message) && /Use approved models only/.test(caught?.message) && /ai-help@corp\.example/.test(caught?.message), 'the message names the policy, the text and the contact');
  caught = undefined;
  try { T.selectProvider('claude-opus-5', {}); } catch (e) { caught = e; }
  assert(caught?.rule === 'deniedModels', 'a denied model glob refuses');
  assert(T.selectProvider('claude-sonnet-5', {}).id === 'anthropic', 'an allowed provider and model work');
  caught = undefined;
  try { T.selectProvider('anthropic/claude-opus-5', { provider: 'ollama' }); } catch (e) { caught = e; }
  assert(caught?.rule === 'deniedModels', 'a routed id is tested with its vendor prefix removed too');

  setPolicy({ localOnly: true });
  caught = undefined;
  try { T.selectProvider('claude-sonnet-5', {}); } catch (e) { caught = e; }
  assert(caught?.rule === 'localOnly', 'localOnly refuses a cloud provider');
  assert(T.selectProvider('llama3.1', { provider: 'ollama' }).id === 'ollama', 'localOnly admits local Ollama');
  caught = undefined;
  try { T.selectProvider('llama3.1', { provider: 'ollama', providers: { ollama: { baseUrl: 'http://gpu-box.corp.example:11434/v1' } } }); } catch (e) { caught = e; }
  assert(caught?.rule === 'localOnly', 'an Ollama on another host is not local');
  caught = undefined;
  try { T.selectProvider('gpt-oss:120b-cloud', { provider: 'ollama' }); } catch (e) { caught = e; }
  assert(caught?.rule === 'localOnly', 'an Ollama -cloud model is not local');
  assert(!T.providerDecision('openai').ok && T.providerDecision('ollama').ok, 'provider-level check for "test connection"');

  setPolicy('{ broken');
  caught = undefined;
  try { T.selectProvider('claude-sonnet-5', {}); } catch (e) { caught = e; }
  assert(caught?.rule === 'policy-file-unreadable', 'lockdown refuses every model');
  setPolicy(null);
  assert(T.selectProvider('gpt-4o', {}).id === 'openai', 'control: no policy, no refusal');
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.OPENAI_API_KEY;
});

await block('gates that own their own switch (ADR 0033) cannot be switched off', async () => {
  setPolicy({ requiredGates: ['supply-chain', 'change-scan'] });
  const mine = { supplyChain: { packageCheck: false, minAgeDays: 7 }, completionGate: { enabled: false, changeSafety: false } };
  const notes = T.applyManagedPolicy(mine, T.managedPolicy());
  assert(mine.supplyChain.packageCheck === true && mine.supplyChain.minAgeDays === 7, 'the package check is back on and its other settings are untouched');
  assert(mine.completionGate.changeSafety === true && mine.completionGate.enabled === true, 'the change-safety review is back on, and so is the gate it runs in');
  assert(notes.length >= 2, 'each change is reported');
  const paths = T.lockedSettings(T.managedPolicy()).map(l => l.path);
  assert(paths.includes('supplyChain.packageCheck') && paths.includes('completionGate.changeSafety'), 'both are listed as locked for the screen');
  const loose = { supplyChain: { packageCheck: true } };
  assert(T.applyManagedPolicy(loose, T.managedPolicy()).length === 0, 'a value already compliant is not touched');
  setPolicy(null);
});

await block('model roles: a model the policy does not allow is not chosen for a job, and the reason says why', async () => {
  const settings = { providers: { anthropic: { apiKey: 'test-key' } }, providerInstances: [{ id: 'anthropic', type: 'anthropic', name: 'Anthropic', apiKey: 'test-key' }] };
  setPolicy(null);
  const free = T.resolveRole('background', { settings, mainModel: 'claude-sonnet-5', env: {} });
  assert(free.ok && free.model !== 'claude-sonnet-5', 'control: background work runs on the cheaper sibling');
  setPolicy({ deniedModels: [free.model], contact: 'ai-help@corp.example' });
  const blocked = T.resolveRole('background', { settings, mainModel: 'claude-sonnet-5', env: {} });
  assert(!(blocked.ok && blocked.model === free.model), 'the denied model is not chosen');
  assert(/organisation/.test(blocked.fellBack ?? '') && /deniedModels/.test(blocked.fellBack ?? ''), 'and the role says which rule skipped it');
  const main = T.resolveRole('main', { settings, mainModel: free.model, env: {} });
  assert(!main.ok && /deniedModels/.test(main.fellBack ?? ''), 'a denied main model is not usable, with the reason');
  setPolicy(null);
});

await block('tool pipeline: the managed-policy guard denies, abstains otherwise, and runs before permission', async () => {
  setPolicy({
    deniedTools: ['WebSearch', 'mcp__github__delete*'],
    network: { mode: 'allow-list', domains: ['example.com', '*.docs.corp.example'] },
    plugins: { mode: 'forbid' },
  });
  const pipeline = new T.ToolPipeline();
  const ran = [];
  pipeline.onGuard('managed-policy', T.createPolicyGuard());
  pipeline.onGuard('permission', () => { ran.push('permission'); return { kind: 'abstain' }; });
  const call = (name, args = {}) => pipeline.execute(
    { callId: `c-${name}`, name, arguments: args, agentId: 'a', state: new Map() },
    async () => { ran.push(`body:${name}`); return { ok: true }; },
  );
  let r = await call('WebSearch', { query: 'x' });
  assert(r.denied && r.deniedBy === 'managed-policy' && /organisation/.test(r.denialReason), 'a denied tool is refused, by name, naming the policy');
  assert(!ran.includes('permission') && !ran.includes('body:WebSearch'), 'a person is never asked, and the body never runs');
  r = await call('mcp__github__delete_repo', {});
  assert(r.denied && r.deniedBy === 'managed-policy', 'an MCP tool pattern is refused');
  r = await call('Read', { file_path: 'a.txt' });
  assert(!r.denied && ran.includes('body:Read'), 'an unrelated tool passes');
  r = await call('WebFetch', { url: 'https://evil.test/x' });
  assert(r.denied && /evil\.test/.test(r.denialReason), 'a URL off the allow-list is refused');
  r = await call('WebFetch', { url: 'https://example.com/docs' });
  assert(!r.denied, 'an allowed domain passes');
  r = await call('WebFetch', { url: 'https://a.docs.corp.example/x' });
  assert(!r.denied, 'a wildcard subdomain passes');
  r = await call('WebFetch', { url: 'https://notexample.com/' });
  assert(r.denied, 'a lookalike domain is refused (suffix needs a dot boundary)');
  r = await call('WebFetch', { url: 'http://localhost:3000/health' });
  assert(!r.denied, 'a local dev server is reachable by default');
  r = await call('SomeMcpTool', { options: { endpoint: 'https://evil.test/hook' } });
  assert(r.denied, 'a URL nested in the arguments is found');
  r = await call('Bash', { command: 'echo hi' });
  assert(!r.denied, 'Bash is not parsed for URLs (stated limit)');
  r = await call('ide_plugin_save', { id: 'cool-plugin' });
  assert(r.denied, 'the agent\'s plugin tools follow the plugins rule');

  setPolicy({ network: { mode: 'deny-list', domains: ['evil.test'] } });
  r = await call('WebFetch', { url: 'https://sub.evil.test/' });
  assert(r.denied, 'a deny-list domain covers subdomains');
  r = await call('WebFetch', { url: 'https://example.com/' });
  assert(!r.denied, 'a deny-list lets everything else through');

  setPolicy({ network: { mode: 'allow-list', domains: ['example.com'], allowLoopback: false } });
  r = await call('WebFetch', { url: 'http://127.0.0.1:8080/' });
  assert(r.denied, 'loopback can be switched off');

  setPolicy('{ broken');
  r = await call('Read', {});
  assert(r.denied, 'lockdown denies every tool');
  setPolicy(null);
  r = await call('WebSearch', {});
  assert(!r.denied, 'control: no policy, the guard abstains');
});

await block('the tool list: a denied tool (pattern included) is not offered at all', async () => {
  setPolicy({ deniedTools: ['Web*'] });
  const names = T.buildToolDefs({ settings: {} }).map(d => d.name);
  assert(!names.includes('WebFetch') && !names.includes('WebSearch'), 'WebFetch and WebSearch are not in the schema');
  assert(names.includes('Read'), 'other tools are');
  setPolicy(null);
  const all = T.buildToolDefs({ settings: {} }).map(d => d.name);
  assert(all.includes('WebFetch'), 'control: offered without a policy');
});

await block('autonomy ceiling, run gate and the day budget', async () => {
  setPolicy({ maxAutonomyLevel: 'L2' });
  assert(T.withPolicyCeiling(undefined) === 'L2', 'a run with no ceiling gets the policy\'s');
  assert(T.withPolicyCeiling('L1') === 'L1', 'a lower agent ceiling stays');
  assert(T.withPolicyCeiling('L4') === 'L2', 'a higher agent ceiling is lowered');
  assert(T.withPolicyCeiling('banana') === 'L2', 'an unparseable ceiling is replaced');
  const opts = { task: 't', autoApprove: true };
  const lowered = T.applyAutonomyCeiling(opts, { ceiling: T.withPolicyCeiling(undefined), isRead: () => false, tty: true });
  assert(lowered.autoApprove === false, 'auto-approve is switched off under the ceiling (the existing mechanism)');

  assert(T.forbidsFullAutonomy() === true, 'an L2 ceiling rules out "full autonomy" (the safety reviewer proceeding unasked)');
  setPolicy({ sentinelRequired: true });
  assert(T.forbidsFullAutonomy() === true, 'so does a required safety reviewer');
  setPolicy({ maxAutonomyLevel: 'L4' });
  assert(T.forbidsFullAutonomy() === false, 'a ceiling that allows L3 and no reviewer requirement leaves it alone');

  setPolicy({ minAicoVersion: '99.0.0' });
  assert(/requires AICO 99\.0\.0/.test(T.runRefusal('0.46.0') ?? ''), 'an older engine is refused with the required version');
  assert(T.runRefusal('99.1.0') === undefined, 'a newer one runs');
  assert(T.runRefusal('unknown') !== undefined, 'an unknowable version fails closed');

  setPolicy({ budget: { perDayUsd: 3 } });
  assert(T.dayBudgetRefusal(1) === undefined, 'under the day cap runs');
  assert(/daily cap/.test(T.dayBudgetRefusal(3.5) ?? ''), 'over the day cap is refused in words');

  setPolicy('{ broken');
  let threw;
  try { await T.runAgent({ task: 'hello', model: 'claude-sonnet-5', autoApprove: false, verbose: false, conversationHistory: [] }); } catch (e) { threw = e; }
  assert(threw instanceof T.PolicyError && threw.rule === 'run-gate', 'runAgent refuses to start under lockdown');
  setPolicy(null);
});

await block('gates, telemetry and extension points', async () => {
  setPolicy({ requiredGates: ['supply-chain', 'verification'], telemetry: 'off', customTools: { mode: 'forbid' }, mcp: { mode: 'forbid' } });
  assert(T.isGateRequired('supply-chain') && T.isGateRequired('verification') && !T.isGateRequired('commit'), 'gate requirements are queryable by gate');
  assert(T.telemetryOff(), 'telemetry off is queryable (the update check reads it)');
  let threw;
  try { await T.addMcpServer({ name: 'x', command: 'node', args: ['s.js'] }); } catch (e) { threw = e; }
  assert(threw instanceof T.PolicyError && threw.rule === 'mcp.forbid', 'adding an MCP server is refused before anything is written');
  const out = await T.executeToolManage({ action: 'create', pack: 'ops', definition: { name: 'mytool' } }, { human: true });
  assert(/^Not written: .*organisation/.test(out), 'creating a custom tool is refused in the policy\'s words');
  setPolicy({ mcp: { mode: 'allow-list', allow: ['github', 'corp-*'] } });
  assert(T.extensionDecision('mcp', 'github').ok && T.extensionDecision('mcp', 'corp-wiki').ok && !T.extensionDecision('mcp', 'random').ok, 'an allow-list admits named servers and globs');
  setPolicy(null);
  assert(!T.telemetryOff() && T.extensionDecision('mcp', 'anything').ok, 'control: no policy, no restriction');
});

await block('host matching', async () => {
  assert(T.policyHostMatches('example.com', 'example.com') && T.policyHostMatches('example.com', 'a.b.example.com'), 'a bare domain covers itself and its subdomains');
  assert(!T.policyHostMatches('*.example.com', 'example.com') && T.policyHostMatches('*.example.com', 'x.example.com'), '*.domain is subdomains only');
  assert(!T.policyHostMatches('example.com', 'badexample.com'), 'no match across a missing dot');
  assert(T.policyHostMatches('Example.COM', 'EXAMPLE.com.'), 'case and a trailing dot do not matter');
});

await block('the route: what is locked, no secrets, and write refusal', async () => {
  setPolicy({ maxAutonomyLevel: 'L1', budget: { perSessionUsd: 4 }, requiredGates: ['checks'], sentinelRequired: true, message: 'Managed.', contact: 'it@corp.example' });
  const res = await T.handlePolicyRoute('policy', 'GET', {}, async () => ({ ok: false }));
  assert(res.status === 200 && res.body.managed === true, 'GET policy says the machine is managed');
  const paths = res.body.locked.map(l => l.path);
  assert(['autoApprove', 'completionGate.enabled', 'safetyLimits.maxCostPerSession', 'sentinel.mode'].every(p => paths.includes(p)), 'the locked paths a client binds controls to are listed');
  assert(res.body.contact === 'it@corp.example' && res.body.rules.length > 0, 'contact and plain-English rules are included');
  assert(res.body.sources.every(s => s.weakness), 'a file the user can write is reported as not a lock');
  const wire = JSON.stringify(res.body);
  assert(!/api[_-]?key|secret|password/i.test(wire.replace(/"secret[^"]*"/g, '')), 'nothing secret-shaped is exposed');
  assert((await T.handlePolicyRoute('policy', 'POST', {}, async () => ({ ok: true }))).status === 405, 'policy is read-only');
  assert(T.lockedWriteRefusal({ autoApprove: true }) !== undefined, 'a write to a fixed value is refused by name');
  assert(T.lockedWriteRefusal({ autoApprove: false }) === undefined, 'writing the fixed value itself is fine');
  assert(T.lockedWriteRefusal({ safetyLimits: { maxCostPerSession: 50 } }) !== undefined, 'raising a bounded value is refused');
  assert(T.lockedWriteRefusal({ safetyLimits: { maxCostPerSession: 3 } }) === undefined, 'lowering it is fine');
  assert(T.lockedWriteRefusal({ theme: 'dark' }) === undefined, 'unrelated settings are untouched');
  const noPerson = await T.handlePolicyRoute('audit/export', 'POST', {}, async () => ({ ok: false, reason: 'no person' }));
  assert(noPerson.status === 403 && noPerson.body.code === 'human-required', 'the audit export needs a person');
  const person = await T.handlePolicyRoute('audit/export', 'POST', { format: 'jsonl' }, async () => ({ ok: true }));
  assert(person.status === 200 && person.body.schema === 'aico.audit/1', 'with a person it returns the stream');
  assert((await T.handlePolicyRoute('audit/export', 'POST', { format: 'xml' }, async () => ({ ok: true }))).status === 400, 'an unknown format is refused');
  assert((await T.handlePolicyRoute('something/else', 'GET', {}, async () => ({ ok: true }))) === undefined, 'a route that is not its own is left alone');
  setPolicy(null);
  assert((await T.handlePolicyRoute('policy', 'GET', {}, async () => ({ ok: false }))).body.managed === false, 'control: unmanaged');
});

await block('the policy and settings changes are audited, without values', async () => {
  T.resetAuditLogMemory();
  const before = T.readOwnAuditEvents().length;
  setPolicy({ maxAutonomyLevel: 'L3' });
  T.recordPolicyLoad(T.managedPolicy());
  T.recordPolicyLoad(T.managedPolicy());
  setPolicy(null);
  T.recordPolicyLoad(T.managedPolicy());
  const events = T.readOwnAuditEvents().slice(before).filter(e => e.kind === 'policy.load');
  assert(events.length === 2, 'a policy appearing and disappearing are each recorded once');
  assert(events[0].active === true && events[1].active === false, 'removal is recorded as removal');
  await T.saveUserSetting('theme', 'dark');
  await T.saveUserSetting('providers', { openai: { apiKey: 'canary-not-recorded-0001' } }); // standards-allow: secret
  const changes = T.readOwnAuditEvents().filter(e => e.kind === 'settings.change');
  assert(changes.some(c => c.key === 'theme' && c.valueHash && c.action === 'set'), 'a settings write records the key and a hash');
  const providersChange = changes.find(c => c.key === 'providers');
  assert(providersChange && !providersChange.valueHash, 'a credential root records the key only');
  assert(!JSON.stringify(T.readOwnAuditEvents()).includes('canary-not-recorded'), 'no value is ever recorded');
});

// ═════════════════════════════════════════════════════════════════════

console.warn = realWarn;
console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { for (const f of failures) console.log(`  ✗ ${f}`); process.exit(1); }
process.exit(0);
