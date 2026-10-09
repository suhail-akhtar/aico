/**
 * The contract test (ADR 0039 section 3, point 3): each operation a pack declares is run through
 * the REAL engine path against its recorded fixtures, served by a loopback server the engine starts
 * for the occasion, and the normalised result is compared to what the fixture says to expect.
 *
 * What "real engine path" means here, and why it is not a mock of the runner:
 *
 *  - The arguments are rendered, validated, and the request is built from the tool definition by
 *    `runOperation` (runner.ts), the same function a live connection uses.
 *  - The rendered host is checked against the pack's DECLARED hosts first (so a tool that wanders to
 *    another host fails the contract), and only then sent to the loopback server in its place.
 *  - The request goes through `ConnectionClient`: SSRF guard, auth applied by the declared scheme
 *    (the server checks the header really is there, in the right shape), size and time limits.
 *  - The answer goes through `normaliseFor`, so a missing required field or an unmapped enum value
 *    fails the operation exactly as it would live.
 *
 * What the loopback server verifies about each request: method, path, the query keys the fixture
 * lists, a required substring of the body, and that the declared credential scheme was applied with
 * the contract token and no other way (never in the URL). A request that does not match gets a 599
 * that names the difference, and the case fails with it. One request per page the case declares;
 * a case that sends more or fewer fails.
 *
 * A fixture case is `{name, input, request:{method,path,query?,bodyIncludes?}, response:{status,
 * headers?,body?}, expect?, next?:[{request,response}]}`. `expect` is a subset: objects match when
 * every key given matches, arrays must be the same length with each element a subset. An
 * `expect: {"error": {"code": "not-found", "status": 404}}` case asserts the operation fails that way.
 * An MCP-backed operation has no HTTP to replay: its case supplies `response.body` as the tool's
 * result and only the field maps and normalisation are exercised; the server itself is exercised by
 * the person's live probe.
 *
 * The result is recorded against the pack's content hash (store.ts `recordTest`): it says which
 * operations pass for THIS content, and a pack with any edit starts untested again. Operations that
 * fail stay off, with their reason shown.
 *
 * What it does not do: talk to the real service (the person's click on Test does, read-only), or
 * enable anything.
 *
 * @module connections/packs/contract
 */

import crypto from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { ConnectionError } from '../http.js';
import type { StoredConnection } from '../types.js';
import { OPS, isOpName, type FixtureCase } from './format.js';
import { normaliseFor } from './normalise.js';
import { runOperation, type PackResult } from './runner.js';
import { loadPack, recordTest, PackError, type TestRecord } from './store.js';

const CONTRACT_TOKEN = 'contract-test-token-0000-not-a-credential'; // standards-allow: secret (fixed fake for the loopback contract test)

interface Served { request?: NonNullable<FixtureCase['request']>; response: FixtureCase['response'] }

function subsetDiff(want: unknown, got: unknown, at = '$'): string | undefined {
  if (want === null || typeof want !== 'object') return want === got ? undefined : `${at}: expected ${JSON.stringify(want)} got ${JSON.stringify(got)?.slice(0, 80)}`;
  if (Array.isArray(want)) {
    if (!Array.isArray(got)) return `${at}: expected a list, got ${JSON.stringify(got)?.slice(0, 80)}`;
    if (want.length !== got.length) return `${at}: expected ${want.length} item(s), got ${got.length}`;
    for (let i = 0; i < want.length; i++) { const d = subsetDiff(want[i], got[i], `${at}[${i}]`); if (d) return d; }
    return undefined;
  }
  if (got === null || typeof got !== 'object') return `${at}: expected an object, got ${JSON.stringify(got)?.slice(0, 80)}`;
  for (const [k, v] of Object.entries(want as Record<string, unknown>)) {
    if (!(k in (got as Record<string, unknown>))) return `${at}.${k}: missing (expected ${JSON.stringify(v)?.slice(0, 80)})`;
    const d = subsetDiff(v, (got as Record<string, unknown>)[k], `${at}.${k}`);
    if (d) return d;
  }
  return undefined;
}

interface LoopbackServer { origin: string; host: string; serve(s: Served[], scheme: { kind: 'bearer' | 'basic' | 'header'; header?: string; username?: string }): { mismatches: string[]; served: () => number }; close(): Promise<void> }

async function startServer(): Promise<LoopbackServer> {
  let queue: Served[] = [];
  let scheme: { kind: 'bearer' | 'basic' | 'header'; header?: string; username?: string } = { kind: 'bearer' };
  let mismatches: string[] = [];
  let count = 0;
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', c => chunks.push(c as Buffer));
    req.on('end', () => {
      count++;
      const raw = Buffer.concat(chunks).toString('utf8');
      const u = new URL(req.url ?? '/', 'http://contract.invalid');
      const want = queue.shift();
      const fail = (why: string): void => {
        mismatches.push(why);
        res.writeHead(599, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ contract: why }));
      };
      if (!want) return fail(`an unexpected extra request: ${req.method} ${u.pathname}`);
      // The declared credential scheme, applied with the contract token, and never in the URL.
      const auth = String(req.headers.authorization ?? '');
      const headerValue = scheme.kind === 'header' ? String(req.headers[(scheme.header ?? '').toLowerCase()] ?? '') : '';
      const okAuth = scheme.kind === 'bearer' ? auth === `Bearer ${CONTRACT_TOKEN}`
        : scheme.kind === 'basic' ? auth === `Basic ${Buffer.from(`${scheme.username ?? ''}:${CONTRACT_TOKEN}`).toString('base64')}`
          : headerValue === CONTRACT_TOKEN;
      if (!okAuth) return fail(`the credential was not applied as the declared "${scheme.kind}" scheme${scheme.kind === 'header' ? ` (${scheme.header})` : ''}`);
      if (req.url?.includes(CONTRACT_TOKEN)) return fail('the credential appeared in the URL');
      const rq = want.request;
      if (rq) {
        if (req.method?.toUpperCase() !== rq.method.toUpperCase()) return fail(`expected ${rq.method.toUpperCase()} ${rq.path}, the tool sent ${req.method} ${u.pathname}`);
        if (u.pathname !== rq.path) return fail(`expected path ${rq.path}, the tool sent ${u.pathname}`);
        for (const [k, v] of Object.entries(rq.query ?? {})) {
          if (u.searchParams.get(k) !== String(v)) return fail(`expected query ${k}=${v}, the tool sent ${k}=${u.searchParams.get(k) ?? '(absent)'}`);
        }
        if (rq.bodyIncludes && !raw.includes(rq.bodyIncludes)) return fail(`expected the body to include ${JSON.stringify(rq.bodyIncludes)}, it was ${raw.slice(0, 120) || '(empty)'}`);
      }
      const r = want.response;
      const text = r.text !== undefined ? String(r.text) : r.body !== undefined ? JSON.stringify(r.body) : '';
      res.writeHead(r.status, { ...(text ? { 'content-type': r.text !== undefined ? 'text/plain' : 'application/json' } : {}), ...(r.headers ?? {}) });
      res.end(text);
    });
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = (server.address() as AddressInfo).port;
  return {
    origin: `http://127.0.0.1:${port}`, host: `127.0.0.1:${port}`,
    serve(s, sch) { queue = [...s]; scheme = sch; mismatches = []; count = 0; return { mismatches, served: () => count }; },
    close: () => new Promise<void>(resolve => { server.closeAllConnections?.(); server.close(() => resolve()); }),
  };
}

export interface ContractReport {
  id: string;
  hash: string;
  ops: TestRecord['ops'];
  /** Per case, for the agent: `ok` or the first difference. */
  cases: Array<{ op: string; name: string; ok: boolean; detail?: string }>;
}

/**
 * Run every declared operation's fixtures. The pack need not be enabled (that is the point), but it
 * must validate. Records the result for the pack's current content. Throws PackError if it cannot run.
 */
export async function runContract(id: string): Promise<ContractReport> {
  const pack = loadPack(id);
  if (!pack) throw new PackError(`No pack "${id}".`, 'not-found');
  if (pack.report.errors.length || !pack.report.manifest) throw new PackError(`The pack has ${pack.report.errors.length} problem(s); fix them before testing:\n- ${pack.report.errors.slice(0, 8).join('\n- ')}`, 'invalid');
  const manifest = pack.report.manifest;
  const hash = pack.hash;
  const server = await startServer();
  const ops: TestRecord['ops'] = {};
  const cases: ContractReport['cases'] = [];
  try {
    for (const summary of pack.report.ops) {
      const name = summary.name;
      const fx = pack.report.fixtures.get(name);
      if (!fx || fx.cases.length === 0) { ops[name] = { ok: false, detail: 'no fixture: record at least one request/response pair' }; continue; }
      let firstFail: string | undefined;
      for (const c of fx.cases) {
        const conn: StoredConnection = {
          id: `contract-${id}-${crypto.randomBytes(4).toString('hex')}`, provider: 'custom', pack: id, label: manifest.label,
          baseUrl: server.origin, hosts: [server.host], insecureHttp: true, createdAt: new Date().toISOString(), createdBy: 'agent', credential: 'contract-test',
          ...(manifest.auth.scheme === 'basic' ? { username: manifest.auth.username ?? '' } : {}),
        };
        const sequence: Served[] = [{ ...(c.request ? { request: c.request } : {}), response: c.response }];
        for (const n of ((c as unknown as { next?: Served[] }).next ?? [])) sequence.push(n);
        const handle = server.serve(c.request ? sequence : [], { kind: manifest.auth.scheme, ...(manifest.auth.header ? { header: manifest.auth.header } : {}), ...(manifest.auth.username ? { username: manifest.auth.username } : {}) });
        let detail: string | undefined;
        try {
          const raw: PackResult = await runOperation(name, c.input, {
            conn, pack, person: true,
            contract: { origin: server.origin, secret: CONTRACT_TOKEN, mcpReply: () => c.response.body },
          });
          const normalised = normaliseFor(isOpName(name) ? name : 'probe', raw, { connection: conn.id, repo: { owner: String(c.input.owner ?? 'owner'), name: String(c.input.name ?? 'repo') }, manifest });
          const expectErr = (c.expect as { error?: unknown } | undefined)?.error;
          if (expectErr) detail = `expected the operation to fail with ${JSON.stringify(expectErr)}, but it returned a result`;
          else if (c.expect !== undefined) detail = subsetDiff(c.expect, JSON.parse(JSON.stringify(normalised ?? null)));
          if (!detail && handle.mismatches.length) detail = handle.mismatches[0];
          if (!detail && c.request && handle.served() !== sequence.length) detail = `the tool sent ${handle.served()} request(s); the fixture expects ${sequence.length}`;
          // A write must not have been served unless the fixture says so; a read fixture with a non-GET is caught by validation.
          void OPS;
        } catch (e) {
          const expectErr = (c.expect as { error?: { code?: string; status?: number } } | undefined)?.error;
          if (handle.mismatches.length) detail = handle.mismatches[0];
          else if (expectErr && e instanceof ConnectionError) {
            if (expectErr.code && expectErr.code !== e.code) detail = `expected error code ${expectErr.code}, got ${e.code}`;
            else if (expectErr.status && expectErr.status !== e.status) detail = `expected error status ${expectErr.status}, got ${e.status}`;
          } else detail = e instanceof Error ? e.message.slice(0, 300) : String(e).slice(0, 300);
        }
        cases.push({ op: name, name: c.name, ok: !detail, ...(detail ? { detail } : {}) });
        if (detail && !firstFail) firstFail = `${c.name}: ${detail}`;
      }
      ops[name] = firstFail ? { ok: false, detail: firstFail } : { ok: true };
    }
  } finally {
    await server.close();
  }
  // Only record if nothing changed while we ran (an edit during the test would make this about other content).
  if (loadPack(id)?.hash === hash) recordTest(id, hash, ops);
  return { id, hash, ops, cases };
}
