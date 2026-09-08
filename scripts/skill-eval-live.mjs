/**
 * Measure the app skills against their tasks, with a real model.
 *
 * SkillLab's corpus for `app-plan`, `app-architecture`, `app-design`,
 * `app-ship` and `app-quality` has deterministic graders; this runs each skill
 * through the same `skill-eval/run` route the Settings screen uses and prints
 * the per-task scores, so "the skill works" is a number that can regress.
 *
 * Costs money. Not part of `npm test`.
 *
 *   node scripts/skill-eval-live.mjs --model z-ai/glm-5.3-flash --budget 0.4
 */
import './lib/test-home.mjs';
import { spawn, spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback; };
const MODEL = arg('model', process.env.LIVE_MODEL || 'z-ai/glm-5.3-flash');
const BUDGET = Number(arg('budget', '0.5'));
const ITERATIONS = Number(arg('iterations', '40'));
const SKILLS = arg('skills', 'app-plan,app-architecture,app-design,app-ship,app-quality').split(',');
const OUT = path.resolve(arg('out', path.join(repoRoot, 'dist-test', `skill-eval-${Date.now()}`)));
fs.mkdirSync(OUT, { recursive: true });

const settingsFile = path.join(process.env.AICO_HOME, 'settings.json');
const settings = fs.existsSync(settingsFile) ? JSON.parse(fs.readFileSync(settingsFile, 'utf8')) : {};
settings.model = MODEL;
settings.miniApps = { ...(settings.miniApps ?? {}), enabled: false };
delete settings.projects;
fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2));

const workdir = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'aico-skill-eval-'));
const server = spawn(process.execPath, [path.join(repoRoot, 'dist', 'index.js'), 'serve', '--no-open'], { cwd: workdir, env: { ...process.env, FORCE_COLOR: '0' } });
const url = await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('serve never printed a URL')), 90_000);
  server.stdout.on('data', d => { const m = d.toString().match(/http:\/\/127\.0\.0\.1:\d+\/\?token=[A-Za-z0-9_-]+/); if (m) { clearTimeout(t); resolve(m[0]); } });
});
const token = url.split('token=')[1];
const base = url.split('/?')[0];
const api = async (route, body) => fetch(`${base}/api/${route}`, { method: body ? 'POST' : 'GET', headers: { 'x-aico-token': token, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }).then(r => r.json());
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

console.log(`\nSKILL EVAL — ${SKILLS.length} skill(s) on ${MODEL}, up to ${BUDGET} and ${ITERATIONS} steps each\n`);
const jobs = [];
for (const skill of SKILLS) {
  const started = await api('skill-eval/run', { skill, model: MODEL, budgetUsd: BUDGET, maxIterations: ITERATIONS });
  if (started.error) { console.log(`  ✗ ${skill}: ${started.error}`); continue; }
  jobs.push({ skill, id: started.id });
}
const results = [];
for (const j of jobs) {
  let job;
  for (let i = 0; i < 720; i++) { job = await api(`skill-eval/job?id=${j.id}`); if (job.done) break; await sleep(5000); }
  const tasks = job?.tasks ?? [];
  const mean = tasks.length ? tasks.reduce((n, t) => n + (t.score ?? 0), 0) / tasks.length : 0;
  results.push({ skill: j.skill, phase: job?.phase, cost: job?.costUsd, mean, tasks: tasks.map(t => ({ id: t.id ?? t.taskId, score: t.score, cost: t.costUsd, error: t.error, missed: (t.checks ?? []).filter(r => !r.passed).map(r => r.check?.why ?? r.why) })) });
  console.log(`  ${mean >= 0.7 ? '✓' : '✗'} ${j.skill}: mean ${(mean * 100).toFixed(0)}% over ${tasks.length} task(s) · $${(job?.costUsd ?? 0).toFixed(3)} · ${job?.phase}`);
  for (const t of tasks) console.log(`      ${((t.score ?? 0) * 100).toFixed(0).padStart(3)}%  ${t.id ?? t.taskId}${t.error ? `  (error: ${String(t.error).slice(0, 80)})` : ''}`);
  for (const t of tasks) for (const r of (t.checks ?? []).filter(r => !r.passed)) console.log(`           - ${t.id ?? t.taskId}: ${r.check?.why ?? r.why}`);
}
fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify({ model: MODEL, results }, null, 2));
const weak = results.filter(r => r.mean < 0.7);
console.log(`\nSKILL EVAL: ${results.length - weak.length} of ${results.length} skills at 70% or better · report ${path.join(OUT, 'report.json')}\n`);
try { if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(server.pid), '/T', '/F']); else server.kill(); } catch {}
process.exit(weak.length > 0 ? 1 : 0);
