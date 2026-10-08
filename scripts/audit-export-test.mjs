/**
 * The audit export and usage report (ADR 0035): a redacted, versioned stream
 * built from the durable records AICO already keeps.
 *
 * Why it exists: an organisation needs the facts — which tool ran against what,
 * who allowed it, which guard refused it, which credential was used, what
 * changed in settings, what it cost — in a form a SIEM ingests, and it needs
 * to be certain the file can be copied off the machine. So the blocks below
 * plant fake secrets everywhere they could travel (a command line, a file
 * body, a URL query, a vault purpose, a guard's reason, a settings value) and
 * assert none of them is in any of the three formats; then the record shape,
 * the decision fields, the filters, the CEF and CSV escaping, the identity
 * rules and the usage sums.
 *
 * Offline and free: logs are written with the real session writer under this
 * process's own AICO_HOME; nothing is sent anywhere.
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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aico-audit-'));
process.on('exit', () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } });
process.env.AICO_POLICY_FILE = path.join(tmp, 'no-policy.json');
if (fs.existsSync(T.systemPolicyPath())) { console.log('This machine has a managed policy; this suite needs an unmanaged one. Skipped.'); process.exit(0); }
T.resetManagedPolicyCache();

// Fake secrets: obviously fake, and every shape carries the marker the secret scan honours.
const KEY_SHAPED = 'sk-ant-api03-' + 'CANARY'.repeat(9);              // standards-allow: secret
const PASSWORD_ARG = 'hunter2-canary-pw-7731';                         // standards-allow: secret
const ENV_VALUE = 'ENVCANARYVALUE9876';                                // standards-allow: secret
const URL_SECRET = 'urlquerycanary5544';                               // standards-allow: secret
const FILE_BODY = 'FILE-BODY-CANARY-DO-NOT-EXPORT';                    // standards-allow: secret
const VAULT_VALUE = 'vault-held-canary-value-2468';                    // standards-allow: secret
const PURPOSE_SECRET = 'purposecanary13579';                           // standards-allow: secret
const SETTING_VALUE = 'settingcanary-24680';                           // standards-allow: secret
const CANARIES = [KEY_SHAPED, PASSWORD_ARG, ENV_VALUE, URL_SECRET, FILE_BODY, VAULT_VALUE, PURPOSE_SECRET, SETTING_VALUE];

const projA = fs.mkdtempSync(path.join(tmp, 'projA-'));
const projB = fs.mkdtempSync(path.join(tmp, 'projB-'));
const day = (d, h = 10, m = 0) => Date.UTC(2026, 9, d, h, m, 0);

// ── fixtures ─────────────────────────────────────────────────────────

async function writeSession(id, cwd, build) {
  const opened = await T.openSession(id, cwd);
  build(opened.session);
  await opened.close();
}

await writeSession('web-audit-a', projA, (s) => {
  const at = (t) => ({ timestamp: t });
  s.append('request/header', { header: { provider: 'anthropic', model: 'claude-sonnet-5', systemHash: 'h1', tools: [] }, reason: 'initial' }, at(day(2, 9, 59)));
  s.append('turn/start', { turn: 1 }, at(day(2, 10, 0)));
  s.append('assistant/message', { turn: 1, step: 1, content: 'PROMPT-AND-ANSWER-TEXT-MUST-NOT-LEAK', usage: { inputTokens: 1_000_000, outputTokens: 100_000, cachedTokens: 0 } }, at(day(2, 10, 1)));
  const call = (n, id, name, args, t) => s.append('tool/call', { turn: 1, step: 1, callId: id, name, arguments: JSON.stringify(args) }, at(t));
  const result = (id, name, content, t, isError) => s.append('tool/result', { turn: 1, step: 1, callId: id, name, content, ...(isError ? { isError: true } : {}) }, at(t));
  call(1, 'c1', 'Bash', { command: `curl -H "Authorization: Bearer ${PASSWORD_ARG}" https://x.test --password ${PASSWORD_ARG}; export API_KEY=${ENV_VALUE}; echo ${KEY_SHAPED}` }, day(2, 10, 2));
  result('c1', 'Bash', 'TOOL-RESULT-TEXT-MUST-NOT-LEAK', day(2, 10, 3));
  call(2, 'c2', 'Write', { file_path: 'src/a.ts', content: FILE_BODY }, day(2, 10, 4));
  s.append('tool/decision', { callId: 'c2', name: 'Write', decision: 'approved', by: 'person' }, at(day(2, 10, 4)));
  result('c2', 'Write', 'ok', day(2, 10, 5));
  call(3, 'c3', 'WebFetch', { url: `https://example.com/p?token=${URL_SECRET}#frag` }, day(2, 10, 6));
  result('c3', 'WebFetch', 'page', day(2, 10, 7));
  call(4, 'c4', 'WebSearch', { query: 'forbidden' }, day(2, 10, 8));
  s.append('tool/decision', { callId: 'c4', name: 'WebSearch', decision: 'denied', by: 'policy', stage: 'managed-policy', reason: `The WebSearch tool is blocked by your organisation's AICO policy (deniedTools) ${KEY_SHAPED}` }, at(day(2, 10, 8)));
  result('c4', 'WebSearch', 'blocked', day(2, 10, 9), true);
  call(5, 'c5', 'Read', { file_path: 'README.md' }, day(2, 10, 10)); // never answered: the process died
  s.append('agent/spawn', { agentId: 'ag1', agentType: 'explore', description: 'look around', model: 'claude-haiku-4', depth: 1 }, at(day(2, 10, 11)));
  s.append('agent/done', { agentId: 'ag1', status: 'completed', toolCalls: 3, ms: 4000, inputTokens: 500, outputTokens: 50 }, at(day(2, 10, 12)));
  s.append('turn/end', { turn: 1, reason: { kind: 'completed' } }, at(day(2, 10, 13)));
  s.append('turn/start', { turn: 2 }, at(day(3, 10, 0)));
  s.append('assistant/message', { turn: 2, step: 1, content: 'x', usage: { inputTokens: 200_000, outputTokens: 20_000, cachedTokens: 0 } }, at(day(3, 10, 1)));
  s.append('turn/end', { turn: 2, reason: { kind: 'aborted', cause: 'user' } }, at(day(3, 10, 2)));
});
await writeSession('web-audit-b', projB, (s) => {
  s.append('request/header', { header: { provider: 'openai', model: 'gpt-4o', systemHash: 'h2', tools: [] }, reason: 'initial' }, { timestamp: day(4, 8, 0) });
  s.append('turn/start', { turn: 1 }, { timestamp: day(4, 9, 0) });
  s.append('assistant/message', { turn: 1, step: 1, content: 'y', usage: { inputTokens: 300_000, outputTokens: 30_000, cachedTokens: 0 } }, { timestamp: day(4, 9, 1) });
  s.append('turn/end', { turn: 1, reason: { kind: 'completed' } }, { timestamp: day(4, 9, 2) });
});

// Inbox: one parked call a person approved, one nobody answered before it expired.
fs.mkdirSync(path.join(process.env.AICO_HOME, 'inbox'), { recursive: true });
const parked = (id, extra = {}) => ({ t: 'park', at: day(2, 11), action: { id, status: 'pending', createdAt: day(2, 11), origin: 'cron', tool: 'deploy_prod', effect: 'destructive', why: 'destructive: a person approves every call', call: `deploy --token ${PASSWORD_ARG}`, args: {}, cwd: projA, sessionId: 'web-audit-a', ...extra } });
fs.writeFileSync(path.join(process.env.AICO_HOME, 'inbox', 'actions.jsonl'), [
  parked('p1'), { t: 'status', at: day(2, 12), id: 'p1', status: 'approved', via: 'host' },
  parked('p2'), { t: 'status', at: day(3, 12), id: 'p2', status: 'expired', via: 'expiry' },
].map(l => JSON.stringify(l)).join('\n') + '\n{"torn');

// The vault's own trail: names only; the free-text fields are redacted again on the way out.
fs.mkdirSync(path.join(process.env.AICO_HOME, 'vault'), { recursive: true });
fs.writeFileSync(path.join(process.env.AICO_HOME, 'vault', 'audit.jsonl'), [
  { at: day(2, 10, 30), action: 'use', outcome: 'ok', name: 'GITHUB_TOKEN', tool: 'Bash', target: 'api.github.com', purpose: `open a PR with token=${PURPOSE_SECRET} ${VAULT_VALUE}`, sessionId: 'web-audit-a', actor: 'agent:Bash' },
  { at: day(2, 10, 31), action: 'reveal', outcome: 'denied', name: 'DB_PASSWORD', actor: 'agent:Bash', sessionId: 'web-audit-a' },
].map(l => JSON.stringify(l)).join('\n') + '\n');

// The work ledger: a background agent and a cron firing.
fs.writeFileSync(path.join(process.env.AICO_HOME, 'work.jsonl'), [
  { t: 'add', at: day(2, 13), record: { id: 'w1', kind: 'agent', title: 'Refactor the parser', state: 'done', origin: 'user', startedAt: day(2, 13), endedAt: day(2, 13, 30), heartbeatAt: day(2, 13, 30), reported: true, sessionId: 'web-audit-a', cost: { usd: 0.12, tokens: 9000 } } },
  { t: 'add', at: day(5, 3), record: { id: 'w2', kind: 'cron', title: 'Nightly dependency check', state: 'failed', origin: 'cron', startedAt: day(5, 3), endedAt: day(5, 3, 5), heartbeatAt: day(5, 3, 5), reported: false, error: 'exit 1' } },
].map(l => JSON.stringify(l)).join('\n') + '\n');

// Settings and policy: the two facts that had no record. The value is never written.
await T.saveUserSetting('theme', 'dark');
await T.saveUserSetting('sessionTitles', { model: SETTING_VALUE });
// The vault learns its secret only now, so the export's own redaction — not the session writer's — has to catch it.
T.setExtraRedactions('audit-test', [{ name: 'GITHUB_TOKEN', values: [VAULT_VALUE] }]);

const all = await T.collectAudit({});
const of = (kind) => all.filter(r => r.kind === kind);

// ═════════════════════════════════════════════════════════════════════

await block('the stream: kinds, shape and the version field', async () => {
  const kinds = new Set(all.map(r => r.kind));
  for (const k of ['tool.call', 'turn.end', 'subagent', 'approval', 'credential', 'work', 'settings.change']) assert(kinds.has(k), `has ${k} records`);
  assert(all.every(r => r.schema === 'aico.audit/1' && /^[0-9a-f]{16}$/.test(r.id)), 'every record has the schema version and a stable id');
  assert(all.every(r => /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(r.time)), 'times are ISO-8601 UTC');
  assert(all.every((r, i) => i === 0 || all[i - 1].time <= r.time), 'oldest first');
  assert(all.every(r => typeof r.aicoVersion === 'string' && r.user && /^[0-9a-f]{16}$/.test(r.host)), 'version, OS user and a hashed host on every record');
  assert(JSON.stringify(await T.collectAudit({})) === JSON.stringify(all), 'a second export is identical (stable ids, no clock in the data)');
  assert(new Set(all.map(r => r.id)).size === all.length, 'ids are unique');
});

await block('tool calls: target, decision, who decided, which stage', async () => {
  const calls = of('tool.call');
  const by = (id) => calls.find(r => r.callId === id);
  assert(by('c1').tool === 'Bash' && by('c1').decision === 'allow' && by('c1').decidedBy === 'auto' && by('c1').outcome === 'ok', 'an unprompted call is allow / auto');
  assert(by('c2').decision === 'allow' && by('c2').decidedBy === 'person', 'a call a person answered says so');
  assert(by('c2').target === 'src/a.ts', 'a Write is exported as its path alone');
  assert(by('c3').target === 'https://example.com/p', 'a fetch is host and path, with no query string or fragment');
  assert(by('c4').outcome === 'denied' && by('c4').decision === 'deny' && by('c4').stage === 'managed-policy' && by('c4').decidedBy === 'guard:managed-policy', 'a refusal names the guard that made it');
  assert(by('c5').outcome === 'aborted', 'a call with no result is exported as aborted, not lost');
  assert(by('c1').model === 'claude-sonnet-5' && by('c1').sessionId === 'web-audit-a' && by('c1').project === projA && by('c1').turn === 1, 'model, session, project and turn correlate');
  assert(by('c1').durationMs === 60_000, 'duration is result minus call');
  assert(by('c1').target.length <= 200, 'a command is cut at 200 characters');
  const sub = of('subagent')[0];
  assert(sub && sub.action === 'explore' && sub.outcome === 'ok' && sub.model === 'claude-haiku-4', 'a sub-agent is a record of its own');
  const turns = of('turn.end');
  assert(turns.length === 3, 'one turn.end per turn across sessions');
  const t1 = turns.find(r => r.sessionId === 'web-audit-a' && r.turn === 1);
  assert(t1.inputTokens === 1_000_000 && t1.outputTokens === 100_000 && t1.costUsd > 0, 'tokens and an estimated cost');
  assert(turns.find(r => r.turn === 2).outcome === 'aborted', 'an aborted turn is aborted');
});

await block('approvals, credentials, work, settings', async () => {
  const ap = of('approval');
  assert(ap.length >= 3, 'a parked call and its decisions are each a record');
  const approved = ap.find(r => r.action === 'approved');
  assert(approved && approved.decision === 'allow' && approved.decidedBy === 'person:host', 'who approved, and by which channel');
  assert(ap.find(r => r.action === 'park').decision === 'escalated' && ap.find(r => r.action === 'park').outcome === 'escalated', 'parking is an escalation');
  assert(ap.find(r => r.action === 'expired').decidedBy === 'system', 'an expiry is the system, not a person');
  const cred = of('credential');
  assert(cred.find(r => r.action === 'use').credential === 'GITHUB_TOKEN', 'a credential use is a reference name');
  assert(cred.find(r => r.action === 'reveal').outcome === 'denied', 'a denied reveal is recorded');
  const work = of('work');
  assert(work.find(r => r.callId === 'w1').outcome === 'ok' && work.find(r => r.callId === 'w2').outcome === 'error', 'background work has an outcome');
  const settings = of('settings.change');
  assert(settings.some(r => r.target === 'theme') && settings.some(r => r.target === 'sessionTitles'), 'settings changes are records');
  assert(!JSON.stringify(settings).includes('dark'), 'a settings value is never exported (only its key)');
});

await block('redaction: no planted secret appears in any format', async () => {
  const everything = [
    T.formatAuditRecords(all, 'jsonl'),
    T.formatAuditRecords(all, 'csv'),
    T.formatAuditRecords(all, 'cef'),
    JSON.stringify(T.summarizeUsage(all, 'model')),
  ].join('\n');
  for (const c of CANARIES) assert(!everything.includes(c), `"${c.slice(0, 18)}…" is not in the export`);
  for (const text of ['PROMPT-AND-ANSWER-TEXT-MUST-NOT-LEAK', 'TOOL-RESULT-TEXT-MUST-NOT-LEAK']) assert(!everything.includes(text), `${text.slice(0, 12)}… (message / result text) is not in the export`);
  assert(T.auditText(`export TOKEN=${ENV_VALUE} && x`).includes('[redacted]'), 'NAME=value with a secret-looking name is masked');
  assert(T.auditText('curl https://bob:pw123456@host/x').includes('[redacted]@'), 'URL credentials are masked');
  assert(!T.auditText('a\u0000b\u2028c\nd').match(/[\u0000-\u001f\u2028]/), 'control characters are stripped (no log injection)');
  assert(T.auditText('x'.repeat(500), 50).length === 50, 'text is bounded');
  assert(T.callTarget('Write', { file_path: 'a.ts', content: FILE_BODY }) === 'a.ts', 'a Write target never includes content');
  assert(T.callTarget('X', { url: 'https://u:p@h.test/a/b?q=1' }).includes('h.test/a/b') && !T.callTarget('X', { url: 'https://u:p@h.test/a/b?q=1' }).includes('q=1'), 'a URL target drops the query');
});

await block('filters: since, until, project', async () => {
  const since = await T.collectAudit({ since: T.parseWhen('2026-10-03') });
  assert(since.length > 0 && since.every(r => Date.parse(r.time) >= day(3, 0)), '--since keeps only later records');
  const until = await T.collectAudit({ until: T.parseWhen('2026-10-02', true) });
  assert(until.some(r => r.callId === 'c1') && until.every(r => Date.parse(r.time) < day(3, 0)), '--until with a date includes that whole day');
  assert(T.parseWhen('2026-10-02', true) - T.parseWhen('2026-10-02') === 86_400_000, 'a date alone as --until means the end of the day');
  assert(T.parseWhen('nonsense') === undefined, 'a non-date is rejected, not guessed');
  const onlyB = await T.collectAudit({ project: projB });
  assert(onlyB.length > 0 && onlyB.every(r => r.project === projB), '--project keeps one project');
  assert(onlyB.every(r => r.kind !== 'settings.change' && r.kind !== 'credential'), 'a project export carries nothing global');
  const onlyA = await T.collectAudit({ project: projA });
  assert(onlyA.some(r => r.kind === 'credential') && onlyA.some(r => r.kind === 'approval'), 'records tied to a project\'s sessions are included with it');
  const calls = await T.collectAudit({ kinds: ['tool.call'] });
  assert(calls.length > 0 && calls.every(r => r.kind === 'tool.call'), 'kinds narrows the stream');
});

await block('CEF: header and extension escaping, one event per line', async () => {
  const hostile = {
    schema: 'aico.audit/1', id: '0123456789abcdef', time: '2026-10-02T10:00:00.000Z', kind: 'tool.call', action: 'Ba|sh', outcome: 'denied',
    aicoVersion: '0.47.0', user: 'a=b', host: 'h', target: 'c:\\temp\\x', reason: 'line1\nline2 | pipe = equals \\ slash', decidedBy: 'guard:x', decision: 'deny', stage: 'x',
  };
  const lines = T.toCef([hostile, hostile]).trimEnd().split('\n');
  assert(lines.length === 2, 'a newline in a value cannot start a second event');
  const line = lines[0];
  assert(line.startsWith('CEF:0|AICO|aico|0.47.0|tool.call|tool.call: Ba\\|sh|6|'), 'header: 7 pipes, the action\'s | escaped, severity for a denial');
  assert(/^CEF:0\|(?:(?:[^|\\]|\\.)*\|){6}/.test(line),'the seven header fields are separated by exactly seven unescaped pipes');
  assert(line.includes('msg=line1\\nline2 | pipe \\= equals \\\\ slash'), 'extension: newline, = and backslash escaped, a pipe is plain there');
  assert(line.includes('suser=a\\=b') && line.includes('cs1=c:\\\\temp\\\\x'), 'values with = and backslashes are escaped');
  assert(/rt=1790935200000/.test(line), 'rt is epoch milliseconds');
  assert(T.cefHeader('a|b\\c') === 'a\\|b\\\\c' && T.cefValue('a=b\r\nc') === 'a\\=b\\nc', 'the escapers on their own');
});

await block('CSV: RFC 4180 quoting and formula-injection protection', async () => {
  assert(T.csvCell('plain') === 'plain', 'a plain cell is bare');
  assert(T.csvCell('a,b') === '"a,b"' && T.csvCell('say "hi"') === '"say ""hi"""' && T.csvCell('a\nb') === '"a\nb"', 'commas, quotes and newlines are quoted');
  for (const f of ['=1+1', '+SUM(A1)', '-2+3', '@cmd', '\tx']) assert(T.csvCell(f).startsWith('\'') || T.csvCell(f).startsWith('"\''), `"${JSON.stringify(f)}" cannot run as a formula`);
  assert(T.csvCell(-5) === '-5', 'numbers are not mangled');
  const csv = T.toCsv(all);
  const rows = csv.split('\r\n');
  assert(rows[0] === T.AUDIT_COLUMNS.join(','), 'the first row is the documented column list');
  assert(csv.endsWith('\r\n') && rows.length === all.length + 2, 'CRLF rows, one per record');
});

await block('end to end: a real run under a policy, a guard\'s refusal and a person\'s yes land in the export', async () => {
  fs.writeFileSync(process.env.AICO_POLICY_FILE, JSON.stringify({ maxAutonomyLevel: 'L1', network: { mode: 'allow-list', domains: ['example.com'] } }));
  T.resetManagedPolicyCache();
  const projC = fs.mkdtempSync(path.join(tmp, 'projC-'));
  const opened = await T.openSession('web-audit-live', projC);
  const steps = [
    [{ type: 'tool_call', id: 'live-w', name: 'Write', input: { file_path: path.join(projC, 'out.txt'), content: 'hello' } }, { type: 'finish', reason: 'tool_calls' }],
    [{ type: 'tool_call', id: 'live-f', name: 'WebFetch', input: { url: 'https://evil.test/x?k=1' } }, { type: 'finish', reason: 'tool_calls' }],
    [{ type: 'text', content: 'done' }, { type: 'finish', reason: 'stop' }],
  ];
  let i = 0;
  const provider = { id: 'mock', displayName: 'Mock', async *chat() { for (const ev of steps[Math.min(i++, steps.length - 1)]) yield ev; } };
  const asked = [];
  await T.runAgent({
    task: 'go', model: 'mock-model', showPlan: false, autoApprove: false, verbose: false, silent: true, conversationHistory: [],
    sessionId: 'web-audit-live', session: opened.session, provider, cwd: projC,
    settings: { completionGate: { enabled: false }, cron: { enabled: false }, repeatGuard: { enabled: false }, deferTools: false },
    onPermissionRequest: async (tool) => { asked.push(tool); return true; },
  });
  await opened.close();
  assert(asked.includes('Write'), 'under the L1 ceiling a write is a question, and a person answered it');
  assert(!asked.includes('WebFetch'), 'nobody was asked about the fetch the policy forbids');
  assert(fs.existsSync(path.join(projC, 'out.txt')), 'the approved write happened');
  const decisions = opened.session.events.filter(e => e.type === 'tool/decision').map(e => e.data);
  assert(decisions.some(d => d.callId === 'live-w' && d.decision === 'approved' && d.by === 'person'), 'the log holds the person\'s yes');
  assert(decisions.some(d => d.callId === 'live-f' && d.decision === 'denied' && d.stage === 'managed-policy'), 'the log names the stage that refused');
  const records = (await T.collectAudit({ project: projC })).filter(r => r.kind === 'tool.call');
  const w = records.find(r => r.callId === 'live-w');
  const f = records.find(r => r.callId === 'live-f');
  assert(w && w.decidedBy === 'person' && w.decision === 'allow' && w.target.endsWith('out.txt'), 'the export: the write was a person\'s yes');
  assert(f && f.outcome === 'denied' && f.decidedBy === 'guard:managed-policy' && f.stage === 'managed-policy' && f.target === 'https://evil.test/x', 'the export: the fetch was refused by the managed-policy guard, and the query is gone');
  assert(!JSON.stringify(records).includes('hello'), 'the file body is not in the export');
  fs.unlinkSync(process.env.AICO_POLICY_FILE);
  T.resetManagedPolicyCache();
});

await block('identity comes from the policy, not the person being audited', async () => {
  const none = T.resolveIdentity({});
  assert(none.user && /^[0-9a-f]{16}$/.test(none.host), 'default: OS username and a hashed host');
  assert(T.resolveIdentity({ user: 'ci-bot', host: 'build-7' }).user === 'ci-bot' && T.resolveIdentity({ user: 'ci-bot', host: 'build-7' }).host === 'build-7', 'without a policy the flags label the export');
  fs.writeFileSync(process.env.AICO_POLICY_FILE, JSON.stringify({ audit: { user: 'hash', host: 'hostname', tenant: 'acme' } }));
  T.resetManagedPolicyCache();
  const managed = T.resolveIdentity({ user: 'spoofed', host: 'spoofed' });
  assert(/^[0-9a-f]{16}$/.test(managed.user) && managed.user !== 'spoofed' && managed.host === os.hostname() && managed.tenant === 'acme', 'with a policy, the policy decides and the flags are ignored');
  const records = await T.collectAudit({ kinds: ['turn.end'] });
  assert(records.every(r => r.tenant === 'acme'), 'the tenant rides on every record');
  fs.writeFileSync(process.env.AICO_POLICY_FILE, JSON.stringify({ audit: { user: 'omit', host: 'omit' } }));
  T.resetManagedPolicyCache();
  const omitted = await T.collectAudit({ kinds: ['turn.end'] });
  assert(omitted.every(r => r.user === undefined && r.host === undefined), 'omit leaves the fields out');
  fs.unlinkSync(process.env.AICO_POLICY_FILE);
  T.resetManagedPolicyCache();
});

await block('usage: sums by model, project and day; an estimate, labelled', async () => {
  const byModel = T.summarizeUsage(all, 'model');
  const sonnet = byModel.find(r => r.key === 'claude-sonnet-5');
  assert(sonnet.turns === 2 && sonnet.inputTokens === 1_200_000 && sonnet.outputTokens === 120_000, 'per model: both turns of the first session');
  assert(byModel.find(r => r.key === 'gpt-4o').inputTokens === 300_000, 'per model: the other session');
  assert(byModel[0].costUsd >= byModel[byModel.length - 1].costUsd, 'models are ordered by cost');
  const byProject = T.summarizeUsage(all, 'project');
  assert(byProject.length === 2 && byProject.find(r => r.key === projA).turns === 2, 'per project');
  const byDay = T.summarizeUsage(all, 'day');
  assert(byDay.map(r => r.key).join() === '2026-10-02,2026-10-03,2026-10-04', 'per day, in order');
  const csv = T.usageToCsv(byModel, 'model');
  assert(csv.split('\r\n')[0] === 'model,turns,inputTokens,outputTokens,estimatedCostUsd', 'CSV header');
  const json = JSON.parse(T.usageToJson(byModel, 'model'));
  assert(json.schema === 'aico.usage/1' && json.estimated === true && json.rows.length === byModel.length, 'JSON says it is an estimate');
  assert(Math.abs(byModel.reduce((a, r) => a + r.costUsd, 0) - all.filter(r => r.kind === 'turn.end').reduce((a, r) => a + r.costUsd, 0)) < 1e-6, 'the report and the audit stream agree to the cent');
  T.resetTodaySpendCache();
  assert((await T.todaySpend({}, Date.UTC(2026, 9, 2, 12))) >= 0, 'today\'s spend is computable (the per-day cap reads it)');
});

await block('damaged sources do not fail the export', async () => {
  const dir = path.join(process.env.AICO_HOME, 'projects', 'garbage', 'sessions');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'broken.events.jsonl'), '{"type":"__header__","id":"x"\nnot json at all\n{"type":"turn/start","data":{}}');
  fs.writeFileSync(path.join(process.env.AICO_HOME, 'vault', 'audit.jsonl'), 'garbage\n');
  const again = await T.collectAudit({});
  assert(again.some(r => r.kind === 'tool.call'), 'the good sessions are still exported');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { for (const f of failures) console.log(`  ✗ ${f}`); process.exit(1); }
process.exit(0);
