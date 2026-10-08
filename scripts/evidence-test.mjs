/**
 * The change packet, tested offline (ADR 0034, src/evidence/).
 *
 * Why a script of its own: the packet's whole value is that it says only what
 * the log proves, and that is a property of many small cases — an absent record,
 * a stale check, a refused call, a log from before the records existed — that
 * the engine harness has no reason to build. Logs here are hand-built event
 * arrays (the same shape `Session` persists), plus one real round trip through
 * a persisted session and a real git repository for the file counts.
 *
 * Part of `npm test`. No model, no network.
 */

// A store of this process's own — nothing below may touch ~/.aico. Must stay first.
import './lib/test-home.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import {
  buildEvidence, gatherGit, packetFromDisk, renderEvidence, renderEvidenceMarkdown, renderEvidenceShort,
  evidenceTool, evidenceAnswer, runInContext, openSession, executeTool, groupOf, groupsForRequest, isDeferred,
} from '../dist-test/test-exports.js';

let pass = 0; let fail = 0;
function ok(cond, label, detail) {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}${detail !== undefined ? ` — ${JSON.stringify(detail).slice(0, 700)}` : ''}`); }
}
const tmp = (tag) => fs.mkdtempSync(path.join(os.tmpdir(), `aico-${tag}-`));
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim();

/** A hand-built log: `ev('tool/call', {...})` appends with the next seq. */
function log() {
  const events = [];
  const ev = (type, data) => { events.push({ seq: events.length + 1, type, timestamp: 1_700_000_000_000 + events.length * 1000, data }); return events.length; };
  return { events, ev };
}
const FORBIDDEN = /co-authored|generated (?:with|by)|🤖|noreply@anthropic/i;

console.log('\n── An empty log claims nothing ──');
{
  const p = buildEvidence([], { projectChecks: ['typecheck', 'test'] });
  const md = renderEvidenceMarkdown(p);
  ok(p.goal === null && p.checks.ran.length === 0 && p.files.source === 'none', 'no goal, no checks, no files', p);
  ok(/No check run is recorded in this log/.test(md) && /\*\*Not run:\*\* typecheck, test/.test(md), 'the report says not run, and names the project checks that have no record', md);
  ok(/Not run\./.test(md.split('Browser verification')[1] ?? '') && /No scan result is recorded/.test(md), 'VerifyApp and scans: not run / no record', md);
  ok(renderEvidenceShort(p) === 'Checks: not run: typecheck, test', 'the commit line does not say verified', renderEvidenceShort(p));
  ok(renderEvidenceShort(buildEvidence([])) === 'Verified: no check run is recorded.', "and with the project's checks unknown it says only that none is recorded", renderEvidenceShort(buildEvidence([])));
}

console.log('\n── A worked log ──');
let rich;
{
  const { events, ev } = log();
  ev('user/message', { turn: 1, content: 'Fix the  rounding bug in cart totals\nand add a test', source: { kind: 'human' } });
  ev('request/header', { header: { provider: 'mock', model: 'mock-model', systemHash: 'h', tools: [] }, reason: 'initial' });
  ev('turn/start', { turn: 1 });
  ev('assistant/message', { turn: 1, step: 1, content: '', toolCalls: [], usage: { inputTokens: 1000, outputTokens: 200, cachedTokens: 600 } });
  ev('tool/call', { turn: 1, step: 1, callId: 'w1', name: 'Edit', arguments: JSON.stringify({ file_path: '/proj/src/cart.ts', old_string: 'a', new_string: 'b' }) });
  ev('tool/decision', { callId: 'w1', name: 'Edit', decision: 'approved', by: 'person' });
  ev('tool/result', { turn: 1, step: 1, callId: 'w1', name: 'Edit', content: 'ok' });
  ev('tool/call', { turn: 1, step: 2, callId: 'b1', name: 'Bash', arguments: JSON.stringify({ command: 'rm -rf /' }) });
  ev('tool/decision', { callId: 'b1', name: 'Bash', decision: 'denied', by: 'policy', reason: 'BLOCKED: recursive delete of the root' });
  ev('tool/result', { turn: 1, step: 2, callId: 'b1', name: 'Bash', content: '{"error":"BLOCKED: recursive delete of the root"}', isError: true });
  ev('check/run', { name: 'typecheck', command: 'npm run typecheck', outcome: 'passed', exitCode: 0, ms: 1200 });
  ev('check/run', { name: 'test', command: 'npm run test', outcome: 'failed', exitCode: 1, ms: 4100, tests: { runner: 'node:test', passed: 10, failed: 1, skipped: 0, failures: ['rounds half up'] }, retry: { basis: 'tests', tests: ['rounds half up'], passed: false } });
  ev('tool/call', { turn: 1, step: 3, callId: 'w2', name: 'Edit', arguments: JSON.stringify({ file_path: '/proj/src/cart.ts', old_string: 'b', new_string: 'c' }) });
  ev('tool/result', { turn: 1, step: 3, callId: 'w2', name: 'Edit', content: 'ok' });
  ev('check/run', { name: 'test', command: 'npm run test', outcome: 'flaky', exitCode: 1, ms: 4000, tests: { runner: 'node:test', passed: 10, failed: 1, skipped: 0, failures: ['login redirects'] }, retry: { basis: 'tests', tests: ['login redirects'], passed: true, flaky: ['login redirects'] } });
  ev('check/run', { name: 'security', command: 'built-in', outcome: 'passed', exitCode: null, ms: 300, builtin: 'security', findings: { secrets: 0, high: 0, medium: 1, advisories: 0 } });
  ev('tool/call', { turn: 1, step: 4, callId: 'v1', name: 'VerifyApp', arguments: '{}' });
  ev('tool/result', { turn: 1, step: 4, callId: 'v1', name: 'VerifyApp', content: 'PASSED — http://localhost:3000 loads and works.\nconsole: 0 errors' });
  ev('tool/call', { turn: 1, step: 4, callId: 'd1', name: 'DependencyAudit', arguments: '{}' });
  ev('tool/result', { turn: 1, step: 4, callId: 'd1', name: 'DependencyAudit', content: '1 advisory (moderate) in lodash\n- GHSA-xxxx lodash <4.17.21' });
  ev('safety/finding', { turn: 1, control: 'test-tamper', rule: 'skip-marker-added', severity: 'medium', outcome: 'nudged', file: 'src/cart.test.ts', line: 12, detail: 'a .skip was added' });
  ev('tool/call', { turn: 1, step: 5, callId: 't1', name: 'TodoWrite', arguments: JSON.stringify({ todos: [{ title: 'add the rounding test', status: 'done' }, { title: 'update the changelog', status: 'pending' }] }) });
  ev('agent/spawn', { agentId: 'a1', agentType: 'explore', description: 'find rounding helpers', model: 'mock-model', depth: 1 });
  ev('agent/done', { agentId: 'a1', status: 'failed', toolCalls: 3, ms: 900, inputTokens: 5000, outputTokens: 100, error: 'boom' });
  ev('turn/end', { turn: 1, reason: { kind: 'aborted', cause: 'cost limit' } });
  rich = events;

  const p = buildEvidence(events, { root: '/proj', projectChecks: ['typecheck', 'lint', 'test', 'security'], sessionId: 'abc' });
  const md = renderEvidenceMarkdown(p);

  ok(p.goal?.source === 'first message' && p.goal.text === 'Fix the rounding bug in cart totals and add a test', 'goal: the first human message, whitespace collapsed', p.goal);
  ok(p.checks.ran.length === 4 && p.checks.latest.length === 3, 'every run is listed; the latest per check is tracked', p.checks.latest.map(c => `${c.name}:${c.outcome}`));
  const typecheck = p.checks.latest.find(c => c.name === 'typecheck');
  ok(typecheck.editsAfter === 1 && /typecheck last ran before 1 edit/.test(p.open.gaps.join(' ')), 'a check that ran before a later edit is marked, and listed as a gap', p.open.gaps);
  ok(p.checks.notRun.join() === 'lint', 'only the project check with no record is "not run"', p.checks.notRun);
  ok(/\| test \| `npm run test` \| 1 \| FAILED \(failed again on re-run\)/.test(md), 'a check that failed twice says so, with its exit code', md);
  ok(/FLAKY — failed, then passed on a re-run: login redirects/.test(md), 'a flaky check says FLAKY, with the test', md);
  ok(/\| security \| `built-in` \| — \|/.test(md) && /secrets 0, high 0, medium 1, advisories 0/.test(md), 'the built-in security check has no exit code and shows its counts', md);
  ok(p.verifyApp.length === 1 && p.verifyApp[0].verdict === 'passed' && /console: 0 errors/.test(renderEvidenceMarkdown(p)), 'VerifyApp: the verdict and what it said', p.verifyApp);
  ok(p.scans.some(s => s.kind === 'DependencyAudit' && /1 advisory/.test(s.result)) && p.scans.some(s => s.kind === 'security check') && p.scans.some(s => s.kind === 'test-tamper' && /skip-marker-added/.test(s.findings[0])), 'scans: dependency audit, security check and the safety findings of ADR 0033', p.scans);
  ok(p.decisions.approvedByPerson[0]?.name === 'Edit' && p.decisions.deniedByPolicy[0]?.reason.includes('BLOCKED'), 'approvals by a person and denials by policy, with the reason', p.decisions);
  ok(p.models.length === 1 && p.models[0].requests === 1 && p.models[0].inputTokens === 1000 && p.cost.estimated === true && p.cost.usd > 0 && p.cost.delegatedUsd > 0, 'models and an estimated cost, delegated spend apart', { models: p.models, cost: p.cost });
  ok(p.open.todos.length === 1 && p.open.todos[0].title === 'update the changelog', 'open todos: only the unfinished one', p.open.todos);
  ok(p.open.gaps.some(g => /delegated explore agent failed/.test(g)) && p.open.gaps.some(g => /last turn ended: aborted \(cost limit\)/.test(g)) && p.open.gaps.some(g => /own logs/.test(g)), 'gaps: the failed delegation, the aborted turn, and that sub-agent checks are not counted', p.open.gaps);
  ok(p.files.source === 'log' && p.files.list[0].path === 'src/cart.ts', 'with no git facts, the files written come from the log and say they have no counts', p.files);
  ok(!FORBIDDEN.test(md) && !FORBIDDEN.test(renderEvidenceShort(p)), 'no authorship, credit or generated-by line in either form', null);
  ok(/^Checks: failing: |^Verified: /.test(renderEvidenceShort(p)) && /flaky: test/.test(renderEvidenceShort(p)) && /not run: lint/.test(renderEvidenceShort(p)), 'the commit-body line: what is verified, flaky, and not run', renderEvidenceShort(p));
  ok(JSON.parse(renderEvidence(p, 'json')).schema === 1, 'JSON form parses and is versioned', null);
}

console.log('\n── Older logs and awkward input ──');
{
  // Before this release a refusal was only in the result text; no tool/decision exists.
  const { events, ev } = log();
  ev('user/message', { turn: 1, content: 'x', source: { kind: 'human' } });
  ev('tool/call', { turn: 1, step: 1, callId: 'o1', name: 'Write', arguments: '{}' });
  ev('tool/result', { turn: 1, step: 1, callId: 'o1', name: 'Write', content: '{"error":"User denied this tool call."}', isError: true });
  ev('tool/call', { turn: 1, step: 1, callId: 'o2', name: 'Bash', arguments: '{}' });
  ev('tool/result', { turn: 1, step: 1, callId: 'o2', name: 'Bash', content: '{"error":"BLOCKED: nope"}', isError: true });
  const p = buildEvidence(events);
  ok(p.decisions.deniedByPerson[0]?.name === 'Write' && p.decisions.deniedByPolicy[0]?.name === 'Bash', 'refusals are recovered from result text when no decision event exists', p.decisions);
  ok(p.checks.notRun === undefined && !/Not run:/.test(renderEvidenceMarkdown(p)), 'unknown project checks: nothing is claimed unrun', p.checks);

  const goalLog = log();
  goalLog.ev('user/message', { turn: 1, content: 'first', source: { kind: 'human' } });
  goalLog.ev('goal/set', { text: 'Ship the invoice export', status: 'active' });
  ok(buildEvidence(goalLog.events).goal?.source === 'goal', 'a standing goal outranks the first message', null);

  const pipe = log();
  pipe.ev('check/run', { name: 'a|b', command: 'x | y', outcome: 'passed', exitCode: 0, ms: 1 });
  ok(!/\| a\|b \|/.test(renderEvidenceMarkdown(buildEvidence(pipe.events))), 'a pipe in a name cannot break the table', null);

  const unknown = log();
  unknown.ev('check/run', { name: 'typecheck', command: 't', outcome: 'passed', exitCode: 0, ms: 1 });
  unknown.ev('future/event', { anything: true });
  ok(buildEvidence(unknown.events).checks.ran.length === 1, 'an event type this version does not know is ignored', null);
}

console.log('\n── Git: counts against a base ──');
{
  const repo = tmp('evidence-git');
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 't@example.com'); git(repo, 'config', 'user.name', 't');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'one\ntwo\nthree\n');
  fs.writeFileSync(path.join(repo, 'b.txt'), 'keep\n');
  git(repo, 'add', '-A'); git(repo, 'commit', '-q', '-m', 'base');
  git(repo, 'switch', '-q', '-c', 'feature');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'one\nTWO\nthree\nfour\n');       // +2 -1
  git(repo, 'add', '-A'); git(repo, 'commit', '-q', '-m', 'committed change');
  fs.writeFileSync(path.join(repo, 'b.txt'), 'keep\nmore\n');                  // +1, uncommitted
  fs.writeFileSync(path.join(repo, 'new.txt'), 'x\ny\n');                      // untracked, 2 lines
  fs.writeFileSync(path.join(repo, 'bin.dat'), Buffer.from([0, 1, 2, 3]));     // untracked binary

  const facts = await gatherGit(repo);
  const by = Object.fromEntries((facts?.files ?? []).map(x => [x.path, x]));
  ok(facts && by['a.txt']?.added === 2 && by['a.txt'].removed === 1, 'a committed change counts against the merge base', by['a.txt']);
  ok(by['b.txt']?.added === 1 && by['new.txt']?.added === 2 && by['new.txt'].untracked && by['bin.dat']?.binary, 'uncommitted, untracked and binary files are all there', by);
  const p = buildEvidence([], { git: facts, root: repo });
  ok(p.files.source === 'git' && p.files.added === 5 && p.files.removed === 1 && p.files.list.length === 4, 'totals add up', p.files);
  ok(await gatherGit(tmp('evidence-nogit')) === undefined, 'a directory that is not a git work tree has no git facts', null);
  ok(await gatherGit(repo, 'no-such-ref') === undefined, 'an unknown base ref is not guessed', null);
  ok(await gatherGit(repo, '--output=owned.txt') === undefined && !fs.existsSync(path.join(repo, 'owned.txt')), 'a base that git could read as an option is refused before git sees it', null);
  const vs = await gatherGit(repo, 'HEAD');
  ok(vs.files.length === 3 && !vs.files.some(x => x.path === 'a.txt'), 'an explicit base of HEAD shows only the uncommitted work', vs.files.map(x => x.path));
  const marked = buildEvidence([{ seq: 1, type: 'tool/call', timestamp: 1, data: { turn: 1, step: 1, callId: 'c', name: 'Write', arguments: JSON.stringify({ file_path: path.join(repo, 'b.txt') }) } }], { git: facts, root: repo });
  ok(marked.files.list.find(x => x.path === 'b.txt').bySession === true && marked.files.list.find(x => x.path === 'a.txt').bySession === false, 'a file is marked "written this session" only if the log wrote it', marked.files.list.map(x => [x.path, x.bySession]));
  fs.rmSync(repo, { recursive: true, force: true });
}

console.log('\n── The tool, the persisted log and the route ──');
{
  ok(groupOf('Evidence') === 'evidence' && isDeferred('Evidence', new Set()), 'Evidence is deferred: its schema is not sent until a request loads the group', groupOf('Evidence'));
  ok(groupsForRequest('write the PR description for this').includes('evidence') && groupsForRequest('draft the commit message').includes('evidence') && groupsForRequest('what did you verify?').includes('evidence'), 'a request about a PR, a commit or what was verified loads it', null);
  ok(!groupsForRequest('rename the variable').includes('evidence'), 'and an unrelated request does not', null);
  const none = await runInContext({ cwd: process.cwd() }, () => evidenceTool({}));
  ok(/has none/.test(none), 'a run with no session log says so instead of inventing a report', none);

  const proj = tmp('evidence-tool');
  const { events, ev } = log();
  ev('user/message', { turn: 1, content: 'add a feature', source: { kind: 'human' } });
  ev('check/run', { name: 'test', command: 'npm run test', outcome: 'passed', exitCode: 0, ms: 5, tests: { runner: 'node:test', passed: 4, failed: 0, skipped: 0, failures: [] } });
  const handle = { events: () => events, record: (t, d) => ev(t, d) };
  const md = await runInContext({ cwd: proj, sessionId: 's1', sessionLog: handle }, () => evidenceTool({}));
  ok(/## Change evidence/.test(md) && /npm run test/.test(md) && /4 passed/.test(md), 'the tool reports the live log of its own run', md);
  const short = await runInContext({ cwd: proj, sessionId: 's1', sessionLog: handle }, () => evidenceTool({ format: 'short' }));
  ok(/^Verified: test \(4 passed\)/.test(short) && /Do not add authorship/.test(short), 'short form for a commit body, with the instruction not to add credit lines', short);
  const viaDispatch = await runInContext({ cwd: proj, sessionId: 's1', sessionLog: handle }, () => executeTool('Evidence', { format: 'short' }));
  ok(/^Verified:/.test(String(viaDispatch)), 'and it is reachable by name through the tool dispatcher', viaDispatch);

  // Persisted round trip: write a real session log, read it back through the disk path.
  const opened = await openSession('evid-disk', proj);
  opened.session.append('user/message', { turn: 1, content: 'persisted goal', source: { kind: 'human' } });
  opened.session.append('check/run', { name: 'build', command: 'npm run build', outcome: 'passed', exitCode: 0, ms: 9 });
  await opened.close();
  const disk = await packetFromDisk({ root: proj, sessionId: 'evid-disk' });
  ok(disk.ok && disk.packet.goal?.text === 'persisted goal' && disk.packet.checks.ran[0].name === 'build' && disk.packet.session.id === 'evid-disk', 'a persisted session is read back into a packet', disk);
  const latest = await packetFromDisk({ root: proj });
  ok(latest.ok && latest.packet.session.id === 'evid-disk', 'with no id, the most recent session of the project', latest.ok && latest.packet.session);
  const bad = await packetFromDisk({ root: proj, sessionId: '../../settings' });
  ok(!bad.ok && /invalid session id/.test(bad.error), 'a session id that could leave the directory is refused', bad);
  ok(!(await packetFromDisk({ root: tmp('evidence-empty') })).ok, 'a project with no sessions says so', null);

  const known = async () => true; const unknown = async () => false;
  const allowed = await evidenceAnswer(new URLSearchParams({ path: proj, session: 'evid-disk', format: 'short' }), { isKnownProject: known });
  ok(allowed.status === 200 && /^Verified: build/.test(allowed.body.text) && allowed.body.packet.schema === 1, 'the route answers for a registered project', allowed);
  ok((await evidenceAnswer(new URLSearchParams({ path: proj }), { isKnownProject: unknown })).status === 403, 'and refuses a folder that is not a registered project', null);
  ok((await evidenceAnswer(new URLSearchParams({}), { isKnownProject: known })).status === 400, 'a missing path is a 400', null);
  ok((await evidenceAnswer(new URLSearchParams({ path: proj, base: '--output=x' }), { isKnownProject: known })).status === 400, 'a base ref that looks like a git option is refused', null);
  ok((await evidenceAnswer(new URLSearchParams({ path: proj, session: '../x' }), { isKnownProject: known })).status === 400, 'an unsafe session id is a 400', null);
  fs.rmSync(proj, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
