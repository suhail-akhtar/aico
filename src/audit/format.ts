/**
 * Serialising audit records: JSONL, CEF and CSV (ADR 0035).
 *
 * JSONL and CSV carry every field. CEF — what most SIEM connectors (ArcSight,
 * Sentinel, QRadar, Splunk's CEF add-on) take natively — carries the
 * standard keys it has (`rt`, `suser`, `shost`, `act`, `outcome`, `msg`,
 * `externalId`, `cat`) and six labelled custom strings, with the fields that
 * have no CEF home folded into the last one as `k=v;`. That is the documented
 * trade of the format, not a loss in the data: the JSONL export is the full
 * record.
 *
 * The escaping is where exporters get hurt, so it is explicit:
 *  - CEF header fields: `\` and `|` are escaped; extension values: `\`, `=`
 *    and line breaks. A value containing `|` or `=` cannot forge a field or
 *    start a new event.
 *  - CSV: RFC 4180 quoting, CRLF rows, and a cell that starts with `=`, `+`,
 *    `-`, `@`, tab or CR is prefixed with `'` so a spreadsheet does not run it
 *    as a formula (CSV injection) — the strings here come, ultimately, from a
 *    model and from file names.
 *
 * @module audit/format
 */

import { AUDIT_COLUMNS, type AuditRecord } from './export.js';

export type AuditFormat = 'jsonl' | 'cef' | 'csv';
export const AUDIT_FORMATS: readonly AuditFormat[] = ['jsonl', 'cef', 'csv'];

// ── JSONL ───────────────────────────────────────────────────────────

export function toJsonl(records: readonly AuditRecord[]): string {
  return records.map(r => JSON.stringify(r)).join('\n') + (records.length ? '\n' : '');
}

// ── CSV ─────────────────────────────────────────────────────────────

/** One CSV cell, RFC 4180 plus formula-injection protection. */
export function csvCell(value: unknown): string {
  if (value === undefined || value === null) return '';
  let s = typeof value === 'number' ? String(value) : String(value);
  if (typeof value !== 'number' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(records: readonly AuditRecord[]): string {
  const rows = [AUDIT_COLUMNS.join(',')];
  for (const r of records) rows.push(AUDIT_COLUMNS.map(c => csvCell((r as unknown as Record<string, unknown>)[c])).join(','));
  return rows.join('\r\n') + '\r\n';
}

// ── CEF ─────────────────────────────────────────────────────────────

export const cefHeader = (s: string): string => s.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' ');
export const cefValue = (s: string): string => s.replace(/\\/g, '\\\\').replace(/=/g, '\\=').replace(/\r?\n/g, '\\n').replace(/\r/g, '');

/** 0–10. Denials and errors rank above routine success; a lockdown or an unreadable policy is the loudest. */
export function cefSeverity(r: AuditRecord): number {
  if (r.kind === 'policy.load' && r.outcome === 'error') return 9;
  if (r.kind === 'policy.load' && r.action === 'removed') return 7;
  if (r.kind === 'credential') return r.action === 'reveal' || r.action === 'export' || r.action === 'grant' ? 6 : r.outcome === 'denied' ? 5 : 3;
  if (r.outcome === 'denied') return 6;
  if (r.outcome === 'error' || r.outcome === 'timeout') return 5;
  if (r.outcome === 'escalated') return 4;
  if (r.kind === 'settings.change') return 3;
  if (r.outcome === 'aborted' || r.outcome === 'declined' || r.outcome === 'expired') return 3;
  return 1;
}

export function toCefLine(r: AuditRecord): string {
  const ext: string[] = [];
  const add = (k: string, v: unknown): void => { if (v !== undefined && v !== '' && v !== null) ext.push(`${k}=${cefValue(String(v))}`); };
  add('rt', Date.parse(r.time));
  add('externalId', r.id);
  add('cat', r.kind);
  add('act', r.action);
  add('outcome', r.outcome);
  add('suser', r.user);
  add('shost', r.host);
  add('msg', r.reason);
  if (r.target) { add('cs1Label', 'target'); add('cs1', r.target); }
  if (r.sessionId) { add('cs2Label', 'sessionId'); add('cs2', r.sessionId); }
  if (r.project) { add('cs3Label', 'project'); add('cs3', r.project); }
  if (r.tool) { add('cs4Label', 'tool'); add('cs4', r.tool); }
  if (r.model) { add('cs5Label', 'model'); add('cs5', r.model); }
  const extra = [
    ['decision', r.decision], ['decidedBy', r.decidedBy], ['stage', r.stage], ['credential', r.credential],
    ['callId', r.callId], ['turn', r.turn], ['tenant', r.tenant], ['aicoVersion', r.aicoVersion], ['schema', r.schema],
  ].filter(([, v]) => v !== undefined && v !== '').map(([k, v]) => `${k}=${String(v).replace(/;/g, ',')}`).join(';');
  if (extra) { add('cs6Label', 'extra'); add('cs6', extra); }
  if (r.inputTokens !== undefined) { add('cn1Label', 'inputTokens'); add('cn1', r.inputTokens); }
  if (r.outputTokens !== undefined) { add('cn2Label', 'outputTokens'); add('cn2', r.outputTokens); }
  if (r.durationMs !== undefined) { add('cn3Label', 'durationMs'); add('cn3', r.durationMs); }
  if (r.costUsd !== undefined) { add('cfp1Label', 'costUsd'); add('cfp1', r.costUsd); }
  return [
    'CEF:0', cefHeader('AICO'), cefHeader('aico'), cefHeader(r.aicoVersion), cefHeader(r.kind),
    cefHeader(`${r.kind}: ${r.action}`.slice(0, 120)), String(cefSeverity(r)), ext.join(' '),
  ].join('|');
}

export function toCef(records: readonly AuditRecord[]): string {
  return records.map(toCefLine).join('\n') + (records.length ? '\n' : '');
}

export function formatAudit(records: readonly AuditRecord[], format: AuditFormat): string {
  if (format === 'cef') return toCef(records);
  if (format === 'csv') return toCsv(records);
  return toJsonl(records);
}
