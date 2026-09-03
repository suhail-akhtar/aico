/**
 * Remove the project folders that tests and probes left in the real store.
 *
 *   node scripts/prune-test-projects.mjs            # list what would go
 *   node scripts/prune-test-projects.mjs --apply    # remove it
 *
 * Before `AICO_HOME` existed, every harness run and live probe filed its
 * sessions under `~/.aico/projects/<encoded cwd>/`, where the cwd was a
 * throwaway directory under the system temp folder. This finds those and
 * nothing else. A folder is a candidate only when all three hold:
 *
 *   1. its sessions' own header says the cwd was under the temp folder,
 *      falling back to decoding the folder name only when no header exists;
 *   2. that cwd's last path segment begins with `aico-`, the prefix every
 *      test workspace in this repository is created with;
 *   3. the cwd no longer exists on disk.
 *
 * A real project a person opened from a temp folder fails (2); a test
 * workspace still on disk fails (3). Nothing outside `projects/` is touched.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

const apply = process.argv.includes('--apply');
const home = process.env.AICO_HOME?.trim() || path.join(os.homedir(), '.aico');
const projects = path.join(home, 'projects');
const tmp = os.tmpdir();

/** Case-insensitive on Windows, where the temp path often carries a short name. */
const norm = (p) => path.normalize(p).replace(/[\\/]+$/, '').toLowerCase();
const tmpKey = norm(tmp);

function decodeName(name) {
  // `getSessionDir` replaced every `/`, `+` and `=` with `_`; `/` is the
  // common one in base64, so this is a best effort used only without a header.
  try {
    return Buffer.from(name.replace(/_/g, '/'), 'base64').toString('utf8').replace(/\0+$/, '');
  } catch {
    return '';
  }
}

function cwdOf(folder) {
  const sessions = path.join(folder, 'sessions');
  if (fs.existsSync(sessions)) {
    for (const file of fs.readdirSync(sessions)) {
      if (!file.endsWith('.events.jsonl')) continue;
      try {
        const first = fs.readFileSync(path.join(sessions, file), 'utf8').split('\n', 1)[0];
        const header = JSON.parse(first);
        if (typeof header.cwd === 'string' && header.cwd) return { cwd: header.cwd, from: 'header' };
      } catch { /* try the next one */ }
    }
  }
  return { cwd: decodeName(path.basename(folder)), from: 'name' };
}

if (!fs.existsSync(projects)) {
  console.log(`No projects folder at ${projects}`);
  process.exit(0);
}

const candidates = [];
let total = 0;
for (const name of fs.readdirSync(projects)) {
  const folder = path.join(projects, name);
  if (!fs.statSync(folder).isDirectory()) continue;
  total++;
  const { cwd, from } = cwdOf(folder);
  if (!cwd) continue;
  const key = norm(cwd);
  const underTemp = key.startsWith(tmpKey + path.sep) || key.startsWith(tmpKey + '/');
  if (!underTemp) continue;
  const rel = key.slice(tmpKey.length + 1);
  const first = rel.split(/[\\/]/)[0];
  if (!first.startsWith('aico-')) continue;
  if (fs.existsSync(cwd)) continue;
  candidates.push({ folder, cwd, from, family: first.replace(/-[a-z0-9]{6}$/i, '') });
}

const families = new Map();
for (const c of candidates) families.set(c.family, (families.get(c.family) ?? 0) + 1);

console.log(`\n${projects}`);
console.log(`  ${total} project folder(s), ${candidates.length} left by tests or probes under ${tmp}\n`);
for (const [family, n] of [...families].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(n).padStart(5)}  ${family}-*`);
}

if (!candidates.length) process.exit(0);

if (!apply) {
  console.log('\n  Nothing removed. Run again with --apply to remove these.\n');
  process.exit(0);
}

let removed = 0;
for (const c of candidates) {
  try {
    fs.rmSync(c.folder, { recursive: true, force: true });
    removed++;
  } catch (err) {
    console.log(`  could not remove ${c.folder}: ${err.message}`);
  }
}
console.log(`\n  Removed ${removed} folder(s). ${total - removed} remain.\n`);
