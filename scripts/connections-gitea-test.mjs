/**
 * The Gitea, Forgejo and GitBucket adapters, tested offline (ADR 0039): unit checks first
 * (remote URL parsing incl. a server under a path and GitBucket's /git/ clone form, API base,
 * hosts and the `token` auth scheme, the Gitea fold rules as tables, GitBucket's thinner pull
 * request fold, the query-text splitter), then the shared conformance script
 * (scripts/connections-conformance.mjs) against the loopback mock forge:
 *
 *   Gitea      v1-22 (full), v1-16 (an older server: thin protection, no statuses), limited-token
 *              (a read-only token), rate-limited, hostile;
 *   Forgejo    forgejo-7 (full; the same API under a Forgejo version string), plus the cross-check
 *              that adding a Forgejo server as Gitea (and the reverse) warns instead of failing;
 *   GitBucket  bucket-4 (the supported subset of GitHub's API v3), rate-limited, hostile, plus a
 *              check that every gap is a capability that stays off.
 *
 * Part of `npm test`. No model, no network beyond 127.0.0.1, no real forge: scripts/lib/mock-forge.mjs
 * replays hand-written fixtures from scripts/fixtures/connections/{gitea,gitbucket}/ (documented
 * API shapes; the owner records real ones before these providers are called supported). A fixture
 * pull request that is "being checked" carries an updated_at far in the future, so the two-minute
 * grace that tells a conflict from a check in progress holds whatever the clock says. The only
 * credential is an obviously fake canary.
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

const TOKEN = 'gtea-Can4ry-Tok-7e3d9a41c0b5f268'; // standards-allow: secret (test canary)
const gitea = T.giteaAdapter;
const forgejo = T.forgejoAdapter;
const bucket = T.gitbucketAdapter;
const GF = T.GiteaFold;
const BF = T.GitbucketFold;
const Rest = T.ConnRest;

// ═══════════════════════════════════════════════════════════
console.log('\n══ E1. REMOTE URLS ══');
{
  const repo = { owner: 'octo-org', name: 'widgets' };
  const g = 'https://git.corp.test';
  const table = [
    [gitea, 'https://git.corp.test/octo-org/widgets.git', g, repo],
    [gitea, 'https://git.corp.test/octo-org/widgets', g, repo],
    [gitea, 'https://git.corp.test/octo-org/widgets/', g, repo],
    [gitea, 'https://oauth2:fake-userinfo@git.corp.test/octo-org/widgets.git', g, repo],
    [gitea, 'git@git.corp.test:octo-org/widgets.git', g, repo],
    [gitea, 'ssh://git@git.corp.test:2222/octo-org/widgets.git', g, repo],
    [gitea, 'https://git.corp.test/octo-org/widgets/src/branch/main', g, undefined],
    [gitea, 'https://git.corp.test/octo-org/sub/widgets.git', g, undefined],
    [gitea, 'https://git.corp.test/octo-org', g, undefined],
    [gitea, 'https://github.com/octo-org/widgets.git', g, undefined],
    [gitea, 'https://git.corp.test.evil.test/octo-org/widgets.git', g, undefined],
    [gitea, 'https://git.corp.test:3000/octo-org/widgets.git', 'https://git.corp.test:3000', repo],
    [gitea, 'https://git.corp.test/octo-org/widgets.git', 'https://git.corp.test:3000', undefined],
    [gitea, 'https://corp.test/gitea/octo-org/widgets.git', 'https://corp.test/gitea', repo],
    [gitea, 'https://corp.test/other/octo-org/widgets.git', 'https://corp.test/gitea', undefined],
    [forgejo, 'https://codeberg.test/octo-org/widgets.git', 'https://codeberg.test', repo],
    [forgejo, 'git@codeberg.test:octo-org/widgets.git', 'https://codeberg.test', repo],
    [bucket, 'http://127.0.0.1:8080/octo-org/widgets.git', 'http://127.0.0.1:8080', repo],
    [bucket, 'http://127.0.0.1:8080/git/octo-org/widgets.git', 'http://127.0.0.1:8080', repo],
    [bucket, 'http://127.0.0.1:8080/gitbucket/git/octo-org/widgets.git', 'http://127.0.0.1:8080/gitbucket', repo],
    [bucket, 'http://127.0.0.1:8080/other/octo-org/widgets.git', 'http://127.0.0.1:8080', undefined],
    [bucket, 'ssh://octo@127.0.0.1:29418/octo-org/widgets.git', 'http://127.0.0.1:8080', repo],
    [bucket, 'http://127.0.0.1:8080/a/b/c/d.git', 'http://127.0.0.1:8080', undefined],
    [bucket, 'http://127.0.0.1:9090/octo-org/widgets.git', 'http://127.0.0.1:8080', undefined],
  ];
  const wrong = table.filter(([a, u, b, want]) => !same(a.parseRemote(u, b), want));
  assert(wrong.length === 0, `parseRemote: ${table.length} forms (wrong: ${wrong.map(w => w[1]).join(' | ') || 'none'})`);
  assert(!JSON.stringify(gitea.parseRemote('https://oauth2:fake-userinfo@git.corp.test/octo-org/widgets.git', g)).includes('fake-userinfo'), 'userinfo never reaches the parsed repository');
}

// ═══════════════════════════════════════════════════════════
console.log('\n══ E2. API BASE, HOSTS, CLIENT OPTIONS ══');
{
  assert(gitea.apiBase({ baseUrl: 'https://git.corp.test' }) === 'https://git.corp.test/api/v1', 'Gitea REST base is /api/v1');
  assert(forgejo.apiBase({ baseUrl: 'https://codeberg.test/' }) === 'https://codeberg.test/api/v1', 'Forgejo REST base is /api/v1 too, whatever the trailing slash');
  assert(gitea.apiBase({ baseUrl: 'https://corp.test/gitea' }) === 'https://corp.test/gitea/api/v1', 'a server under a path keeps it');
  assert(bucket.apiBase({ baseUrl: 'http://127.0.0.1:8080/gitbucket/' }) === 'http://127.0.0.1:8080/gitbucket/api/v3', 'GitBucket REST base is <base>/api/v3');
  assert(same(gitea.hostsFor('https://git.corp.test:3000'), ['git.corp.test:3000']) && same(bucket.hostsFor('http://127.0.0.1:8080'), ['127.0.0.1:8080']), 'hostsFor keeps the port');
  for (const [a, base] of [[gitea, 'https://git.corp.test'], [forgejo, 'https://git.corp.test'], [bucket, 'http://127.0.0.1:8080']]) {
    const o = a.clientOptions({ baseUrl: base });
    assert(o.auth.kind === 'bearer' && o.auth.scheme === 'token', `${a.id}: the credential travels as "Authorization: token <value>" (the scheme these servers document)`);
  }
  assert(gitea.id === 'gitea' && forgejo.id === 'forgejo' && bucket.id === 'gitbucket', 'the adapters are named gitea, forgejo and gitbucket');
  assert(gitea.gitUsername({ probe: { user: 'ana' } }) === 'ana' && gitea.gitUsername({}) === 'x-access-token' && bucket.gitUsername({ probe: { user: 'bo' } }) === 'bo', 'git pairs the token with the probed account, else a placeholder');
  const applied = T.ConnRest ? true : false;
  assert(applied, 'the shared REST helpers are exported for the tests');
}

// ═══════════════════════════════════════════════════════════
console.log('\n══ E3. GITEA FOLDING RULES (tables) ══');
{
  const st = (status) => ({ context: 'c', status });
  const checks = [
    ['no statuses', [], 'none'], ['success', [st('success')], 'passing'], ['warning and skipped are not gates', [st('success'), st('warning'), st('skipped')], 'passing'],
    ['error', [st('error')], 'failing'], ['failure', [st('failure')], 'failing'], ['pending', [st('pending')], 'pending'],
    ['failure outranks pending', [st('failure'), st('pending')], 'failing'], ['pending outranks success', [st('success'), st('pending')], 'pending'],
    ['an unknown status is informational', [st('mystery')], 'passing'],
  ];
  const badChecks = checks.filter(([, s, want]) => GF.foldChecks(s).state !== want).map(c => c[0]);
  assert(badChecks.length === 0, `checks.state: ${checks.length} cases (wrong: ${badChecks.join(' | ') || 'none'})`);

  const now = Date.parse('2026-10-09T12:00:00Z');
  const open = (o) => ({ number: 1, state: 'open', merged: false, ...o });
  const merge = [
    [open({ mergeable: true }), 'mergeable'],
    [open({ mergeable: false, updated_at: '2026-10-09T11:50:00Z' }), 'conflicting'],
    [open({ mergeable: false, updated_at: '2026-10-09T11:59:00Z' }), 'unknown'],
    [open({ mergeable: false, updated_at: '2026-10-09T11:57:59Z' }), 'conflicting'],
    [open({ mergeable: false, created_at: '2026-10-09T11:59:30Z' }), 'unknown'],
    [open({ mergeable: false }), 'unknown'],
    [open({}), 'unknown'],
    [open({ state: 'closed', merged: true, mergeable: false, updated_at: '2020-01-01T00:00:00Z' }), 'unknown'],
  ];
  const badMerge = merge.filter(([i, want]) => GF.foldMergeable(i, now) !== want).map(m => JSON.stringify(m[0]));
  assert(badMerge.length === 0, `mergeable: ${merge.length} cases; false inside the two-minute grace is "still being checked", never a conflict (wrong: ${badMerge.join(' | ') || 'none'})`);

  const rv = (state, o = {}) => ({ id: 1, user: { login: 'x' }, state, ...o });
  const revs = [
    ['none', [], 0, undefined, 'none', 0, 0],
    ['a requested reviewer', [], 1, undefined, 'pending', 0, 0],
    ['one approval, two required', [rv('APPROVED')], 0, 2, 'pending', 1, 0],
    ['two approvals, two required', [rv('APPROVED'), { ...rv('APPROVED'), user: { login: 'y' } }], 0, 2, 'approved', 2, 0],
    ['an approval that is not official counts for nothing', [rv('APPROVED', { official: false })], 0, 1, 'pending', 0, 0],
    ['changes requested', [rv('REQUEST_CHANGES')], 0, 1, 'changes', 0, 1],
    ['changes then approval by the same person', [rv('REQUEST_CHANGES'), rv('APPROVED')], 0, 1, 'approved', 1, 0],
    ['a comment does not undo changes', [rv('REQUEST_CHANGES'), rv('COMMENT')], 0, 1, 'changes', 0, 1],
    ['a dismissed review is erased', [rv('REQUEST_CHANGES'), rv('REQUEST_CHANGES', { dismissed: true })], 0, undefined, 'none', 0, 0],
    ['review requests and pending reviews are not verdicts', [rv('REQUEST_REVIEW'), rv('PENDING')], 0, undefined, 'none', 0, 0],
  ];
  const badRev = revs.filter(([, r, req, need, state, a, c]) => {
    const got = GF.foldPullReviews(r, req, need);
    return got.state !== state || got.approved !== a || got.changesRequested !== c || got.required !== need;
  }).map(c => c[0]);
  assert(badRev.length === 0, `reviews: ${revs.length} cases through the shared fold (wrong: ${badRev.join(' | ') || 'none'})`);

  const okRev = { state: 'none', approved: 0, changesRequested: 0 };
  const okChecks = { state: 'passing', items: [] };
  const canCases = [
    [open({ mergeable: true }), okRev, okChecks, undefined, true],
    [open({ mergeable: true }), okRev, { state: 'none', items: [] }, undefined, true],
    [open({ mergeable: true, draft: true }), okRev, okChecks, undefined, false],
    [open({ mergeable: true, title: 'WIP: x' }), okRev, okChecks, undefined, false],
    [open({ mergeable: true, title: '[WIP] x' }), okRev, okChecks, undefined, false],
    [open({ mergeable: false }), okRev, okChecks, undefined, false],
    [open({}), okRev, okChecks, undefined, false],
    [open({ mergeable: true, state: 'closed' }), okRev, okChecks, undefined, false],
    [open({ mergeable: true }), { state: 'changes', approved: 0, changesRequested: 1 }, okChecks, undefined, false],
    [open({ mergeable: true }), { state: 'pending', approved: 0, changesRequested: 0 }, okChecks, undefined, false],
    [open({ mergeable: true }), okRev, { state: 'failing', items: [] }, undefined, false],
    [open({ mergeable: true }), okRev, { state: 'pending', items: [] }, undefined, false],
    [open({ mergeable: true }), { state: 'approved', approved: 1, changesRequested: 0 }, okChecks, { protected: true, requiredReviews: 2 }, false],
    [open({ mergeable: true }), { state: 'approved', approved: 2, changesRequested: 0 }, okChecks, { protected: true, requiredReviews: 2 }, true],
    [open({ mergeable: true }), okRev, okChecks, { protected: true, requiredReviews: 2, unreadable: 'x' }, true],
  ];
  const badCan = canCases.filter(([p, r, c, prot, want]) => GF.foldCanMerge(p, r, c, prot) !== want).map((c, i) => `#${i} ${JSON.stringify(c[0])}`);
  assert(badCan.length === 0, `canMerge: ${canCases.length} cases, conservative on reviews and checks (wrong: ${badCan.join(' | ') || 'none'})`);

  const folded = GF.foldPull({
    connection: 'c1', nowMs: now, now: '2026-10-09T12:00:00.000Z',
    pr: { number: 7, state: 'closed', merged: true, merge_commit_sha: 'abc1234', head: { sha: 'h1' }, mergeable: false, updated_at: '2020-01-01T00:00:00Z', html_url: 'https://forge.test/o/r/pulls/7' },
    statuses: [{ context: 'ci', status: 'success' }], reviews: [], protection: { protected: true, requiredReviews: 1, requiredChecks: ['ci'] },
  });
  assert(folded.id === '7' && folded.state === 'merged' && folded.mergedSha === 'abc1234' && folded.headSha === 'h1' && folded.protectedBase === true && folded.reviews.required === 1 && folded.canMerge === false, 'foldPull: id as string, merged state and sha, protection feeds required reviews, a merged PR is not mergeable');
  const bl = GF.foldPull({ connection: 'c1', nowMs: now, pr: { number: 8, state: 'open', mergeable: false, updated_at: '2020-01-01T00:00:00Z' }, statuses: [{ context: 'ci', status: 'failure' }], reviews: [] });
  assert(bl.mergeable === 'conflicting' && bl.mergeBlockers.some(b => /conflicts/.test(b)) && bl.mergeBlockers.some(b => /Check failed: ci/.test(b)), 'foldPull: a conflict and a red check each say so');
  assert(GF.isDraft({ draft: true }) && GF.isDraft({ title: 'WIP: x' }) && GF.isDraft({ title: '[WIP] x' }) && !GF.isDraft({ title: 'Wipe the cache' }), 'isDraft: the flag and the title prefixes, not a word that begins with wip');
  const item = GF.foldItem({ number: 3, title: 'T <!-- hidden -->', body: null, state: 'closed', labels: ['sp:3', { name: 'bug' }], assignees: [{ login: 'a' }], user: { login: 'u' }, updated_at: 'R', milestone: { id: 31, title: 'M' } });
  assert(item.id === '3' && item.title === 'T' && item.body === '' && item.state === 'closed' && item.points === 3 && same(item.labels, ['sp:3', 'bug']) && item.milestone.id === '31' && item.iteration === '31' && item.rev === 'R', 'foldItem: id, sanitised title, points from a label, milestone id, rev');
  assert(GF.foldItem({ number: 4, title: 'x', assignee: { login: 'solo' } }).assignees[0] === 'solo' && GF.foldItem({ number: 5, title: 'x', labels: null }).labels.length === 0, 'foldItem: the single `assignee` of older servers counts; null labels are none');
  const rc = GF.foldReviewComment({ id: 5, user: { login: 'r' }, state: 'REQUEST_CHANGES', body: 'b', submitted_at: 'T' }, 'COLLABORATOR');
  assert(rc?.review === 'changes' && rc.association === 'COLLABORATOR' && GF.foldReviewComment({ id: 6, state: 'PENDING' }, 'NONE') === undefined && GF.foldReviewComment({ id: 7, state: 'COMMENT', dismissed: true }, 'NONE') === undefined, 'review comments: verdicts are conversation, pending and dismissed are not');
}

// ═══════════════════════════════════════════════════════════
console.log('\n══ E4. GITBUCKET FOLD AND QUERY TEXT ══');
{
  const open = (o) => ({ number: 1, state: 'open', merged: false, ...o });
  const ok = [{ context: 'ci', state: 'success' }];
  const cases = [
    [open({ mergeable: true }), ok, 'mergeable', true], [open({ mergeable: true }), [], 'mergeable', true],
    [open({ mergeable: false }), ok, 'conflicting', false], [open({ mergeable: null }), ok, 'unknown', false], [open({}), ok, 'unknown', false],
    [open({ mergeable: true }), [{ context: 'ci', state: 'failure' }], 'mergeable', false],
    [open({ mergeable: true }), [{ context: 'ci', state: 'error' }], 'mergeable', false],
    [open({ mergeable: true }), [{ context: 'ci', state: 'pending' }], 'mergeable', false],
    [open({ mergeable: true, state: 'closed', merged: true }), ok, 'unknown', false],
  ];
  const bad = cases.filter(([p, s, want, can]) => { const f = BF.foldPull({ connection: 'c', pr: p, statuses: s }); return f.mergeable !== want || f.canMerge !== can; }).map(c => JSON.stringify(c[0]));
  assert(bad.length === 0, `GitBucket pull: ${cases.length} cases; mergeable is a plain boolean, unknown stays unknown, a red or running status blocks (wrong: ${bad.join(' | ') || 'none'})`);
  const f = BF.foldPull({ connection: 'c', pr: open({ number: 9, merged: true, state: 'closed', merge_commit_sha: 'm1', head: { sha: 'h' } }), statuses: [] });
  assert(f.state === 'merged' && f.mergedSha === 'm1' && f.reviews.state === 'none' && f.draft === false && f.checks.state === 'none', 'GitBucket pull: merged state and sha; no reviews, no drafts, no checks are reported as such');
  assert(BF.foldPull({ connection: 'c', pr: open({ mergeable: true }), statuses: [], protection: { protected: true, requiredChecks: ['ci'] } }).protectedBase === true, 'GitBucket pull: a readable protected branch is reported');

  const q = (t) => Object.fromEntries(Object.entries(Rest.parseItemQuery(t)).sort(([a], [b]) => (a < b ? -1 : 1)));
  assert(same(q('is:open label:bug crash on login'), { labels: ['bug'], state: 'open', text: 'crash on login' }), 'query text: is:, label: and free text');
  assert(same(q('label:bug,docs assignee:@ana author:bo is:closed'), { assignee: 'ana', author: 'bo', labels: ['bug', 'docs'], state: 'closed', text: '' }), 'query text: comma labels, @ stripped, closed');
  assert(same(q('milestone:1 login'), { labels: [], text: 'milestone:1 login' }), 'query text: an unknown qualifier stays free text, nothing is dropped');
  assert(same(q(''), { labels: [], text: '' }) && same(q('is:wat'), { labels: [], text: 'is:wat' }), 'query text: empty, and a state that is not a state, are harmless');
}

// ═══════════════════════════════════════════════════════════
const vault = T.configureVault({ dir: path.join(testHome, 'vault'), keyProvider: T.memoryKeyProvider() });
function connectionMaker(provider) {
  return async ({ forge, scenario, token, id }) => {
    const credential = `cred-${id}`;
    await vault.create({
      name: credential, kind: 'api-token', secret: { token }, url: forge.url, createdBy: 'user',
      policy: { approval: 'auto', allowedTools: ['Connection'], allowedOrigins: [forge.url] },
    });
    return {
      id, provider, label: `Mock ${scenario}`, baseUrl: forge.url, hosts: [forge.host], insecureHttp: true,
      createdAt: new Date().toISOString(), createdBy: 'person', credential,
    };
  };
}

const head = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const base = 'b0b1b2b3b4b5b6b7b8b9babbbcbdbebf00112233';
const mergeSha = 'c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00';
const sub = {
  repo: { owner: 'octo-org', name: 'widgets' },
  head: 'aico/task-42', base: 'main', createTitle: 'Add widget cache',
  pullId: '7', headSha: head, baseSha: base,
  staleSha: '0'.repeat(40), unmergeableSha: '1'.repeat(40), mergeSha, mergeMethod: 'squash',
  issueId: '11', issueRev: '2026-10-01T10:00:00Z', staleRev: '2020-01-01T00:00:00Z', me: 'octo-dev',
  prNumbers: [12], pagedNumbers: [13],
  removableLabel: 'needs-triage', goneLabel: 'gone',
  protectedBranch: 'main', unprotectedBranch: 'dev', hostileBigIssue: '22',
};

// ═══════════════════════════════════════════════════════════
console.log('\n══ E5. CONFORMANCE: GITEA (v1-22, v1-16, limited-token, rate-limited, hostile) ══');
{
  const R = '/api/v1/repos/octo-org/widgets';
  const requestsTo = (all, method, re) => all.filter(r => r.method === method && re.test(r.path));
  const subject = {
    ...sub,
    milestoneId: '31',
    createPath: new RegExp(`${R}/pulls$`), pullCommentPath: new RegExp(`${R}/issues/7/comments$`), mergePath: new RegExp(`${R}/pulls/7/merge$`),
    mergeHttpMethod: 'POST',
    mergeRequestOk: (req) => {
      const b = req?.body ?? {};
      if (b.Do !== 'squash') return `Do is ${b.Do}`;
      if (b.head_commit_id !== head) return `head_commit_id is ${b.head_commit_id}`;
      const extra = Object.keys(b).filter(k => !['Do', 'head_commit_id'].includes(k));
      return extra.length ? `extra keys ${extra.join(', ')} (force_merge is the admin bypass and is never sent)` : true;
    },
    pullExpect: [
      { state: 'open', mergeable: 'mergeable', canMerge: false, checks: 'pending', reviews: 'pending' },
      { state: 'open', mergeable: 'mergeable', canMerge: false, checks: 'failing', reviews: 'changes' },
      { state: 'open', mergeable: 'mergeable', canMerge: true, checks: 'passing', reviews: 'approved' },
      { state: 'open', mergeable: 'conflicting', canMerge: false, checks: 'passing', reviews: 'approved' },
      { state: 'merged', mergeable: 'unknown', canMerge: false, checks: 'passing', reviews: 'approved' },
    ],
    associations: ['COLLABORATOR', 'NONE'], hostileAssociations: ['COLLABORATOR', 'NONE'],
    issuesPath: new RegExp(`${R}/issues$`), issuePath: new RegExp(`${R}/issues/11$`), issueCommentPath: new RegExp(`${R}/issues/11/comments$`), labelsPath: new RegExp(`${R}/issues/11/labels$`),
    rateLimitStatus: 429,
    wire: {
      authScheme: 'token',
      itemsQueryOk: (all) => all.some(r => r.query.labels === 'bug' && r.query.state === 'open' && r.query.type === 'issues' && r.query.since === '2026-09-01T00:00:00.000Z' && r.query.limit === '50'),
      assignedOk: (all, items) => items.length > 0 && items.every(i => i.assignees.includes('octo-dev')),
      updateVerb: 'PATCH',
      // Gitea keeps labels in their own resource: one PATCH for the fields, one PUT for the label ids.
      updateSentOk: (all) => requestsTo(all, 'PATCH', new RegExp(`${R}/issues/11$`)).some(r => r.body?.title === 'Cache invalidation on widget update (reworded)' && r.body?.milestone === 31 && Object.keys(r.body).sort().join() === 'milestone,title')
        && requestsTo(all, 'PUT', new RegExp(`${R}/issues/11/labels$`)).some(r => same(r.body?.labels, [1, 2, 3]) && Object.keys(r.body).length === 1),
      updateWrites: 2,
      closeOk: (b) => b?.state === 'closed' && Object.keys(b).length === 1,
      labelsOk: (all) => { const p = requestsTo(all, 'POST', new RegExp(`${R}/issues/11/labels$`)); return p.length === 1 && same(p[0].body?.labels, [3]); },
      assignOk: (b) => b?.milestone === 31,
    },
  };

  const extra = {
    'v1-22': async (env) => {
      const { forge, adapter: a, ctx, assert: ok } = env;
      ok(forge.requests.every(r => r.path.startsWith('/api/v1/')), 'every request went to /api/v1');
      ok(forge.requests.every(r => r.headers.accept === 'application/json'), 'every request asked for JSON');
      ok(forge.requests.every(r => r.headers.authorization === `token ${TOKEN}`), 'the token travels as "Authorization: token <value>", never "Bearer"');
      const find = forge.requests.find(r => r.method === 'GET' && r.path === `${R}/pulls` && r.query.state === 'open');
      ok(find?.query.limit === '50' && find.query.sort === 'recentupdate', 'pulls.find lists the open pull requests (there is no head filter) a page at a time');
      const again = await env.attempt(() => a.pulls.find(ctx, 'aico/task-42'));
      ok(again.value?.id === '7' && again.value.state === 'merged', 'pulls.find returns the PR that has the task branch, once it exists');
      const created = forge.requests.find(r => r.method === 'POST' && r.path === `${R}/pulls`);
      ok(Object.keys(created?.body ?? {}).sort().join() === 'base,body,head,title', 'the pull request is created from the branch, base, title and body only');
      const draft = await env.attempt(() => a.pulls.create(ctx, { head: 'aico/task-43', base: 'main', title: 'Another change', body: 'x', draft: true }));
      ok(!draft.error && forge.requests.filter(r => r.method === 'POST' && r.path === `${R}/pulls`).at(-1)?.body?.title === 'WIP: Another change', 'a draft is a "WIP:" title prefix');
      const mr = forge.requests.filter(r => r.method === 'POST' && r.path === `${R}/pulls/7/merge`);
      ok(mr.length >= 3 && mr.every(r => !('force_merge' in (r.body ?? {})) && !('merge_when_checks_succeed' in (r.body ?? {}))), 'no merge request ever asked for force_merge (the admin bypass) or an auto-merge');
      const afterMerge = forge.requests.slice(forge.requests.indexOf(mr.at(-1))).find(r => r.method === 'GET' && r.path === `${R}/pulls/7`);
      ok(!!afterMerge, 'the merge commit is read back from the pull request (the merge answers with an empty body)');

      const before = forge.requests.length;
      const lab = await env.attempt(() => a.items.addLabels(ctx, '11', ['aico:in-review']));
      const sent = forge.requests.slice(before);
      const mk = sent.find(r => r.method === 'POST' && r.path === `${R}/labels`);
      ok(!lab.error && mk?.body?.name === 'aico:in-review' && /^#[0-9a-f]{6}$/i.test(mk.body.color) && sent.some(r => r.method === 'POST' && r.path === `${R}/issues/11/labels` && same(r.body?.labels, [9])),
        'a label that does not exist is created once, then applied by id (these servers do not create labels from names)');
      const ms = await env.attempt(() => a.iterations.list(ctx));
      ok(ms.value?.length === 2 && ms.value.every(i => i.kind === 'milestone') && ms.value[0].url === `${forge.url}/octo-org/widgets/milestone/31`, 'iterations are milestones, with a rebuilt web address');
      const unmapped = await env.attempt(() => a.probe({ ...ctx, repo: undefined }));
      ok(unmapped.value?.capabilities.pulls.create === true && unmapped.value.capabilities.items.query === true && unmapped.value.warnings.some(w => /Checked against octo-org\/widgets/.test(w)),
        'a test before any repository is mapped checks one the account can write to, so the chips come from real calls');
      const noRepo = await env.attempt(() => a.pulls.get({ ...ctx, repo: undefined }, '7'));
      ok(noRepo.error?.code === 'config' && /Gitea repository/.test(noRepo.error.message), 'an operation without a mapped repository says to map it, naming the server');
      const badId = await env.attempt(() => a.pulls.get(ctx, '7/../x'));
      ok(badId.error?.code === 'config', 'a pull request number that is not a number is refused');
      const prot = await env.attempt(() => a.protection.read(ctx, 'main'));
      ok(prot.value?.requiredReviews === 1 && same(prot.value.requiredChecks, ['ci/lint']), 'protection reads the required approvals and the required status contexts from the branch');
    },
    'v1-16': async (env) => {
      const { forge, assert: ok } = env;
      ok(forge.requests.every(r => r.method === 'GET'), 'a read-only script made no writes');
    },
  };

  await runConformance({
    name: 'gitea', T, adapter: gitea, makeConnection: connectionMaker('gitea'), token: TOKEN, subject, assert, extra,
    fixturesDir: path.join(here, 'fixtures', 'connections', 'gitea'),
    scenarios: [
      { scenario: 'v1-22', profile: 'full' },
      { scenario: 'v1-16', profile: 'degraded' },
      { scenario: 'limited-token', profile: 'limited' },
      { scenario: 'rate-limited', profile: 'rate-limit' },
      { scenario: 'hostile', profile: 'hostile' },
    ],
  });

  console.log('\n══ E6. CONFORMANCE: FORGEJO (forgejo-7) ══');
  await runConformance({
    name: 'forgejo', T, adapter: forgejo, makeConnection: connectionMaker('forgejo'), token: TOKEN, subject, assert,
    extra: {
      'forgejo-7': async (env) => {
        const { forge, adapter: a, ctx, assert: ok } = env;
        const p = await env.attempt(() => a.probe(ctx));
        ok(p.value?.version === '7.0.5+gitea-1.22.0' && !p.value.warnings.some(w => /Gitea version|Forgejo version/.test(w)), 'a Forgejo server added as Forgejo raises no flavour warning');
        ok(p.value?.warnings.some(w => /^Forgejo has milestones/.test(w)), 'messages name Forgejo');
        const err = await env.attempt(() => a.pulls.get({ ...ctx, repo: undefined }, '7'));
        ok(/Forgejo repository/.test(err.error?.message ?? ''), 'errors name Forgejo, not Gitea');
        ok(forge.requests.every(r => r.headers.authorization === `token ${TOKEN}`), 'Forgejo takes the same `token` scheme');
        // The same server added under the other name: a warning that says so, not a failed connection.
        const asGitea = await env.attempt(() => gitea.probe(ctx));
        ok(asGitea.value?.warnings.some(w => /reports a Forgejo version/.test(w)), 'a Forgejo server added as Gitea warns "add it as Forgejo"');
      },
    },
    fixturesDir: path.join(here, 'fixtures', 'connections', 'gitea'),
    scenarios: [{ scenario: 'forgejo-7', profile: 'full' }],
  });
}

// ═══════════════════════════════════════════════════════════
console.log('\n══ E7. CONFORMANCE: GITBUCKET (bucket-4, rate-limited, hostile) ══');
{
  const R = '/api/v3/repos/octo-org/widgets';
  const subject = {
    ...sub,
    milestoneId: '1',
    createPath: new RegExp(`${R}/pulls$`), pullCommentPath: new RegExp(`${R}/issues/7/comments$`), mergePath: new RegExp(`${R}/pulls/7/merge$`),
    mergeHttpMethod: 'PUT',
    mergeRequestOk: (req) => {
      const b = req?.body ?? {};
      const keys = Object.keys(b);
      return same(keys, ['merge_method']) && b.merge_method === 'squash' ? true : `body ${JSON.stringify(b)}`;
    },
    pullExpect: [
      { state: 'open', mergeable: 'mergeable', canMerge: false, checks: 'pending', reviews: 'none' },
      { state: 'open', mergeable: 'mergeable', canMerge: false, checks: 'failing', reviews: 'none' },
      { state: 'open', mergeable: 'mergeable', canMerge: true, checks: 'passing', reviews: 'none' },
      { state: 'open', mergeable: 'conflicting', canMerge: false, checks: 'passing', reviews: 'none' },
      { state: 'merged', mergeable: 'unknown', canMerge: false, checks: 'passing', reviews: 'none' },
    ],
    associations: ['COLLABORATOR', 'NONE'], hostileAssociations: ['COLLABORATOR', 'NONE'],
    issuesPath: new RegExp(`${R}/issues$`), issuePath: new RegExp(`${R}/issues/11$`), issueCommentPath: new RegExp(`${R}/issues/11/comments$`), labelsPath: new RegExp(`${R}/issues/11/labels$`),
    rateLimitStatus: 403,
    wire: {
      authScheme: 'token',
      itemsQueryOk: (all) => all.some(r => r.query.state === 'open') && all.every(r => !r.query.labels && !r.query.since),
      assignedOk: (all, items) => items.length > 0 && items.every(i => i.assignees.includes('octo-dev')),
    },
  };

  const extra = {
    'bucket-4': async (env) => {
      const { forge, adapter: a, ctx, assert: ok } = env;
      ok(forge.requests.every(r => r.path.startsWith('/api/v3/')), 'every request went to /api/v3');
      ok(!forge.requests.some(r => /check-runs|\/reviews|graphql|\/search\//.test(r.path)), 'nothing GitBucket does not have is asked of it (no check-runs, reviews, GraphQL or search)');
      ok(forge.requests.every(r => r.headers.authorization === `token ${TOKEN}`), 'the token travels as "Authorization: token <value>"');
      const probe = await env.attempt(() => a.probe(ctx));
      const c = probe.value?.capabilities;
      ok(!!c && c.pulls.draft === false && c.checks.rerun === false && c.checks.logsUrl === false && c.iterations === 'milestone' && c.items.estimate === 'label',
        'every GitBucket gap is a capability that stays off: no draft pull requests, no re-run, no log links, milestones not iterations, estimates as labels');
      ok(probe.value?.warnings.some(w => /no check-runs or reviews/.test(w)) === true && probe.value?.scopes.reported === false, 'the gaps are said in words, and no scopes are invented');
      const info = await env.attempt(() => a.repos.get(ctx, { owner: 'octo-org', name: 'widgets' }));
      ok(info.value?.cloneUrl === `${forge.url}/git/octo-org/widgets.git`, 'the clone address has GitBucket\'s /git/ prefix, built from the base URL');
      const missing = await env.attempt(() => a.items.get(ctx, '99'));
      ok(missing.error?.code === 'not-found' && !/GitHub/.test(missing.error.message), 'a missing issue is "not found, or the token cannot see it"');
      const refused = await env.attempt(() => a.items.get(ctx, '98'));
      ok(/^GitBucket refused access to Issue #98/.test(refused.error?.message ?? '') && !/GitHub/.test(refused.error?.message ?? ''), 'delegated GitHub-adapter errors are re-worded for GitBucket');
      const merge405 = await env.attempt(() => a.pulls.merge(ctx, '7', { method: 'rebase', sha: head }));
      ok(merge405.error?.code === 'conflict' && merge405.error.status === 405, 'a merge GitBucket refuses is a `conflict`, not a crash');
      const stale = await env.attempt(() => a.pulls.merge(ctx, '7', { method: 'merge', sha: '2'.repeat(40) }));
      const putsAfter = forge.requests.filter(r => r.method === 'PUT' && /pulls\/7\/merge$/.test(r.path)).length;
      ok(stale.error?.code === 'conflict' && putsAfter === 2, 'a stale head is refused here, before any merge request (the API cannot be told which head was reviewed)');
      const unmapped = await env.attempt(() => a.probe({ ...ctx, repo: undefined }));
      ok(unmapped.value?.capabilities.pulls.create === true && unmapped.value.capabilities.checks.read === true && unmapped.value.warnings.some(w => /Checked against octo-org\/widgets/.test(w)),
        'a test before any repository is mapped checks one the account can write to, so the chips come from real calls');
      const noRepo = await env.attempt(() => a.pulls.get({ ...ctx, repo: undefined }, '7'));
      ok(noRepo.error?.code === 'config' && /GitBucket repository/.test(noRepo.error.message), 'an operation without a mapped repository says to map it');
    },
  };

  await runConformance({
    name: 'gitbucket', T, adapter: bucket, makeConnection: connectionMaker('gitbucket'), token: TOKEN, subject, assert, extra,
    fixturesDir: path.join(here, 'fixtures', 'connections', 'gitbucket'),
    scenarios: [
      { scenario: 'bucket-4', profile: 'full' },
      { scenario: 'rate-limited', profile: 'rate-limit' },
      { scenario: 'hostile', profile: 'hostile' },
    ],
  });
}

console.log(`\n══ SUMMARY ══\n  ${passed} passed, ${failed} failed`);
if (failed) { console.log(`  failures:\n    ${failures.join('\n    ')}`); process.exit(1); }
process.exit(0);
