/**
 * Validate one or more starter templates and print every problem.
 *
 * Why this exists: the loader drops a template whose manifest fails validation
 * *silently* (an unknown shape must not half-run), so a typo in `template.json`
 * used to make a starter vanish from the catalogue with no message. This runs
 * the same validator (`validateManifest`, src/apps/templates.ts) plus the
 * completeness bar the harness enforces, and says what is wrong.
 *
 * Run: node scripts/validate-template.mjs [templates/<id> …]   (default: all)
 * Exit code 1 when any template has a problem. Offline, free.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEngineModule } from './lib/engine-module.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { validateManifest, REQUIRED_TEMPLATE_FILES } = await loadEngineModule('apps/templates.ts');

const args = process.argv.slice(2);
const dirs = args.length
  ? args.map(a => path.resolve(a))
  : fs.readdirSync(path.join(root, 'templates')).map(n => path.join(root, 'templates', n)).filter(d => fs.existsSync(path.join(d, 'template.json')));

const LOCKS = { python: ['uv.lock', 'poetry.lock', 'requirements.txt', 'pylock.toml'], go: ['go.sum'], php: ['composer.lock'], dotnet: ['packages.lock.json'], java: ['gradle.lockfile', 'pom.xml'], node: ['package-lock.json'] };

function tree(dir, depth = 0) {
  if (depth > 4) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e =>
    e.isDirectory() ? (['.git', 'node_modules', '.venv', 'venv', 'target', 'obj', 'bin', 'vendor', '__pycache__'].includes(e.name) ? [] : tree(path.join(dir, e.name), depth + 1)) : [e.name]);
}

let bad = 0;
for (const dir of dirs) {
  const problems = [];
  const file = path.join(dir, 'template.json');
  let m;
  try { m = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { problems.push(`template.json: ${e.message}`); }
  if (m) {
    problems.push(...validateManifest(m));
    for (const rel of REQUIRED_TEMPLATE_FILES) if (!fs.existsSync(path.join(dir, rel))) problems.push(`missing ${rel}`);
    try {
      const n = fs.readFileSync(path.join(dir, 'AICO.md'), 'utf8').length;
      if (n > 2000) problems.push(`AICO.md is ${n} characters; the inlined cap is 2000`);
    } catch { /* reported above */ }
    try {
      if (!/- \[x\]/.test(fs.readFileSync(path.join(dir, '.aico', 'backlog.md'), 'utf8'))) problems.push('.aico/backlog.md has no ticked story (Iteration 0 records the worked feature as done)');
    } catch { /* reported above */ }
    if (m.kind === 'process') {
      const id = m.toolchain?.id ?? 'node';
      if (!tree(dir).some(n => (LOCKS[id] ?? []).includes(n))) problems.push(`no lock or pinned dependency file (${(LOCKS[id] ?? []).join(' | ')})`);
      for (const f of ['Dockerfile', 'compose.yaml', '.env.example', '.gitignore']) if (!fs.existsSync(path.join(dir, f))) problems.push(`missing ${f}`);
      if (m.envFile && fs.existsSync(path.join(dir, '.gitignore'))) {
        const gi = fs.readFileSync(path.join(dir, '.gitignore'), 'utf8').split(/\r?\n/).map(l => l.trim());
        if (!gi.includes(m.envFile.file) && !gi.includes(`/${m.envFile.file}`)) problems.push(`.gitignore does not ignore the generated env file (${m.envFile.file})`);
      }
    }
    if (fs.existsSync(path.join(dir, '.env.example'))) {
      const real = fs.readFileSync(path.join(dir, '.env.example'), 'utf8').split(/\r?\n/)
        .filter(l => /^[A-Z0-9_]*(SECRET|KEY|PASSWORD|TOKEN)[A-Z0-9_]*=.+/.test(l) && !/=(change-me|<|\$\{|\s*$)/i.test(l) && !/PUBLIC|_KEY_PATH|KEY_FILE/.test(l.split('=')[0]));
      if (real.length) problems.push(`.env.example holds what looks like a real secret value: ${real.map(l => l.split('=')[0]).join(', ')} (use change-me… or empty)`);
    }
  }
  const name = path.relative(root, dir) || dir;
  if (problems.length) { bad++; console.log(`✗ ${name}\n${problems.map(p => `    - ${p}`).join('\n')}`); }
  else console.log(`✓ ${name} (${m.kind}${m.toolchain ? `, ${m.toolchain.id}` : ''})`);
}
console.log(bad ? `\n${bad} template(s) with problems` : '\nall templates valid');
process.exit(bad ? 1 : 0);
