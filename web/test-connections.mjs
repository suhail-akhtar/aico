/**
 * Unit tests for the Connections client logic (web/src/connections.ts, ADR 0039):
 * the status chip and its sentence, capability chips (a missing capability has no
 * chip), the scope diff, the repo suggestion, the add-connection form's validation
 * (https only; http only for a private address with the opt-in; no user name in the
 * URL), the project mapping form (landing confirm, work-item values, seven state rows),
 * pull request chips and merge blockers, the review card's wording per landing mode,
 * and the board's sync label.
 *
 * Bundles its own subject with esbuild, so it runs on its own:
 *   node web/test-connections.mjs
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aico-connections-unit-'));
async function load(name) {
  const outfile = path.join(tmp, `${name}.mjs`);
  await build({ entryPoints: [path.join(here, 'src', `${name}.ts`)], bundle: true, format: 'esm', platform: 'node', outfile, logLevel: 'error' });
  return import(pathToFileURL(outfile).href);
}
const C = await load('connections');
const M = await load('delivery-model');
const { PROVIDERS, DEFAULT_STATE_MAP } = await import(pathToFileURL((await (async () => {
  const outfile = path.join(tmp, 'shared-types.mjs');
  await build({ entryPoints: [path.join(here, '..', 'shared', 'connections', 'types.ts')], bundle: true, format: 'esm', platform: 'node', outfile, logLevel: 'error' });
  return outfile;
})())).href);

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; } catch (e) { console.error(`FAIL ${name}\n`, e); process.exitCode = 1; }
}
/** Table-driven: one assertion per row, the row's label in the failure. */
function table(name, rows, fn) {
  test(name, () => { for (const row of rows) { try { fn(...row); } catch (e) { e.message = `[${JSON.stringify(row[0])}] ${e.message}`; throw e; } } });
}

const NOW = Date.parse('2026-10-09T12:00:00Z');
const caps = (over = {}) => ({
  repos: true,
  pulls: { create: true, comment: true, merge: true, draft: true, bodyMax: 65536 },
  items: { query: true, create: false, transition: true, comment: true, estimate: 'none', parentLink: false },
  iterations: 'none',
  checks: { read: true, rerun: false, logsUrl: true },
  protection: { read: true },
  ...over,
});
const probe = (over = {}) => ({
  at: '2026-10-09T11:55:00Z', user: 'octo', capabilities: caps(),
  scopes: { found: [], needed: [], missing: [], extra: [], reported: true },
  warnings: [], ...over,
});
const conn = (over = {}) => ({
  id: 'gh', provider: 'github', label: 'GitHub', baseUrl: 'https://github.com', host: 'github.com', hosts: ['github.com'],
  createdAt: '2026-10-09T10:00:00Z', createdBy: 'person', hasCredential: true, state: 'connected', projects: [], ...over,
});

// ── status ───────────────────────────────────────────────────────────
test('a plain connected connection has a green chip and nothing to explain', () => {
  const s = C.connectionStatus(conn({ probe: probe() }), NOW);
  assert.deepEqual([s.label, s.tone, s.reason], ['Connected', 'success', '']);
});

test('a connected connection without pipelines says it is limited', () => {
  const s = C.connectionStatus(conn({ probe: probe({ capabilities: caps({ checks: { read: false, rerun: false, logsUrl: false } }) }) }), NOW);
  assert.equal(s.label, 'Connected');
  assert.equal(s.reason, 'Limited: no pipelines.');
});

table('needs-attention reasons', [
  [conn({ hasCredential: false, state: 'needs-attention' }), 'Add a token to finish setting this up.'],
  [conn({ state: 'needs-attention' }), 'Sign in again: paste a new token.'],
  [conn({ state: 'needs-attention', stateDetail: 'Blocked by policy.' }), 'Blocked by policy.'],
  [conn({ state: 'needs-attention', probe: probe({ scopes: { found: [], needed: [], missing: ['issues:write'], extra: [], reported: true } }) }), 'The token is missing: issues:write.'],
  [conn({ rateLimited: { until: new Date(NOW + 5 * 60_000).toISOString() } }), 'Rate-limited by the remote. It resumes in 5 min.'],
], (c, reason) => {
  const s = C.connectionStatus(c, NOW);
  assert.equal(s.label, 'Needs attention');
  assert.equal(s.tone, 'warning');
  assert.equal(s.reason, reason);
});

test('an expired rate limit no longer counts', () => {
  assert.equal(C.connectionStatus(conn({ rateLimited: { until: new Date(NOW - 1000).toISOString() } }), NOW).label, 'Connected');
});

test('off wins over everything', () => {
  const s = C.connectionStatus(conn({ disabled: true, state: 'off', hasCredential: false }), NOW);
  assert.deepEqual([s.label, s.tone], ['Off', 'neutral']);
});

// ── capability chips ─────────────────────────────────────────────────
test('capability chips only exist for what was probed', () => {
  const ids = C.capabilityChips(caps()).map(c => c.id);
  assert.deepEqual(ids, ['repos', 'pulls', 'draft', 'pr-comments', 'merge', 'items', 'transition', 'item-comments', 'checks', 'protection']);
  const none = C.capabilityChips(caps({ repos: false, pulls: { create: false, comment: false, merge: false, draft: false, bodyMax: 0 }, items: { query: false, create: false, transition: false, comment: false, estimate: 'none', parentLink: false }, checks: { read: false, rerun: false, logsUrl: false }, protection: { read: false } }));
  assert.deepEqual(none, []);
});

test('iterations and estimates are named for what the platform has', () => {
  const ids = C.capabilityChips(caps({ iterations: 'milestone', items: { query: false, create: false, transition: false, comment: false, estimate: 'label', parentLink: false } }));
  assert.ok(ids.some(c => c.label === 'Milestones'));
  assert.ok(ids.some(c => c.label === 'Estimates (labels)'));
});

// ── scopes ───────────────────────────────────────────────────────────
const needed = [
  { scope: 'contents:write', why: 'Push branches.', feature: 'pulls', required: true },
  { scope: 'checks:read', why: 'Read the remote\'s checks.', feature: 'checks', required: false },
];

test('reported scopes: missing is read from the provider\'s list', () => {
  const v = C.scopeView(probe({ scopes: { found: ['contents:write'], needed, missing: ['checks:read'], extra: [], reported: true } }));
  assert.deepEqual(v.rows.map(r => [r.scope, r.status, r.basis]), [['contents:write', 'ok', 'reported'], ['checks:read', 'missing', 'reported']]);
  assert.equal(v.ok, true, 'an optional scope missing does not stop use');
  assert.match(v.advice[0], /^Optional: checks:read/);
});

test('unreported scopes: a working capability counts as granted', () => {
  const v = C.scopeView(probe({
    capabilities: caps({ pulls: { create: false, comment: false, merge: false, draft: false, bodyMax: 0 } }),
    scopes: { found: [], needed, missing: [], extra: [], reported: false },
  }));
  assert.deepEqual(v.rows.map(r => [r.scope, r.status, r.basis]), [['contents:write', 'missing', 'probed'], ['checks:read', 'ok', 'probed']]);
  assert.equal(v.ok, false);
  assert.match(v.advice[0], /Add contents:write to the token/);
  assert.ok(v.advice.some(a => /does not list a token/.test(a)));
});

test('extra powers produce least-privilege advice', () => {
  const v = C.scopeView(probe({ scopes: { found: ['repo', 'admin:org'], needed: [], missing: [], extra: ['admin:org'], reported: true } }));
  assert.ok(v.advice.some(a => /more than AICO needs \(admin:org\)/.test(a) && /narrower token/.test(a)));
});

test('the verdict names the account, and what is missing when it cannot be used', () => {
  assert.equal(C.probeVerdict(probe({ version: 'GitHub.com' })).headline, 'Signed in as octo on GitHub.com.');
  const bad = C.probeVerdict(probe({ scopes: { found: [], needed, missing: ['contents:write'], extra: [], reported: true } }));
  assert.equal(bad.usable, false);
  assert.match(bad.headline, /missing contents:write/);
});

// ── "Connect GitHub for this repo?" ──────────────────────────────────
table('repo suggestion', [
  [{ project: '/p', provider: 'github', repo: { owner: 'acme', name: 'shop' } }, [], false, { text: 'Connect GitHub for this repo?', detail: 'acme/shop', action: 'connect', provider: 'github' }],
  [{ project: '/p', provider: 'github', connection: 'gh' }, [conn()], false, { text: 'Use GitHub for this repo?', action: 'map', connection: 'gh', provider: 'github' }],
  [{ project: '/p', provider: 'github' }, [], true, null],
  [{ project: '/p', provider: 'azure-devops' }, [], false, null],
  [{ project: '/p' }, [], false, null],
  [{ project: '/p', provider: 'github', connection: 'gh' }, [conn({ disabled: true })], false, { text: 'Connect GitHub for this repo?', action: 'connect', provider: 'github' }],
], (det, conns, mapped, want) => {
  assert.deepEqual(C.detectHint(det, conns, mapped, PROVIDERS), want);
});

// ── add form ─────────────────────────────────────────────────────────
const gh = PROVIDERS.find(p => p.id === 'github');
const gitea = PROVIDERS.find(p => p.id === 'gitea');
const form = (over = {}) => ({ provider: 'github', label: '', serverUrl: false, baseUrl: '', insecureHttp: false, caBundle: '', ...over });

table('server addresses', [
  ['https://git.example.com', false, true, 'https://git.example.com'],
  ['https://git.example.com/', false, true, 'https://git.example.com'],
  ['  https://git.example.com/gitea/  ', false, true, 'https://git.example.com/gitea'],
  ['', false, false, /Enter the server address/],
  ['git.example.com', false, false, /Start the address with https/],
  ['ftp://git.example.com', false, false, /Only https/],
  ['https://user:pw@git.example.com', false, false, /Remove the user name and password/],
  ['https://git.example.com?x=1', false, false, /without \?/],
  ['http://git.example.com', true, false, /only allowed for a private address/],
  ['http://192.168.1.20:3000', false, false, /Tick "Allow plain http/],
  ['http://192.168.1.20:3000', true, true, 'http://192.168.1.20:3000'],
  ['http://localhost:3000', true, true, 'http://localhost:3000'],
  ['http://169.254.169.254', true, false, /only allowed for a private address/],
  ['not a url://', false, false, /Start the address|valid address/],
], (raw, optIn, ok, want) => {
  const r = C.checkBaseUrl(raw, optIn);
  assert.equal(r.ok, ok, JSON.stringify(r));
  if (ok) assert.equal(r.url, want); else assert.match(r.error, want);
});

table('private hosts', [
  ['localhost', true], ['127.0.0.1', true], ['10.1.2.3', true], ['172.16.0.1', true], ['172.31.255.255', true], ['172.32.0.1', false],
  ['192.168.0.9', true], ['8.8.8.8', false], ['169.254.169.254', false], ['[::1]', true], ['fd12:3456::1', true], ['fe80::1', false],
  ['gitlab.corp', true], ['forge.internal', true], ['nas', true], ['github.com', false], ['300.1.1.1', false],
], (host, want) => assert.equal(C.isPrivateHost(host), want));

test('a cloud tile asks for no address and sends none', () => {
  const r = C.validateConnectionForm(form({ label: ' Work ' }), gh);
  assert.equal(r.ok, true);
  assert.deepEqual(r.body, { provider: 'github', label: 'Work' });
});

test('the Enterprise Server switch makes the address required', () => {
  const missing = C.validateConnectionForm(form({ serverUrl: true }), gh);
  assert.equal(missing.ok, false);
  assert.match(missing.errors.baseUrl, /Enter the server address/);
  const ok = C.validateConnectionForm(form({ serverUrl: true, baseUrl: 'https://ghe.example.com/' }), gh);
  assert.deepEqual(ok.body, { provider: 'github', baseUrl: 'https://ghe.example.com' });
});

test('a server-only provider always asks for the address', () => {
  assert.equal(C.asksForUrl(gitea, { serverUrl: false }), true);
  assert.equal(C.asksForUrl(gh, { serverUrl: false }), false);
});

test('plain http: the opt-in is reported on its own field and then sent', () => {
  const f = form({ provider: 'gitea', baseUrl: 'http://10.0.0.5:3000' });
  const refused = C.validateConnectionForm(f, gitea);
  assert.equal(refused.ok, false);
  assert.equal(refused.needsHttpOptIn, true);
  assert.ok(refused.errors.insecureHttp && !refused.errors.baseUrl);
  const ok = C.validateConnectionForm({ ...f, insecureHttp: true }, gitea);
  assert.deepEqual(ok.body, { provider: 'gitea', baseUrl: 'http://10.0.0.5:3000', insecureHttp: true });
});

table('CA bundle', [
  ['C:\\certs\\ca.pem', 'https://git.example.com', true],
  ['/etc/ssl/company.crt', 'https://git.example.com', true],
  ['/etc/ssl/company.txt', 'https://git.example.com', false],
  ['/etc/ssl/company.pem', 'http://10.0.0.5', false],
], (ca, url, ok) => {
  const r = C.validateConnectionForm(form({ provider: 'gitea', baseUrl: url, insecureHttp: true, caBundle: ca }), gitea);
  assert.equal(r.ok, ok, JSON.stringify(r.errors));
  if (ok) assert.equal(r.body.caBundle, ca);
});

test('a name over 60 characters is refused', () => {
  assert.ok(C.validateConnectionForm(form({ label: 'x'.repeat(61) }), gh).errors.label);
});

test('the form model has no token field', () => {
  const r = C.validateConnectionForm(form(), gh);
  assert.ok(!JSON.stringify(r).toLowerCase().includes('token'));
});

// ── mapping form ─────────────────────────────────────────────────────
test('the seven state rows are exactly the default map', () => {
  assert.deepEqual(C.STATE_ROWS.map(r => r.id), Object.keys(DEFAULT_STATE_MAP));
  assert.equal(C.STATE_ROWS.length, 7);
  const f = C.initialMappingForm({ connection: 'gh' });
  assert.deepEqual(f.stateMap, { ...DEFAULT_STATE_MAP });
  assert.deepEqual([f.landing, f.source, f.trunk, f.repo], ['local', 'off', 'main', '']);
});

test('detection prefills the repo and the trunk; an existing mapping wins', () => {
  const det = { project: '/p', repo: { owner: 'acme', name: 'shop' }, trunk: 'develop' };
  const f = C.initialMappingForm({ connection: 'gh', detection: det });
  assert.deepEqual([f.repo, f.trunk], ['acme/shop', 'develop']);
  const existing = { project: '/p', connection: 'gh', repo: { owner: 'acme', name: 'api' }, workItems: { source: 'label', value: 'aico' }, landing: 'pr', trunk: 'main', iterations: 'off', stateMap: { running: 'doing' }, trustedCommenters: ['bob'] };
  const g = C.initialMappingForm({ connection: 'gh', detection: det, existing });
  assert.deepEqual([g.repo, g.trunk, g.landing, g.source, g.value, g.trustedCommenters], ['acme/api', 'main', 'pr', 'label', 'aico', 'bob']);
  assert.equal(g.stateMap.running, 'doing');
  assert.equal(g.stateMap.backlog, DEFAULT_STATE_MAP.backlog);
});

table('repo text', [
  ['acme/shop', { owner: 'acme', name: 'shop' }], [' acme/shop.git ', { owner: 'acme', name: 'shop' }], ['acme', null], ['a/b/c', null], ['', null], ['ac me/shop', null],
], (text, want) => assert.deepEqual(C.parseRepo(text), want));

test('label and query sources need a value; off and assigned-to-me do not', () => {
  const base = { ...C.initialMappingForm({ connection: 'gh' }), repo: 'acme/shop' };
  assert.equal(C.validateMapping(base).ok, true);
  assert.equal(C.validateMapping({ ...base, source: 'assigned-to-me' }).ok, true);
  for (const source of ['label', 'query']) {
    const r = C.validateMapping({ ...base, source });
    assert.equal(r.ok, false);
    assert.match(r.errors.value, /Enter the (label|query)/);
    assert.equal(C.validateMapping({ ...base, source, value: 'x' }).ok, true);
  }
});

test('state names and branch are validated', () => {
  const base = { ...C.initialMappingForm({ connection: 'gh' }), repo: 'acme/shop' };
  const blank = C.validateMapping({ ...base, stateMap: { ...base.stateMap, running: '  ' } });
  assert.deepEqual(Object.keys(blank.errors.states), ['running']);
  assert.ok(C.validateMapping({ ...base, trunk: 'a b' }).errors.trunk);
  assert.ok(C.validateMapping({ ...base, trunk: '' }).errors.trunk);
  assert.ok(C.validateMapping({ ...base, repo: 'nope' }).errors.repo);
});

test('pull request mode needs the person\'s accept; staying in it does not', () => {
  const base = { ...C.initialMappingForm({ connection: 'gh' }), repo: 'acme/shop', landing: 'pr' };
  assert.equal(C.landingNeedsConfirm(base, undefined), true);
  assert.equal(C.landingNeedsConfirm(base, { landing: 'local' }), true);
  assert.equal(C.landingNeedsConfirm(base, { landing: 'pr' }), false);
  assert.equal(C.landingNeedsConfirm({ landing: 'local' }, { landing: 'pr' }), false);
  assert.equal(C.mappingBody('/p', base, undefined), null, 'no body until the card is accepted');
  const body = C.mappingBody('/p', { ...base, prConfirmed: true }, undefined);
  assert.equal(body.confirmLanding, true);
  assert.equal(body.landing, 'pr');
  const stay = C.mappingBody('/p', base, { landing: 'pr' });
  assert.ok(stay && !('confirmLanding' in stay));
});

test('the map body carries what the form says and nothing else', () => {
  const f = { ...C.initialMappingForm({ connection: 'gh' }), repo: 'acme/shop', source: 'label', value: ' aico ', trustedCommenters: '@bob, carol bob' };
  const b = C.mappingBody('/p', f, undefined);
  assert.deepEqual(b.repo, { owner: 'acme', name: 'shop' });
  assert.deepEqual(b.workItems, { source: 'label', value: 'aico' });
  assert.deepEqual(b.trustedCommenters, ['bob', 'carol']);
  assert.deepEqual(b.stateMap, { ...DEFAULT_STATE_MAP });
  assert.ok(!('confirmLanding' in b));
  const off = C.mappingBody('/p', { ...f, source: 'off' }, undefined);
  assert.deepEqual(off.workItems, { source: 'off' });
});

test('the confirm card says what will happen', () => {
  const t = C.prConfirmText('acme/shop');
  assert.match(t, /push aico\/task-\* branches to acme\/shop and open pull requests/);
  assert.match(t, /never pushes the trunk, never force-pushes/);
  assert.match(t, /checks and reviews decide when work lands/);
});

// ── policy ───────────────────────────────────────────────────────────
test('policy: any allows everything and shows no banner', () => {
  assert.deepEqual(C.policyView({ mode: 'any' }), { forbidden: false, prAllowed: true, banner: null });
  assert.deepEqual(C.policyView(undefined), { forbidden: false, prAllowed: true, banner: null });
});

test('policy: forbid, allow-list and maxLanding', () => {
  assert.equal(C.policyView({ mode: 'forbid' }).forbidden, true);
  assert.match(C.policyView({ mode: 'forbid' }).banner, /does not allow connections/);
  assert.equal(C.policyView({ mode: 'any', maxLanding: 'local' }).prAllowed, false);
  assert.match(C.policyView({ mode: 'any', maxLanding: 'local' }).banner, /limits pull request landing/);
  assert.equal(C.policyView({ mode: 'allow-list', message: 'Ask IT.' }).banner, 'Ask IT.');
  const pol = { mode: 'allow-list', providers: ['github'], hosts: ['github.com', '*.corp.example'] };
  assert.equal(C.providerAllowed(pol, 'github'), true);
  assert.equal(C.providerAllowed(pol, 'gitlab'), false);
  assert.equal(C.hostAllowed(pol, 'github.com'), true);
  assert.equal(C.hostAllowed(pol, 'git.corp.example'), true);
  assert.equal(C.hostAllowed(pol, 'evil.example'), false);
  assert.equal(C.providerAllowed({ mode: 'forbid' }, 'github'), false);
});

test('provider tiles: supported first, the rest disabled with their note, Other last', () => {
  const tiles = C.providerTiles(PROVIDERS);
  assert.equal(tiles[0].id, 'github');
  assert.equal(tiles[0].enabled, true);
  assert.equal(tiles.at(-1).id, 'other');
  assert.equal(tiles.at(-1).enabled, false);
  const az = tiles.find(t => t.id === 'azure-devops');
  assert.deepEqual([az.enabled, az.note], [false, 'Next after GitHub.']);
  const blocked = C.providerTiles(PROVIDERS, { mode: 'allow-list', providers: ['gitlab'] }).find(t => t.id === 'github');
  assert.deepEqual([blocked.enabled, blocked.note], [false, 'Not allowed by your organization.']);
});

// ── pull requests ────────────────────────────────────────────────────
const pr = (over = {}) => ({
  connection: 'gh', id: '12', url: 'https://github.com/acme/shop/pull/12', state: 'open', draft: false, headSha: 'abc',
  mergeable: 'mergeable', checks: { state: 'passing', items: [] }, reviews: { state: 'approved', approved: 2, required: 2, changesRequested: 0 },
  canMerge: true, mergeBlockers: [], observedAt: '2026-10-09T11:59:00Z', ...over,
});
const ids = chips => chips.map(c => `${c.id}:${c.label}:${c.tone}`);

test('a mergeable pull request reads passing, approved, ready', () => {
  assert.deepEqual(ids(C.prChips(pr())), ['checks:Checks passing:success', 'reviews:Approved (2 of 2):success', 'ready:Ready to merge:success']);
});

table('checks chip per state', [
  ['none', 'No checks', 'neutral'], ['pending', 'Checks running', 'info'], ['passing', 'Checks passing', 'success'], ['failing', 'Checks failing', 'danger'],
], (state, label, tone) => {
  const c = C.prChips(pr({ checks: { state, items: [] }, canMerge: false })).find(x => x.id === 'checks');
  assert.deepEqual([c.label, c.tone], [label, tone]);
});

test('failing check names are listed, clipped, and counted', () => {
  const items = ['lint', 'unit', 'e2e', 'build'].map(name => ({ name, state: 'failure' })).concat([{ name: 'ok', state: 'success' }]);
  const p = pr({ checks: { state: 'failing', items }, canMerge: false });
  assert.equal(C.failingLine(p), 'Failing: lint, unit +2');
  assert.equal(C.prChips(p).find(c => c.id === 'checks').title, 'Failing: lint, unit +2');
  assert.equal(C.failingLine(pr()), null);
  assert.equal(C.nameList(['x'.repeat(40)]).length, 28);
});

table('reviews chip per state', [
  [{ state: 'approved', approved: 1, changesRequested: 0 }, 'Approved (1)', 'success'],
  [{ state: 'pending', approved: 1, required: 2, changesRequested: 0 }, 'Awaiting review (1 of 2)', 'warning'],
  [{ state: 'changes', approved: 0, changesRequested: 2 }, 'Changes requested', 'danger'],
  [{ state: 'none', approved: 0, required: 1, changesRequested: 0 }, 'Approvals 0 of 1', 'warning'],
  [{ state: 'none', approved: 0, changesRequested: 0 }, 'No reviews', 'neutral'],
], (reviews, label, tone) => {
  const c = C.prChips(pr({ reviews, canMerge: false })).find(x => x.id === 'reviews');
  assert.deepEqual([c.label, c.tone], [label, tone]);
});

test('compact chips leave out the quiet ones; merged and closed are just their state', () => {
  const quiet = pr({ reviews: { state: 'none', approved: 0, changesRequested: 0 }, canMerge: false });
  assert.ok(C.prChips(quiet).some(c => c.id === 'reviews'));
  assert.ok(!C.prChips(quiet, { compact: true }).some(c => c.id === 'reviews'));
  assert.deepEqual(ids(C.prChips(pr({ state: 'merged' }))), ['state:Merged:success']);
  assert.deepEqual(ids(C.prChips(pr({ state: 'closed' }))), ['state:Closed:neutral']);
});

test('conflicts and drafts show instead of "ready"', () => {
  const c = C.prChips(pr({ mergeable: 'conflicting', canMerge: false }));
  assert.ok(c.some(x => x.id === 'conflicts' && x.tone === 'danger'));
  assert.ok(!c.some(x => x.id === 'ready'));
  assert.ok(C.prChips(pr({ draft: true, canMerge: true })).some(x => x.id === 'draft'));
  assert.ok(!C.prChips(pr({ draft: true, canMerge: true })).some(x => x.id === 'ready'));
});

test('merge blockers: the remote\'s own words first, ours only as a fallback', () => {
  assert.deepEqual(C.mergeBlockers(pr({ canMerge: false, mergeBlockers: ['2 required checks have not passed', '2 required checks have not passed'] })), ['2 required checks have not passed']);
  assert.deepEqual(C.mergeBlockers(pr({ canMerge: false, draft: true, mergeable: 'conflicting', checks: { state: 'failing', items: [] }, reviews: { state: 'pending', approved: 0, required: 2, changesRequested: 0 } })), [
    'The pull request is still a draft.', 'It conflicts with the target branch.', 'A check failed.', 'Needs 2 more approvals.',
  ]);
  assert.deepEqual(C.mergeBlockers(pr({ canMerge: false, mergeable: 'unknown', checks: { state: 'passing', items: [] }, reviews: { state: 'approved', approved: 1, changesRequested: 0 } })), ['The remote has not said it can be merged yet.']);
  assert.deepEqual(C.mergeBlockers(pr()), []);
  assert.deepEqual(C.mergeBlockers(pr({ state: 'merged', canMerge: false })), []);
});

test('Merge is offered only when the remote says it can merge now', () => {
  assert.equal(C.canMergeOnRemote({ pr: pr() }), true);
  assert.equal(C.canMergeOnRemote({ pr: pr({ canMerge: false }) }), false);
  assert.equal(C.canMergeOnRemote({ pr: pr({ draft: true }) }), false);
  assert.equal(C.canMergeOnRemote({ pr: pr({ state: 'merged' }) }), false);
  assert.equal(C.canMergeOnRemote({}), false);
});

test('merge wording', () => {
  assert.equal(C.mergeButtonLabel('github'), 'Merge on GitHub');
  assert.equal(C.mergeButtonLabel(undefined), 'Merge pull request');
  assert.equal(C.mergeConfirmText({ id: '12' }, 'main'), 'Merge pull request #12 into main? The remote has confirmed it can be merged.');
  assert.equal(C.mergeConfirmText({ id: '#12' }, 'main'), 'Merge pull request #12 into main? The remote has confirmed it can be merged.');
  assert.equal(C.prName({ id: '12' }), 'PR #12');
  assert.deepEqual(['open', 'merged', 'closed'].map(state => C.prStateWord({ state, draft: false })), ['Open', 'Merged', 'Closed']);
  assert.equal(C.prStateWord({ state: 'open', draft: true }), 'Draft');
});

// ── review card wording ──────────────────────────────────────────────
test('the review card lands locally unless the project lands through pull requests', () => {
  assert.deepEqual(C.landingUi(undefined, {}), { action: 'Approve and land', busy: 'Landing…', confirm: 'Confirm: land a high-risk change', foot: 'Lands on the trunk' });
  assert.equal(C.landingUi('local', {}).action, 'Approve and land');
  assert.equal(C.landingUi('pr', {}).action, 'Open pull request');
  assert.equal(C.landingUi('pr', { pr: pr() }).action, 'Update pull request');
  assert.match(C.landingUi('pr', {}).confirm, /open a pull request for a high-risk change/);
});

test('the batch button follows the landing mode', () => {
  assert.equal(C.batchLandingLabel(2, 'local'), 'Approve and land 2');
  assert.equal(C.batchLandingLabel(1, 'pr'), 'Open 1 pull request');
  assert.equal(C.batchLandingLabel(3, 'pr'), 'Open 3 pull requests');
  assert.equal(C.batchLandingLabel(3, 'pr', true), 'Opening 3…');
});

// ── imported tasks ───────────────────────────────────────────────────
test('imported task chip', () => {
  const remote = { connection: 'gh', kind: 'item', id: '12', url: 'https://github.com/acme/shop/issues/12', rev: 'r', syncedAt: 'x', remoteState: 'open', readyOnRemote: true };
  assert.deepEqual(C.remoteChip(remote, 'GitHub'), { text: 'from GitHub #12', url: remote.url, readyOnRemote: true, closed: false });
  assert.equal(C.remoteChip({ ...remote, remoteState: 'closed', readyOnRemote: undefined }, 'the remote').closed, true);
  assert.equal(C.remoteChip(undefined, 'GitHub'), null);
});

table('only http(s) links are opened', [
  ['https://github.com/a/b/pull/1', 'https://github.com/a/b/pull/1'], ['http://10.0.0.5/x', 'http://10.0.0.5/x'],
  ['javascript:alert(1)', null], ['file:///etc/passwd', null], ['', null], [undefined, null], ['not a url', null],
], (url, want) => assert.equal(C.safeExternalUrl(url), want));

// ── board header ─────────────────────────────────────────────────────
table('sync chip', [
  [{ state: 'syncing' }, 'Syncing…', 'info', true],
  [{ state: 'idle', at: new Date(NOW - 3 * 60_000).toISOString() }, 'Synced 3m ago', 'neutral', false],
  [{ state: 'idle' }, 'Not synced yet', 'neutral', false],
  [{ state: 'rate-limited' }, 'Rate-limited', 'warning', false],
  [{ state: 'error', message: 'HTTP 502' }, 'Sync failed', 'danger', false],
  [{ state: 'blocked' }, 'Blocked by policy', 'warning', false],
], (sync, label, tone, busy) => {
  const c = C.syncChip(sync, NOW);
  assert.deepEqual([c.label, c.tone, c.busy], [label, tone, busy]);
});

test('sync titles carry the engine\'s message', () => {
  assert.equal(C.syncChip({ state: 'error', message: 'HTTP 502' }, NOW).title, 'HTTP 502');
  assert.match(C.syncChip({ state: 'rate-limited' }, NOW).title, /slow down/);
});

test('board label and sync result sentence', () => {
  assert.equal(C.boardConnectionLabel({ connection: 'gh', label: 'GitHub', provider: 'github', repo: 'acme/shop', landing: 'pr', workItems: 'off', sync: { state: 'idle' } }), 'GitHub · acme/shop');
  assert.equal(C.landingWord('pr'), 'Pull requests');
  assert.equal(C.syncResultLine({ imported: 0, updated: 0, pushed: 0, observed: 0, conflicts: 0 }), 'Already up to date.');
  assert.equal(C.syncResultLine({ imported: 3, updated: 1, pushed: 0, observed: 2, conflicts: 1, message: 'Next sync in 5 min.' }),
    'Synced: 3 imported, 1 updated, 2 pull requests checked. 1 conflict: the remote\'s version was kept. Next sync in 5 min.');
});

test('provider labels fall back to the id', () => {
  assert.equal(C.providerLabel('azure-devops'), 'Azure DevOps');
  assert.equal(C.providerLabel('custom'), 'Custom connector');
  assert.equal(C.providerLabel('linear'), 'linear');
  assert.equal(C.serverSwitchLabel('github'), 'GitHub Enterprise Server');
  assert.equal(C.serverSwitchLabel('gitea'), null);
});

// ── the "PR open" status in the board's model ───────────────────────
const task = (id, over = {}) => ({ id, project: '/p', title: `Task ${id}`, body: '', acceptance: [], status: 'backlog', priority: 3, dependsOn: [], labels: [], createdAt: 1000, updatedAt: 1000, ...over });

test('PR open is a column between Changes and Merged, with a label', () => {
  const order = M.COLUMNS.map(c => c.id);
  assert.deepEqual(order.slice(order.indexOf('changes')), ['changes', 'pr', 'merged']);
  assert.equal(M.STATUS_LABEL.pr, 'PR open');
  assert.equal(M.COLUMNS.find(c => c.id === 'pr').label, 'PR open');
});

test('tasks group, count and sort under pr', () => {
  const ts = [task('a', { status: 'pr', updatedAt: 1 }), task('b', { status: 'pr', updatedAt: 9 }), task('c', { status: 'merged' })];
  assert.deepEqual(M.groupTasks(ts).pr.map(t => t.id), ['b', 'a']);
  const n = M.countTasks(ts);
  assert.deepEqual([n.byStatus.pr, n.open], [2, 2]);
});

test('a person cannot drag a task into or out of PR open, and is told why', () => {
  assert.equal(M.checkMove({ status: 'pr' }, 'backlog').ok, false);
  assert.match(M.checkMove({ status: 'pr' }, 'backlog').reason, /remote/);
  const into = M.checkMove({ status: 'ready' }, 'pr');
  assert.equal(into.ok, false);
  assert.match(into.reason, /Open pull request/);
  assert.deepEqual(M.allowedTargets({ status: 'pr' }), []);
});

test('the board keeps its connection, and a board without one has none', () => {
  const bc = { connection: 'gh', label: 'GitHub', provider: 'github', repo: 'acme/shop', landing: 'pr', workItems: 'off', sync: { state: 'idle' } };
  assert.deepEqual(M.normaliseBoard({ project: '/p', tasks: [], connection: bc }).connection, bc);
  assert.ok(!('connection' in M.normaliseBoard({ project: '/p', tasks: [] })));
  const t = M.normaliseBoard({ project: '/p', tasks: [task('x', { status: 'pr', pr: { id: '1' }, remote: { id: '2' } })] }).tasks[0];
  assert.deepEqual([t.pr.id, t.remote.id], ['1', '2']);
});

console.log(`connections: ${passed} tests passed${process.exitCode ? ' (with failures)' : ''}`);
