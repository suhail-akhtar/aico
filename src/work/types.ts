/**
 * One shape for everything that outlives a single tool call.
 *
 * Before this module there were five registries. Sub-agents lived in a `Map` in
 * `tools/task.ts`, background agents in another in `background/index.ts`, cron
 * firings in a persisted store, background shell commands in a pid map in
 * `tools/bash.ts`, and Mini App servers in a sixth in `miniapps/process.ts`.
 * Each had its own record shape, its own lifecycle and its own idea of what
 * "running" meant.
 *
 * That is fine until something has to answer *"what is running right now?"* —
 * and then it is impossible, because there is nowhere to ask. An orchestrator
 * cannot supervise what it cannot enumerate, a restart cannot recover what it
 * cannot find, and a user cannot kill what nothing reports. Five registries is
 * five different answers to the same question.
 *
 * So: one record, one id space, one place. The individual subsystems keep their
 * own APIs — `task.ts` still returns `SubAgentRecord`s to the code that wants
 * them — but everything long-lived also registers here, and this is what gets
 * persisted, supervised, and shown.
 *
 * @module work/types
 */

/**
 * What kind of thing is running.
 *
 * The distinction is not cosmetic: it decides what can be done to a record and
 * what happens to it across a restart. A `process` has a pid and may genuinely
 * outlive us; an `agent` lives in this process and cannot.
 */
export type WorkKind =
  /** A sub-agent or background agent — an LLM loop with its own transcript. */
  | 'agent'
  /** A top-level session turn. */
  | 'run'
  /** A spawned OS process: a backgrounded shell command, a Mini App server. */
  | 'process'
  /** A condition being observed, which will wake a session when it fires. */
  | 'watcher'
  /** One firing of a cron job. The job is config; this is the occurrence. */
  | 'schedule'
  /** Work admitted from outside — reserved for the MCP surface. */
  | 'remote';

/**
 * Where a record is in its life.
 *
 * `blocked` and `lost` are the two that earn their place. Without `blocked`,
 * work waiting on a watcher or an approval is indistinguishable from work that
 * has hung, and the supervisor's idle timer would kill it. Without `lost`,
 * a crash silently drops everything that was in flight — the record simply
 * never gets an ending, and nothing can tell that apart from still running.
 */
export type WorkState =
  | 'queued'
  | 'running'
  /** Waiting on something external: a watcher, an approval, a sibling. */
  | 'blocked'
  | 'done'
  | 'failed'
  | 'cancelled'
  /** Was running when the process died, and is provably not running now. */
  | 'lost';

/** The states nothing further will happen from. */
export const TERMINAL_STATES: ReadonlySet<WorkState> =
  new Set<WorkState>(['done', 'failed', 'cancelled', 'lost']);

export function isTerminal(state: WorkState): boolean {
  return TERMINAL_STATES.has(state);
}

/** Who asked for this. Kept because it decides what may be done without asking. */
export type WorkOrigin = 'user' | 'model' | 'cron' | 'remote' | 'watcher';

/**
 * Limits the supervisor enforces, and what it does when one is breached.
 *
 * This is a policy the orchestrator *sets*, not a judgement it is asked to make
 * every turn. A model told "stop the agent if it costs too much" has to
 * remember to look, decide what "too much" is, and act — three chances to not.
 * A model that sets `maxCostUsd` has one, and the loop does the rest.
 */
export interface SupervisionPolicy {
  /** Wall-clock ceiling from `startedAt`. */
  deadlineMs?: number;
  /** Spend ceiling. Uses the same figures the cost tracker already reports. */
  maxCostUsd?: number;
  /** Step ceiling, for a loop that is progressing but going nowhere. */
  maxSteps?: number;
  /**
   * How long without a heartbeat counts as stuck.
   *
   * Deliberately distinct from a deadline: an agent that has made no tool call
   * in ten minutes is a different failure from one that has worked hard for an
   * hour, and conflating them kills the wrong one. Zero progress is not slow
   * progress — a lesson this repo learned from a test assertion that let "or it
   * already finished" pass.
   */
  idleMs?: number;
  /**
   * What to do on breach.
   *
   * - `report` notifies and leaves it running. The right default for a ceiling
   *   you want to know about rather than enforce.
   * - `stop` asks it to end: a sub-agent aborts at its next step boundary with
   *   the reason attached, a process gets SIGTERM.
   * - `kill` does not ask: SIGKILL, or `taskkill /T /F` on Windows.
   *
   * There is deliberately no `pause`. An LLM turn cannot be suspended and
   * resumed — the provider stream is a single open request, and stopping it
   * loses the completion in flight. A control named "pause" that silently
   * cancels is worse than not offering one, and `blocked` already covers the
   * only real suspension: waiting on something.
   */
  onBreach: 'report' | 'stop' | 'kill';
  /** When to raise a notification. Defaults to `on-breach`. */
  notify?: 'always' | 'on-breach' | 'on-finish' | 'never';
}

/** Cheap, frequently-updated liveness. Separated so it can be written lazily. */
export interface WorkProgress {
  /** Tool calls, loop iterations — whatever counts as a step for this kind. */
  steps: number;
  /** What it is inside right now. The difference between "slow" and "stuck". */
  lastTool?: string;
  /** A line the work chose to say about itself. */
  note?: string;
}

/** Spend so far. Optional because a `process` has no token cost. */
export interface WorkCost {
  usd: number;
  tokens: number;
}

/**
 * One thing that is, or was, running.
 *
 * Serialisable by construction: this crosses the wire to a browser and is
 * appended to a log on disk, so nothing here may be a handle, a promise or an
 * `AbortController`. Those live in side maps keyed by the same id — the same
 * split `tools/task.ts` already makes, and for the same reason.
 */
export interface WorkRecord {
  /** Unique across every kind, so one lookup finds anything. */
  id: string;
  kind: WorkKind;
  /** What a person would call it. Shown in lists; never parsed. */
  title: string;
  state: WorkState;
  /**
   * The work that started this, if any.
   *
   * A tree rather than a flat list, because "stop that agent and everything it
   * spawned" is the common supervisory act and a flat list cannot express it.
   */
  parent?: string;
  /** The conversation that owns this, so one session does not see another's. */
  sessionId?: string;
  origin: WorkOrigin;
  startedAt: number;
  endedAt?: number;
  /**
   * Last sign of life.
   *
   * The single most useful field here. A six-minute delegation and a six-minute
   * hang are identical without it, which is how people end up cancelling work
   * that was going fine.
   */
  heartbeatAt: number;
  progress?: WorkProgress;
  cost?: WorkCost;
  /** For `kind: 'process'` — what to signal, and what to check on restart. */
  pid?: number;
  /** Set when the work finished cleanly. */
  result?: string;
  /** Set when it did not. For a stop, carries the reason it was stopped. */
  error?: string;
  policy?: SupervisionPolicy;
  /**
   * Whether the orchestrator has been told the outcome.
   *
   * A finished job and a finished job somebody knows about are different
   * states, and only one of them is done with. This is what lets a turn open
   * by asking "what settled while I was away?" and get an answer that shrinks
   * as it is read, rather than the same list forever.
   */
  reported: boolean;
}

/**
 * What a watcher is waiting for.
 *
 * Every kind reduces to a poll or a subscription that eventually says yes. The
 * point is not that these conditions are hard to check — most are one line —
 * it is that checking them from inside the agent costs a turn each time. A
 * watcher costs one turn to register and one to be woken by.
 */
export type WatchCondition =
  /** A path or glob changed. Debounced, because editors write more than once. */
  | { kind: 'file'; path: string; debounceMs?: number }
  /** A pid exited. Reports the exit code when the platform gives us one. */
  | { kind: 'process'; pid: number }
  /** A URL answered as expected — the readiness check for a server. */
  | { kind: 'http'; url: string; expectStatus?: number; intervalMs?: number }
  /** A command exited with an expected code. The general escape hatch. */
  | { kind: 'command'; command: string; cwd?: string; expectExit?: number; intervalMs?: number }
  /** Another ledger record reached a state. How you wait on a sibling. */
  | { kind: 'work'; workId: string; states?: WorkState[] }
  /** A pattern appeared in a file being appended to. Tail, not re-read. */
  | { kind: 'log'; path: string; pattern: string };

/** How a fired watcher reaches the conversation that asked for it. */
export interface WatchWake {
  sessionId: string;
  /**
   * `notification` is passive — it lands in the tray and nothing resumes.
   * `followup` starts a new turn. `steer` lands at the running turn's next
   * step boundary, which is the only point a correction can arrive without
   * discarding what the turn has already learned.
   */
  as: 'notification' | 'followup' | 'steer';
  /** Prefixed to the woken message, so the agent knows why it is awake. */
  message?: string;
}

export interface WatchSpec {
  condition: WatchCondition;
  wake: WatchWake;
  /** `first` disarms after one firing; `always` keeps watching. */
  until?: 'first' | 'always';
  /** Give up after this long. Absent means watch until stopped. */
  expiresInMs?: number;
}

/** A ledger mutation, as it is written to disk. */
export type WorkEvent =
  | { t: 'add'; at: number; record: WorkRecord }
  | { t: 'patch'; at: number; id: string; patch: Partial<WorkRecord> }
  | { t: 'drop'; at: number; id: string };
