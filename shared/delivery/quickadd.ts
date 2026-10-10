/**
 * Quick-add: turn one typed line into a task's fields ("Fix login redirect !1 #auth @sam due:2026-10-20 type:bug").
 *
 * WHY HERE AND PURE. A board is only fast to use if adding a card is one line. The same
 * parser runs in the engine (so the API, a chat tool and any client agree on what the
 * line means) and in a client (to preview what will be created while typing). It reads
 * a string and returns fields; it touches nothing and has no clock beyond the `today`
 * it is given.
 *
 * Tokens (each is removed from the title; anything else stays in it): `!1`..`!4`
 * priority, `#label`, `@person` assignee, `due:YYYY-MM-DD` / `due:today` /
 * `due:tomorrow` / `due:+3d`, `type:feature|bug|chore|spike|docs`. An unknown `type:` or
 * a malformed date is left in the title rather than guessed at.
 *
 * @module shared/delivery/quickadd
 */

import type { TaskPriority, TaskType } from './types.js';

export interface QuickAdd {
  title: string;
  priority?: TaskPriority;
  labels: string[];
  assignee?: string;
  dueDate?: string;
  type?: TaskType;
}

const TYPES: readonly string[] = ['feature', 'bug', 'chore', 'spike', 'docs'];

const pad = (n: number): string => String(n).padStart(2, '0');
const ymd = (d: Date): string => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** `YYYY-MM-DD` and a real calendar day. */
export function isDueDate(s: unknown): s is string {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

export function parseQuickAdd(line: string, today: Date = new Date()): QuickAdd {
  const out: QuickAdd = { title: '', labels: [] };
  const kept: string[] = [];
  for (const word of line.trim().split(/\s+/)) {
    let m: RegExpExecArray | null;
    if ((m = /^!([1-4])$/.exec(word))) { out.priority = Number(m[1]) as TaskPriority; continue; }
    if ((m = /^#([\w./-]{1,60})$/.exec(word))) { if (!out.labels.includes(m[1]!)) out.labels.push(m[1]!); continue; }
    if ((m = /^@([\w.-]{1,40})$/.exec(word))) { out.assignee = m[1]!; continue; }
    if ((m = /^type:(\w+)$/i.exec(word)) && TYPES.includes(m[1]!.toLowerCase())) { out.type = m[1]!.toLowerCase() as TaskType; continue; }
    if ((m = /^due:(.+)$/i.exec(word))) {
      const v = m[1]!.toLowerCase();
      const base = new Date(today.getFullYear(), today.getMonth(), today.getDate());
      let due: string | undefined;
      if (v === 'today') due = ymd(base);
      else if (v === 'tomorrow') { base.setDate(base.getDate() + 1); due = ymd(base); }
      else if (/^\+\d{1,3}d$/.test(v)) { base.setDate(base.getDate() + Number(v.slice(1, -1))); due = ymd(base); }
      else if (isDueDate(v)) due = v;
      if (due) { out.dueDate = due; continue; }
    }
    kept.push(word);
  }
  out.title = kept.join(' ').trim();
  return out;
}
