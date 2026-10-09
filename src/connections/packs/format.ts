/**
 * The connector pack format (ADR 0039 section 3, "dynamic connectors"): what an agent may write to
 * teach AICO a platform it has no built-in adapter for, and the rules that make that data safe to
 * run. Pure: no I/O, no network, no imports from the tool graph, so every rule is a table in
 * scripts/connector-packs-test.mjs.
 *
 * A pack is DATA plus tools that already have a trust model, never engine code:
 *
 *   connector.json          provider name, base URL and host allow-list, auth scheme, capability hints,
 *                           and one entry per operation: which tool runs it, what the author CLAIMS its
 *                           effect is, how adapter inputs become tool arguments, and how the response
 *                           becomes the normalised shapes (JSON pointers only, no expressions)
 *   tools/<name>.tool.json  ADR 0009 definitions, `http` runner only (a pack never runs a command)
 *   fixtures/<op>.json      recorded request/response pairs the contract test replays on loopback
 *
 * The rules, each a failure it prevents:
 *
 *  - **No expressions.** A field map is a JSON pointer or a constant. A template language is a
 *    code-execution surface; a pointer cannot do anything but read.
 *  - **Hosts are a closed list, fixed by the file.** Every tool URL's host must be in `hosts`, the
 *    base URL's host must be too, and there are no wildcards. The runner checks the RENDERED host
 *    again on every request (a placeholder in a path cannot change it, and validation forbids one
 *    in the host).
 *  - **No credential in the pack.** Nothing may look like a secret and `{{secret:...}}` is refused:
 *    the credential is the connection's own vault record, origin-bound to these hosts, applied by
 *    the transport. The auth scheme only says WHERE it goes (bearer, basic, one header); never a
 *    query parameter, because URLs are logged.
 *  - **The effect class is the stricter of what the author declared and what the operation is.**
 *    Whatever the file says, `*.create|update|transition|comment` are at least `external`,
 *    `pulls.merge` and anything with `merge` or `delete` in its name are `destructive`, and the
 *    tool's HTTP method counts too (DELETE is destructive; a read must be GET, or say
 *    `readOnlyPost` out loud, which the review card shows). The author's word is a claim (ADR 0009's
 *    honest limit), so it can raise the class and never lower it.
 *  - **Unknown is an error, not a guess.** An operation name, an adapter input, a field the shapes
 *    do not have, a placeholder naming nothing: all refused with the fix, so a typo cannot silently
 *    turn into an operation that returns nothing.
 *  - **One hash covers everything that runs.** connector.json, every tool and every fixture, so an
 *    edit to any of them is a different pack to the approval record (store.ts).
 *
 * What it does not do: read files, run requests, or decide who may enable a pack.
 *
 * @module connections/packs/format
 */

import crypto from 'node:crypto';
import { validateDefinition, type CustomToolDef } from '../../custom-tools/format.js';

export const PACK_FORMAT = 1;
export const PACK_ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;

export const MAX_CONNECTOR_BYTES = 64 * 1024;
export const MAX_TOOL_BYTES = 32 * 1024;
export const MAX_FIXTURE_BYTES = 256 * 1024;
export const MAX_FILES = 60;
export const MAX_PACK_BYTES = 4 * 1024 * 1024;

// ── effect classes ─────────────────────────────────────────────────────────

export type PackEffect = 'read' | 'external' | 'destructive';
const RANK: Record<PackEffect, number> = { read: 0, external: 1, destructive: 2 };

export function stricter(...effects: Array<PackEffect | undefined>): PackEffect {
  let out: PackEffect = 'read';
  for (const e of effects) if (e && RANK[e] > RANK[out]) out = e;
  return out;
}

/** An author's word, in ADR 0009's vocabulary, as a pack class: `write` and `exec` are at least external. */
export function normaliseEffect(e: unknown): PackEffect | undefined {
  if (e === 'read') return 'read';
  if (e === 'external' || e === 'write' || e === 'exec') return 'external';
  if (e === 'destructive') return 'destructive';
  return undefined;
}

/** What an operation IS, from its name alone: the adapter's own mapping, which a file cannot change. */
export function mappedEffect(op: string): PackEffect {
  if (/(^|\.)(merge|delete|remove|close|decline|abandon)/i.test(op) || /merge|delete/i.test(op)) return 'destructive';
  if (/\.(create|update|transition|comment|assign|addLabels|removeLabel)$/.test(op)) return 'external';
  return 'read';
}

export function methodEffect(method: string): PackEffect {
  const m = method.toUpperCase();
  if (m === 'GET' || m === 'HEAD') return 'read';
  if (m === 'DELETE') return 'destructive';
  return 'external';
}

// ── the operations an adapter can ask a pack for ───────────────────────────

export type OpKind = 'object' | 'maybe' | 'list' | 'none';

export interface OpDef {
  /** The adapter's inputs: the only names an `args` template may reference. */
  inputs: readonly string[];
  kind: OpKind;
  /** The normalised fields a `result.map` may fill. */
  fields: readonly string[];
  /** Fields a `result.map` must fill. */
  required: readonly string[];
}

const PULL_FIELDS = ['id', 'url', 'state', 'draft', 'headSha', 'mergeable', 'canMerge', 'mergeBlockers', 'approved', 'changesRequested', 'requiredApprovals', 'mergedSha'] as const;
const ITEM_FIELDS = ['id', 'number', 'title', 'body', 'state', 'labels', 'assignees', 'author', 'url', 'rev', 'points'] as const;
const COMMENT_FIELDS = ['id', 'author', 'association', 'body', 'at', 'review', 'url'] as const;
const CHECK_FIELDS = ['name', 'state', 'url', 'summary'] as const;

export const OPS = {
  'probe': { inputs: [], kind: 'object', fields: ['user', 'version'], required: ['user'] },
  'repos.get': { inputs: ['owner', 'name'], kind: 'object', fields: ['defaultBranch', 'cloneUrl', 'htmlUrl', 'private', 'id'], required: ['defaultBranch'] },
  'pulls.find': { inputs: ['owner', 'name', 'head'], kind: 'maybe', fields: PULL_FIELDS, required: ['id', 'state'] },
  'pulls.create': { inputs: ['owner', 'name', 'head', 'base', 'title', 'body', 'draft'], kind: 'object', fields: PULL_FIELDS, required: ['id', 'state'] },
  'pulls.get': { inputs: ['owner', 'name', 'id'], kind: 'object', fields: PULL_FIELDS, required: ['id', 'state'] },
  'pulls.comment': { inputs: ['owner', 'name', 'id', 'body'], kind: 'none', fields: [], required: [] },
  'pulls.comments': { inputs: ['owner', 'name', 'id'], kind: 'list', fields: COMMENT_FIELDS, required: ['id', 'body'] },
  'pulls.merge': { inputs: ['owner', 'name', 'id', 'method', 'sha'], kind: 'object', fields: ['sha'], required: [] },
  'items.query': { inputs: ['owner', 'name', 'source', 'value', 'since', 'me', 'state'], kind: 'list', fields: ITEM_FIELDS, required: ['id', 'title', 'state'] },
  'items.get': { inputs: ['owner', 'name', 'id'], kind: 'object', fields: ITEM_FIELDS, required: ['id', 'title', 'state'] },
  'items.create': { inputs: ['owner', 'name', 'title', 'body', 'labels'], kind: 'object', fields: ITEM_FIELDS, required: ['id', 'title', 'state'] },
  'items.update': { inputs: ['owner', 'name', 'id', 'title', 'body', 'ifRev'], kind: 'object', fields: ITEM_FIELDS, required: ['id', 'title', 'state'] },
  'items.transition': { inputs: ['owner', 'name', 'id', 'to', 'ifRev'], kind: 'object', fields: ITEM_FIELDS, required: ['id', 'title', 'state'] },
  'items.comment': { inputs: ['owner', 'name', 'id', 'body'], kind: 'none', fields: [], required: [] },
  'checks.forCommit': { inputs: ['owner', 'name', 'sha'], kind: 'list', fields: CHECK_FIELDS, required: ['name', 'state'] },
} as const satisfies Record<string, OpDef>;

export type OpName = keyof typeof OPS;
export const OP_NAMES = Object.keys(OPS) as OpName[];
export const isOpName = (s: string): s is OpName => Object.prototype.hasOwnProperty.call(OPS, s);

/** Operations that only read: they must be GET/HEAD (or say `readOnlyPost`). */
export const isReadRole = (op: string): boolean => mappedEffect(op) === 'read';

// ── the manifest ───────────────────────────────────────────────────────────

export type FieldSpec = string | { const: string | number | boolean };

export interface ValueMap { map: Record<string, string>; default?: string }

export interface ResultSpec {
  /** For list operations: the pointer to the array in the response. */
  list?: string;
  map?: Record<string, FieldSpec>;
  values?: Record<string, ValueMap>;
  /** `pulls.get` only: where the pull request's checks are, mapped like a list of checks. */
  checks?: ResultSpec;
}

export interface Pagination {
  style: 'link' | 'cursor' | 'page';
  /** cursor: pointer to the next cursor in the body; page: unused. */
  cursorPath?: string;
  /** The query parameter that carries the cursor or the page number. */
  param?: string;
  maxPages?: number;
}

export interface PackOperation {
  tool?: string;
  mcp?: { server: string; tool: string };
  /** The author's claim; the effective class is the stricter of this, the operation and the HTTP method. */
  effect: string;
  args?: Record<string, unknown>;
  result?: ResultSpec;
  pagination?: Pagination;
  /** A read that has to be a POST (a search, a GraphQL query). Shown on the review card. */
  readOnlyPost?: boolean;
}

export interface PackAuth {
  scheme: 'bearer' | 'basic' | 'header';
  header?: string;
  /** basic: the account name that goes with the token. */
  username?: string;
  /** Words for the token form: where a person creates the token. */
  help?: string;
}

export interface ConnectorManifest {
  format: 1;
  id: string;
  label: string;
  provider: string;
  baseUrl: string;
  hosts: string[];
  auth: PackAuth;
  mcpServers?: string[];
  capabilities?: { pulls?: { draft?: boolean; bodyMax?: number }; items?: { estimate?: 'field' | 'label' | 'none' } };
  operations: Record<string, PackOperation>;
}

// ── JSON pointers ──────────────────────────────────────────────────────────

const POINTER_RE = /^(?:\/(?:[^/~]|~[01])*)*$/;
export const isPointer = (s: unknown): s is string => typeof s === 'string' && POINTER_RE.test(s) && s.length <= 200;

/** RFC 6901 read. Never throws; undefined when the path is not there. `""` is the whole document. */
export function readPointer(doc: unknown, pointer: string): unknown {
  if (pointer === '') return doc;
  let cur: unknown = doc;
  for (const raw of pointer.slice(1).split('/')) {
    const key = raw.replace(/~1/g, '/').replace(/~0/g, '~');
    if (Array.isArray(cur)) {
      if (!/^(0|[1-9]\d{0,8})$/.test(key)) return undefined;
      cur = cur[Number(key)];
    } else if (cur && typeof cur === 'object') {
      if (!Object.prototype.hasOwnProperty.call(cur, key) || key === '__proto__') return undefined;
      cur = (cur as Record<string, unknown>)[key];
    } else return undefined;
  }
  return cur;
}

// ── validation ─────────────────────────────────────────────────────────────

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const HOST_RE = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*(?::\d{1,5})?$/;
const HEADER_RE = /^[A-Za-z][A-Za-z0-9-]{0,63}$/;
const RESERVED_HEADERS = new Set(['host', 'content-length', 'content-type', 'transfer-encoding', 'connection', 'cookie', 'set-cookie', 'proxy-authorization', 'authorization', 'accept']);
const WHOLE = /^\{([A-Za-z_][A-Za-z0-9_]*)\}$/;
const ANY = /\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
const MCP_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const SECRETISH = /\{\{\s*secret|(?:api[_-]?key|token|secret|password|passwd|authorization)["']?\s*[:=]\s*["'][A-Za-z0-9_\-./+=]{16,}["']|\bBearer\s+[A-Za-z0-9_\-./+=]{20,}|\b(?:ghp|gho|github_pat|glpat|xox[abp]|sk-live|sk_live|AKIA)[A-Za-z0-9_-]{12,}/i;

export interface PackFile { path: string; text: string }

export interface PackFiles {
  /** Every file by pack-relative path (`connector.json`, `tools/x.tool.json`, `fixtures/y.json`). */
  files: Record<string, string>;
}

export interface OpSummary {
  name: string;
  tool?: string;
  mcp?: { server: string; tool: string };
  declared: PackEffect;
  mapped: PackEffect;
  /** The HTTP method of the tool, when it has one. */
  method?: string;
  url?: string;
  effective: PackEffect;
  readOnlyPost: boolean;
}

export interface FixtureCase {
  name: string;
  input: Record<string, unknown>;
  request?: { method: string; path: string; query?: Record<string, string>; bodyIncludes?: string };
  response: { status: number; headers?: Record<string, string>; body?: unknown; text?: string };
  expect?: unknown;
}
export interface FixtureFile { operation: string; cases: FixtureCase[] }

export interface PackReport {
  manifest?: ConnectorManifest;
  tools: Map<string, CustomToolDef>;
  fixtures: Map<string, FixtureFile>;
  ops: OpSummary[];
  errors: string[];
  warnings: string[];
}

function fileEntries(files: Record<string, string>, dir: string, suffix: string): Array<[string, string]> {
  return Object.entries(files).filter(([p]) => p.startsWith(`${dir}/`) && p.endsWith(suffix) && !p.slice(dir.length + 1).includes('/')).sort(([a], [b]) => a.localeCompare(b));
}

/** Check a value is one of the pointer-or-constant field specs. */
function checkField(spec: unknown, where: string, errors: string[]): void {
  if (typeof spec === 'string') { if (!isPointer(spec)) errors.push(`${where}: "${String(spec).slice(0, 60)}" is not a JSON pointer (like /data/title). Expressions are not supported.`); return; }
  if (isRecord(spec) && Object.keys(spec).length === 1 && 'const' in spec && ['string', 'number', 'boolean'].includes(typeof spec.const)) return;
  errors.push(`${where}: a field is a JSON pointer string or {"const": value}.`);
}

function checkResult(op: string, def: (typeof OPS)[OpName], r: unknown, errors: string[], nested = false): void {
  const where = `operations.${op}.result`;
  if (r === undefined) {
    if (def.kind !== 'none') errors.push(`${where} is missing: say how the response becomes ${def.fields.join(', ')}.`);
    return;
  }
  if (!isRecord(r)) { errors.push(`${where} must be an object.`); return; }
  for (const k of Object.keys(r)) if (!['list', 'map', 'values', 'checks'].includes(k)) errors.push(`${where}: unknown key "${k}".`);
  if (def.kind === 'list' || nested) {
    if (!isPointer(r.list)) errors.push(`${where}.list must be a JSON pointer to the array in the response ("" if the response is the array).`);
  } else if (def.kind === 'maybe') {
    if (r.list !== undefined && !isPointer(r.list)) errors.push(`${where}.list must be a JSON pointer to the array whose first element is the result.`);
  } else if (r.list !== undefined) errors.push(`${where}.list is for list operations only.`);
  const map = r.map;
  if (!isRecord(map)) {
    if (def.kind !== 'none') errors.push(`${where}.map must be an object of field: pointer.`);
  } else {
    for (const [field, spec] of Object.entries(map)) {
      if (!(def.fields as readonly string[]).includes(field)) errors.push(`${where}.map: "${field}" is not a field of ${op} (it has: ${def.fields.join(', ')}).`);
      checkField(spec, `${where}.map.${field}`, errors);
    }
    for (const need of def.required) if (!(need in map)) errors.push(`${where}.map must fill "${need}".`);
  }
  if (r.values !== undefined) {
    if (!isRecord(r.values)) errors.push(`${where}.values must be an object of field: {map, default?}.`);
    else for (const [field, vm] of Object.entries(r.values)) {
      if (!isRecord(vm) || !isRecord(vm.map) || Object.values(vm.map).some(v => typeof v !== 'string')) errors.push(`${where}.values.${field} must be {"map": {"RAW": "normalised"}, "default"?: "..."}.`);
      else if (vm.default !== undefined && typeof vm.default !== 'string') errors.push(`${where}.values.${field}.default must be a string.`);
    }
  }
  if (r.checks !== undefined) {
    if (op !== 'pulls.get') errors.push(`${where}.checks is for pulls.get only.`);
    else checkResult(`${op}.checks`, OPS['checks.forCommit'], r.checks, errors, true);
  }
}

function checkPagination(op: string, p: unknown, errors: string[]): void {
  if (p === undefined) return;
  const where = `operations.${op}.pagination`;
  if (OPS[op as OpName]?.kind !== 'list') { errors.push(`${where} is for list operations only.`); return; }
  if (!isRecord(p) || !['link', 'cursor', 'page'].includes(String(p.style))) { errors.push(`${where}.style must be link, cursor or page.`); return; }
  if (p.style === 'cursor' && (!isPointer(p.cursorPath) || typeof p.param !== 'string')) errors.push(`${where}: a cursor style needs cursorPath (a JSON pointer) and param (the query parameter).`);
  if (p.style === 'page' && typeof p.param !== 'string') errors.push(`${where}: a page style needs param (the query parameter, like "page").`);
  if (typeof p.param === 'string' && !/^[A-Za-z0-9_.~-]{1,64}$/.test(p.param)) errors.push(`${where}.param is not a usable query parameter name.`);
  if (p.maxPages !== undefined && (!Number.isInteger(p.maxPages) || (p.maxPages as number) < 1 || (p.maxPages as number) > 10)) errors.push(`${where}.maxPages must be a whole number from 1 to 10.`);
}

/** Validate a whole pack. Never throws. */
export function validatePack(id: string, files: Record<string, string>): PackReport {
  const errors: string[] = [];
  const warnings: string[] = [];
  const tools = new Map<string, CustomToolDef>();
  const fixtures = new Map<string, FixtureFile>();
  const ops: OpSummary[] = [];
  const done = (manifest?: ConnectorManifest): PackReport => ({ ...(manifest ? { manifest } : {}), tools, fixtures, ops, errors, warnings });

  if (!PACK_ID_RE.test(id)) { errors.push(`The pack id "${id.slice(0, 50)}" must be lower-case letters, digits and - (1-40, starting with a letter or digit).`); return done(); }
  const names = Object.keys(files);
  if (names.length > MAX_FILES) errors.push(`A pack has at most ${MAX_FILES} files; this one has ${names.length}.`);
  const total = Object.values(files).reduce((n, t) => n + t.length, 0);
  if (total > MAX_PACK_BYTES) errors.push(`The pack is ${(total / 1024 / 1024).toFixed(1)} MB; the limit is ${MAX_PACK_BYTES / 1024 / 1024} MB.`);
  for (const [p, text] of Object.entries(files)) {
    if (SECRETISH.test(text)) errors.push(`${p} looks like it contains a credential. A pack never holds one: the token is stored by a person on the Connections page and applied by AICO.`);
  }
  for (const p of names) {
    if (p !== 'connector.json' && !/^tools\/[a-z][a-z0-9_]{0,63}\.tool\.json$/.test(p) && !/^fixtures\/[A-Za-z0-9][A-Za-z0-9._-]{0,63}\.json$/.test(p)) {
      warnings.push(`${p} is not part of the pack format and is ignored (and not hashed).`);
    }
  }

  const rawConnector = files['connector.json'];
  if (rawConnector === undefined) { errors.push('connector.json is missing.'); return done(); }
  if (rawConnector.length > MAX_CONNECTOR_BYTES) { errors.push(`connector.json is ${rawConnector.length} bytes; the limit is ${MAX_CONNECTOR_BYTES}.`); return done(); }
  let raw: unknown;
  try { raw = JSON.parse(rawConnector); } catch (e) { errors.push(`connector.json is not valid JSON: ${(e as Error).message}`); return done(); }
  if (!isRecord(raw)) { errors.push('connector.json must be a JSON object.'); return done(); }
  for (const k of Object.keys(raw)) {
    if (!['format', 'id', 'label', 'provider', 'baseUrl', 'hosts', 'auth', 'mcpServers', 'capabilities', 'operations'].includes(k)) warnings.push(`connector.json: "${k}" is not part of the format and is ignored.`);
  }

  if (raw.format !== PACK_FORMAT) errors.push(`connector.json: "format" must be ${PACK_FORMAT}.`);
  if (raw.id !== id) errors.push(`connector.json: "id" must be "${id}" (the pack's folder name).`);
  const label = raw.label;
  if (typeof label !== 'string' || !label.trim() || label.length > 60) errors.push('connector.json: "label" is required (up to 60 characters): the name a person sees.');
  const provider = raw.provider;
  if (typeof provider !== 'string' || !provider.trim() || provider.length > 60) errors.push('connector.json: "provider" is required (up to 60 characters): the platform\'s name.');

  // ── base URL and hosts ──
  let baseHost = '';
  let baseIsHttp = false;
  if (typeof raw.baseUrl !== 'string') errors.push('connector.json: "baseUrl" is required, like https://api.example.com.');
  else {
    try {
      const u = new URL(raw.baseUrl);
      baseHost = u.host.toLowerCase();
      baseIsHttp = u.protocol === 'http:';
      if (u.protocol !== 'https:' && u.protocol !== 'http:') errors.push('connector.json: "baseUrl" must be https.');
      if (u.username || u.password || u.search || u.hash) errors.push('connector.json: "baseUrl" must have no credentials, query or fragment.');
      if (baseIsHttp) warnings.push('"baseUrl" is plain http: it works only for a private or loopback address a person opts into when connecting.');
    } catch { errors.push('connector.json: "baseUrl" is not a valid URL.'); }
  }
  const hosts: string[] = [];
  if (!Array.isArray(raw.hosts) || raw.hosts.length === 0) errors.push('connector.json: "hosts" is required: the closed list of hosts this connector may contact, like ["api.example.com"].');
  else {
    if (raw.hosts.length > 6) errors.push('connector.json: "hosts" lists at most 6 hosts.');
    for (const h of raw.hosts) {
      if (typeof h !== 'string' || !HOST_RE.test(h) || h.includes('*')) errors.push(`connector.json: host ${JSON.stringify(h)} must be a plain host name (optionally :port), lower-case, no scheme, path or wildcard.`);
      else hosts.push(h);
    }
    if (baseHost && !hosts.includes(baseHost)) errors.push(`connector.json: the base URL's host ${baseHost} must be one of "hosts".`);
  }

  // ── auth ──
  let auth: PackAuth | undefined;
  if (!isRecord(raw.auth)) errors.push('connector.json: "auth" is required: {"scheme": "bearer"}, {"scheme":"basic","username":"..."} or {"scheme":"header","header":"X-Api-Key"}.');
  else {
    const a = raw.auth;
    for (const k of Object.keys(a)) if (!['scheme', 'header', 'username', 'help'].includes(k)) warnings.push(`connector.json: auth."${k}" is ignored.`);
    if (a.scheme !== 'bearer' && a.scheme !== 'basic' && a.scheme !== 'header') {
      errors.push('connector.json: auth.scheme must be bearer, basic or header. A token is never sent in a query parameter (URLs are logged).');
    } else {
      if (a.scheme === 'header' && (typeof a.header !== 'string' || !HEADER_RE.test(a.header) || RESERVED_HEADERS.has(a.header.toLowerCase()))) errors.push('connector.json: auth.header must be a header name like X-Api-Key (not Authorization, Host, Cookie ...).');
      if (a.scheme === 'basic' && (typeof a.username !== 'string' || !a.username.trim() || /[:\s]/.test(a.username))) errors.push('connector.json: auth.username is required for basic auth, a single word without a colon.');
      if (a.help !== undefined && (typeof a.help !== 'string' || a.help.length > 300)) errors.push('connector.json: auth.help is up to 300 characters of plain words for the token form.');
      auth = a as unknown as PackAuth;
    }
  }

  // ── capabilities hints ──
  if (raw.capabilities !== undefined) {
    const c = raw.capabilities;
    if (!isRecord(c)) errors.push('connector.json: "capabilities" must be an object.');
    else {
      const p = c.pulls; const i = c.items;
      if (p !== undefined && (!isRecord(p) || (p.draft !== undefined && typeof p.draft !== 'boolean') || (p.bodyMax !== undefined && (!Number.isInteger(p.bodyMax) || (p.bodyMax as number) < 500 || (p.bodyMax as number) > 1_000_000)))) errors.push('connector.json: capabilities.pulls is {draft?: boolean, bodyMax?: 500..1000000}.');
      if (i !== undefined && (!isRecord(i) || (i.estimate !== undefined && !['field', 'label', 'none'].includes(String(i.estimate))))) errors.push('connector.json: capabilities.items is {estimate?: "field"|"label"|"none"}. Everything else is derived from the operations that pass their contract.');
    }
  }
  const mcpServers: string[] = [];
  if (raw.mcpServers !== undefined) {
    if (!Array.isArray(raw.mcpServers) || raw.mcpServers.some(s => typeof s !== 'string' || !MCP_NAME_RE.test(s))) errors.push('connector.json: "mcpServers" is a list of MCP server names already configured in AICO.');
    else mcpServers.push(...(raw.mcpServers as string[]));
  }

  // ── tools ──
  for (const [p, text] of fileEntries(files, 'tools', '.tool.json')) {
    const base = p.slice('tools/'.length, -'.tool.json'.length);
    if (text.length > MAX_TOOL_BYTES) { errors.push(`${p} is ${text.length} bytes; the limit is ${MAX_TOOL_BYTES}.`); continue; }
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch (e) { errors.push(`${p} is not valid JSON: ${(e as Error).message}`); continue; }
    const rep = validateDefinition(parsed, { reserved: new Set<string>() });
    for (const e of rep.errors) errors.push(`${p}: ${e}`);
    if (!rep.def) continue;
    const d = rep.def;
    if (d.name !== base) { errors.push(`${p}: the tool is named "${d.name}"; the file must be tools/${d.name}.tool.json.`); continue; }
    if (!d.http) { errors.push(`${p}: a connector tool is an "http" tool; a pack never runs a command.`); continue; }
    if (d.run) { errors.push(`${p}: a connector tool cannot have "run".`); continue; }
    if (/\{\{/.test(text)) { errors.push(`${p}: no {{secret:...}} references in a connector tool. The credential is the connection's own, applied by AICO.`); continue; }
    let urlHost = '';
    try { urlHost = new URL(d.http.url.replace(ANY, 'x')).host.toLowerCase(); } catch { /* validateDefinition reported it */ }
    if (urlHost && hosts.length && !hosts.includes(urlHost)) errors.push(`${p}: the URL's host ${urlHost} is not in connector.json "hosts" (${hosts.join(', ')}).`);
    for (const [hk, hv] of Object.entries(d.http.headers ?? {})) {
      if (/[{}]/.test(hv)) errors.push(`${p}: header ${hk} must be a literal value (a placeholder in a header is an injection route).`);
      if (RESERVED_HEADERS.has(hk.toLowerCase()) && hk.toLowerCase() !== 'accept' && hk.toLowerCase() !== 'content-type') errors.push(`${p}: header ${hk} is set by AICO and cannot be set by a tool.`);
    }
    tools.set(d.name, d);
  }

  // ── operations ──
  const rawOps = raw.operations;
  if (!isRecord(rawOps) || Object.keys(rawOps).length === 0) errors.push('connector.json: "operations" is required, and must include "probe".');
  const manifestOps: Record<string, PackOperation> = {};
  if (isRecord(rawOps)) {
    if (!('probe' in rawOps)) errors.push('connector.json: operations.probe is required: a read that says who the token is (so a person can check it is the right account).');
    const usedTools = new Set<string>();
    for (const [name, rawOp] of Object.entries(rawOps)) {
      if (!isOpName(name)) { errors.push(`operations."${name}" is not an operation AICO can ask for. Choose from: ${OP_NAMES.join(', ')}.`); continue; }
      const def = OPS[name];
      const where = `operations.${name}`;
      if (!isRecord(rawOp)) { errors.push(`${where} must be an object.`); continue; }
      for (const k of Object.keys(rawOp)) if (!['tool', 'mcp', 'effect', 'args', 'result', 'pagination', 'readOnlyPost'].includes(k)) warnings.push(`${where}: "${k}" is ignored.`);
      const hasTool = rawOp.tool !== undefined; const hasMcp = rawOp.mcp !== undefined;
      if (hasTool === hasMcp) { errors.push(`${where}: give exactly one of "tool" (a tools/<name>.tool.json) or "mcp" ({server, tool}).`); continue; }
      const declared = normaliseEffect(rawOp.effect);
      if (!declared) { errors.push(`${where}.effect must be read, external or destructive: it decides when a person is asked.`); continue; }
      if (rawOp.readOnlyPost !== undefined && typeof rawOp.readOnlyPost !== 'boolean') errors.push(`${where}.readOnlyPost must be true or false.`);

      const toolName = hasTool ? rawOp.tool : undefined;
      let tool: CustomToolDef | undefined;
      let mcp: { server: string; tool: string } | undefined;
      if (hasTool) {
        if (typeof toolName !== 'string') { errors.push(`${where}.tool must be a tool name.`); continue; }
        tool = tools.get(toolName);
        if (!tool) { errors.push(`${where}.tool "${toolName}" has no valid tools/${toolName}.tool.json.`); continue; }
        usedTools.add(toolName);
      } else {
        const m = rawOp.mcp;
        if (!isRecord(m) || typeof m.server !== 'string' || typeof m.tool !== 'string' || !MCP_NAME_RE.test(m.server) || !MCP_NAME_RE.test(m.tool)) { errors.push(`${where}.mcp must be {"server": "<name>", "tool": "<name>"}.`); continue; }
        mcp = { server: m.server, tool: m.tool };
        if (!mcpServers.includes(m.server)) errors.push(`${where}: the MCP server "${m.server}" must be listed in connector.json "mcpServers" (a person sees that list when enabling).`);
      }

      // args: op input -> tool argument
      const args = rawOp.args;
      if (args !== undefined) {
        if (!isRecord(args)) errors.push(`${where}.args must be an object of toolArgument: value.`);
        else for (const [k, v] of Object.entries(args)) {
          if (tool && !(k in tool.input_schema.properties)) errors.push(`${where}.args."${k}" is not a parameter of tool ${tool.name} (it takes: ${Object.keys(tool.input_schema.properties).join(', ') || 'nothing'}).`);
          if (typeof v === 'string') {
            for (const m of v.matchAll(ANY)) if (!(def.inputs as readonly string[]).includes(m[1]!)) errors.push(`${where}.args."${k}": {${m[1]}} is not an input of ${name} (it has: ${def.inputs.join(', ') || 'nothing'}).`);
          } else if (!['number', 'boolean'].includes(typeof v) && v !== null) errors.push(`${where}.args."${k}" must be a string template, number or boolean.`);
        }
      }
      if (tool) {
        for (const need of tool.input_schema.required ?? []) {
          if (!args || !isRecord(args) || !(need in args)) errors.push(`${where}: tool ${tool.name} requires "${need}"; give it in "args" (a constant or an input like "{id}").`);
        }
      }

      checkResult(name, def, rawOp.result, errors);
      checkPagination(name, rawOp.pagination, errors);

      const method = tool?.http?.method.toUpperCase();
      const mapped = mappedEffect(name);
      const viaMethod = method ? methodEffect(method) : undefined;
      const readOnlyPost = rawOp.readOnlyPost === true;
      // A read role may be a GET, or a POST that says so; anything else would let a "read" write.
      const toolEffect = tool ? normaliseEffect(tool.effect) : undefined;
      let effective = stricter(declared, mapped, toolEffect, viaMethod === 'read' || (viaMethod === 'external' && readOnlyPost && mapped === 'read') ? undefined : viaMethod);
      if (mapped === 'read' && viaMethod === 'external' && !readOnlyPost) {
        errors.push(`${where}: ${name} is a read but tool ${tool?.name} uses ${method}. A read must be GET (or HEAD); a search that needs POST sets "readOnlyPost": true, which the person sees when enabling.`);
        effective = stricter(effective, 'external');
      }
      if (mapped === 'read' && viaMethod === 'destructive') errors.push(`${where}: ${name} is a read but tool ${tool?.name} uses DELETE.`);
      if (RANK[declared] < RANK[effective]) warnings.push(`${where}: declared "${rawOp.effect}" but ${name} is treated as ${effective} (${RANK[mapped] > RANK[declared] ? 'by what the operation is' : 'by the HTTP method'}).`);
      if (mcp && mapped === 'read' && declared !== 'read') warnings.push(`${where}: an MCP tool's effect cannot be seen, so the declared "${declared}" stands.`);

      ops.push({
        name, ...(toolName && typeof toolName === 'string' ? { tool: toolName } : {}), ...(mcp ? { mcp } : {}),
        declared, mapped, ...(method ? { method, url: tool!.http!.url } : {}), effective, readOnlyPost,
      });
      manifestOps[name] = rawOp as unknown as PackOperation;
    }
    for (const t of tools.keys()) if (!usedTools.has(t)) warnings.push(`tools/${t}.tool.json is not used by any operation.`);
  }

  // ── fixtures ──
  for (const [p, text] of fileEntries(files, 'fixtures', '.json')) {
    if (text.length > MAX_FIXTURE_BYTES) { errors.push(`${p} is ${text.length} bytes; the limit is ${MAX_FIXTURE_BYTES}.`); continue; }
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch (e) { errors.push(`${p} is not valid JSON: ${(e as Error).message}`); continue; }
    if (!isRecord(parsed) || typeof parsed.operation !== 'string' || !Array.isArray(parsed.cases) || parsed.cases.length === 0) { errors.push(`${p}: a fixture file is {"operation": "<name>", "cases": [ {name, input, request, response, expect} ]}.`); continue; }
    const opName = parsed.operation;
    if (!isOpName(opName)) { errors.push(`${p}: "${opName}" is not an operation.`); continue; }
    const cases: FixtureCase[] = [];
    parsed.cases.forEach((c, i) => {
      const w = `${p} case ${i + 1}`;
      if (!isRecord(c) || typeof c.name !== 'string' || !isRecord(c.input) || !isRecord(c.response) || !Number.isInteger(c.response.status)) { errors.push(`${w}: needs name, input (an object) and response {status, body}.`); return; }
      const opSpec = manifestOps[opName];
      if (opSpec && !opSpec.mcp) {
        const rq = c.request;
        if (!isRecord(rq) || typeof rq.method !== 'string' || typeof rq.path !== 'string' || !rq.path.startsWith('/')) { errors.push(`${w}: an http operation's case needs request {method, path} (path starts with /).`); return; }
      }
      const known = new Set<string>(OPS[opName].inputs);
      for (const k of Object.keys(c.input)) if (!known.has(k)) errors.push(`${w}: input "${k}" is not an input of ${opName}.`);
      cases.push(c as unknown as FixtureCase);
    });
    const prior = fixtures.get(opName);
    fixtures.set(opName, { operation: opName, cases: [...(prior?.cases ?? []), ...cases] });
  }
  for (const o of ops) if (!fixtures.has(o.name)) warnings.push(`operation ${o.name} has no fixture, so it cannot pass its contract and stays off.`);
  for (const f of fixtures.keys()) if (!ops.some(o => o.name === f)) warnings.push(`fixtures for ${f} are not used: the operation is not declared.`);

  if (errors.length || !auth || typeof raw.baseUrl !== 'string') return done();
  const manifest: ConnectorManifest = {
    format: 1, id, label: String(label).trim(), provider: String(provider).trim(), baseUrl: raw.baseUrl.replace(/\/+$/, ''),
    hosts, auth, ...(mcpServers.length ? { mcpServers } : {}),
    ...(isRecord(raw.capabilities) ? { capabilities: raw.capabilities as ConnectorManifest['capabilities'] } : {}),
    operations: manifestOps,
  };
  return done(manifest);
}

// ── the hash ───────────────────────────────────────────────────────────────

/**
 * One digest over everything that can run or be tested: connector.json (so the hosts, the auth
 * scheme and every mapping), each tool and each fixture, by path. Files outside the format do not
 * count (they are ignored by the runner too). A change to any byte is a different pack.
 */
export function packHash(files: Record<string, string>): string {
  const h = crypto.createHash('sha256');
  const counted = Object.keys(files)
    .filter(p => p === 'connector.json' || /^tools\/[a-z][a-z0-9_]{0,63}\.tool\.json$/.test(p) || /^fixtures\/[A-Za-z0-9][A-Za-z0-9._-]{0,63}\.json$/.test(p))
    .sort();
  for (const p of counted) {
    h.update(p); h.update('\0');
    h.update(crypto.createHash('sha256').update(files[p]!).digest('hex')); h.update('\n');
  }
  return h.digest('hex');
}

// ── mapping a response to the normalised shapes ───────────────────────────

export function mapField(doc: unknown, spec: FieldSpec | undefined): unknown {
  if (spec === undefined) return undefined;
  if (typeof spec === 'string') return readPointer(doc, spec);
  return spec.const;
}

/** A raw value through a field's value map: case-insensitive on the raw side; `default` when nothing matches. */
export function applyValueMap(raw: unknown, vm: ValueMap | undefined): unknown {
  if (!vm) return raw;
  const key = raw === undefined || raw === null ? '' : String(raw);
  for (const [k, v] of Object.entries(vm.map)) if (k.toLowerCase() === key.toLowerCase()) return v;
  // No default: hand the raw value on, so the normaliser can say "state is \"archived\"" instead of "state is missing".
  return vm.default !== undefined ? vm.default : raw;
}

/** One object of a result: every mapped field read from `doc` and passed through its value map. */
export function mapObject(doc: unknown, spec: ResultSpec): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [field, fs] of Object.entries(spec.map ?? {})) {
    const v = applyValueMap(mapField(doc, fs), spec.values?.[field]);
    if (v !== undefined && v !== null) out[field] = v;
  }
  return out;
}

/** Fill `{input}` placeholders in an op's `args`: a whole-value `{x}` keeps its type; embedded ones become text. */
export function renderArgs(args: Record<string, unknown> | undefined, input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args ?? {})) {
    if (typeof v !== 'string') { out[k] = v; continue; }
    const whole = WHOLE.exec(v)?.[1];
    if (whole !== undefined) { if (input[whole] !== undefined && input[whole] !== null) out[k] = input[whole]; continue; }
    out[k] = v.replace(ANY, (_m, f: string) => (input[f] === undefined || input[f] === null ? '' : String(input[f])));
  }
  return out;
}
