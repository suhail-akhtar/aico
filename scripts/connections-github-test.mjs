/**
 * The GitHub adapter, tested offline (ADR 0039): GitHub-specific unit checks first (remote
 * URL parsing, API base and hosts for github.com versus GHES, the PullState folding rules as
 * tables, the extra-power detection), then the shared conformance script
 * (scripts/connections-conformance.mjs) against the loopback mock forge for the dotcom,
 * ghes-old, limited-token, rate-limited and hostile scenarios.
 *
 * Part of `npm test`. No model, no network beyond 127.0.0.1, no real GitHub: the "forge" is
 * scripts/lib/mock-forge.mjs replaying hand-written fixtures from
 * scripts/fixtures/connections/github/. The store is this process's own AICO_HOME and the vault
 * key lives in memory. The only credential is an obviously fake canary.
 *
 * A mock on loopback is not api.github.com, so the adapter treats it as GitHub Enterprise Server
 * (`<origin>/api/v3`, `<origin>/api/graphql`) and the fixtures are served under those paths;
 * the "dotcom" scenario is therefore github.com's response SHAPES on the GHES URL layout. The
 * github.com URL layout itself is asserted directly in the unit checks below.
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

const TOKEN = 'ghx-Can4ry-Tok-7e3d9a41c0b5f268'; // standards-allow: secret (test canary)
const adapter = T.githubAdapter;
const P = T.GithubAdapterParts;
const F = T.GithubFold;
const S = T.GithubScopes;

// ═══════════════════════════════════════════════════════════
console.log('\n══ G1. REMOTE URLS ══');
{
  const parse = (url, base) => adapter.parseRemote(url, base);
  const repo = { owner: 'octo-org', name: 'widgets' };
  const dot = 'https://github.com';
  const table = [
    ['https://github.com/octo-org/widgets.git', dot, repo],
    ['https://github.com/octo-org/widgets', dot, repo],
    ['https://github.com/octo-org/widgets/', dot, repo],
    ['https://x-access-token:fake-userinfo@github.com/octo-org/widgets.git', dot, repo],
    ['git@github.com:octo-org/widgets.git', dot, repo],
    ['git@github.com:octo-org/widgets', dot, repo],
    ['ssh://git@github.com/octo-org/widgets.git', dot, repo],
    ['ssh://git@github.com:22/octo-org/widgets.git', dot, repo],
    ['https://gitlab.com/octo-org/widgets.git', dot, undefined],
    ['git@gitlab.com:octo-org/widgets.git', dot, undefined],
    ['https://github.com.evil.test/octo-org/widgets.git', dot, undefined],
    ['https://github.com/octo-org', dot, undefined],
    ['https://github.com/octo-org/widgets/tree/main', dot, undefined],
    ['https://github.com/octo org/widgets', dot, undefined],
    ['file:///srv/git/widgets.git', dot, undefined],
    ['C:\\repos\\widgets', dot, undefined],
    ['', dot, undefined],
    ['https://ghe.corp.test/octo-org/widgets.git', 'https://ghe.corp.test', repo],
    ['git@ghe.corp.test:octo-org/widgets.git', 'https://ghe.corp.test', repo],
    ['ssh://git@ghe.corp.test:2222/octo-org/widgets.git', 'https://ghe.corp.test', repo],
    ['https://github.com/octo-org/widgets', 'https://ghe.corp.test', undefined],
    ['https://ghe.corp.test:8443/octo-org/widgets.git', 'https://ghe.corp.test:8443', repo],
    ['https://ghe.corp.test/octo-org/widgets.git', 'https://ghe.corp.test:8443', undefined],
    ['git@ghe.corp.test:octo-org/widgets.git', 'https://ghe.corp.test:8443', repo],
    ['http://127.0.0.1:4000/octo-org/widgets.git', 'http://127.0.0.1:4000', repo],
  ];
  const wrong = table.filter(([u, b, want]) => !same(parse(u, b), want));
  assert(wrong.length === 0, `parseRemote: ${table.length} forms (wrong: ${wrong.map(w => w[0]).join(' | ') || 'none'})`);
  const userinfo = parse('https://x-access-token:fake-userinfo@github.com/octo-org/widgets.git', dot);
  assert(!JSON.stringify(userinfo).includes('fake-userinfo'), 'userinfo never reaches the parsed repository');
}

// ═══════════════════════════════════════════════════════════
console.log('\n══ G2. API BASE, GRAPHQL, HOSTS, CLIENT OPTIONS ══');
{
  assert(adapter.apiBase({ baseUrl: 'https://github.com' }) === 'https://api.github.com', 'github.com REST base is api.github.com');
  assert(adapter.apiBase({ baseUrl: 'https://github.com/' }) === 'https://api.github.com', 'a trailing slash does not matter');
  assert(adapter.apiBase({ baseUrl: 'https://ghe.corp.test' }) === 'https://ghe.corp.test/api/v3', 'GHES REST base is <origin>/api/v3');
  assert(adapter.apiBase({ baseUrl: 'https://ghe.corp.test:8443/' }) === 'https://ghe.corp.test:8443/api/v3', 'GHES keeps a custom port');
  assert(adapter.apiBase({ baseUrl: 'http://127.0.0.1:4000' }) === 'http://127.0.0.1:4000/api/v3', 'any other host is GHES (the mock forge relies on this)');
  assert(P.githubGraphqlUrl({ baseUrl: 'https://github.com' }) === 'https://api.github.com/graphql', 'github.com GraphQL URL');
  assert(P.githubGraphqlUrl({ baseUrl: 'https://ghe.corp.test' }) === 'https://ghe.corp.test/api/graphql', 'GHES GraphQL URL');
  assert(same(adapter.hostsFor('https://github.com'), ['api.github.com', 'github.com']), 'hostsFor github.com: api and web hosts');
  assert(same(adapter.hostsFor('https://ghe.corp.test'), ['ghe.corp.test']), 'hostsFor GHES: its host');
  assert(same(adapter.hostsFor('https://ghe.corp.test:8443'), ['ghe.corp.test:8443']), 'hostsFor GHES keeps the port');
  const o = adapter.clientOptions({ baseUrl: 'https://ghe.corp.test' });
  assert(o.apiBase === 'https://ghe.corp.test/api/v3' && o.auth.kind === 'bearer', 'clientOptions: GHES base and bearer auth');
  assert(o.headers.Accept === 'application/vnd.github+json' && o.headers['X-GitHub-Api-Version'] === '2022-11-28', 'clientOptions: GitHub media type and API version');
  assert(adapter.id === 'github', 'the adapter is "github"');
}

// ═══════════════════════════════════════════════════════════
console.log('\n══ G3. FOLDING RULES (tables) ══');
{
  const run = (conclusion, status = 'completed') => ({ name: 'c', status, conclusion });
  const st = (state) => ({ context: 's', state });
  const checks = [
    ['no checks and no statuses', [], [], 'none'],
    ['one success', [run('success')], [], 'passing'],
    ['neutral and skipped do not fail', [run('neutral'), run('skipped')], [], 'passing'],
    ['stale is informational', [run('stale')], [], 'passing'],
    ['failure', [run('failure')], [], 'failing'],
    ['timed_out', [run('timed_out')], [], 'failing'],
    ['cancelled', [run('cancelled')], [], 'failing'],
    ['action_required', [run('action_required')], [], 'failing'],
    ['an error status', [], [st('error')], 'failing'],
    ['a failure status', [], [st('failure')], 'failing'],
    ['queued', [run(null, 'queued')], [], 'pending'],
    ['in progress', [run(null, 'in_progress')], [], 'pending'],
    ['a pending status', [], [st('pending')], 'pending'],
    ['failure outranks pending', [run('failure'), run(null, 'queued')], [st('pending')], 'failing'],
    ['pending outranks success', [run('success'), run(null, 'in_progress')], [], 'pending'],
    ['success run and success status', [run('success')], [st('success')], 'passing'],
  ];
  const badChecks = checks.filter(([, r, s, want]) => F.foldChecks(r, s).state !== want).map(c => c[0]);
  assert(badChecks.length === 0, `checks.state: ${checks.length} cases (wrong: ${badChecks.join(' | ') || 'none'})`);

  const rv = (user, state) => ({ id: 1, user: { login: user }, state });
  const reviews = [
    ['none at all', [], 0, undefined, 'none', 0, 0],
    ['a requested reviewer', [], 1, undefined, 'pending', 0, 0],
    ['one approval, requirement unknown', [rv('x', 'APPROVED')], 0, undefined, 'approved', 1, 0],
    ['one approval, two required', [rv('x', 'APPROVED')], 0, 2, 'pending', 1, 0],
    ['two approvals, two required', [rv('x', 'APPROVED'), rv('y', 'APPROVED')], 0, 2, 'approved', 2, 0],
    ['no approvals, one required', [], 0, 1, 'pending', 0, 0],
    ['no approvals, none required', [], 0, 0, 'none', 0, 0],
    ['an approval, none required', [rv('x', 'APPROVED')], 0, 0, 'approved', 1, 0],
    ['changes requested', [rv('x', 'CHANGES_REQUESTED')], 0, 1, 'changes', 0, 1],
    ['changes then approval by the same person', [rv('x', 'CHANGES_REQUESTED'), rv('x', 'APPROVED')], 0, 1, 'approved', 1, 0],
    ['approval then changes by the same person', [rv('x', 'APPROVED'), rv('x', 'CHANGES_REQUESTED')], 0, 1, 'changes', 0, 1],
    ['a later comment does not undo changes', [rv('x', 'CHANGES_REQUESTED'), rv('x', 'COMMENTED')], 0, 1, 'changes', 0, 1],
    ['a dismissed review is erased', [rv('x', 'CHANGES_REQUESTED'), rv('x', 'DISMISSED')], 0, undefined, 'none', 0, 0],
    ['a dismissed approval leaves the requirement unmet', [rv('x', 'APPROVED'), rv('x', 'DISMISSED')], 0, 1, 'pending', 0, 0],
    ['comment-only reviews count for nothing', [rv('x', 'COMMENTED')], 0, undefined, 'none', 0, 0],
    ['changes outrank approvals from others', [rv('x', 'APPROVED'), rv('y', 'CHANGES_REQUESTED')], 0, 1, 'changes', 1, 1],
  ];
  const badRev = reviews.filter(([, r, req, need, state, a, c]) => {
    const got = F.foldReviews(r, req, need);
    return got.state !== state || got.approved !== a || got.changesRequested !== c || got.required !== need;
  }).map(c => c[0]);
  assert(badRev.length === 0, `reviews: ${reviews.length} cases (wrong: ${badRev.join(' | ') || 'none'})`);

  const merge = [
    [{ mergeable: true, mergeable_state: 'clean' }, 'mergeable'],
    [{ mergeable: false }, 'conflicting'],
    [{ mergeable: null, mergeable_state: 'dirty' }, 'conflicting'],
    [{ mergeable: true, mergeable_state: 'dirty' }, 'conflicting'],
    [{ mergeable: null, mergeable_state: 'unknown' }, 'unknown'],
    [{ mergeable: null }, 'unknown'],
    [{}, 'unknown'],
  ];
  const badMerge = merge.filter(([i, want]) => F.foldMergeable(i) !== want).map(m => JSON.stringify(m[0]));
  assert(badMerge.length === 0, `mergeable: ${merge.length} cases, null is unknown (wrong: ${badMerge.join(' | ') || 'none'})`);

  const open = (mergeable_state, extra = {}) => ({ state: 'open', draft: false, merged: false, mergeable_state, ...extra });
  const can = [
    [open('clean'), true], [open('unstable'), true], [open('has_hooks'), true],
    [open('blocked'), false], [open('behind'), false], [open('dirty'), false], [open('draft'), false], [open('unknown'), false],
    [open('clean', { draft: true }), false], [open('clean', { state: 'closed' }), false], [open('clean', { merged: true }), false],
    [{ state: 'open' }, false],
  ];
  const badCan = can.filter(([i, want]) => F.foldCanMerge(i) !== want).map(c => JSON.stringify(c[0]));
  assert(badCan.length === 0, `canMerge: ${can.length} cases, only clean|unstable|has_hooks on an open non-draft PR (wrong: ${badCan.join(' | ') || 'none'})`);

  const none = { state: 'none', approved: 0, changesRequested: 0 };
  const blockers = [
    [open('blocked'), [], none, /Required reviews or checks are not satisfied/],
    [open('behind'), [], none, /behind the base/],
    [open('dirty'), [], none, /conflicts with the base/],
    [open('draft'), [], none, /is a draft/],
    [open('clean', { draft: true }), [], none, /is a draft/],
    [open('unknown'), [], none, /not finished/],
    [open('blocked'), [{ name: 'build', state: 'failure' }], none, /Check failed: build/],
    [open('blocked'), [], { state: 'changes', approved: 0, changesRequested: 1, required: 1 }, /requested changes/],
    [open('blocked'), [], { state: 'pending', approved: 0, changesRequested: 0, required: 2 }, /0 of 2 required approvals/],
  ];
  const badBlock = blockers.filter(([i, c, r, re]) => !F.foldBlockers(i, c, r).some(s => re.test(s))).map(b => String(b[3]));
  assert(badBlock.length === 0, `mergeBlockers: ${blockers.length} cases give plain sentences (missing: ${badBlock.join(' | ') || 'none'})`);
  assert(F.foldBlockers(open('clean'), [], none).length === 0 && F.foldBlockers({ state: 'closed', merged: true }, [], none).length === 0, 'a clean or finished PR has no blockers');

  const pr = { number: 7, html_url: 'https://forge.test/o/r/pull/7', state: 'closed', merged: true, merge_commit_sha: 'abc1234', head: { sha: 'h1' }, mergeable: null, mergeable_state: 'unknown' };
  const folded = F.foldPull({ connection: 'c1', pr, runs: [], statuses: [], reviews: [], protection: { protected: true, requiredReviews: 2, requiredChecks: [] }, now: '2026-10-09T00:00:00.000Z' });
  assert(folded.connection === 'c1' && folded.id === '7' && folded.state === 'merged' && folded.mergedSha === 'abc1234' && folded.headSha === 'h1', 'foldPull: connection, id as string, merged state, merge sha, head sha');
  assert(folded.protectedBase === true && folded.reviews.required === 2 && folded.canMerge === false && folded.observedAt === '2026-10-09T00:00:00.000Z', 'foldPull: protection feeds protectedBase and required reviews; merged is not mergeable');
  const unreadable = F.foldPull({ connection: 'c1', pr: { ...pr, state: 'open', merged: false, mergeable_state: 'blocked', mergeable: true }, runs: [], statuses: [], reviews: [], protection: { protected: false, unreadable: 'needs repo admin' } });
  assert(unreadable.protectedBase === undefined && unreadable.reviews.required === undefined && unreadable.state === 'open', 'foldPull: unreadable protection leaves protectedBase and required unknown');
  const closedUnmerged = F.foldPull({ connection: 'c1', pr: { number: 8, state: 'closed', merged: false }, runs: [], statuses: [], reviews: [] });
  assert(closedUnmerged.state === 'closed' && closedUnmerged.mergedSha === undefined, 'foldPull: closed without merging is `closed`');

  const labels = [['sp:5', 5], ['points:3', 3], ['estimate:8', 8], ['Story Points: 2', 2], ['sp-13', 13], ['sp:2.5', 2.5], ['sprint:5', undefined], ['sp:', undefined], ['bug', undefined]];
  const badPts = labels.filter(([l, want]) => F.pointsFromLabels([l]) !== want).map(l => l[0]);
  assert(badPts.length === 0, `estimate labels: ${labels.length} cases (wrong: ${badPts.join(' | ') || 'none'})`);

  const clipped = F.clipText(`${'a'.repeat(9)}😀b`, 10);
  assert(clipped.head === 'a'.repeat(9) && clipped.overflow === '😀b', 'clipText never splits a surrogate pair');
  assert(F.clipText('abc', 10).overflow === undefined, 'clipText leaves short text alone');
  assert(F.safeUrl('javascript:alert(1)') === undefined && F.safeUrl('https://forge.test/x') === 'https://forge.test/x' && F.safeUrl('data:text/html,x') === undefined, 'safeUrl keeps http(s) only');
  const item = F.foldItem({ number: 3, title: 'T <!-- hidden -->', body: null, state: 'closed', labels: ['sp:3', { name: 'bug' }], assignees: [{ login: 'a' }], user: { login: 'u' }, updated_at: 'R', milestone: { number: 2, title: 'M' } });
  assert(item.id === '3' && item.title === 'T' && item.body === '' && item.state === 'closed' && item.points === 3 && same(item.labels, ['sp:3', 'bug']) && item.milestone.id === '2' && item.rev === 'R', 'foldItem: id, sanitised title, points from a label, milestone, rev');
}

// ═══════════════════════════════════════════════════════════
console.log('\n══ G4. SCOPES AND EXTRA POWER ══');
{
  assert(S.parseScopes(undefined) === undefined, 'no header: scopes are not reported');
  assert(same(S.parseScopes(''), []), 'an empty header: reported, none held');
  assert(same(S.parseScopes('repo, read:user'), ['repo', 'read:user']), 'a scope list is split and trimmed');
  assert(same(S.missingScopes(['repo'], true), ['read:user']) && same(S.missingScopes(['repo', 'read:user'], true), []) && same(S.missingScopes(['repo', 'user'], true), []), 'missing scopes are computed by name; `user` covers read:user');
  assert(same(S.missingScopes([], false), []), 'missing scopes are not computed when the provider does not report scopes');
  const extra = S.extraPowers(['repo', 'admin:org', 'delete_repo', 'admin:repo_hook', 'admin:public_key', 'write:packages', 'read:user']);
  const has = (s) => extra.some(e => e.startsWith(`${s}:`));
  assert(['admin:org', 'delete_repo', 'admin:repo_hook', 'admin:public_key', 'write:packages', 'repo'].every(has), `extra powers named in plain words (${extra.length})`);
  assert(!has('read:user') && S.extraPowers(['read:user']).length === 0, 'a least-privilege scope is not flagged');
  assert(extra.find(e => e.startsWith('repo:')).includes('fine-grained'), 'the broad `repo` note recommends a fine-grained token');
  assert(S.neededScopes(true).some(n => n.scope === 'repo' && n.required) && S.neededScopes(false).some(n => /Pull requests/.test(n.scope)), 'needed scopes: classic scopes, or the fine-grained list');
}

// ═══════════════════════════════════════════════════════════
console.log('\n══ G5. CONFORMANCE (dotcom, ghes-old, limited-token, rate-limited, hostile) ══');
{
  const vault = T.configureVault({ dir: path.join(testHome, 'vault'), keyProvider: T.memoryKeyProvider() });
  async function makeConnection({ forge, scenario, token, id }) {
    const credential = `cred-${id}`;
    await vault.create({
      name: credential, kind: 'api-token', secret: { token }, url: forge.url, createdBy: 'user',
      policy: { approval: 'auto', allowedTools: ['Connection'], allowedOrigins: [forge.url] },
    });
    return {
      id, provider: 'github', label: `Mock ${scenario}`, baseUrl: forge.url, hosts: [forge.host], insecureHttp: true,
      createdAt: new Date().toISOString(), createdBy: 'person', credential,
    };
  }

  const head = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
  const base = 'b0b1b2b3b4b5b6b7b8b9babbbcbdbebf00112233';
  const R = '/api/v3/repos/octo-org/widgets';
  const subject = {
    repo: { owner: 'octo-org', name: 'widgets' },
    head: 'aico/task-42', base: 'main', createTitle: 'Add widget cache',
    pullId: '7', headSha: head, baseSha: base,
    staleSha: '0'.repeat(40), unmergeableSha: '1'.repeat(40), mergeSha: 'c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00', mergeMethod: 'squash',
    createPath: new RegExp(`${R}/pulls$`), pullCommentPath: new RegExp(`${R}/issues/7/comments$`), mergePath: new RegExp(`${R}/pulls/7/merge$`),
    pullExpect: [
      { state: 'open', mergeable: 'mergeable', canMerge: false, checks: 'pending', reviews: 'pending' },
      { state: 'open', mergeable: 'mergeable', canMerge: false, checks: 'failing', reviews: 'changes' },
      { state: 'open', mergeable: 'mergeable', canMerge: true, checks: 'passing', reviews: 'approved' },
      { state: 'merged', mergeable: 'unknown', canMerge: false, checks: 'passing', reviews: 'approved' },
    ],
    associations: ['MEMBER', 'NONE'],
    issueId: '11', issueRev: '2026-10-01T10:00:00Z', staleRev: '2020-01-01T00:00:00Z', milestoneId: '2', me: 'octo-dev',
    prNumbers: [12], pagedNumbers: [13],
    issuesPath: new RegExp(`${R}/issues$`), issuePath: new RegExp(`${R}/issues/11$`), issueCommentPath: new RegExp(`${R}/issues/11/comments$`), labelsPath: new RegExp(`${R}/issues/11/labels$`),
    removableLabel: 'needs-triage', goneLabel: 'gone',
    protectedBranch: 'main', unprotectedBranch: 'dev',
    hostileBigIssue: '22',
  };

  const extra = {
    dotcom: async (env) => {
      const { forge, adapter: a, ctx, assert: ok } = env;
      ok(forge.requests.every(r => r.headers.accept === 'application/vnd.github+json' && r.headers['x-github-api-version'] === '2022-11-28'), 'every request carried the GitHub media type and API version');
      const gql = forge.requests.filter(r => r.path === '/api/graphql');
      ok(gql.length > 0 && gql.every(r => r.method === 'POST' && typeof r.body?.query === 'string' && r.body.variables?.owner === 'octo-org'), 'Projects v2 is read with a plain GraphQL POST at /api/graphql');
      const find = forge.requests.find(r => r.method === 'GET' && r.path === `${R}/pulls` && r.query.head);
      ok(find?.query.head === 'octo-org:aico/task-42' && find.query.state === 'open', 'pulls.find asks for the open PR whose head is owner:branch');
      const before = forge.requests.length;
      await env.attempt(() => a.items.query(ctx, { source: 'query', value: 'repo:evil/other label:bug' }));
      const search = forge.requests.slice(before).find(r => r.path === '/api/v3/search/issues');
      ok(!!search && !/evil\/other/.test(search.query.q) && /repo:octo-org\/widgets/.test(search.query.q), 'a search query cannot name another repository');
      const noMilestoneCalls = forge.requests.filter(r => r.path === `${R}/milestones` && r.query.per_page === '1');
      ok(noMilestoneCalls.length === 0, 'with native iterations the probe does not fall back to milestones');
    },
  };

  const result = await runConformance({
    name: 'github', T, adapter, makeConnection, token: TOKEN, subject, assert, extra,
    fixturesDir: path.join(here, 'fixtures', 'connections', 'github'),
    scenarios: [
      { scenario: 'dotcom', profile: 'full' },
      { scenario: 'ghes-old', profile: 'degraded' },
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
