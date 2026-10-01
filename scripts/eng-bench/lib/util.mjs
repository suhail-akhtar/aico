/**
 * Grading helpers shared by every eng-bench task: a check list, shell and
 * process control, HTTP, JWT minting, and a TAP parser for `node --test`.
 *
 * Why these live in one place: each grader must be skeptical in the same way
 * (never trust the agent's own claims, always run the thing), and the
 * Windows-specific details — `shell: true` needing quoted paths, killing a
 * process *tree* rather than the shell that started it, CRLF in output — were
 * each a real failure in the earlier live scripts (see the header of
 * scripts/swebench-live.mjs). One copy of each fix, not six.
 *
 * Deliberately has no dependency on the engine: graders run against a project
 * directory and nothing else, so `test-graders.mjs` can prove them against
 * reference solutions offline and for free.
 */
import { spawn, spawnSync } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import net from 'net';
import path from 'path';

/** A list of named pass/fail checks with a short detail each. */
export function createChecks(log = () => {}) {
  const list = [];
  const check = (id, ok, detail = '', { weight = 1 } = {}) => {
    list.push({ id, ok: Boolean(ok), detail: String(detail ?? '').slice(0, 400), weight });
    log(`  ${ok ? 'PASS' : 'FAIL'} ${id}${detail ? ` — ${String(detail).slice(0, 160)}` : ''}`);
    return Boolean(ok);
  };
  const summary = () => {
    const total = list.reduce((n, c) => n + c.weight, 0);
    const passed = list.reduce((n, c) => n + (c.ok ? c.weight : 0), 0);
    return { passed, total, score: total ? Math.round((passed / total) * 1000) / 1000 : 0, checks: list };
  };
  return { check, list, summary };
}

/** Run a shell command to completion. Never throws. */
export function sh(cmd, { cwd, env, timeoutMs = 300_000 } = {}) {
  const r = spawnSync(cmd, {
    cwd, shell: true, encoding: 'utf8', timeout: timeoutMs, windowsHide: true,
    env: { ...process.env, ...env }, maxBuffer: 64 * 1024 * 1024,
  });
  return {
    code: r.status, timedOut: r.error?.code === 'ETIMEDOUT' || (r.signal != null && r.status == null),
    out: (r.stdout ?? '').replace(/\r\n/g, '\n'), err: (r.stderr ?? '').replace(/\r\n/g, '\n'),
    error: r.error?.message,
  };
}

/** Kill a process and everything it started. On Windows `kill()` only reaches the shell. */
export function killTree(pid) {
  if (!pid) return;
  try {
    if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true });
    else process.kill(-pid, 'SIGKILL');
  } catch { /* already gone */ }
}

/** Start a long-running command (a server). Output is kept for the report. */
export function startProcess(cmd, { cwd, env } = {}) {
  const proc = spawn(cmd, {
    cwd, shell: true, windowsHide: true, detached: process.platform !== 'win32',
    env: { ...process.env, ...env },
  });
  let output = '';
  const keep = (d) => { output = (output + d.toString()).slice(-20_000); };
  proc.stdout.on('data', keep);
  proc.stderr.on('data', keep);
  let exited = null;
  proc.on('exit', (code) => { exited = code ?? -1; });
  return {
    proc,
    output: () => output,
    exited: () => exited,
    stop: async () => { killTree(proc.pid); await sleep(500); },
  };
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A port nothing is listening on right now. */
export function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });
}

/** Wait until `url` answers with any status below 500, or the process dies. */
export async function waitForHttp(url, { timeoutMs = 45_000, proc } = {}) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (proc && proc.exited() !== null) return false;
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (r.status < 500) return true;
    } catch { /* not up yet */ }
    await sleep(400);
  }
  return false;
}

/** One HTTP request; JSON in and out when possible. Never throws. */
export async function http(base, method, route, { token, body, rawBody, headers = {} } = {}) {
  const h = { ...headers };
  if (token) h.authorization = `Bearer ${token}`;
  let payload;
  if (rawBody !== undefined) { payload = rawBody; h['content-type'] = 'application/json'; }
  else if (body !== undefined) { payload = JSON.stringify(body); h['content-type'] = 'application/json'; }
  try {
    const r = await fetch(`${base}${route}`, { method, headers: h, body: payload, signal: AbortSignal.timeout(10_000) });
    const text = await r.text();
    let json; try { json = text ? JSON.parse(text) : undefined; } catch { json = undefined; }
    return { status: r.status, json, text };
  } catch (e) {
    return { status: 0, json: undefined, text: String(e.message) };
  }
}

const b64url = (buf) => Buffer.from(buf).toString('base64url');

/** An HS256 JWT. The grader mints its own so it can also mint wrong ones. */
export function mintJwt(payload, secret, { alg = 'HS256' } = {}) {
  const head = b64url(JSON.stringify({ alg, typ: 'JWT' }));
  const body = b64url(JSON.stringify(payload));
  const sig = alg === 'none' ? '' : crypto.createHmac('sha256', secret).update(`${head}.${body}`).digest('base64url');
  return `${head}.${body}.${sig}`;
}

/**
 * Run `node --test` over the given files and return one entry per top-level
 * test, parsed from TAP. A file that never reported (crash, hang) shows up as
 * missing names, which the caller treats as failures.
 */
/**
 * The project's test scripts under test/: JavaScript files only, never fixtures.
 * Handing `node --test` a data file (an agent's golden JSON) counts as a failing test.
 */
export function testScripts(project) {
  return listFiles(path.join(project, 'test'))
    .filter((f) => /\.[cm]?js$/.test(f) && !/(^|[\/])fixtures[\/]/.test(f))
    .map((f) => `test/${f}`);
}

export function runNodeTests(files, { cwd, timeoutMs = 120_000, env } = {}) {
  const quoted = files.map((f) => `"${f}"`).join(' ');
  const r = sh(`node --test --test-reporter=tap --test-timeout=20000 ${quoted}`, { cwd, timeoutMs, env });
  return { ...parseTap(r.out), raw: r.out.slice(-6000) + r.err.slice(-2000), code: r.code, timedOut: r.timedOut };
}

/** Top-level `ok`/`not ok` lines of a TAP stream (subtests are indented). */
export function parseTap(text) {
  const tests = [];
  for (const line of text.split('\n')) {
    const m = line.match(/^(not ok|ok) \d+ - (.+?)(?:\s+#\s*(SKIP|TODO).*)?$/);
    if (m) tests.push({ name: m[2].trim(), ok: m[1] === 'ok' && !m[3] });
  }
  return { tests, passed: tests.filter((t) => t.ok).length, failed: tests.filter((t) => !t.ok).length };
}

/** Copy a directory tree (fixtures are small). */
export function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  fs.cpSync(src, dst, { recursive: true });
}

/**
 * Make the project a git repository with the fixture as its first commit, so
 * the agent sees a normal working copy and the grader can diff what changed.
 * `core.autocrlf=false` per repo: this machine's global `true` rewrites LF.
 */
export function gitInit(dir) {
  const g = (args) => spawnSync('git', args, { cwd: dir, encoding: 'utf8', windowsHide: true });
  g(['init', '-q']);
  g(['config', 'core.autocrlf', 'false']);
  g(['config', 'user.email', 'dev@example.com']);
  g(['config', 'user.name', 'Fixture Author']);
  g(['add', '-A']);
  g(['commit', '-q', '-m', 'Initial import']);
}

/** Files changed since the fixture commit, including untracked ones. */
export function gitChanged(dir) {
  const r = spawnSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: dir, encoding: 'utf8', windowsHide: true });
  return (r.stdout ?? '').split('\n').filter(Boolean).map((l) => l.slice(3).trim())
    .filter((f) => !/(^|\/)(node_modules|\.venv|venv|__pycache__)\//.test(f));
}

/** Read a file, or '' when it is not there. */
export function readText(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return ''; }
}

/** All files under `dir` (relative, forward slashes), skipping dependency and VCS folders. */
export function listFiles(dir, { skip = /^(node_modules|\.git|\.venv|venv|__pycache__|\.bench-hidden|coverage|dist)$/ } = {}) {
  const out = [];
  const walk = (d, rel) => {
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (skip.test(e.name)) continue;
      const p = path.join(d, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(p, r); else out.push(r);
    }
  };
  walk(dir, '');
  return out;
}

export function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

/** Find a local Chrome/Edge for Playwright; the repo ships playwright-core without browsers. */
export function findBrowser() {
  const candidates = [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome', '/usr/bin/chromium',
  ];
  return candidates.find((p) => fs.existsSync(p));
}
