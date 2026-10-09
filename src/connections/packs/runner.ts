/**
 * Running one operation of an enabled connector pack through the engine's own transport.
 *
 * A pack operation is: adapter inputs -> tool arguments (`args` templates) -> an HTTP request
 * rendered from the ADR 0009 tool definition -> the shared `ConnectionClient` -> a JSON response
 * -> normalised fields (JSON pointers). The model never touches any step; it wrote the data that
 * drives them and a person approved that exact data.
 *
 * The checks that run on EVERY request, not once at enable time, each a failure it prevents:
 *
 *  - **Still approved.** `requireEnabled` re-reads the pack and compares its digest to the person's
 *    approval. An edit made since (by anyone) refuses the call with the fix. This is what "any edit
 *    disables it until re-approved" means in code.
 *  - **The rendered host is on the allow-list.** The tool's URL host is fixed by validation, but the
 *    check is repeated on the URL actually about to be sent, and again by the connection (its hosts
 *    are fixed by the first credential) and by the transport's origin-bound vault record. A path
 *    placeholder cannot change the host; `.` and `..` as values are refused so they cannot climb out
 *    of the path either.
 *  - **The class of the operation is enforced, not displayed.** A read-role operation may only send
 *    GET/HEAD (or the POST its author declared `readOnlyPost`); a destructive one (merge) refuses to
 *    run unless the caller says a person asked (`person`), which only the human-gated landing path
 *    does. The class is the stricter of the author's claim, the operation and the method (format.ts).
 *  - **Arguments are validated against the tool's own schema** (type, enum, pattern, bounds, no
 *    undeclared field). Not the command-injection rules of ADR 0009's `validateArgs`: a markdown
 *    body has newlines and backticks and goes into a JSON body or a URL-encoded segment, never a
 *    shell. Header values are literals, so a value cannot become a header.
 *  - **Bounded.** Pages are capped (`maxPages` <= 10), bodies by the transport's size limit,
 *    and every request by its deadline.
 *
 * MCP-backed operations call a tool of an MCP server the person already configured and listed in the
 * pack's `mcpServers`; the managed `mcp` policy governs the server. Their output goes through the
 * same field maps.
 *
 * What it does not do: decide what to sync or merge (sync.ts, landing.ts), or hold a credential
 * (the transport resolves it from the vault for the exact origin).
 *
 * @module connections/packs/runner
 */

import type { CustomToolDef, InputSchema } from '../../custom-tools/format.js';
import { renderHttp } from '../../custom-tools/format.js';
import { extensionDecision } from '../../policy/enforce.js';
import { parseAuth } from '../../tools/ops/http.js';
import { auditConnection } from '../audit.js';
import { ConnectionClient, ConnectionError, nextLink, type ConnResponse } from '../http.js';
import * as ConnStore from '../store.js';
import type { StoredConnection } from '../types.js';
import {
  OPS, isOpName, mapObject, readPointer, renderArgs, type ConnectorManifest, type OpName, type PackOperation, type ResultSpec,
} from './format.js';
import { requireEnabled, type LoadedPack, PackError } from './store.js';

export interface PackRunCtx {
  conn: StoredConnection;
  signal?: AbortSignal;
  project?: string;
  /** A person asked for this (the landing path's merge click). Required for a destructive operation. */
  person?: boolean;
  /** The contract test: send to this loopback origin with this fake token instead (see ClientOptions.contractSecret). */
  contract?: { origin: string; secret: string; mcpReply?: (op: string, args: Record<string, unknown>) => unknown };
  /** Use this pack instead of loading the enabled one (the contract test runs a not-yet-enabled pack). */
  pack?: LoadedPack;
}

export type PackResult = Record<string, unknown> | Array<Record<string, unknown>> | undefined;

// ── arguments ──────────────────────────────────────────────────────────────

/** Validate tool arguments for an HTTP call: declared fields, types, enum, pattern, bounds. */
export function validatePackArgs(schema: InputSchema, args: Record<string, unknown>): string[] {
  const problems: string[] = [];
  const props = schema.properties ?? {};
  for (const key of Object.keys(args)) if (!(key in props)) problems.push(`"${key}" is not a parameter of the tool.`);
  for (const r of schema.required ?? []) if (args[r] === undefined || args[r] === null) problems.push(`"${r}" is required.`);
  for (const [key, spec] of Object.entries(props)) {
    const v = args[key];
    if (v === undefined || v === null) continue;
    if (spec.type === 'boolean') { if (typeof v !== 'boolean') problems.push(`"${key}" must be true or false.`); continue; }
    if (spec.type === 'number' || spec.type === 'integer') {
      if (typeof v !== 'number' || !Number.isFinite(v) || (spec.type === 'integer' && !Number.isInteger(v))) { problems.push(`"${key}" must be ${spec.type === 'integer' ? 'a whole number' : 'a number'}.`); continue; }
      if (spec.minimum !== undefined && v < spec.minimum) problems.push(`"${key}" must be at least ${spec.minimum}.`);
      if (spec.maximum !== undefined && v > spec.maximum) problems.push(`"${key}" must be at most ${spec.maximum}.`);
      if (spec.enum && !spec.enum.includes(v)) problems.push(`"${key}" must be one of ${spec.enum.join(', ')}.`);
      continue;
    }
    if (typeof v !== 'string') { problems.push(`"${key}" must be a string.`); continue; }
    const max = spec.maxLength ?? 100_000;
    if (v.length > max) problems.push(`"${key}" is ${v.length} characters; the limit is ${max}.`);
    if (spec.minLength !== undefined && v.length < spec.minLength) problems.push(`"${key}" must be at least ${spec.minLength} characters.`);
    if (v === '.' || v === '..') problems.push(`"${key}" cannot be a dot segment.`);
    if (/[\u0000]/.test(v)) problems.push(`"${key}" contains a NUL character.`);
    if (spec.enum && !spec.enum.includes(v)) problems.push(`"${key}" must be one of ${spec.enum.join(', ')}.`);
    if (spec.pattern && !new RegExp(spec.pattern, 'u').test(v)) problems.push(`"${key}" does not match ${spec.pattern}.`);
  }
  return problems;
}

// ── pieces ─────────────────────────────────────────────────────────────────

function packAuth(m: ConnectorManifest, conn: StoredConnection): { auth: ReturnType<typeof parseAuth>; username?: string } {
  if (m.auth.scheme === 'bearer') return { auth: { kind: 'bearer' } };
  if (m.auth.scheme === 'basic') return { auth: { kind: 'basic' }, username: conn.username ?? m.auth.username ?? '' };
  return { auth: parseAuth(`header:${m.auth.header}`) };
}

function failureOf(res: ConnResponse, what: string, conn: StoredConnection): ConnectionError {
  const s = res.status;
  if (s === 404) return new ConnectionError(`${what} was not found, or the token cannot see it.`, 'not-found', 404);
  if (s === 403) return new ConnectionError(`${conn.label} refused ${what} (403): the token may lack permission.`, 'http', 403);
  if (s === 409 || s === 412) return new ConnectionError(`${what} conflicts with the current state on ${conn.label}.`, 'conflict', s);
  return new ConnectionError(`${conn.label} answered ${s} for ${what}.`, 'http', s);
}

function pageSpec(op: PackOperation): { style: 'link' | 'cursor' | 'page'; cursorPath?: string; param?: string; maxPages: number } | undefined {
  const p = op.pagination;
  return p ? { style: p.style, ...(p.cursorPath ? { cursorPath: p.cursorPath } : {}), ...(p.param ? { param: p.param } : {}), maxPages: Math.min(p.maxPages ?? 5, 10) } : undefined;
}

const toArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** A response document to the operation's result, by kind. Pure. */
export function shapeResult(name: OpName, spec: ResultSpec | undefined, doc: unknown): PackResult {
  const kind = OPS[name].kind;
  if (kind === 'none' || !spec) return undefined;
  if (kind === 'list') return toArray(readPointer(doc, spec.list ?? '')).map(item => mapObject(item, spec));
  if (kind === 'maybe') {
    const at = spec.list !== undefined ? readPointer(doc, spec.list) : doc;
    const first = Array.isArray(at) ? at[0] : at;
    if (first === undefined || first === null || (typeof first === 'object' && Object.keys(first as object).length === 0)) return undefined;
    return mapObject(first, spec);
  }
  const out = mapObject(doc, spec);
  if (spec.checks) {
    const checks = toArray(readPointer(doc, spec.checks.list ?? '')).map(item => mapObject(item, spec.checks!));
    (out as Record<string, unknown>).checks = checks;
  }
  return out;
}

function parseMcp(result: unknown): unknown {
  if (result && typeof result === 'object') {
    const r = result as Record<string, unknown>;
    if (r.structuredContent !== undefined) return r.structuredContent;
    const content = Array.isArray(r.content) ? r.content : undefined;
    const text = content?.find((c): c is { type: string; text: string } => !!c && typeof c === 'object' && (c as { type?: unknown }).type === 'text' && typeof (c as { text?: unknown }).text === 'string');
    if (text) { try { return JSON.parse(text.text); } catch { return { text: text.text }; } }
  }
  return result;
}

// ── the run ────────────────────────────────────────────────────────────────

/**
 * Run one operation. Throws `ConnectionError` (code `config` for a pack that is not usable,
 * `policy` for a refusal, `http`/`conflict`/... as the transport reports). Resolves to the mapped
 * fields: an object, a list, or undefined for an operation with no result.
 */
export async function runOperation(opName: string, input: Record<string, unknown>, ctx: PackRunCtx): Promise<PackResult> {
  const conn = ctx.conn;
  let pack: LoadedPack;
  try {
    pack = ctx.pack ?? requireEnabled(conn.pack ?? '');
  } catch (e) {
    if (e instanceof PackError) throw new ConnectionError(e.message, 'config');
    throw e;
  }
  const manifest = pack.report.manifest;
  if (!manifest) throw new ConnectionError(`The connector "${pack.id}" has problems and cannot run.`, 'config');
  if (!isOpName(opName)) throw new ConnectionError(`"${opName}" is not an operation.`, 'config');
  const op = manifest.operations[opName];
  const summary = pack.report.ops.find(o => o.name === opName);
  if (!op || !summary) throw new ConnectionError(`The connector "${manifest.label}" does not provide ${opName}.`, 'config');
  // Outside a contract test, an operation that did not pass its contract for this content stays off.
  if (!ctx.contract && !pack.state.tested?.ops[opName]?.ok) throw new ConnectionError(`${opName} on "${manifest.label}" has not passed its contract test, so it is switched off.`, 'config');
  if (summary.effective === 'destructive' && !ctx.person) {
    throw new ConnectionError(`${opName} changes things that cannot be undone, so it runs only when a person asks for it (their click in AICO), never on its own.`, 'policy');
  }
  const def = OPS[opName];
  for (const k of Object.keys(input)) if (!(def.inputs as readonly string[]).includes(k)) throw new ConnectionError(`Internal: ${opName} was given an unknown input "${k}".`, 'config');
  const args = renderArgs(op.args, input);

  if (op.mcp) return runMcp(opName, op, args, ctx, pack, summary.effective);
  const tool = pack.report.tools.get(op.tool ?? '');
  if (!tool?.http) throw new ConnectionError(`The tool for ${opName} is missing.`, 'config');
  const problems = validatePackArgs(tool.input_schema, args);
  if (problems.length) throw new ConnectionError(`${opName}: ${problems.join(' ')}`, 'config');

  const rendered = renderHttp(tool.http, args);
  let url: URL;
  try { url = new URL(rendered.url); } catch { throw new ConnectionError(`${opName}: the rendered URL is not valid.`, 'config'); }
  if (url.username || url.password) throw new ConnectionError(`${opName}: a URL with credentials in it was refused.`, 'config');
  // Allow-list on the URL ABOUT TO BE SENT, against the declared hosts, before any rewrite for a contract test.
  if (!manifest.hosts.includes(url.host.toLowerCase())) {
    auditConnection({ action: 'policy.deny', connection: conn.id, provider: conn.provider, target: rendered.url, outcome: 'denied', detail: 'pack.host', ...(ctx.project ? { project: ctx.project } : {}) });
    throw new ConnectionError(`${url.host} is not one of the connector's hosts (${manifest.hosts.join(', ')}). The request was not sent.`, 'policy');
  }
  const method = rendered.method.toUpperCase();
  if (summary.effective === 'read' && summary.mapped === 'read' && method !== 'GET' && method !== 'HEAD' && !op.readOnlyPost) {
    throw new ConnectionError(`${opName} is a read but its tool would send ${method}; refused.`, 'policy');
  }

  const { auth, username } = packAuth(manifest, conn);
  const origin = ctx.contract ? ctx.contract.origin : url.origin;
  const client = new ConnectionClient(conn, {
    apiBase: origin, auth, ...(username ? { username } : {}),
    headers: { Accept: 'application/json' },
    ...(ctx.contract ? { contractSecret: ctx.contract.secret, retries: 0 } : {}),
    ...(ctx.contract ? {} : { onAuthFailed: (c: StoredConnection) => { const cur = ConnStore.getConnection(c.id); if (cur) ConnStore.putConnection({ ...cur, authFailedAt: new Date().toISOString() }); } }),
  });
  const read = summary.effective === 'read';
  const audit = opName === 'pulls.merge' ? 'pr.merge' : opName === 'pulls.create' ? 'pr.open' : read ? undefined : 'write';
  const page = pageSpec(op);
  const results: unknown[] = [];
  let doc: unknown;
  let path = url.pathname + url.search;
  let more = true;
  for (let n = 0; n < (page?.maxPages ?? 1) && more; n++) {
    const res = await client.request({
      method: method as 'GET', path, headers: rendered.headers, conditional: false,
      ...(rendered.json !== undefined && n === 0 ? { json: rendered.json } : {}),
      ...(audit ? { audit } : {}),
      ...(ctx.signal ? { signal: ctx.signal } : {}), ...(ctx.project ? { project: ctx.project } : {}),
      ref: String(input.id ?? input.head ?? input.sha ?? opName),
    });
    if (res.status < 200 || res.status >= 300) throw failureOf(res, opName, conn);
    if (def.kind === 'none') return undefined;
    if (res.json === undefined && res.text.trim() !== '') throw new ConnectionError(`${conn.label} answered ${opName} with something that is not JSON.`, 'http', res.status);
    doc = res.json;
    if (def.kind !== 'list' || !page) break;
    const list = toArray(readPointer(doc, op.result?.list ?? ''));
    results.push(...list);
    // Next page, by the author's declared style (and nothing else): the same origin, the same path.
    if (page.style === 'link') {
      const next = nextLink(res.headers);
      if (!next) { more = false; break; }
      try {
        const nu = new URL(next, url);
        if (nu.host.toLowerCase() !== url.host.toLowerCase()) { more = false; break; }
        path = nu.pathname + nu.search;
      } catch { more = false; }
    } else if (page.style === 'cursor') {
      const cur = readPointer(doc, page.cursorPath ?? '');
      if (typeof cur !== 'string' || !cur) { more = false; break; }
      const nu = new URL(url.pathname + url.search, url.origin);
      nu.searchParams.set(page.param!, cur);
      path = nu.pathname + nu.search;
    } else {
      if (list.length === 0) { more = false; break; }
      const nu = new URL(url.pathname + url.search, url.origin);
      nu.searchParams.set(page.param!, String(n + 2));
      path = nu.pathname + nu.search;
    }
  }
  if (def.kind === 'list' && page) return shapeResult(opName, { ...op.result!, list: '' }, results);
  return shapeResult(opName, op.result, doc);
}

async function runMcp(opName: OpName, op: PackOperation, args: Record<string, unknown>, ctx: PackRunCtx, pack: LoadedPack, effective: string): Promise<PackResult> {
  const { server, tool } = op.mcp!;
  void effective;
  let raw: unknown;
  if (ctx.contract?.mcpReply) raw = ctx.contract.mcpReply(opName, args);
  else {
    const d = extensionDecision('mcp', server);
    if (!d.ok) throw new ConnectionError(d.message, 'policy');
    const { mcpRegistry } = await import('../../mcp/index.js');
    const client = mcpRegistry.clientOf(server);
    if (!client) throw new ConnectionError(`The MCP server "${server}" that "${pack.report.manifest?.label}" needs is not running. Add it under Settings, MCP.`, 'config');
    if (!mcpRegistry.listedTools(server).some(t => t.name === tool)) throw new ConnectionError(`The MCP server "${server}" has no tool "${tool}" (or a person has not approved it yet).`, 'config');
    raw = await client.callTool(tool, args);
  }
  return shapeResult(opName, op.result, parseMcp(raw));
}

export type { CustomToolDef };
