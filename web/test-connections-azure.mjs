/**
 * Unit tests for the Azure DevOps share of the Connections page (web/src/connections-azure.ts and its
 * hooks in web/src/connections.ts, ADR 0039): turning what a person types into an organization and a
 * project/repository pair, the add form for Services versus Server, the mapping form's Azure wording
 * and defaults, and the process-aware state preview (the Agile, Scrum, CMMI and Basic processes).
 *
 * Bundles its own subjects with esbuild, so it runs on its own:
 *   node web/test-connections-azure.mjs
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aico-azure-web-'));
async function load(rel, name) {
  const outfile = path.join(tmp, `${name}.mjs`);
  await build({ entryPoints: [path.join(here, rel)], bundle: true, format: 'esm', platform: 'node', outfile, logLevel: 'error' });
  return import(pathToFileURL(outfile).href);
}
const A = await load('src/connections-azure.ts', 'azure');
const C = await load('src/connections.ts', 'connections');
const { PROVIDERS } = await load('../shared/connections/types.ts', 'types');
const P = await load('../shared/connections/process.ts', 'process');

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; } catch (e) { console.error(`FAIL ${name}\n`, e); process.exitCode = 1; }
}
function table(name, rows, fn) {
  test(name, () => { for (const row of rows) { try { fn(...row); } catch (e) { e.message = `row ${JSON.stringify(row).slice(0, 160)}: ${e.message}`; throw e; } } });
}

const info = PROVIDERS.find(p => p.id === 'azure-devops');

table('organization: a name, or any address that holds one', [
  ['acme', 'acme'],
  ['  acme  ', 'acme'],
  ['dev.azure.com/acme', 'acme'],
  ['https://dev.azure.com/acme/Shop/_git/web', 'acme'],
  ['https://acme.visualstudio.com', 'acme'],
  ['https://acme.visualstudio.com/DefaultCollection', 'acme'],
  ['Acme-Corp', 'Acme-Corp'],
], (text, want) => {
  const r = A.parseAzureOrg(text);
  assert.equal(r.ok, true);
  assert.equal(r.org, want);
  assert.equal(r.baseUrl, `https://dev.azure.com/${want}`);
});

table('organization: refused with a reason', [
  [''], ['   '], ['-bad'], ['has space'], ['https://github.com/acme'], ['https://tfs.corp/tfs/DefaultCollection'], ['https://dev.azure.com/'], ['a'.repeat(51)],
], (text) => {
  const r = A.parseAzureOrg(text);
  assert.equal(r.ok, false);
  assert.ok(r.error.length > 10);
});

table('organization of a Services address (for labels)', [
  ['https://dev.azure.com/acme', 'acme'], ['https://dev.azure.com/acme/', 'acme'], ['https://tfs.corp/tfs/DefaultCollection', undefined], ['nonsense', undefined],
], (url, want) => assert.equal(A.orgOfBaseUrl(url), want));

table('project/repository: spaces are fine, path characters are not, addresses are understood', [
  ['Shop/web', { owner: 'Shop', name: 'web' }],
  [' My Shop / my web ', { owner: 'My Shop', name: 'my web' }],
  ['Shop/web.git', { owner: 'Shop', name: 'web' }],
  ['https://dev.azure.com/acme/Shop/_git/web', { owner: 'Shop', name: 'web' }],
  ['https://dev.azure.com/acme/My%20Shop/_git/my%20web', { owner: 'My Shop', name: 'my web' }],
  ['https://dev.azure.com/acme/_git/web', { owner: 'web', name: 'web' }],
  ['https://acme.visualstudio.com/Shop/_git/web', { owner: 'Shop', name: 'web' }],
  ['https://tfs.corp/tfs/DefaultCollection/Shop/_git/web', { owner: 'Shop', name: 'web' }],
  ['git@ssh.dev.azure.com:v3/acme/Shop/web', { owner: 'Shop', name: 'web' }],
  ['Shop', null], ['a/b/c', null], ['a/', null], ['/b', null], ['a/b?', null], ['a:b/c', null], ['a/..', null], ['x./y', null], ['', null],
  ['https://dev.azure.com/acme/Shop', null],
], (text, want) => assert.deepEqual(A.parseAzureRepo(text), want));

test('the generic repo parser hands Azure to the Azure rules and leaves every other provider alone', () => {
  assert.deepEqual(C.parseRepo('My Shop/web', 'azure-devops'), { owner: 'My Shop', name: 'web' });
  assert.equal(C.parseRepo('My Shop/web'), null);
  assert.equal(C.parseRepo('My Shop/web', 'github'), null);
  assert.deepEqual(C.parseRepo('acme/shop', 'github'), { owner: 'acme', name: 'shop' });
});

test('the Azure tile is enabled and asks for an organization, not a URL', () => {
  assert.equal(info.supported, true);
  assert.equal(info.asksUrl, false);
  assert.equal(info.cloudUrl, undefined);
  assert.equal(C.serverSwitchLabel('azure-devops'), 'Azure DevOps Server');
  assert.equal(C.asksForUrl(info, { serverUrl: false }), false);
  assert.equal(C.asksForUrl(info, { serverUrl: true }), true);
  assert.ok(info.tokenAdvice.some(a => /Work Items/.test(a)) && info.tokenAdvice.some(a => /Project and Team/.test(a)));
});

test('the add form: Services builds the address from the organization', () => {
  const ok = C.validateConnectionForm({ provider: 'azure-devops', label: '', serverUrl: false, baseUrl: '', organization: 'dev.azure.com/acme', insecureHttp: false, caBundle: '' }, info);
  assert.equal(ok.ok, true);
  assert.equal(ok.body.baseUrl, 'https://dev.azure.com/acme');
  assert.equal(ok.body.provider, 'azure-devops');
  const none = C.validateConnectionForm({ provider: 'azure-devops', label: '', serverUrl: false, baseUrl: '', insecureHttp: false, caBundle: '' }, info);
  assert.equal(none.ok, false);
  assert.match(none.errors.baseUrl, /organization/i);
  const bad = C.validateConnectionForm({ provider: 'azure-devops', label: '', serverUrl: false, baseUrl: '', organization: 'https://github.com/x', insecureHttp: false, caBundle: '' }, info);
  assert.equal(bad.ok, false);
});

test('the add form: Server takes the collection address, https only (plain http only for a private address with the opt-in)', () => {
  const ok = C.validateConnectionForm({ provider: 'azure-devops', label: 'On-prem', serverUrl: true, baseUrl: 'https://tfs.corp/tfs/DefaultCollection/', insecureHttp: false, caBundle: '' }, info);
  assert.equal(ok.ok, true);
  assert.equal(ok.body.baseUrl, 'https://tfs.corp/tfs/DefaultCollection');
  const user = C.validateConnectionForm({ provider: 'azure-devops', label: '', serverUrl: true, baseUrl: 'https://u:p@tfs.corp/c', insecureHttp: false, caBundle: '' }, info);
  assert.equal(user.ok, false);
  const http = C.validateConnectionForm({ provider: 'azure-devops', label: '', serverUrl: true, baseUrl: 'http://tfs.corp/c', insecureHttp: false, caBundle: '' }, info);
  assert.equal(http.ok, false);
  const withOptIn = C.validateConnectionForm({ provider: 'azure-devops', label: '', serverUrl: true, baseUrl: 'http://10.0.0.5/c', insecureHttp: true, caBundle: '' }, info);
  assert.equal(withOptIn.ok, true);
  assert.equal(withOptIn.body.insecureHttp, true);
});

test('labels and the token page', () => {
  assert.equal(C.defaultLabel(info, 'https://dev.azure.com/acme'), 'Azure DevOps (acme)');
  assert.equal(C.defaultLabel(info, 'https://tfs.corp/tfs/DefaultCollection'), 'Azure DevOps (tfs.corp)');
  assert.equal(C.defaultLabel(info, ''), 'Azure DevOps');
  assert.equal(C.tokenPageUrl('azure-devops', 'https://tfs.corp/tfs/DefaultCollection/'), 'https://tfs.corp/tfs/DefaultCollection/_usersSettings/tokens');
});

test('the mapping form: Azure starts from categories, other providers from labels', () => {
  const az = C.initialMappingForm({ connection: 'c1', provider: 'azure-devops' });
  assert.equal(az.provider, 'azure-devops');
  assert.equal(az.iterations, 'off');
  assert.deepEqual(az.stateMap, { backlog: 'Proposed', ready: 'Proposed', running: 'InProgress', review: 'InProgress', pr: 'InProgress', merged: 'Completed', blocked: 'aico:blocked' });
  const gh = C.initialMappingForm({ connection: 'c2', provider: 'github' });
  assert.equal(gh.stateMap.running, 'aico:running');
  const plain = C.initialMappingForm({ connection: 'c3' });
  assert.equal('provider' in plain, false, 'a caller that does not say the provider gets exactly the form it always got');
  assert.equal('iterations' in plain, false);
  assert.equal(C.stateMapOf(undefined, 'azure-devops').merged, 'Completed');
  assert.equal(C.stateMapOf({ merged: 'Resolved' }, 'azure-devops').merged, 'Resolved');
  const saved = C.initialMappingForm({ connection: 'c1', provider: 'azure-devops', existing: { connection: 'c1', repo: { owner: 'Shop', name: 'web' }, workItems: { source: 'label', value: 'aico' }, landing: 'pr', trunk: 'main', iterations: 'native', stateMap: { merged: 'Resolved' } } });
  assert.equal(saved.iterations, 'native');
  assert.equal(saved.repo, 'Shop/web');
  assert.equal(saved.stateMap.merged, 'Resolved');
});

test('the mapping form: validation and the request body for Azure', () => {
  const form = { ...C.initialMappingForm({ connection: 'c1', provider: 'azure-devops' }), repo: 'My Shop/web', source: 'label', value: 'aico', iterations: 'native' };
  assert.equal(C.validateMapping(form).ok, true);
  const body = C.mappingBody('/p', form, null);
  assert.deepEqual(body.repo, { owner: 'My Shop', name: 'web' });
  assert.equal(body.iterations, 'native');
  assert.equal(body.stateMap.running, 'InProgress');
  const bad = C.validateMapping({ ...form, repo: 'just-a-name' });
  assert.equal(bad.ok, false);
  assert.match(bad.errors.repo, /project\/repository/);
  const github = C.initialMappingForm({ connection: 'c2', provider: 'github' });
  assert.match(C.validateMapping({ ...github, repo: 'nope' }).errors.repo, /owner\/name/);
  const noIter = C.mappingBody('/p', C.initialMappingForm({ connection: 'c3' }), null);
  assert.equal(noIter, null, 'an empty repo is refused as before');
});

test('work item sources are worded for Azure DevOps', () => {
  const az = C.workItemOptions('azure-devops');
  assert.equal(az.find(o => o.id === 'label').label, 'Tag');
  assert.match(az.find(o => o.id === 'query').valueLabel, /WIQL/);
  assert.equal(az.find(o => o.id === 'off').label, 'Off');
  assert.equal(C.workItemOptions('github'), C.WORK_ITEM_OPTIONS);
  assert.equal(C.workItemOptions(), C.WORK_ITEM_OPTIONS);
});

// ── the process-aware preview ─────────────────────────────────────────────

const st = (...pairs) => pairs.map(([name, category]) => ({ name, category }));
const PROCESSES = {
  Agile: [{ name: 'User Story', states: st(['New', 'proposed'], ['Active', 'inprogress'], ['Resolved', 'resolved'], ['Closed', 'completed']) }, { name: 'Task', states: st(['New', 'proposed'], ['Active', 'inprogress'], ['Closed', 'completed']) }],
  Scrum: [{ name: 'Product Backlog Item', states: st(['New', 'proposed'], ['Approved', 'proposed'], ['Committed', 'inprogress'], ['Done', 'completed']) }, { name: 'Task', states: st(['To Do', 'proposed'], ['In Progress', 'inprogress'], ['Done', 'completed']) }],
  CMMI: [{ name: 'Requirement', states: st(['Proposed', 'proposed'], ['Active', 'inprogress'], ['Resolved', 'resolved'], ['Closed', 'completed']) }],
  Basic: [{ name: 'Issue', states: st(['To Do', 'proposed'], ['Doing', 'inprogress'], ['Done', 'completed']) }],
};
const ROWS = C.STATE_ROWS.map(r => r.id);

table('the preview names each type\'s own state (running, merged) in all four processes', [
  ['Agile', 'User Story', 'Active', 'Closed'], ['Agile', 'Task', 'Active', 'Closed'],
  ['Scrum', 'Product Backlog Item', 'Committed', 'Done'], ['Scrum', 'Task', 'In Progress', 'Done'],
  ['CMMI', 'Requirement', 'Active', 'Closed'], ['Basic', 'Issue', 'Doing', 'Done'],
], (process, type, running, merged) => {
  const rows = A.azureStatePreview(C.stateMapOf(undefined, 'azure-devops'), { name: process, types: PROCESSES[process] }, ROWS);
  const cell = (aico) => rows.find(r => r.aico === aico).perType.find(p => p.type === type).state;
  assert.equal(cell('running'), running);
  assert.equal(cell('review'), running);
  assert.equal(cell('merged'), merged);
  assert.equal(rows.find(r => r.aico === 'blocked').kind, 'tag');
});

test('a category a type does not have is shown as "no state", and a custom map is previewed as typed', () => {
  const rows = A.azureStatePreview({ ...C.stateMapOf(undefined, 'azure-devops'), merged: 'Resolved' }, { name: 'Agile', types: PROCESSES.Agile }, ROWS);
  const merged = rows.find(r => r.aico === 'merged');
  assert.equal(merged.category, 'resolved');
  assert.equal(merged.perType.find(p => p.type === 'User Story').state, 'Resolved');
  assert.equal(merged.perType.find(p => p.type === 'Task').state, null);
  assert.deepEqual(A.azureStatePreview({}, null, ['running']).map(r => r.perType), [[]]);
});

test('the process summary is a sentence', () => {
  assert.equal(A.processSummary({ name: 'Agile', types: PROCESSES.Agile }), 'The Agile process: User Story and Task.');
  assert.match(A.processSummary({ name: 'Custom', types: [] }), /customised process/i);
  const many = A.processSummary({ name: 'Scrum', types: ['A', 'B', 'C', 'D', 'E', 'F'].map(name => ({ name, states: [] })) });
  assert.match(many, /A, B, C and D and 2 more/);
});

test('the shared category helpers the page and the engine both use', () => {
  assert.equal(P.categoryWord('InProgress'), 'inprogress');
  assert.equal(P.categoryWord('aico:running'), undefined);
  assert.equal(P.needsMove('inprogress', 'completed'), true);
  assert.equal(P.needsMove('completed', 'inprogress'), false);
  assert.equal(P.CATEGORY_STATE_MAP.blocked, 'aico:blocked');
});

test('a sync result with sprint changes reads as a sentence', () => {
  assert.equal(C.syncResultLine({ imported: 2, updated: 0, pushed: 0, observed: 0, conflicts: 0, sprints: 3 }), 'Synced: 2 imported, 3 sprint changes.');
  assert.equal(C.syncResultLine({ imported: 0, updated: 0, pushed: 0, observed: 0, conflicts: 0, sprints: 1 }), 'Synced: 1 sprint change.');
});

test('the repository suggestion offers to connect Azure DevOps from a recognised remote', () => {
  const hint = C.detectHint({ project: '/p', provider: 'azure-devops', repo: { owner: 'Shop', name: 'web' }, baseUrl: 'https://dev.azure.com/acme' }, [], false, PROVIDERS);
  assert.equal(hint.text, 'Connect Azure DevOps for this repo?');
  assert.equal(hint.detail, 'Shop/web');
});

console.log(`connections-azure: ${passed} tests passed${process.exitCode ? ' (with failures)' : ''}`);
fs.rmSync(tmp, { recursive: true, force: true });
