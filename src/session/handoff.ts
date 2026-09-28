/**
 * What a compaction summary must carry, taken from the log rather than hoped for.
 *
 * A summary is lossy by design, and the way long agent runs actually go wrong
 * after one is not that the gist was lost — it is that the *specifics* were:
 * the exact thing the person asked for, the plan they approved, which items
 * are still open, which files have already been changed. A summarizer (model
 * or regex) might keep those; this module makes sure of it by reading them out
 * of the log and the todo list directly and writing them into the summary in
 * fixed sections.
 *
 * ## Repeated compaction does not forget
 *
 * A second compaction folds the first summary away. Summarizing a summary is
 * how agents lose the original request after a few rounds, so the verbatim
 * sections of an earlier summary are carried forward as-is, not re-summarized.
 * They are found by their headings, which is why the headings are constants.
 *
 * @module session/handoff
 */

import type { Seq, SessionEvent } from './events.js';
import type { Session } from './session.js';
import { todoChecklist, type Todo } from '../tools/todo.js';

export const ASKED_HEADING = '## What the user asked (verbatim)';
export const PLAN_HEADING = '## Plan';
export const TODO_HEADING = '## Todo list';
export const CHANGED_HEADING = '## Files changed';
export const READ_HEADING = '## Files read';
export const STATE_HEADING = '## Where things stand';

/** Room for the person's own words, in characters. The first request always fits whole. */
const ASKED_BUDGET = 8_000;
const FIRST_REQUEST_MAX = 4_000;
const MAX_FILES_LISTED = 40;

/** Tools whose `file_path`-like argument names a file they changed. */
const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

/** The body under one heading of an earlier summary, up to the next heading. */
export function sectionOf(text: string, heading: string): string | undefined {
  const at = text.indexOf(`${heading}\n`);
  if (at < 0) return undefined;
  const body = text.slice(at + heading.length + 1);
  const next = body.search(/\n## /);
  return (next < 0 ? body : body.slice(0, next)).trim() || undefined;
}

/** A file path named by a tool call's arguments, if it has one. */
function pathArg(raw: string): string | undefined {
  try {
    const input = JSON.parse(raw) as Record<string, unknown>;
    for (const key of ['file_path', 'path', 'notebook_path', 'filePath']) {
      const value = input[key];
      if (typeof value === 'string' && value.trim()) return value.trim();
    }
  } catch { /* malformed arguments name nothing */ }
  return undefined;
}

/** What a plan's reader said about it, read from the phrases the panel sends. */
function planDecision(events: readonly SessionEvent[], after: Seq): string | undefined {
  let decision: string | undefined;
  for (const event of events) {
    if (event.seq <= after || event.type !== 'user/message') continue;
    const data = event.data as { content: string; source: { kind: string } };
    if (data.source.kind !== 'human') continue;
    const text = data.content.trim();
    if (/^(Go ahead with that plan|Start that plan now)/.test(text)) decision = 'approved';
    else if (/^Do not go ahead with that plan/.test(text)) decision = 'declined';
    else if (/^Keep that plan for later/.test(text)) decision = 'deferred';
    else if (/^Cancel that plan/.test(text)) decision = 'cancelled';
    else if (/^That plan is finished/.test(text)) decision = 'completed';
    else if (/^Amend that plan/.test(text)) decision = 'amendment requested';
  }
  return decision;
}

/** The last plan proposed at or before `end`, rendered, with what became of it. */
function planSection(session: Session, end: Seq): string | undefined {
  let call: { seq: Seq; raw: string } | undefined;
  for (const event of session.events) {
    if (event.seq > end) break;
    if (event.type !== 'tool/call') continue;
    const data = event.data as { name: string; arguments: string };
    if (data.name === 'ProposePlan') call = { seq: event.seq, raw: data.arguments };
  }
  if (!call) return undefined;
  let plan: { title?: string; steps?: Array<{ title?: string; detail?: string }> };
  try { plan = JSON.parse(call.raw); } catch { return undefined; }
  const steps = (plan.steps ?? []).filter(s => typeof s?.title === 'string');
  if (steps.length === 0) return undefined;
  const decision = planDecision(session.events, call.seq) ?? 'awaiting an answer';
  return [
    `${plan.title ?? 'Plan'} — ${decision}`,
    ...steps.map((s, i) => `${i + 1}. ${s.title}${s.detail ? ` — ${s.detail}` : ''}`),
  ].join('\n');
}

/** The person's own messages in the folded range, plus any an earlier summary carried. */
function askedSection(visible: readonly SessionEvent[]): string | undefined {
  const asked: string[] = [];
  for (const event of visible) {
    if (event.type !== 'user/message') continue;
    const data = event.data as { content: string; source: { kind: string } };
    if (data.source.kind === 'compaction') {
      const carried = sectionOf(data.content, ASKED_HEADING);
      if (carried) asked.push(carried);
    } else if (data.source.kind === 'human' && data.content.trim()) {
      asked.push(`> ${data.content.trim().replace(/\n/g, '\n> ')}`);
    }
  }
  if (asked.length === 0) return undefined;

  const total = asked.reduce((n, a) => n + a.length, 0);
  if (total <= ASKED_BUDGET) return asked.join('\n\n');

  // Over budget: the first request whole (it is usually the task), then as many
  // of the most recent as fit. What is left out is in the transcript on disk.
  const first = asked[0]!.length > FIRST_REQUEST_MAX
    ? `${asked[0]!.slice(0, FIRST_REQUEST_MAX)}\n> […cut here; the full message is in the transcript file]`
    : asked[0]!;
  const recent: string[] = [];
  let room = ASKED_BUDGET - first.length;
  for (let i = asked.length - 1; i > 0; i--) {
    if (asked[i]!.length > room) break;
    recent.unshift(asked[i]!);
    room -= asked[i]!.length;
  }
  const omitted = asked.length - 1 - recent.length;
  return [
    first,
    ...(omitted > 0 ? [`[…${omitted} message(s) in between are in the transcript file]`] : []),
    ...recent,
  ].join('\n\n');
}

/** Files the folded range changed and read, plus those an earlier summary listed. */
function fileSections(
  session: Session,
  visible: readonly SessionEvent[],
  start: Seq,
  end: Seq,
): { changed?: string; read?: string } {
  const changed = new Set<string>();
  const read = new Set<string>();
  for (const event of visible) {
    if (event.type !== 'user/message') continue;
    const data = event.data as { content: string; source: { kind: string } };
    if (data.source.kind !== 'compaction') continue;
    for (const [heading, into] of [[CHANGED_HEADING, changed], [READ_HEADING, read]] as const) {
      for (const line of sectionOf(data.content, heading)?.split('\n') ?? []) {
        const file = line.replace(/^- /, '').trim();
        if (file) into.add(file);
      }
    }
  }
  for (const event of session.events) {
    if (event.seq < start) continue;
    if (event.seq > end) break;
    if (event.type !== 'tool/call') continue;
    const data = event.data as { name: string; arguments: string };
    const file = pathArg(data.arguments);
    if (!file) continue;
    if (WRITE_TOOLS.has(data.name)) changed.add(file);
    else if (data.name === 'Read') read.add(file);
  }
  for (const file of changed) read.delete(file);
  const list = (files: Set<string>): string | undefined => {
    if (files.size === 0) return undefined;
    const all = [...files];
    const shown = all.slice(-MAX_FILES_LISTED).map(f => `- ${f}`);
    return (all.length > MAX_FILES_LISTED ? [`- …and ${all.length - MAX_FILES_LISTED} earlier`] : [])
      .concat(shown).join('\n');
  };
  return { changed: list(changed), read: list(read) };
}

/**
 * The text that stands in for `[start, end]` once it is folded.
 *
 * @param narrative - the summarizer's account of the work (model or regex).
 * @param todos - the session's todo list, read by the caller.
 * @param preamble - where the full text went, and any standing notes.
 */
export function buildHandoff(
  session: Session,
  range: { start: Seq; end: Seq },
  narrative: string,
  todos: readonly Todo[] | undefined,
  preamble: string,
): string {
  const visible = session.surfaceEvents().filter(e => e.seq >= range.start && e.seq <= range.end);
  const asked = askedSection(visible);
  const plan = planSection(session, range.end);
  const files = fileSections(session, visible, range.start, range.end);
  const todo = todos && todos.length > 0 ? todoChecklist(todos).join('\n') : undefined;

  return [
    '[Context checkpoint] The earlier part of this conversation was condensed to keep the '
      + 'context focused. The sections below were taken from the record directly; the last '
      + 'one is a summary.' + (preamble ? ` ${preamble}` : ''),
    ...(asked ? [`${ASKED_HEADING}\n${asked}`] : []),
    ...(plan ? [`${PLAN_HEADING}\n${plan}`] : []),
    ...(todo ? [`${TODO_HEADING}\n${todo}`] : []),
    ...(files.changed ? [`${CHANGED_HEADING}\n${files.changed}`] : []),
    ...(files.read ? [`${READ_HEADING}\n${files.read}`] : []),
    `${STATE_HEADING}\n${narrative.trim() || '(no summary available)'}`,
    'Carry on from where this leaves off. File contents shown earlier are no longer in view — '
      + 'read a file again before editing it.',
  ].join('\n\n');
}
