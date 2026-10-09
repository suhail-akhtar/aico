/**
 * Iteration <-> sprint sync for GitHub (ADR 0039 section 4, phase 5): the provider-generic
 * module (src/connections/iterations.ts) driven by the REAL GitHub adapter against a loopback
 * mock forge, the real vault and store and a real Delivery board. The Azure DevOps half of the same
 * module is exercised in scripts/connections-azure-test.mjs; this file covers what GitHub adds:
 *
 *  - **Projects v2 iterations** become sprints (the current and the next one), with their
 *    membership and an "Estimate" number field read from the board in one GraphQL request;
 *  - **milestones** (a due date only) stand in when there is no Projects board: the sprint runs
 *    from today to the due date, and an issue's milestone is its sprint;
 *  - story points from an `sp:3` label still work, and a person's planning in AICO that GitHub
 *    cannot be told (a Projects v2 iteration is set on the board; the API this adapter uses
 *    cannot write it) is said once in plain words and never turned into a wrong write;
 *  - a Projects read that fails does NOT read as "nothing is in a sprint": membership is left alone;
 *  - the sprint switch is a person's: with it off no iteration is even requested.
 *
 * Part of `npm test`. No model, no network beyond 127.0.0.1, no real GitHub; fixtures are generated
 * here from the documented GraphQL and REST shapes. The only credential is an obviously fake canary.
 */

import { testHome } from './lib/test-home.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { T } from './lib/dist.mjs';
import { startMockForge } from './lib/mock-forge.mjs';

const { ConnService, ConnSync, ConnIterations: Iter, Delivery: D, DeliveryScrum: Scrum, configureVault, memoryKeyProvider, registerBuiltinAdapters, resetConnectionHttpForTest } = T;

let pass = 0; let fail = 0;
function ok(cond, label, detail) {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}${detail !== undefined ? ` - ${JSON.stringify(detail).slice(0, 700)}` : ''}`); }
}

const TOKEN = 'ghp_Can4ryIterTok0123456789abcdefABCD02'; // standards-allow: secret (test canary)
const tmpRoot = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'aico-iter-')));
process.on('exit', () => { try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* best effort */ } });
const sh = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const git = (cwd, ...args) => sh('git', args, cwd);
let seq = 0;
function makeProject() {
  const dir = path.join(tmpRoot, `proj-${++seq}`);
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.name', 'Test Owner'); git(dir, 'config', 'user.email', 'owner@example.test'); git(dir, 'config', 'commit.gpgsign', 'false'); git(dir, 'config', 'core.autocrlf', 'false');
  fs.writeFileSync(path.join(dir, 'README.md'), 'one\n'); fs.writeFileSync(path.join(dir, '.gitignore'), '.aico/\n');
  git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', 'chore: initial');
  return fs.realpathSync.native(dir);
}
async function forgeWith(scenarios) {
  const dir = fs.mkdtempSync(path.join(tmpRoot, 'gen-'));
  for (const [name, routes] of Object.entries(scenarios)) {
    fs.mkdirSync(path.join(dir, name), { recursive: true });
    fs.writeFileSync(path.join(dir, name, 'routes.json'), JSON.stringify({ prefix: '', routes }));
  }
  return startMockForge({ fixtures: dir, scenario: Object.keys(scenarios)[0], requireAuth: true, token: TOKEN });
}

registerBuiltinAdapters();
configureVault({ dir: path.join(testHome, 'vault'), keyProvider: memoryKeyProvider() });
Iter.setTodayForTest('2026-10-09');

const R = '/api/v3/repos/octo-org/widgets';
const repoBody = { id: 5001, name: 'widgets', full_name: 'octo-org/widgets', private: false, default_branch: 'main', has_issues: true, permissions: { push: true } };
const issue = (number, over = {}) => ({
  id: 6000 + number, number, title: `Issue ${number}`, state: 'open', body: '', user: { login: 'octo-bot' }, labels: [{ name: 'aico' }], assignees: [], milestone: null,
  html_url: `https://forge.test/octo-org/widgets/issues/${number}`, updated_at: `2026-10-0${number % 9}T09:00:00Z`, ...over,
});
const projectBody = (extra = {}) => ({ data: { repository: { projectsV2: { nodes: [{
  id: 'PVT_1', title: 'Roadmap', url: 'https://forge.test/orgs/octo-org/projects/4',
  field: { __typename: 'ProjectV2IterationField', id: 'F1', name: 'Iteration', configuration: {
    iterations: [
      { id: 'it_100', title: 'Iteration 3', startDate: '2026-10-05', duration: 14 },
      { id: 'it_101', title: 'Iteration 4', startDate: '2026-10-19', duration: 14 },
      { id: 'it_102', title: 'Iteration 5', startDate: '2026-11-02', duration: 14 },
    ],
    completedIterations: [{ id: 'it_099', title: 'Iteration 2', startDate: '2026-09-21', duration: 14 }],
  } },
  ...extra,
}] } } } });
const membersBody = (nodes) => ({ data: { repository: { projectsV2: { nodes: [{ items: { nodes } }] } } } });
const card = (number, iterationId, estimate) => ({
  content: { __typename: 'Issue', number },
  iteration: iterationId ? { __typename: 'ProjectV2ItemFieldIterationValue', iterationId } : null,
  estimate: estimate !== undefined ? { __typename: 'ProjectV2ItemFieldNumberValue', number: estimate } : null,
  points: null,
});

// ══ 1. PROJECTS V2 ITERATIONS ═════════════════════════════════════════════
console.log('\n-- GitHub Projects v2: iterations become sprints, with membership and the Estimate field --');
{
  D.resetDeliveryForTest();
  resetConnectionHttpForTest();
  const base = (issues, members) => [
    { path: R, status: 200, body: repoBody },
    { path: `${R}/issues`, status: 200, body: issues },
    { path: `${R}/milestones`, status: 200, body: [{ number: 2, title: 'v1.0', state: 'open', due_on: '2026-10-30T07:00:00Z', html_url: 'https://forge.test/m/2', open_issues: 2, closed_issues: 0 }] },
    { method: 'POST', path: '/api/graphql', bodyIncludes: 'ProjectV2ItemFieldIterationValue', ...members },
    { method: 'POST', path: '/api/graphql', bodyIncludes: 'ProjectV2IterationField', status: 200, body: projectBody() },
  ];
  const forge = await forgeWith({
    v1: base([issue(11, { title: 'Cache invalidation' }), issue(12, { labels: [{ name: 'aico' }, { name: 'sp:3' }] })], { status: 200, body: membersBody([card(11, 'it_100', 5), card(12, null, undefined)]) }),
    // The board moved issue 11 to the next iteration and re-estimated it.
    v2: base([issue(11, { title: 'Cache invalidation', updated_at: '2026-10-08T09:00:00Z' }), issue(12, { labels: [{ name: 'aico' }, { name: 'sp:3' }] })], { status: 200, body: membersBody([card(11, 'it_101', 8), card(12, null, undefined)]) }),
    // The Projects read fails (a token without Projects: read).
    v3: base([issue(11, { title: 'Cache invalidation', updated_at: '2026-10-08T09:00:00Z' }), issue(12, { labels: [{ name: 'aico' }, { name: 'sp:3' }] })], { status: 200, body: { data: null, errors: [{ type: 'FORBIDDEN', message: 'Resource not accessible by personal access token' }] } }),
  });
  const p = makeProject();
  const conn = await ConnService.createConnection({ provider: 'github', baseUrl: forge.url, insecureHttp: true, by: 'person', label: 'Mock GitHub' });
  await ConnService.storeToken(conn.id, TOKEN);
  await ConnService.mapProject({ project: p, connection: conn.id, repo: { owner: 'octo-org', name: 'widgets' }, workItems: { source: 'label', value: 'aico' }, iterations: 'native', by: 'person' });
  const sprints = () => D.boardState(p).sprints ?? [];
  const byRemote = (id) => D.boardState(p).tasks.find(t => t.remote?.id === id);
  const named = (n) => sprints().find(s => s.name === n);
  const writes = (m) => forge.requests.slice(m).filter(r => r.method !== 'GET' && r.path !== '/api/graphql');

  let m = forge.requests.length;
  const r1 = await ConnSync.syncProject(p);
  ok(r1.imported === 2 && r1.sprints >= 2, 'two issues imported, and the current and next Projects iterations became sprints', r1);
  const s3 = named('Iteration 3'); const s4 = named('Iteration 4');
  ok(sprints().length === 2 && !named('Iteration 2') && !named('Iteration 5') && !named('v1.0'), 'only the current and the next: not the completed one, not the one after, not a milestone while a board has iterations', sprints().map(s => s.name));
  ok(s3.start === '2026-10-05' && s3.end === '2026-10-18' && s3.status === 'planned' && s3.remote.kind === 'iteration' && s3.remote.id === 'it_100', 'dates come from startDate and duration (14 days: the 5th to the 18th); the sprint is PLANNED and linked', s3);
  ok(byRemote('11').sprintId === s3.id && byRemote('11').estimate === 5, 'issue 11 is in Iteration 3 on the board, so its task is, with the Estimate field as its points');
  ok(byRemote('12').sprintId === undefined && byRemote('12').estimate === 3, 'issue 12 is on no iteration; its sp:3 label is its estimate');
  ok(D.boardState(p).tasks.every(t => t.status === 'backlog') && sprints().every(s => !s.startedAt), 'nothing was started and nothing promoted');
  ok(writes(m).length === 0, 'GitHub received no write: only reads and the GraphQL queries');
  const queries = forge.requests.slice(m).filter(r => r.path === '/api/graphql');
  ok(queries.length >= 2 && queries.every(r => r.method === 'POST' && typeof r.body.query === 'string' && r.body.variables.owner === 'octo-org'), 'the board is read with plain GraphQL POSTs (no SDK)');
  ok(queries.some(r => /fieldValueByName\(name:"Estimate"\)/.test(r.body.query) && /items\(first:100\)/.test(r.body.query)), 'one request carries the iteration and the number of every card');

  // A person plans issue 12 into the next sprint in AICO. GitHub's API cannot set a Projects iteration; it is said, not faked.
  await Scrum.commitSprint(p, s4.id, [byRemote('12').id]);
  m = forge.requests.length;
  const r2 = await ConnSync.syncProject(p);
  ok(writes(m).length === 0 && r2.pushed === 0, 'a Projects v2 iteration is never written through the issues API: no request was made');
  ok(/project board/i.test(r2.message ?? ''), 'and the sync says why in plain words', r2.message);
  ok(byRemote('12').sprintId === s4.id, 'the person\'s local plan stays as it is');

  // The board changes: the remote wins.
  forge.setScenario('v2');
  m = forge.requests.length;
  await ConnSync.syncProject(p);
  ok(byRemote('11').sprintId === s4.id && byRemote('11').estimate === 8, 'issue 11 moved to Iteration 4 and was re-estimated on the board: the task followed');
  ok(writes(m).length === 0, 'and nothing was written back');

  // The Projects read fails: membership is left alone, not emptied.
  forge.setScenario('v3');
  const before = { eleven: byRemote('11').sprintId, twelve: byRemote('12').sprintId };
  const r3 = await ConnSync.syncProject(p);
  ok(byRemote('11').sprintId === before.eleven && byRemote('12').sprintId === before.twelve, 'when the board cannot be read, no task is taken out of its sprint (unknown is not "none")');
  ok(/Projects boards could not be read/i.test(r3.message ?? ''), 'and the person is told', r3.message);

  // The switch is a person's.
  forge.setScenario('v1');
  await ConnService.mapProject({ project: p, connection: conn.id, iterations: 'off', by: 'person' });
  m = forge.requests.length;
  await ConnSync.syncProject(p);
  ok(!forge.requests.slice(m).some(r => r.path === '/api/graphql' || r.path.endsWith('/milestones')), 'with sprint sync off neither the board nor the milestones are read');
  await ConnService.removeConnection(conn.id);
  await forge.stop();
}

// ══ 2. MILESTONES ════════════════════════════════════════════════════════
console.log('\n-- GitHub milestones: a due date makes a sprint, and the issue\'s milestone is its sprint --');
{
  D.resetDeliveryForTest();
  resetConnectionHttpForTest();
  const noProjects = { method: 'POST', path: '/api/graphql', status: 200, body: { data: { repository: { projectsV2: null } } } };
  const forge = await forgeWith({
    v1: [
      { path: R, status: 200, body: repoBody },
      { path: `${R}/issues`, status: 200, body: [
        issue(21, { title: 'In the milestone', milestone: { number: 2, title: 'v1.0', due_on: '2026-10-30T07:00:00Z' } }),
        issue(22, { title: 'No milestone' }),
      ] },
      { path: `${R}/milestones`, status: 200, body: [
        { number: 2, title: 'v1.0', state: 'open', due_on: '2026-10-30T07:00:00Z', html_url: 'https://forge.test/m/2', open_issues: 1, closed_issues: 0 },
        { number: 3, title: 'v2.0', state: 'open', due_on: '2027-06-30T07:00:00Z', html_url: 'https://forge.test/m/3', open_issues: 0, closed_issues: 0 },
        { number: 1, title: 'v0.9', state: 'closed', due_on: '2026-09-01T07:00:00Z', html_url: 'https://forge.test/m/1', open_issues: 0, closed_issues: 4 },
      ] },
      { method: 'PATCH', path: `${R}/issues/:n`, status: 200, body: issue(22, { milestone: { number: 2, title: 'v1.0' } }) },
      { path: `${R}/issues/:n`, status: 200, body: issue(22) },
      noProjects,
    ],
    // The due date moves out by a few days.
    v2: [
      { path: R, status: 200, body: repoBody },
      { path: `${R}/issues`, status: 200, body: [issue(21, { title: 'In the milestone', milestone: { number: 2, title: 'v1.0', due_on: '2026-11-03T07:00:00Z' }, updated_at: '2026-10-09T09:00:00Z' }), issue(22, { title: 'No milestone' })] },
      { path: `${R}/milestones`, status: 200, body: [{ number: 2, title: 'v1.0 (final)', state: 'open', due_on: '2026-11-03T07:00:00Z', html_url: 'https://forge.test/m/2', open_issues: 1, closed_issues: 0 }] },
      { path: `${R}/issues/:n`, status: 200, body: issue(22) },
      noProjects,
    ],
  });
  const p = makeProject();
  const conn = await ConnService.createConnection({ provider: 'github', baseUrl: forge.url, insecureHttp: true, by: 'person', label: 'Mock GitHub' });
  await ConnService.storeToken(conn.id, TOKEN);
  await ConnService.mapProject({ project: p, connection: conn.id, repo: { owner: 'octo-org', name: 'widgets' }, workItems: { source: 'label', value: 'aico' }, iterations: 'native', by: 'person' });
  const sprints = () => D.boardState(p).sprints ?? [];
  const byRemote = (id) => D.boardState(p).tasks.find(t => t.remote?.id === id);

  await ConnSync.syncProject(p);
  const v1 = sprints().find(s => s.name === 'v1.0');
  ok(!!v1 && v1.start === '2026-10-09' && v1.end === '2026-10-30' && v1.remote.kind === 'milestone' && v1.remote.id === '2' && v1.status === 'planned', 'the nearest open milestone is a sprint from today to its due date', v1);
  ok(sprints().length === 1, 'a milestone a year away is not a sprint, and a closed one is not imported', sprints().map(s => `${s.name} ${s.start}..${s.end}`));
  ok(byRemote('21').sprintId === v1.id && byRemote('22').sprintId === undefined, 'an issue in the milestone is in the sprint');

  // A person plans issue 22 into the sprint; for a milestone GitHub CAN be told.
  await Scrum.commitSprint(p, v1.id, [byRemote('22').id]);
  let m = forge.requests.length;
  const r2 = await ConnSync.syncProject(p);
  const patch = forge.requests.slice(m).find(r => r.method === 'PATCH');
  ok(!!patch && patch.path === `${R}/issues/22` && patch.body.milestone === 2 && Object.keys(patch.body).length === 1 && r2.pushed === 1, 'the planning is pushed once, as the issue\'s milestone and nothing else', patch?.rawBody);
  ok(byRemote('22').remote.iteration === '2', 'and the merge base moved');
  m = forge.requests.length;
  await ConnSync.syncProject(p);
  ok(!forge.requests.slice(m).some(r => r.method === 'PATCH'), 'syncing again pushes nothing');

  // The due date moved and the milestone was renamed: the platform owns both.
  forge.setScenario('v2');
  await ConnSync.syncProject(p);
  const renamed = sprints().find(s => s.remote?.id === '2');
  ok(renamed.name === 'v1.0 (final)' && renamed.end === '2026-11-03' && renamed.start === '2026-10-09', 'the renamed, re-dated milestone updated its sprint (the start day it was first imported stays)', renamed);
  ok(sprints().every(s => s.status === 'planned') && D.boardState(p).tasks.every(t => t.status === 'backlog'), 'still nothing started');
  await ConnService.removeConnection(conn.id);
  await forge.stop();
}

Iter.setTodayForTest(undefined);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
