/**
 * Connector packs, as the Connections page, the `ConnectionManage` tool and the tests use them:
 * list, draft, validate, contract-test, enable (a person), disable, connect.
 *
 * Who may do what, enforced here and at the one route that reaches `enablePack`:
 *
 *   draft / validate / test    the agent (ConnectionManage) or a person. Writing files and running a
 *                              loopback contract test grants nothing: an edited pack is simply a
 *                              different, unapproved one.
 *   enable                     a PERSON ONLY, and only for the content hash they were shown. There is no
 *                              tool action for it and the engine route behind it asks the decision gate
 *                              for a human (server/connection-routes.ts); this module's `enablePack` is
 *                              imported by that route and by tests, and by nothing the model can call.
 *   connect                    makes a connection record for an ENABLED pack with the hosts the person
 *                              approved. A token still has to be pasted by a person.
 *
 * The managed policy can forbid packs outright (`connections.packs: "forbid"`), restrict them by
 * host (`connections.hosts`), or by name through the `customTools` / `mcp` rules (a pack is checked as
 * `connector:<id>`; an MCP-backed operation's server is checked as an MCP server at run time). Every
 * entry point here asks, so a forbidden pack cannot even be drafted or tested.
 *
 * @module connections/packs
 */

import fs from 'node:fs';
import path from 'node:path';
import type { ConnectorPackView, PackOperationView } from '../../../shared/connections/packs.js';
import { connectionDecision, extensionDecision } from '../../policy/enforce.js';
import { isPrivateHost } from '../../vault/policy.js';
import { auditConnection } from '../audit.js';
import * as ConnStore from '../store.js';
import type { StoredConnection } from '../types.js';
import { runContract, type ContractReport } from './contract.js';
import { MAX_CONNECTOR_BYTES, MAX_FIXTURE_BYTES, MAX_TOOL_BYTES, OP_NAMES, type OpSummary } from './format.js';
import { PackError, clearEnabled, listPackIds, loadPack, packDir, setEnabled, writeDraft, type LoadedPack } from './store.js';

export { PackError } from './store.js';
export { customAdapter } from './adapter.js';
export { runContract } from './contract.js';
export type { ContractReport } from './contract.js';

// ── policy ─────────────────────────────────────────────────────────────────

/** Is any use of connector packs allowed here? Asked before a draft, a test, an enable and a connect. */
export function packsPolicy(id?: string, hosts: readonly string[] = []): { ok: true } | { ok: false; message: string; rule: string } {
  const base = connectionDecision({ provider: 'custom', pack: true });
  if (!base.ok) return base;
  const ext = extensionDecision('customTools', id ? `connector:${id}` : 'connector');
  if (!ext.ok) return ext;
  for (const h of hosts) {
    const d = connectionDecision({ provider: 'custom', pack: true, host: h.replace(/:\d+$/, '') });
    if (!d.ok) return d;
  }
  return { ok: true };
}

function requireAllowed(id: string, hosts: readonly string[] = []): void {
  const p = packsPolicy(id, hosts);
  if (!p.ok) {
    auditConnection({ action: 'policy.deny', connection: '-', provider: 'custom', ref: id, outcome: 'denied', detail: p.rule });
    throw new PackError(p.message, 'policy');
  }
}

// ── views ──────────────────────────────────────────────────────────────────

const PHRASE: Record<string, string> = {
  'repos.get': 'read repositories', 'pulls.find': 'find pull requests', 'pulls.create': 'open pull requests', 'pulls.get': 'read pull requests',
  'pulls.comment': 'comment on pull requests', 'pulls.comments': 'read pull request comments', 'pulls.merge': 'merge (a person clicks)',
  'items.query': 'import work items', 'items.get': 'read work items', 'items.create': 'create work items', 'items.update': 'edit work items',
  'items.transition': 'close work items', 'items.comment': 'comment on work items', 'checks.forCommit': 'read checks',
};

function authWords(p: LoadedPack): string {
  const a = p.report.manifest?.auth;
  if (!a) return '';
  return a.scheme === 'bearer' ? 'Authorization: Bearer' : a.scheme === 'basic' ? `Basic (user ${a.username ?? ''})` : `${a.header} header`;
}

function opView(o: OpSummary, p: LoadedPack): PackOperationView {
  const rec = p.state.tested && p.state.tested.hash === p.hash ? p.state.tested.ops[o.name] : undefined;
  return {
    name: o.name, declared: o.declared, effective: o.effective,
    does: o.mcp ? `MCP ${o.mcp.server} / ${o.mcp.tool}` : `${o.method ?? '?'} ${o.url ?? ''}`.trim(),
    contract: rec ? (rec.ok ? 'passed' : 'failed') : 'untested',
    ...(rec && !rec.ok && rec.detail ? { detail: rec.detail } : {}),
    ...(o.readOnlyPost ? { readOnlyPost: true } : {}),
  };
}

export function packView(p: LoadedPack): ConnectorPackView {
  const m = p.report.manifest;
  const tested = p.state.tested && p.state.tested.hash === p.hash ? p.state.tested : undefined;
  const policy = packsPolicy(p.id, m?.hosts ?? []);
  const operations = p.report.ops.map(o => opView(o, p));
  return {
    id: p.id, label: m?.label ?? p.id, provider: m?.provider ?? '', baseUrl: m?.baseUrl ?? '', hosts: m?.hosts ?? [],
    auth: authWords(p), ...(m?.auth.help ? { authHelp: m.auth.help } : {}), mcpServers: m?.mcpServers ?? [],
    status: p.status, statusDetail: p.statusDetail, hash: p.hash,
    errors: p.report.errors.slice(0, 20), warnings: p.report.warnings.slice(0, 20),
    operations,
    can: operations.filter(o => o.contract === 'passed' && PHRASE[o.name]).map(o => PHRASE[o.name]!),
    ...(tested ? { testedAt: tested.at } : {}), ...(p.state.enabled ? { enabledAt: p.state.enabled.at } : {}),
    connections: ConnStore.listConnections().filter(c => c.pack === p.id).map(c => c.id),
    ...(policy.ok ? {} : { blockedByPolicy: policy.message }),
  };
}

export function listPacks(): ConnectorPackView[] {
  const out: ConnectorPackView[] = [];
  for (const id of listPackIds()) { const p = loadPack(id); if (p) out.push(packView(p)); }
  return out;
}

export function getPackView(id: string): ConnectorPackView {
  const p = loadPack(id);
  if (!p) throw new PackError(`No pack "${id}".`, 'not-found');
  return packView(p);
}

// ── draft ──────────────────────────────────────────────────────────────────

const asText = (v: unknown): string => (typeof v === 'string' ? v : `${JSON.stringify(v, null, 2)}\n`);

export interface DraftInput {
  connector?: unknown;
  tools?: Record<string, unknown>;
  fixtures?: Record<string, unknown>;
}

/** Files from a folder laid out as a pack (connector.json, tools/, fixtures/). Regular files only, bounded. */
export function readFolder(dir: string): Record<string, string> {
  const files: Record<string, string> = {};
  const take = (rel: string, abs: string, max: number): void => {
    let st: fs.Stats;
    try { st = fs.lstatSync(abs); } catch { return; }
    if (!st.isFile() || st.isSymbolicLink()) return;
    if (st.size > max) throw new PackError(`${rel} is ${st.size} bytes; the limit is ${max}.`);
    files[rel] = fs.readFileSync(abs, 'utf8');
  };
  take('connector.json', path.join(dir, 'connector.json'), MAX_CONNECTOR_BYTES);
  for (const [sub, max, suffix] of [['tools', MAX_TOOL_BYTES, '.tool.json'], ['fixtures', MAX_FIXTURE_BYTES, '.json']] as const) {
    let names: string[] = [];
    try { names = fs.readdirSync(path.join(dir, sub)); } catch { continue; }
    for (const n of names.sort()) if (n.endsWith(suffix)) take(`${sub}/${n}`, path.join(dir, sub, n), max);
  }
  return files;
}

export interface DraftResult { view: ConnectorPackView; replacedApproval: boolean }

/** Write a draft (from inline objects or a folder's files). Validation errors do not block saving: they come back. */
export function draftPack(id: string, input: { inline?: DraftInput; files?: Record<string, string> }): DraftResult {
  requireAllowed(id);
  const files: Record<string, string> = { ...(input.files ?? {}) };
  if (input.inline) {
    if (input.inline.connector !== undefined) files['connector.json'] = asText(input.inline.connector);
    for (const [n, def] of Object.entries(input.inline.tools ?? {})) files[`tools/${n.replace(/\.tool\.json$/, '')}.tool.json`] = asText(def);
    for (const [n, fx] of Object.entries(input.inline.fixtures ?? {})) files[`fixtures/${n.replace(/\.json$/, '')}.json`] = asText(fx);
  }
  if (!files['connector.json']) throw new PackError('A draft needs connector.json.');
  const before = loadPack(id);
  const wasEnabled = before?.status === 'enabled';
  writeDraft(id, files);
  auditConnection({ action: 'pack.draft', connection: '-', provider: 'custom', ref: id, detail: `${Object.keys(files).length} files` });
  const p = loadPack(id)!;
  return { view: packView(p), replacedApproval: Boolean(wasEnabled && p.status !== 'enabled') };
}

export function validatePackNow(id: string): ConnectorPackView {
  const p = loadPack(id);
  if (!p) throw new PackError(`No pack "${id}".`, 'not-found');
  return packView(p);
}

// ── test, enable, disable ─────────────────────────────────────────────────

export async function testPack(id: string): Promise<{ report: ContractReport; view: ConnectorPackView }> {
  const p = loadPack(id);
  if (!p) throw new PackError(`No pack "${id}".`, 'not-found');
  requireAllowed(id, p.report.manifest?.hosts ?? []);
  const report = await runContract(id);
  auditConnection({ action: 'pack.test', connection: '-', provider: 'custom', ref: id, detail: `${Object.values(report.ops).filter(o => o.ok).length}/${Object.keys(report.ops).length} operations passed` });
  return { report, view: getPackView(id) };
}

/**
 * Enable a pack: a PERSON's act, for the content hash they were shown. Not reachable from the tool.
 * Returns the new view. Throws PackError('stale' | 'not-tested' | 'invalid' | 'policy').
 */
export function enablePack(id: string, hash: string): ConnectorPackView {
  const cur = loadPack(id);
  if (!cur) throw new PackError(`No pack "${id}".`, 'not-found');
  requireAllowed(id, cur.report.manifest?.hosts ?? []);
  const p = setEnabled(id, hash);
  auditConnection({ action: 'pack.enable', connection: '-', provider: 'custom', ref: `${id}@${hash.slice(0, 12)}`, detail: `hosts ${p.report.manifest?.hosts.join(',') ?? ''}` });
  return packView(p);
}

export function disablePack(id: string): ConnectorPackView {
  if (!loadPack(id)) throw new PackError(`No pack "${id}".`, 'not-found');
  clearEnabled(id);
  auditConnection({ action: 'pack.disable', connection: '-', provider: 'custom', ref: id });
  return getPackView(id);
}

// ── connect ────────────────────────────────────────────────────────────────

/**
 * Make a connection record for an enabled pack: the hosts are the pack's, as approved. It does
 * nothing until a person pastes a token (the same Connections flow as any provider).
 */
export function connectPack(id: string, opts: { by: 'person' | 'agent'; insecureHttp?: boolean; label?: string }): StoredConnection {
  const p = loadPack(id);
  if (!p) throw new PackError(`No pack "${id}".`, 'not-found');
  const m = p.report.manifest;
  if (p.status !== 'enabled' || !m) throw new PackError(`The connector "${id}" is not enabled. A person enables it after its tests pass.`, 'not-enabled');
  requireAllowed(id, m.hosts);
  const base = new URL(m.baseUrl);
  const plain = base.protocol === 'http:';
  if (plain && !(opts.by === 'person' && opts.insecureHttp === true && isPrivateHost(base.hostname))) {
    throw new PackError('This connector uses plain http. Only a person can allow that, and only for a private or loopback address.');
  }
  const idv = ConnStore.newConnectionId('custom', id);
  const stored: StoredConnection = {
    id: idv, provider: 'custom', pack: id, label: (opts.label?.trim() || m.label).slice(0, 60),
    baseUrl: m.baseUrl, hosts: [...m.hosts], ...(plain ? { insecureHttp: true } : {}),
    createdAt: new Date().toISOString(), createdBy: opts.by,
  };
  ConnStore.putConnection(stored);
  auditConnection({ action: 'create', connection: idv, provider: 'custom', target: m.baseUrl, detail: `pack ${id} by ${opts.by}` });
  return stored;
}

export function describeForAgent(v: ConnectorPackView): string {
  const lines = [`${v.id}  "${v.label}" (${v.provider})  [${v.status}]  hash ${v.hash.slice(0, 12)}`, v.statusDetail, `Hosts: ${v.hosts.join(', ') || '(none)'}  Auth: ${v.auth || '(invalid)'}`];
  for (const e of v.errors) lines.push(`ERROR: ${e}`);
  for (const w of v.warnings) lines.push(`warning: ${w}`);
  for (const o of v.operations) lines.push(`  ${o.name}: ${o.effective}${o.declared !== o.effective ? ` (declared ${o.declared})` : ''}  ${o.does}  contract: ${o.contract}${o.detail ? ` - ${o.detail}` : ''}`);
  if (v.blockedByPolicy) lines.push(`Policy: ${v.blockedByPolicy}`);
  return lines.join('\n');
}

export { OP_NAMES, packDir };
