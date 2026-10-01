/**
 * Drive one AICO engine headlessly for the eng-bench: a fresh store, `serve`,
 * one task submitted as one turn, and the session logs read back from disk.
 *
 * Same idiom as scripts/swebench-live.mjs and apps-build-custom-live.mjs (a
 * real `serve` process talking HTTP, the way every client does) rather than
 * calling `runAgent` in-process, so what is measured is the product as
 * shipped: the server's prompt assembly, tool policy, safety limits and the
 * sub-agent plumbing all included.
 *
 * Each task gets its own `AICO_HOME`. The real `~/.aico/settings.json` is
 * *copied* (provider keys are needed) and overlaid with the bench's pinned
 * limits; nothing is ever written back. The overlay is what makes two runs
 * comparable: model, step cap and spend cap are the bench's, not whatever the
 * owner's settings happen to say that day.
 *
 * Nobody is watching a bench turn, so a question the agent asks would block
 * forever. Every poll answers any pending question with a fixed "decide
 * yourself" reply, and counts it — asking is recorded, not punished.
 */
import { spawn } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { killTree, sleep } from './util.mjs';

export const AUTO_ANSWER = 'No one is available to answer. Make the most reasonable assumption, state it in your final report, and continue.';

/** The settings keys the bench reports, so a later run can see if they moved. Never secrets. */
export const REPORTED_SETTINGS = ['model', 'agentModels', 'maxIterations', 'safetyLimits', 'autoApprove',
  'autoCompact', 'promptCaching', 'maxParallelToolCalls', 'bashTimeout', 'activeProvider', 'completionGate', 'repeatGuard'];

/**
 * Where provider settings are copied from: the process's own isolated store
 * (scripts/lib/test-home.mjs has already copied the real settings.json there),
 * so nothing here opens ~/.aico at all.
 */
export function settingsSource() {
  return path.join(process.env.AICO_HOME ?? path.join(os.homedir(), '.aico'), 'settings.json');
}

/** Write a fresh store's settings: the copied file, the bench's overlay on top. */
export function prepareHome(home, overlay) {
  fs.mkdirSync(home, { recursive: true });
  let settings = {};
  try { settings = JSON.parse(fs.readFileSync(settingsSource(), 'utf8')); } catch { /* no settings: the store starts empty */ }
  delete settings.projects;
  delete settings.groups;
  settings = { ...settings, ...overlay };
  fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify(settings, null, 2));
  const reported = {};
  for (const k of REPORTED_SETTINGS) if (settings[k] !== undefined) reported[k] = settings[k];
  return reported;
}

/** Start `aico serve` against `home`. Resolves once it prints its URL. */
export async function startEngine({ entry, home, cwd, logFile }) {
  fs.mkdirSync(cwd, { recursive: true });
  const server = spawn(process.execPath, [entry, 'serve', '--no-open'], {
    cwd, windowsHide: true,
    env: { ...process.env, AICO_HOME: home, FORCE_COLOR: '0' },
  });
  const append = (d) => { try { fs.appendFileSync(logFile, d); } catch { /* best effort: log only */ } };
  server.stderr.on('data', append);
  const url = await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('serve never printed a URL')), 90_000);
    server.stdout.on('data', (d) => {
      append(d);
      const m = d.toString().match(/http:\/\/127\.0\.0\.1:\d+\/\?token=[A-Za-z0-9_-]+/);
      if (m) { clearTimeout(t); resolve(m[0]); }
    });
    server.on('exit', (code) => { clearTimeout(t); reject(new Error(`serve exited early (${code})`)); });
  });
  const token = url.split('token=')[1];
  const base = url.split('/?')[0];
  const api = async (route, body) => {
    try {
      const r = await fetch(`${base}/api/${route}`, {
        method: body ? 'POST' : 'GET',
        headers: { 'x-aico-token': token, 'content-type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(30_000),
      });
      const text = await r.text();
      try { return JSON.parse(text); } catch { return { raw: text, status: r.status }; }
    } catch (e) { return { error: String(e.message) }; }
  };
  return { api, base, pid: server.pid, stop: async () => { killTree(server.pid); await sleep(800); } };
}

/**
 * Submit one task as one turn and wait for it to end.
 *
 * `softMinutes`: steer once to wrap up. `hardMinutes`: cancel. Both are wall
 * clock and both are recorded — a turn that needed either is a finding.
 */
export async function runTurn({ api, project, task, softMinutes, hardMinutes, log = () => {} }) {
  const sessionId = crypto.randomUUID();
  await api('projects/add', { path: project, name: path.basename(project) });
  const started = Date.now();
  const sent = await api('submit', { sessionId, task, project });
  if (sent.error || sent.accepted !== true) {
    return { sessionId, error: `submit failed: ${JSON.stringify(sent).slice(0, 300)}`, wallMs: 0, answers: 0, steered: false, cancelled: false };
  }
  let lastCount = -1, polls = 0, answers = 0, steered = false, cancelled = false, session = {};
  for (;;) {
    await sleep(4000);
    polls++;
    session = await api(`session?id=${sessionId}`);
    const n = session.messages?.length ?? 0;
    if (n !== lastCount) { lastCount = n; log(`messages ${n} · $${(session.usage?.costUsd ?? 0).toFixed(4)}`); }
    if (session.busy === false && (n > 1 || polls > 5)) break;
    const a = await api('answer', { sessionId, content: AUTO_ANSWER });
    if (a.ok === true) { answers++; log('answered a question the agent asked'); }
    const minutes = (Date.now() - started) / 60_000;
    if (!steered && minutes > softMinutes) {
      steered = true;
      log(`past ${softMinutes} min — steering to finish`);
      await api('steer', { sessionId, content: 'Steer from the person: time is nearly up. Finish what you are doing, run the tests once, and end the turn with your report.' });
    }
    if (minutes > hardMinutes) {
      cancelled = true;
      log(`past ${hardMinutes} min — cancelling`);
      await api('cancel', { sessionId });
      for (let i = 0; i < 15; i++) { await sleep(2000); session = await api(`session?id=${sessionId}`); if (session.busy === false) break; }
      break;
    }
  }
  return { sessionId, wallMs: Date.now() - started, answers, steered, cancelled, usage: session.usage ?? {}, error: null };
}

/** Every session log in a store: the main one by id, and every `sub-*` delegated agent's. */
export function readLogs(home, sessionId) {
  const files = [];
  const walk = (d) => {
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.events.jsonl')) files.push(p);
    }
  };
  walk(path.join(home, 'projects'));
  const parse = (f) => fs.readFileSync(f, 'utf8').split('\n').filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const mainFile = files.find((f) => path.basename(f) === `${sessionId}.events.jsonl`);
  const subFiles = files.filter((f) => path.basename(f).startsWith('sub-'));
  return {
    mainFile,
    main: mainFile ? parse(mainFile) : [],
    subs: subFiles.map((f) => ({ id: path.basename(f, '.events.jsonl'), file: f, events: parse(f) })),
  };
}

/**
 * One-shot model call through a throwaway engine, for the LLM judge. Goes
 * through AICO's own provider plumbing so no key is ever handled here.
 */
export async function askModel({ entry, workRoot, prompt, model, overlay, log = () => {} }) {
  const home = path.join(workRoot, `judge-home-${Date.now()}`, '.aico');
  const cwd = path.join(workRoot, `judge-cwd-${Date.now()}`);
  fs.mkdirSync(cwd, { recursive: true });
  prepareHome(home, { ...overlay, model, maxIterations: 3 });
  const engine = await startEngine({ entry, home, cwd, logFile: path.join(workRoot, 'judge-server.log') });
  try {
    const turn = await runTurn({ api: engine.api, project: cwd, task: prompt, softMinutes: 8, hardMinutes: 10, log });
    const { main } = readLogs(home, turn.sessionId);
    const replies = main.filter((e) => e.type === 'assistant/message');
    const text = replies.map((e) => e.data.content ?? '').join('\n');
    const usage = replies.reduce((u, e) => {
      const x = e.data.usage ?? {};
      return { inputTokens: u.inputTokens + (x.inputTokens ?? 0), outputTokens: u.outputTokens + (x.outputTokens ?? 0), cachedTokens: u.cachedTokens + (x.cachedTokens ?? 0) };
    }, { inputTokens: 0, outputTokens: 0, cachedTokens: 0 });
    return { text, usage, steps: replies.length, error: turn.error };
  } finally {
    await engine.stop();
  }
}
