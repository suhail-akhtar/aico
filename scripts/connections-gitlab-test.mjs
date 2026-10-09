/**
 * The GitLab adapter, tested offline (ADR 0039): GitLab-specific unit checks first (remote URL
 * parsing incl. nested groups and a server under a path, API base and hosts, the folding rules as
 * tables, scopes and extra power, the Merge click's plan), then the shared conformance script
 * (scripts/connections-conformance.mjs) against the loopback mock forge for the saas, ce-old,
 * limited-token, rate-limited and hostile scenarios, and GitLab-only checks on top (project paths
 * are URL-encoded, "merge when pipeline succeeds" only when asked, an iteration is set through
 * GraphQL, a draft is a title prefix).
 *
 * Part of `npm test`. No model, no network beyond 127.0.0.1, no real GitLab: the "forge" is
 * scripts/lib/mock-forge.mjs replaying hand-written fixtures from scripts/fixtures/connections/gitlab/
 * (documented API v4 shapes; the owner records real ones before GitLab is called supported). The
 * store is this process's own AICO_HOME and the vault key lives in memory. The only credential is
 * an obviously fake canary.
 */

// A store of this process's own: nothing below may touch ~/.aico. Must stay first.
import { testHome } from './lib/test-home.mjs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runConformance } from './connections-conformance.mjs';

const T = await import(process.env.AICO_TEST_DIST
  ? pathToFileURL(path.join(process.env.AICO_TEST_DIST, 'test-exports.js')).href
  : new URL('../dist-test/test-exports.js', import.meta.url).href);

const here = path.dirname(fileURLToPath(import.meta.url));
let passed = 0;
let failed = 0;
const failures = [];
function assert(cond, name) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; failures.push(name); console.log(`  ✗ ${name}`); }
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const TOKEN = 'glpat-Can4ry-Tok-7e3d9a41c0b5f268'; // standards-allow: secret (test canary)
const adapter = T.gitlabAdapter;
const P = T.GitlabAdapterParts;
const F = T.GitlabFold;
const S = T.GitlabScopes;

// ═══════════════════════════════════════════════════════════
console.log('\n══ L1. REMOTE URLS ══');
{
  const parse = (url, base) => adapter.parseRemote(url, base);
  const nested = { owner: 'acme/platform', name: 'widgets' };
  const flat = { owner: 'acme', name: 'widgets' };
  const gl = 'https://gitlab.com';
  const table = [
    ['https://gitlab.com/acme/widgets.git', gl, flat],
    ['https://gitlab.com/acme/widgets', gl, flat],
    ['https://gitlab.com/acme/platform/widgets.git', gl, nested],
    ['https://gitlab.com/a/b/c/d/widgets', gl, { owner: 'a/b/c/d', name: 'widgets' }],
    ['https://oauth2:fake-userinfo@gitlab.com/acme/platform/widgets.git', gl, nested],
    ['git@gitlab.com:acme/platform/widgets.git', gl, nested],
    ['git@gitlab.com:acme/widgets', gl, flat],
    ['ssh://git@gitlab.com/acme/platform/widgets.git', gl, nested],
    ['ssh://git@gitlab.com:22/acme/widgets.git', gl, flat],
    ['https://github.com/acme/widgets.git', gl, undefined],
    ['git@github.com:acme/widgets.git', gl, undefined],
    ['https://gitlab.com.evil.test/acme/widgets.git', gl, undefined],
    ['https://gitlab.com/acme', gl, undefined],
    ['https://gitlab.com/acme/widgets/-/merge_requests/3', gl, undefined],
    ['https://gitlab.com/acme/wid gets', gl, undefined],
    ['https://gitlab.com/acme/../widgets', gl, undefined],
    ['file:///srv/git/widgets.git', gl, undefined],
    ['C:\\repos\\widgets', gl, undefined],
    ['', gl, undefined],
    ['https://git.corp.test/acme/platform/widgets.git', 'https://git.corp.test', nested],
    ['git@git.corp.test:acme/widgets.git', 'https://git.corp.test', flat],
    ['https://gitlab.com/acme/widgets.git', 'https://git.corp.test', undefined],
    ['https://git.corp.test:8443/acme/widgets.git', 'https://git.corp.test:8443', flat],
    ['https://git.corp.test/acme/widgets.git', 'https://git.corp.test:8443', undefined],
    ['ssh://git@git.corp.test:2222/acme/widgets.git', 'https://git.corp.test', flat],
    // a server mounted under a path keeps it in https remotes
    ['https://corp.test/gitlab/acme/platform/widgets.git', 'https://corp.test/gitlab', nested],
    ['https://corp.test/other/acme/widgets.git', 'https://corp.test/gitlab', undefined],
    ['git@corp.test:acme/widgets.git', 'https://corp.test/gitlab', flat],
    ['http://127.0.0.1:4000/acme/widgets.git', 'http://127.0.0.1:4000', flat],
  ];
  const wrong = table.filter(([u, b, want]) => !same(parse(u, b), want));
  assert(wrong.length === 0, `parseRemote: ${table.length} forms (wrong: ${wrong.map(w => w[0]).join(' | ') || 'none'})`);
  const userinfo = parse('https://oauth2:fake-userinfo@gitlab.com/acme/platform/widgets.git', gl);
  assert(!JSON.stringify(userinfo).includes('fake-userinfo'), 'userinfo never reaches the parsed project');
}

// ═══════════════════════════════════════════════════════════
console.log('\n══ L2. API BASE, HOSTS, CLIENT OPTIONS ══');
{
  assert(adapter.apiBase({ baseUrl: 'https://gitlab.com' }) === 'https://gitlab.com/api/v4', 'gitlab.com REST base is /api/v4 on the same host');
  assert(adapter.apiBase({ baseUrl: 'https://gitlab.com/' }) === 'https://gitlab.com/api/v4', 'a trailing slash does not matter');
  assert(adapter.apiBase({ baseUrl: 'https://git.corp.test:8443' }) === 'https://git.corp.test:8443/api/v4', 'self-managed keeps a custom port');
  assert(adapter.apiBase({ baseUrl: 'https://corp.test/gitlab/' }) === 'https://corp.test/gitlab/api/v4', 'a server under a relative URL root keeps it');
  assert(P.gitlabGraphqlUrl({ baseUrl: 'https://corp.test/gitlab' }) === 'https://corp.test/gitlab/api/graphql', 'GraphQL lives beside the REST root');
  assert(same(adapter.hostsFor('https://gitlab.com'), ['gitlab.com']), 'hostsFor gitlab.com: one host (API and web are the same)');
  assert(same(adapter.hostsFor('https://git.corp.test:8443'), ['git.corp.test:8443']), 'hostsFor self-managed keeps the port');
  const o = adapter.clientOptions({ baseUrl: 'https://git.corp.test' });
  assert(o.apiBase === 'https://git.corp.test/api/v4' && o.auth.kind === 'bearer' && !o.auth.scheme, 'clientOptions: bearer auth on the v4 base');
  assert(adapter.id === 'gitlab' && adapter.gitUsername({}) === 'oauth2', 'the adapter is "gitlab" and git pairs the token with oauth2');
  let threw = false;
  try { adapter.apiBase({ baseUrl: 'not a url' }); } catch (e) { threw = e.name === 'ConnectionError'; }
  assert(threw, 'a base URL that is not a URL is a ConnectionError');
}

// ═══════════════════════════════════════════════════════════
console.log('\n══ L3. FOLDING RULES (tables) ══');
{
  const jobs = [
    ['success', false, 'success'], ['failed', false, 'failure'], ['failed', true, 'neutral'], ['canceled', false, 'failure'],
    ['skipped', false, 'skipped'], ['manual', false, 'neutral'], ['running', false, 'pending'], ['pending', false, 'pending'],
    ['created', false, 'pending'], ['waiting_for_resource', false, 'pending'], ['scheduled', false, 'pending'], ['preparing', false, 'pending'],
    ['something-new', false, 'neutral'], [undefined, false, 'neutral'],
  ];
  const badJobs = jobs.filter(([s, a, want]) => F.foldJobState(s, a) !== want).map(j => `${j[0]}/${j[1]}`);
  assert(badJobs.length === 0, `job states: ${jobs.length} cases (wrong: ${badJobs.join(' | ') || 'none'})`);

  const checks = [
    ['no jobs', [], 'none'],
    ['all success', [{ name: 'a', state: 'success' }], 'passing'],
    ['an allowed failure does not fail', [{ name: 'a', state: 'success' }, { name: 'b', state: 'neutral' }, { name: 'c', state: 'skipped' }], 'passing'],
    ['a failure', [{ name: 'a', state: 'failure' }], 'failing'],
    ['pending outranks success', [{ name: 'a', state: 'success' }, { name: 'b', state: 'pending' }], 'pending'],
    ['failure outranks pending', [{ name: 'a', state: 'failure' }, { name: 'b', state: 'pending' }], 'failing'],
  ];
  const badChecks = checks.filter(([, items, want]) => F.foldChecks(items).state !== want).map(c => c[0]);
  assert(badChecks.length === 0, `checks.state: ${checks.length} cases (wrong: ${badChecks.join(' | ') || 'none'})`);

  const mr = (o) => ({ iid: 1, state: 'opened', draft: false, user: { can_merge: true }, ...o });
  const merge = [
    [mr({ detailed_merge_status: 'mergeable' }), 'mergeable'],
    [mr({ detailed_merge_status: 'ci_must_pass' }), 'mergeable'],
    [mr({ detailed_merge_status: 'need_rebase' }), 'mergeable'],
    [mr({ detailed_merge_status: 'checking' }), 'unknown'],
    [mr({ detailed_merge_status: 'unchecked' }), 'unknown'],
    [mr({ detailed_merge_status: 'conflict' }), 'conflicting'],
    [mr({ detailed_merge_status: 'mergeable', has_conflicts: true }), 'conflicting'],
    [mr({ merge_status: 'can_be_merged' }), 'mergeable'],
    [mr({ merge_status: 'cannot_be_merged' }), 'conflicting'],
    [mr({ merge_status: 'checking' }), 'unknown'],
    [mr({ merge_status: 'cannot_be_merged_recheck' }), 'unknown'],
    [mr({ merge_status: 'unchecked' }), 'unknown'],
    [mr({}), 'unknown'],
    [mr({ state: 'merged', detailed_merge_status: 'not_open' }), 'unknown'],
    [mr({ state: 'closed', has_conflicts: true }), 'unknown'],
  ];
  const badMerge = merge.filter(([i, want]) => F.foldMergeable(i) !== want).map(m => JSON.stringify(m[0]));
  assert(badMerge.length === 0, `mergeable: ${merge.length} cases, checking is unknown (wrong: ${badMerge.join(' | ') || 'none'})`);

  const can = [
    [mr({ detailed_merge_status: 'mergeable' }), true],
    [mr({ detailed_merge_status: 'mergeable', user: { can_merge: false } }), false],
    [mr({ detailed_merge_status: 'mergeable', draft: true }), false],
    [mr({ detailed_merge_status: 'mergeable', title: 'Draft: x' }), false],
    [mr({ detailed_merge_status: 'mergeable', state: 'merged' }), false],
    [mr({ detailed_merge_status: 'mergeable', merge_when_pipeline_succeeds: true }), false],
    [mr({ detailed_merge_status: 'mergeable', auto_merge_enabled: true }), false],
    ...['ci_must_pass', 'ci_still_running', 'discussions_not_resolved', 'draft_status', 'not_approved', 'need_rebase', 'conflict', 'blocked_status', 'external_status_checks', 'requested_changes', 'checking', 'a_status_from_the_future']
      .map(s => [mr({ detailed_merge_status: s }), false]),
    // servers before detailed_merge_status: merge_status plus what it ignores
    [mr({ merge_status: 'can_be_merged' }), true],
    [mr({ merge_status: 'can_be_merged', head_pipeline: { id: 1, status: 'success' } }), true],
    [mr({ merge_status: 'can_be_merged', head_pipeline: { id: 1, status: 'running' } }), false],
    [mr({ merge_status: 'can_be_merged', head_pipeline: { id: 1, status: 'failed' } }), false],
    [mr({ merge_status: 'can_be_merged', blocking_discussions_resolved: false }), false],
    [mr({ merge_status: 'cannot_be_merged' }), false],
    [mr({ merge_status: 'checking' }), false],
    [mr({}), false],
  ];
  const badCan = can.filter(([i, want]) => F.foldCanMerge(i) !== want).map(c => JSON.stringify(c[0]));
  assert(badCan.length === 0, `canMerge: ${can.length} cases, only \`mergeable\` (or a clean old-server reading); an unknown status blocks (wrong: ${badCan.join(' | ') || 'none'})`);

  const auto = [
    [mr({ detailed_merge_status: 'ci_still_running' }), { kind: 'pipeline', available: true, armed: false }],
    [mr({ detailed_merge_status: 'ci_still_running', merge_when_pipeline_succeeds: true }), { kind: 'pipeline', available: false, armed: true }],
    [mr({ detailed_merge_status: 'ci_still_running', auto_merge_enabled: true }), { kind: 'pipeline', available: false, armed: true }],
    [mr({ detailed_merge_status: 'ci_still_running', draft: true }), undefined],
    [mr({ detailed_merge_status: 'ci_still_running', user: { can_merge: false } }), undefined],
    [mr({ detailed_merge_status: 'ci_still_running', has_conflicts: true }), undefined],
    [mr({ detailed_merge_status: 'ci_must_pass' }), undefined],
    [mr({ detailed_merge_status: 'not_approved' }), undefined],
    [mr({ detailed_merge_status: 'mergeable' }), undefined],
    [mr({ state: 'merged', detailed_merge_status: 'ci_still_running' }), undefined],
    [mr({ merge_status: 'can_be_merged', head_pipeline: { id: 1, status: 'running' } }), { kind: 'pipeline', available: true, armed: false }],
  ];
  const badAuto = auto.filter(([i, want]) => !same(F.foldAutoMerge(i), want)).map(a => JSON.stringify(a[0]));
  assert(badAuto.length === 0, `autoMerge: ${auto.length} cases, offered only when a running pipeline is the one obstacle (wrong: ${badAuto.join(' | ') || 'none'})`);

  const none = { state: 'none', approved: 0, changesRequested: 0 };
  const blockers = [
    [mr({ detailed_merge_status: 'ci_must_pass' }), [], none, /pipeline must succeed/],
    [mr({ detailed_merge_status: 'ci_still_running' }), [], none, /still running/],
    [mr({ detailed_merge_status: 'discussions_not_resolved' }), [], none, /unresolved discussions/],
    [mr({ detailed_merge_status: 'not_approved' }), [], { state: 'pending', approved: 0, changesRequested: 0, required: 2 }, /0 of 2 required approvals/],
    [mr({ detailed_merge_status: 'need_rebase' }), [], none, /rebased/],
    [mr({ detailed_merge_status: 'conflict' }), [], none, /conflicts/],
    [mr({ detailed_merge_status: 'draft_status' }), [], none, /draft/],
    [mr({ detailed_merge_status: 'checking' }), [], none, /not finished/],
    [mr({ detailed_merge_status: 'a_status_from_the_future' }), [], none, /GitLab says: a status from the future/],
    [mr({ detailed_merge_status: 'requested_changes' }), [], { state: 'changes', approved: 0, changesRequested: 1 }, /requested changes/],
    [mr({ detailed_merge_status: 'ci_must_pass' }), [{ name: 'build', state: 'failure' }], none, /Check failed: build/],
    [mr({ merge_status: 'cannot_be_merged' }), [], none, /conflicts/],
    [mr({ merge_status: 'checking' }), [], none, /not finished/],
    [mr({ merge_status: 'can_be_merged', blocking_discussions_resolved: false }), [], none, /unresolved discussions/],
    [mr({ detailed_merge_status: 'ci_still_running', merge_when_pipeline_succeeds: true }), [], none, /merge when the pipeline succeeds/],
    [mr({ detailed_merge_status: 'mergeable', user: { can_merge: false } }), [], none, /may not merge/],
  ];
  const badBlock = blockers.filter(([i, c, r, re]) => !F.foldBlockers(i, c, r).some(s => re.test(s))).map(b => String(b[3]));
  assert(badBlock.length === 0, `mergeBlockers: ${blockers.length} cases give plain sentences (missing: ${badBlock.join(' | ') || 'none'})`);
  assert(F.foldBlockers(mr({ detailed_merge_status: 'mergeable' }), [], none).length === 0 && F.foldBlockers(mr({ state: 'merged', detailed_merge_status: 'not_open' }), [], none).length === 0, 'a mergeable or finished MR has no blockers');

  const rv = (approved, required, o = {}) => F.foldMrReviews(mr(o), {
    approvals_required: required, approved_by: Array.from({ length: approved }, (_, i) => ({ user: { username: `u${i}` } })),
  });
  const reviews = [
    ['no approvals, none required', rv(0, 0), 'none', 0, 0, 0],
    ['a requested reviewer', rv(0, undefined, { reviewers: [{ username: 'x' }] }), 'pending', 0, 0, undefined],
    ['one approval, two required', rv(1, 2), 'pending', 1, 0, 2],
    ['two approvals, two required', rv(2, 2), 'approved', 2, 0, 2],
    ['an approval, none required', rv(1, 0), 'approved', 1, 0, 0],
    ['no approvals, one required', rv(0, 1), 'pending', 0, 0, 1],
    ['changes requested outrank approvals', rv(1, 1, { detailed_merge_status: 'requested_changes' }), 'changes', 1, 1, 1],
  ];
  const badRev = reviews.filter(([, got, state, a, c, req]) => got.state !== state || got.approved !== a || got.changesRequested !== c || got.required !== req).map(c => c[0]);
  assert(badRev.length === 0, `reviews: ${reviews.length} cases through the shared fold (wrong: ${badRev.join(' | ') || 'none'})`);
  assert(F.foldMrReviews(mr({}), undefined).required === undefined, 'approvals the token cannot read leave the requirement unknown');

  const pr = F.foldPull({
    connection: 'c1', now: '2026-10-09T00:00:00.000Z',
    mr: mr({ iid: 7, state: 'merged', detailed_merge_status: 'not_open', merge_commit_sha: 'abc1234', sha: 'h1', web_url: 'https://forge.test/a/b/-/merge_requests/7' }),
    jobs: [{ name: 'build', status: 'success' }], approvals: { approvals_required: 2, approved_by: [] }, protection: { protected: true },
  });
  assert(pr.connection === 'c1' && pr.id === '7' && pr.state === 'merged' && pr.mergedSha === 'abc1234' && pr.headSha === 'h1', 'foldPull: connection, iid as string, merged state, merge sha, head sha');
  assert(pr.protectedBase === true && pr.canMerge === false && pr.autoMerge === undefined && pr.observedAt === '2026-10-09T00:00:00.000Z', 'foldPull: protection feeds protectedBase; a merged MR is not mergeable and offers no auto-merge');
  const unreadable = F.foldPull({ connection: 'c1', mr: mr({ detailed_merge_status: 'not_approved' }), protection: { protected: false, unreadable: 'x' } });
  assert(unreadable.protectedBase === undefined && unreadable.reviews.required === undefined && unreadable.checks.state === 'none', 'foldPull: unreadable protection, approvals and jobs leave everything unknown, checks `none`');
  const squashed = F.foldPull({ connection: 'c1', mr: mr({ state: 'merged', squash_commit_sha: 'sq1', merge_commit_sha: null }) });
  assert(squashed.mergedSha === 'sq1', 'foldPull: a squash-merged MR reports the squash commit');
  const piped = F.foldPull({ connection: 'c1', mr: mr({ head_pipeline: { id: 9, status: 'failed', web_url: 'https://forge.test/p/9' } }), jobs: undefined });
  assert(piped.checks.state === 'failing' && piped.checks.items[0].name === 'Pipeline #9', 'foldPull: when jobs cannot be read the head pipeline stands in as the one check');
  assert(F.isDraft({ title: 'Draft: x' }) && F.isDraft({ title: '[Draft] x' }) && F.isDraft({ draft: true }) && F.isDraft({ work_in_progress: true }) && !F.isDraft({ title: 'Drafting a plan' }), 'isDraft: title prefixes and the flags, not the word in a sentence');

  const item = F.foldIssue({ iid: 3, title: 'T <!-- hidden -->', description: null, state: 'closed', labels: ['sp:3', { name: 'bug' }], assignees: [{ username: 'a' }], author: { username: 'u' }, updated_at: 'R', milestone: { id: 40, iid: 2, title: 'M' }, weight: 8 });
  assert(item.id === '3' && item.title === 'T' && item.body === '' && item.state === 'closed' && item.points === 8 && same(item.labels, ['sp:3', 'bug']) && item.milestone.id === '40' && item.rev === 'R' && item.iteration === '40', 'foldIssue: iid as id, sanitised title, weight over a label, milestone id, rev');
  const noWeight = F.foldIssue({ iid: 4, title: 'x', state: 'opened', labels: ['estimate:5'], weight: null });
  assert(noWeight.points === 5 && noWeight.state === 'open', 'foldIssue: a null weight falls back to an estimate label');
  const iterated = F.foldIssue({ iid: 5, title: 'x', state: 'opened', iteration: { id: 61 }, milestone: { id: 41, title: 'M' } });
  assert(iterated.iteration === 'iteration-61' && iterated.milestone.id === '41', 'foldIssue: a native iteration wins `iteration`, the milestone stays');
  assert(F.foldIssue({ iid: 6, title: 'x', state: 'opened', assignee: { username: 'solo' } }).assignees[0] === 'solo', 'foldIssue: the single `assignee` of older servers counts');

  const assoc = [[50, 'OWNER'], [40, 'MEMBER'], [30, 'MEMBER'], [20, 'CONTRIBUTOR'], [10, 'CONTRIBUTOR'], [undefined, 'NONE'], [0, 'NONE']];
  const badAssoc = assoc.filter(([l, want]) => F.associationOf(l) !== want).map(a => a[0]);
  assert(badAssoc.length === 0 && F.associationOf(0, true) === 'OWNER', 'access levels map to associations: Developer and up are trusted, Reporter and Guest are not');
  const approvedNote = F.foldNote({ id: 1, body: 'approved this merge request', system: true, author: { username: 'a' }, created_at: 'T' }, 40);
  assert(approvedNote?.review === 'approved' && approvedNote.association === 'MEMBER' && approvedNote.body === '', 'a system "approved" note is a review verdict');
  assert(F.foldNote({ id: 2, body: 'added 1 commit', system: true, author: { username: 'a' } }, 40) === undefined, 'other system notes are not conversation');
  assert(F.foldNote({ id: 3, body: 'requested changes', system: true, author: { username: 'a' } }, 30)?.review === 'changes', 'a system "requested changes" note is a review verdict');
  assert(F.foldNote({ id: 4, body: 'hello', author: { username: 'z' } }, undefined)?.association === 'NONE', 'a non-member is NONE');
}

// ═══════════════════════════════════════════════════════════
console.log('\n══ L4. SCOPES AND EXTRA POWER ══');
{
  assert(S.parseScopes(undefined) === undefined && S.parseScopes({}) === undefined && S.parseScopes({ scopes: 'api' }) === undefined, 'no usable answer: scopes are not reported');
  assert(same(S.parseScopes({ scopes: ['api', 'read_user'] }), ['api', 'read_user']), 'a scope list is read as sent');
  assert(same(S.missingScopes(['api'], true), []), '`api` covers everything AICO needs, read_user included');
  assert(same(S.missingScopes(['read_api'], true), ['api', 'read_user']), 'read_api cannot open a merge request: `api` is reported missing');
  assert(same(S.missingScopes([], false), []), 'missing scopes are not computed when the server does not report scopes');
  const extra = S.extraPowers(['api', 'sudo', 'admin_mode', 'create_runner']);
  const has = (s) => extra.some(e => e.startsWith(`${s}:`));
  assert(['sudo', 'admin_mode', 'create_runner'].every(has) && extra.length === 3, `extra powers named in plain words (${extra.length})`);
  assert(!has('api') && S.extraPowers(['api']).length === 0, '`api` is the scope AICO needs: it is not flagged on every correct token');
  assert(S.extraPowers(['read_api']).length === 0, 'a read-only scope is not flagged');
  assert(S.neededScopes().some(n => n.scope === 'api' && n.required), 'needed scopes: `api` is required');
}

// ═══════════════════════════════════════════════════════════
console.log('\n══ L5. THE MERGE CLICK ══');
{
  const L = T.ConnLanding;
  const pull = (o) => ({ canMerge: false, mergeBlockers: [], ...o });
  assert(same(L.mergePlan(pull({ canMerge: true })), { allow: true, arm: false }), 'mergeable now: merge now');
  assert(same(L.mergePlan(pull({ canMerge: true, autoMerge: { kind: 'pipeline', available: true, armed: false } })), { allow: true, arm: false }), 'mergeable now wins over an offered auto-merge');
  assert(same(L.mergePlan(pull({ autoMerge: { kind: 'pipeline', available: true, armed: false } })), { allow: true, arm: true }), 'only a running pipeline in the way: the click arms "merge when the pipeline succeeds"');
  const armed = L.mergePlan(pull({ mergeBlockers: ['It is set to merge when the pipeline succeeds.'], autoMerge: { kind: 'pipeline', available: false, armed: true } }));
  assert(armed.allow === false && /set to merge when the pipeline succeeds/.test(armed.reason), 'already armed: nothing to do, and the reason says so');
  const blocked = L.mergePlan(pull({ mergeBlockers: ['The pipeline must succeed before this can be merged.'] }));
  assert(blocked.allow === false && /pipeline must succeed/.test(blocked.reason), 'blocked for another reason: refused with the remote\'s own words');
  assert(L.mergePlan(pull({})).allow === false, 'no answer from the remote is not a yes');
}

// ═══════════════════════════════════════════════════════════
console.log('\n══ L6. CONFORMANCE (saas, ce-old, limited-token, rate-limited, hostile) ══');
{
  const vault = T.configureVault({ dir: path.join(testHome, 'vault'), keyProvider: T.memoryKeyProvider() });
  async function makeConnection({ forge, scenario, token, id }) {
    const credential = `cred-${id}`;
    await vault.create({
      name: credential, kind: 'api-token', secret: { token }, url: forge.url, createdBy: 'user',
      policy: { approval: 'auto', allowedTools: ['Connection'], allowedOrigins: [forge.url] },
    });
    return {
      id, provider: 'gitlab', label: `Mock ${scenario}`, baseUrl: forge.url, hosts: [forge.host], insecureHttp: true,
      createdAt: new Date().toISOString(), createdBy: 'person', credential,
    };
  }

  const head = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
  const base = 'b0b1b2b3b4b5b6b7b8b9babbbcbdbebf00112233';
  const R = '/api/v4/projects/acme%2Fplatform%2Fwidgets';
  const putsTo = (all, re) => all.filter(r => r.method === 'PUT' && re.test(r.path));
  const subject = {
    repo: { owner: 'acme/platform', name: 'widgets' },
    head: 'aico/task-42', base: 'main', createTitle: 'Add widget cache',
    pullId: '7', headSha: head, baseSha: base,
    staleSha: '0'.repeat(40), unmergeableSha: '1'.repeat(40), mergeSha: 'c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00', mergeMethod: 'squash',
    createPath: new RegExp(`${R}/merge_requests$`), pullCommentPath: new RegExp(`${R}/merge_requests/7/notes$`), mergePath: new RegExp(`${R}/merge_requests/7/merge$`),
    mergeHttpMethod: 'PUT',
    prBodyOf: (b) => b?.description,
    mergeRequestOk: (req) => {
      const b = req?.body ?? {};
      if (b.sha !== head) return `sha is ${b.sha}`;
      if (b.squash !== true) return `squash is ${b.squash}`;
      if (b.merge_when_pipeline_succeeds !== undefined) return 'merge_when_pipeline_succeeds was sent without a request for it';
      const allowed = ['sha', 'squash', 'should_remove_source_branch'];
      const extra = Object.keys(b).filter(k => !allowed.includes(k));
      if (extra.length) return `extra keys ${extra.join(', ')}`;
      return b.should_remove_source_branch === false ? true : 'the source branch would be removed';
    },
    pullExpect: [
      { state: 'open', mergeable: 'mergeable', canMerge: false, checks: 'pending', reviews: 'pending' },
      { state: 'open', mergeable: 'mergeable', canMerge: false, checks: 'failing', reviews: 'pending' },
      { state: 'open', mergeable: 'mergeable', canMerge: false, checks: 'passing', reviews: 'changes' },
      { state: 'open', mergeable: 'mergeable', canMerge: true, checks: 'passing', reviews: 'approved' },
      { state: 'merged', mergeable: 'unknown', canMerge: false, checks: 'passing', reviews: 'approved' },
    ],
    associations: ['MEMBER', 'NONE'],
    issueId: '11', issueRev: '2026-10-01T10:00:00.000Z', staleRev: '2020-01-01T00:00:00.000Z', milestoneId: '41', me: 'octo-dev',
    prNumbers: [12], pagedNumbers: [13],
    issuesPath: new RegExp(`${R}/issues$`), issuePath: new RegExp(`${R}/issues/11$`), issueCommentPath: new RegExp(`${R}/issues/11/notes$`), labelsPath: new RegExp(`${R}/issues/11$`),
    removableLabel: 'needs-triage', goneLabel: 'gone',
    protectedBranch: 'main', unprotectedBranch: 'dev',
    hostileBigIssue: '22',
    rateLimitStatus: 429,
    wire: {
      itemsQueryOk: (all) => all.some(r => r.query.labels === 'bug' && r.query.state === 'opened' && r.query.updated_after === '2026-09-01T00:00:00.000Z' && r.query.per_page === '100'),
      assignedOk: (all, items) => all.some(r => r.query.assignee_username === 'octo-dev') && items.length > 0,
      updateVerb: 'PUT',
      updateSentOk: (all) => putsTo(all, new RegExp(`${R}/issues/11$`)).some(r => r.body?.title === 'Cache invalidation on widget update (reworded)'
        && same(r.body?.labels, ['bug', 'sp:3', 'aico:running']) && r.body?.milestone_id === 41 && Object.keys(r.body).sort().join() === 'labels,milestone_id,title'),
      closeOk: (b) => b?.state_event === 'close' && Object.keys(b).length === 1,
      labelsOk: (all) => putsTo(all, new RegExp(`${R}/issues/11$`)).filter(r => r.body?.add_labels === 'aico:running').length === 1,
      assignOk: (b) => b?.milestone_id === 41,
    },
  };

  const extra = {
    saas: async (env) => {
      const { forge, adapter: a, ctx, assert: ok } = env;
      ok(forge.requests.every(r => r.path.startsWith('/api/v4/') || r.path === '/api/graphql'), 'every request went to /api/v4 (or the GraphQL root)');
      const proj = forge.requests.filter(r => r.path.includes('/projects/') && r.path !== '/api/v4/projects');
      ok(proj.length > 0 && proj.every(r => r.path.startsWith(`${R}`)), 'the project is addressed by its URL-encoded full path (nested group included), never by a guessed id');
      ok(forge.requests.every(r => r.headers.accept === 'application/json'), 'every request asked for JSON');
      const find = forge.requests.find(r => r.method === 'GET' && r.path === `${R}/merge_requests` && r.query.source_branch);
      ok(find?.query.source_branch === 'aico/task-42' && find.query.state === 'opened' && find.query.scope === 'all', 'pulls.find asks for the opened MR whose source branch is the task branch');
      const again = await env.attempt(() => a.pulls.find(ctx, 'aico/task-42'));
      ok(again.value?.id === '7' && again.value.state === 'merged', 'pulls.find returns the MR once it exists (idempotent open)');

      const created = forge.requests.find(r => r.method === 'POST' && r.path === `${R}/merge_requests`);
      ok(Object.keys(created?.body ?? {}).sort().join() === 'description,remove_source_branch,source_branch,target_branch,title' && created.body.remove_source_branch === false, 'the MR is created with the source branch left alone (AICO never deletes remote branches)');
      const draft = await env.attempt(() => a.pulls.create(ctx, { head: 'aico/task-43', base: 'main', title: 'Draft: Another change', body: 'x', draft: true }));
      const dreq = forge.requests.filter(r => r.method === 'POST' && r.path === `${R}/merge_requests`).at(-1);
      ok(!draft.error && dreq?.body?.title === 'Draft: Another change', 'a draft is a "Draft:" title prefix, written once');

      const before = forge.requests.length;
      const armed = await env.attempt(() => a.pulls.merge(ctx, '7', { method: 'merge', sha: head, whenChecksPass: true }));
      const mreq = forge.requests.slice(before).find(r => r.method === 'PUT' && r.path === `${R}/merge_requests/7/merge`);
      ok(!armed.error && mreq?.body?.merge_when_pipeline_succeeds === true && mreq.body.squash === false && mreq.body.sha === head, '"merge when the pipeline succeeds" is sent only when the caller asked for it, with the reviewed head');

      const its = await env.attempt(() => a.iterations.list(ctx));
      const native = (its.value ?? []).filter(i => i.kind === 'iteration');
      ok(native.length === 3 && native.every(i => i.id.startsWith('iteration-')), 'native iterations are listed with an id that cannot collide with a milestone id');
      ok(same(native.map(i => i.timeFrame), ['current', 'past', 'future']) && native[1].title === '2026-09-21 to 2026-10-04', 'iteration time frames come from the state; an unnamed iteration is named by its dates');
      const gb = forge.requests.length;
      const setIt = await env.attempt(() => a.iterations.assign(ctx, '11', 'iteration-61'));
      const gql = forge.requests.slice(gb).find(r => r.path === '/api/graphql');
      ok(!setIt.error && gql?.method === 'POST' && gql.body?.variables?.projectPath === 'acme/platform/widgets' && gql.body.variables.iid === '11' && gql.body.variables.iterationId === 'gid://gitlab/Iteration/61'
        && /issueSetIteration/.test(gql.body.query), 'a native iteration is set with the GraphQL mutation, addressed by the project path');
      const wrongGql = await env.attempt(() => a.iterations.assign(ctx, '11', 'iteration-abc'));
      ok(wrongGql.error?.code === 'config', 'a malformed iteration id is refused before any request');
      const unmapped = await env.attempt(() => a.probe({ ...ctx, repo: undefined }));
      ok(unmapped.value?.capabilities.pulls.create === true && unmapped.value.capabilities.iterations === 'native' && unmapped.value.warnings.some(w => /Checked against acme\/platform\/widgets/.test(w)),
        'a test before any project is mapped checks a project the account can push to, so the chips come from real calls');
      const noRepo = await env.attempt(() => a.pulls.get({ ...ctx, repo: undefined }, '7'));
      ok(noRepo.error?.code === 'config' && /map the project/.test(noRepo.error.message), 'an operation without a mapped project says to map it');
      const badId = await env.attempt(() => a.pulls.get(ctx, '7; drop'));
      ok(badId.error?.code === 'config', 'a merge request number that is not a number is refused');
    },
    'ce-old': async (env) => {
      const { forge, assert: ok } = env;
      ok(forge.requests.some(r => r.path.endsWith('/iterations') && r.status === 404), 'the iteration endpoint was asked and answered 404 (CE or Free)');
      ok(forge.requests.every(r => r.method === 'GET'), 'a read-only script made no writes');
    },
  };

  const result = await runConformance({
    name: 'gitlab', T, adapter, makeConnection, token: TOKEN, subject, assert, extra,
    fixturesDir: path.join(here, 'fixtures', 'connections', 'gitlab'),
    scenarios: [
      { scenario: 'saas', profile: 'full' },
      { scenario: 'ce-old', profile: 'degraded' },
      { scenario: 'limited-token', profile: 'limited' },
      { scenario: 'rate-limited', profile: 'rate-limit' },
      { scenario: 'hostile', profile: 'hostile' },
    ],
  });
  void result;
}

console.log(`\n══ SUMMARY ══\n  ${passed} passed, ${failed} failed`);
if (failed) { console.log(`  failures:\n    ${failures.join('\n    ')}`); process.exit(1); }
process.exit(0);
