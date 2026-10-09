/**
 * The ONLY place AICO pushes to, or fetches from, a remote (ADR 0039 section 2, PR mode).
 *
 * ADR 0038 said "Delivery never pushes", and `src/delivery` still does not: its test greps
 * every module there for `push`/`fetch`/`remote`. PR mode is a deliberate, narrow carve-out
 * and it lives here, where the carve-out can be read in one screen and attacked in one test.
 *
 * What is enforced, in code, before git is ever run:
 *
 *  - **Only task branches.** The destination ref must match `^aico/task-[A-Za-z0-9_-]+$`, so
 *    the trunk, any release branch and any protected pattern are unreachable by construction;
 *    a branch equal to the configured trunk is refused too (belt and braces).
 *  - **Never destructive.** The argument list is built here from fixed parts: `push` plus a
 *    plain `refs/heads/X:refs/heads/X` refspec. No `--force`, `--force-with-lease`, `+refspec`,
 *    `--delete`, `:ref`, `--mirror`, `--all`, `--prune`. {@link assertSafePushArgs} re-checks
 *    the final list, and a non-fast-forward is reported as a result for a person to read; it
 *    is never retried harder.
 *  - **The destination host is the connection's.** The URL is the provider's clone URL for the
 *    mapped repo (no userinfo) and its host must be one of the connection's hosts.
 *
 * The credential never touches argv, `.git/config`, the model's environment or its Bash:
 *
 *  - It is resolved from the vault for the clone URL's exact origin (a trusted consumer, ADR 0006).
 *  - It is written to a read-once 0600 file in a fresh 0700 directory (the ADR 0010 sink) and a
 *    tiny `GIT_ASKPASS` script prints it and DELETES the file on first read. The script also
 *    refuses to answer unless git's prompt names the expected host, so a repository whose
 *    config rewrites URLs (`url.<x>.insteadOf`) cannot redirect the token to another host.
 *  - `-c credential.helper=` stops stored helpers; `GIT_TERMINAL_PROMPT=0` stops prompting.
 *  - `-c core.hooksPath=<empty dir>` means no repository hook (a `pre-push`, say) runs while
 *    the token file exists. This closes the window ADR 0039 listed as an honest limit. The
 *    checks Delivery needs have already run on the tree; hooks are the person's own and are
 *    not part of an engine push.
 *  - The directory is removed in `finally`, whatever happened.
 *
 * Honest limits: while git runs, any process of the same user can read the file in that
 * directory (the same exposure ADR 0010 states); on Windows the per-user temp ACL is what
 * protects it.
 *
 * @module connections/git
 */

import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getVault } from '../vault/index.js';
import { sinkRedactText } from '../vault/sink.js';
import * as G from '../delivery/git.js';
import { auditConnection } from './audit.js';
import { CONNECTION_TOOL, originsOf } from './http.js';
import type { StoredConnection } from './types.js';

export const TASK_REF_RE = /^aico\/task-[A-Za-z0-9_-]{1,64}$/;

export class PushRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PushRefused';
  }
}

/** Why a branch may not be pushed, or undefined when it may. Pure. */
export function pushRefusal(branch: string, trunk: string): string | undefined {
  if (!TASK_REF_RE.test(branch)) return `Only task branches (aico/task-<id>) are ever pushed; "${branch.slice(0, 60)}" is not one.`;
  if (branch === trunk) return 'The trunk is never pushed.';
  return undefined;
}

/** The arguments for pushing one task branch. Pure; throws PushRefused for anything else. */
export function buildPushArgs(input: { url: string; branch: string; trunk: string }): string[] {
  const why = pushRefusal(input.branch, input.trunk);
  if (why) throw new PushRefused(why);
  const args = ['push', '--porcelain', input.url, `refs/heads/${input.branch}:refs/heads/${input.branch}`];
  assertSafePushArgs(args, input.trunk);
  return args;
}

const FORBIDDEN_FLAGS = /^--(force|force-with-lease|force-if-includes|delete|mirror|all|prune|tags|follow-tags|no-verify|receive-pack|exec|repo)\b|^-f$|^-d$|^-u$/;

/** The last line of defence: whatever built the list, a destructive push never leaves this function. */
export function assertSafePushArgs(args: readonly string[], trunk: string): void {
  if (args[0] !== 'push') throw new PushRefused('Internal: not a push.');
  const rest = args.slice(1).filter(a => a !== '--porcelain');
  const url = rest[0];
  const refspec = rest[1];
  if (rest.length !== 2 || !url || !refspec) throw new PushRefused('Internal: a push has exactly one remote URL and one refspec.');
  for (const a of rest) if (FORBIDDEN_FLAGS.test(a) || a.startsWith('+') || a.startsWith(':') || a.startsWith('-')) throw new PushRefused(`Refused push argument "${a.slice(0, 40)}".`);
  const m = /^refs\/heads\/(.+):refs\/heads\/(.+)$/.exec(refspec);
  if (!m || m[1] !== m[2]) throw new PushRefused('Internal: the source and destination refs must be the same task branch.');
  const why = pushRefusal(m[2]!, trunk);
  if (why) throw new PushRefused(why);
  if (/^[a-z][a-z0-9+.-]*:\/\/[^/]*@/i.test(url)) throw new PushRefused('The remote URL must not carry credentials.');
}

// ── the credential sink ──────────────────────────────────────────────────

const liveDirs = new Set<string>();
let exitSweep = false;
function installExitSweep(): void {
  if (exitSweep) return;
  exitSweep = true;
  process.once('exit', () => { for (const d of liveDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort at exit */ } } });
}

/** Where git-credential temp files live; the same root custom tools use for secret files (ADR 0010). */
export function gitSecretRoot(): string { return path.join(os.tmpdir(), 'aico-secret-files'); }

const ASKPASS = `#!/bin/sh
# Printed once by AICO for one git call (ADR 0039). Answers only for the expected host; deletes the token file on first read.
case "$1" in
  Username*) case "$1" in *"$AICO_ASKPASS_HOST"*) printf '%s' "$AICO_ASKPASS_USER"; exit 0;; *) exit 1;; esac;;
  Password*)
    case "$1" in *"$AICO_ASKPASS_HOST"*) ;; *) exit 1;; esac
    f="$AICO_ASKPASS_FILE"
    [ -f "$f" ] || exit 1
    cat "$f"
    rm -f "$f"
    exit 0;;
esac
exit 1
`;

interface Sink { dir: string; askpass: string; tokenFile: string; hooks: string }

function makeSink(token: string): Sink {
  fs.mkdirSync(gitSecretRoot(), { recursive: true, mode: 0o700 });
  const dir = fs.mkdtempSync(path.join(gitSecretRoot(), 'git-'));
  fs.chmodSync(dir, 0o700);
  liveDirs.add(dir);
  installExitSweep();
  const tokenFile = path.join(dir, 'token');
  fs.writeFileSync(tokenFile, token, { mode: 0o600, flag: 'wx' });
  const askpass = path.join(dir, 'askpass.sh');
  fs.writeFileSync(askpass, ASKPASS, { mode: 0o700 });
  const hooks = path.join(dir, 'no-hooks');
  fs.mkdirSync(hooks);
  return { dir, askpass, tokenFile, hooks };
}

function dropSink(s: Sink | undefined): void {
  if (!s) return;
  liveDirs.delete(s.dir);
  try { fs.rmSync(s.dir, { recursive: true, force: true }); } catch { /* the exit sweep tries again */ }
}

/** Number of credential temp directories alive right now (tests assert it is zero after a call). */
export function liveGitSecretDirs(): number { return liveDirs.size; }

/** Git's askpass runs through a shell: a path with a space would be split. Use the short name on Windows, else name the fix. */
function spaceFree(p: string): string {
  if (!/\s/.test(p)) return p;
  if (process.platform === 'win32') {
    try {
      const out = execFileSync('cmd', ['/d', '/c', `for %I in ("${p}") do @echo %~sI`], { encoding: 'utf8', windowsHide: true }).trim();
      if (out && !/\s/.test(out)) return out;
    } catch { /* fall through to the message */ }
  }
  throw new PushRefused(`The temporary folder ${p} contains a space, which git's credential prompt cannot handle. Set TEMP/TMPDIR to a path without spaces and try again.`);
}

// ── running git with the sink ────────────────────────────────────────────

export interface GitRun { ok: boolean; code: number; out: string; err: string }

function runGit(cwd: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs: number): Promise<GitRun> {
  return new Promise(resolve => {
    execFile('git', args, { cwd, env, timeout: timeoutMs, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      const code = error ? (typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : 1) : 0;
      resolve({ ok: !error, code, out: String(stdout), err: String(stderr || (error && error.message) || '') });
    });
  });
}

function originOfUrl(url: string): string {
  const u = new URL(url);
  return `${u.protocol}//${u.hostname}:${u.port || (u.protocol === 'https:' ? '443' : '80')}`;
}

function checkRemoteUrl(conn: StoredConnection, url: string): URL {
  let u: URL;
  try { u = new URL(url); } catch { throw new PushRefused('The remote URL is not a valid URL.'); }
  if (u.username || u.password) throw new PushRefused('The remote URL must not carry credentials.');
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && conn.insecureHttp)) throw new PushRefused('Only https remotes are used (plain http only where a person opted in for a private address).');
  if (!conn.hosts.some(h => h.toLowerCase() === u.host.toLowerCase() || h.toLowerCase() === u.hostname.toLowerCase())) {
    throw new PushRefused(`${u.host} is not one of this connection's hosts (${conn.hosts.join(', ')}).`);
  }
  return u;
}

/**
 * Run a git network command (`push` or `fetch`) with the connection's token delivered through the
 * read-once sink. The caller has already validated the arguments; the URL is re-checked here.
 */
async function withToken(conn: StoredConnection, urlStr: string, purpose: string, cwd: string, buildArgs: (sink: Sink) => string[], timeoutMs: number): Promise<GitRun> {
  const url = checkRemoteUrl(conn, urlStr);
  if (!conn.credential) throw new PushRefused('This connection has no token yet.');
  const secret = await getVault().resolve(conn.credential, { tool: CONNECTION_TOOL, origin: originOfUrl(urlStr), purpose: purpose.slice(0, 480) });
  let sink: Sink | undefined;
  try {
    sink = makeSink(secret.value());
  } finally {
    secret.release();
  }
  try {
    const askpass = spaceFree(sink.askpass).replace(/\\/g, '/');
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', GIT_ASKPASS: askpass, SSH_ASKPASS: askpass,
      AICO_ASKPASS_FILE: sink.tokenFile.replace(/\\/g, '/'), AICO_ASKPASS_HOST: url.host, AICO_ASKPASS_USER: 'x-access-token',
      GIT_EDITOR: 'true', GIT_PAGER: 'cat',
      ...(conn.caBundle ? { GIT_SSL_CAINFO: conn.caBundle } : {}),
    };
    const args = ['-c', 'credential.helper=', '-c', `core.hooksPath=${sink.hooks.replace(/\\/g, '/')}`, '-c', 'core.askPass=', ...buildArgs(sink)];
    const r = await runGit(cwd, args, env, timeoutMs);
    return { ...r, out: sinkRedactText(r.out), err: sinkRedactText(r.err) };
  } finally {
    dropSink(sink);
  }
}

export interface PushOutcome { ok: boolean; kind?: 'non-fast-forward' | 'auth' | 'rejected' | 'network'; message: string; upToDate?: boolean }

/** Push one task branch (fast-forward only) from `repo` to the connection's clone URL. */
export async function pushTaskBranch(input: {
  conn: StoredConnection; repo: string; cloneUrl: string; branch: string; trunk: string; project?: string;
}): Promise<PushOutcome> {
  const { conn } = input;
  let args: string[];
  try {
    args = buildPushArgs({ url: input.cloneUrl, branch: input.branch, trunk: input.trunk });
    checkRemoteUrl(conn, input.cloneUrl);
  } catch (e) {
    auditConnection({ action: 'push', connection: conn.id, provider: conn.provider, target: input.cloneUrl, ref: input.branch, outcome: 'denied', detail: (e as Error).message, ...(input.project ? { project: input.project } : {}) });
    return { ok: false, kind: 'rejected', message: (e as Error).message };
  }
  let r: GitRun;
  try {
    r = await withToken(conn, input.cloneUrl, `push ${input.branch} to ${new URL(input.cloneUrl).host}`, input.repo, () => args, 180_000);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    auditConnection({ action: 'push', connection: conn.id, provider: conn.provider, target: input.cloneUrl, ref: input.branch, outcome: 'error', detail: message, ...(input.project ? { project: input.project } : {}) });
    return { ok: false, kind: 'auth', message };
  }
  const text = `${r.out}\n${r.err}`;
  const outcome: PushOutcome = r.ok
    ? { ok: true, message: `Pushed ${input.branch}.`, upToDate: /\bUp to date\b|=\s+refs\/heads/.test(text) && !/^\*\s/m.test(text) }
    : /non-fast-forward|\(fetch first\)|stale info|rejected/i.test(text) && !/denied|403|401|Authentication/i.test(text)
      ? { ok: false, kind: 'non-fast-forward', message: `The remote already has different commits on ${input.branch}. AICO does not force-push; a person must reconcile the branch.` }
      : /Authentication failed|could not read Username|403|401|denied|Permission/i.test(text)
        ? { ok: false, kind: 'auth', message: 'The remote refused the push: the token may lack write access to this repository (Contents: read and write). Check the connection\'s Test result.' }
        : { ok: false, kind: 'network', message: `git push failed: ${text.trim().split('\n').slice(-3).join(' ').slice(0, 300)}` };
  auditConnection({ action: 'push', connection: conn.id, provider: conn.provider, target: input.cloneUrl, ref: input.branch, outcome: outcome.ok ? 'ok' : 'error', detail: outcome.ok ? undefined : outcome.kind, ...(input.project ? { project: input.project } : {}) });
  return outcome;
}

/**
 * Bring the local copy of the trunk up to the remote's, fast-forward only, so the next task's
 * branch starts from what the team has. Fetches into a private ref (nothing under `refs/remotes`
 * is touched), then moves the local trunk only if it is a strict ancestor of what was fetched and
 * nobody has uncommitted work on it. Never throws: it reports what it did.
 */
export async function refreshTrunk(input: {
  conn: StoredConnection; repo: string; cloneUrl: string; trunk: string; project?: string;
}): Promise<{ ok: boolean; moved?: { from: string; to: string }; message: string }> {
  const { conn, repo, trunk } = input;
  if (!/^[A-Za-z0-9._\/-]{1,100}$/.test(trunk) || trunk.startsWith('-')) return { ok: false, message: `The trunk name "${trunk.slice(0, 40)}" is not usable.` };
  const ref = `refs/aico/remote/${trunk}`;
  let r: GitRun;
  try {
    r = await withToken(conn, input.cloneUrl, `fetch ${trunk} from ${new URL(input.cloneUrl).host}`, repo,
      () => ['fetch', '--no-tags', '--no-write-fetch-head', input.cloneUrl, `+refs/heads/${trunk}:${ref}`], 180_000);
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
  if (!r.ok) return { ok: false, message: `Could not fetch ${trunk}: ${`${r.err}`.trim().split('\n').slice(-2).join(' ').slice(0, 240)}` };
  const fetched = await G.revParse(repo, ref);
  const local = await G.revParse(repo, trunk);
  if (!fetched) return { ok: false, message: `The remote has no branch ${trunk}.` };
  if (!local) return { ok: false, message: `There is no local branch ${trunk}.` };
  if (local === fetched) return { ok: true, message: `${trunk} is already current.` };
  if (!(await G.isAncestor(repo, local, fetched))) return { ok: false, message: `The local ${trunk} has commits the remote does not; it was left alone.` };
  const here = await G.currentBranch(repo);
  if (here === trunk) {
    if ((await G.porcelain(repo)).length > 0) return { ok: false, message: `${trunk} is checked out with uncommitted changes, so it was not updated.` };
    const ff = await G.git(['merge', '--ff-only', fetched], repo);
    if (!ff.ok) return { ok: false, message: `Could not fast-forward ${trunk}: ${(ff.err || ff.out).trim().slice(0, 200)}` };
  } else {
    const holder = (await G.worktreeList(repo)).find(w => w.branch === trunk);
    if (holder) return { ok: false, message: `${trunk} is checked out in ${holder.path}, so it was not updated.` };
    const mv = await G.git(['update-ref', `refs/heads/${trunk}`, fetched, local], repo);
    if (!mv.ok) return { ok: false, message: `Could not move ${trunk}: ${(mv.err || mv.out).trim().slice(0, 200)}` };
  }
  return { ok: true, moved: { from: local, to: fetched }, message: `${trunk} moved to the remote's ${fetched.slice(0, 10)}.` };
}
