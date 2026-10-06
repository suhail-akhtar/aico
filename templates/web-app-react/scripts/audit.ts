/**
 * `npm run audit`: fail on high or critical advisories in the locked dependencies.
 *
 * Runs `npm audit --json` against the registry, applies the policy in
 * `audit-lib.ts` and the reviewed allow-list `.audit-allowlist.json`, and exits:
 *   0  nothing blocking
 *   1  a blocking advisory (or an expired / malformed allow-list entry)
 *   2  the audit could not run (no network, registry error): never a silent pass
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { advisoriesOf, evaluate, parseAllowList } from './audit-lib.ts';

const result = spawnSync('npm', ['audit', '--json'], {
  encoding: 'utf8',
  shell: process.platform === 'win32',
  maxBuffer: 64 * 1024 * 1024,
});

let report: unknown;
try {
  report = JSON.parse(result.stdout);
} catch {
  console.error('audit: npm audit produced no JSON (is the registry reachable?)');
  console.error(result.stderr.trim().split('\n').slice(-5).join('\n'));
  process.exit(2);
}
if ((report as { error?: unknown }).error) {
  console.error(`audit: npm audit failed: ${JSON.stringify((report as { error: unknown }).error)}`);
  process.exit(2);
}

const allowPath = '.audit-allowlist.json';
const { entries, invalid } = parseAllowList(
  existsSync(allowPath) ? JSON.parse(readFileSync(allowPath, 'utf8')) : [],
);
const today = new Date().toISOString().slice(0, 10);
const verdict = evaluate(advisoriesOf(report), entries, today);

for (const a of verdict.allowed)
  console.log(`allowed   ${a.severity.padEnd(8)} ${a.package}: ${a.title} (${a.id})`);
for (const e of verdict.expired)
  console.error(`expired   allow-list entry ${e.id} (${e.expires}): review it or renew it`);
for (const message of invalid) console.error(`invalid   ${message}`);
for (const a of verdict.failing)
  console.error(`FAIL      ${a.severity.padEnd(8)} ${a.package}: ${a.title}\n          ${a.url}`);

if (verdict.failing.length > 0 || verdict.expired.length > 0 || invalid.length > 0) process.exit(1);
console.log(`audit: no high or critical advisories (${verdict.allowed.length} allow-listed)`);
