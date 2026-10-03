/**
 * How many agents one conversation may have running at once.
 *
 * Without a ceiling, nothing bounded the fan-out: an `Investigate` with eight
 * angles started eight model loops in one `Promise.all`, a parent could detach
 * a dozen children, and each of those could delegate again. Every one of them
 * streams from a provider at the same time — the rate limit, not the work,
 * decided what finished — and a runaway parent could spend a session's budget
 * in the minutes before anyone looked. `agents.maxConcurrent` (default
 * {@link DEFAULT_MAX_CONCURRENT}) caps sub-agents, background agents and
 * Investigate workers together, per conversation (ADR 0021).
 *
 * **Queueing, not refusal.** A spawn over the cap waits for a slot and is shown
 * as `queued` in the ledger. Refusing would turn a resource limit into a tool
 * error the model then "works around" by doing the work less carefully itself.
 *
 * **No hold-and-wait deadlock.** A sub-agent that blocks on its own children
 * (a non-detached `Task`, an `Investigate`) suspends its slot while it waits and
 * takes one back afterwards. Without that, six parents each waiting on a child
 * would hold all six slots while their children queued for a seventh that never
 * comes. A suspended holder holds nothing, so every slot is always held by
 * something that can make progress.
 *
 * What it does not do: bound processes (a backgrounded shell command is not a
 * model loop), or share a cap across conversations.
 *
 * @module agents/limiter
 */

export const DEFAULT_MAX_CONCURRENT = 6;

interface Waiter {
  holder: string;
  max: number;
  resolve: () => void;
  reject: (err: Error) => void;
  cleanup: () => void;
}

interface Pool {
  active: Set<string>;
  /** Holders that gave their slot up while blocked on their own children, with a nesting count. */
  suspended: Map<string, number>;
  queue: Waiter[];
}

const pools = new Map<string, Pool>();

function pool(session: string): Pool {
  let p = pools.get(session);
  if (!p) {
    p = { active: new Set(), suspended: new Map(), queue: [] };
    pools.set(session, p);
  }
  return p;
}

/** The ceiling from settings, sanitised: at least 1, defaulting when unset or nonsense. */
export function maxConcurrentFrom(settings: { agents?: { maxConcurrent?: number } } | undefined): number {
  const n = settings?.agents?.maxConcurrent;
  return typeof n === 'number' && Number.isFinite(n) && n >= 1 ? Math.floor(n) : DEFAULT_MAX_CONCURRENT;
}

function pump(session: string): void {
  const p = pools.get(session);
  if (!p) return;
  while (p.queue.length && p.active.size < p.queue[0]!.max) {
    const next = p.queue.shift()!;
    next.cleanup();
    p.active.add(next.holder);
    next.resolve();
  }
  if (!p.active.size && !p.queue.length && !p.suspended.size) pools.delete(session);
}

/**
 * Ask for a slot. `queued` says whether the caller has to wait, so it can say
 * so (the ledger's `queued` state) before it does; `ready` resolves when the
 * slot is held, or rejects when `signal` aborts first — a queued agent that is
 * stopped never starts.
 */
export function acquireSlot(
  session: string, holder: string, max: number, signal?: AbortSignal,
): { queued: boolean; ready: Promise<void> } {
  const p = pool(session);
  if (p.active.has(holder)) return { queued: false, ready: Promise.resolve() };
  if (p.active.size < max && !p.queue.length) {
    p.active.add(holder);
    return { queued: false, ready: Promise.resolve() };
  }
  if (signal?.aborted) return { queued: true, ready: Promise.reject(new Error('aborted while queued')) };
  const ready = new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      const i = p.queue.indexOf(waiter);
      if (i >= 0) p.queue.splice(i, 1);
      reject(new Error('aborted while queued'));
      pump(session);
    };
    const waiter: Waiter = {
      holder, max, resolve, reject,
      cleanup: () => signal?.removeEventListener('abort', onAbort),
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    p.queue.push(waiter);
  });
  // Handled by the caller; this only stops an unobserved rejection taking the process down.
  ready.catch(() => undefined);
  return { queued: true, ready };
}

/** Give a slot back. Safe to call for a holder that never got one. */
export function releaseSlot(session: string, holder: string): void {
  const p = pools.get(session);
  if (!p) return;
  p.active.delete(holder);
  p.suspended.delete(holder);
  pump(session);
}

/** A holder is about to block on its own children: free its slot for them. Nests. */
export function suspendSlot(session: string, holder: string): void {
  const p = pools.get(session);
  if (!p) return;
  const depth = p.suspended.get(holder) ?? 0;
  if (depth === 0 && !p.active.has(holder)) return;
  p.suspended.set(holder, depth + 1);
  if (depth === 0) {
    p.active.delete(holder);
    pump(session);
  }
}

/** The children it waited on are done: take a slot back (waiting for one if they are all busy). */
export function resumeSlot(session: string, holder: string, max: number, signal?: AbortSignal): Promise<void> {
  const p = pools.get(session);
  const depth = p?.suspended.get(holder) ?? 0;
  if (!p || depth === 0) return Promise.resolve();
  if (depth > 1) {
    p.suspended.set(holder, depth - 1);
    return Promise.resolve();
  }
  p.suspended.delete(holder);
  return acquireSlot(session, holder, max, signal).ready;
}

/** Running and waiting counts for one conversation. Diagnostics and tests. */
export function slotState(session: string): { active: number; queued: number; suspended: number } {
  const p = pools.get(session);
  return { active: p?.active.size ?? 0, queued: p?.queue.length ?? 0, suspended: p?.suspended.size ?? 0 };
}

/** Tests only. */
export function resetLimiterForTest(): void {
  for (const p of pools.values()) for (const w of p.queue) { w.cleanup(); w.reject(new Error('reset')); }
  pools.clear();
}
