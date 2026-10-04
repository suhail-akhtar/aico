/**
 * Watchers: wait without spending turns.
 *
 * An agent waiting for a build, a server, or a sibling has one tool today —
 * run something, sleep, run it again. Each cycle is a turn: a full prompt, a
 * full response, a tool call, for the privilege of learning that nothing has
 * changed yet. Ten of those is ten turns and ten prompts, and the model has to
 * *remember* to keep checking, so the common failure is not the expensive loop
 * — it is the agent that checks twice, decides it is probably fine, and moves
 * on.
 *
 * A watcher costs one turn to register and one to be woken by, and the platform
 * does the checking. That is the whole idea.
 *
 * ## The wake path already exists
 *
 * `Inbox.inject(content, { kind: 'plugin', plugin: 'supervisor' })` delivers a
 * message to a running turn at its next **step boundary** — the only point at
 * which something can arrive without discarding what the turn has already
 * learned. It is durable, it is recorded in the session log as an injection
 * rather than as something a person typed, and it is already wired. So a
 * watcher does not need a delivery mechanism; it needs a condition and a
 * pointer at that one.
 *
 * ## Polling, mostly, and honest about it
 *
 * `file` and `log` use `fs.watch` where the platform provides it. The rest
 * poll, because an HTTP endpoint and a shell command have nothing to subscribe
 * to. Polling on a timer the platform owns is still strictly better than
 * polling from inside the agent: the interval is not paid for in tokens, it
 * does not depend on the model choosing to look again, and it keeps going while
 * the agent does something else.
 *
 * ## Unattended, so guarded here (security review 2026-10, D4/D5)
 *
 * The condition is model-chosen and re-checked every few seconds with nobody
 * watching, so the checks live in this module rather than in the tool that
 * registers it:
 *   - `http` goes through the SSRF guard (`guardedFetch`): http(s) only,
 *     public addresses only, pinned, redirects re-checked, size and time caps.
 *     Loopback is refused too — the engine's own API lives there. A local dev
 *     server is waited on with a read-only `command` (`curl -sf …`) instead.
 *   - `command` is refused when the bash classifier blocks it, and runs
 *     without a person only when it is read-only (`isBashReadOnly`); anything
 *     else needs `approvedByPerson`, which only the tool's approval card sets.
 *     Both checks repeat before every run, together with the person's own
 *     `disabledTools`, because settings change while a watcher lives. A plain
 *     command runs through `execFile` (no shell); only one that needs a shell
 *     (a pipe, a quote, a builtin) gets one.
 *
 * @module work/watchers
 */

import { exec, execFile } from 'child_process';
import fs from 'fs';
import { stat } from 'fs/promises';
import net from 'net';
import { pushNotification } from '../background/notifications.js';
import { guardedFetch, type Fetcher } from '../canvas/deck-media.js';
import { classifyBashCommand, isBashReadOnly } from '../safety.js';
import { readUserSettingsFile } from '../settings-project-policy.js';
import { classifyAddress } from '../tools/ops/ssrf.js';
import { clearStopHandle, registerStopHandle } from './handles.js';
import { ledger } from './ledger.js';
import { pidAlive } from './store.js';
import type { WatchCondition, WatchSpec, WorkRecord } from './types.js';

/** Default poll interval for the conditions that have nothing to subscribe to. */
const DEFAULT_POLL_MS = 2_000;

/** Default settle time for file changes. Editors write a file more than once. */
const DEFAULT_DEBOUNCE_MS = 250;

/** A command watcher that runs longer than this is treated as "not yet". */
const COMMAND_TIMEOUT_MS = 30_000;

/** Response bytes an `http` watcher reads: only the status matters. */
const HTTP_MAX_BYTES = 64 * 1024;

let fetcher: Fetcher = guardedFetch;

/** Swap the http watcher's fetcher. Tests only (a live probe's loopback server). */
export function setWatcherFetcherForTest(next: Fetcher | undefined): void {
  fetcher = next ?? guardedFetch;
}

/** Why a watcher may not run this command, or undefined when it may. */
export interface CommandRefusal {
  /** `block`: never runs. `needs-person`: runs only once a person approves it. `disabled`: the person switched shell commands off. */
  kind: 'block' | 'needs-person' | 'disabled';
  message: string;
}

/**
 * Whether a watcher may run `command` now. Checked at creation and again
 * before every run, so a settings change or a newly blocked pattern stops a
 * watcher that was armed before it.
 */
export function watchCommandRefusal(command: string, approvedByPerson = false): CommandRefusal | undefined {
  const safety = classifyBashCommand(command);
  if (safety.level === 'block') {
    return { kind: 'block', message: `BLOCKED: ${safety.reason}. A watcher will never run this command.` };
  }
  const disabled = readUserSettingsFile().disabledTools;
  if (Array.isArray(disabled) && disabled.includes('Bash')) {
    return { kind: 'disabled', message: 'Shell commands are disabled in your settings (disabledTools: Bash), so a command watcher cannot run.' };
  }
  if (!approvedByPerson && !isBashReadOnly(command)) {
    return {
      kind: 'needs-person',
      message: `\`${command.slice(0, 120)}\` is not a read-only command, and a watcher runs it repeatedly with nobody watching. `
        + 'Only read-only commands (git status, ls, grep, curl -sf <url>, …) run without a person approving the watcher. '
        + 'Fix: watch a file, log, process or work item instead, use a read-only command, or ask from a chat where the person can approve it.',
    };
  }
  return undefined;
}

/**
 * The synchronous half of the SSRF check for an `http` watcher: scheme,
 * credentials, and a host that is an address literal or `localhost`. Names
 * are resolved and checked again by `guardedFetch` on every poll.
 */
export function watchUrlRefusal(raw: string): string | undefined {
  let u: URL;
  try { u = new URL(raw); } catch { return `not a URL: ${String(raw).slice(0, 80)}`; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return `only http(s) URLs are watched, not ${u.protocol}`;
  if (u.username || u.password) return 'a URL with credentials in it is not watched';
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase().replace(/\.$/, '');
  const cls = host === 'localhost' || host.endsWith('.localhost') ? 'loopback' : net.isIP(host) ? classifyAddress(host) : 'public';
  if (cls !== 'public') {
    return `${u.hostname} is a ${cls} address; an http watcher reaches public addresses only. `
      + 'For a local dev server, watch it with a read-only command instead: {kind:"command",command:"curl -sf <url>"}.';
  }
  return undefined;
}

/** A guard refusal that will not change on the next poll (as opposed to "not up yet"). */
function permanentFetchRefusal(err: unknown): string | undefined {
  const msg = err instanceof Error ? err.message : String(err);
  if (/did not resolve/.test(msg)) return undefined;
  return /^(?:refused:|only http|a URL with credentials|not a URL|too many redirects)/.test(msg) ? msg : undefined;
}

/**
 * Run a watcher's command. A command of plain words goes to `execFile` with
 * an argument array (no shell); one that needs a shell — a pipe, a quote, a
 * variable, a shell builtin that is not a program on PATH — falls back to it.
 */
function runCommand(command: string, cwd: string | undefined, done: (code: number | string) => void): void {
  const opts = { cwd, timeout: COMMAND_TIMEOUT_MS, windowsHide: true };
  const viaShell = (): void => {
    // security-allow: exec-interpolated — the shell is the condition's meaning (pipes, builtins); only reached after watchCommandRefusal passed for this run
    exec(command, opts, (err) => { done(err ? ((err as NodeJS.ErrnoException & { code?: number }).code ?? 1) : 0); });
  };
  if (!/^[\w@+=:,./\\ -]+$/.test(command.trim())) { viaShell(); return; }
  const [file, ...args] = command.trim().split(/\s+/);
  execFile(file!, args, { ...opts, shell: false }, (err) => {
    if (err && (err as NodeJS.ErrnoException).code === 'ENOENT') { viaShell(); return; }
    done(err ? ((err as NodeJS.ErrnoException & { code?: number }).code ?? 1) : 0);
  });
}

/**
 * How a watcher reaches a session.
 *
 * Injected rather than imported so this module does not depend on the server,
 * the REPL, or the session registry — all three of which import work of their
 * own. The host wires this once at boot; without it a watcher still fires and
 * still notifies, it just cannot resume a conversation.
 */
export interface WakeDelivery {
  /** Deliver at the running turn's next step boundary. */
  steer(sessionId: string, message: string): boolean;
  /** Queue as a new turn, to be picked up when the current one ends. */
  followup(sessionId: string, message: string): boolean;
}

let delivery: WakeDelivery | undefined;

export function setWakeDelivery(next: WakeDelivery | undefined): void {
  delivery = next;
}

/** The wired delivery, for the other things that wake a session (the approve-later inbox). */
export function wakeDelivery(): WakeDelivery | undefined {
  return delivery;
}

interface ActiveWatcher {
  id: string;
  spec: WatchSpec;
  timer?: NodeJS.Timeout;
  fsWatcher?: fs.FSWatcher;
  debounce?: NodeJS.Timeout;
  /** For `log`: how far into the file we have already read. */
  offset?: number;
  /** For `file`: the last modification time seen, so a poll can spot a change. */
  seenMtime?: number;
  /**
   * For `file`: whether the path existed when the watcher was armed.
   *
   * The whole behaviour turns on this. If it existed, the event is a
   * *modification* and the baseline mtime is what to compare against. If it did
   * not, the event is the file *appearing* — which is the more common ask
   * ("tell me when the build writes the bundle") and the one that was silently
   * broken: the first poll to find the file recorded it as the baseline and
   * waited for a second change that never came.
   */
  existedAtArm?: boolean;
  /** For `command`: a person approved this exact command when the watcher was created. */
  approvedByPerson: boolean;
  fired: number;
  disposed: boolean;
}

const active = new Map<string, ActiveWatcher>();

/**
 * Start watching. Returns the ledger id, which is also the watcher's id.
 *
 * The watcher is a ledger record like anything else — it shows up in `list`,
 * it can be stopped by id, and it is reconciled on restart. A watcher that
 * lived outside the ledger would be the sixth registry this work exists to
 * remove.
 *
 * Throws, before anything is recorded, when the condition may not be watched
 * (an http URL the SSRF guard refuses, a command the classifier blocks or that
 * is not read-only and no person approved). `approvedByPerson` must only be
 * set by a caller that showed a person this exact command and got a yes.
 */
export function watch(spec: WatchSpec, opts: {
  title?: string; parent?: string; sessionId?: string; approvedByPerson?: boolean;
} = {}): string {
  const cond = spec.condition;
  if (cond.kind === 'http') {
    // Skipped only while a test has swapped the fetcher (a loopback probe server).
    const refused = fetcher === guardedFetch ? watchUrlRefusal(cond.url) : undefined;
    if (refused) throw new Error(refused);
  }
  if (cond.kind === 'command') {
    const refused = watchCommandRefusal(cond.command, opts.approvedByPerson === true);
    if (refused) throw new Error(refused.message);
  }
  const id = ledger.open({
    kind: 'watcher',
    title: opts.title ?? describe(spec.condition),
    origin: 'model',
    // A watcher is waiting by definition. `blocked` rather than `running` keeps
    // the supervisor's idle timer off it — see the supervisor's sweep.
    state: 'blocked',
    ...(opts.parent ? { parent: opts.parent } : {}),
    ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
  });

  const watcher: ActiveWatcher = { id, spec, approvedByPerson: opts.approvedByPerson === true, fired: 0, disposed: false };
  active.set(id, watcher);

  registerStopHandle(id, () => { dispose(id); });

  if (spec.expiresInMs !== undefined) {
    const expiry = setTimeout(() => {
      if (!active.has(id)) return;
      dispose(id);
      ledger.close(id, 'done', `Expired after ${Math.round(spec.expiresInMs! / 1000)}s without firing`);
    }, spec.expiresInMs);
    expiry.unref?.();
  }

  arm(watcher);
  return id;
}

/** Stop watching, without recording an outcome. */
export function unwatch(id: string, reason = 'Stopped'): boolean {
  if (!active.has(id)) return false;
  dispose(id);
  return ledger.close(id, 'cancelled', reason);
}

export function activeWatcherCount(): number {
  return active.size;
}

function dispose(id: string): void {
  const watcher = active.get(id);
  if (!watcher) return;
  watcher.disposed = true;
  if (watcher.timer) clearInterval(watcher.timer);
  if (watcher.debounce) clearTimeout(watcher.debounce);
  try { watcher.fsWatcher?.close(); } catch { /* already closed */ }
  active.delete(id);
  clearStopHandle(id);
}

/** A one-line description, used as the title when the caller gives none. */
export function describe(condition: WatchCondition): string {
  switch (condition.kind) {
    case 'file':    return `Watch ${condition.path}`;
    case 'process': return `Watch pid ${condition.pid}`;
    case 'http':    return `Watch ${condition.url}`;
    case 'command': return `Watch \`${condition.command}\``;
    case 'work':    return `Watch work ${condition.workId}`;
    case 'log':     return `Watch ${condition.path} for /${condition.pattern}/`;
  }
}

function poll(watcher: ActiveWatcher, ms: number, check: () => Promise<string | undefined>): void {
  const timer = setInterval(() => {
    void check().then(hit => {
      if (hit !== undefined && !watcher.disposed) fire(watcher, hit);
    }).catch(() => {
      // A condition that throws has not been met. A DNS failure on an `http`
      // watcher is the normal state of a server that has not started yet, and
      // treating it as a firing would wake the agent to say "it is not ready".
    });
  }, ms);
  timer.unref?.();
  watcher.timer = timer;
}

/** Stop a watcher the guards no longer allow, recording why and telling the person. */
function refuse(watcher: ActiveWatcher, reason: string): void {
  if (watcher.disposed) return;
  const title = ledger.get(watcher.id)?.title ?? 'Watcher stopped';
  dispose(watcher.id);
  ledger.close(watcher.id, 'failed', reason);
  pushNotification({ title, body: reason, level: 'warning', sourceId: watcher.id });
}

function arm(watcher: ActiveWatcher): void {
  const c = watcher.spec.condition;

  if (c.kind === 'file') {
    const debounceMs = c.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    // The baseline is established *before* anything starts watching, because
    // whether the path existed at arm time decides what counts as the event.
    // Doing this concurrently with the watch was the bug: the first poll to
    // find a newly-created file recorded it as the baseline instead of firing.
    void stat(c.path).then(
      s => { watcher.seenMtime = s.mtimeMs; watcher.existedAtArm = true; },
      () => { watcher.existedAtArm = false; },
    ).then(() => {
      if (watcher.disposed) return;
      if (!watcher.existedAtArm) {
        // Nothing to hand `fs.watch`. Poll until it shows up; its appearance is
        // the firing.
        pollFile(watcher, c.path, debounceMs);
        return;
      }
      try {
        const fsWatcher = fs.watch(c.path, { persistent: false }, () => {
          if (watcher.debounce) clearTimeout(watcher.debounce);
          watcher.debounce = setTimeout(() => {
            if (!watcher.disposed) fire(watcher, `${c.path} changed`);
          }, debounceMs);
          watcher.debounce.unref?.();
        });
        fsWatcher.on('error', () => {
          // The path went away, or the platform gave up on it. Fall back to
          // polling rather than silently watching nothing for the rest of the run.
          try { fsWatcher.close(); } catch { /* ignore */ }
          watcher.fsWatcher = undefined;
          pollFile(watcher, c.path, debounceMs);
        });
        watcher.fsWatcher = fsWatcher;
      } catch {
        pollFile(watcher, c.path, debounceMs);
      }
    });
    return;
  }

  if (c.kind === 'process') {
    poll(watcher, DEFAULT_POLL_MS, async () =>
      pidAlive(c.pid) ? undefined : `pid ${c.pid} exited`);
    return;
  }

  if (c.kind === 'http') {
    const expect = c.expectStatus;
    poll(watcher, c.intervalMs ?? DEFAULT_POLL_MS, async () => {
      let res;
      try {
        res = await fetcher(c.url, { maxBytes: HTTP_MAX_BYTES, timeoutMs: 5_000 });
      } catch (err) {
        // The guard said no (a name that resolves to loopback, metadata, a
        // redirect into either): that will not change, so stop rather than
        // re-asking every poll. Anything else is "not up yet".
        const refused = permanentFetchRefusal(err);
        if (refused) { refuse(watcher, `http watcher stopped: ${refused}`); return undefined; }
        throw err;
      }
      const ok = res.status >= 200 && res.status < 300;
      if (expect === undefined ? ok : res.status === expect) {
        return `${c.url} answered ${res.status}`;
      }
      return undefined;
    });
    return;
  }

  if (c.kind === 'command') {
    const expectExit = c.expectExit ?? 0;
    poll(watcher, c.intervalMs ?? DEFAULT_POLL_MS, () => new Promise(resolve => {
      // Again before every run: the classifier or the person's settings may
      // have changed since the watcher was armed.
      const refused = watchCommandRefusal(c.command, watcher.approvedByPerson);
      if (refused) { refuse(watcher, `command watcher stopped: ${refused.message}`); resolve(undefined); return; }
      runCommand(c.command, c.cwd, (code) => {
        resolve(code === expectExit ? `\`${c.command}\` exited ${code}` : undefined);
      });
    }));
    return;
  }

  if (c.kind === 'work') {
    const wanted = c.states ?? ['done', 'failed', 'cancelled', 'lost'];
    // Subscribing rather than polling: the ledger already tells everyone when
    // anything changes, so a timer here would be strictly worse.
    const unsubscribe = ledger.subscribe(() => {
      if (watcher.disposed) return;
      const target = ledger.get(c.workId);
      if (target && wanted.includes(target.state)) {
        unsubscribe();
        fire(watcher, `${target.title} is ${target.state}`
          + (target.error ? ` — ${target.error}` : ''));
      }
    });
    return;
  }

  if (c.kind === 'log') {
    const pattern = new RegExp(c.pattern);
    // Start at the current end of the file. Matching what was already written
    // would fire instantly on a log that has been running for an hour, which is
    // never what "tell me when this appears" means.
    void stat(c.path).then(s => { watcher.offset = s.size; }).catch(() => { watcher.offset = 0; });
    poll(watcher, DEFAULT_POLL_MS, async () => {
      const s = await stat(c.path);
      const from = watcher.offset ?? 0;
      if (s.size <= from) {
        // Truncated or rotated: start again from the new end rather than
        // reading a negative range.
        if (s.size < from) watcher.offset = s.size;
        return undefined;
      }
      const chunk = await readRange(c.path, from, s.size);
      watcher.offset = s.size;
      const line = chunk.split('\n').find(l => pattern.test(l));
      return line ? `matched: ${line.trim().slice(0, 200)}` : undefined;
    });
    return;
  }
}

function pollFile(watcher: ActiveWatcher, target: string, debounceMs: number): void {
  poll(watcher, Math.max(debounceMs, DEFAULT_POLL_MS), async () => {
    const s = await stat(target).catch(() => undefined);
    if (!s) return undefined;
    // It did not exist when we started, so existing at all is the answer.
    if (watcher.existedAtArm === false) return `${target} appeared`;
    if (watcher.seenMtime === undefined) { watcher.seenMtime = s.mtimeMs; return undefined; }
    if (s.mtimeMs !== watcher.seenMtime) {
      watcher.seenMtime = s.mtimeMs;
      return `${target} changed`;
    }
    return undefined;
  });
}

function readRange(file: string, from: number, to: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    fs.createReadStream(file, { start: from, end: Math.max(from, to - 1) })
      .on('data', c => chunks.push(c as Buffer))
      .on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
      .on('error', reject);
  });
}

/**
 * The condition was met.
 *
 * Delivery is best-effort and the notification is not: if the session is gone,
 * or nothing wired a delivery, the tray still gets it. A watcher that fires
 * into silence because the conversation moved on is how someone learns their
 * deploy finished an hour after it did.
 */
function fire(watcher: ActiveWatcher, detail: string): void {
  watcher.fired++;
  const { wake } = watcher.spec;
  const record = ledger.get(watcher.id);
  const message = wake.message ? `${wake.message}\n\n(${detail})` : detail;

  let delivered = false;
  if (wake.as !== 'notification' && delivery) {
    delivered = wake.as === 'steer'
      ? delivery.steer(wake.sessionId, message)
      : delivery.followup(wake.sessionId, message);
  }

  if (!delivered) {
    pushNotification({
      title: record?.title ?? 'Watcher fired',
      body: detail,
      level: 'info',
      sourceId: watcher.id,
    });
  }

  if ((watcher.spec.until ?? 'first') === 'first') {
    dispose(watcher.id);
    ledger.close(watcher.id, 'done', detail);
  } else {
    ledger.beat(watcher.id, {
      steps: watcher.fired,
      note: `fired ${watcher.fired}× — ${detail}`,
    });
  }
}

/** Re-arm nothing and forget everything. Tests only. */
export function resetWatchersForTest(): void {
  for (const id of [...active.keys()]) dispose(id);
  delivery = undefined;
}

export type { WatchSpec, WatchCondition, WorkRecord };
