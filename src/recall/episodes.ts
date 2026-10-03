/**
 * Episodes: what a past session was about, built from its log with no model
 * call (ADR 0018).
 *
 * WHY NO MODEL. "What did we do last week about the invoices?" needs a
 * searchable line per session, and there may be a thousand sessions. A
 * summary per session from a model would cost money for every one nobody ever
 * asks about, and would put words in the record that nobody said. The log
 * already holds what matters: the person's own request, the agent's final
 * answer, the files it wrote and the tools it used.
 *
 * WHAT COUNTS. Only `user/message` events from a human (not guard reminders,
 * plugins or compaction summaries) are requests; the outcome is the last
 * non-empty `assistant/message`. A session that is mid-turn (a request with no
 * `turn/end` after it, and recent) is not built yet: half an episode would be
 * indexed and then contradicted.
 *
 * READING CHEAPLY. Logs can be megabytes of chunks and tool output. Lines are
 * rejected by substring before any JSON parsing, the same trick
 * session/persistence uses for the sidebar.
 *
 * @module recall/episodes
 */

import fs from 'fs';
import path from 'path';
import { aicoHome } from '../home.js';
import { clip } from './text.js';

export interface Episode {
  sessionId: string;
  cwd?: string;
  title: string;
  /** The first human request(s), clipped. */
  request: string;
  /** The final assistant answer, clipped. */
  outcome: string;
  files: string[];
  tools: string[];
  turns: number;
  startedAt: number;
  endedAt: number;
  /** What is indexed for words (and embedded for meaning). */
  text: string;
}

/** A session still talking within this window, with a turn open, is not an episode yet. */
const OPEN_TURN_GRACE_MS = 30 * 60 * 1000;

/** Tools whose arguments name a file the session changed. */
const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'CodeRewrite', 'Refactor']);

/**
 * One session log (the file's text) as an episode, or undefined when there is
 * nothing a person asked or a turn is still open.
 */
export function episodeFromLog(text: string, opts: { sessionId: string; now?: number }): Episode | undefined {
  const now = opts.now ?? Date.now();
  let cwd: string | undefined;
  let startedAt = 0; let endedAt = 0;
  let title: string | undefined;
  const requests: string[] = [];
  let outcome = '';
  let lastUserSeq = -1; let lastEndSeq = -1;
  let turns = 0;
  const files = new Set<string>();
  const tools = new Map<string, number>();

  for (const line of text.split(/\r?\n/)) {
    if (!line) continue;
    const header = line.includes('"__header__"');
    const user = line.includes('"user/message"');
    const assistant = line.includes('"assistant/message"');
    const call = line.includes('"tool/call"');
    const ttl = line.includes('"session/title"');
    const end = line.includes('"turn/end"');
    if (!header && !user && !assistant && !call && !ttl && !end) continue;
    let ev: { type?: string; seq?: number; timestamp?: number; cwd?: string; startedAt?: number; data?: Record<string, unknown> };
    try { ev = JSON.parse(line); } catch { continue; /* a torn line is one lost event, not a lost episode */ }
    if (ev.type === '__header__') {
      cwd = typeof ev.cwd === 'string' ? ev.cwd : undefined;
      if (typeof ev.startedAt === 'number') startedAt = ev.startedAt;
      continue;
    }
    if (typeof ev.timestamp === 'number') {
      if (!startedAt || ev.timestamp < startedAt) startedAt = ev.timestamp;
      if (ev.timestamp > endedAt) endedAt = ev.timestamp;
    }
    const seq = typeof ev.seq === 'number' ? ev.seq : 0;
    const d = ev.data ?? {};
    switch (ev.type) {
      case 'user/message': {
        const source = d.source as { kind?: string } | undefined;
        if (source?.kind && source.kind !== 'human') break;
        if (typeof d.content !== 'string' || !d.content.trim()) break;
        turns++;
        if (seq > lastUserSeq) lastUserSeq = seq;
        if (requests.length < 2) requests.push(clip(d.content, 300));
        break;
      }
      case 'assistant/message':
        if (typeof d.content === 'string' && d.content.trim()) outcome = d.content;
        break;
      case 'tool/call': {
        const name = typeof d.name === 'string' ? d.name : '';
        if (!name) break;
        tools.set(name, (tools.get(name) ?? 0) + 1);
        if (WRITE_TOOLS.has(name) && files.size < 40) {
          try {
            const args = JSON.parse(String(d.arguments ?? '{}')) as Record<string, unknown>;
            const p = args.file_path ?? args.path ?? args.notebook_path ?? args.file;
            if (typeof p === 'string' && p.trim()) files.add(shortPath(p, cwd));
          } catch { /* arguments the model mangled: the tool name still counts */ }
        }
        break;
      }
      case 'session/title':
        if (typeof d.title === 'string' && d.title.trim()) title = d.title.trim();
        break;
      case 'turn/end':
        if (seq > lastEndSeq) lastEndSeq = seq;
        break;
    }
  }

  if (requests.length === 0) return undefined;
  const open = lastUserSeq > lastEndSeq;
  if (open && now - endedAt < OPEN_TURN_GRACE_MS) return undefined;

  const toolList = [...tools.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([n]) => n);
  const fileList = [...files].slice(0, 12);
  const name = title ?? clip(requests[0]!, 80);
  const request = requests.join(' / ');
  const out = clip(outcome, 400);
  const body = [
    request,
    out ? `Outcome: ${out}` : '',
    fileList.length ? `Files: ${fileList.join(', ')}` : '',
    toolList.length ? `Tools: ${toolList.join(', ')}` : '',
  ].filter(Boolean).join('\n');
  return {
    sessionId: opts.sessionId, ...(cwd ? { cwd } : {}), title: name, request, outcome: out,
    files: fileList, tools: toolList, turns, startedAt: startedAt || endedAt, endedAt: endedAt || startedAt, text: body,
  };
}

/** A path relative to the project when it is inside it; separators made forward. */
function shortPath(p: string, cwd: string | undefined): string {
  let out = p;
  if (cwd && path.isAbsolute(p)) {
    const rel = path.relative(cwd, p);
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) out = rel;
  }
  return out.replace(/\\/g, '/');
}

export interface SessionLogFile { id: string; file: string; mtimeMs: number; size: number }

/** Every session event log in the store, across projects. */
export function listSessionLogs(): SessionLogFile[] {
  const root = path.join(aicoHome(), 'projects');
  let projects: string[] = [];
  try { projects = fs.readdirSync(root); } catch { return []; }
  const out: SessionLogFile[] = [];
  for (const p of projects) {
    const dir = path.join(root, p, 'sessions');
    let names: string[] = [];
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const n of names) {
      if (!n.endsWith('.events.jsonl')) continue;
      const file = path.join(dir, n);
      try {
        const s = fs.statSync(file);
        out.push({ id: n.slice(0, -'.events.jsonl'.length), file, mtimeMs: s.mtimeMs, size: s.size });
      } catch { /* removed between listing and stat */ }
    }
  }
  return out;
}
