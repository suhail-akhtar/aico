/**
 * What a running task is doing, read from its session log.
 *
 * WHY FROM THE LOG AND NOT FROM THE MODEL. The board's "what are the agents doing?" answer must
 * cost nothing and cannot be wrong about itself: the run's session already records every tool
 * call (ADR 0001), so the current step is the last call and its target, the history is the
 * calls that mean something to a person (an edit, a check, a commit), and nobody asks the model
 * to narrate. Nothing here is journaled per step - a live line changes every few seconds and the
 * journal is forever - only the throttled milestones the service chooses to keep.
 *
 * Pure functions over events, with the worktree path given so a target is shown relative to it.
 * They tolerate any event shape (a missing or unparseable argument gives a plainer line, never
 * an error), because a status line must never be the thing that breaks a board.
 *
 * @module delivery/activity
 */

import path from 'node:path';
import type { SessionEvent } from '../session/events.js';

export interface Milestone { kind: 'edit' | 'checks' | 'commit'; text: string; seq: number; files?: string[] }

interface Call { seq: number; callId: string; name: string; args: Record<string, unknown> }

function parseArgs(raw: unknown): Record<string, unknown> {
  if (typeof raw !== 'string') return {};
  try { const v = JSON.parse(raw) as unknown; return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {}; } catch { return {}; }
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

function rel(p: string, cwd: string | undefined): string {
  if (!p) return '';
  if (cwd && path.isAbsolute(p)) {
    const r = path.relative(cwd, p);
    if (r && !r.startsWith('..') && !path.isAbsolute(r)) return r.replace(/\\/g, '/');
  }
  return p.replace(/\\/g, '/');
}

const clip = (s: string, n: number): string => { const one = s.replace(/\s+/g, ' ').trim(); return one.length > n ? `${one.slice(0, n - 1)}...` : one; };

/** The file an edit-like call writes, if it names one. */
function editTarget(c: Call, cwd: string | undefined): string {
  return rel(str(c.args.file_path) || str(c.args.path) || str(c.args.notebook_path), cwd);
}

const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit', 'ApplyPatch', 'FileEdit', 'FileWrite']);
const SHELL_TOOLS = new Set(['Bash', 'PowerShell', 'Shell']);

/** A present-tense line for a call: "Editing src/auth.mjs", "Running RunChecks". */
export function describeCall(c: Call, cwd: string | undefined, pending: boolean): string {
  const name = c.name;
  if (EDIT_TOOLS.has(name)) { const t = editTarget(c, cwd); return `${pending ? 'Editing' : 'Edited'}${t ? ` ${t}` : ' a file'}`; }
  if (name === 'Read') { const t = rel(str(c.args.file_path) || str(c.args.path), cwd); return `${pending ? 'Reading' : 'Read'}${t ? ` ${t}` : ' a file'}`; }
  if (name === 'RunChecks') return pending ? 'Running RunChecks' : 'Ran RunChecks';
  if (SHELL_TOOLS.has(name)) { const cmd = clip(str(c.args.command), 70); return `${pending ? 'Running' : 'Ran'}${cmd ? ` ${cmd}` : ' a command'}`; }
  if (name === 'Grep' || name === 'Glob' || name === 'Search') { const q = clip(str(c.args.pattern) || str(c.args.query), 50); return `${pending ? 'Searching' : 'Searched'}${q ? ` for ${q}` : ''}`; }
  if (name === 'Git') return `${pending ? 'Running' : 'Ran'} git ${str(c.args.action)}`.trim();
  if (name === 'Delivery') return `Delivery: ${str(c.args.action) || 'update'}`;
  if (name === 'WebFetch' || name === 'WebSearch') return `${pending ? 'Looking up' : 'Looked up'} ${clip(str(c.args.url) || str(c.args.query), 60)}`.trim();
  return `${pending ? 'Using' : 'Used'} ${name}`;
}

/**
 * The current step: the last tool call, in the present tense when it has no result yet. Undefined
 * for a log with no tool call (the run has only thought so far).
 */
export function liveSummary(events: readonly SessionEvent[], cwd?: string): { summary: string; at: number } | undefined {
  const results = new Set<string>();
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.type === 'tool/result') { results.add(String((e.data as { callId?: unknown }).callId ?? '')); continue; }
    if (e.type === 'tool/call') {
      const d = e.data as { callId?: unknown; name?: unknown; arguments?: unknown };
      const call: Call = { seq: e.seq, callId: String(d.callId ?? ''), name: String(d.name ?? ''), args: parseArgs(d.arguments) };
      return { summary: describeCall(call, cwd, !results.has(call.callId)), at: Number(e.timestamp) || Date.now() };
    }
  }
  return undefined;
}

/**
 * Things worth a line of history, found after `afterSeq`: edits (one entry naming the files),
 * check runs (with their outcome), commits. The caller throttles and remembers the last seq.
 */
export function milestonesSince(events: readonly SessionEvent[], afterSeq: number, cwd?: string): { milestones: Milestone[]; lastSeq: number } {
  const calls = new Map<string, Call>();
  const out: Milestone[] = [];
  const edited: string[] = [];
  let editSeq = 0;
  let lastSeq = afterSeq;
  for (const e of events) {
    if (e.seq > lastSeq) lastSeq = e.seq;
    if (e.type === 'tool/call') {
      const d = e.data as { callId?: unknown; name?: unknown; arguments?: unknown };
      calls.set(String(d.callId ?? ''), { seq: e.seq, callId: String(d.callId ?? ''), name: String(d.name ?? ''), args: parseArgs(d.arguments) });
      continue;
    }
    if (e.type !== 'tool/result' || e.seq <= afterSeq) continue;
    const d = e.data as { callId?: unknown; isError?: unknown; content?: unknown };
    const call = calls.get(String(d.callId ?? ''));
    if (!call) continue;
    const failed = d.isError === true;
    if (EDIT_TOOLS.has(call.name) && !failed) {
      const t = editTarget(call, cwd);
      if (t && !edited.includes(t)) edited.push(t);
      editSeq = e.seq;
    } else if (call.name === 'RunChecks') {
      out.push({ kind: 'checks', seq: e.seq, text: failed ? 'Ran the checks: they did not all pass.' : `Ran the checks.${/\b(pass|passed|ok|green)\b/i.test(clip(str(d.content), 400)) ? ' They passed.' : ''}` });
    } else if (SHELL_TOOLS.has(call.name) && /\bgit\s+(?:-\S+\s+)*commit\b/.test(str(call.args.command)) && !failed) {
      const m = /-m\s+["']([^"']{1,100})/.exec(str(call.args.command));
      out.push({ kind: 'commit', seq: e.seq, text: m ? `Committed: ${m[1]}` : 'Committed.' });
    } else if (call.name === 'Git' && str(call.args.action) === 'commit' && !failed) {
      out.push({ kind: 'commit', seq: e.seq, text: `Committed${str(call.args.message) ? `: ${clip(str(call.args.message), 100)}` : '.'}` });
    }
  }
  if (edited.length > 0) {
    out.push({
      kind: 'edit', seq: editSeq, files: edited,
      text: `Edited ${edited.slice(0, 3).join(', ')}${edited.length > 3 ? ` and ${edited.length - 3} more` : ''}.`,
    });
  }
  out.sort((a, b) => a.seq - b.seq);
  return { milestones: out, lastSeq };
}
