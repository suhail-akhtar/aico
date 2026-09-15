/**
 * Drive AICO against real SWE-bench Lite instances: clone the repo at its
 * base commit, register it as an AICO project, submit the real GitHub issue
 * text as the task, wait for the turn to end, and capture `git diff` as the
 * model's patch. Writes predictions.jsonl for the swebench harness to grade.
 *
 * This is the only externally-verified signal AICO has, as of the 2026-09-15
 * probe that first ran this: 5 of 5 selected instances resolved on
 * deepseek-v4-flash, blind (no local test execution, no dependency install --
 * the model reads and edits real source, nothing else). n=5 is a real result,
 * not a benchmark claim; see the memory entry for this probe before citing it
 * anywhere public.
 *
 * Requires: `pip install swebench datasets` in a throwaway venv (never the
 * system Python -- it drags in a specific `websockets`/`h11` pin that has
 * broken unrelated global tools before). Fetches princeton-nlp's dataset by
 * default; grading needs the `SWE-bench/SWE-bench_Lite` dataset instead (it
 * carries the prebuilt-image `image` field the harness now requires).
 *
 * *** On Windows, run the grading harness from WSL2/Linux, not from Windows
 * Python. *** Windows Python writes text files (eval.sh, the intermediate
 * patch) with CRLF line endings; those `\r` characters survive into the
 * Linux grading container and corrupt shell arguments and patch application
 * (a filename ending in a stray `\r` fails `git checkout` with "pathspec did
 * not match any files"). This drove three real, distinct failures the first
 * time this was run on Windows -- none of them were AICO's fault:
 *   1. `core.autocrlf=true` (this machine's git default) rewrote LF to CRLF
 *      on checkout and on `git diff`, breaking `git apply` in the container.
 *      Fixed here with a per-repo `git config core.autocrlf false`.
 *   2. swebench's own Windows codepage default (cp1252) crashed writing a
 *      Unicode box-drawing character from pytest's own output. Fixed by
 *      running the harness with `PYTHONUTF8=1`.
 *   3. swebench writes its generated eval.sh with Windows line endings when
 *      run from Windows Python, corrupting every argument on every line once
 *      bash parses it inside the Linux container. Not fixable by any flag --
 *      run the harness itself from WSL2 (Docker Desktop's WSL integration
 *      shares the same daemon, so images/containers are visible from both
 *      sides): `wsl -d <distro> -- bash -c "cd /mnt/<drive>/... && ./venv-linux/bin/python -m swebench.harness.run_evaluation ..."`
 *
 * Usage:
 *   node scripts/swebench-select-instances.py first, to write instances.json
 *   node scripts/swebench-live.mjs --model deepseek-v4-flash --work E:/tmp/swebench
 *   # then grade predictions.jsonl with swebench.harness.run_evaluation, from WSL on Windows
 *
 * Costs money (a model runs per instance) and clones real upstream repos.
 * Not part of `npm test`.
 */
import { spawn, spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(here, '..');

const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : fallback; };
const MODEL = arg('model', process.env.LIVE_MODEL || 'deepseek-v4-flash');
const WORK = path.resolve(arg('work', path.join(os.tmpdir(), 'aico-swebench')));
const SOFT_MINUTES = Number(arg('soft-minutes', '15'));
const instancesFile = arg('instances', path.join(WORK, 'instances.json'));

const instances = JSON.parse(fs.readFileSync(instancesFile, 'utf8'));

const AICO_HOME = path.join(WORK, 'aico-home');
fs.rmSync(AICO_HOME, { recursive: true, force: true });
fs.mkdirSync(AICO_HOME, { recursive: true });
// Carry over provider keys from the real settings, same isolation idiom as
// scripts/lib/test-home.mjs -- everything else starts fresh.
const src = path.join(process.env.USERPROFILE || process.env.HOME, '.aico', 'settings.json');
const settings = JSON.parse(fs.readFileSync(src, 'utf8'));
settings.model = MODEL;
settings.miniApps = { ...(settings.miniApps ?? {}), enabled: false };
delete settings.projects;
fs.writeFileSync(path.join(AICO_HOME, 'settings.json'), JSON.stringify(settings, null, 2));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a);

const server = spawn(process.execPath, [path.join(REPO_ROOT, 'dist', 'index.js'), 'serve', '--no-open'], {
  cwd: WORK,
  env: { ...process.env, AICO_HOME, FORCE_COLOR: '0' },
});
server.stderr.on('data', (d) => process.stderr.write(d));
const url = await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('serve never printed a URL')), 90_000);
  server.stdout.on('data', (d) => {
    const m = d.toString().match(/http:\/\/127\.0\.0\.1:\d+\/\?token=[A-Za-z0-9_-]+/);
    if (m) { clearTimeout(t); resolve(m[0]); }
  });
});
const token = url.split('token=')[1];
const base = url.split('/?')[0];
const api = async (route, body) =>
  fetch(`${base}/api/${route}`, {
    method: body ? 'POST' : 'GET',
    headers: { 'x-aico-token': token, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  }).then((r) => r.json());

const run = (cmd, cwd) => spawnSync(cmd, { cwd, shell: true, encoding: 'utf8', timeout: 600_000 });

const predictions = [];
const predictionsPath = path.join(WORK, 'predictions.jsonl');
for (const inst of instances) {
  const id = inst.instance_id;
  log(id, 'cloning', inst.repo, '@', inst.base_commit.slice(0, 10));
  const repoDir = path.join(WORK, 'repos', id);
  fs.rmSync(repoDir, { recursive: true, force: true });
  fs.mkdirSync(repoDir, { recursive: true });
  const clone = run(`git clone --filter=blob:none --no-checkout https://github.com/${inst.repo}.git .`, repoDir);
  if (clone.status !== 0) { log(id, 'CLONE FAILED', clone.stderr?.slice(0, 300)); predictions.push({ instance_id: id, model_name_or_path: MODEL, model_patch: '', error: 'clone failed' }); continue; }
  // core.autocrlf=true (this machine's global default) rewrites LF to CRLF on
  // checkout and on `git diff`, which the Linux grading containers then fail
  // to `git apply` -- must be off, per-repo, before the checkout materialises
  // any files.
  run('git config core.autocrlf false', repoDir);
  const checkout = run(`git checkout ${inst.base_commit}`, repoDir);
  if (checkout.status !== 0) { log(id, 'CHECKOUT FAILED', checkout.stderr?.slice(0, 300)); predictions.push({ instance_id: id, model_name_or_path: MODEL, model_patch: '', error: 'checkout failed' }); continue; }
  run('git config user.email aico@aico.local', repoDir);
  run('git config user.name "AICO Agent"', repoDir);

  await api('projects/add', { path: repoDir, name: id });
  const sessionId = crypto.randomUUID();
  const task = `${inst.problem_statement}\n\n---\nThis is a real, existing open-source project checked out at the exact commit above. Read the relevant source, find the root cause, and make the minimal correct code change(s) to fix it. Do not install dependencies or run the test suite -- there is no working Python environment here, focus entirely on reading and editing source. When the fix is made, stop; do not write a summary document.`;

  log(id, 'submitting task');
  const sent = await api('submit', { sessionId, task, project: repoDir });
  if (sent.error) { log(id, 'SUBMIT FAILED', sent.error); predictions.push({ instance_id: id, model_name_or_path: MODEL, model_patch: '', error: sent.error }); continue; }

  const started = Date.now();
  let lastCount = -1;
  let steered = false;
  for (;;) {
    const s = await api(`session?id=${sessionId}`);
    if (s.messages && s.messages.length !== lastCount) { lastCount = s.messages.length; log(id, 'messages', lastCount); }
    if (s.busy === false && lastCount > 1) break;
    const minutes = (Date.now() - started) / 60_000;
    if (!steered && minutes > SOFT_MINUTES) {
      steered = true;
      log(id, `past ${SOFT_MINUTES} minutes -- steering to finish`);
      await api('steer', { sessionId, content: 'Steer from the person: stop exploring and make your best fix now with what you already know, then end the turn.' });
    }
    if (minutes > SOFT_MINUTES * 2) { log(id, 'HARD TIMEOUT, moving on'); break; }
    await sleep(4000);
  }

  const diff = run('git diff', repoDir);
  const patch = diff.stdout ?? '';
  log(id, 'patch length', patch.length, 'chars');
  predictions.push({ instance_id: id, model_name_or_path: MODEL, model_patch: patch });
  fs.writeFileSync(predictionsPath, predictions.map((p) => JSON.stringify(p)).join('\n') + '\n');
}

log('done. predictions written to', predictionsPath);
try { if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(server.pid), '/T', '/F']); else server.kill(); } catch {}
process.exit(0);
