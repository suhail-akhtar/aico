/**
 * `aico audit export`, `aico usage`, `aico policy show|check` (ADR 0035).
 *
 * The terminal is the path a log shipper, a cron job or an administrator
 * uses, so it is the complete one: it reads the person's own files as the
 * person and needs no approval (the HTTP route does — a model can hold the API
 * token, it cannot hold a terminal). Output goes to stdout unless `--out`
 * names a file (written 0600); diagnostics go to stderr so a pipe into a SIEM
 * forwarder carries only records.
 *
 * `policy check <file>` exists for the people who write the policy: it runs
 * the same validator the engine runs at load, prints what each key would
 * become and exits non-zero on an error — so a typo is found on the admin's
 * machine, not by a developer whose AICO then locks down.
 *
 * @module policy/cli
 */

import fs from 'node:fs';
import type { Command } from 'commander';
import { loadSettings } from '../settings.js';
import { collectAudit, parseWhen, type ExportOptions } from '../audit/export.js';
import { AUDIT_FORMATS, formatAudit, type AuditFormat } from '../audit/format.js';
import { USAGE_BY, summarizeUsage, usageToCsv, usageToJson, type UsageBy } from '../audit/usage.js';
import { describeRules, publicPolicy } from './enforce.js';
import { systemPolicyPath, validatePolicy } from './managed.js';

interface RangeFlags { since?: string; until?: string; project?: string; out?: string; user?: string; host?: string }

function rangeOf(flags: RangeFlags): ExportOptions | undefined {
  const since = parseWhen(flags.since);
  const until = parseWhen(flags.until, true);
  if (flags.since && since === undefined) { console.error('--since must be a date such as 2026-10-01'); process.exitCode = 2; return undefined; }
  if (flags.until && until === undefined) { console.error('--until must be a date such as 2026-10-08 (the whole day is included)'); process.exitCode = 2; return undefined; }
  return {
    ...(since !== undefined ? { since } : {}), ...(until !== undefined ? { until } : {}),
    ...(flags.project ? { project: flags.project } : {}),
    ...(flags.user || flags.host ? { identity: { ...(flags.user ? { user: flags.user } : {}), ...(flags.host ? { host: flags.host } : {}) } } : {}),
  };
}

function emit(text: string, out: string | undefined): void {
  if (out) fs.writeFileSync(out, text, { encoding: 'utf8', mode: 0o600 });
  else process.stdout.write(text);
}

export function registerPolicyCommands(program: Command): void {
  const audit = program.command('audit').description('the audit trail: a redacted, versioned export for a SIEM (ADR 0035)');
  audit
    .command('export')
    .description('write audit records (tool calls, turns, approvals, credential use, settings and policy changes, background work)')
    .option('--since <date>', 'first day to include (UTC), e.g. 2026-10-01')
    .option('--until <date>', 'last day to include (UTC); a date alone includes that whole day')
    .option('--project <path>', 'only this project folder')
    .option('--format <fmt>', `one of ${AUDIT_FORMATS.join(' | ')}`, 'jsonl')
    .option('--out <file>', 'write to a file (mode 0600) instead of stdout')
    .option('--user <id>', 'user label, used only when no managed policy states how identity is reported')
    .option('--host <id>', 'host label, used only when no managed policy states how identity is reported')
    .action(async (flags: RangeFlags & { format: string }) => {
      const format = flags.format as AuditFormat;
      if (!AUDIT_FORMATS.includes(format)) { console.error(`--format must be one of ${AUDIT_FORMATS.join(', ')}`); process.exitCode = 2; return; }
      const range = rangeOf(flags);
      if (!range) return;
      const settings = await loadSettings();
      const records = await collectAudit({ ...range, settings });
      emit(formatAudit(records, format), flags.out);
      console.error(`${records.length} audit record(s)${flags.out ? ` written to ${flags.out}` : ''} (schema aico.audit/1, ${format})`);
    });

  program
    .command('usage')
    .description('tokens and estimated cost, summed from the audit records (an estimate, not an invoice)')
    .option('--since <date>', 'first day to include (UTC)')
    .option('--until <date>', 'last day to include (UTC); a date alone includes that whole day')
    .option('--project <path>', 'only this project folder')
    .option('--by <key>', `group by ${USAGE_BY.join(' | ')}`, 'model')
    .option('--format <fmt>', 'csv | json', 'csv')
    .option('--out <file>', 'write to a file (mode 0600) instead of stdout')
    .action(async (flags: RangeFlags & { by: string; format: string }) => {
      const by = flags.by as UsageBy;
      if (!USAGE_BY.includes(by)) { console.error(`--by must be one of ${USAGE_BY.join(', ')}`); process.exitCode = 2; return; }
      if (flags.format !== 'csv' && flags.format !== 'json') { console.error('--format must be csv or json'); process.exitCode = 2; return; }
      const range = rangeOf(flags);
      if (!range) return;
      const settings = await loadSettings();
      const rows = summarizeUsage(await collectAudit({ ...range, settings, kinds: ['turn.end'] }), by);
      emit(flags.format === 'csv' ? usageToCsv(rows, by) : usageToJson(rows, by), flags.out);
    });

  const policy = program.command('policy').description('the organisation\'s managed policy (ADR 0035)');
  policy
    .command('show')
    .description('is a policy in force, what it does, and what is wrong with the file')
    .action(() => {
      const view = publicPolicy();
      if (!view.managed) {
        console.log(`No managed policy. (Looked for ${systemPolicyPath()}${process.env.AICO_POLICY_FILE ? ` and ${process.env.AICO_POLICY_FILE}` : ''}.)`);
        return;
      }
      console.log(`Managed policy ${view.hash}${view.lockdown ? ' — LOCKDOWN (the file could not be read)' : ''}`);
      for (const s of view.sources) console.log(`  ${s.origin}: ${s.path}${s.error ? ` — ${s.error}` : ''}${s.weakness ? `\n    note: not a lock — ${s.weakness}` : ''}`);
      if (view.message) console.log(`  message: ${view.message}`);
      if (view.contact) console.log(`  contact: ${view.contact}`);
      for (const line of view.rules) console.log(`  • ${line}`);
      for (const p of view.problems) console.log(`  ${p.level === 'error' ? '✗' : '!'} ${p.message}`);
      if (view.lockdown || view.problems.some(p => p.level === 'error')) process.exitCode = 1;
    });

  policy
    .command('check <file>')
    .description('validate a policy file before you deploy it (what each key would become; exit 1 on an error)')
    .action((file: string) => {
      let raw: unknown;
      try { raw = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')); }
      catch (err) { console.error(`${file}: ${err instanceof Error ? err.message : String(err)} — AICO would be locked down by this file.`); process.exitCode = 1; return; }
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) { console.error(`${file}: not a JSON object — AICO would be locked down by this file.`); process.exitCode = 1; return; }
      const { policy: effective, problems } = validatePolicy(raw as Record<string, unknown>);
      const rules = describeRules({ active: true, lockdown: false, layers: [{ origin: 'system', path: file, policy: effective, lockdown: false }], sources: [], problems: [], hash: '' });
      console.log(rules.length ? rules.map(r => `  • ${r}`).join('\n') : '  (no rules: this file restricts nothing)');
      for (const p of problems) console.log(`  ${p.level === 'error' ? '✗' : '!'} ${p.message}`);
      console.log(problems.some(p => p.level === 'error') ? 'Invalid: the keys above would take their most restrictive value.' : 'Valid.');
      if (problems.some(p => p.level === 'error')) process.exitCode = 1;
    });

}
