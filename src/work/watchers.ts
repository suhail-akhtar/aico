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
 * @module work/watchers
 */

import { exec } from 'child_process';
import fs from 'fs';
import { stat } from 'fs/promises';
import { pushNotification } from '../background/notifications.js';
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
 */
export function watch(spec: WatchSpec, opts: {
  title?: string; parent?: string; sessionId?: string;
} = {}): string {
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

  const watcher: ActiveWatcher = { id, spec, fired: 0, disposed: false };
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
      const res = await fetch(c.url, { signal: AbortSignal.timeout(5_000) });
      if (expect === undefined ? res.ok : res.status === expect) {
        return `${c.url} answered ${res.status}`;
      }
      return undefined;
    });
    return;
  }

  if (c.kind === 'command') {
    const expectExit = c.expectExit ?? 0;
    poll(watcher, c.intervalMs ?? DEFAULT_POLL_MS, () => new Promise(resolve => {
      exec(c.command, {
        cwd: c.cwd, timeout: COMMAND_TIMEOUT_MS, windowsHide: true,
      }, (err) => {
        const code = err ? ((err as NodeJS.ErrnoException & { code?: number }).code ?? 1) : 0;
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
