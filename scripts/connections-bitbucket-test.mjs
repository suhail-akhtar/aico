/**
 * The Bitbucket adapters, tested offline (ADR 0039): Cloud (REST 2.0) and Data Center (REST 1.0).
 *
 * Provider-specific unit checks first (remote URL parsing, API bases and hosts, Basic versus
 * Bearer, the git user names, the folding rules as tables), then the shared conformance script
 * (scripts/connections-conformance.mjs) against the loopback mock forge, for each of:
 *   Cloud:  cloud (full), limited-token, rate-limited, hostile
 *   DC:     dc (full), limited-token, rate-limited, hostile
 * plus extras that only these providers have: Cloud's issue tracker and the "AICO never approves"
 * invariant, and Data Center's merge `version` optimistic lock (a 409 is a `conflict`, never a
 * retry) and its repository-wide protection.
 *
 * Part of `npm test`. No model, no network beyond 127.0.0.1, no real Bitbucket: the "forge" is
 * scripts/lib/mock-forge.mjs replaying hand-written fixtures from
 * scripts/fixtures/connections/bitbucket-cloud/ and bitbucket-dc/. The store is this process's own
 * AICO_HOME and the vault key lives in memory. The only credential is an obviously fake canary,
 * and the suite asserts it appears nowhere but the Authorization header.
 *
 * A mock on loopback is not bitbucket.org, so Cloud treats it as "another host" and serves the
 * same layout under `<origin>/2.0`; the bitbucket.org URL layout itself is asserted directly.
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

const TOKEN = 'bbx-Can4ry-Tok-5c1e8b73d0a94f26'; // standards-allow: secret (test canary)
const EMAIL = 'octo.dev@example.test';
const cloud = T.bitbucketCloudAdapter;
const dc = T.bitbucketDcAdapter;
const F = T.BitbucketFold;
const CP = T.BitbucketCloudParts;
const DP = T.BitbucketDcParts;

const HEAD = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const BASE = 'b0b1b2b3b4b5b6b7b8b9babbbcbdbebf00112233';
const MERGE = 'c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00';

// ═══════════════════════════════════════════════════════════
console.log('\n══ B1. REMOTE URLS ══');
{
  const repo = { owner: 'acme', name: 'widgets' };
  const web = 'https://bitbucket.org';
  const table = [
    ['https://bitbucket.org/acme/widgets.git', web, repo],
    ['https://bitbucket.org/acme/widgets', web, repo],
    ['https://octo-dev@bitbucket.org/acme/widgets.git', web, repo],
    ['https://x-token-auth:fake-userinfo@bitbucket.org/acme/widgets.git', web, repo],
    ['git@bitbucket.org:acme/widgets.git', web, repo],
    ['ssh://git@bitbucket.org/acme/widgets.git', web, repo],
    ['https://github.com/acme/widgets.git', web, undefined],
    ['https://bitbucket.org.evil.test/acme/widgets.git', web, undefined],
    ['https://bitbucket.org/acme', web, undefined],
    ['https://bitbucket.org/acme/widgets/src/main', web, undefined],
    ['file:///srv/git/widgets.git', web, undefined],
    ['', web, undefined],
    ['http://127.0.0.1:4000/acme/widgets.git', 'http://127.0.0.1:4000', repo],
  ];
  const wrong = table.filter(([u, b, want]) => !same(cloud.parseRemote(u, b), want)).map(w => w[0]);
  assert(wrong.length === 0, `Cloud parseRemote: ${table.length} forms (wrong: ${wrong.join(' | ') || 'none'})`);
  assert(!JSON.stringify(cloud.parseRemote('https://x-token-auth:fake-userinfo@bitbucket.org/acme/widgets.git', web)).includes('fake-userinfo'), 'Cloud: userinfo never reaches the parsed repository');

  const dcBase = 'https://git.corp.test';
  const key = { owner: 'ACME', name: 'widgets' };
  const dcTable = [
    ['https://git.corp.test/scm/ACME/widgets.git', dcBase, key],
    ['https://octo-dev@git.corp.test/scm/acme/widgets.git', dcBase, { owner: 'acme', name: 'widgets' }],
    ['ssh://git@git.corp.test:7999/ACME/widgets.git', dcBase, key],
    ['https://git.corp.test/projects/ACME/repos/widgets/browse', dcBase, key],
    ['https://git.corp.test/scm/~octo/notes.git', dcBase, { owner: '~octo', name: 'notes' }],
    ['https://git.corp.test/bitbucket/scm/ACME/widgets.git', 'https://git.corp.test/bitbucket', key],
    ['https://git.corp.test/scm/ACME/widgets.git', 'https://git.corp.test/bitbucket', undefined],
    ['https://other.test/scm/ACME/widgets.git', dcBase, undefined],
    ['https://git.corp.test/scm/ACME', dcBase, undefined],
    ['https://git.corp.test:8443/scm/ACME/widgets.git', 'https://git.corp.test:8443', key],
    ['https://git.corp.test/scm/ACME/widgets.git', 'https://git.corp.test:8443', undefined],
    ['git@git.corp.test:ACME/widgets.git', dcBase, undefined],
  ];
  const wrongDc = dcTable.filter(([u, b, want]) => !same(dc.parseRemote(u, b), want)).map(w => w[0]);
  assert(wrongDc.length === 0, `Data Center parseRemote: ${dcTable.length} forms (wrong: ${wrongDc.join(' | ') || 'none'})`);
}

// ═══════════════════════════════════════════════════════════
console.log('\n══ B2. API BASES, HOSTS, AUTH, GIT USER NAMES ══');
{
  assert(cloud.id === 'bitbucket-cloud' && dc.id === 'bitbucket-dc', 'adapter ids');
  assert(cloud.apiBase({ baseUrl: 'https://bitbucket.org' }) === 'https://api.bitbucket.org/2.0', 'Cloud REST base is api.bitbucket.org/2.0');
  assert(cloud.apiBase({ baseUrl: 'http://127.0.0.1:4000' }) === 'http://127.0.0.1:4000/2.0', 'any other host serves the same layout under /2.0 (the mock forge relies on this)');
  assert(same(cloud.hostsFor('https://bitbucket.org'), ['api.bitbucket.org', 'bitbucket.org']), 'Cloud hosts: api and web');
  assert(same(cloud.hostsFor('http://127.0.0.1:4000'), ['127.0.0.1:4000']), 'a non-Cloud host is its own host');
  const withEmail = cloud.clientOptions({ baseUrl: 'https://bitbucket.org', username: EMAIL });
  const without = cloud.clientOptions({ baseUrl: 'https://bitbucket.org' });
  assert(withEmail.auth.kind === 'basic' && withEmail.username === EMAIL, 'an API token (with the account email) is sent as Basic');
  assert(without.auth.kind === 'bearer' && without.username === undefined, 'an access token (no email) is sent as Bearer');
  assert(cloud.gitUsername({ username: EMAIL }) === 'x-bitbucket-api-token-auth' && cloud.gitUsername({}) === 'x-token-auth', 'git user names: API token vs access token');

  assert(dc.apiBase({ baseUrl: 'https://git.corp.test' }) === 'https://git.corp.test/rest/api/1.0', 'Data Center REST base');
  assert(dc.apiBase({ baseUrl: 'https://git.corp.test/bitbucket/' }) === 'https://git.corp.test/bitbucket/rest/api/1.0', 'a context path is kept (and a trailing slash dropped)');
  assert(DP.dcRoot({ baseUrl: 'https://git.corp.test:8443/bb' }) === 'https://git.corp.test:8443/bb', 'dcRoot keeps port and context path');
  assert(same(dc.hostsFor('https://git.corp.test:8443/bb'), ['git.corp.test:8443']), 'Data Center hosts: the server host with its port');
  assert(dc.clientOptions({ baseUrl: 'https://git.corp.test' }).auth.kind === 'bearer', 'an HTTP access token is Bearer');
  assert(dc.gitUsername({ probe: { user: 'octo-dev' } }) === 'octo-dev' && dc.gitUsername({}) === 'x-token-auth', 'Data Center git user name: the account the probe found');
  assert(dc.items === undefined && dc.iterations === undefined, 'Data Center has no work items or iterations (Jira is out of scope)');
  assert(cloud.iterations === undefined && cloud.pulls?.merge !== undefined, 'Cloud has no iterations; it can merge on a click');
  assert(typeof cloud.pulls.approve === 'undefined' && typeof dc.pulls.approve === 'undefined', 'neither adapter can approve a pull request');
  const reg = T.ConnRegistry;
  T.registerBuiltinAdapters();
  const cat = reg.providerCatalogue();
  assert(cat.find(p => p.id === 'bitbucket-cloud')?.supported && cat.find(p => p.id === 'bitbucket-dc')?.supported, 'both providers are registered as supported');
}

// ═══════════════════════════════════════════════════════════
console.log('\n══ B3. FOLDING RULES (tables) ══');
{
  const u = (n) => ({ nickname: n, display_name: n });
  const cpr = (over = {}) => ({ id: 7, state: 'OPEN', draft: false, author: u('octo-dev'), source: { commit: { hash: 'h1' } }, destination: { branch: { name: 'main' } }, participants: [], reviewers: [], links: { html: { href: 'https://forge.test/pr/7' } }, ...over });
  const part = (n, approved, state, role = 'REVIEWER') => ({ user: u(n), role, approved, state });
  const st = (state) => ({ name: 's', state });
  const required = (n) => ({ protected: true, requiredReviews: n, requiredChecks: [] });
  const cases = [
    ['open, requirement unreadable, nobody approved: not offered', cpr(), [], undefined, { canMerge: false, reviews: 'none', checks: 'none' }],
    ['open, readable and unprotected: nothing is required', cpr(), [], { protected: false }, { canMerge: true, reviews: 'none', checks: 'none' }],
    ['requirement unreadable, one approval stands in for "reviewed"', cpr({ participants: [part('r1', true, 'approved')] }), [], undefined, { canMerge: true, reviews: 'approved' }],
    ['a draft cannot merge', cpr({ draft: true }), [], { protected: false }, { canMerge: false }],
    ['a failing build blocks', cpr(), [st('FAILED')], { protected: false }, { canMerge: false, checks: 'failing' }],
    ['a running build blocks', cpr(), [st('INPROGRESS')], { protected: false }, { canMerge: false, checks: 'pending' }],
    ['a stopped build is a failure', cpr(), [st('STOPPED')], { protected: false }, { canMerge: false, checks: 'failing' }],
    ['all builds green', cpr(), [st('SUCCESSFUL')], { protected: false }, { canMerge: true, checks: 'passing' }],
    ['changes requested blocks', cpr({ participants: [part('r1', false, 'changes_requested')] }), [], undefined, { canMerge: false, reviews: 'changes' }],
    ['one approval of two required', cpr({ participants: [part('r1', true, 'approved')] }), [], required(2), { canMerge: false, reviews: 'pending' }],
    ['two approvals of two required', cpr({ participants: [part('r1', true, 'approved'), part('r2', true, 'approved')] }), [], required(2), { canMerge: true, reviews: 'approved' }],
    ['the author\'s own approval does not count', cpr({ participants: [part('octo-dev', true, 'approved')] }), [], required(1), { canMerge: false, reviews: 'pending' }],
    ['a reviewer who has not decided is pending', cpr({ reviewers: [u('r1')] }), [], { protected: false }, { canMerge: true, reviews: 'pending' }],
    ['merged is not mergeable', cpr({ state: 'MERGED', merge_commit: { hash: 'm1' } }), [st('SUCCESSFUL')], undefined, { canMerge: false, state: 'merged' }],
    ['declined is closed', cpr({ state: 'DECLINED' }), [], undefined, { canMerge: false, state: 'closed' }],
    ['superseded is closed', cpr({ state: 'SUPERSEDED' }), [], undefined, { canMerge: false, state: 'closed' }],
  ];
  const bad = [];
  for (const [name, pr, statuses, protection, want] of cases) {
    const got = F.foldCloudPull({ connection: 'c', pr, statuses, ...(protection ? { protection } : {}), now: '2026-10-09T00:00:00.000Z' });
    const ok = got.canMerge === want.canMerge && (want.reviews === undefined || got.reviews.state === want.reviews)
      && (want.checks === undefined || got.checks.state === want.checks) && (want.state === undefined || got.state === want.state)
      && got.mergeable === 'unknown' && (got.canMerge || got.state !== 'open' || got.mergeBlockers.length > 0);
    if (!ok) bad.push(name);
  }
  assert(bad.length === 0, `Cloud fold: ${cases.length} cases; mergeable is always unknown; a blocked PR says why (wrong: ${bad.join(' | ') || 'none'})`);
  const merged = F.foldCloudPull({ connection: 'c', pr: cpr({ state: 'MERGED', merge_commit: { hash: 'm1' } }), statuses: [] });
  assert(merged.mergedSha === 'm1' && merged.headSha === 'h1' && merged.id === '7' && merged.url === 'https://forge.test/pr/7', 'Cloud fold: merge sha, head sha, id as string, safe url');
  assert(F.foldCloudPull({ connection: 'c', pr: cpr({ links: { html: { href: 'javascript:alert(1)' } } }), statuses: [] }).url === '', 'a non-http url is dropped');
  assert(F.foldCloudPull({ connection: 'c', pr: cpr(), statuses: [], protection: { protected: false, unreadable: 'needs repository admin' } }).protectedBase === undefined, 'unreadable protection leaves protectedBase unknown');

  const dr = (user, status) => ({ user: { name: user, slug: user }, role: 'REVIEWER', approved: status === 'APPROVED', status });
  const dpr = (over = {}) => ({ id: 7, version: 1, state: 'OPEN', draft: false, author: { user: { name: 'octo-dev', slug: 'octo-dev' } }, fromRef: { latestCommit: 'h1' }, reviewers: [], links: { self: [{ href: 'https://forge.test/pr/7' }] }, ...over });
  const m = (canMerge, extra = {}) => ({ canMerge, conflicted: false, outcome: 'CLEAN', vetoes: [], ...extra });
  const dcases = [
    ['the server says it can merge', dpr(), m(true), { canMerge: true, mergeable: 'mergeable' }],
    ['the server says it cannot', dpr(), m(false, { vetoes: [{ summaryMessage: 'Requires 2 approvals' }] }), { canMerge: false, blocker: /Requires 2 approvals/ }],
    ['conflicts', dpr(), m(false, { conflicted: true, outcome: 'CONFLICTED' }), { canMerge: false, mergeable: 'conflicting', blocker: /conflicts/ }],
    ['a draft never merges', dpr({ draft: true }), m(true), { canMerge: false, blocker: /draft/ }],
    ['needs work blocks even if the server allows', dpr({ reviewers: [dr('r1', 'NEEDS_WORK')] }), m(true), { canMerge: false, reviews: 'changes' }],
    ['not asked: unknown, not mergeable', dpr(), undefined, { canMerge: false, mergeable: 'unknown', blocker: /not asked/ }],
    ['a closed request is not mergeable', dpr({ state: 'DECLINED' }), m(true), { canMerge: false, state: 'closed' }],
    ['merged: merge commit from properties', dpr({ state: 'MERGED', properties: { mergeCommit: { id: 'm1' } } }), undefined, { canMerge: false, state: 'merged', mergedSha: 'm1' }],
    ['approved reviewers', dpr({ reviewers: [dr('r1', 'APPROVED'), dr('r2', 'APPROVED')] }), m(true), { canMerge: true, reviews: 'approved' }],
  ];
  const badDc = [];
  for (const [name, pr, merge, want] of dcases) {
    const got = F.foldDcPull({ connection: 'c', pr, merge, builds: [], now: '2026-10-09T00:00:00.000Z' });
    const ok = got.canMerge === want.canMerge && (want.mergeable === undefined || got.mergeable === want.mergeable)
      && (want.blocker === undefined || got.mergeBlockers.some(b => want.blocker.test(b))) && (want.reviews === undefined || got.reviews.state === want.reviews)
      && (want.state === undefined || got.state === want.state) && (want.mergedSha === undefined || got.mergedSha === want.mergedSha);
    if (!ok) badDc.push(name);
  }
  assert(badDc.length === 0, `Data Center fold: ${dcases.length} cases; the server's verdict and its sentences (wrong: ${badDc.join(' | ') || 'none'})`);
  const dcChecks = F.foldDcPull({ connection: 'c', pr: dpr(), merge: m(true), builds: [{ state: 'SUCCESSFUL', name: 'a' }, { state: 'FAILED', name: 'b' }] });
  assert(dcChecks.checks.state === 'failing' && dcChecks.checks.items.length === 2, 'Data Center builds fold to checks');
  assert(F.foldDcPull({ connection: 'c', pr: dpr(), merge: m(true), builds: [] }).checks.state === 'none', 'no CI at all is "none", never "passing"');

  const decisions = [
    ['none', [], undefined, 'none'], ['a waiting reviewer', [{ who: 'a', state: 'pending' }], undefined, 'pending'],
    ['approved, requirement unknown', [{ who: 'a', state: 'approved' }], undefined, 'approved'],
    ['one of two', [{ who: 'a', state: 'approved' }], 2, 'pending'], ['changes outrank approvals', [{ who: 'a', state: 'approved' }, { who: 'b', state: 'changes' }], 1, 'changes'],
    ['none required, none given', [], 0, 'none'],
  ];
  const badDec = decisions.filter(([, d, req, want]) => F.foldDecisions(d, req).state !== want).map(d => d[0]);
  assert(badDec.length === 0, `review decisions: ${decisions.length} cases (wrong: ${badDec.join(' | ') || 'none'})`);

  const rs = (kind, pattern, value, bmk = 'glob') => ({ kind, pattern, value, branch_match_kind: bmk });
  assert(F.patternCovers(rs('push', 'main'), 'main') && !F.patternCovers(rs('push', 'main'), 'dev'), 'restriction patterns: exact name');
  assert(F.patternCovers(rs('push', 'release/*'), 'release/1.2') && !F.patternCovers(rs('push', 'release/*'), 'hotfix/1'), 'restriction patterns: a * glob');
  assert(!F.patternCovers(rs('push', '', null, 'branching_model'), 'main') && !F.patternCovers(rs('push', 'main', null, 'branching_model'), 'main'), 'a branching-model restriction is not guessed at');
  const prot = F.foldCloudRestrictions([rs('require_approvals_to_merge', 'main', 2), rs('require_passing_builds_to_merge', 'main', 1), rs('push', 'release/*', null)], 'main');
  assert(prot.protected && prot.requiredReviews === 2 && same(prot.requiredChecks, ['1 passing build']), 'Cloud restrictions: required approvals and builds for main');
  assert(F.foldCloudRestrictions([rs('push', 'release/*', null)], 'main').protected === false, 'a restriction on another branch does not protect main');

  const set = F.foldDcPullSettings({ requiredApprovers: { enable: true, count: 2 }, requiredSuccessfulBuilds: { enable: false, count: 3 }, requiredAllTasksComplete: { enable: true } });
  assert(set.requiredReviews === 2 && set.requiredBuilds === 0 && set.tasksMustBeDone === true, 'Data Center settings: only enabled requirements count');

  const issue = F.foldCloudIssue({ id: 5, title: 'T <!-- x -->', state: 'on hold', content: { raw: 'b' }, component: { name: 'api' }, assignee: u('a'), reporter: u('r'), updated_on: 'R', milestone: { name: 'S1' }, links: { html: { href: 'https://forge.test/i/5' } } });
  assert(issue.state === 'open' && issue.title === 'T' && same(issue.labels, ['api']) && issue.rev === 'R' && issue.milestone.id === 'S1' && same(issue.assignees, ['a']), 'Cloud issue: on hold is still open; component stands in for a label; rev = updated_on');
  assert(['resolved', 'closed', 'invalid', 'duplicate', 'wontfix'].every(s => F.foldCloudIssue({ id: 1, state: s }).state === 'closed'), 'Cloud issue: every ended state is closed');

  const pr = cpr({ participants: [part('rev-one', false, 'changes_requested', 'REVIEWER')], reviewers: [u('rev-one')] });
  const comments = F.foldCloudComments([
    { id: 1, user: u('octo-dev'), content: { raw: 'mine' }, created_on: '2026-10-08T09:00:00Z' },
    { id: 2, user: u('rev-one'), content: { raw: 'theirs' }, created_on: '2026-10-08T10:00:00Z' },
    { id: 3, user: u('drive-by'), content: { raw: 'hi' }, created_on: '2026-10-08T11:00:00Z' },
    { id: 4, user: u('drive-by'), content: { raw: 'deleted' }, created_on: '2026-10-08T12:00:00Z', deleted: true },
  ], pr);
  const assoc = Object.fromEntries(comments.map(c => [c.author + (c.review ? '/review' : ''), c.association]));
  assert(comments.length === 4 && assoc['octo-dev'] === 'OWNER' && assoc['rev-one'] === 'COLLABORATOR' && assoc['drive-by'] === 'NONE', 'Cloud comments: author OWNER, reviewer COLLABORATOR, others NONE; deleted dropped');
  assert(comments.some(c => c.review === 'changes' && c.author === 'rev-one'), 'a reviewer who asked for changes appears as a review entry');
}

// ═══════════════════════════════════════════════════════════
const vault = T.configureVault({ dir: path.join(testHome, 'vault'), keyProvider: T.memoryKeyProvider() });
function connectionMaker(provider, extra = {}) {
  return async function makeConnection({ forge, scenario, token, id }) {
    const credential = `cred-${id}`;
    await vault.create({
      name: credential, kind: 'api-token', secret: { token }, url: forge.url, createdBy: 'user',
      policy: { approval: 'auto', allowedTools: ['Connection'], allowedOrigins: [forge.url] },
    });
    return {
      id, provider, label: `Mock ${scenario}`, baseUrl: forge.url, hosts: [forge.host], insecureHttp: true,
      createdAt: new Date().toISOString(), createdBy: 'person', credential, ...extra,
    };
  };
}

// ═══════════════════════════════════════════════════════════
console.log('\n══ B4. BITBUCKET CLOUD: CONFORMANCE (cloud, limited-token, rate-limited, hostile) ══');
{
  const R = '/2.0/repositories/acme/widgets';
  const subject = {
    repo: { owner: 'acme', name: 'widgets' },
    head: 'aico/task-42', base: 'main', createTitle: 'Add widget cache',
    pullId: '7', headSha: HEAD, baseSha: BASE,
    staleSha: '0'.repeat(40), unmergeableSha: '1'.repeat(40), mergeSha: MERGE, mergeMethod: 'squash',
    basicUser: EMAIL, rateLimitStatus: 429,
    createPath: new RegExp(`${R}/pullrequests$`), pullCommentPath: new RegExp(`${R}/pullrequests/7/comments$`),
    mergePath: new RegExp(`${R}/pullrequests/7/merge$`), mergeHttpMethod: 'POST',
    prBodyOf: (b) => b?.description,
    mergeRequestOk: (r) => {
      const keys = Object.keys(r?.body ?? {});
      if (r?.body?.type !== 'pullrequest' || r.body.merge_strategy !== 'squash') return `unexpected body ${JSON.stringify(r?.body)}`;
      if (r.body.close_source_branch !== false) return 'the source branch must not be closed on merge';
      return keys.every(k => ['type', 'merge_strategy', 'close_source_branch', 'message'].includes(k)) ? true : `extra keys ${keys.join(', ')}`;
    },
    pullExpect: [
      { state: 'open', mergeable: 'unknown', canMerge: false, checks: 'pending', reviews: 'pending' },
      { state: 'open', mergeable: 'unknown', canMerge: false, checks: 'failing', reviews: 'changes' },
      { state: 'open', mergeable: 'unknown', canMerge: true, checks: 'passing', reviews: 'approved' },
      { state: 'merged', mergeable: 'unknown', canMerge: false, checks: 'passing', reviews: 'approved' },
    ],
    associations: ['OWNER', 'COLLABORATOR', 'NONE'], hostileAssociations: ['COLLABORATOR', 'NONE'],
    sections: ['checks', 'protection'],
    protectedBranch: 'main', unprotectedBranch: 'dev', hostileBigIssue: '22',
  };

  const extra = {
    cloud: async (env) => {
      const { forge, adapter: a, ctx, assert: ok } = env;
      ok(forge.requests.every(r => r.headers.accept === 'application/json'), 'every request asked for JSON');
      ok(forge.requests.every(r => !/approve/i.test(r.path)), 'AICO never approves a pull request (no request to an approve endpoint)');
      const find = forge.requests.find(r => r.method === 'GET' && r.path === `${R}/pullrequests` && r.query.q);
      ok(/source\.branch\.name="aico\/task-42"/.test(find?.query.q ?? '') && /state="OPEN"/.test(find?.query.q ?? ''), 'pulls.find filters by source branch and open state');
      const create = forge.requests.find(r => r.method === 'POST' && r.path === `${R}/pullrequests`);
      ok(create?.body?.source?.branch?.name === 'aico/task-42' && create.body.destination?.branch?.name === 'main' && create.body.close_source_branch === false && create.body.draft === false, 'create: source, destination, never closes the source branch');
      const writes = forge.requests.filter(r => r.method !== 'GET').length;
      const behind = await env.attempt(() => a.pulls.merge(ctx, '7', { method: 'merge', sha: BASE }));
      ok(behind.error?.code === 'conflict' && forge.requests.filter(r => r.method !== 'GET').length === writes, 'merge with a head the PR does not have is refused locally: no POST was sent');
      const bad = await env.attempt(() => a.pulls.find(ctx, 'x" OR state="MERGED'));
      ok(bad.error?.code === 'config', 'a branch name cannot break out of the Bitbucket filter');

      // ── the issue tracker, for repositories that use it ──
      const probe = await a.probe(ctx);
      ok(probe.capabilities.items.query === true && probe.capabilities.iterations === 'none' && probe.capabilities.items.estimate === 'none', 'probe: issues readable (has_issues), no iterations, no estimates');
      ok(probe.warnings.some(w => /no sprints/i.test(w) && /Jira is not supported/i.test(w)), 'the probe says plainly: no sprints, Jira not supported');
      const q = await a.items.query(ctx, { source: 'label', value: 'cache', state: 'open', since: '2026-09-01T00:00:00Z' });
      const iq = forge.requests.filter(r => r.method === 'GET' && r.path === `${R}/issues` && r.query.q).at(-1);
      ok(q.items.length === 2 && /component\.name="cache"/.test(iq?.query.q ?? '') && /state="new"/.test(iq?.query.q ?? '') && /updated_on>=2026-09-01T00:00:00\.000Z/.test(iq?.query.q ?? ''), 'items.query: component filter, open states, since');
      ok(same(q.items[0].labels, ['cache']) && q.items[0].rev === '2026-10-01T10:00:00.000000+00:00' && q.items[1].labels.length === 0, 'issues carry their component as the only label and updated_on as the revision');
      const mine = await a.items.query(ctx, { source: 'assigned-to-me', me: 'octo-dev', state: 'open' });
      ok(mine.items.length === 2 && /assignee\.nickname="octo-dev"/.test(forge.requests.filter(r => r.path === `${R}/issues` && r.query.q).at(-1)?.query.q ?? ''), 'assigned-to-me filters on the account nickname');
      const injected = await env.attempt(() => a.items.query(ctx, { source: 'label', value: 'x" OR 1=1', state: 'open' }));
      ok(injected.error?.code === 'config', 'a label cannot break out of the Bitbucket filter');
      const noMe = await env.attempt(() => a.items.query(ctx, { source: 'assigned-to-me', state: 'open' }));
      ok(noMe.error?.code === 'config', 'assigned-to-me without a known account is refused with a fix');
      const rev = '2026-10-01T10:00:00.000000+00:00';
      const before = forge.requests.filter(r => r.method !== 'GET').length;
      const upd = await a.items.update(ctx, '11', { title: 'Cache invalidation on widget update (reworded)' }, rev);
      ok(upd.title.endsWith('(reworded)') && forge.requests.filter(r => r.method !== 'GET').length === before + 1, 'items.update with the right revision writes once');
      const stale = await env.attempt(() => a.items.update(ctx, '11', { title: 'Overwrites someone else' }, '2020-01-01T00:00:00.000000+00:00'));
      ok(stale.error?.code === 'conflict' && stale.error.status === 409 && forge.requests.filter(r => r.method !== 'GET').length === before + 1, 'a stale revision is a `conflict` and nothing is written');
      const closed = await a.items.transition(ctx, '11', 'closed', rev);
      const put = forge.requests.filter(r => r.method === 'PUT' && r.path === `${R}/issues/11`).at(-1);
      ok(closed.state === 'closed' && put?.body?.state === 'resolved', 'closing an issue marks it resolved');
      const n = forge.requests.length;
      await a.items.addLabels(ctx, '11', ['aico:running']);
      await a.items.removeLabel(ctx, '11', 'aico:running');
      ok(forge.requests.length === n, 'Cloud issues have no labels: the label calls are no-ops that make no request');
      await a.items.comment(ctx, '11', 'Progress.\nCo-Authored-By: Some Tool <x@example.test>\nDone.');
      const ic = forge.requests.filter(r => r.method === 'POST' && r.path === `${R}/issues/11/comments`).at(-1);
      ok(/Progress/.test(ic?.rawBody ?? '') && !/co-authored-by/i.test(ic?.rawBody ?? ''), 'issue comments carry no AI attribution');
      const made = await a.items.create(ctx, { title: 'Follow-up: cache metrics', body: 'Track hit rate.' });
      ok(made.id === '13', 'items.create returns the new issue');
      const repos = await a.repos.list(ctx, 'gadgets');
      ok(repos.length === 1 && repos[0].ref.name === 'gadgets' && repos[0].cloneUrl === `${forge.url}/acme/gadgets.git`, 'repos.list filters by name and builds clone URLs from the base');
    },
    'limited-token': async (env) => {
      const { ctx, adapter: a, assert: ok } = env;
      const probe = await a.probe(ctx);
      ok(probe.user === EMAIL && probe.warnings.some(w => /cannot read its own account/i.test(w)), 'an access token that cannot read /user is still a working connection');
      ok(probe.capabilities.items.query === false && probe.warnings.some(w => /issue tracker is turned off/i.test(w) && /Jira is not supported/i.test(w)), 'issues off on the repository: capability false and a plain note');
      ok(probe.capabilities.pulls.create === true, 'without a permission lookup the token is assumed able to write (the first push says otherwise)');
    },
    hostile: async (env) => {
      const { ctx, adapter: a, assert: ok } = env;
      const pull = await a.pulls.get(ctx, '7');
      ok(pull.canMerge === false, 'hostile text did not change the merge decision (Cloud)');
    },
  };

  await runConformance({
    name: 'bitbucket-cloud', T, adapter: cloud, makeConnection: connectionMaker('bitbucket-cloud', { username: EMAIL }), token: TOKEN, subject, assert, extra,
    fixturesDir: path.join(here, 'fixtures', 'connections', 'bitbucket-cloud'),
    scenarios: [
      { scenario: 'cloud', profile: 'full' },
      { scenario: 'limited-token', profile: 'limited' },
      { scenario: 'rate-limited', profile: 'rate-limit' },
      { scenario: 'hostile', profile: 'hostile' },
    ],
  });
}

// ═══════════════════════════════════════════════════════════
console.log('\n══ B5. BITBUCKET DATA CENTER: CONFORMANCE (dc, limited-token, rate-limited, hostile) ══');
{
  const P = '/rest/api/1.0/projects/ACME/repos/widgets';
  const subject = {
    repo: { owner: 'ACME', name: 'widgets' },
    head: 'aico/task-42', base: 'main', createTitle: 'Add widget cache',
    pullId: '7', headSha: HEAD, baseSha: BASE,
    staleSha: '0'.repeat(40), unmergeableSha: '1'.repeat(40), mergeSha: MERGE, mergeMethod: 'squash',
    rateLimitStatus: 429,
    createPath: new RegExp(`${P}/pull-requests$`), pullCommentPath: new RegExp(`${P}/pull-requests/7/comments$`),
    mergePath: new RegExp(`${P}/pull-requests/7/merge$`), mergeHttpMethod: 'POST',
    prBodyOf: (b) => b?.description,
    mergeRequestOk: (r) => {
      if (r?.query.version !== '6') return `the merge must carry the PR's current version (6), got ${r?.query.version}`;
      const keys = Object.keys(r?.body ?? {});
      if (r.body?.strategyId !== 'squash') return `unexpected strategy ${r.body?.strategyId}`;
      return keys.every(k => ['strategyId', 'message', 'autoSubject'].includes(k)) ? true : `extra keys ${keys.join(', ')}`;
    },
    pullExpect: [
      { state: 'open', mergeable: 'mergeable', canMerge: false, checks: 'pending', reviews: 'pending' },
      { state: 'open', mergeable: 'mergeable', canMerge: false, checks: 'failing', reviews: 'changes' },
      { state: 'open', mergeable: 'mergeable', canMerge: true, checks: 'passing', reviews: 'approved' },
      { state: 'merged', mergeable: 'unknown', canMerge: false, checks: 'passing', reviews: 'approved' },
    ],
    associations: ['OWNER', 'COLLABORATOR', 'NONE'], hostileAssociations: ['COLLABORATOR', 'NONE'],
    sections: ['checks', 'protection'], skipUnprotected: true,
    protectedBranch: 'main', unprotectedBranch: 'dev', hostileBigIssue: '22',
  };

  const extra = {
    dc: async (env) => {
      const { forge, adapter: a, ctx, assert: ok } = env;
      const who = forge.requests.find(r => r.path === '/plugins/servlet/applinks/whoami');
      ok(who?.headers.accept === 'text/plain', 'the account is read from the plain-text whoami endpoint');
      ok(forge.requests.filter(r => r.path.startsWith('/rest/api/1.0') || r.path.startsWith('/rest/build-status') || r.path.startsWith('/rest/branch-permissions') || r.path.startsWith('/plugins')).length === forge.requests.length, 'every request went to a REST 1.0, build-status, branch-permissions or whoami URL');
      const find = forge.requests.find(r => r.method === 'GET' && r.path === `${P}/pull-requests` && r.query.direction);
      ok(find?.query.at === 'refs/heads/aico/task-42' && find.query.direction === 'OUTGOING' && find.query.state === 'OPEN', 'pulls.find asks for open PRs coming FROM the task branch');
      const create = forge.requests.find(r => r.method === 'POST' && r.path === `${P}/pull-requests`);
      ok(create?.body?.fromRef?.id === 'refs/heads/aico/task-42' && create.body.toRef?.id === 'refs/heads/main' && create.body.fromRef.repository?.project?.key === 'ACME' && create.body.fromRef.repository.slug === 'widgets', 'create: from/to refs with the repository and project key');
      ok(forge.requests.every(r => !/approve/i.test(r.path) || r.method === 'GET'), 'AICO never approves a pull request');
      const dflt = forge.requests.find(r => r.path === `${P}/branches/default`);
      ok(!!dflt, 'the default branch is read from the server, not assumed');
      const info = await a.repos.get(ctx, subject.repo);
      ok(info.cloneUrl === `${forge.url}/scm/acme/widgets.git` && info.defaultBranch === 'main', 'the clone URL is built from the base and the lower-cased project key');
      const probe = await a.probe(ctx);
      ok(probe.version === '8.19.4' && probe.user === 'octo-dev' && probe.capabilities.items.query === false && probe.capabilities.iterations === 'none', 'probe: version, account, no work items, no iterations');
      ok(probe.warnings.some(w => /Jira/.test(w)), 'the probe says plainly that work items live in Jira, which is not supported');
      ok(probe.capabilities.protection.read === true && probe.capabilities.checks.read === true, 'protection (settings + restrictions) and build statuses are readable here');

      // ── the version lock: the PR moved between the read and the merge → 409 → conflict, one POST, no retry ──
      forge.setScenario('version-lock');
      const posts0 = forge.requests.filter(r => r.method === 'POST').length;
      const locked = await env.attempt(() => a.pulls.merge(ctx, '7', { method: 'merge', sha: HEAD }));
      const posts = forge.requests.filter(r => r.method === 'POST').slice(posts0);
      ok(locked.error?.code === 'conflict' && locked.error.status === 409 && /Look at it again/.test(locked.error.message), 'a stale PR version is a `conflict` that says to look again');
      ok(posts.length === 1 && posts[0].query.version === '4' && posts[0].body?.strategyId === 'no-ff', 'exactly one merge POST, carrying the version just read (4); it is not retried with a newer one');
      const moved = await env.attempt(() => a.pulls.merge(ctx, '7', { method: 'merge', sha: BASE }));
      ok(moved.error?.code === 'conflict' && forge.requests.filter(r => r.method === 'POST').length === posts0 + 1, 'a head that is not the reviewed one is refused before any POST');
      forge.setScenario('dc');
    },
    open: async (env) => {
      const { adapter: a, ctx, assert: ok } = env;
      const prot = await a.protection.read(ctx, 'main');
      ok(prot.protected === false && !prot.unreadable, 'a repository with no requirements and no restrictions is readable and unprotected');
    },
    'limited-token': async (env) => {
      const { adapter: a, ctx, assert: ok } = env;
      const probe = await a.probe(ctx);
      ok(probe.version === undefined && probe.user === 'octo-dev', 'a server that hides its version is still a working connection');
      const pull = await a.pulls.get(ctx, '7');
      ok(pull.canMerge === false && pull.mergeBlockers.some(b => /not asked/i.test(b)), 'when the token cannot ask the merge check, canMerge is false and says why');
    },
    hostile: async (env) => {
      const { adapter: a, ctx, assert: ok } = env;
      const pull = await a.pulls.get(ctx, '7');
      ok(pull.mergeBlockers.every(b => b.length < 400 && !/<!--/.test(b)), 'a veto message from the server is sanitised and capped');
    },
  };

  // The "open" scenario is reached through a conformance-free run: the profile list only has the four standard ones.
  const result = await runConformance({
    name: 'bitbucket-dc', T, adapter: dc, makeConnection: connectionMaker('bitbucket-dc'), token: TOKEN, subject, assert, extra,
    fixturesDir: path.join(here, 'fixtures', 'connections', 'bitbucket-dc'),
    scenarios: [
      { scenario: 'dc', profile: 'full' },
      { scenario: 'limited-token', profile: 'limited' },
      { scenario: 'rate-limited', profile: 'rate-limit' },
      { scenario: 'hostile', profile: 'hostile' },
    ],
  });
  void result;
}

// ═══════════════════════════════════════════════════════════
console.log('\n══ B6. DATA CENTER: AN UNPROTECTED REPOSITORY ══');
{
  const { startMockForge } = await import('./lib/mock-forge.mjs');
  const forge = await startMockForge({ fixtures: path.join(here, 'fixtures', 'connections', 'bitbucket-dc'), scenario: 'open', requireAuth: true, token: TOKEN });
  try {
    T.resetConnectionHttpForTest();
    const conn = await connectionMaker('bitbucket-dc')({ forge, scenario: 'open', token: TOKEN, id: 'bitbucket-dc-open' });
    const client = new T.ConnectionClient(conn, { ...dc.clientOptions(conn), retries: 0 });
    const ctx = { conn, client, repo: { owner: 'ACME', name: 'widgets' } };
    const prot = await dc.protection.read(ctx, 'main');
    assert(prot.protected === false && !prot.unreadable && prot.requiredReviews === 0, 'no requirements and no restrictions: readable, unprotected, zero required reviews');
    const probe = await dc.probe(ctx);
    assert(probe.capabilities.protection.read === true && probe.capabilities.checks.read === true, 'probe: protection and checks readable on an open repository');
  } finally { await forge.stop(); }
}

console.log(`\n══ SUMMARY ══\n  ${passed} passed, ${failed} failed`);
if (failed) { console.log(`  failures:\n    ${failures.join('\n    ')}`); process.exit(1); }
process.exit(0);
