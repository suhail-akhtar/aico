/**
 * HTTP routes for the managed policy and the audit export (ADR 0035).
 *
 *   GET  /api/policy        token       what is locked, why, and what is wrong with the file
 *   POST /api/audit/export  token+human the redacted audit stream (jsonl | cef | csv)
 *   POST /api/audit/usage   token+human tokens and estimated cost by model | project | day
 *
 * `policy` is a read of rules, never of secrets — the policy file has no field
 * that could hold one — so the API token is enough; the settings screen needs
 * it before anyone has done anything.
 *
 * The audit routes need a person. The model can hold the API token and `curl`
 * the loopback port (decision-gate.ts says so in its header); the record of
 * what it did is exactly what it should not be able to pull, or pipe somewhere,
 * on its own. The CLI (`aico audit export`) needs no approval: it reads files
 * the person owns, as the person.
 *
 * Returns `undefined` for a route that is not its own, like the other route
 * modules `handleSystemRoute` delegates to.
 *
 * @module policy/routes
 */

import type { AicoSettings } from '../settings.js';
import { loadSettings } from '../settings.js';
import { collectAudit, parseWhen, type ExportOptions } from '../audit/export.js';
import { AUDIT_FORMATS, formatAudit, type AuditFormat } from '../audit/format.js';
import { USAGE_BY, summarizeUsage, usageToCsv, usageToJson, type UsageBy } from '../audit/usage.js';
import { lockedSettings, publicPolicy } from './enforce.js';
import { managedPolicy } from './managed.js';

type Human = () => Promise<{ ok: boolean; reason?: string }>;
type Reply = { status: number; body: unknown };

/** Upper bound on one HTTP export, so a request cannot ask for years of logs in one response. */
const MAX_HTTP_RECORDS = 200_000;

const isObj = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

function readAt(root: unknown, dotted: string): unknown {
  let cursor = root;
  for (const key of dotted.split('.')) {
    if (!isObj(cursor)) return undefined;
    cursor = cursor[key];
  }
  return cursor;
}

/**
 * Why a settings write must be refused outright, or undefined. Only `fixed`
 * and `bounded` locks refuse; a `restricted` one is clamped at the merge, so a
 * write there is inert rather than wrong. `patch` holds whole new values for
 * the top-level keys it names, as `POST /api/settings` receives them.
 */
export function lockedWriteRefusal(patch: Record<string, unknown>): string | undefined {
  const lp = managedPolicy();
  if (!lp.active) return undefined;
  for (const lock of lockedSettings(lp)) {
    const sent = readAt(patch, lock.path);
    if (sent === undefined) continue;
    if (lock.kind === 'fixed' && sent !== lock.value) return `${lock.path} is managed by your organisation and cannot be changed. ${lock.reason}`;
    if (lock.kind === 'bounded' && typeof lock.value === 'number' && (typeof sent !== 'number' || sent > lock.value || sent <= 0)) {
      return `${lock.path} is capped by your organisation at ${lock.value}. ${lock.reason}`;
    }
  }
  return undefined;
}

function optionsFrom(body: Record<string, unknown>, settings: AicoSettings): { options: ExportOptions } | { error: string } {
  const str = (k: string): string | undefined => (typeof body[k] === 'string' && (body[k] as string).trim() ? (body[k] as string).trim() : undefined);
  const since = parseWhen(str('since'));
  const until = parseWhen(str('until'), true);
  if (str('since') && since === undefined) return { error: '"since" must be a date such as 2026-10-01.' };
  if (str('until') && until === undefined) return { error: '"until" must be a date such as 2026-10-08.' };
  const project = str('project');
  const user = str('user');
  const host = str('host');
  return {
    options: {
      ...(since !== undefined ? { since } : {}), ...(until !== undefined ? { until } : {}),
      ...(project ? { project } : {}), settings,
      ...(user || host ? { identity: { ...(user ? { user } : {}), ...(host ? { host } : {}) } } : {}),
    },
  };
}

export async function handlePolicyRoute(
  route: string,
  method: string,
  body: Record<string, unknown>,
  human: Human,
): Promise<Reply | undefined> {
  if (route === 'policy') {
    if (method !== 'GET') return { status: 405, body: { error: 'GET only' } };
    return { status: 200, body: publicPolicy() };
  }
  if (route !== 'audit/export' && route !== 'audit/usage') return undefined;
  if (method !== 'POST') return { status: 405, body: { error: 'POST only' } };
  const person = await human();
  if (!person.ok) {
    return { status: 403, body: { ok: false, code: 'human-required', error: person.reason ?? 'The audit trail needs a person in the AICO window; the API token alone cannot read it.' } };
  }
  const parsed = optionsFrom(body, await loadSettings());
  if ('error' in parsed) return { status: 400, body: { ok: false, error: parsed.error } };

  if (route === 'audit/export') {
    const format = (typeof body.format === 'string' ? body.format : 'jsonl') as AuditFormat;
    if (!AUDIT_FORMATS.includes(format)) return { status: 400, body: { ok: false, error: `format must be one of ${AUDIT_FORMATS.join(', ')}` } };
    const records = await collectAudit(parsed.options);
    if (records.length > MAX_HTTP_RECORDS) {
      return { status: 413, body: { ok: false, error: `That is ${records.length} records; narrow it with since/until, or use \`aico audit export --out file\` on the machine.` } };
    }
    const ext = format === 'jsonl' ? 'jsonl' : format;
    return { status: 200, body: { ok: true, schema: 'aico.audit/1', format, count: records.length, filename: `aico-audit.${ext}`, content: formatAudit(records, format) } };
  }

  const by = (typeof body.by === 'string' ? body.by : 'model') as UsageBy;
  if (!USAGE_BY.includes(by)) return { status: 400, body: { ok: false, error: `by must be one of ${USAGE_BY.join(', ')}` } };
  const format = body.format === 'csv' ? 'csv' : 'json';
  const rows = summarizeUsage(await collectAudit({ ...parsed.options, kinds: ['turn.end'] }), by);
  return { status: 200, body: { ok: true, by, estimated: true, rows, content: format === 'csv' ? usageToCsv(rows, by) : usageToJson(rows, by) } };
}
