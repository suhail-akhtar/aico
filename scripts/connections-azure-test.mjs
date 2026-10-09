/**
 * The Azure DevOps adapter, and the iteration <-> sprint sync it feeds, tested offline (ADR 0039).
 *
 *  A1-A5  pure units: every spelling of an Azure DevOps remote, API base / REST version / client options,
 *         the folding rules as tables (votes, policies, checks, mergeability, HTML descriptions, work item
 *         states by category for the four processes), WIQL building and the person-typed condition check,
 *         id batching.
 *  A6     the shared conformance script (scripts/connections-conformance.mjs) over the loopback mock forge
 *         for a full Server, an older Server (REST version fallback, no team iterations), a limited token,
 *         a rate limit and hostile text, plus Azure-specific wire checks.
 *  A7-A9  WIQL paging and the 200-id batches, a dead PAT answered with 203 + HTML, the 4000-character
 *         description limit and its overflow thread.
 *  A10    iteration <-> sprint sync end to end: the real adapter, the real vault and store, a real
 *         Delivery board, a mock forge whose answers change between syncs. Imports never start spend, the
 *         platform owns the sprint's name and dates, membership and story points merge three ways (remote
 *         wins, a local change is pushed once), a person's click is the only way a remote iteration is made.
 *
 * Part of `npm test`. No model, no network beyond 127.0.0.1, no real Azure DevOps: the "service" is
 * scripts/lib/mock-forge.mjs replaying hand-written fixtures from scripts/fixtures/connections/azure-devops/
 * (documented REST 7.1 / 6.0 shapes; the owner still records real ones before this adapter is called
 * supported). The only credential is an obviously fake canary.
 */

// A store of this process's own: nothing below may touch ~/.aico. Must stay first.
import { testHome } from './lib/test-home.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { T } from './lib/dist.mjs';
import { runConformance } from './connections-conformance.mjs';
import { startMockForge } from './lib/mock-forge.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
let passed = 0;
let failed = 0;
const failures = [];
function assert(cond, name, detail) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; failures.push(name); console.log(`  ✗ ${name}${detail !== undefined ? ` - ${JSON.stringify(detail).slice(0, 700)}` : ''}`); }
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const TOKEN = 'azp-Can4ry-Pat-5b8d1e07c3a94f62'; // standards-allow: secret (test canary)
const adapter = T.azureDevopsAdapter;
const P = T.AzureAdapterParts;
const F = T.AzureFold;
const U = T.AzureUrls;
const W = T.AzureWiql;
const C = T.StateCategories;
const { ConnectionError, ConnectionClient, ConnService, ConnStore, ConnSync, ConnIterations: Iter, Delivery: D, DeliveryStore: S, DeliveryScrum: Scrum } = T;

const tmpRoot = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'aico-azure-')));
process.on('exit', () => { try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* best effort */ } });

// ═══════════════════════════════════════════════════════════
console.log('\n══ A1. REMOTE URLS AND BASE ADDRESSES ══');
{
  const repo = { owner: 'Shop', name: 'web' };
  const parse = (url, base) => adapter.parseRemote(url, base);
  const svc = 'https://dev.azure.com/acme';
  const table = [
    ['https://dev.azure.com/acme/Shop/_git/web', svc, repo],
    ['https://acme@dev.azure.com/acme/Shop/_git/web', svc, repo],
    ['https://dev.azure.com/acme/Shop/_git/web/', svc, repo],
    ['https://dev.azure.com/Acme/Shop/_git/web', svc, repo],
    ['git@ssh.dev.azure.com:v3/acme/Shop/web', svc, repo],
    ['ssh://git@ssh.dev.azure.com/v3/acme/Shop/web', svc, repo],
    ['https://acme.visualstudio.com/Shop/_git/web', svc, repo],
    ['https://acme.visualstudio.com/DefaultCollection/Shop/_git/web', svc, repo],
    ['acme@vs-ssh.visualstudio.com:v3/acme/Shop/web', svc, repo],
    ['https://dev.azure.com/acme/My%20Shop/_git/my%20web', svc, { owner: 'My Shop', name: 'my web' }],
    ['https://dev.azure.com/acme/_git/web', svc, { owner: 'web', name: 'web' }],
    ['https://dev.azure.com/other/Shop/_git/web', svc, undefined],
    ['git@ssh.dev.azure.com:v3/other/Shop/web', svc, undefined],
    ['https://github.com/acme/web.git', svc, undefined],
    ['https://dev.azure.com/acme/Shop', svc, undefined],
    ['https://dev.azure.com/acme/Shop/_git/web/pullrequest/5', svc, undefined],
    ['https://dev.azure.com.evil.test/acme/Shop/_git/web', svc, undefined],
    ['file:///srv/git/web.git', svc, undefined],
    ['C:\\repos\\web', svc, undefined],
    ['', svc, undefined],
    ['https://dev.azure.com/acme/Shop/_git/web', 'https://acme.visualstudio.com', repo],
    ['https://acme.visualstudio.com/Shop/_git/web', 'https://acme.visualstudio.com', repo],
    ['https://tfs.corp/tfs/DefaultCollection/Shop/_git/web', 'https://tfs.corp/tfs/DefaultCollection', repo],
    ['https://tfs.corp/tfs/DefaultCollection/_git/web', 'https://tfs.corp/tfs/DefaultCollection', { owner: 'web', name: 'web' }],
    ['ssh://tfs.corp:22/tfs/DefaultCollection/Shop/_git/web', 'https://tfs.corp/tfs/DefaultCollection', repo],
    ['ssh://tfs.corp:22/DefaultCollection/Shop/_git/web', 'https://tfs.corp/tfs/DefaultCollection', repo],
    ['https://tfs.corp/DefaultCollection/Shop/_git/web', 'https://tfs.corp/DefaultCollection', repo],
    ['https://tfs.corp/other/Shop/_git/web', 'https://tfs.corp/tfs/DefaultCollection', undefined],
    ['https://tfs.corp:8443/tfs/DefaultCollection/Shop/_git/web', 'https://tfs.corp/tfs/DefaultCollection', undefined],
    ['https://dev.azure.com/acme/Shop/_git/web', 'https://tfs.corp/tfs/DefaultCollection', undefined],
    ['http://127.0.0.1:4000/Shop/_git/web', 'http://127.0.0.1:4000', repo],
  ];
  const wrong = table.filter(([u, b, want]) => !same(parse(u, b), want));
  assert(wrong.length === 0, `parseRemote: ${table.length} forms (wrong: ${wrong.map(w => w[0]).join(' | ') || 'none'})`);
  assert(!JSON.stringify(parse('https://acme@dev.azure.com/acme/Shop/_git/web', svc)).includes('acme@'), 'user-info never reaches the parsed repository');

  const sug = adapter.suggestFromRemote('git@ssh.dev.azure.com:v3/acme/Shop/web');
  assert(sug?.baseUrl === 'https://dev.azure.com/acme' && same(sug.repo, repo), 'suggestFromRemote: an ssh remote names the organization to connect');
  assert(adapter.suggestFromRemote('https://acme.visualstudio.com/Shop/_git/web')?.baseUrl === 'https://dev.azure.com/acme', 'suggestFromRemote: a legacy host suggests the canonical address');
  assert(adapter.suggestFromRemote('https://github.com/a/b.git') === undefined && adapter.suggestFromRemote('https://tfs.corp/tfs/DefaultCollection/Shop/_git/web') === undefined, 'suggestFromRemote: only Azure DevOps Services remotes are recognised without a connection');

  assert(U.parseBase('https://dev.azure.com/acme').kind === 'services' && U.parseBase('https://dev.azure.com/acme/').apiBase === 'https://dev.azure.com/acme', 'parseBase: Services keeps the organization in the API base');
  assert(U.parseBase('https://dev.azure.com') === undefined && U.parseBase('https://dev.azure.com/-bad') === undefined, 'parseBase: Services without a valid organization is refused');
  assert(U.parseBase('https://acme.visualstudio.com/').kind === 'legacy' && U.parseBase('https://acme.visualstudio.com/').org === 'acme', 'parseBase: the legacy host');
  const srv = U.parseBase('https://tfs.corp/tfs/DefaultCollection/');
  assert(srv.kind === 'server' && srv.apiBase === 'https://tfs.corp/tfs/DefaultCollection' && srv.path === '/tfs/DefaultCollection', 'parseBase: a Server collection keeps its path, without a trailing slash');
  assert(same(adapter.hostsFor('https://dev.azure.com/acme'), ['dev.azure.com']) && same(adapter.hostsFor('https://acme.visualstudio.com'), ['acme.visualstudio.com']) && same(adapter.hostsFor('https://tfs.corp:8443/tfs/DefaultCollection'), ['tfs.corp:8443']), 'hostsFor: dev.azure.com, the legacy host, or the server host with its port');

  const names = [['Shop', 'web', true], ['My Shop', 'my web', true], ['Ünï', 'ñ', true], ['', 'web', false], ['a/b', 'web', false], [' x', 'web', false], ['a:b', 'web', false], ['x.', 'web', false], ['Shop', 'we?b', false], ['Shop', '..', false], ['Shop', 'a\\b', false]];
  const badNames = names.filter(([o, n, ok]) => (adapter.validateRepo({ owner: o, name: n }) === undefined) !== ok).map(x => `${x[0]}/${x[1]}`);
  assert(badNames.length === 0, `validateRepo: ${names.length} names (wrong: ${badNames.join(' | ') || 'none'}); spaces are fine, path characters are not`);

  const base = U.parseBase(svc);
  assert(U.cloneUrl(base, { owner: 'My Shop', name: 'web' }) === 'https://dev.azure.com/acme/My%20Shop/_git/web' && !U.cloneUrl(base, repo).includes('@'), 'cloneUrl: encoded, rebuilt from the base, no user-info');
  assert(U.itemWebUrl(base, 'Shop', 11) === 'https://dev.azure.com/acme/Shop/_workitems/edit/11' && U.pullWebUrl(base, repo, 7).endsWith('/Shop/_git/web/pullrequest/7'), 'web URLs are built from the base');
}

// ═══════════════════════════════════════════════════════════
console.log('\n══ A2. API BASE, REST VERSION, CLIENT OPTIONS ══');
{
  assert(adapter.apiBase({ baseUrl: 'https://dev.azure.com/acme' }) === 'https://dev.azure.com/acme' && adapter.apiBase({ baseUrl: 'https://tfs.corp/tfs/DefaultCollection' }) === 'https://tfs.corp/tfs/DefaultCollection', 'apiBase: the organization or the collection');
  let threw = false; try { adapter.apiBase({ baseUrl: 'https://dev.azure.com' }); } catch (e) { threw = e instanceof ConnectionError && e.code === 'config'; }
  assert(threw, 'apiBase: an address without an organization is a config error');
  assert(P.restVersion({ baseUrl: 'https://dev.azure.com/acme' }) === '7.1', 'Services always speaks 7.1');
  assert(P.restVersion({ baseUrl: 'https://tfs.corp/c' }) === '6.0', 'a Server speaks 6.0 until a probe has negotiated');
  assert(P.restVersion({ baseUrl: 'https://tfs.corp/c', probe: { version: 'Azure DevOps Server (REST 7.0)' } }) === '7.0', 'a Server speaks what the last probe negotiated');
  const o = adapter.clientOptions({ baseUrl: 'https://tfs.corp/c', probe: { version: 'Azure DevOps Server (REST 7.0)' } });
  assert(o.auth.kind === 'basic-empty-user' && o.headers.Accept === 'application/json;api-version=7.0', 'clientOptions: a PAT as Basic with an empty user, the version in Accept');
  assert(P.VERSIONS.join() === '7.1,7.0,6.0,5.1' && P.PULL_BODY_MAX === 4000, 'versions tried highest first; the description limit is 4000');
  const dead = [[203, 'text/html'], [200, 'text/html; charset=utf-8'], [200, 'application/json'], [401, 'application/json'], [404, 'text/html'], [204, '']];
  assert(same(dead.map(([s, c]) => P.authFailure(s, {}, c)), [true, true, false, false, false, false]), 'authFailure: 203 and a 2xx HTML page are a dead token; JSON and errors are not');
  const hdr = T.applyAuth({ kind: 'basic-empty-user' }, new URL('https://x.test/'), 'tok-123');
  assert(hdr.headers.Authorization === `Basic ${Buffer.from(':tok-123').toString('base64')}`, 'a PAT is sent as base64(":" + token)');
  assert(adapter.defaultStateMap.running === 'InProgress' && adapter.defaultStateMap.merged === 'Completed' && adapter.defaultStateMap.blocked === 'aico:blocked', 'the default state map is categories, with blocked as a tag');
}

// ═══════════════════════════════════════════════════════════
console.log('\n══ A3. FOLDING RULES (tables) ══');
{
  const votes = [[10, 'approved'], [5, 'approved'], [0, 'none'], [-5, 'changes'], [-10, 'changes'], [undefined, 'none']];
  const badVotes = votes.filter(([v, want]) => F.foldVote(v) !== want).map(v => String(v[0]));
  assert(badVotes.length === 0, `votes: ${votes.length} cases (wrong: ${badVotes.join(' | ') || 'none'})`);
  const ms = [['succeeded', 'mergeable'], ['rejectedByPolicy', 'mergeable'], ['conflicts', 'conflicting'], ['queued', 'unknown'], ['notSet', 'unknown'], ['failure', 'unknown'], [undefined, 'unknown']];
  assert(ms.every(([s, want]) => F.foldMergeable(s) === want), 'mergeStatus: succeeded merges, conflicts conflict, everything not known yet is unknown');
  const kinds = [[T.AzureFold.POLICY.minReviewers, undefined, 'min-reviewers'], [T.AzureFold.POLICY.build, undefined, 'build'], [T.AzureFold.POLICY.requiredReviewers, undefined, 'required-reviewers'],
    [T.AzureFold.POLICY.comments, undefined, 'comments'], [T.AzureFold.POLICY.workItems, undefined, 'work-items'], [T.AzureFold.POLICY.status, undefined, 'status'],
    ['unknown-id', 'Minimum number of reviewers', 'min-reviewers'], ['unknown-id', 'Build', 'build'], ['unknown-id', 'Comment requirements', 'comments'], ['x', 'Something else', 'other']];
  assert(kinds.every(([id, name, want]) => F.policyKind({ type: { id, displayName: name } }) === want), 'policy kinds by id, then by name');

  const base = U.parseBase('https://dev.azure.com/acme');
  const repo = { owner: 'Shop', name: 'web' };
  const reviewer = (vote, over = {}) => ({ displayName: `r${vote}${JSON.stringify(over).length}`, uniqueName: `r${vote}-${Object.keys(over).join('')}@x.test`, vote, ...over });
  const ev = (kind, status, over = {}) => ({
    status, configuration: { isEnabled: true, isBlocking: true, type: { id: { build: F.POLICY.build, min: F.POLICY.minReviewers, comments: F.POLICY.comments, work: F.POLICY.workItems, req: F.POLICY.requiredReviewers }[kind] }, settings: { minimumApproverCount: 2, displayName: kind === 'build' ? 'CI' : undefined }, ...over.cfg }, context: kind === 'build' ? { buildId: 5 } : {},
  });
  const pr = (over = {}) => ({ pullRequestId: 7, status: 'active', isDraft: false, mergeStatus: 'succeeded', lastMergeSourceCommit: { commitId: 'h1' }, reviewers: [reviewer(10)], repository: { id: 'r', name: 'web', project: { id: 'p', name: 'Shop' } }, ...over });
  const fold = (prOver, evals, extra = {}) => F.foldPull({ connection: 'c1', base, repo, pr: pr(prOver), evaluations: evals, statuses: [], now: '2026-10-09T00:00:00.000Z', ...extra });

  const cases = [
    ['no policies at all, merge succeeded', fold({}, []), { canMerge: true, protectedBase: false, state: 'open' }],
    ['policies unreadable: never a guess', fold({}, undefined), { canMerge: false, protectedBase: undefined }],
    ['a rejected blocking build', fold({}, [ev('build', 'rejected'), ev('min', 'approved')]), { canMerge: false, checks: 'failing' }],
    ['a running build', fold({}, [ev('build', 'running'), ev('min', 'approved')]), { canMerge: false, checks: 'pending' }],
    ['an optional build that failed does not block or fail', fold({}, [ev('build', 'rejected', { cfg: { isBlocking: false } })]), { canMerge: true, checks: 'passing' }],
    ['all approved', fold({}, [ev('build', 'approved'), ev('min', 'approved')]), { canMerge: true, checks: 'passing', protectedBase: true }],
    ['a draft', fold({ isDraft: true }, [ev('min', 'approved')]), { canMerge: false, draft: true }],
    ['a conflict', fold({ mergeStatus: 'conflicts' }, [ev('min', 'approved')]), { canMerge: false, mergeable: 'conflicting' }],
    ['merge still being computed', fold({ mergeStatus: 'queued' }, [ev('min', 'approved')]), { canMerge: false, mergeable: 'unknown' }],
    ['rejected by policy', fold({ mergeStatus: 'rejectedByPolicy' }, [ev('min', 'rejected')]), { canMerge: false, mergeable: 'mergeable' }],
    ['a requested change blocks even with approvals', fold({ reviewers: [reviewer(10), reviewer(-5)] }, [ev('min', 'approved')]), { canMerge: false }],
    ['completed is merged', fold({ status: 'completed', lastMergeCommit: { commitId: 'm1' } }, []), { canMerge: false, state: 'merged', mergedSha: 'm1' }],
    ['abandoned is closed', fold({ status: 'abandoned' }, []), { canMerge: false, state: 'closed' }],
  ];
  const badCase = cases.filter(([, got, want]) => Object.entries(want).some(([k, v]) => (k === 'checks' ? got.checks.state : got[k]) !== v)).map(c => c[0]);
  assert(badCase.length === 0, `pull request folding: ${cases.length} cases (wrong: ${badCase.join(' | ') || 'none'})`);

  const blockers = (p) => p.mergeBlockers.join(' | ');
  assert(/comments are not all resolved/i.test(blockers(fold({}, [ev('comments', 'rejected')]))) && fold({}, [ev('comments', 'rejected')]).checks.items.length === 0, 'unresolved comments are a blocker with a sentence, not a check the agent is sent to fix');
  assert(/linked work item is required/i.test(blockers(fold({}, [ev('work', 'rejected')]))) && fold({}, [ev('work', 'rejected')]).checks.state === 'none', 'a missing work item link is a blocker, not a failing check');
  assert(/required reviewer/i.test(blockers(fold({}, [ev('req', 'running')]))), 'a required reviewer policy says so');
  assert(/1 of 2 required approvals/.test(blockers(fold({}, [ev('min', 'running')]))), 'minimum reviewers say how many approvals there are');
  assert(/policies could not be read/i.test(blockers(fold({}, undefined))) && !/policies could not be read/i.test(blockers(fold({}, undefined, { fresh: true }))) && /still evaluating/i.test(blockers(fold({ mergeStatus: 'queued' }, undefined, { fresh: true }))), 'unreadable policies are said once; a brand-new pull request is "still evaluating"');
  assert(fold({}, [ev('min', 'approved')]).reviews.required === 2 && fold({}, []).reviews.required === undefined, 'reviews.required comes from the minimum-reviewers policy; unknown when nothing is protected');

  const rv = (reviewers, required) => F.foldPrReviews(reviewers, required);
  assert(rv([], undefined).state === 'none' && rv([reviewer(0)], undefined).state === 'pending', 'no reviewers: none; an invited reviewer who has not voted: pending');
  assert(rv([reviewer(0, { isContainer: true })], undefined).state === 'pending' && rv([reviewer(0, { isContainer: true })], undefined).approved === 0, 'a group is a pending request, never an approval');
  assert(rv([reviewer(10), reviewer(5, { x: 1 })], 2).state === 'approved' && rv([reviewer(5)], 2).state === 'pending', '5 (approved with suggestions) counts as approved; two required, one given: pending');
  assert(rv([reviewer(10), reviewer(-10, { y: 1 })], 1).state === 'changes' && rv([reviewer(-5)], 1).changesRequested === 1, 'waiting-for-author and rejected both ask for changes');
  assert(rv([reviewer(-10, { hasDeclined: true })], undefined).state === 'none', 'a reviewer who declined is ignored');

  const withBuilds = F.foldPull({ connection: 'c1', base, repo, pr: pr(), evaluations: undefined, statuses: [], builds: [{ id: 9, status: 'completed', result: 'failed', definition: { name: 'CI' } }, { id: 8, status: 'completed', result: 'succeeded', definition: { name: 'CI' } }] });
  assert(withBuilds.checks.items.length === 2 && withBuilds.checks.state === 'failing' && withBuilds.canMerge === false, 'with policies unreadable the builds list stands in for the checks (and still does not allow a merge)');
  const deduped = F.foldPull({ connection: 'c1', base, repo, pr: pr(), evaluations: [], statuses: [{ id: 1, state: 'failed', context: { name: 'q', genre: 'g' } }, { id: 3, state: 'succeeded', context: { name: 'q', genre: 'g' } }, { id: 2, state: 'pending', context: { name: 'other' } }] });
  assert(deduped.checks.items.length === 2 && deduped.checks.items.find(c => c.name === 'g/q').state === 'success', 'statuses: the newest per context wins');

  assert(F.htmlToMarkdown('<div>Hello<br>world</div><ul><li>one</li><li>two &amp; three</li></ul>') === 'Hello\nworld\n\n- one\n- two & three', 'html: breaks, lists and entities');
  assert(F.htmlToMarkdown('<h2>Steps</h2><p>go <a href="https://x.test/a">here</a> now</p>').includes('## Steps') && F.htmlToMarkdown('<a href="javascript:alert(1)">bad</a>') === 'bad', 'html: headings, links kept only if http(s)');
  const hidden = F.htmlToMarkdown('<div>seen</div><div style="display:none">no1</div><span hidden>no2</span><p style="color:red;font-size:0px">no3</p><!-- no4 --><script>no5</script><div style="visibility: hidden"><b>no6</b></div><div class="hidden-note">kept</div>');
  assert(hidden.includes('seen') && hidden.includes('kept') && !/no[1-6]/.test(hidden), 'html: hidden elements, comments and scripts are removed; a class with "hidden" in its name is not', hidden);
  assert(F.htmlToMarkdown('&lt;script&gt;x&lt;/script&gt;') === '<script>x</script>' && F.htmlToMarkdown(undefined) === '' && F.htmlToMarkdown('plain') === 'plain', 'html: encoded markup becomes text, not markup; plain text and absence are fine');
  assert(F.markdownToHtml('a <b>&\nb') === '<div>a &lt;b&gt;&amp;<br>b</div>', 'what AICO writes is escaped and line-broken');

  const idx = F.indexStates([{ name: 'Task', states: [{ name: 'To Do', category: 'proposed' }, { name: 'Doing', category: 'inprogress' }, { name: 'Done', category: 'completed' }] }]);
  assert(F.categoryOf(idx, 'Task', 'Doing') === 'inprogress' && F.categoryOf(idx, 'Task', 'done') === 'completed', 'a state\'s category comes from the project\'s own types');
  assert(F.categoryOf(undefined, 'Bug', 'Closed') === 'completed' && F.categoryOf(undefined, 'Bug', 'Committed') === 'inprogress' && F.categoryOf(undefined, 'Bug', 'Weird custom') === 'proposed', 'without types the well-known names are the fallback; unknown reads as proposed, never done');

  const item = F.foldItem({ id: 11, rev: 5, fields: {
    'System.TeamProject': 'Shop', 'System.WorkItemType': 'User Story', 'System.Title': 'Cache  <!-- x -->  fix', 'System.State': 'Active', 'System.Tags': 'bug; aico:running ;  ', 'System.AssignedTo': 'Dana Dev <dana@x.test>',
    'System.IterationPath': 'Shop\\Sprint 1', 'System.AreaPath': 'Shop\\Web', 'Microsoft.VSTS.Scheduling.Effort': 8, 'System.Description': '<div>Body</div>',
    'Microsoft.VSTS.Common.AcceptanceCriteria': '<ul><li>one</li><li>two</li></ul>',
  } }, base);
  assert(item.id === '11' && item.rev === '5' && item.title === 'Cache fix' && item.state === 'open' && item.stateName === 'Active' && item.stateCategory === 'inprogress' && item.kind === 'User Story', 'item: id, revision as text, sanitised title, state and category', item);
  assert(same(item.labels, ['bug', 'aico:running', 'area:Shop\\Web']) && same(item.assignees, ['Dana Dev']) && item.points === 8 && item.iteration === 'Shop\\Sprint 1', 'item: tags split, area as a label, "Name <email>" reduced, points from Effort, the sprint path');
  assert(/## Acceptance\n\n?- one\n- two/.test(item.body) && item.body.startsWith('Body'), 'item: the acceptance criteria field becomes the "## Acceptance" checklist Delivery parses');
  const rootItem = F.foldItem({ id: 1, rev: 1, fields: { 'System.TeamProject': 'Shop', 'System.WorkItemType': 'Bug', 'System.State': 'Closed', 'System.IterationPath': 'Shop', 'System.AreaPath': 'Shop', 'Microsoft.VSTS.TCM.ReproSteps': '<div>1. open</div>' } }, base);
  assert(rootItem.iteration === undefined && rootItem.state === 'closed' && rootItem.labels.length === 0 && rootItem.body === '1. open', 'item: the root iteration means no sprint; Closed is closed; a bug\'s repro steps are its description');
  assert(F.splitTags('a;b; c ;;') .join() === 'a,b,c' && F.joinTags(['a', 'a', 'b;c', ' ']) === 'a; b c', 'tags: split and joined without duplicates or separators inside a tag');

  assert(F.nodePathToItemPath('\\Shop\\Iteration\\Release 1\\Sprint 2') === 'Shop\\Release 1\\Sprint 2' && F.nodePathToItemPath('\\Shop\\Iteration') === 'Shop', 'classification node path -> the System.IterationPath items carry');
  const nodes = F.foldNodes({ identifier: 'r', name: 'Iteration', path: '\\Shop\\Iteration', children: [
    { identifier: 'a', name: 'Sprint 1', path: '\\Shop\\Iteration\\Sprint 1', attributes: { startDate: '2026-09-28T00:00:00Z', finishDate: '2026-10-09T00:00:00Z' } },
    { identifier: 'b', name: 'Undated', path: '\\Shop\\Iteration\\Undated' },
  ] }, '2026-10-01');
  assert(nodes.length === 1 && nodes[0].itemKey === 'Shop\\Sprint 1' && nodes[0].start === '2026-09-28' && nodes[0].timeFrame === 'current', 'iteration tree: only dated nodes are sprints');

  const th = F.foldThreads([
    { id: 1, comments: [{ id: 1, author: { displayName: 'Rae', uniqueName: 'rae@x.test' }, content: '<p>hi</p>', publishedDate: '2026-10-02T00:00:00Z', commentType: 'text' }] },
    { id: 2, comments: [{ id: 1, author: { displayName: 'Sys' }, content: 'updated', publishedDate: '2026-10-01T00:00:00Z', commentType: 'system' }] },
    { id: 3, isDeleted: true, comments: [{ id: 1, author: { displayName: 'Gone' }, content: 'x', commentType: 'text' }] },
    { id: 4, comments: [{ id: 1, author: { displayName: 'Stranger', uniqueName: 's@y.test' }, content: 'yo', publishedDate: '2026-10-03T00:00:00Z', commentType: 'text' }] },
  ], pr({ createdBy: { displayName: 'Dana', uniqueName: 'd@x.test' }, reviewers: [{ displayName: 'Rae', uniqueName: 'rae@x.test' }] }), 'public');
  assert(th.length === 2 && th[0].author === 'Rae' && th[0].association === 'MEMBER' && th[1].association === 'NONE' && th[0].body === 'hi', 'comments: system and deleted dropped; in a public project only the creator and reviewers are members');
  assert(F.foldThreads([{ id: 1, comments: [{ id: 1, author: { displayName: 'Stranger' }, content: 'yo', commentType: 'text' }] }], pr(), 'private')[0].association === 'MEMBER', 'comments: commenting on a private project needs membership');
}

// ═══════════════════════════════════════════════════════════
console.log('\n══ A4. WORK ITEM STATES BY CATEGORY (the four processes) ══');
{
  const st = (...pairs) => pairs.map(([name, category]) => ({ name, category }));
  const processes = {
    Agile: { 'User Story': st(['New', 'proposed'], ['Active', 'inprogress'], ['Resolved', 'resolved'], ['Closed', 'completed'], ['Removed', 'removed']), Bug: st(['New', 'proposed'], ['Active', 'inprogress'], ['Resolved', 'resolved'], ['Closed', 'completed']), Task: st(['New', 'proposed'], ['Active', 'inprogress'], ['Closed', 'completed'], ['Removed', 'removed']), Epic: st(['New', 'proposed'], ['Done', 'completed']) },
    Scrum: { 'Product Backlog Item': st(['New', 'proposed'], ['Approved', 'proposed'], ['Committed', 'inprogress'], ['Done', 'completed'], ['Removed', 'removed']), Bug: st(['New', 'proposed'], ['Approved', 'proposed'], ['Committed', 'inprogress'], ['Done', 'completed']), Task: st(['To Do', 'proposed'], ['In Progress', 'inprogress'], ['Done', 'completed'], ['Removed', 'removed']) },
    CMMI: { Requirement: st(['Proposed', 'proposed'], ['Active', 'inprogress'], ['Resolved', 'resolved'], ['Closed', 'completed']), 'Change Request': st(['Proposed', 'proposed'], ['Active', 'inprogress'], ['Closed', 'completed']), Task: st(['Proposed', 'proposed'], ['Active', 'inprogress'], ['Resolved', 'resolved'], ['Closed', 'completed']) },
    Basic: { Issue: st(['To Do', 'proposed'], ['Doing', 'inprogress'], ['Done', 'completed']), Task: st(['To Do', 'proposed'], ['Doing', 'inprogress'], ['Done', 'completed']), Epic: st(['To Do', 'proposed'], ['Doing', 'inprogress'], ['Done', 'completed']) },
  };
  const expect = {
    Agile: { 'User Story': ['New', 'Active', 'Closed'], Bug: ['New', 'Active', 'Closed'], Task: ['New', 'Active', 'Closed'] },
    Scrum: { 'Product Backlog Item': ['New', 'Committed', 'Done'], Bug: ['New', 'Committed', 'Done'], Task: ['To Do', 'In Progress', 'Done'] },
    CMMI: { Requirement: ['Proposed', 'Active', 'Closed'], 'Change Request': ['Proposed', 'Active', 'Closed'], Task: ['Proposed', 'Active', 'Closed'] },
    Basic: { Issue: ['To Do', 'Doing', 'Done'], Task: ['To Do', 'Doing', 'Done'] },
  };
  for (const [name, types] of Object.entries(processes)) {
    assert(C.detectProcess(Object.keys(types)) === name, `${name}: the process is recognised from its type names`);
    const rows = C.previewStateMap(adapter.defaultStateMap, Object.entries(types).map(([n, states]) => ({ name: n, states })), ['backlog', 'running', 'merged', 'blocked']);
    const byAico = Object.fromEntries(rows.map(r => [r.aico, r]));
    const bad = [];
    for (const [type, [proposed, active, done]] of Object.entries(expect[name])) {
      const pick = (aico) => byAico[aico].perType.find(p => p.type === type)?.state;
      if (pick('backlog') !== proposed || pick('running') !== active || pick('merged') !== done) bad.push(`${type}: ${pick('backlog')}/${pick('running')}/${pick('merged')}`);
    }
    assert(bad.length === 0 && byAico.blocked.kind === 'tag', `${name}: backlog / running / merged map to each type's own Proposed / InProgress / Completed state, blocked stays a tag`, bad);
  }
  const preview = C.previewStateMap({ running: 'InProgress', merged: 'Resolved' }, [{ name: 'Task', states: st(['To Do', 'proposed'], ['Doing', 'inprogress'], ['Done', 'completed']) }], ['running', 'merged']);
  assert(preview[0].perType[0].state === 'Doing' && preview[1].perType[0].state === null && preview[1].category === 'resolved', 'the preview says when a type has no state in a category (it would not be moved)');
  assert(C.detectProcess(['Widget']) === 'Custom' && C.detectProcess([]) === 'Custom', 'an unrecognised process is Custom');

  const move = [[undefined, 'inprogress', true], ['proposed', 'inprogress', true], ['inprogress', 'inprogress', false], ['resolved', 'inprogress', false], ['completed', 'inprogress', false], ['removed', 'completed', false],
    ['inprogress', 'completed', true], ['resolved', 'completed', true], ['proposed', 'proposed', false], ['completed', 'completed', false]];
  assert(move.every(([cur, target, want]) => C.needsMove(cur, target) === want), 'needsMove: forward only, a closed item is never reopened');
  const words = [['InProgress', 'inprogress'], ['in progress', 'inprogress'], ['Completed', 'completed'], ['Proposed', 'proposed'], ['Removed', 'removed'], ['Resolved', 'resolved'], ['aico:running', undefined], ['', undefined], [undefined, undefined], ['open', undefined]];
  assert(words.every(([w, want]) => C.categoryWord(w) === want), 'a state-map value is a category only when it names one');
  assert(C.normaliseCategory('InProgress') === 'inprogress' && C.normaliseCategory('Mystery') === 'proposed' && C.normaliseCategory(7) === 'proposed', 'a category word from a newer API reads as proposed, never as done');
}

// ═══════════════════════════════════════════════════════════
console.log('\n══ A5. WIQL ══');
{
  const closed = ['Closed', 'Done', 'Removed'];
  const q = (over) => W.buildWiql({ source: 'label', value: 'bug', state: 'open', closedStates: closed, ...over });
  const base = q({});
  assert(base.startsWith('SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = @project') && base.endsWith('ORDER BY [System.ChangedDate] DESC'), 'wiql: scoped to the project, newest first');
  assert(base.includes("[System.State] NOT IN ('Closed', 'Done', 'Removed')") && base.includes("[System.Tags] CONTAINS 'bug'") && base.includes("[System.WorkItemType] NOT IN ('Epic', 'Feature'"), 'wiql: open states by name from the project\'s categories, the tag, no portfolio levels');
  assert(q({ state: 'closed' }).includes("[System.State] IN ('Closed'") && !q({ state: 'all' }).includes('[System.State]') && !q({ closedStates: [] }).includes('[System.State]'), 'wiql: closed and all, and no state filter when the states are unknown');
  assert(q({ source: 'assigned-to-me', value: undefined }).includes('[System.AssignedTo] = @Me') && q({ since: '2026-09-01T00:00:00.000Z' }).includes("[System.ChangedDate] >= '2026-09-01T00:00:00.000Z'"), 'wiql: @Me is the token\'s own identity; since uses a time-precise literal');
  assert(q({ value: "o'brien" }).includes("CONTAINS 'o''brien'") && W.literal("a'b\n") === "'a''b '", 'wiql: quotes are doubled, control characters dropped');
  assert(q({ source: 'query', value: "[System.AreaPath] UNDER 'Shop\\Web' AND [System.WorkItemType] = 'Bug'" }).includes("AND ([System.AreaPath] UNDER 'Shop\\Web' AND [System.WorkItemType] = 'Bug')"), 'wiql: a person\'s condition is parenthesised and AND-ed with the project');
  const bad = ['', '1=1) OR ([System.TeamProject] = \'Other\'', '(a', 'a)', "x = 'unterminated", 'SELECT [System.Id] FROM WorkItems', '[System.State] = \'New\' ORDER BY [System.Id]', 'a = 1; DROP', 'x'.repeat(700), '[System.Title] = "a) OR ("'];
  const results = bad.map(t => { try { W.checkCondition(t); return true; } catch (e) { return e instanceof ConnectionError && e.code === 'config' ? false : 'wrong error'; } });
  assert(same(results.slice(0, 9), Array(9).fill(false)) && results[9] === true, 'checkCondition refuses a fragment that could leave its parentheses, start a second statement or run past quotes; parentheses inside a quoted literal are fine', results);
  const ok = ["[System.Title] CONTAINS 'a (b'", '([System.State] = \'New\' OR [System.State] = \'Active\') AND [System.AreaPath] UNDER \'Shop\'', "[System.Tags] CONTAINS 'select'"];
  assert(ok.every(t => { try { W.checkCondition(t); return true; } catch { return false; } }), 'checkCondition accepts ordinary conditions, including keywords inside a quoted literal');
  const ids = Array.from({ length: 405 }, (_, i) => i + 1);
  const b = W.batches(ids);
  assert(b.length === 3 && b[0].length === 200 && b[1].length === 200 && b[2].length === 5 && b.flat().join() === ids.join(), 'batches: at most 200 ids each, order kept');
  assert(W.batches([]).length === 0 && W.batches([1]).length === 1, 'batches: empty and single');
}

// ═══════════════════════════════════════════════════════════
console.log('\n══ A6. CONFORMANCE (full, server-2020, limited-token, rate-limited, hostile) ══');
const vault = T.configureVault({ dir: path.join(testHome, 'vault'), keyProvider: T.memoryKeyProvider() });
async function makeConnection({ forge, scenario, token, id }) {
  const credential = `cred-${id}`;
  await vault.create({
    name: credential, kind: 'api-token', secret: { token }, url: forge.url, createdBy: 'user',
    policy: { approval: 'auto', allowedTools: ['Connection'], allowedOrigins: [forge.url] },
  });
  // A mock on loopback is not dev.azure.com, so the adapter treats it as an Azure DevOps Server with no collection path.
  return {
    id, provider: 'azure-devops', label: `Mock ${scenario}`, baseUrl: forge.url, hosts: [forge.host], insecureHttp: true,
    createdAt: new Date().toISOString(), createdBy: 'person', credential,
  };
}

const HEAD = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const BASE = 'b0b1b2b3b4b5b6b7b8b9babbbcbdbebf00112233';
const RP = '/Shop/_apis/git/repositories/web';
const ITEM = '/Shop/_apis/wit/workitems/11';
const patchOps = (r) => (Array.isArray(r?.body) ? r.body : []);
const patches = (reqs) => reqs.filter(r => r.method === 'PATCH' && r.path === ITEM);
const hasOp = (ops, op, p, pred = () => true) => ops.some(o => o.op === op && o.path === p && pred(o.value));
const subject = {
  repo: { owner: 'Shop', name: 'web' },
  basicUser: '',
  rateLimitStatus: 429,
  head: 'aico/task-42', base: 'main', createTitle: 'Add widget cache',
  pullId: '7', headSha: HEAD, baseSha: BASE,
  staleSha: '0'.repeat(40), unmergeableSha: '1'.repeat(40), mergeSha: 'c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00', mergeMethod: 'squash',
  createPath: new RegExp(`${RP}/pullrequests$`), pullCommentPath: new RegExp(`${RP}/pullrequests/7/threads$`),
  mergePath: new RegExp(`${RP}/pullrequests/7$`), mergeHttpMethod: 'PATCH',
  prBodyOf: (b) => b?.description,
  mergeRequestOk: (req) => {
    const b = req?.body ?? {};
    const keys = Object.keys(b);
    if (b.status !== 'completed' || b.lastMergeSourceCommit?.commitId !== HEAD) return 'it must complete the reviewed commit';
    if (b.completionOptions?.mergeStrategy !== 'squash') return `merge strategy ${b.completionOptions?.mergeStrategy}`;
    if (b.completionOptions?.bypassPolicy !== false || 'bypassReason' in (b.completionOptions ?? {})) return 'it must not bypass policy';
    if (b.completionOptions?.deleteSourceBranch !== false) return 'it must not delete the source branch';
    if (!keys.every(k => ['status', 'lastMergeSourceCommit', 'completionOptions'].includes(k))) return `unexpected keys ${keys.join(',')}`;
    return true;
  },
  pullExpect: [
    { state: 'open', mergeable: 'mergeable', canMerge: false, checks: 'pending', reviews: 'pending' },
    { state: 'open', mergeable: 'mergeable', canMerge: false, checks: 'failing', reviews: 'changes' },
    { state: 'open', mergeable: 'mergeable', canMerge: true, checks: 'passing', reviews: 'approved' },
    { state: 'merged', mergeable: 'mergeable', canMerge: false, checks: 'passing', reviews: 'approved' },
  ],
  associations: ['MEMBER'],
  issueId: '11', issueRev: '5', staleRev: '1', milestoneId: '11111111-0000-4000-8000-000000000002', me: 'Dana Dev',
  prNumbers: [], pagedNumbers: [],
  issuesPath: /\/Shop\/_apis\/wit\/wiql$/, issuePath: new RegExp(`${ITEM}$`), issueCommentPath: new RegExp(`${ITEM}$`), labelsPath: new RegExp(`${ITEM}$`),
  removableLabel: 'needs-triage', goneLabel: 'gone',
  protectedBranch: 'main', unprotectedBranch: 'dev',
  hostileBigIssue: '22',
  wire: {
    itemsMethod: 'POST',
    conditional: false,
    updateVerb: 'PATCH',
    itemsQueryOk: (posts) => {
      const p = posts.find(r => /CONTAINS 'bug'/.test(r.body?.query ?? ''));
      return !!p && p.query.timePrecision === 'true' && p.query.$top === '1000' && /\[System\.ChangedDate\] >= '2026-09-01T00:00:00\.000Z'/.test(p.body.query) && /^SELECT \[System\.Id\] FROM WorkItems WHERE \[System\.TeamProject\] = @project/.test(p.body.query);
    },
    assignedOk: (posts) => posts.some(r => /\[System\.AssignedTo\] = @Me/.test(r.body?.query ?? '')),
    updateSentOk: (requests) => {
      const p = patches(requests).find(r => hasOp(patchOps(r), 'add', '/fields/System.Title'));
      const ops = patchOps(p);
      return !!p && /json-patch\+json/.test(p.headers['content-type'] ?? '')
        && hasOp(ops, 'test', '/rev', v => v === 5)
        && hasOp(ops, 'add', '/fields/System.Title', v => v === 'Cache invalidation on widget update (reworded)')
        && hasOp(ops, 'add', '/fields/System.Tags', v => v === 'bug; sp:3; aico:running')
        && hasOp(ops, 'add', '/fields/System.IterationPath', v => v === 'Shop\\Sprint 2')
        && ops.length === 4;
    },
    closeOk: (body) => Array.isArray(body) && hasOp(body, 'test', '/rev', v => v === 5) && hasOp(body, 'add', '/fields/System.State', v => v === 'Closed'),
    itemCommentOk: (requests) => {
      const p = patches(requests).find(r => hasOp(patchOps(r), 'add', '/fields/System.History'));
      const text = String(patchOps(p).find(o => o.path === '/fields/System.History')?.value ?? '');
      return !!p && /Update/.test(text) && !/co-authored-by/i.test(text) && !hasOp(patchOps(p), 'test', '/rev');
    },
    labelsOk: (requests) => patches(requests).some(r => hasOp(patchOps(r), 'add', '/fields/System.Tags', v => v === 'bug; needs-triage; aico:running') && hasOp(patchOps(r), 'test', '/rev', v => v === 5)),
    createItemOk: (requests) => {
      const p = requests.filter(r => r.method === 'POST' && decodeURIComponent(r.path) === '/Shop/_apis/wit/workitems/$User Story').at(-1);
      return !!p && !/generated with|🤖/i.test(p.rawBody) && hasOp(patchOps(p), 'add', '/fields/System.Tags', v => /aico/.test(v)) && /json-patch\+json/.test(p.headers['content-type'] ?? '');
    },
    assignOk: (_body, requests) => patches(requests).some(r => hasOp(patchOps(r), 'add', '/fields/System.IterationPath', v => v === 'Shop\\Sprint 2') && patchOps(r).length === 1),
    degradedIterationsOk: (its) => its.length > 0 && its.every(i => i.kind === 'iteration' && typeof i.itemKey === 'string'),
    readPostsOk: (r) => /\/_apis\/wit\/(wiql|workitemsbatch)$/.test(r.path),
  },
};

const acceptOf = (r) => r.headers.accept;
const extra = {
  full: async (env) => {
    const { forge, reqs, ctx, adapter: a, assert: ok } = env;
    const projects = forge.requests.filter(r => r.path === '/_apis/projects' && r.query.$top === '1');
    ok(projects[0] && acceptOf(projects[0]) === 'application/json;api-version=7.1', 'a Server is first tried at REST 7.1 and accepts it');
    const afterProbe = forge.requests.filter(r => r.path.startsWith('/Shop/_apis/git/repositories/web/pullrequests/7') && r.method === 'GET');
    ok(afterProbe.length > 0 && afterProbe.every(r => acceptOf(r) === 'application/json;api-version=6.0'), 'a client built before any probe speaks the safe floor, 6.0 (the page re-tests to learn the version)');
    const evals = forge.requests.filter(r => r.path === '/Shop/_apis/policy/evaluations');
    ok(evals.length >= 4 && evals.every(r => /api-version=6\.0-preview\.1$/.test(acceptOf(r)) && /^vstfs:\/\/\/CodeReview\/CodeReviewId\/5d3f1b0e-5a1c-4e0f-9b0d-0a1b2c3d4e51\/7$/.test(r.query.artifactId)), 'policy evaluations are the preview API for the negotiated version, for the PR\'s artifact id');
    ok(forge.requests.filter(r => ['PATCH', 'POST'].includes(r.method) && /\/workitems\//.test(r.path)).every(r => !Array.isArray(r.body) || /json-patch\+json/.test(r.headers['content-type'] ?? '')), 'every work item write is a JSON-Patch document');
    const created = reqs('POST', subject.createPath).at(-1);
    ok(created?.body?.sourceRefName === 'refs/heads/aico/task-42' && created.body.targetRefName === 'refs/heads/main' && created.body.title === 'Add widget cache' && created.body.workItemRefs === undefined, 'the pull request is created from refs/heads/aico/task-42 into main (no work item given: no refs)');
    const thread = reqs('POST', subject.pullCommentPath).at(-1)?.body;
    ok(thread?.status === 4 && thread.comments?.[0]?.parentCommentId === 0 && thread.comments[0].commentType === 1, 'AICO\'s own comment is a CLOSED thread, so it can never trip a "resolve all comments" policy');
    ok(!forge.requests.some(r => r.method === 'DELETE') && !forge.requests.some(r => /bypass/i.test(r.rawBody) && !/"bypassPolicy":false/.test(r.rawBody)), 'nothing is deleted and nothing asks to bypass a policy');

    const withRefs = await env.attempt(() => a.pulls.create(ctx, { head: 'aico/task-43', base: 'main', title: 't', body: 'b', itemIds: ['11', 'x', '12'], draft: true }));
    const last = reqs('POST', subject.createPath).at(-1)?.body;
    ok(!withRefs.error && same(last?.workItemRefs, [{ id: '11' }, { id: '12' }]) && last.isDraft === true, 'work items are linked at creation (ids only), and a draft is a draft');
    const noDelete = await env.attempt(() => a.pulls.merge(ctx, '7', { method: 'merge', sha: HEAD }));
    ok(!noDelete.error && reqs('PATCH', subject.mergePath).at(-1)?.body?.completionOptions?.mergeStrategy === 'noFastForward', 'merge maps to noFastForward, squash to squash, rebase to rebase');
    const proc = await env.attempt(() => a.process.describe({ ...ctx }));
    ok(proc.value?.name === 'Agile' && proc.value.types.some(t => t.name === 'User Story') && !proc.value.types.some(t => t.name === 'Epic'), 'process.describe: the process, and the types an agent can work on (no portfolio levels)');
    const repos = await env.attempt(() => a.repos.list(ctx, 'sh'));
    ok(repos.value?.length === 2 && repos.value.every(r => r.ref.owner === 'Shop' && !r.cloneUrl.includes('@')) && !repos.value.some(r => r.ref.name === 'old-mirror'), 'repos.list: project/repo pairs, disabled repositories left out, clone URLs without user-info');
    const bad = await env.attempt(() => a.repos.get(ctx, { owner: 'a/b', name: 'web' }));
    ok(bad.error?.code === 'config', 'a project name with a path separator is refused before any request');
  },
  'server-2020': async (env) => {
    const { forge, ctx, adapter: a, assert: ok } = env;
    const tries = forge.requests.filter(r => r.path === '/_apis/projects' && r.query.$top === '1').slice(0, 3).map(acceptOf);
    ok(same(tries, ['application/json;api-version=7.1', 'application/json;api-version=7.0', 'application/json;api-version=6.0']), 'an older Server is walked down 7.1, 7.0, 6.0 until it answers', tries);
    const third = forge.requests.filter(r => r.path === '/_apis/projects' && r.query.$top === '1')[2];
    ok(!!third && forge.requests.slice(forge.requests.indexOf(third) + 1).every(r => !/api-version=7/.test(acceptOf(r) ?? '')), 'after the fallback no request asks for a version the server refused');
    const pr = env.outputs[0]; // the first probe of the script, as the conformance run recorded it
    ok(/REST 6\.0\)$/.test(pr?.version ?? '') && pr.warnings.some(w => /REST 6\.0, not 7\.1/.test(w)), 'the negotiated version is recorded in the probe, with a plain warning', pr);
    const q = await env.attempt(() => a.items.query(ctx, { source: 'label', value: 'bug' }));
    ok(q.value?.items[0]?.points === 5 && q.value.items[0].stateCategory === 'inprogress', 'a server that lists work item types without their states: states are read type by type, and Effort is the estimate');
    const p2 = await env.attempt(() => a.probe(ctx));
    ok(p2.value?.capabilities.iterations === 'native' && p2.value.capabilities.protection.read === true, 'iterations fall back to the project\'s iteration tree; branch policies are still readable');
    ok(P.restVersion({ baseUrl: forge.url, probe: { version: pr.version } }) === '6.0', 'restVersion reads the negotiated version back from the probe');
  },
  'limited-token': async (env) => {
    const { adapter: a, ctx, assert: ok } = env;
    const p = await env.attempt(() => a.probe(ctx));
    const w = p.value?.warnings ?? [];
    ok(p.value.capabilities.items.query === false && w.some(x => /Work items are unreadable/.test(x)) && w.some(x => /Sprints are unreadable/.test(x)) && w.some(x => /Build checks are unreadable/.test(x)), 'each missing permission is named in a plain warning');
    ok(p.value.capabilities.pulls.create === true && p.value.capabilities.repos === true, 'what the token can read stays on');
    ok(p.value.scopes.reported === false && p.value.scopes.needed.some(n => n.scope === 'Work Items: read and write') && same(p.value.scopes.extra, []), 'Azure DevOps does not report scopes: the advice is listed, nothing is called missing, and no over-scope note without the hooks signal');
    const iter = await env.attempt(() => a.iterations.list(ctx));
    ok(iter.error?.code === 'http' && iter.error.status === 403 && /Project and Team/.test(iter.error.message), 'iterations unreadable: a permission error, not "no sprints"');
    const pull = await env.attempt(() => a.pulls.get(ctx, '7'));
    ok(pull.value?.mergeBlockers.some(b => /policies could not be read/i.test(b)), 'unreadable policies say so in the blockers');
  },
};

const result = await runConformance({
  name: 'azure-devops', T, adapter, makeConnection, token: TOKEN, subject, assert, extra,
  fixturesDir: path.join(here, 'fixtures', 'connections', 'azure-devops'),
  scenarios: [
    { scenario: 'full', profile: 'full' },
    { scenario: 'server-2020', profile: 'degraded' },
    { scenario: 'limited-token', profile: 'limited' },
    { scenario: 'rate-limited', profile: 'rate-limit' },
    { scenario: 'hostile', profile: 'hostile' },
  ],
});
void result;

// ═══════════════════════════════════════════════════════════
console.log('\n══ A7. PAGING, 200-ID BATCHES, THE 4000-CHARACTER LIMIT, A DEAD PAT ══');

/** A mock forge whose scenarios are built here (so a test can change the "service" between syncs). */
async function generatedForge(scenarios) {
  const dir = fs.mkdtempSync(path.join(tmpRoot, 'gen-'));
  for (const [name, routes] of Object.entries(scenarios)) {
    fs.mkdirSync(path.join(dir, name), { recursive: true });
    fs.writeFileSync(path.join(dir, name, 'routes.json'), JSON.stringify(routes));
  }
  return startMockForge({ fixtures: dir, scenario: Object.keys(scenarios)[0], requireAuth: true, token: TOKEN, basicUser: '' });
}
let connSeq = 0;
async function clientFor(forge, over = {}) {
  const conn = await makeConnection({ forge, scenario: 'gen', token: TOKEN, id: `azure-gen-${++connSeq}` });
  const client = new ConnectionClient(conn, { ...adapter.clientOptions(conn), retries: 0, ...over });
  return { conn, client, ctx: { conn, client, repo: { owner: 'Shop', name: 'web' } } };
}
const PROJECT_ID = '5d3f1b0e-5a1c-4e0f-9b0d-0a1b2c3d4e51';
const REPO_ID = '8c2e7f60-1d3b-4f58-a6a7-5b4c3d2e1f00';
const repoJson = { id: REPO_ID, name: 'web', project: { id: PROJECT_ID, name: 'Shop', visibility: 'private' }, defaultBranch: 'refs/heads/main' };
const states = (...p) => p.map(([name, category]) => ({ name, category }));
const typesBody = { count: 3, value: [
  { name: 'User Story', states: states(['New', 'Proposed'], ['Active', 'InProgress'], ['Resolved', 'Resolved'], ['Closed', 'Completed'], ['Removed', 'Removed']) },
  { name: 'Bug', states: states(['New', 'Proposed'], ['Active', 'InProgress'], ['Resolved', 'Resolved'], ['Closed', 'Completed']) },
  { name: 'Task', states: states(['New', 'Proposed'], ['Active', 'InProgress'], ['Closed', 'Completed']) },
] };
const wi = (id, rev, fields) => ({ id, rev, fields: { 'System.TeamProject': 'Shop', 'System.WorkItemType': 'User Story', 'System.State': 'New', 'System.IterationPath': 'Shop', 'System.AreaPath': 'Shop', 'System.Title': `Item ${id}`, ...fields } });

{
  // 450 ids: three batches of at most 200, order kept, another project's items dropped, the query asks for time precision.
  const ids = Array.from({ length: 450 }, (_, i) => i + 1);
  const chunk = (from, to) => ids.slice(from, to).map(id => wi(id, 1, id === 7 ? { 'System.TeamProject': 'Other' } : {}));
  const forge = await generatedForge({ s: [
    { path: '/Shop/_apis/wit/workitemtypes', status: 200, body: typesBody },
    { method: 'POST', path: '/Shop/_apis/wit/wiql', status: 200, body: { workItems: ids.map(id => ({ id })) } },
    { method: 'POST', path: '/Shop/_apis/wit/workitemsbatch', responses: [
      { status: 200, body: { value: chunk(0, 200).reverse() } }, { status: 200, body: { value: chunk(200, 400) } }, { status: 200, body: { value: chunk(400, 450) } },
    ] },
  ] });
  const { ctx } = await clientFor(forge);
  const out = await adapter.items.query(ctx, { source: 'assigned-to-me', state: 'open', since: '2026-09-01T00:00:00Z' });
  const batchReqs = forge.requests.filter(r => r.path.endsWith('/workitemsbatch'));
  assert(batchReqs.length === 3 && batchReqs.every(r => r.body.ids.length <= 200 && r.body.errorPolicy === 'omit' && r.body.fields.includes('System.IterationPath')), 'a 450-item result is fetched in batches of at most 200 ids', batchReqs.map(r => r.body.ids.length));
  assert(same(batchReqs.flatMap(r => r.body.ids), ids), 'the batches carry the WIQL ids in order');
  assert(out.items.length === 449 && !out.items.some(i => i.number === 7), 'an item of another project is dropped even if the query returned it');
  assert(out.items.slice(0, 6).map(i => i.number).join() === '1,2,3,4,5,6', 'the order of the query (newest change first) is kept even if a batch comes back shuffled');
  const wq = forge.requests.find(r => r.path.endsWith('/wiql'));
  assert(wq.query.timePrecision === 'true' && wq.query.$top === '1000' && /ChangedDate\] >= '2026-09-01T00:00:00\.000Z'/.test(wq.body.query) && /@Me/.test(wq.body.query), 'WIQL: time precision, a cap of 1000, the since filter, @Me');
  await forge.stop();
}

{
  // A dead PAT: 203 + an HTML sign-in page, or a 200 HTML page.
  for (const mode of ['203', '200-html']) {
    const forge = await generatedForge({ s: [{ path: '/_apis/connectionData', status: mode === '203' ? 203 : 200, headers: { 'content-type': 'text/html; charset=utf-8' }, text: '<html><body>Sign in to your account</body></html>' }] });
    let failedCount = 0;
    const { ctx } = await clientFor(forge, { onAuthFailed: () => { failedCount++; } });
    let err; try { await adapter.probe(ctx); } catch (e) { err = e; }
    assert(err instanceof ConnectionError && err.code === 'auth' && err.status === 401 && /sign in again/i.test(err.message) && failedCount === 1, `a dead PAT (${mode}) is an auth failure that marks the connection "Sign in again"`, err?.message);
    assert(!String(err?.message).includes(TOKEN), 'and the message does not carry the token');
    await forge.stop();
  }
}

{
  // The description limit, end to end through the adapter: clip, overflow returned, an update never exceeds it.
  const forge = await generatedForge({ s: [
    { method: 'POST', path: '/Shop/_apis/git/repositories/web/pullrequests', status: 201, body: { pullRequestId: 8, status: 'active', mergeStatus: 'queued', repository: repoJson, lastMergeSourceCommit: { commitId: HEAD } } },
    { method: 'PATCH', path: '/Shop/_apis/git/repositories/web/pullrequests/8', status: 200, body: { pullRequestId: 8, status: 'active', mergeStatus: 'queued', repository: repoJson } },
    { path: '/Shop/_apis/git/repositories/web/pullrequests/8', status: 200, body: { pullRequestId: 8, status: 'active', mergeStatus: 'queued', repository: repoJson } },
    { path: '/Shop/_apis/policy/evaluations', status: 200, body: { value: [] } },
    { path: '/Shop/_apis/git/repositories/web/pullrequests/8/statuses', status: 200, body: { value: [] } },
    { method: 'POST', path: '/Shop/_apis/git/repositories/web/pullrequests/8/threads', status: 201, body: { id: 1 } },
  ] });
  const { ctx } = await clientFor(forge);
  const body = `${'evidence line\n'.repeat(700)}END`;
  const made = await adapter.pulls.create(ctx, { head: 'aico/task-9', base: 'main', title: 'Big', body });
  const sent = forge.requests.find(r => r.method === 'POST' && r.path.endsWith('/pullrequests')).body.description;
  assert(sent.length <= 4000 && sent.length + made.overflow.length === body.length && made.overflow.endsWith('END'), `the description is clipped to 4000 and the rest (${made.overflow.length} chars) is returned for a thread (${sent.length} sent)`);
  await adapter.pulls.comment(ctx, '8', `The rest of the change report:\n\n${made.overflow}`);
  const thread = forge.requests.find(r => r.path.endsWith('/threads')).body;
  assert(thread.comments[0].content.endsWith('END') && thread.status === 4, 'the overflow is posted as a closed thread, in full');
  await adapter.pulls.update(ctx, '8', { body });
  const upd = forge.requests.filter(r => r.method === 'PATCH').at(-1).body.description;
  assert(upd.length <= 4000 && /the rest is in the first comment/.test(upd), 'an update that cannot fit says where the rest is, and still fits');
  await forge.stop();
}

{
  // Before a project is mapped the probe can only say what the organization-level reads say, and says so.
  const forge = await generatedForge({ s: [
    { path: '/_apis/connectionData', status: 200, body: { authenticatedUser: { id: 'u1', providerDisplayName: 'Dana Dev', properties: { Account: { $value: 'dana@example.test' } } }, deploymentType: 'hosted' } },
    { path: '/_apis/projects', status: 200, body: { value: [{ name: 'Shop' }] } },
    { path: '/_apis/git/repositories', status: 200, body: { value: [] } },
    { method: 'POST', path: '/_apis/wit/wiql', status: 200, body: { workItems: [] } },
    { path: '/_apis/build/builds', status: 200, body: { value: [] } },
    { path: '/_apis/hooks/subscriptions', status: 200, body: { count: 0, value: [] } },
  ] });
  const { conn, ctx } = await clientFor(forge);
  delete ctx.repo;
  const pr = await adapter.probe(ctx);
  assert(pr.capabilities.repos && pr.capabilities.pulls.create && pr.capabilities.items.query && pr.capabilities.checks.read && pr.capabilities.iterations === 'native', 'org-level probe: repositories, pull requests, work items, builds and sprints are on when their reads work', pr.capabilities);
  assert(pr.warnings.some(w => /Map a project and a repository and test again/.test(w)), 'and it says a mapped project gives the real answer');
  assert(pr.scopes.extra.length === 1 && /Full access/.test(pr.scopes.extra[0]), 'a token that can read service hooks is flagged as over-scoped (a hint, in plain words)');
  assert(pr.version === 'Azure DevOps Server (REST 7.1)' && conn.id.startsWith('azure-gen'), 'a server answering connectionData is a Server whose REST version was negotiated');
  await forge.stop();
}

{
  // Only an http(s) link leaves the adapter; a stranger's text never reaches a name; a hostile branch name never reaches a URL.
  const forge = await generatedForge({ s: [{ path: '/Shop/_apis/git/repositories/web/pullrequests', status: 200, body: { value: [] } }] });
  const { ctx } = await clientFor(forge);
  const bad = ['..', 'a b', '-x', 'a:b', 'x\n', 'a~1'];
  const results = [];
  for (const b of bad) { try { await adapter.pulls.find(ctx, b); results.push('allowed'); } catch (e) { results.push(e.code); } }
  assert(results.every(r => r === 'config') && forge.requests.length === 0, 'a malformed branch name is refused before any request', results);
  await forge.stop();
}

// ═══════════════════════════════════════════════════════════
console.log('\n══ A8. ITERATION PICKING AND THE THREE-WAY MERGE (pure) ══');
{
  const it = (id, title, start, end, over = {}) => ({ id, title, kind: 'iteration', state: 'open', ...(start ? { start } : {}), ...(end ? { end } : {}), ...over });
  const ms = (id, title, end, over = {}) => ({ id, title, kind: 'milestone', state: 'open', ...(end ? { end } : {}), ...over });
  const pick = (list, today) => Iter.pickToImport(list, today).picks.map(p => `${p.iteration.id}:${p.start}..${p.end}`).join(' ');
  assert(pick([it('a', 'S1', '2026-10-05', '2026-10-16'), it('b', 'S2', '2026-10-19', '2026-10-30'), it('c', 'S3', '2026-11-02', '2026-11-13')], '2026-10-09') === 'a:2026-10-05..2026-10-16 b:2026-10-19..2026-10-30', 'current and next by dates; later ones wait');
  assert(pick([it('a', 'S1', '2026-09-21', '2026-10-02'), it('b', 'S2', '2026-10-19', '2026-10-30')], '2026-10-09') === 'b:2026-10-19..2026-10-30', 'between sprints: only the next one; an ended one is not imported');
  assert(pick([it('a', 'S1', '2026-10-05', '2026-10-16', { state: 'closed' }), it('b', 'S2', '2026-10-05', '2026-10-16', { timeFrame: 'past' })], '2026-10-09') === '', 'closed and past are never imported');
  assert(pick([it('a', 'S1', '2026-09-21', '2026-10-02', { timeFrame: 'current' }), it('b', 'S2', '2026-10-05', '2026-10-16', { timeFrame: 'future' })], '2026-12-31') === 'a:2026-09-21..2026-10-02 b:2026-10-05..2026-10-16', 'the platform\'s own timeFrame wins over this machine\'s clock');
  assert(pick([it('a', 'S1', '2026-10-05', '2026-10-16'), it('z', 'Overlap', '2026-10-08', '2026-10-19')], '2026-10-09') === 'z:2026-10-08..2026-10-19', 'two current: the one that started last');
  assert(pick([ms('1', 'v1', '2026-10-30'), ms('2', 'v2', '2026-11-13'), ms('3', 'v3', '2027-01-01'), ms('0', 'old', '2026-09-01')], '2026-10-09') === '1:2026-10-09..2026-10-30 2:2026-10-09..2026-11-13', 'milestones: the two soonest due dates, from today; one already past is skipped');
  const r = Iter.pickToImport([ms('1', 'Release 2027', '2027-10-01'), it('u', 'No dates'), it('x', 'Quarter', '2026-10-01', '2026-12-31')], '2026-10-09');
  assert(r.picks.length === 0 && r.skipped.length === 3 && r.skipped.every(s => /days|dates/.test(s)), 'too long and undated ones are skipped with a reason', r.skipped);
  assert(pick([it('a', 'S1', '2026-10-05', '2026-10-16', { state: 'open', itemKey: 'P\\S1' })], '2026-10-09') === 'a:2026-10-05..2026-10-16' && Iter.keyOf({ id: 'a', itemKey: 'P\\S1' }) === 'P\\S1' && Iter.keyOf({ id: '7' }) === '7', 'an item key replaces the id when the platform has one');

  const m = Iter.mergeValue;
  const table = [['a', 'a', 'a', 'none'], ['a', 'b', 'a', 'pull'], ['a', 'a', 'b', 'push'], ['a', 'b', 'c', 'pull'], [undefined, 'a', undefined, 'pull'], [undefined, undefined, 'a', 'push'],
    ['a', undefined, 'a', 'pull'], ['a', 'a', undefined, 'push'], [undefined, undefined, undefined, 'none'], [3, 8, 2, 'pull'], [3, 3, 5, 'push']];
  const wrong = table.filter(([b, rem, loc, want]) => m(b, rem, loc) !== want).map(t => t.join('/'));
  assert(wrong.length === 0, `mergeValue: ${table.length} cases, the remote wins whenever it moved (wrong: ${wrong.join(' | ') || 'none'})`);
}

// ═══════════════════════════════════════════════════════════
console.log('\n══ A9. SPRINT SYNC END TO END (the real adapter, vault, store and board) ══');
{
  const sh = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const git = (cwd, ...args) => sh('git', args, cwd);
  function makeProject() {
    const dir = path.join(tmpRoot, `proj-${connSeq++}`);
    fs.mkdirSync(dir, { recursive: true });
    git(dir, 'init', '-q', '-b', 'main');
    git(dir, 'config', 'user.name', 'Test Owner'); git(dir, 'config', 'user.email', 'owner@example.test'); git(dir, 'config', 'commit.gpgsign', 'false'); git(dir, 'config', 'core.autocrlf', 'false');
    fs.writeFileSync(path.join(dir, 'README.md'), 'one\n'); fs.writeFileSync(path.join(dir, '.gitignore'), '.aico/\n');
    git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', 'chore: initial');
    return fs.realpathSync.native(dir);
  }
  T.registerBuiltinAdapters();
  D.resetDeliveryForTest();
  T.resetConnectionHttpForTest();
  Iter.setTodayForTest('2026-10-09');

  const TEAM = '/Shop/Shop Team/_apis/work/teamsettings/iterations';
  const team = (s1, s2, extraIts = []) => ({ path: TEAM, status: 200, body: { count: 3, value: [
    { id: 'i0', name: 'Sprint 0', path: 'Shop\\Sprint 0', attributes: { startDate: '2026-09-14T00:00:00Z', finishDate: '2026-09-25T00:00:00Z', timeFrame: 'past' } }, s1, s2, ...extraIts] } });
  const S1 = (over = {}) => ({ id: 'i1', name: 'Sprint 1', path: 'Shop\\Sprint 1', attributes: { startDate: '2026-09-28T00:00:00Z', finishDate: '2026-10-09T00:00:00Z', timeFrame: 'current', ...over.attributes }, ...over.top });
  const S2 = (over = {}) => ({ id: 'i2', name: 'Sprint 2', path: 'Shop\\Sprint 2', attributes: { startDate: '2026-10-12T00:00:00Z', finishDate: '2026-10-23T00:00:00Z', timeFrame: 'future', ...over.attributes }, ...over.top });
  const common = (items, getRev13, patches) => [
    { path: '/Shop/_apis/git/repositories/web', status: 200, body: repoJson },
    { path: '/Shop/_apis/wit/workitemtypes', status: 200, body: typesBody },
    { path: '/Shop/_apis/wit/workitemtypes/:type', status: 200, body: { name: 'Bug', fields: [{ referenceName: 'Microsoft.VSTS.Scheduling.StoryPoints' }] } },
    { method: 'POST', path: '/Shop/_apis/wit/wiql', status: 200, body: { workItems: items.map(i => ({ id: i.id })) } },
    { method: 'POST', path: '/Shop/_apis/wit/workitemsbatch', status: 200, body: { value: items } },
    { path: '/_apis/projects/Shop', status: 200, body: { id: PROJECT_ID, name: 'Shop', defaultTeam: { name: 'Shop Team' } } },
    ...patches,
    { path: '/Shop/_apis/wit/workitems/13', status: 200, body: getRev13 },
    { path: '/Shop/_apis/wit/workitems/11', status: 200, body: items.find(i => i.id === 11) },
  ];
  const item11 = (rev, over = {}) => wi(11, rev, { 'System.Title': 'Cache invalidation', 'System.WorkItemType': 'User Story', 'System.State': 'Active', 'System.Tags': 'bug', 'System.IterationPath': 'Shop\\Sprint 1', 'Microsoft.VSTS.Scheduling.StoryPoints': 3, ...over });
  const item13 = (rev, over = {}) => wi(13, rev, { 'System.Title': 'Widget count is wrong', 'System.WorkItemType': 'Bug', 'System.State': 'New', 'System.Tags': 'bug', ...over });

  const forge = await generatedForge({
    v1: [...common([item11(5), item13(2)], item13(3, { 'System.IterationPath': 'Shop\\Sprint 2' }), [
      { method: 'PATCH', path: '/Shop/_apis/wit/workitems/13', bodyIncludes: 'System.IterationPath', status: 200, body: item13(3, { 'System.IterationPath': 'Shop\\Sprint 2' }) },
      { method: 'PATCH', path: '/Shop/_apis/wit/workitems/13', bodyIncludes: 'StoryPoints', status: 200, body: item13(4, { 'System.IterationPath': 'Shop\\Sprint 2', 'Microsoft.VSTS.Scheduling.StoryPoints': 5 }) },
    ]), team(S1(), S2())],
    // The platform changed its mind: Sprint 1 renamed and extended, item 11 moved to Sprint 2 and re-estimated, item 13 retitled.
    v2: [...common([item11(6, { 'System.IterationPath': 'Shop\\Sprint 2', 'Microsoft.VSTS.Scheduling.StoryPoints': 8 }), item13(5, { 'System.Title': 'Widget count is wrong (edited)', 'System.IterationPath': 'Shop\\Sprint 2', 'Microsoft.VSTS.Scheduling.StoryPoints': 5 })], item13(5), []),
      team(S1({ top: { name: 'Sprint 1 (Hardening)' }, attributes: { finishDate: '2026-10-10T00:00:00Z' } }), S2())],
    // Sprint 1 is over on the platform; a third sprint appears.
    v3: [...common([item11(6, { 'System.IterationPath': 'Shop\\Sprint 2', 'Microsoft.VSTS.Scheduling.StoryPoints': 8 }), item13(5, { 'System.Title': 'Widget count is wrong (edited)', 'System.IterationPath': 'Shop\\Sprint 2', 'Microsoft.VSTS.Scheduling.StoryPoints': 5 })], item13(5), []),
      team(S1({ attributes: { timeFrame: 'past' } }), S2({ attributes: { timeFrame: 'current' } }), [{ id: 'i3', name: 'Sprint 3', path: 'Shop\\Sprint 3', attributes: { startDate: '2026-10-26T00:00:00Z', finishDate: '2026-11-06T00:00:00Z', timeFrame: 'future' } }])],
    // Item 13 is New on the platform while its task is running.
    v4: [...common([item11(6, { 'System.IterationPath': 'Shop\\Sprint 2', 'Microsoft.VSTS.Scheduling.StoryPoints': 8 }), item13(5, { 'System.IterationPath': 'Shop\\Sprint 2', 'Microsoft.VSTS.Scheduling.StoryPoints': 5 })], item13(5), [
      { method: 'PATCH', path: '/Shop/_apis/wit/workitems/13', bodyIncludes: 'System.State', status: 200, body: item13(6, { 'System.State': 'Active', 'System.IterationPath': 'Shop\\Sprint 2', 'Microsoft.VSTS.Scheduling.StoryPoints': 5 }) },
    ]), team(S1({ attributes: { timeFrame: 'past' } }), S2({ attributes: { timeFrame: 'current' } }))],
    // The task merged: a comment (revision 7) and then the move to Closed must carry that revision.
    v5: [...common([item11(6, { 'System.IterationPath': 'Shop\\Sprint 2', 'Microsoft.VSTS.Scheduling.StoryPoints': 8 }), item13(6, { 'System.State': 'Active', 'System.IterationPath': 'Shop\\Sprint 2', 'Microsoft.VSTS.Scheduling.StoryPoints': 5 })], item13(7, { 'System.State': 'Active' }), [
      { method: 'PATCH', path: '/Shop/_apis/wit/workitems/13', bodyIncludes: 'System.History', status: 200, body: item13(7, { 'System.State': 'Active' }) },
      { method: 'PATCH', path: '/Shop/_apis/wit/workitems/13', bodyIncludes: 'System.State', status: 200, body: item13(8, { 'System.State': 'Closed' }) },
    ]), team(S1({ attributes: { timeFrame: 'past' } }), S2({ attributes: { timeFrame: 'current' } }))],
    mk: [
      { path: '/Shop/_apis/wit/classificationnodes/iterations', method: 'POST', status: 201, body: { identifier: 'i9', name: 'Hand made', path: '\\Shop\\Iteration\\Hand made' } },
      { path: '/_apis/projects/Shop', status: 200, body: { defaultTeam: { name: 'Shop Team' } } },
      { path: TEAM, method: 'POST', status: 200, body: { id: 'i9' } },
    ],
  });

  const p = makeProject();
  const conn = await ConnService.createConnection({ provider: 'azure-devops', baseUrl: forge.url, insecureHttp: true, by: 'person', label: 'Mock Azure DevOps' });
  await ConnService.storeToken(conn.id, TOKEN);
  const mapped = await ConnService.mapProject({ project: p, connection: conn.id, repo: { owner: 'Shop', name: 'web' }, workItems: { source: 'label', value: 'bug' }, iterations: 'native', by: 'person' });
  assert(mapped.mapping.iterations === 'native' && mapped.mapping.stateMap.running === 'InProgress' && mapped.mapping.stateMap.merged === 'Completed' && mapped.mapping.stateMap.blocked === 'aico:blocked', 'mapping: sprint sync on, and the state map starts as categories (Azure DevOps), not labels');
  const bad = await ConnService.mapProject({ project: p, connection: conn.id, repo: { owner: 'a/b', name: 'web' }, by: 'person' }).catch(e => e);
  assert(/project name|character/.test(String(bad?.message)) && !(bad instanceof Error && bad.status === 500), 'mapping: a project with a path separator is refused with the adapter\'s own words');

  // A sprint made by hand, before anything is imported: it is the one a person will later create on the platform.
  const handMade = await Scrum.createSprint(p, { name: 'Hand made', start: '2026-11-09', end: '2026-11-20' });
  const tasks = () => D.boardState(p).tasks;
  const mirrored = () => (D.boardState(p).sprints ?? []).filter(s => s.remote);
  const byRemote = (id) => tasks().find(t => t.remote?.id === id);
  const sprints = () => D.boardState(p).sprints ?? [];
  const sprintNamed = (n) => sprints().find(s => s.name === n);
  const mark = () => forge.requests.length;
  const since = (m) => forge.requests.slice(m);
  const isWrite = (r) => r.method === 'PATCH' || (r.method === 'POST' && !/\/(wiql|workitemsbatch)$/.test(r.path));

  // ── sync 1: import ──
  let m = mark();
  const r1 = await ConnSync.syncProject(p);
  assert(r1.imported === 2 && tasks().length === 2 && tasks().every(t => t.status === 'backlog'), 'import: two tasks, both in the backlog (nothing is promoted to ready)', r1);
  assert(mirrored().length === 2 && mirrored().every(s => s.status === 'planned' && s.remote.connection === conn.id), 'the current and next iteration became PLANNED sprints; the past one did not', sprints().map(s => `${s.name}:${s.status}`));
  const s1 = sprintNamed('Sprint 1'); const s2 = sprintNamed('Sprint 2');
  assert(s1.start === '2026-09-28' && s1.end === '2026-10-09' && s1.remote.id === 'i1' && s1.remote.itemKey === 'Shop\\Sprint 1' && s1.remote.timeFrame === 'current', 'a mirrored sprint carries the platform\'s name, dates and link', s1);
  assert(byRemote('11').sprintId === s1.id && byRemote('13').sprintId === undefined, 'item 11 was in Sprint 1 on the platform, so its task is committed to the mirrored Sprint 1; item 13 (root iteration) is in none');
  assert(byRemote('11').estimate === 3 && byRemote('11').remote.points === 3 && byRemote('11').remote.iteration === 'Shop\\Sprint 1', 'the platform\'s story points became the estimate; the merge bases are stored on the task\'s link');
  assert(D.boardState(p).tasks.every(t => t.status === 'backlog') && sprints().every(s => !s.startedAt), 'importing started nothing: no sprint is active, no task is ready');
  assert(!since(m).some(isWrite), 'sync 1 wrote nothing to the platform');

  // ── a person plans in AICO: Sprint 2 gets item 13, and an estimate ──
  await Scrum.commitSprint(p, s2.id, [byRemote('13').id]);
  await Scrum.setEstimate(p, byRemote('13').id, 5);
  m = mark();
  const r2 = await ConnSync.syncProject(p);
  const w2 = since(m).filter(isWrite);
  assert(w2.length === 2 && w2[0].method === 'PATCH' && w2[0].path.endsWith('/workitems/13') && w2[0].rawBody.includes('Shop\\\\Sprint 2') && patchOps(w2[0]).length === 1, 'a person\'s planning in AICO is pushed once: the item is assigned to the iteration', w2.map(r => r.rawBody));
  const ops2 = patchOps(w2[1]);
  assert(hasOp(ops2, 'test', '/rev', v => v === 3) && hasOp(ops2, 'add', '/fields/Microsoft.VSTS.Scheduling.StoryPoints', v => v === 5), 'and the estimate right after it, carrying the revision the first write produced (not the stale one)', w2[1].rawBody);
  assert(r2.pushed === 2 && byRemote('13').remote.iteration === 'Shop\\Sprint 2' && byRemote('13').remote.points === 5, 'the merge bases moved to what was pushed', r2);
  m = mark();
  const r2b = await ConnSync.syncProject(p);
  assert(!since(m).some(isWrite) && r2b.pushed === 0, 'syncing again pushes nothing: the three-way merge is settled');

  // ── the platform changes; a local estimate made meanwhile loses ──
  await Scrum.setEstimate(p, byRemote('11').id, 2);
  forge.setScenario('v2');
  m = mark();
  const r3 = await ConnSync.syncProject(p);
  assert(!since(m).some(isWrite), 'when the platform moved, nothing is pushed (the remote wins)', since(m).filter(isWrite).map(r => r.rawBody));
  const sp1 = sprintNamed('Sprint 1 (Hardening)');
  assert(!!sp1 && sp1.end === '2026-10-10' && sp1.remote.id === 'i1' && mirrored().length === 2, 'the renamed, extended iteration updated its sprint (the platform owns name and dates)', sprints().map(s => `${s.name} ${s.start}..${s.end}`));
  assert(byRemote('11').sprintId === s2.id && /Moved into "Sprint 2"/.test(byRemote('11').review.comments.at(-1).text), 'item 11 moved to Sprint 2 on the platform, so its task moved sprints, with a note why');
  assert(byRemote('11').estimate === 8 && byRemote('11').remote.points === 8, 'the platform\'s 8 points replaced the local 2');
  assert(byRemote('13').title === 'Widget count is wrong (edited)' && byRemote('13').estimate === 5 && byRemote('13').sprintId === s2.id, 'a retitled item overwrote the local title; membership and estimate agreed and were left alone');
  assert(sprints().every(s => s.status === 'planned') && tasks().every(t => t.status === 'backlog'), 'a remote planning change never started a sprint or promoted a task');

  // ── the platform ends Sprint 1 and adds Sprint 3 ──
  forge.setScenario('v3');
  m = mark();
  await ConnSync.syncProject(p);
  const closedRemote = sprintNamed('Sprint 1');
  assert(closedRemote?.status === 'planned' && closedRemote.remote.state === 'closed' && closedRemote.remote.timeFrame === 'past', 'an iteration the platform ended does not close its sprint (that stays a person\'s act); the link says it is over', closedRemote?.remote);
  assert(!!sprintNamed('Sprint 3') && sprintNamed('Sprint 3').status === 'planned' && !sprintNamed('Sprint 2').startedAt, 'the next iteration appeared as a planned sprint');
  assert(!forge.requests.some(r => /classificationnodes|teamsettings\/iterations$/.test(r.path) && r.method !== 'GET'), 'across all of these syncs AICO created and deleted no iteration on the platform');

  // ── workflow state by category, forward only ──
  const t13 = byRemote('13');
  S.patchTask(p, t13.id, { status: 'running' });
  forge.setScenario('v4');
  m = mark();
  const r4 = await ConnSync.syncProject(p);
  const w4 = since(m).filter(isWrite);
  assert(w4.length === 1 && hasOp(patchOps(w4[0]), 'add', '/fields/System.State', v => v === 'Active') && hasOp(patchOps(w4[0]), 'test', '/rev', v => v === 5) && r4.pushed === 1, 'a running task moves its New bug to the type\'s InProgress state ("Active"), guarded by the revision', w4.map(r => r.rawBody));
  assert(!w4.some(r => r.rawBody.includes('aico:running')), 'and it is a state, not a tag');
  S.patchTask(p, t13.id, { status: 'review' });
  forge.setScenario('v5');
  m = mark();
  await ConnSync.syncProject(p);
  assert(!since(m).some(isWrite), 'review maps to InProgress too: the item is already further along, so nothing is written (forward only)');
  S.patchTask(p, t13.id, { status: 'merged' });
  m = mark();
  const r5 = await ConnSync.syncProject(p);
  const w5 = since(m).filter(isWrite);
  assert(w5.length === 2 && hasOp(patchOps(w5[0]), 'add', '/fields/System.History') && !hasOp(patchOps(w5[0]), 'test', '/rev'), 'merged: a note first (no revision test: a comment never conflicts)', w5.map(r => r.rawBody));
  assert(hasOp(patchOps(w5[1]), 'add', '/fields/System.State', v => v === 'Closed') && hasOp(patchOps(w5[1]), 'test', '/rev', v => v === 7) && r5.conflicts === 0, 'then the move to Closed carrying the revision the note produced, so AICO\'s own note is not a conflict with itself', w5.map(r => r.rawBody));
  assert(byRemote('13').remote.remoteState === 'closed', 'the task\'s link now says closed');

  // ── a person creates a sprint on the platform ──
  assert(!handMade.remote && !sprints().find(s => s.id === handMade.id).remote, 'a sprint made by hand stayed local through every sync (nothing mirrors it, nothing creates it remotely)');
  forge.setScenario('mk');
  m = mark();
  const made = await Iter.createRemoteIteration(p, handMade.id);
  const w = since(m).filter(isWrite);
  assert(w.length === 2 && w[0].path.endsWith('/classificationnodes/iterations') && w[0].body.attributes.startDate === '2026-11-09T00:00:00Z' && decodeURIComponent(w[1].path) === TEAM && made.sprint.remote?.id === 'i9', 'a click by a person creates the iteration and adds it to the team; the sprint is then linked', w.map(r => r.rawBody));
  const again = await Iter.createRemoteIteration(p, handMade.id).catch(e => e);
  assert(again?.code === 'conflict', 'a sprint that already mirrors an iteration cannot be created again');

  // ── sprint sync off: no iteration is even read ──
  forge.setScenario('v5');
  await ConnService.mapProject({ project: p, connection: conn.id, iterations: 'off', by: 'person' });
  m = mark();
  await ConnSync.syncProject(p);
  assert(!since(m).some(r => r.path.includes('teamsettings')), 'with sprint sync off the iterations are not read at all');
  const agentTry = await ConnService.mapProject({ project: p, connection: conn.id, iterations: 'native', by: 'agent' }).catch(e => e);
  assert(agentTry?.code === 'human-required' && ConnStore.getMapping(p).iterations === 'off', 'an agent cannot turn sprint sync on: it lets AICO write a task\'s sprint and points back, which is a person\'s decision');
  const agentKeep = await ConnService.mapProject({ project: p, connection: conn.id, workItems: { source: 'label', value: 'bug' }, by: 'agent' }).catch(e => e);
  assert(agentKeep.mapping?.iterations === 'off', 'and an agent that changes something else leaves it as it was');

  // The PAT is in the vault, encrypted, and nowhere else: not in the store, the journal, the audit log or any file this run wrote.
  const needles = [TOKEN, Buffer.from(`:${TOKEN}`).toString('base64'), Buffer.from(TOKEN).toString('base64'), Buffer.from(TOKEN).toString('hex')];
  const found = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const f = path.join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== 'node_modules') walk(f); continue; }
      let text = ''; try { text = fs.readFileSync(f, 'latin1'); } catch { continue; }
      if (needles.some(n => text.includes(n))) found.push(path.relative(testHome, f));
    }
  };
  walk(testHome); walk(p);
  assert(found.length === 0, 'the PAT (plain, as Basic, base64, hex) is in no file of the AICO store, the project or the audit log', found);
  assert(forge.requests.length > 20 && forge.requests.every(r => r.headers.authorization === `Basic ${Buffer.from(`:${TOKEN}`).toString('base64')}` && !r.url.includes(TOKEN)), 'and every request carried it only as the Basic password, never in a URL');
  await ConnService.removeConnection(conn.id);
  await forge.stop();
  Iter.setTodayForTest(undefined);
}

//@@PART4@@


console.log(`\n══ SUMMARY ══\n  ${passed} passed, ${failed} failed`);
if (failed) { console.log(`  failures:\n    ${failures.join('\n    ')}`); process.exit(1); }
process.exit(0);
