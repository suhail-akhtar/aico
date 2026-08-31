/**
 * The ledger: the one place that knows what is running.
 *
 * An in-memory index that is the source of truth for this process, backed by an
 * append-only log that is the source of truth across restarts. Everything
 * long-lived registers here — sub-agents, background agents, cron firings,
 * backgrounded shell commands, Mini App servers, watchers.
 *
 * ## Not every write hits the disk
 *
 * Heartbeats arrive on every tool call of every running agent. Persisting each
 * one would turn a supervision aid into a disk-thrash, and buy nothing: the
 * exact step count at the moment of a crash is not information anybody acts on.
 * So state transitions are written immediately and progress is written at most
 * once every {@link BEAT_FLUSH_MS} — with a final flush on the way to a
 * terminal state, so what is on disk when the process dies is the last thing
 * that actually mattered.
 *
 * ## Reconciliation is the point of persisting at all
 *
 * A record left `running` in the log by a process that is no longer alive is
 * the single most useful thing here. Today a crash loses in-flight work
 * silently — the registry was a `Map`, the `Map` is gone, and nothing can tell
 * "finished" from "never came back". After a reconcile it is a fact the next
 * turn is handed.
 *
 * @module work/ledger
 */

import { randomUUID } from 'crypto';
import { clearStopHandle } from './handles.js';
import {
  appendWorkEvent, compactWorkLog, pidAlive, readWorkLog, shouldCompact,
} from './store.js';
import type {
  SupervisionPolicy, WorkCost, WorkKind, WorkOrigin, WorkProgress, WorkRecord, WorkState,
} from './types.js';
import { isTerminal } from './types.js';

/** How often progress-only changes are allowed to reach the disk. */
const BEAT_FLUSH_MS = 15_000;

export interface OpenWorkOptions {
  kind: WorkKind;
  title: string;
  origin: WorkOrigin;
  /** Supply one to adopt an existing id — how adapters keep their own ids. */
  id?: string;
  parent?: string;
  sessionId?: string;
  pid?: number;
  policy?: SupervisionPolicy;
  /** Start `queued` rather than `running`, for work that is not moving yet. */
  state?: WorkState;
}

export interface WorkQuery {
  kind?: WorkKind | WorkKind[];
  state?: WorkState | WorkState[];
  sessionId?: string;
  parent?: string;
  origin?: WorkOrigin;
  /** Only work that has finished without the orchestrator being told. */
  unreported?: boolean;
  /** Only work that is still going. Shorthand for the three live states. */
  live?: boolean;
}

type Listener = (records: WorkRecord[]) => void;

function asArray<T>(value: T | T[] | undefined): T[] | undefined {
  if (value === undefined) return undefined;
  return Array.isArray(value) ? value : [value];
}

class Ledger {
  private records = new Map<string, WorkRecord>();
  private listeners = new Set<Listener>();
  /** Last time each record's progress was flushed, so beats can be throttled. */
  private lastFlush = new Map<string, number>();
  private logLines = 0;
  private loaded = false;

  // ── Reading ────────────────────────────────────────────────────────────

  get(id: string): WorkRecord | undefined {
    return this.records.get(id);
  }

  all(): WorkRecord[] {
    return [...this.records.values()];
  }

  /**
   * Filtered view.
   *
   * Every field is an AND, and each accepts one value or several, because the
   * questions that get asked are compound: "running agents in this session",
   * "anything that finished and has not been reported". Making the caller
   * filter afterwards would push that shape into six different call sites.
   */
  query(q: WorkQuery = {}): WorkRecord[] {
    const kinds = asArray(q.kind);
    const states = asArray(q.state);
    return this.all().filter(r => {
      if (kinds && !kinds.includes(r.kind)) return false;
      if (states && !states.includes(r.state)) return false;
      if (q.sessionId !== undefined && r.sessionId !== q.sessionId) return false;
      if (q.parent !== undefined && r.parent !== q.parent) return false;
      if (q.origin !== undefined && r.origin !== q.origin) return false;
      if (q.live && isTerminal(r.state)) return false;
      if (q.unreported && (!isTerminal(r.state) || r.reported)) return false;
      return true;
    }).sort((a, b) => a.startedAt - b.startedAt);
  }

  /**
   * Every descendant of a record, deepest last.
   *
   * "Stop that agent and everything it spawned" is the ordinary supervisory
   * act, and it needs the tree. Guarded against a cycle because a parent id is
   * data — an adapter with a bug could point a record at itself, and a
   * supervisor that hangs while tidying up is worse than one that misses a
   * child.
   */
  descendants(id: string): WorkRecord[] {
    const out: WorkRecord[] = [];
    const seen = new Set<string>([id]);
    let frontier = [id];
    while (frontier.length) {
      const next: string[] = [];
      for (const record of this.all()) {
        if (record.parent && frontier.includes(record.parent) && !seen.has(record.id)) {
          seen.add(record.id);
          out.push(record);
          next.push(record.id);
        }
      }
      frontier = next;
    }
    return out;
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    fn(this.all());
    return () => { this.listeners.delete(fn); };
  }

  private emit(): void {
    const snapshot = this.all();
    for (const fn of this.listeners) {
      try {
        fn(snapshot);
      } catch {
        // A broken subscriber is the subscriber's problem. The alternative is
        // one bad listener in a browser tab taking down process supervision.
      }
    }
  }

  // ── Writing ────────────────────────────────────────────────────────────

  /** Register something that has started. Returns the record's id. */
  open(opts: OpenWorkOptions): string {
    const now = Date.now();
    const record: WorkRecord = {
      id: opts.id ?? `work-${randomUUID().slice(0, 8)}`,
      kind: opts.kind,
      title: opts.title,
      state: opts.state ?? 'running',
      origin: opts.origin,
      startedAt: now,
      heartbeatAt: now,
      reported: false,
      ...(opts.parent ? { parent: opts.parent } : {}),
      ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
      ...(opts.pid !== undefined ? { pid: opts.pid } : {}),
      ...(opts.policy ? { policy: opts.policy } : {}),
    };
    this.records.set(record.id, record);
    this.lastFlush.set(record.id, now);
    this.logLines++;
    void appendWorkEvent({ t: 'add', at: now, record });
    this.emit();
    return record.id;
  }

  /**
   * Liveness and progress.
   *
   * Deliberately cheap and deliberately lossy on disk — see the module note.
   * The in-memory record is always current; only the persisted copy lags, and
   * it lags by at most one flush interval.
   */
  beat(id: string, progress?: Partial<WorkProgress>, cost?: WorkCost): void {
    const record = this.records.get(id);
    if (!record || isTerminal(record.state)) return;
    const now = Date.now();
    record.heartbeatAt = now;
    if (progress) {
      record.progress = { steps: record.progress?.steps ?? 0, ...record.progress, ...progress };
    }
    if (cost) record.cost = cost;

    const since = now - (this.lastFlush.get(id) ?? 0);
    if (since >= BEAT_FLUSH_MS) {
      this.lastFlush.set(id, now);
      this.logLines++;
      void appendWorkEvent({
        t: 'patch', at: now, id,
        patch: {
          heartbeatAt: now,
          ...(record.progress ? { progress: record.progress } : {}),
          ...(record.cost ? { cost: record.cost } : {}),
        },
      });
    }
    this.emit();
  }

  /** Change state without ending the work — `running` ⇄ `blocked`, mostly. */
  setState(id: string, state: WorkState, note?: string): boolean {
    const record = this.records.get(id);
    if (!record || isTerminal(record.state)) return false;
    if (isTerminal(state)) return this.close(id, state, note);
    record.state = state;
    record.heartbeatAt = Date.now();
    if (note) record.progress = { steps: record.progress?.steps ?? 0, ...record.progress, note };
    this.persist(id, {
      state, heartbeatAt: record.heartbeatAt,
      ...(record.progress ? { progress: record.progress } : {}),
    });
    this.emit();
    return true;
  }

  /** Attach or replace a supervision policy on live work. */
  setPolicy(id: string, policy: SupervisionPolicy): boolean {
    const record = this.records.get(id);
    if (!record || isTerminal(record.state)) return false;
    record.policy = policy;
    this.persist(id, { policy });
    this.emit();
    return true;
  }

  /**
   * End it.
   *
   * `outcome` carries the result for a success and the reason for everything
   * else. A stop and a crash both surface inside the work as "aborted", and a
   * supervisor reading that cannot tell them apart — but one invites a retry
   * and the other a re-plan, so the difference has to be recorded here rather
   * than inferred later.
   */
  close(id: string, state: WorkState, outcome?: string): boolean {
    const record = this.records.get(id);
    if (!record || isTerminal(record.state)) return false;
    const now = Date.now();
    record.state = state;
    record.endedAt = now;
    record.heartbeatAt = now;
    if (outcome !== undefined) {
      if (state === 'done') record.result = outcome;
      else record.error = outcome;
    }
    // Nothing can stop what has already stopped, and a stale handle keyed by a
    // reused id would stop the wrong thing.
    clearStopHandle(id);
    // Always flushed, whatever the beat throttle says: this is the write that
    // has to be on disk if the process dies in the next second.
    this.persist(id, {
      state, endedAt: now, heartbeatAt: now,
      ...(record.result !== undefined ? { result: record.result } : {}),
      ...(record.error !== undefined ? { error: record.error } : {}),
      ...(record.progress ? { progress: record.progress } : {}),
      ...(record.cost ? { cost: record.cost } : {}),
    });
    this.emit();
    return true;
  }

  /**
   * Mark outcomes as delivered.
   *
   * The orchestrator calls this once it has actually read them. Until it does,
   * the same finished work keeps being offered — which is the correct default:
   * silently dropping an outcome nobody looked at is how a failed background
   * job becomes a mystery an hour later.
   */
  acknowledge(ids: string[]): number {
    let count = 0;
    const at = Date.now();
    for (const id of ids) {
      const record = this.records.get(id);
      if (!record || record.reported) continue;
      record.reported = true;
      count++;
      this.logLines++;
      void appendWorkEvent({ t: 'patch', at, id, patch: { reported: true } });
    }
    if (count) this.emit();
    return count;
  }

  private persist(id: string, patch: Partial<WorkRecord>): void {
    this.lastFlush.set(id, Date.now());
    this.logLines++;
    void appendWorkEvent({ t: 'patch', at: Date.now(), id, patch });
  }

  // ── Boot ───────────────────────────────────────────────────────────────

  /**
   * Load the log and settle what the last process left behind.
   *
   * The reconciliation rule turns on whether a kind *can* survive us:
   *
   * - A `process` with a live pid is still running. Backgrounded commands are
   *   spawned detached precisely so a server outlives the session that started
   *   it, and marking those `lost` would be a lie that also loses the pid we
   *   need in order to stop them later.
   * - A `process` with a dead pid is `lost`.
   * - Everything else — agents, runs, watchers, cron firings — lives inside
   *   this process. If the log says it was running and we have only just
   *   started, it cannot be. `lost`, without a check.
   *
   * Returns what it settled so the caller can say so rather than doing it
   * silently.
   */
  async load(): Promise<{ recovered: WorkRecord[]; lost: WorkRecord[] }> {
    if (this.loaded) return { recovered: [], lost: [] };
    this.loaded = true;

    const { records, lines } = await readWorkLog();
    this.logLines = lines;
    const recovered: WorkRecord[] = [];
    const lost: WorkRecord[] = [];
    const now = Date.now();

    for (const record of records) {
      this.records.set(record.id, record);
      this.lastFlush.set(record.id, now);
      if (isTerminal(record.state)) continue;

      const survives = record.kind === 'process'
        && record.pid !== undefined
        && pidAlive(record.pid);

      if (survives) {
        recovered.push(record);
        // Its heartbeat is stale by however long we were down. Reset it, or the
        // supervisor's idle timer would kill a healthy server for the crime of
        // having been alive while we were not.
        record.heartbeatAt = now;
      } else {
        record.state = 'lost';
        record.endedAt = now;
        record.error = record.kind === 'process'
          ? 'Process was gone when aico restarted'
          : 'Interrupted — aico restarted while this was running';
        lost.push(record);
        void appendWorkEvent({
          t: 'patch', at: now, id: record.id,
          patch: { state: 'lost', endedAt: now, error: record.error },
        });
      }
    }

    if (shouldCompact(this.logLines, this.records.size)) {
      await compactWorkLog(this.all());
      this.logLines = this.records.size;
    }
    this.emit();
    return { recovered, lost };
  }

  /** Drop everything. Tests only — a live ledger is never emptied. */
  resetForTest(): void {
    this.records.clear();
    this.lastFlush.clear();
    this.listeners.clear();
    this.logLines = 0;
    this.loaded = false;
  }
}

export const ledger = new Ledger();
export type { WorkRecord, WorkState, WorkKind } from './types.js';
