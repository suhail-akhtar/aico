/**
 * Shared plumbing for the end-to-end template proofs (`templates-verify-react.mjs`,
 * `templates-verify-bundles.mjs`): a reporter, process and HTTP helpers, a clean-copy
 * step, and a check that every GitHub Action in a workflow is pinned by commit SHA to
 * the tag its comment names.
 *
 * Why it exists: both scripts report the way the other `templates-verify-*` scripts do
 * (named checks, "skip" is never "pass", a final count and exit code) and both need the
 * same clean-copy and Docker helpers; copying that twice invites two slightly different
 * definitions of "passed".
 *
 * What it deliberately does not do: touch `~/.aico` (callers import `test-home.mjs`
 * first), install anything on the host, or hide a failure. A step that cannot run (no
 * Docker, no network) is reported as skipped.
 */

import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

export const isWin = process.platform === 'win32';
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const secret = (bytes) => crypto.randomBytes(bytes).toString('hex');

export function tail(text, n = 25) {
  return String(text).trim().split('\n').slice(-n).join('\n');
}

export function createReporter() {
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  const failures = [];
  const indent = (text) => String(text).split('\n').map((l) => `       ${l}`).join('\n');
  return {
    check(cond, label, detail) {
      if (cond) {
        passed++;
        console.log(`  ok   ${label}`);
      } else {
        failed++;
        failures.push(label);
        console.log(`  FAIL ${label}${detail ? `\n${indent(detail)}` : ''}`);
      }
      return Boolean(cond);
    },
    skip(label, why) {
      skipped++;
      console.log(`  skip ${label} (${why})`);
    },
    section(name) {
      console.log(`\n-- ${name} --`);
    },
    note(text) {
      console.log(`       ${text}`);
    },
    finish(extra) {
      if (extra) console.log(`\n${extra}`);
      console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped`);
      if (failed) console.log(`failed:\n${failures.map((f) => `  - ${f}`).join('\n')}`);
      return failed ? 1 : 0;
    },
    get failed() {
      return failed;
    },
  };
}

/** Run a command to completion. Never throws; `ok` is exit status 0. */
export function run(cmd, args, { cwd, env = {}, timeout = 15 * 60_000, input } = {}) {
  const r = spawnSync(cmd, args, {
    cwd,
    encoding: 'utf8',
    timeout,
    input,
    env: { ...process.env, CI: '1', MSYS_NO_PATHCONV: '1', ...env },
    maxBuffer: 128 * 1024 * 1024,
  });
  const out = `${r.stdout ?? ''}\n${r.stderr ?? ''}`;
  return { ok: r.status === 0, status: r.status, out, stdout: r.stdout ?? '', stderr: r.stderr ?? '', error: r.error };
}

export function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

export async function waitFor(fn, ms, label, every = 500) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      last = e;
    }
    await sleep(every);
  }
  throw new Error(`timed out waiting for ${label}${last ? `: ${last.message}` : ''}`);
}

/** A fetch that does not follow redirects, and returns text, parsed JSON when it is, and the headers. */
export async function http(method, url, { body, headers = {}, timeout = 15_000, redirect = 'manual' } = {}) {
  const res = await fetch(url, {
    method,
    headers: { ...(body && typeof body !== 'string' ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    signal: AbortSignal.timeout(timeout),
    redirect,
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  return { status: res.status, headers: res.headers, text, json, setCookies: res.headers.getSetCookie?.() ?? [] };
}

const ARTEFACTS = /[\\/](node_modules|dist|coverage|playwright-report|test-results|blob-report|\.git|\.venv|__pycache__|target|bin|obj|\.gradle|\.next)([\\/]|$)|[\\/]\.env$|[\\/]sbom\.cdx\.json$/;

/**
 * Copy a template the way `instantiateTemplate` does: no artefact directories, no
 * `template.json`, tokens substituted in the files the manifest names.
 */
export function copyTemplate(source, dest, { substitutions = {}, extraSkip } = {}) {
  fs.cpSync(source, dest, {
    recursive: true,
    filter: (p) => p === source || (!ARTEFACTS.test(p.slice(source.length)) && !(extraSkip && extraSkip.test(p.slice(source.length)))),
  });
  const manifestPath = path.join(source, 'template.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  fs.rmSync(path.join(dest, 'template.json'), { force: true });
  for (const rel of manifest.substitute ?? []) {
    const dir = path.dirname(rel);
    const pattern = path.basename(rel);
    const re = new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);
    const abs = path.join(dest, dir);
    if (!fs.existsSync(abs)) continue;
    for (const f of fs.readdirSync(abs).filter((n) => re.test(n))) {
      const full = path.join(abs, f);
      if (!fs.statSync(full).isFile()) continue;
      let text = fs.readFileSync(full, 'utf8');
      for (const [k, val] of Object.entries(substitutions)) text = text.split(k).join(val);
      fs.writeFileSync(full, text);
    }
  }
  return manifest;
}

export function scratchDir(prefix) {
  return fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), prefix));
}

export function dockerAvailable() {
  const r = run('docker', ['version', '--format', '{{.Server.Version}}'], { timeout: 30_000 });
  return r.ok ? r.out.trim().split('\n')[0] : undefined;
}

/** Every `uses:` in the workflows must be `owner/repo@<40-hex> # vX.Y.Z` and the SHA must be that tag's commit. */
export function checkActionPins(dir, { offline = false } = {}) {
  const problems = [];
  const verified = [];
  const wfDir = path.join(dir, '.github', 'workflows');
  if (!fs.existsSync(wfDir)) return { problems: [`no workflows in ${dir}`], verified, skipped: false };
  const uses = new Map();
  for (const f of fs.readdirSync(wfDir).filter((n) => /\.ya?ml$/.test(n))) {
    for (const line of fs.readFileSync(path.join(wfDir, f), 'utf8').split(/\r?\n/)) {
      const m = /^\s*-?\s*uses:\s*(\S+)(?:\s+#\s*(\S+))?/.exec(line);
      if (!m) continue;
      const [, ref, comment] = m;
      if (ref.startsWith('./')) continue;
      const at = ref.indexOf('@');
      if (at < 0 || !/^[0-9a-f]{40}$/.test(ref.slice(at + 1))) {
        problems.push(`${f}: ${ref} is not pinned to a full commit SHA`);
        continue;
      }
      if (!comment || !/^v?\d/.test(comment)) problems.push(`${f}: ${ref} has no version comment`);
      uses.set(ref, comment);
    }
  }
  if (offline) return { problems, verified, skipped: true };
  const gh = run('gh', ['--version'], { timeout: 15_000 });
  if (!gh.ok) return { problems, verified, skipped: true };
  for (const [ref, tag] of uses) {
    const [full, sha] = ref.split('@');
    const repo = full.split('/').slice(0, 2).join('/');
    if (!tag) continue;
    const r1 = run('gh', ['api', `repos/${repo}/git/ref/tags/${tag}`, '--jq', '.object.type + " " + .object.sha'], { timeout: 30_000 });
    if (!r1.ok) {
      problems.push(`${ref}: tag ${tag} not found in ${repo}`);
      continue;
    }
    let [type, real] = r1.stdout.trim().split(' ');
    if (type === 'tag') real = run('gh', ['api', `repos/${repo}/git/tags/${real}`, '--jq', '.object.sha'], { timeout: 30_000 }).stdout.trim();
    if (real === sha) verified.push(`${full}@${tag}`);
    else problems.push(`${ref}: the SHA is not the commit of ${tag} (${real})`);
  }
  return { problems, verified, skipped: false };
}

/** Start a long-lived process and collect its output; returns a handle with `stop()`. */
export function startProcess(cmd, args, options = {}) {
  const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, MSYS_NO_PATHCONV: '1' }, ...options });
  let output = '';
  for (const s of [child.stdout, child.stderr]) s.on('data', (d) => (output += d));
  return {
    child,
    output: () => output,
    stop() {
      try {
        if (isWin) spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F']);
        else child.kill('SIGTERM');
      } catch {
        /* already gone */
      }
    },
  };
}
