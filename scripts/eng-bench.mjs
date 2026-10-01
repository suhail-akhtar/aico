/**
 * eng-bench: a small, repeatable benchmark of AICO's software-engineering
 * work on enterprise-style tasks, with tokens and dollars measured, so that a
 * prompt, skill or tool change can be shown to help or to hurt.
 *
 * Why it exists. The earlier evidence answers different questions:
 * SWE-bench (scripts/swebench-live.mjs) is bounded bug-fixing on public,
 * possibly-memorised repositories; the custom-app probe
 * (scripts/apps-build-custom-live.mjs) grades with the agent's own checks
 * plus a human spot-check. Neither is a fixed suite that can be re-run
 * after a change to see a delta. This is: six fixed tasks, fixed prompts,
 * seeded hidden tests, and graders that never read the agent's report.
 *
 *   1 enterprise-api       build a multi-tenant orders API from an empty folder (black-box HTTP grader)
 *   2 bugfix-export        fix a non-obvious bug from a customer ticket, no test given (hidden tests)
 *   3 refactor-shipping    god function -> Strategy, behaviour pinned by 800-case characterization
 *   4 architecture-doc     design doc for an offline + real-time + reporting system (SOFT: rubric + LLM judge)
 *   5 fullstack-comments   DB + API + UI + tests in an existing app (API checks + Playwright)
 *   6 delegation-security  five independent security fixes; records how sub-agents were briefed
 *
 * Each task runs in a fresh temp project with its own AICO_HOME (the real
 * ~/.aico/settings.json is copied for provider keys, never written), through
 * `aico serve` exactly as a client drives it, one turn, capped by
 * settings.maxIterations and settings.safetyLimits plus a wall clock. Per task
 * it records pass/fail per check, wall time, steps, tokens (input / output /
 * cached), USD, tool calls by tool, whether the agent verified its own work,
 * and the delegation briefs — as JSON and as a Markdown summary.
 *
 * Costs money (a real model runs; ~6 tasks on deepseek-flash). Not part of
 * `npm test`; run only when asked. Never run two live probes at once on this
 * machine (see the 0912 memory: parallel live jobs died silently).
 *
 *   npm run bench:eng -- --out <dir>                         # all tasks, once, on dist/
 *   node scripts/eng-bench.mjs --tasks bugfix-export,refactor-shipping --runs 3
 *   node scripts/eng-bench.mjs --aico <frozen>/dist/index.js --label baseline --out <dir>
 *   node scripts/eng-bench.mjs --compare <old results.json> ...   # adds a delta table
 *   node scripts/eng-bench/test-graders.mjs                       # free: graders vs reference solutions
 *
 * Options: --model (deepseek-flash) --judge-model (deepseek-v4-pro)
 * --max-iterations (80) --max-usd (1.0 per task session) --max-usd-subagent
 * (0.3) --soft-minutes (25) --hard-minutes (40) --work <dir> --label <name>.
 */
// A store of this process's own; must stay first. Each task then gets a fresh
// store of its own, seeded from this one's copy of settings.json.
import './lib/test-home.mjs';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath, pathToFileURL } from 'url';
import { prepareHome, startEngine, runTurn, readLogs, askModel } from './eng-bench/lib/engine.mjs';
import { summarise } from './eng-bench/lib/metrics.mjs';
import { createChecks } from './eng-bench/lib/util.mjs';
import { renderMarkdown } from './eng-bench/lib/report.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : fallback;
};

const TASK_ORDER = ['enterprise-api', 'bugfix-export', 'refactor-shipping', 'architecture-doc', 'fullstack-comments', 'delegation-security'];
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const opts = {
  entry: path.resolve(arg('aico', path.join(repoRoot, 'dist', 'index.js'))),
  tasks: (arg('tasks', TASK_ORDER.join(','))).split(',').map((s) => s.trim()).filter(Boolean),
  runs: Number(arg('runs', '1')),
  model: arg('model', 'deepseek-flash'),
  judgeModel: arg('judge-model', 'deepseek-v4-pro'),
  maxIterations: Number(arg('max-iterations', '80')),
  maxUsd: Number(arg('max-usd', '1.0')),
  maxUsdSub: Number(arg('max-usd-subagent', '0.3')),
  softMinutes: Number(arg('soft-minutes', '25')),
  hardMinutes: Number(arg('hard-minutes', '40')),
  out: path.resolve(arg('out', path.join(repoRoot, 'dist-test', `eng-bench-${stamp}`))),
  work: path.resolve(arg('work', path.join(fs.realpathSync.native(os.tmpdir()), `aico-eng-bench-${stamp}`))),
  label: arg('label', null),
  compare: arg('compare', null),
};

const unknown = opts.tasks.filter((t) => !TASK_ORDER.includes(t));
if (unknown.length) { console.error(`unknown task(s): ${unknown.join(', ')} — choices: ${TASK_ORDER.join(', ')}`); process.exit(2); }
if (!fs.existsSync(opts.entry)) { console.error(`no engine at ${opts.entry} — run \`npm run build\` or pass --aico`); process.exit(2); }

// Common to every task: nobody will answer mid-task, which is true of a bench
// run and also of most real delegated work.
const AUTONOMY = '\n\nYou are working autonomously: nobody will answer questions during this task, so make reasonable assumptions, state them in your final message, and carry on.';

// Judge pricing, per million tokens, mirrored from src/tokens.ts for the two
// models the bench uses; the engine's own tracker prices the agent's spend.
const PRICES = {
  'deepseek-flash': { input: 0.15, output: 0.60, cacheRead: 0.02 },
  'deepseek-v4-flash': { input: 0.14, output: 0.28, cacheRead: 0.02 },
  'deepseek-v4-pro': { input: 0.66, output: 1.98, cacheRead: 0.0333 },
};
const priceOf = (model, u) => {
  const p = PRICES[model];
  if (!p || !u) return null;
  return ((Math.max(0, u.inputTokens - u.cachedTokens) * p.input) + (u.cachedTokens * p.cacheRead) + (u.outputTokens * p.output)) / 1e6;
};

fs.mkdirSync(opts.out, { recursive: true });
fs.mkdirSync(opts.work, { recursive: true });
const runLog = path.join(opts.out, 'run.log');
const log = (...a) => {
  const line = `[${new Date().toISOString().slice(11, 19)}] ${a.join(' ')}`;
  console.log(line);
  fs.appendFileSync(runLog, `${line}\n`);
};

const overlay = {
  model: opts.model,
  autoApprove: true,
  maxIterations: opts.maxIterations,
  safetyLimits: { maxCostPerSession: opts.maxUsd, maxCostPerSubagent: opts.maxUsdSub },
  miniApps: { enabled: false },
};

const version = spawnSync(process.execPath, [opts.entry, '--version'], { encoding: 'utf8', env: { ...process.env, AICO_HOME: path.join(opts.work, 'version-home', '.aico') } }).stdout?.trim();
const gitOf = (dir) => {
  const head = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: dir, encoding: 'utf8' });
  if (head.status !== 0) return null;
  const dirty = spawnSync('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: dir, encoding: 'utf8' }).stdout.trim();
  return `${head.stdout.trim()}${dirty ? '+dirty' : ''}`;
};

const doc = {
  meta: {
    label: opts.label, startedAt: new Date().toISOString(), finishedAt: null,
    entry: opts.entry, aicoVersion: version, git: gitOf(path.dirname(opts.entry)),
    node: process.version, platform: `${process.platform} ${os.release()}`,
    judgeModel: opts.judgeModel, runs: opts.runs, tasks: opts.tasks,
    softMinutes: opts.softMinutes, hardMinutes: opts.hardMinutes, work: opts.work, settings: null,
  },
  results: [],
};
const previous = opts.compare ? JSON.parse(fs.readFileSync(opts.compare, 'utf8')) : null;
const save = () => {
  const name = opts.label ?? 'results';
  fs.writeFileSync(path.join(opts.out, `${name}.json`), JSON.stringify(doc, null, 2));
  fs.writeFileSync(path.join(opts.out, `${name}.md`), renderMarkdown(doc, previous));
};

const tasks = [];
for (const id of TASK_ORDER.filter((t) => opts.tasks.includes(t))) {
  tasks.push((await import(pathToFileURL(path.join(here, 'eng-bench', 'tasks', id, 'task.mjs')).href)).default);
}

const graderContext = (dir) => ({
  askModel: async (prompt) => {
    const r = await askModel({ entry: opts.entry, workRoot: path.join(dir, 'judge'), prompt, model: opts.judgeModel, overlay, log });
    return { ...r, model: opts.judgeModel, costUsd: priceOf(opts.judgeModel, r.usage) };
  },
});

async function gradeRecord(task, record, tlog) {
  const checks = createChecks(tlog);
  let extra = {};
  try {
    extra = await task.grade({ project: record.paths.project, check: checks.check, log: tlog, ...graderContext(path.dirname(record.paths.project)) }) ?? {};
  } catch (e) {
    checks.check('grader ran to completion', false, e.message);
    tlog('grader error', e.stack ?? e.message);
  }
  const summary = checks.summary();
  return { ...summary, pass: summary.total > 0 && summary.passed === summary.total, extra };
}

// --regrade <results.json>: grade the projects an earlier run left on disk
// again, with the current graders, without running the agent. For when a
// grader bug is found after the fact; the old grade is kept beside the new.
const regrade = arg('regrade', null);
if (regrade) {
  const old = JSON.parse(fs.readFileSync(regrade, 'utf8'));
  Object.assign(doc, { meta: { ...old.meta, regradedAt: new Date().toISOString(), regradeNote: arg('note', 'graders updated') }, results: old.results });
  const filter = process.argv.includes('--tasks') ? new Set(opts.tasks) : null;
  for (const record of doc.results) {
    if (filter && !filter.has(record.task)) continue;
    const task = tasks.find((t) => t.id === record.task) ?? (await import(pathToFileURL(path.join(here, 'eng-bench', 'tasks', record.task, 'task.mjs')).href)).default;
    const tlog = (...a) => log(`[regrade ${record.task}#${record.run}]`, ...a);
    const before = record.grade;
    record.grade = await gradeRecord(task, record, tlog);
    record.previousGrade = { passed: before.passed, total: before.total, failed: before.checks.filter((c) => !c.ok).map((c) => c.id) };
    tlog(`${before.passed}/${before.total} -> ${record.grade.passed}/${record.grade.total}`);
  }
  opts.label ??= old.meta.label;
  doc.meta.label = opts.label;
  save();
  log(`regraded into ${path.join(opts.out, `${opts.label ?? 'results'}.json`)}`);
  process.exit(0);
}

log(`eng-bench: ${tasks.map((t) => t.id).join(', ')} × ${opts.runs} on ${opts.model} via ${opts.entry} (AICO ${version})`);
log(`out ${opts.out} · work ${opts.work}`);

for (let run = 1; run <= opts.runs; run++) {
  for (const task of tasks) {
    const dir = path.join(opts.work, `run${run}`, task.id);
    const project = path.join(dir, task.id);
    const home = path.join(dir, 'home', '.aico');
    const logsOut = path.join(opts.out, `run${run}`, task.id);
    fs.mkdirSync(logsOut, { recursive: true });
    const tlog = (...a) => log(`[${task.id}#${run}]`, ...a);
    const record = { run, task: task.id, title: task.title, soft: task.soft, error: null, turn: null, metrics: null, grade: null, paths: { project, logs: logsOut } };
    try {
      task.setup(project);
      const effective = prepareHome(home, overlay);
      doc.meta.settings ??= effective;
      tlog('starting engine');
      const engine = await startEngine({ entry: opts.entry, home, cwd: dir, logFile: path.join(logsOut, 'server.log') });
      let turn;
      try {
        turn = await runTurn({ api: engine.api, project, task: task.prompt + AUTONOMY, softMinutes: opts.softMinutes, hardMinutes: opts.hardMinutes, log: tlog });
      } finally {
        // Stopping the engine's process tree also stops anything the agent
        // left running (dev servers), before the grader starts its own.
        await engine.stop();
      }
      record.turn = turn;
      if (turn.error) record.error = turn.error;
      const logs = readLogs(home, turn.sessionId);
      if (logs.mainFile) fs.copyFileSync(logs.mainFile, path.join(logsOut, 'session.events.jsonl'));
      for (const s of logs.subs) fs.copyFileSync(s.file, path.join(logsOut, `${s.id}.events.jsonl`));
      record.metrics = summarise(logs, turn.usage);
      tlog(`turn ended (${JSON.stringify(record.metrics.turnEnd)}) after ${(turn.wallMs / 60_000).toFixed(1)} min, ${record.metrics.iterations} steps, $${(record.metrics.costUsd ?? 0).toFixed(4)}; grading`);
    } catch (e) {
      record.error = `runner: ${e.stack ?? e.message}`;
      tlog('runner error', e.message);
    }

    record.grade = await gradeRecord(task, record, tlog);
    tlog(`score ${record.grade.passed}/${record.grade.total}${record.grade.pass ? ' PASS' : ''}`);
    doc.results.push(record);
    save();
  }
}

doc.meta.finishedAt = new Date().toISOString();
save();
const total = doc.results.reduce((n, r) => n + (r.metrics?.costUsd ?? 0) + (r.grade?.extra?.judge?.costUsd ?? 0), 0);
log(`done: ${doc.results.map((r) => `${r.task}#${r.run} ${r.grade.passed}/${r.grade.total}`).join(' · ')} · total $${total.toFixed(3)}`);
log(`results: ${path.join(opts.out, `${opts.label ?? 'results'}.json`)} and .md`);
process.exit(0);
