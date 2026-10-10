/**
 * Runs every control/test/*.test.mjs in its own process (each owns its server
 * and database), builds the server first, and fails if any suite fails.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.dirname(here);

if (!process.argv.includes('--no-build')) {
  const b = spawnSync('npx', ['tsup'], { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' });
  if (b.status !== 0) process.exit(b.status ?? 1);
}
let bad = 0;
for (const f of fs.readdirSync(here).filter(n => n.endsWith('.test.mjs')).sort()) {
  console.log(`\n######## ${f}`);
  const r = spawnSync(process.execPath, [path.join(here, f)], { stdio: 'inherit', cwd: root });
  if (r.status !== 0) bad++;
}
console.log(bad ? `\n${bad} control suite(s) failed` : '\nAll control suites passed');
process.exit(bad ? 1 : 0);
