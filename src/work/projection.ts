/**
 * What the model is told about work that is still running.
 *
 * The ledger is useless to an orchestrator that never looks at it, and a model
 * only looks at what it is shown. Before this, `Supervise list` existed and
 * nothing ever prompted a turn to call it — so a background agent could fail at
 * 3am and the next morning's conversation would open with no idea.
 *
 * ## Only when there is something to say
 *
 * This returns the empty string when nothing is running and nothing has
 * finished unacknowledged, and that is the common case. A permanent "0 items"
 * block would be paid for on every turn of every session to communicate
 * nothing — the same trade the widget catalog and the skills list already
 * refuse to make.
 *
 * ## In the volatile tail, not the system prompt
 *
 * This churns by definition: a step count moves every tool call. In the system
 * prompt it would invalidate the cached transcript behind it on almost every
 * turn, so a feature meant to save the orchestrator work would cost more than
 * it saved. It rides at the tail with the working tree and the runtime roster.
 *
 * @module work/projection
 */

import { ledger } from './ledger.js';
import { isTerminal, reportsProgress } from './types.js';
import type { WorkRecord } from './types.js';

/**
 * How much of the turn's budget this block may take.
 *
 * A fan-out of forty sub-agents must not push out the request. Past the limit
 * the *identities* are kept and the detail is dropped — the same degradation
 * order a skills catalog uses, and for the same reason: knowing that eleven
 * things are running and being able to ask about them is most of the value,
 * and it survives when the per-item detail cannot.
 */
const MAX_CHARS = 1_400;

/** Beyond this without a heartbeat, the age is worth stating outright. */
const STALL_MS = 30_000;

function age(ms: number): string {
  if (ms < 1000) return '0s';
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m`;
  return `${Math.floor(ms / 3_600_000)}h${Math.floor((ms % 3_600_000) / 60_000)}m`;
}

function attrs(record: WorkRecord, now: number): string {
  const bits = [
    `id="${record.id}"`,
    `kind="${record.kind}"`,
    `state="${record.state}"`,
    `for="${age((record.endedAt ?? now) - record.startedAt)}"`,
  ];
  if (record.progress?.steps) bits.push(`steps="${record.progress.steps}"`);
  if (record.cost?.usd) bits.push(`cost="$${record.cost.usd.toFixed(3)}"`);
  // The number that distinguishes "working hard" from "hung". Stated only when
  // it is long enough to mean something, so it does not become noise on every
  // healthy row.
  if (!isTerminal(record.state)) {
    const idle = now - record.heartbeatAt;
    if (idle > STALL_MS && reportsProgress(record.kind)) bits.push(`idle="${age(idle)}"`);
    if (record.progress?.lastTool) bits.push(`in="${record.progress.lastTool}"`);
  }
  return bits.join(' ');
}

function escape(text: string): string {
  return text.replace(/[&<>]/g, c => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;'));
}

function row(record: WorkRecord, now: number, detailed: boolean): string {
  const open = `    <work ${attrs(record, now)}>`;
  if (!detailed) return `${open.slice(0, -1)} />`;
  const outcome = record.error ?? record.result;
  const body = escape(
    outcome ? `${record.title} — ${outcome}` : record.title,
  ).replace(/\s*\n+\s*/g, ' ').trim().slice(0, 180);
  return `${open}${body}</work>`;
}

export interface LedgerProjectionOptions {
  /** Only this conversation's work. Omit to project everything. */
  sessionId?: string;
  /** Overridable for tests, so a projection can be asserted without a clock. */
  now?: number;
}

/**
 * Render the running-work block, or nothing.
 *
 * The instruction attached to the settled list is the part that matters:
 * without it the model sees outcomes and has no reason to believe they will
 * stop appearing, so it either re-reports them every turn or ignores them.
 * Saying that acknowledging is what clears them makes the list shrink as it is
 * dealt with, which is the behaviour that makes it worth reading at all.
 */
export function renderRunningWork(opts: LedgerProjectionOptions = {}): string {
  const now = opts.now ?? Date.now();
  const mine = ledger.all().filter(r =>
    opts.sessionId === undefined || !r.sessionId || r.sessionId === opts.sessionId);

  const live = mine.filter(r => !isTerminal(r.state));
  const settled = mine.filter(r => isTerminal(r.state) && !r.reported);
  if (!live.length && !settled.length) return '';

  const build = (detailed: boolean): string => [
    '<running_work>',
    ...(live.length ? [
      `  <live count="${live.length}">`,
      ...live.map(r => row(r, now, detailed)),
      '  </live>',
    ] : []),
    ...(settled.length ? [
      `  <finished count="${settled.length}" note="not yet acknowledged">`,
      ...settled.map(r => row(r, now, detailed)),
      '  </finished>',
      '  <!-- These stay listed until you acknowledge them with',
      '       Supervise {"action":"ack","id":[...]}. Reading does not clear them, so an',
      '       outcome you have not dealt with will be here again next turn. -->',
    ] : []),
    '  <!-- Control all of this with the Supervise tool: list, stop, wait, policy,',
    '       watch, ack. To wait for something, register a watcher rather than',
    '       polling in a loop — a watcher costs one turn, a poll costs one per check. -->',
    '</running_work>',
  ].join('\n');

  const full = build(true);
  if (full.length <= MAX_CHARS) return full;

  // Over budget: keep every identity, drop the titles and outcomes. A truncated
  // list would be worse than a terse one — the orchestrator would act on a
  // roster it believes is complete and is not.
  const terse = build(false);
  if (terse.length <= MAX_CHARS) {
    return terse.replace('<running_work>',
      '<running_work note="titles omitted for space — Supervise list has them">');
  }

  // Still over, which means a very large fan-out. Report the shape rather than
  // a partial roster, and say where the whole one is.
  return [
    '<running_work note="too many to list — use Supervise list">',
    `  <live count="${live.length}" />`,
    `  <finished count="${settled.length}" note="not yet acknowledged" />`,
    '</running_work>',
  ].join('\n');
}
