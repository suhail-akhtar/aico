/**
 * Model roles (ADR 0017, src/models/roles.ts, src/models/vision.ts), offline.
 *
 * Why it exists: the resolver is where a person's data and a safety reviewer
 * are routed, and its rules are the kind that break quietly — a legacy key
 * stops counting, a preset changes today's defaults, a personal role falls
 * through to the work model's cloud vendor, a cloned repository picks the
 * Sentinel. Each of those is asserted here, plus the vision fallback with a
 * stub provider (described once, cached, costed, and the plain note when it
 * fails), the sub-agent role mapping, the image backend choice, and the
 * settings API's shape.
 *
 * Offline and free: no provider is ever called; every key below is a fake
 * one-letter string, and every provider environment variable is cleared so
 * the developer's own keys cannot change an answer.
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

const ANT = { id: 'anthropic', type: 'anthropic', name: 'Anthropic', apiKey: 'k' };
const DS = { id: 'deepseek', type: 'deepseek', name: 'DeepSeek', apiKey: 'k' };
const OAI = { id: 'openai', type: 'openai', name: 'OpenAI', apiKey: 'k' };
const GEM = { id: 'gemini', type: 'gemini', name: 'Gemini', apiKey: 'k' };
const OLL = { id: 'ollama', type: 'ollama', name: 'Ollama', models: ['llama3.2', 'nomic-embed-text'] };
const ENV = {};
const r = (role, settings, mainModel, extra = {}) => T.resolveRole(role, { settings, mainModel, env: ENV, ...extra });

await block('One order: override, models.roles, legacy key, preset', async () => {
  const base = { providerInstances: [ANT, DS] };
  const s = { ...base, models: { roles: { background: 'claude-sonnet-4-5' } }, sessionTitles: { model: 'claude-haiku-4-5' } };
  const o = r('background', s, 'claude-opus-5', { override: 'deepseek-v4-flash' });
  assert(o.ok && o.model === 'deepseek-v4-flash' && o.source === 'override', `a per-call override wins (${o.model}, ${o.source})`);
  const role = r('background', s, 'claude-opus-5');
  assert(role.model === 'claude-sonnet-4-5' && role.source === 'role', `then models.roles (${role.model}, ${role.source})`);
  const legacy = r('background', { ...base, sessionTitles: { model: 'claude-haiku-4-5' } }, 'claude-opus-5');
  assert(legacy.model === 'claude-haiku-4-5' && legacy.source === 'legacy', `then the legacy key (${legacy.model}, ${legacy.source})`);
  const preset = r('background', base, 'claude-opus-5');
  assert(preset.model === 'claude-haiku-4-5' && preset.source === 'preset', `then the preset: the family's cheap model (${preset.model}, ${preset.source})`);
  assert(preset.instanceId === 'anthropic' && preset.providerType === 'anthropic' && preset.local === false, 'and says where it is served');
  const blank = r('background', { ...base, models: { roles: { background: '  ' } } }, 'claude-opus-5');
  assert(blank.source === 'preset', 'an empty role entry means "use the preset"');
});

await block('Legacy keys keep working, each for its own feature', async () => {
  const s = { providerInstances: [ANT], sessionTitles: { model: 'claude-sonnet-4-5' }, learning: { model: 'claude-haiku-4-5' }, brief: { model: 'claude-opus-5' } };
  assert(r('background', s, 'claude-opus-5', { feature: 'titles' }).model === 'claude-sonnet-4-5', 'titles read sessionTitles.model');
  assert(r('background', s, 'claude-opus-5', { feature: 'learning' }).model === 'claude-haiku-4-5', 'learning reads learning.model');
  assert(r('background', s, 'claude-opus-5', { feature: 'brief' }).model === 'claude-opus-5', 'the brief reads brief.model');
  const onlyLearning = { providerInstances: [ANT], learning: { model: 'claude-sonnet-4-5' } };
  assert(r('background', onlyLearning, 'claude-opus-5', { feature: 'titles' }).model === 'claude-haiku-4-5',
    'a learning.model does not rename sessions (titles keep the preset)');
  assert(r('background', s, 'claude-opus-5').model === 'claude-sonnet-4-5', 'the settings page (no feature) shows titles first');
  assert(T.pickNamingModel({ providerInstances: [ANT] }, 'claude-opus-5') === 'claude-haiku-4-5', 'pickNamingModel goes through the role: Opus is named by Haiku');
  assert(T.pickNamingModel({ providerInstances: [ANT], sessionTitles: { model: 'claude-sonnet-4-5' } }, 'claude-opus-5') === 'claude-sonnet-4-5', 'and sessionTitles.model still names');
  assert(T.distillModel({ providerInstances: [ANT], learning: { model: 'claude-sonnet-4-5' } }, 'claude-opus-5') === 'claude-sonnet-4-5', 'distilling reads learning.model');
  const sentinel = r('sentinel', { providerInstances: [ANT, DS], sentinel: { model: 'claude-haiku-4-5' } }, 'claude-opus-5');
  assert(sentinel.model === 'claude-haiku-4-5' && sentinel.source === 'legacy', 'sentinel.model is the Sentinel\'s legacy key');
  const explore = r('explore', { providerInstances: [ANT], agentModels: { explore: 'claude-haiku-4-5', default: 'claude-sonnet-4-5' } }, 'claude-opus-5', { agentType: 'explore' });
  assert(explore.model === 'claude-haiku-4-5' && explore.source === 'legacy', 'agentModels[type] counts for its sub-agent role');
  const fallbackDefault = r('coding', { providerInstances: [ANT], agentModels: { default: 'claude-sonnet-4-5' } }, 'claude-opus-5', { agentType: 'general' });
  assert(fallbackDefault.model === 'claude-sonnet-4-5', 'and agentModels.default for any type');
});

await block('Presets change roles, and balanced is today\'s behaviour', async () => {
  const s = (preset) => ({ providerInstances: [ANT], ...(preset ? { models: { preset } } : {}) });
  for (const [preset, label] of [[undefined, 'no preset'], ['balanced', 'balanced']]) {
    assert(r('explore', s(preset), 'claude-opus-5').model === 'claude-opus-5' && r('review', s(preset), 'claude-opus-5').model === 'claude-opus-5',
      `${label}: explore and review run on the main model, as sub-agents always did`);
    assert(r('coding', s(preset), 'claude-opus-5').model === 'claude-opus-5' && r('compact', s(preset), 'claude-opus-5').model === 'claude-opus-5',
      `${label}: coding and summaries on the main model`);
    assert(r('background', s(preset), 'claude-opus-5').model === 'claude-haiku-4-5', `${label}: background on the cheap model`);
  }
  assert(r('explore', s('economy'), 'claude-opus-5').model === 'claude-haiku-4-5' && r('review', s('economy'), 'claude-opus-5').model === 'claude-haiku-4-5',
    'economy: explore and review go to the family\'s cheap model');
  assert(r('coding', s('economy'), 'claude-opus-5').model === 'claude-opus-5', 'economy never moves the coding role');
  assert(r('background', s('quality'), 'claude-opus-5').model === 'claude-opus-5', 'quality: the main model everywhere, background included');
  const priv = r('background', s('private'), 'claude-opus-5');
  assert(!priv.ok && priv.model === '', 'private: a personal role with no local model is not usable');
});

await block('A capability mismatch falls back with a reason, never silently', async () => {
  const v = r('vision', { providerInstances: [ANT, DS], models: { roles: { vision: 'deepseek-v4-pro' } } }, 'claude-opus-5');
  assert(v.ok && v.model === 'claude-opus-5' && /does not accept images/.test(v.fellBack ?? ''),
    `a text-only vision choice is skipped for the main model, and says why (${v.fellBack})`);
  const none = r('vision', { providerInstances: [DS], models: { roles: { vision: 'deepseek-v4-pro' } } }, 'deepseek-v4-pro');
  assert(!none.ok && /does not accept images/.test(none.fellBack ?? ''), 'with a text-only main model there is nothing to fall back to: not usable, with the reason');
  const off = r('vision', { providerInstances: [DS] }, 'deepseek-v4-pro');
  assert(!off.ok && off.source === 'off' && !off.fellBack, 'an unset optional role is simply off (no warning)');
  const embed = r('embed', { providerInstances: [OAI], models: { roles: { embed: 'gpt-4o' } } }, 'gpt-5');
  assert(!embed.ok && /not an embedding model/.test(embed.fellBack ?? ''), 'a chat model is not an embedder');
  const okEmbed = r('embed', { providerInstances: [OLL], models: { roles: { embed: 'nomic-embed-text' } } }, 'llama3.2');
  assert(okEmbed.ok && okEmbed.local, 'a local embedding model is usable and local');
});

await block('Personal data never falls back to a cloud provider', async () => {
  const s = { providerInstances: [ANT, OLL], models: { localOnlyPersonal: true } };
  const bg = r('background', s, 'claude-opus-5');
  assert(!bg.ok && bg.model === '' && !bg.local && /stay on this machine/.test(bg.fellBack ?? ''), `kept local with only a cloud choice: not usable, reason given (${bg.fellBack})`);
  const set = r('background', { ...s, models: { localOnlyPersonal: true, roles: { background: 'claude-haiku-4-5' } } }, 'claude-opus-5');
  assert(!set.ok && set.model === '', 'an explicit cloud model for a personal role is refused, not substituted');
  const local = r('background', { ...s, models: { localOnlyPersonal: true, roles: { background: 'llama3.2' } } }, 'claude-opus-5');
  assert(local.ok && local.model === 'llama3.2' && local.local && local.instanceId === 'ollama', 'a local model serves it');
  assert(T.backgroundModel(s, 'claude-opus-5', 'titles') === undefined && T.pickNamingModel(s, 'claude-opus-5') === '', 'titles get no model: the session keeps its fallback name');
  assert(T.distillModel(s, 'claude-opus-5') === undefined, 'distilling gets no model: the signals wait');
  const work = r('explore', s, 'claude-opus-5');
  assert(work.ok && work.model === 'claude-opus-5', 'non-personal roles are unaffected by the switch');
  const loopback = { providerInstances: [{ id: 'lm', type: 'openai-compatible', name: 'LM Studio', baseUrl: 'http://127.0.0.1:1234/v1', apiKey: 'k', models: ['qwen-local'] }], models: { localOnlyPersonal: true, roles: { background: 'qwen-local' } } };
  const lb = r('background', loopback, 'qwen-local');
  assert(lb.ok && lb.local, 'a loopback endpoint counts as this machine');
});

await block('Only the person\'s own settings choose models', async () => {
  const layer = { models: { preset: 'quality' }, learning: { model: 'x', preferences: false }, sessionTitles: { model: 'y', enabled: true }, brief: { model: 'z' }, agentModels: { explore: 'm' } };
  const dropped = T.dropProjectModelChoices(layer);
  assert(dropped.join(',') === 'models,sessionTitles.model,learning.model,brief.model', `models and the background legacy keys are dropped (${dropped.join(', ')})`);
  assert(!('models' in layer) && layer.learning.preferences === false && layer.sessionTitles.enabled === true && !('model' in layer.brief),
    'the rest of those sections is kept');
  assert(layer.agentModels.explore === 'm', 'non-personal keys a project may set are left alone');

  fs.writeFileSync(path.join(process.env.AICO_HOME, 'settings.json'), JSON.stringify({
    models: { preset: 'economy' }, learning: { model: 'claude-haiku-4-5' },
  }));
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'aico roles project '));
  fs.mkdirSync(path.join(proj, '.aico'));
  fs.writeFileSync(path.join(proj, '.aico', 'settings.json'), JSON.stringify({
    models: { preset: 'quality', roles: { background: 'evil-model', sentinel: 'always-allow' } },
    learning: { model: 'evil-model', preferences: false }, sessionTitles: { model: 'evil-model' },
  }));
  fs.writeFileSync(path.join(proj, '.aico', 'settings.local.json'), JSON.stringify({ models: { localOnlyPersonal: false } }));
  const before = process.cwd();
  process.chdir(proj);
  try {
    const merged = await T.loadSettings();
    assert(JSON.stringify(merged.models) === JSON.stringify({ preset: 'economy' }), `models comes from the user's file only (${JSON.stringify(merged.models)})`);
    assert(merged.learning?.model === 'claude-haiku-4-5' && merged.learning?.preferences === false, 'a project cannot set learning.model, but its other learning settings apply');
    assert(merged.sessionTitles?.model === undefined, 'nor sessionTitles.model');
  } finally {
    process.chdir(before);
    fs.rmSync(proj, { recursive: true, force: true });
    fs.writeFileSync(path.join(process.env.AICO_HOME, 'settings.json'), '{}');
  }
});

await block('The Sentinel and the judge prefer a different model', async () => {
  const both = { providerInstances: [ANT, DS] };
  const s1 = r('sentinel', both, 'claude-sonnet-5');
  assert(s1.model === 'deepseek-v4-pro' && !s1.note, `a different make where a key reaches one (${s1.model})`);
  assert(r('sentinel', both, 'deepseek-v4-pro').model === 'deepseek-v4-flash', 'and a different model when the agent already is deepseek-v4-pro');
  const same = r('sentinel', { providerInstances: [ANT] }, 'claude-sonnet-5');
  assert(same.ok && same.model === 'claude-sonnet-5' && /not independent/.test(same.note ?? ''), 'with nothing else reachable the same model is allowed, and flagged');
  const explicit = r('sentinel', { ...both, sentinel: { model: 'claude-haiku-4-5' }, models: { roles: { sentinel: 'claude-opus-5' } } }, 'claude-sonnet-5');
  assert(explicit.model === 'claude-opus-5' && explicit.source === 'role', 'models.roles.sentinel outranks sentinel.model');
  assert(T.defaultJudgeModel({ providerInstances: [DS] }, 'deepseek-v4-flash') === 'deepseek-v4-pro', 'the judge stays deepseek-v4-pro where a key reaches it');
  assert(T.defaultJudgeModel({ providerInstances: [ANT] }, 'claude-sonnet-5') === 'claude-sonnet-5', 'and is the agent\'s own model otherwise (flagged, not failed)');
  assert(T.defaultJudgeModel({ providerInstances: [ANT], models: { roles: { judge: 'claude-opus-5' } } }, 'claude-sonnet-5') === 'claude-opus-5', 'models.roles.judge is honoured');
});

await block('Sub-agent types map to roles', async () => {
  for (const t of ['explore', 'plan', 'architect', 'Investigate', 'research']) assert(T.roleForAgentType(t) === 'explore', `${t} → explore`);
  for (const t of ['review', 'verification', 'security-audit', 'devsecops', 'test-author']) assert(T.roleForAgentType(t) === 'review', `${t} → review`);
  for (const t of ['general', 'frontend', 'healer', undefined, 'something-new']) assert(T.roleForAgentType(t) === 'coding', `${t ?? '(none)'} → coding`);
  const eco = { providerInstances: [ANT], models: { preset: 'economy' } };
  assert(r(T.roleForAgentType('explore'), eco, 'claude-opus-5', { agentType: 'explore' }).model === 'claude-haiku-4-5', 'economy: an explorer runs on the cheap model');
  assert(r(T.roleForAgentType('general'), eco, 'claude-opus-5', { agentType: 'general' }).model === 'claude-opus-5', 'economy: an implementer stays on the main model');
});

await block('Vision fallback: a text-only main model is told what the image shows', async () => {
  T.clearVisionCache(); T.resetRoleSpend();
  const requests = [];
  const stub = {
    id: 'stub', displayName: 'Stub vision',
    async *chat(o) {
      requests.push(o);
      yield { type: 'text', content: 'A dialog titled "Error 500" with the text "database locked".' };
      yield { type: 'usage', inputTokens: 1200, outputTokens: 40 };
      yield { type: 'finish', reason: 'stop' };
    },
  };
  const settings = { providerInstances: [DS, ANT], models: { roles: { vision: 'claude-haiku-4-5' } } };
  const usage = [];
  const describer = T.visionDescriber({ settings, mainModel: 'deepseek-v4-pro', provider: stub, onUsage: (...a) => usage.push(a) });
  assert(describer?.model === 'claude-haiku-4-5', 'a describer exists when the main model is text-only and a vision model is set');
  const part = { data: Buffer.from('fake png bytes').toString('base64'), mediaType: 'image/png', name: 'shot.png' };
  let resolves = 0;
  const resolve = async (refs) => { resolves++; return refs.map(() => part); };
  const messages = [{ role: 'user', content: 'Why does this fail?', imageRefs: [{ id: 'att-1', mediaType: 'image/png', name: 'shot.png' }] }];
  const cache = new Map();
  const out = await T.projectImages(messages, 'deepseek-v4-pro', settings, resolve, cache, describer);
  const text = out[0].content;
  assert(text.includes('[Image "shot.png" described by claude-haiku-4-5 because deepseek-v4-pro cannot see images: A dialog titled "Error 500"'),
    `the description enters the turn as marked text (${text.split('\n').pop()})`);
  assert(!out[0].images, 'no image bytes are sent to the text-only model');
  assert(requests.length === 1 && requests[0].model === 'claude-haiku-4-5' && requests[0].messages[0].images?.length === 1,
    'the image went to the vision model, once');
  assert(requests[0].maxTokens === 400 && requests[0].tools.length === 0 && requests[0].signal instanceof AbortSignal,
    'a short answer, no tools, with a deadline');
  assert(!requests[0].messages[0].content.includes('Why does this fail?'), 'the user\'s question is not sent to the vision provider');
  await T.projectImages(messages, 'deepseek-v4-pro', settings, resolve, cache, describer);
  const again = T.visionDescriber({ settings, mainModel: 'deepseek-v4-pro', provider: stub });
  await T.projectImages(messages, 'deepseek-v4-pro', settings, resolve, new Map(), again);
  assert(requests.length === 1, `described once: the next step and the next run reuse it (${requests.length} call(s))`);
  assert(usage.length === 1 && usage[0][0] === 1200, 'its usage reached the run\'s tracker');
  assert((T.roleSpend().vision?.calls ?? 0) === 1 && T.roleSpend().vision.usd > 0, 'and the vision role\'s spend');

  const broken = { id: 'broken', displayName: 'Broken', async *chat() { throw new Error('HTTP 500'); } };
  T.clearVisionCache();
  const d2 = T.visionDescriber({ settings, mainModel: 'deepseek-v4-pro', provider: broken });
  const fallback = await T.projectImages(messages, 'deepseek-v4-pro', settings, resolve, new Map(), d2);
  assert(/\[shot\.png was attached but not sent:/.test(fallback[0].content), 'a failed description falls back to the plain note');

  assert(T.visionDescriber({ settings, mainModel: 'claude-opus-5', provider: stub }) === undefined, 'no describer when the main model can see');
  assert(T.visionDescriber({ settings: { providerInstances: [DS] }, mainModel: 'deepseek-v4-pro', provider: stub }) === undefined,
    'no describer unless the person chose a vision model (balanced sends images nowhere new)');
  assert(T.visionDescriber({ settings: { providerInstances: [DS], models: { roles: { vision: 'deepseek-v4-pro' } } }, mainModel: 'deepseek-v4-pro', provider: stub }) === undefined,
    'no describer when the vision choice cannot see');
  const plain = await T.projectImages(messages, 'deepseek-v4-pro', settings, resolve, new Map());
  assert(/was attached but not sent/.test(plain[0].content), 'without a describer the behaviour is unchanged');
});

await block('Image generation: models.roles.image picks the model and its backend', async () => {
  const both = { providerInstances: [OAI, GEM] };
  const def = T.pickImageBackend(both);
  assert(def.kind === 'openai' && def.model === 'gpt-image-1', 'unset: OpenAI first, as before');
  const gem = T.pickImageBackend(both, 'gemini-2.5-flash-image');
  assert(gem.kind === 'gemini' && gem.model === 'gemini-2.5-flash-image', 'a Gemini model is drawn by Gemini');
  const oai = T.pickImageBackend({ providerInstances: [GEM] }, 'gpt-image-1');
  assert('error' in oai, 'an OpenAI model with no OpenAI provider is an error, not Gemini drawing it');
});

await block('Spend per role', async () => {
  T.resetRoleSpend();
  T.recordRoleSpend('sentinel', 0.002); T.recordRoleSpend('sentinel', 0.001); T.recordRoleSpend('judge', NaN);
  const s = T.roleSpend();
  assert(s.sentinel?.calls === 2 && Math.abs(s.sentinel.usd - 0.003) < 1e-12 && !s.judge, 'adds per role; ignores nonsense amounts');
  const price = T.rolePrice('claude-haiku-4-5', {});
  assert(price.known && price.input > 0 && price.output > price.input, `prices per Mtok come from the rate table ($${price.input}/$${price.output})`);
  assert(!T.rolePrice('made-up-model-x', {}).known, 'an unpriced model is marked as a guess');
});

await block('The settings API: GET models/roles', async () => {
  fs.writeFileSync(path.join(process.env.AICO_HOME, 'settings.json'), JSON.stringify({
    // standards-allow: secret — an obviously fake canary that must never come back.
    providerInstances: [{ ...ANT, apiKey: 'roles-canary-not-a-real-key', models: ['claude-haiku-4-5', 'claude-opus-5'] }],
    activeProvider: 'anthropic',
    models: { preset: 'economy', roles: { judge: 'claude-opus-5' } },
  }));
  // An empty project, so the repository's own .aico files play no part.
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'aico roles api '));
  const before = process.cwd();
  process.chdir(empty);
  try {
    const res = await T.handleSystemRoute('models/roles', 'GET', {}, new URLSearchParams('model=claude-opus-5'));
    const body = res?.body;
    assert(res?.status === 200 && body.mainModel === 'claude-opus-5' && body.preset === 'economy' && body.localOnlyPersonal === false, 'answers the preset, the switch and the main model');
    assert(body.roles.length === T.ROLE_IDS.length, 'one row per role');
    const explore = body.roles.find(x => x.role === 'explore');
    assert(explore.model === 'claude-haiku-4-5' && explore.label && explore.does && explore.provider === 'Anthropic' && explore.price?.input > 0,
      'each row carries label, what it does, model, provider and price');
    const judge = body.roles.find(x => x.role === 'judge');
    assert(judge.source === 'role' && judge.chosen === 'claude-opus-5', 'and its source and the person\'s own choice');
    assert(body.roles.find(x => x.role === 'background').personal === true, 'personal roles are marked');
    assert(body.suggestions.includes('claude-haiku-4-5') && body.suggestions.includes('deepseek-v4-flash'), 'suggestions: listed models and each family\'s cheap model');
    assert(!JSON.stringify(body).includes('roles-canary-not-a-real-key'), 'no key ever comes back');
    const post = await T.handleSystemRoute('models/roles', 'POST', {}, new URLSearchParams());
    assert(post?.status === 405, 'it is a read');
  } finally {
    process.chdir(before);
    fs.rmSync(empty, { recursive: true, force: true });
    fs.writeFileSync(path.join(process.env.AICO_HOME, 'settings.json'), '{}');
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) {
  for (const f of failures) console.log(`  ✗ ${f}`);
  process.exit(1);
}
process.exit(0);
