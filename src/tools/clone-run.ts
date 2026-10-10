/**
 * `CloneRun`: run the clone and exercise it, inside the clean-room wall.
 *
 * The implementer has no shell (cleanroom/wall.ts), but it must be able to try
 * what it wrote. This is the one way it can: it starts a Node script from
 * `clone/` under Node's permission model, so the process can read and write
 * only `clone/` and can start no child process, worker or addon. A clone that
 * tries to read the observer's corpus, or anything else outside its folder,
 * gets ERR_ACCESS_DENIED.
 *
 *  - `run`: execute a script once (args, stdin), return stdout, stderr and the
 *    exit code. For a command-line clone.
 *  - `serve`: start a server script with `PORT` set, wait until it accepts
 *    connections, send the given HTTP requests, return each response, stop it.
 *    For a web or API clone.
 *
 * Refuses outside a marked workspace and when this Node cannot confine the
 * child: it never runs unconfined. The child gets a minimal environment (no
 * provider keys, nothing inherited), and the network is the one thing the
 * permission model does not limit (said in the wall's header).
 *
 * Deferred (group `cleanroom`), so the schema costs nothing outside a
 * clean-room run.
 *
 * @module tools/clone-run
 */

import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { projectRoot } from '../run-context.js';
import { isWorkspace, permissionFlags, realish } from '../cleanroom/wall.js';

export interface CloneRunInput {
  mode?: 'run' | 'serve';
  file?: string;
  args?: string[];
  stdin?: string;
  env?: Record<string, string>;
  timeoutSec?: number;
  requests?: { method?: string; path: string; headers?: Record<string, string>; body?: unknown }[];
}

const CAP = 20_000;
const clip = (s: string): string => (s.length > CAP ? `${s.slice(0, CAP)}\n[… ${s.length - CAP} more characters]` : s);

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)); });
  });
}

function minimalEnv(extra: Record<string, string> | undefined, port?: number): Record<string, string> {
  const env: Record<string, string> = {};
  for (const k of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'TEMP', 'TMP', 'HOME', 'USERPROFILE']) if (process.env[k]) env[k] = process.env[k]!;
  if (port !== undefined) env.PORT = String(port);
  for (const [k, v] of Object.entries(extra ?? {})) if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(k) && !/key|token|secret|password/i.test(k)) env[k] = String(v);
  return env;
}

export async function cloneRun(input: CloneRunInput): Promise<string> {
  const root = projectRoot();
  if (!isWorkspace(root)) return 'CloneRun works only inside a clean-room workspace (a folder prepared by `aico cleanroom implement`).';
  const cloneDir = realish(path.join(root, 'clone')); // the real path: the permission model compares path strings (Windows short names would not match)
  if (!input.file || typeof input.file !== 'string') return 'CloneRun needs "file": the script in clone/ to run, e.g. "server.mjs".';
  const file = realish(path.resolve(cloneDir, input.file));
  const rel = path.relative(cloneDir, file);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return `${input.file} is not inside clone/. Only scripts in clone/ can be run.`;
  if (!fs.existsSync(file)) return `${path.relative(root, file)} does not exist yet. Write it first.`;
  const flags = permissionFlags(cloneDir);
  if (!flags) return 'This Node cannot confine a child process to one folder (it needs the permission model, Node 20 or newer). CloneRun will not run code unconfined.';
  const timeoutMs = Math.min(Math.max(Number(input.timeoutSec) || 15, 1), 60) * 1000;
  const mode = input.mode ?? (input.requests?.length ? 'serve' : 'run');
  return mode === 'serve' ? serve(file, cloneDir, flags, input, timeoutMs) : runOnce(file, cloneDir, flags, input, timeoutMs);
}

function runOnce(file: string, cwd: string, flags: string[], input: CloneRunInput, timeoutMs: number): Promise<string> {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [...flags, file, ...(input.args ?? [])], { cwd, env: minimalEnv(input.env), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let out = '', err = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); err += `\n[stopped: no exit within ${timeoutMs / 1000}s]`; }, timeoutMs);
    child.stdout.on('data', d => { if (out.length < CAP * 2) out += d; });
    child.stderr.on('data', d => { if (err.length < CAP * 2) err += d; });
    child.on('error', e => { err += `\n[spawn error] ${e.message}`; });
    child.on('close', (code, sig) => { clearTimeout(timer); resolve(`exit ${code ?? sig}\n--- stdout ---\n${clip(out)}\n--- stderr ---\n${clip(err)}`); });
    child.stdin.end(input.stdin ?? '');
  });
}

async function serve(file: string, cwd: string, flags: string[], input: CloneRunInput, timeoutMs: number): Promise<string> {
  const port = await freePort();
  const child = spawn(process.execPath, [...flags, file, ...(input.args ?? [])], { cwd, env: minimalEnv(input.env, port), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let log = '';
  let exited: string | undefined;
  child.stdout.on('data', d => { if (log.length < CAP) log += d; });
  child.stderr.on('data', d => { if (log.length < CAP) log += d; });
  child.on('close', (code, sig) => { exited = `exited early with ${code ?? sig}`; });
  child.on('error', e => { exited = `could not start: ${e.message}`; });
  const ready = async (): Promise<boolean> => {
    const end = Date.now() + Math.min(timeoutMs, 10_000);
    while (Date.now() < end && !exited) {
      const ok = await new Promise<boolean>(r => { const s = net.connect(port, '127.0.0.1'); s.once('connect', () => { s.destroy(); r(true); }); s.once('error', () => r(false)); });
      if (ok) return true;
      await new Promise(r => setTimeout(r, 100));
    }
    return false;
  };
  try {
    if (!(await ready())) return `The server did not start listening on PORT=${port} (${exited ?? 'no connection within the wait'}).\n--- output ---\n${clip(log)}`;
    const lines: string[] = [`Listening on 127.0.0.1:${port} (the PORT it was given).`];
    for (const r of input.requests ?? []) {
      const method = (r.method ?? 'GET').toUpperCase();
      let body: string | undefined;
      const headers: Record<string, string> = { ...r.headers };
      if (r.body !== undefined) { body = typeof r.body === 'string' ? r.body : JSON.stringify(r.body); if (typeof r.body !== 'string' && !Object.keys(headers).some(h => h.toLowerCase() === 'content-type')) headers['content-type'] = 'application/json'; }
      try {
        const res = await fetch(`http://127.0.0.1:${port}${r.path.startsWith('/') ? r.path : `/${r.path}`}`, { method, headers, ...(body !== undefined ? { body } : {}), redirect: 'manual', signal: AbortSignal.timeout(Math.min(timeoutMs, 10_000)) });
        const text = await res.text();
        const h = ['content-type', 'location', 'set-cookie'].map(k => (res.headers.get(k) ? `${k}: ${res.headers.get(k)}` : '')).filter(Boolean).join('; ');
        lines.push(`${method} ${r.path} -> ${res.status}${h ? ` (${h})` : ''}\n${clip(text.slice(0, 4000))}`);
      } catch (e) { lines.push(`${method} ${r.path} -> failed: ${e instanceof Error ? e.message : String(e)}`); }
    }
    if (log.trim()) lines.push(`--- server output ---\n${clip(log)}`);
    return lines.join('\n\n');
  } finally { child.kill('SIGKILL'); }
}

export const cloneRunDefinition = {
  name: 'CloneRun',
  description:
    'Run the clone you are building and try it. Only scripts in clone/ run, under a permission sandbox (they can read and write clone/ only and cannot start other processes), with PORT set for servers.\n'
    + 'mode "run": execute file once with args and stdin; returns exit code, stdout and stderr (a command-line clone).\n'
    + 'mode "serve": start file as a server (PORT is given), send requests [{method, path, headers, body}], return each response (a web or API clone).',
  inputSchema: {
    type: 'object' as const,
    properties: {
      mode: { type: 'string', enum: ['run', 'serve'] },
      file: { type: 'string', description: 'The script in clone/, e.g. "cli.mjs" or "server.mjs".' },
      args: { type: 'array', items: { type: 'string' } },
      stdin: { type: 'string' },
      env: { type: 'object', additionalProperties: { type: 'string' } },
      timeoutSec: { type: 'number', description: 'Up to 60. Default 15.' },
      requests: { type: 'array', items: { type: 'object', properties: { method: { type: 'string' }, path: { type: 'string' }, headers: { type: 'object', additionalProperties: { type: 'string' } }, body: {} }, required: ['path'] } },
    },
    required: ['file'],
  },
};
