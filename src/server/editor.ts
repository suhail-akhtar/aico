/**
 * "Open in editor" for clients without one of their own (ADR 0030): the web
 * client's Code map and file links, and the desktop's "Open in external
 * editor".
 *
 *   POST /api/editor/open  { path?, file, line?, col? }   launch the editor (a person's click)
 *   GET  /api/editor/file?path=&file=                     a project file for the web viewer
 *
 * ## Why the engine launches it
 *
 * A browser page cannot start a program, and the engine already runs on the
 * person's machine. So the click goes to the engine, which starts the
 * person's editor at the line — VS Code's `code -g file:line` when it is on
 * the PATH, or the command line in their own settings (`editor.command`,
 * e.g. `cursor -g {file}:{line}`, `idea --line {line} {file}`,
 * `subl {file}:{line}`). When there is none, the answer says so and the
 * client opens its own read-only viewer at that line instead.
 *
 * ## Why it is safe to offer
 *
 * Starting a process is the most dangerous thing a route can do, so:
 *
 * - **A person, not the token.** `open` needs the same proof as approving a
 *   tool call (server/decision-gate `checkHuman`: the desktop's one-time
 *   grant, or the web client's UI-key nonce). A model that learned the API
 *   token cannot make it launch anything.
 * - **The program is the person's.** The command comes from their own
 *   settings file only (`editor` is user-only: a project's
 *   `.aico/settings.json` cannot set it — settings-project-policy) or is
 *   VS Code found on the PATH. Nothing from the request names a program.
 * - **No shell.** The program is started with an argument array. On Windows a
 *   `.cmd`/`.bat` launcher (which is what `code` is) can only run through
 *   `cmd.exe`; then every argument is double-quoted and an argument with a
 *   character `cmd` would still interpret (`"`, `%`, `!`, a line break) is
 *   refused — the viewer opens instead.
 * - **Only files of registered projects.** The real path (symlinks
 *   resolved) must lie inside the real path of a project the server knows,
 *   and be a regular file.
 *
 * The viewer route returns a file's text to the client: registered projects
 * only, real path confined, at most 2 MB, text only (a NUL byte means
 * binary), and never a file that looks like credentials (`.env`, keys,
 * `credentials.json` — the list `Git` uses). The API token already lets a
 * client read what the agent can read; these bounds keep it to source code.
 *
 * @module server/editor
 */

import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { looksLikeSecretPath } from '../tools/git.js';

export interface EditorDeps {
  /** Whether a person is behind this request (decision-gate checkHuman). */
  human: () => Promise<{ ok: boolean; reason?: string }>;
  isKnownProject: (dir: string) => Promise<boolean>;
  /** Registered project roots, to find the one an absolute path belongs to. */
  projects: () => Promise<string[]>;
  /** `editor.command` from the person's own settings file. */
  editorCommand: () => string | undefined;
  /** Tests: replaces child_process.spawn. */
  spawn?: (cmd: string, args: string[], opts: SpawnOptions) => ChildProcess;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}

export const VIEWER_MAX_BYTES = 2_000_000;

// ── Command lines ───────────────────────────────────────────────────────────

/** Split a command line into words, honouring double and single quotes (no other shell syntax). */
export function splitCommand(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: '"' | '\'' | undefined;
  let has = false;
  for (const ch of line.trim()) {
    if (quote) { if (ch === quote) quote = undefined; else cur += ch; continue; }
    if (ch === '"' || ch === '\'') { quote = ch; has = true; continue; }
    if (/\s/.test(ch)) { if (cur || has) { out.push(cur); cur = ''; has = false; } continue; }
    cur += ch;
  }
  if (cur || has) out.push(cur);
  return out;
}

/** How each well-known editor opens a file at a line, when the command names no placeholders. */
export function defaultArgs(exe: string): string[] {
  const base = path.basename(exe).toLowerCase().replace(/\.(exe|cmd|bat)$/, '');
  if (/^(code|code-insiders|codium|vscodium|cursor|windsurf|positron)$/.test(base)) return ['-g', '{file}:{line}:{col}'];
  if (/^(idea|idea64|webstorm|webstorm64|pycharm|pycharm64|goland|goland64|phpstorm|phpstorm64|rider|rider64|clion|clion64|rubymine|rubymine64|studio|studio64)$/.test(base)) return ['--line', '{line}', '{file}'];
  if (/^(subl|sublime_text|zed|atom|mate|kate|gedit)$/.test(base)) return ['{file}:{line}'];
  if (/^(notepad\+\+)$/.test(base)) return ['-n{line}', '{file}'];
  return ['{file}'];
}

/** A program on the PATH (with PATHEXT on Windows), or an existing absolute path. */
export function findProgram(name: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): string | undefined {
  const isFile = (p: string): boolean => { try { return fs.statSync(p).isFile(); } catch { return false; } };
  const exts = platform === 'win32' ? (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean).map(e => e.toLowerCase()) : [''];
  if (path.isAbsolute(name)) {
    if (isFile(name)) return name;
    for (const e of exts) if (e && isFile(name + e)) return name + e;
    return undefined;
  }
  if (/[\\/]/.test(name)) return undefined;
  const dirs = (env.PATH ?? env.Path ?? '').split(path.delimiter).filter(Boolean);
  for (const d of dirs) {
    for (const e of platform === 'win32' && !path.extname(name) ? exts : ['']) {
      const p = path.join(d, name + e);
      if (isFile(p)) return p;
    }
  }
  return undefined;
}

export interface EditorPlan { exe: string; args: string[]; label: string }

/** Which program, with which arguments, opens `file` at `line`. Undefined (with why) when none is available. */
export function planEditor(configured: string | undefined, file: string, line: number, col: number, root: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): EditorPlan | { error: string } {
  const words = configured?.trim() ? splitCommand(configured) : ['code'];
  const name = words[0]!;
  const exe = findProgram(name, env, platform);
  if (!exe) {
    return { error: configured?.trim() ? `The editor command "${name}" (settings editor.command) was not found.` : 'VS Code (`code`) is not on the PATH and no editor.command is set.' };
  }
  const template = words.length > 1 ? words.slice(1) : defaultArgs(exe);
  const fill = (w: string): string => w.replace(/\{file\}/g, file).replace(/\{line\}/g, String(line)).replace(/\{col\}/g, String(col)).replace(/\{root\}/g, root);
  const args = template.map(fill);
  // A command with no {file} still gets the file (an editor that takes it last).
  if (!template.some(w => w.includes('{file}'))) args.push(file);
  return { exe, args, label: configured?.trim() ? name : 'VS Code' };
}

/** cmd.exe would still interpret these inside double quotes. */
const CMD_UNSAFE = /["%!\r\n]/;

/** Start the editor; resolves when it started (or failed to). Never a shell on POSIX. */
export function launch(plan: EditorPlan, deps: Pick<EditorDeps, 'spawn' | 'env' | 'platform'>): Promise<{ ok: true } | { ok: false; reason: string }> {
  const platform = deps.platform ?? process.platform;
  const doSpawn = deps.spawn ?? spawn;
  let child: ChildProcess;
  try {
    if (platform === 'win32' && /\.(cmd|bat)$/i.test(plan.exe)) {
      // A batch launcher runs only through cmd.exe: quote every word, refuse what quoting cannot neutralise.
      const words = [plan.exe, ...plan.args];
      if (words.some(w => CMD_UNSAFE.test(w))) return Promise.resolve({ ok: false, reason: 'The path has a character the Windows editor launcher cannot take safely (", %, !).' });
      const comspec = deps.env?.ComSpec ?? process.env.ComSpec ?? 'cmd.exe';
      child = doSpawn(comspec, ['/d', '/s', '/c', `"${words.map(w => `"${w}"`).join(' ')}"`], { detached: true, stdio: 'ignore', windowsHide: true, windowsVerbatimArguments: true, env: deps.env ?? process.env });
    } else {
      child = doSpawn(plan.exe, plan.args, { detached: true, stdio: 'ignore', windowsHide: true, env: deps.env ?? process.env, shell: false });
    }
  } catch (err) {
    return Promise.resolve({ ok: false, reason: `Could not start ${plan.label}: ${(err as Error).message}` });
  }
  return new Promise(resolve => {
    let done = false;
    const finish = (r: { ok: true } | { ok: false; reason: string }): void => { if (!done) { done = true; resolve(r); } };
    child.once('spawn', () => { child.unref?.(); finish({ ok: true }); });
    child.once('error', (err: Error) => finish({ ok: false, reason: `Could not start ${plan.label}: ${err.message}` }));
    const t = setTimeout(() => finish({ ok: true }), 3_000);
    t.unref?.();
  });
}

// ── Paths ───────────────────────────────────────────────────────────────────

const caseless = process.platform === 'win32' || process.platform === 'darwin';
const norm = (p: string): string => (caseless ? p.toLowerCase() : p);

function inside(root: string, target: string): boolean {
  const rel = path.relative(norm(root), norm(target));
  return rel === '' ? false : !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** A file of a registered project, by its real path — or why not. */
export async function projectFile(deps: Pick<EditorDeps, 'isKnownProject' | 'projects'>, projectParam: string | undefined, fileParam: string): Promise<{ root: string; abs: string; rel: string } | { status: number; error: string }> {
  if (!fileParam) return { status: 400, error: 'file required' };
  let root: string | undefined;
  if (projectParam) {
    root = path.resolve(projectParam);
    if (!await deps.isKnownProject(root)) return { status: 403, error: 'not a registered project' };
  } else if (path.isAbsolute(fileParam)) {
    const target = path.resolve(fileParam);
    root = (await deps.projects()).map(p => path.resolve(p)).filter(p => inside(p, target) || norm(p) === norm(target)).sort((a, b) => b.length - a.length)[0];
    if (!root) return { status: 403, error: 'the file is not in a registered project' };
  } else return { status: 400, error: 'path (the project) required for a relative file' };
  let realRoot: string;
  let real: string;
  try {
    realRoot = fs.realpathSync.native(root);
    real = fs.realpathSync.native(path.resolve(root, fileParam));
  } catch {
    return { status: 404, error: 'no such file' };
  }
  if (!inside(realRoot, real)) return { status: 403, error: 'the file is outside the project' };
  let st: fs.Stats;
  try { st = fs.statSync(real); } catch { return { status: 404, error: 'no such file' }; }
  if (!st.isFile()) return { status: 400, error: 'not a file' };
  return { root: realRoot, abs: real, rel: path.relative(realRoot, real).split(path.sep).join('/') };
}

// ── Routes ──────────────────────────────────────────────────────────────────

const intOr = (v: unknown, d: number): number => { const n = Number(v); return Number.isInteger(n) && n > 0 && n < 10_000_000 ? n : d; };

export async function handleEditorRoute(route: string, method: string, body: Record<string, unknown>, query: URLSearchParams, deps: EditorDeps): Promise<{ status: number; body: unknown } | undefined> {
  if (route === 'editor/open') {
    if (method !== 'POST') return { status: 405, body: { error: 'POST only' } };
    // Launching a program needs a person, never only the token (decision-gate).
    const person = await deps.human();
    if (!person.ok) return { status: 403, body: { error: person.reason ?? 'This needs a person in the AICO window.', code: 'human-required' } };
    const f = await projectFile(deps, typeof body.path === 'string' ? body.path : undefined, typeof body.file === 'string' ? body.file : '');
    if ('error' in f) return { status: f.status, body: { error: f.error } };
    const line = intOr(body.line, 1);
    const col = intOr(body.col, 1);
    const plan = planEditor(deps.editorCommand(), f.abs, line, col, f.root, deps.env ?? process.env, deps.platform);
    if ('error' in plan) return { status: 200, body: { opened: false, reason: plan.error, fallback: 'viewer', rel: f.rel, line } };
    const res = await launch(plan, deps);
    return res.ok
      ? { status: 200, body: { opened: true, editor: plan.label, rel: f.rel, line } }
      : { status: 200, body: { opened: false, reason: res.reason, fallback: 'viewer', rel: f.rel, line } };
  }
  if (route === 'editor/file') {
    if (method !== 'GET') return { status: 405, body: { error: 'GET only' } };
    const f = await projectFile(deps, query.get('path') ?? undefined, query.get('file') ?? '');
    if ('error' in f) return { status: f.status, body: { error: f.error } };
    if (looksLikeSecretPath(f.rel)) return { status: 403, body: { error: 'This file looks like it holds credentials; it is not shown here. Open it in your editor.' } };
    const st = fs.statSync(f.abs);
    if (st.size > VIEWER_MAX_BYTES) return { status: 413, body: { error: `The file is ${(st.size / 1e6).toFixed(1)} MB; the viewer shows files up to ${VIEWER_MAX_BYTES / 1e6} MB.` } };
    const buf = fs.readFileSync(f.abs);
    if (buf.subarray(0, 8_192).includes(0)) return { status: 415, body: { error: 'Not a text file.' } };
    return { status: 200, body: { path: f.rel, root: f.root, text: buf.toString('utf8'), size: st.size } };
  }
  return undefined;
}
