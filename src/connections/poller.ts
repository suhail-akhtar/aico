/**
 * When the engine looks at the remote (ADR 0039 section 1, "Sync cadence").
 *
 * The local engine has no public address, so there are no webhooks: it polls. To stay polite and
 * to cost nothing when nobody is looking, it polls ONLY while a board with a mapped project is
 * open or its dispatcher is running (the server tells it which, `isActive`), and:
 *
 *  - items every 5 minutes, tasks in `pr` every 60 seconds, backing off (jittered, to 5 minutes)
 *    after a failure so a broken token or an outage is not hammered;
 *  - never while the connection is rate-limited (the HTTP client fails fast; the status chip says so);
 *  - one sync per project at a time (sync.ts), and a board being opened kicks one at once.
 *
 * Each cycle is cheap by construction: lists use `If-None-Match` (a 304 is free of quota), and
 * the per-connection token bucket caps the rate whatever the timers say.
 *
 * What it does not do: decide anything about tasks (sync.ts and Delivery) or make a request itself.
 *
 * @module connections/poller
 */

import { backoffMs } from './ratelimit.js';
import { syncProject, syncStatusOf } from './sync.js';
import * as Store from './store.js';

export const POLL_TICK_MS = 15_000;
export const ITEMS_EVERY_MS = 5 * 60_000;
export const PRS_EVERY_MS = 60_000;

interface Due { items: number; prs: number; failures: number }
const due = new Map<string, Due>();
let timer: NodeJS.Timeout | undefined;
let isActive: (project: string) => boolean = () => false;

export function startConnectionPoller(opts: { isActive: (project: string) => boolean; tickMs?: number }): void {
  isActive = opts.isActive;
  if (timer) return;
  timer = setInterval(() => { void pollOnce().catch(() => undefined); }, opts.tickMs ?? POLL_TICK_MS);
  timer.unref?.();
}

export function stopConnectionPoller(): void {
  if (timer) clearInterval(timer);
  timer = undefined;
  due.clear();
}

/** A board was opened (or a person clicked Sync): look now. */
export function kickProject(project: string): void {
  const d = due.get(project);
  if (d) { d.items = 0; d.prs = 0; }
  if (timer) void pollOnce().catch(() => undefined);
}

/** One pass over every mapped project that is active and due. Exported for tests. */
export async function pollOnce(now = Date.now()): Promise<number> {
  let ran = 0;
  for (const m of Store.allMappings()) {
    const project = m.project;
    if (!isActive(project)) continue;
    const d = due.get(project) ?? { items: 0, prs: 0, failures: 0 };
    due.set(project, d);
    const wantItems = m.workItems.source !== 'off' && now >= d.items;
    const wantPrs = now >= d.prs;
    if (!wantItems && !wantPrs) continue;
    if (syncStatusOf(project).state === 'rate-limited') {
      // The client would fail fast anyway; just wait out the interval.
      d.prs = now + PRS_EVERY_MS; d.items = now + ITEMS_EVERY_MS;
      continue;
    }
    ran++;
    await syncProject(project, { items: wantItems, prs: wantPrs });
    const failed = syncStatusOf(project).state === 'error' || syncStatusOf(project).state === 'rate-limited';
    d.failures = failed ? d.failures + 1 : 0;
    const wait = failed ? backoffMs(d.failures, { base: PRS_EVERY_MS, cap: 5 * 60_000 }) + PRS_EVERY_MS : 0;
    if (wantItems) d.items = now + ITEMS_EVERY_MS + wait;
    d.prs = now + PRS_EVERY_MS + wait;
  }
  return ran;
}
