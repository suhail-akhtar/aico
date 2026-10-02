/**
 * Phase 7 of the agents/skills/tools design (docs/engineering/design/
 * agents-skills-tools.md §8.3, §10): autonomy levels and the approve-later
 * inbox.
 *
 * What each block proves, against the acceptance list:
 *   - the L0–L4 scale maps onto today's switches both ways, and the effective
 *     level only goes down (agent ceiling, parent, certification);
 *   - an unattended (L4) run that reaches a destructive custom tool records a
 *     pending action — the exact call, the preview, the hashes — instead of
 *     running it, tells the model not to work around it, and carries on;
 *     below L4 the same call is refused, as before;
 *   - approving runs exactly that call, once (a double click runs it once; a
 *     second approval is refused);
 *   - a changed preview (simulated cluster state) is refused as diverged, as
 *     is a changed tool definition or a stored call edited on disk;
 *   - expiry and denial never run anything;
 *   - only a person can approve: the route refuses the API token alone, the
 *     agent's shell cannot reach the route, and a deny needs no proof;
 *   - the outcome is delivered into the session it came from, and every step
 *     is in the inbox's audit file.
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

fs.writeFileSync(path.join(process.env.AICO_HOME, 'settings.json'), '{}');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aico phase7 '));   // a space on purpose
process.on('exit', () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } });
const NODE = process.execPath;
const script = (name, body) => { const f = path.join(tmp, name); fs.writeFileSync(f, body); return f; };

// The "cluster": a state file the preview reads, and a log every apply appends to.
const STATE = path.join(tmp, 'cluster-state.txt');
const APPLIED = path.join(tmp, 'applied.log');
fs.writeFileSync(STATE, 'replicas=3');
const DIFF_JS = script('diff.cjs', 'const fs=require("fs");console.log("DIFF release " + process.argv[2] + ": " + fs.readFileSync(process.argv[3],"utf8") + " -> replicas=5")');
const APPLY_JS = script('apply.cjs', 'require("fs").appendFileSync(process.argv[3], process.argv[2] + "\\n"); console.log("upgraded " + process.argv[2])');

const userTools = path.join(process.env.AICO_HOME, 'tools');
function writeTool(pack, def) {
  const f = path.join(userTools, pack, `${def.name}.tool.json`);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(def, null, 2));
  return f;
}
async function enable(name) {
  const t = (await T.loadCustomTools(tmp)).find(x => x.name === name);
  T.setToolEnabled(t, true);
}
const schema = (properties) => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const RELEASE = { release: { type: 'string', pattern: '^[a-z]+$' } };
writeTool('k8s', { name: 'k8s_helm_diff', description: 'Show what an upgrade would change.', input_schema: schema(RELEASE), run: { argv: [NODE, DIFF_JS, '{release}', STATE] }, effect: 'read' });
const UPGRADE = { name: 'k8s_helm_upgrade', description: 'Upgrade a release. Irreversible.', input_schema: schema(RELEASE), run: { argv: [NODE, APPLY_JS, '{release}', APPLIED] }, effect: 'destructive', preview: { tool: 'k8s_helm_diff', args: 'same' } };
const UPGRADE_FILE = writeTool('k8s', UPGRADE);
writeTool('k8s', { name: 'k8s_notify', description: 'Post a deploy note.', input_schema: schema(RELEASE), run: { argv: [NODE, '-e', 'console.log("noted")'] }, effect: 'external' });
for (const n of ['k8s_helm_diff', 'k8s_helm_upgrade', 'k8s_notify']) await enable(n);

const applied = () => (fs.existsSync(APPLIED) ? fs.readFileSync(APPLIED, 'utf8').split('\n').filter(Boolean) : []);
const resetApplied = () => fs.rmSync(APPLIED, { force: true });

// ── a scripted model ────────────────────────────────────────────────────
function mock(steps) {
  let i = 0;
  return {
    id: 'mock', displayName: 'Mock',
    async *chat() {
      const step = steps[Math.min(i++, steps.length - 1)];
      for (const ev of step) yield ev;
    },
  };
}
const calls = (...list) => [
  ...list.map(([name, input], i) => [{ type: 'tool_call', id: `c${i}-${name}`, name, input }, { type: 'finish', reason: 'tool_calls' }]),
  [{ type: 'text', content: 'done' }, { type: 'finish', reason: 'stop' }],
];
const SETTINGS = { completionGate: { enabled: false }, cron: { enabled: false }, repeatGuard: { enabled: false }, deferTools: false };
let runs = 0;
async function turn(steps, extra = {}) {
  const session = new T.Session({ id: extra.sessionId ?? `phase7-${++runs}`, cwd: tmp, startedAt: Date.now() });
  await T.runAgent({
    task: 'go', model: 'mock-model', showPlan: false, autoApprove: true, verbose: false, silent: true,
    conversationHistory: [], sessionId: session.header.id, session, provider: mock(steps), settings: SETTINGS, cwd: tmp,
    ...extra,
  });
  return session.events.filter(e => e.type === 'tool/result').map(e => JSON.stringify(e.data));
}
const pending = () => T.listActions({ status: 'pending' });
const parkedId = (results) => /inbox \(id (act-[a-z0-9-]+)\)/.exec(results.join('\n'))?.[1];

// ═══════════════════════════════════════════════════════════════════════
await block('The scale: mapping and the effective level', async () => {
  assert(T.AUTONOMY_LEVELS.join() === 'L0,L1,L2,L3,L4', 'five levels, in order');
  assert(['L3', 3, 'auto', 'Unattended', 'plan', 'edits', 'bogus', 7].map(T.parseLevel).join() === 'L3,L3,L3,L4,L0,L2,,', 'levels parse from names, numbers and the old mode names; junk is undefined');
  assert(T.levelFromMode({ planMode: true, approval: 'auto' }) === 'L0' && T.levelFromMode({ approval: 'ask' }) === 'L1'
    && T.levelFromMode({ approval: 'edits' }) === 'L2' && T.levelFromMode({ approval: 'auto' }) === 'L3'
    && T.levelFromMode({ approval: 'auto', unattended: true }) === 'L4', 'migration: plan/ask/edits/auto/unattended map to L0–L4');
  assert(T.AUTONOMY_LEVELS.every(l => T.levelFromMode({ ...T.modeFromLevel(l), unattended: T.modeFromLevel(l).parks }) === l), 'and back again, for every level');
  assert(T.modeFromLevel('L4').parks && !T.modeFromLevel('L3').parks, 'only L4 parks');
  const e = (o) => T.effectiveLevel(o);
  assert(e({ requested: 'L4', agentCeiling: 'L2' }).level === 'L2' && e({ requested: 'L4', agentCeiling: 'L2' }).cappedBy === 'agent', 'an agent ceiling lowers the level');
  assert(e({ requested: 'L2', agentCeiling: 'L4' }).level === 'L2', 'and never raises it');
  assert(e({ requested: 'L4', parent: 'L1' }).level === 'L1', 'a child is never above its parent');
  assert(e({ requested: 'L4', certified: false }).level === 'L3' && e({ requested: 'L4', certified: false }).cappedBy === 'certification', 'an uncertified agent cannot run at L4');
  assert(e({ requested: 'L3', agentCeiling: 'nonsense' }).level === 'L3', 'an unreadable ceiling is ignored here (the agent validator reports it)');
  assert(T.minLevel('L3', undefined, 'L1') === 'L1' && T.minLevel() === undefined, 'minLevel');
  assert(T.defaultBackgroundLevel('full', false) === 'L4' && T.defaultBackgroundLevel('inherit', true) === 'L4'
    && T.defaultBackgroundLevel('inherit', false) === undefined && T.defaultBackgroundLevel('readonly', true) === undefined,
  'background/cron: full → L4; readonly never parks');
});

let firstId;
await block('Recording: an L4 run parks the destructive call and carries on', async () => {
  resetApplied();
  const results = await turn(calls(['k8s_helm_upgrade', { release: 'web' }], ['k8s_helm_diff', { release: 'web' }]), { autonomy: 'L4', headless: true, parkFrom: { origin: 'cron', label: 'nightly deploy' } });
  assert(applied().length === 0, 'the destructive call did not run');
  assert(results.some(r => /PARKED/.test(r) && /has NOT run/.test(r) && /Do not try to do the same thing another way/.test(r)), 'the model is told it is parked, has not run, and must not be worked around');
  assert(results.some(r => /DIFF release web/.test(r)), 'and the run carried on (the next call ran)');
  firstId = parkedId(results);
  const list = pending();
  assert(list.length === 1 && list[0].id === firstId, 'one pending action, with the id the model was given');
  const a = list[0];
  assert(a.tool === 'k8s_helm_upgrade' && a.effect === 'destructive' && a.origin === 'cron' && a.label === 'nightly deploy', 'tool, effect and where it came from');
  assert(JSON.stringify(a.args) === '{"release":"web"}' && a.argsHash === T.hashArgs({ release: 'web' }), 'the exact arguments, and their hash');
  assert(a.call.includes('apply.cjs') && a.call.includes('web'), 'the exact rendered argv');
  assert(/Preview \(k8s_helm_diff\)/.test(a.preview ?? '') && /replicas=3 -> replicas=5/.test(a.preview ?? '') && /^[0-9a-f]{64}$/.test(a.previewHash ?? ''), 'the preview (the diff) and its hash');
  assert(/^[0-9a-f]{64}$/.test(a.contextHash) && a.expiresAt - a.createdAt === T.DEFAULT_PARK_TTL_MS, 'a context hash and a 24-hour expiry');
  assert(/destructive/.test(a.why), 'and why it needed a person');
});

await block('Below L4 the same call is refused, never parked or run', async () => {
  const before = pending().length;
  const l3 = await turn(calls(['k8s_helm_upgrade', { release: 'web' }]), { autonomy: 'L3', headless: true });
  assert(applied().length === 0 && l3.some(r => /nobody is available/.test(r)) && pending().length === before, 'L3 headless: refused as before');
  const none = await turn(calls(['k8s_helm_upgrade', { release: 'web' }]), { headless: true });
  assert(applied().length === 0 && none.some(r => /nobody is available/.test(r)) && pending().length === before, 'no level: unchanged behaviour');
  const plan = await turn(calls(['k8s_helm_upgrade', { release: 'web' }]), { autonomy: 'L4', headless: true, planMode: true });
  assert(applied().length === 0 && pending().length === before && plan.every(r => !/PARKED/.test(r)), 'plan mode never parks');
});

await block('External: first use parks at L4', async () => {
  const before = pending().length;
  const r = await turn(calls(['k8s_notify', { release: 'web' }]), { autonomy: 'L4', headless: true });
  assert(r.some(x => /PARKED/.test(x)) && pending().length === before + 1, 'an external tool\'s first use is parked, not asked');
  T.denyAction(parkedId(r), 'test');
});

await block('Scope: only a person can approve', async () => {
  const human = { no: async () => ({ ok: false, reason: 'no person' }) };
  const r1 = await T.handleSystemRoute('inbox/decide', 'POST', { id: firstId, decision: 'approve' }, new URLSearchParams(), human.no);
  assert(r1.status === 403 && r1.body.code === 'human-required', 'the API token alone is refused (403 human-required)');
  assert(T.getAction(firstId).status === 'pending' && applied().length === 0, 'and nothing ran');
  // The real gate: token-only → refused; the UI key → a person.
  const gate = T.resetDecisionGate(new T.DecisionGate());
  const v1 = await gate.checkHuman({});
  const v2 = await gate.checkHuman({ uiKey: gate.uiKey });
  assert(!v1.ok && v2.ok && v2.via === 'ui-key', 'the decision gate tells a person from the token');
  gate.setHostAttached(true);
  assert(!(await gate.checkHuman({ uiKey: gate.uiKey })).ok, 'with the desktop attached, only its window\'s grant counts');
  gate.setHostAttached(false);
  assert(/BLOCKED/.test(T.shellDenial('curl -X POST -H "x-aico-token: abc" http://127.0.0.1:7340/api/inbox/decide -d "{}"') ?? ''), 'the agent\'s shell cannot drive the inbox route');
  const list = await T.handleSystemRoute('inbox/list', 'GET', {}, new URLSearchParams('status=pending'), human.no);
  assert(list.status === 200 && list.body.pending >= 1 && list.body.actions.some(a => a.id === firstId), 'listing is a read anyone with the token may do');
});

await block('Exact replay: approving runs exactly that call, once', async () => {
  resetApplied();
  const delivered = [];
  T.setWakeDelivery({ steer: () => false, followup: (sid, msg) => { delivered.push({ sid, msg }); return true; } });
  // Two clicks at once: one runs, one is refused.
  const [a, b] = await Promise.all([
    T.handleSystemRoute('inbox/decide', 'POST', { id: firstId, decision: 'approve' }, new URLSearchParams(), async () => ({ ok: true, via: 'ui-key' })),
    T.approveAction(firstId, 'ui-key'),
  ]);
  const oks = [a.body.ok, b.ok].filter(Boolean).length;
  assert(oks === 1, 'a double approval runs once');
  assert(applied().join() === 'web', 'the exact argument reached the tool, exactly once');
  const done = T.getAction(firstId);
  assert(done.status === 'executed' && done.decidedVia === 'ui-key' && /upgraded web/.test(done.outcome ?? ''), 'recorded as executed, with the channel and the result');
  const again = await T.approveAction(firstId, 'ui-key');
  assert(!again.ok && /already executed/.test(again.message) && applied().length === 1, 'a later approval is refused');
  assert(delivered.length === 1 && delivered[0].sid === done.sessionId, 'the outcome goes to the run\'s own session only');
  T.setWakeDelivery(undefined);
});

await block('Divergence: a changed preview is refused', async () => {
  resetApplied();
  const r = await turn(calls(['k8s_helm_upgrade', { release: 'api' }]), { autonomy: 'L4', headless: true });
  const id = parkedId(r);
  fs.writeFileSync(STATE, 'replicas=9');      // the cluster moved overnight
  const out = await T.approveAction(id, 'ui-key');
  const a = T.getAction(id);
  assert(!out.ok && a.status === 'diverged' && applied().length === 0, 'refused as diverged; nothing ran');
  assert(/replicas=9/.test(a.newPreview ?? '') && /fresh proposal/.test(a.outcome ?? ''), 'the new preview is shown, with a request for a fresh proposal');
  fs.writeFileSync(STATE, 'replicas=3');
});

await block('Divergence: a changed tool definition or an edited stored call is refused', async () => {
  resetApplied();
  let r = await turn(calls(['k8s_helm_upgrade', { release: 'db' }]), { autonomy: 'L4', headless: true });
  const id1 = parkedId(r);
  writeTool('k8s', { ...UPGRADE, description: 'Upgrade a release. Irreversible. (edited)' });
  await enable('k8s_helm_upgrade');          // even re-enabled by a person: the approval covered the old definition
  const out1 = await T.approveAction(id1, 'ui-key');
  assert(!out1.ok && T.getAction(id1).status === 'diverged' && /definition/.test(out1.message) && applied().length === 0, 'a definition edited after parking → diverged');
  fs.writeFileSync(UPGRADE_FILE, JSON.stringify(UPGRADE, null, 2));
  await enable('k8s_helm_upgrade');

  r = await turn(calls(['k8s_helm_upgrade', { release: 'cache' }]), { autonomy: 'L4', headless: true });
  const id2 = parkedId(r);
  const file = T.inboxFile();
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('"release":"cache"', '"release":"evil"'));
  const out2 = await T.approveAction(id2, 'ui-key');
  assert(!out2.ok && T.getAction(id2).status === 'diverged' && applied().length === 0, 'a stored call edited on disk → refused');
});

await block('Deny and expiry never run anything', async () => {
  resetApplied();
  let r = await turn(calls(['k8s_helm_upgrade', { release: 'web' }]), { autonomy: 'L4', headless: true });
  const id1 = parkedId(r);
  const human = async () => ({ ok: false });
  const denied = await T.handleSystemRoute('inbox/decide', 'POST', { id: id1, decision: 'deny', note: 'not tonight' }, new URLSearchParams(), human);
  assert(denied.status === 200 && denied.body.ok && T.getAction(id1).status === 'denied' && /not tonight/.test(T.getAction(id1).outcome), 'a deny needs no proof and is recorded with its note');
  assert(!(await T.approveAction(id1, 'ui-key')).ok && applied().length === 0, 'a denied action cannot be approved afterwards');

  const tool = (await T.loadCustomTools(tmp)).find(t => t.name === 'k8s_helm_upgrade');
  const parked = T.parkAction({ tool, args: { release: 'web' }, why: 'test', cwd: tmp, agentId: 'x', origin: 'background', ttlMs: 1 });
  await new Promise(res => setTimeout(res, 10));
  T.listActions();
  assert(T.getAction(parked.id).status === 'expired' && T.getAction(parked.id).decidedVia === 'expiry', 'an overdue action expires when the inbox is read');
  const late = await T.approveAction(parked.id, 'ui-key');
  assert(!late.ok && applied().length === 0, 'and cannot be approved');
  const parked2 = T.parkAction({ tool, args: { release: 'web' }, why: 'test', cwd: tmp, agentId: 'x', origin: 'background', ttlMs: 1 });
  await new Promise(res => setTimeout(res, 10));
  const late2 = await T.approveAction(parked2.id, 'ui-key');
  assert(!late2.ok && /expired/.test(late2.message) && T.getAction(parked2.id).status === 'expired' && applied().length === 0, 'approving one that just expired refuses it and records the expiry');
});

await block('A secret value is never parked', async () => {
  const saved = T.activeRedactor();
  T.setActiveRedactor(new T.Redactor([{ name: 'tok', values: ['sk-test-not-a-real-secret-123456'] }])); // standards-allow: secret
  try {
    const tool = (await T.loadCustomTools(tmp)).find(t => t.name === 'k8s_helm_upgrade');
    const r = T.parkAction({ tool, args: { release: 'sk-test-not-a-real-secret-123456' }, why: 'x', cwd: tmp, agentId: 'x', origin: 'background' }); // standards-allow: secret
    assert('error' in r && /secret/.test(r.error) && !fs.readFileSync(T.inboxFile(), 'utf8').includes('sk-test-not-a-real-secret'), 'refused, and nothing written'); // standards-allow: secret
  } finally { T.setActiveRedactor(saved); }
});

await block('Injection: a chat\'s parked call reports back into that chat', async () => {
  resetApplied();
  const delivered = [];
  T.setWakeDelivery({ steer: () => false, followup: (sid, msg) => { delivered.push({ sid, msg }); return true; } });
  const r = await turn(calls(['k8s_helm_upgrade', { release: 'web' }]), { autonomy: 'L4', sessionId: 'phase7-chat', onApprovalRequired: async () => { throw new Error('L4 must not ask'); } });
  const id = parkedId(r);
  assert(id && T.getAction(id).sessionId === 'phase7-chat' && T.getAction(id).origin === 'chat', 'parked with its session (L4 wins over the approval card)');
  const out = await T.approveAction(id, 'host');
  assert(out.ok && applied().join() === 'web', 'approved and ran');
  assert(delivered.length === 1 && delivered[0].sid === 'phase7-chat' && /^\[Inbox\]/.test(delivered[0].msg) && /ran/.test(delivered[0].msg) && /upgraded web/.test(delivered[0].msg), 'the result is delivered to that session as a follow-up');
  const r2 = await turn(calls(['k8s_helm_upgrade', { release: 'web' }]), { autonomy: 'L4', sessionId: 'phase7-chat' });
  T.denyAction(parkedId(r2), 'client');
  assert(delivered.length === 2 && /denied/.test(delivered[1].msg) && /do not try/i.test(delivered[1].msg), 'and so is a denial');
  T.setWakeDelivery(undefined);
});

await block('Audit: every step is in the inbox file', async () => {
  const lines = fs.readFileSync(T.inboxFile(), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  const mine = lines.filter(e => (e.action?.id ?? e.id) === firstId);
  assert(mine.map(e => e.t === 'park' ? 'park' : e.status).join() === 'park,approved,executed', 'park → approved → executed, in order');
  assert(mine.every(e => typeof e.at === 'number') && mine.find(e => e.status === 'approved').via === 'ui-key', 'each with a time, and the approval with its channel');
  assert(lines.some(e => e.status === 'diverged') && lines.some(e => e.status === 'denied') && lines.some(e => e.status === 'expired'), 'refusals, denials and expiries are recorded too');
});

await block('Schedules carry their level', async () => {
  const job = await T.executeCronCreate({ name: 'nightly', schedule: '0 2 * * *', prompt: 'deploy staging', cwd: tmp, autonomy: 'L3' });
  const job2 = await T.executeCronCreate({ name: 'nightly2', schedule: '0 2 * * *', prompt: 'deploy staging', cwd: tmp, autonomy: 'L1' });
  assert(job.autonomy === 'L3' && job2.autonomy === undefined, 'a job stores L3/L4; anything else is the default (L4 for full)');
});

console.log(`\n  PHASE 7 AUTONOMY: ${passed} passed, ${failed} failed\n`);
if (failed) { console.log(failures.map(f => `  - ${f}`).join('\n')); }
process.exit(failed > 0 ? 1 : 0);
