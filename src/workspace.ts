import path from 'path';
import { mkdir, readFile, readdir, stat, writeFile } from 'fs/promises';
import { existsSync, realpathSync } from 'fs';
import { aicoHome } from './home.js';
import crypto from 'crypto';
import type { AicoSettings } from './settings.js';
import { saveProjectWorkspacePath } from './settings.js';
import { currentRunContext } from './run-context.js';

export type WorkspaceScope = 'session' | 'common';

export interface WorkspaceContext {
  settings?: AicoSettings;
  sessionId?: string;
  cwd?: string;
}

export interface WorkspaceInfo {
  root: string;
  configuredPath?: string;
  sessionId?: string;
  commonDir: string;
  sessionsDir: string;
  sessionDir?: string;
  artifactsDir?: string;
  reportsDir?: string;
  logsDir?: string;
  scratchDir?: string;
}

let runtimeSessionId: string | undefined;
let runtimeSettings: AicoSettings | undefined;

export function setWorkspaceRuntime(ctx: WorkspaceContext): void {
  runtimeSessionId = ctx.sessionId ?? runtimeSessionId;
  runtimeSettings = ctx.settings ?? runtimeSettings;
}

/**
 * The active run's workspace context.
 *
 * Reads the async-local run context first and falls back to the module-level
 * values. The fallback is for the CLI, where there is one run and the globals
 * are unambiguous; inside the server, where several runs share the process, the
 * run context is the only answer that is correct per-caller.
 */
export function getWorkspaceRuntime(): WorkspaceContext {
  const run = currentRunContext();
  return {
    settings: run?.settings ?? runtimeSettings,
    sessionId: run?.sessionId ?? runtimeSessionId,
    cwd: run?.cwd ?? process.cwd(),
  };
}

function cleanSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120);
}

function projectWorkspaceDir(projectPath: string): string {
  const projectName = cleanSegment(path.basename(projectPath) || 'project');
  const hash = crypto.createHash('sha1').update(projectPath.toLowerCase()).digest('hex').slice(0, 10);
  return path.join(aicoHome(), 'workspace', 'projects', `${projectName}-${hash}`);
}

/**
 * The per-project workspace, keyed by the project's canonical path.
 *
 * Canonical means resolved, then `realpath.native` — so `C:\Users\SUHAIL~1\x`
 * and `C:\Users\Suhail Akhtar\x`, or a symlink and its target, are one
 * project — then lower-cased, as the key always was (drive-letter case).
 * Where canonicalising changed the spelling and only the folder under the
 * old spelling exists, that folder is kept: an existing workspace stays where
 * its files are rather than silently starting over beside them.
 */
function defaultProjectWorkspaceRoot(cwd: string): string {
  const resolved = path.resolve(cwd);
  let canonical = resolved;
  try { canonical = realpathSync.native(resolved); } catch { /* not on disk yet: the resolved path is all there is */ }
  const preferred = projectWorkspaceDir(canonical);
  if (canonical.toLowerCase() !== resolved.toLowerCase() && !existsSync(preferred)) {
    const legacy = projectWorkspaceDir(resolved);
    if (existsSync(legacy)) return legacy;
  }
  return preferred;
}

export function resolveWorkspaceRoot(settings?: AicoSettings, cwd = process.cwd()): string {
  const configured = settings?.workspace?.path;
  if (!configured) {
    /*
      A cwd that already is a workspace root names itself.

      Sessions bound to an app run with the workspace root as their cwd. Without
      this, resolving from there derived a second root nested under the first —
      the app the session was bound to was then "not found", and its logs and
      sessions went to a directory nobody ever opens.
    */
    return isDefaultWorkspaceRoot(cwd) ? path.resolve(cwd) : defaultProjectWorkspaceRoot(cwd);
  }
  return path.isAbsolute(configured) ? configured : path.resolve(cwd, configured);
}

function isDefaultWorkspaceRoot(dir: string): boolean {
  const projects = path.join(aicoHome(), 'workspace', 'projects');
  const rel = path.relative(projects, path.resolve(dir));
  return rel.length > 0 && !rel.startsWith('..') && !path.isAbsolute(rel) && !rel.includes(path.sep);
}

/*
  Defaults come from the run context (getWorkspaceRuntime), never straight from
  `process.cwd()` and the module globals. They did, and the two halves of the
  workspace disagreed: WorkspaceInfo/WorkspaceWrite keyed the folder by the
  server's launch directory while Write's guard (`writableRoots`) keyed it by
  the run's project — two folders, `enterprise-api-b43bb0eed1` and
  `-c3dc124cf7`, and a file WorkspaceWrite had just written was "outside the
  AICO workspace" to Write. The session id had the same flaw: a sub-agent's
  `setWorkspaceRuntime` left `sub-…` in the global, and the parent's next
  WorkspaceWrite landed in the sub-agent's session folder.
*/
export function getWorkspaceInfo(ctx: WorkspaceContext = {}): WorkspaceInfo {
  const runtime = getWorkspaceRuntime();
  const settings = ctx.settings ?? runtime.settings;
  const cwd = ctx.cwd ?? runtime.cwd ?? process.cwd();
  const sessionId = ctx.sessionId ?? runtime.sessionId;
  const root = resolveWorkspaceRoot(settings, cwd);
  const sessionsDir = path.join(root, 'sessions');
  const sessionDir = sessionId ? path.join(sessionsDir, cleanSegment(sessionId)) : undefined;
  return {
    root,
    configuredPath: settings?.workspace?.path,
    sessionId,
    commonDir: path.join(root, 'common'),
    sessionsDir,
    sessionDir,
    artifactsDir: sessionDir ? path.join(sessionDir, 'artifacts') : undefined,
    reportsDir: sessionDir ? path.join(sessionDir, 'reports') : undefined,
    logsDir: sessionDir ? path.join(sessionDir, 'logs') : undefined,
    scratchDir: sessionDir ? path.join(sessionDir, 'scratch') : undefined,
  };
}

export async function ensureWorkspace(ctx: WorkspaceContext = {}): Promise<WorkspaceInfo> {
  const info = getWorkspaceInfo(ctx);
  await mkdir(info.commonDir, { recursive: true });
  await mkdir(info.sessionsDir, { recursive: true });
  if (info.sessionDir) {
    await mkdir(info.sessionDir, { recursive: true });
    await mkdir(info.artifactsDir!, { recursive: true });
    await mkdir(info.reportsDir!, { recursive: true });
    await mkdir(info.logsDir!, { recursive: true });
    await mkdir(info.scratchDir!, { recursive: true });
  }
  return info;
}

function assertInside(parent: string, target: string): void {
  const rel = path.relative(parent, target);
  if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) return;
  throw new Error(`Path escapes workspace: ${target}`);
}

export function resolveWorkspacePath(
  relativePath: string,
  opts: WorkspaceContext & { scope?: WorkspaceScope } = {},
): string {
  if (!relativePath || path.isAbsolute(relativePath)) {
    throw new Error('Workspace path must be a non-empty relative path');
  }
  const info = getWorkspaceInfo(opts);
  const base = opts.scope === 'common'
    ? info.commonDir
    : (info.sessionDir ?? info.commonDir);
  const target = path.resolve(base, relativePath);
  assertInside(base, target);
  return target;
}

export async function writeWorkspaceFile(input: {
  path: string;
  content: string;
  scope?: WorkspaceScope;
  settings?: AicoSettings;
  sessionId?: string;
  cwd?: string;
}): Promise<{ path: string; bytes: number }> {
  await ensureWorkspace(input);
  const target = resolveWorkspacePath(input.path, input);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, input.content, 'utf8');
  return { path: target, bytes: Buffer.byteLength(input.content, 'utf8') };
}

export async function readWorkspaceFile(input: {
  path: string;
  scope?: WorkspaceScope;
  settings?: AicoSettings;
  sessionId?: string;
  cwd?: string;
}): Promise<string> {
  const target = resolveWorkspacePath(input.path, input);
  return readFile(target, 'utf8');
}

export async function listWorkspace(input: {
  path?: string;
  scope?: WorkspaceScope;
  settings?: AicoSettings;
  sessionId?: string;
  cwd?: string;
} = {}): Promise<string> {
  await ensureWorkspace(input);
  const info = getWorkspaceInfo(input);
  const base = input.scope === 'common' ? info.commonDir : (info.sessionDir ?? info.commonDir);
  const target = input.path ? resolveWorkspacePath(input.path, input) : base;
  assertInside(base, target);
  const entries = await readdir(target, { withFileTypes: true });
  const lines = await Promise.all(entries.map(async (entry) => {
    const full = path.join(target, entry.name);
    const s = await stat(full);
    const kind = entry.isDirectory() ? 'dir ' : 'file';
    return `${kind} ${String(s.size).padStart(8)} ${entry.name}`;
  }));
  return lines.join('\n') || '(empty)';
}

export async function setProjectWorkspacePath(workspacePath?: string): Promise<string> {
  await saveProjectWorkspacePath(workspacePath);
  const settings: AicoSettings = { ...(runtimeSettings ?? {}), workspace: { path: workspacePath ?? '' } };
  runtimeSettings = settings;
  const info = await ensureWorkspace({ settings });
  return workspacePath
    ? `Workspace path saved to .aico/settings.local.json\nWorkspace: ${info.root}`
    : `Workspace reset to default path\nWorkspace: ${info.root}`;
}

export function formatWorkspaceInfo(info: WorkspaceInfo): string {
  return [
    `Workspace root : ${info.root}`,
    `Configured path: ${info.configuredPath || '(default ~/.aico/workspace/projects/<project>)'}`,
    `Session ID     : ${info.sessionId ?? '(none)'}`,
    `Common dir     : ${info.commonDir}`,
    `Sessions dir   : ${info.sessionsDir}`,
    ...(info.sessionDir ? [
      `Session dir    : ${info.sessionDir}`,
      `Artifacts      : ${info.artifactsDir}`,
      `Reports        : ${info.reportsDir}`,
      `Logs           : ${info.logsDir}`,
      `Scratch        : ${info.scratchDir}`,
    ] : []),
  ].join('\n');
}
