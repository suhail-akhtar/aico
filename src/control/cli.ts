/**
 * `aico control login | status | logout | sync` (ADR 0040).
 *
 * The terminal is the path an administrator or a CI image uses to enrol a
 * machine, and it needs no extra approval: it is the person at their own
 * keyboard (the HTTP routes, which a model can reach with the API token, do —
 * see routes.ts). `login` prints the code before it opens a browser, so it
 * also works over SSH: type the code at the address shown on any device.
 *
 * Output that is meant to be read by a script (`status --json`) contains no
 * token, only what `state.json` holds.
 *
 * @module control/cli
 */

import { execFile } from 'node:child_process';
import type { Command } from 'commander';
import { ControlError, completeLogin, logout, startLogin } from './client.js';
import { graceExpired, readControlState } from './state.js';
import { syncOnce } from './sync.js';
import { managedPolicy } from '../policy/managed.js';
import { describeRules } from '../policy/enforce.js';

/** Open the system browser on `url` (https or loopback http only; an argument array, never a shell string). */
export function openInBrowser(url: string): void {
  if (!/^https?:\/\//.test(url)) return;
  const [cmd, args]: [string, string[]] = process.platform === 'win32' ? ['explorer.exe', [url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  try { execFile(cmd, args, () => undefined).unref(); } catch { /* the code is printed anyway */ }
}

export function statusLines(): string[] {
  const s = readControlState();
  if (!s) return ['Not signed in to an organisation. Run: aico control login <url>'];
  const lines = [
    `Organisation: ${s.tenant.name} (${s.url})`,
    `Signed in as: ${s.user.email}  role: ${s.role}${s.team ? `  team: ${s.team}` : ''}`,
    `Policy: ${s.policy ? `${s.policy.layers.length} layer(s), version ${s.policy.hash}` : 'not fetched yet'}`,
    `Last contact: ${s.lastContactAt ? new Date(s.lastContactAt).toISOString() : 'never'}${graceExpired(s) ? '  (offline allowance used up: model calls are refused until reconnected)' : ''}`,
  ];
  if (s.policy?.lease?.blocked) lines.push(`Budget: ${s.policy.lease.reason ?? 'reached'}`);
  if (s.lastError) lines.push(`Last problem: ${s.lastError}`);
  const rules = describeRules(managedPolicy());
  if (rules.length) lines.push('Rules in force:', ...rules.map(r => `  - ${r}`));
  return lines;
}

export function registerControlCommands(program: Command): void {
  const control = program.command('control').description('sign in to your organisation\'s AICO Control server (policy, usage, audit) - ADR 0040');

  control
    .command('login <url>')
    .description('enrol this machine: shows a code to approve in the browser (device authorization grant)')
    .option('--tenant <slug>', 'organisation, when the server hosts several')
    .option('--no-open', 'do not open a browser; just print the address and code')
    .action(async (url: string, flags: { tenant?: string; open: boolean }) => {
      try {
        const start = await startLogin(url, flags.tenant ? { tenant: flags.tenant } : {});
        console.log(`\nOpen ${start.verificationUri} and enter the code:\n\n    ${start.userCode}\n`);
        console.log('Only approve if you started this yourself, just now.');
        if (flags.open) openInBrowser(start.verificationUriComplete);
        console.log('Waiting for approval...');
        const state = await completeLogin(start);
        console.log(`Signed in to ${state.tenant.name} as ${state.user.email} (${state.role}).`);
        const r = await syncOnce();
        console.log(r.ok ? 'Your organisation\'s policy is applied.' : `Signed in, but the first sync failed: ${r.error}`);
      } catch (e) {
        console.error(e instanceof ControlError ? e.message : `Sign-in failed: ${e instanceof Error ? e.message : String(e)}`);
        process.exitCode = 1;
      }
    });

  control
    .command('status')
    .description('who you are signed in as, the policy in force, and when the server was last reached')
    .option('--json', 'machine-readable (never contains a token)')
    .action((flags: { json?: boolean }) => {
      if (flags.json) {
        const s = readControlState();
        console.log(JSON.stringify(s ? { enrolled: true, url: s.url, organisation: s.tenant, user: s.user, role: s.role, team: s.team ?? null, policyHash: s.policy?.hash ?? null, lastContactAt: s.lastContactAt ?? null, offlineAllowanceUsedUp: graceExpired(s), lastError: s.lastError ?? null } : { enrolled: false }, null, 2));
      } else console.log(statusLines().join('\n'));
    });

  control
    .command('logout')
    .description('sign out of the organisation on this machine (its rules stop applying here)')
    .action(async () => {
      const r = await logout();
      console.log(r.wasEnrolled ? `Signed out of ${r.org}. Ask an administrator to revoke this device in the portal if it is lost.` : 'Not signed in.');
    });

  control
    .command('sync')
    .description('fetch the latest policy and upload audit and usage now')
    .option('--pull-only', 'only fetch the policy')
    .action(async (flags: { pullOnly?: boolean }) => {
      const r = await syncOnce({ pull: Boolean(flags.pullOnly) });
      if (r.skipped) { console.log('Not signed in.'); return; }
      if (!r.ok) { console.error(`Sync failed: ${r.error}`); process.exitCode = 1; return; }
      console.log(`Synced. Policy ${r.policyChanged ? 'changed' : 'unchanged'}; uploaded ${r.auditPushed} audit record(s), ${r.usagePushed} usage event(s).`);
    });
}
