/**
 * An agent's `autonomy` ceiling, applied to a run before it starts.
 *
 * The level scale (`autonomy/levels`) is how a run is described; what the
 * engine actually obeys is three older switches — plan mode, `autoApprove`
 * and the permission callback. So a ceiling is enforced by turning those
 * switches, never by asking the model: the effective level is
 * min(requested, the agent's ceiling, the delegating run's level), and
 *
 *   L0  plan mode: only read tools are offered or dispatched;
 *   L1  every tool that changes something asks a person;
 *   L2  file edits run, everything else that changes something asks;
 *   L3+ unchanged (L4's parking is the run context's, `autonomy/inbox`).
 *
 * Asking goes to whoever can ask: the session's own permission callback when
 * it has one (it shows the diff card), else the always-ask channel the server
 * passes and sub-agents inherit through the run context. With nobody to ask
 * and no terminal, a call that needs a person is refused — never run.
 *
 * The requested level of a run that does not state one is read from its
 * switches: plan mode → L0, `autoApprove` → L3, otherwise L2 (it already asks
 * through its callback, and `edits` versus `ask` is the callback's business).
 *
 * @module agents/ceiling
 */

import { levelRank, minLevel, parseLevel, type AutonomyLevel } from '../autonomy/levels.js';

type PermissionFn = (toolName: string, detail: string, fileDiff?: { path: string; added?: string[]; removed?: string[]; preview?: string }) => Promise<boolean>;

/** The run options this touches. */
export interface CeilingInput {
  planMode?: boolean;
  autoApprove: boolean;
  autonomy?: AutonomyLevel;
  onPermissionRequest?: PermissionFn;
}

/** File writers that L2 (`edits`) lets through, as the server's `edits` mode does. */
export const EDIT_TOOLS: ReadonlySet<string> = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

/** The effective level, or undefined when nothing bounds the run. */
export function ceilingLevel(o: { requested: AutonomyLevel; ceiling?: unknown; parent?: AutonomyLevel }): AutonomyLevel | undefined {
  const ceiling = parseLevel(o.ceiling);
  if (!ceiling && !o.parent) return undefined;
  return minLevel(o.requested, ceiling, o.parent);
}

/** What a run asks for when it does not say: see the module note. */
export function requestedLevel(opts: CeilingInput): AutonomyLevel {
  if (opts.autonomy) return opts.autonomy;
  if (opts.planMode) return 'L0';
  return opts.autoApprove ? 'L3' : 'L2';
}

/**
 * The switches for a run under a ceiling. Returns `opts` itself when nothing
 * changes, so an unbounded run is exactly what it was.
 */
export function applyAutonomyCeiling<T extends CeilingInput>(opts: T, o: {
  ceiling?: unknown;
  parent?: AutonomyLevel;
  /** The always-ask channel (server card, inherited by sub-agents). */
  approve?: (toolName: string, detail: string) => Promise<boolean>;
  /** Built-in tools that only read, which never ask. */
  isRead: (toolName: string) => boolean;
  /** Whether a terminal can answer `checkPermission` when nobody else can. */
  tty: boolean;
}): T {
  const requested = requestedLevel(opts);
  const level = ceilingLevel({ requested, ceiling: o.ceiling, parent: o.parent });
  if (!level) return opts;
  const rank = levelRank(level);
  if (rank === 0) return opts.planMode ? opts : { ...opts, planMode: true };
  if (rank >= 3) return opts;

  // A callback beside autoApprove is never consulted, so it is not the session's asker.
  const original = opts.autoApprove ? undefined : opts.onPermissionRequest;
  const lowered = rank < levelRank(requested);
  if (!lowered && original) return opts;
  if (!original && !o.approve && o.tty) return { ...opts, autoApprove: false };

  const ask: PermissionFn = async (tool, detail, diff) => {
    if (o.isRead(tool)) return original ? original(tool, detail, diff) : true;
    if (EDIT_TOOLS.has(tool)) {
      if (rank === 2) return original ? original(tool, detail, diff) : true;
      // L1 under an `edits` session: the session's callback would wave edits
      // through, so the always-ask channel asks instead.
      if (o.approve) return o.approve(tool, detail);
    }
    if (original) return original(tool, detail, diff);
    if (o.approve) return o.approve(tool, detail);
    return false;
  };
  return { ...opts, autoApprove: false, onPermissionRequest: ask };
}
