/**
 * Group a flat transcript into turns: what you asked, the work the agent did,
 * and what it answered.
 *
 * The work — reasoning, tool calls, the running commentary between them — is
 * folded under one "Worked for 1m 12s" line (or "Thought for 5s" when it only
 * thought), the way Antigravity and ChatGPT present it. The answer is the text
 * after the last piece of work. Errors are never folded away.
 *
 * Pure, so it is unit-tested without a DOM.
 *
 * @module desktop/renderer/chat/turns
 */

import type { ChatMessage } from '@aico/ui';

export interface Turn {
  key: string;
  user?: ChatMessage;
  /** Reasoning, tool calls and intermediate text, in order. */
  work: ChatMessage[];
  /** The reply — text after the last piece of work — plus any errors. */
  answer: ChatMessage[];
  /** Only reasoning in the work: say "Thought", not "Worked". */
  onlyThought: boolean;
  toolCount: number;
  startedAt: number;
  endedAt?: number;
  running: boolean;
}

export function groupTurns(messages: ChatMessage[], busy: boolean): Turn[] {
  const raw: Array<{ user?: ChatMessage; items: ChatMessage[] }> = [];
  for (const m of messages) {
    if (m.type === 'user') { raw.push({ user: m, items: [] }); continue; }
    if (raw.length === 0) raw.push({ items: [] });
    raw[raw.length - 1]!.items.push(m);
  }
  return raw.map((t, index) => {
    const last = index === raw.length - 1;
    let lastWork = -1;
    t.items.forEach((m, i) => { if (m.type === 'tool' || m.type === 'reasoning') lastWork = i; });
    const work: ChatMessage[] = [];
    const answer: ChatMessage[] = [];
    t.items.forEach((m, i) => {
      if (m.type === 'error') { answer.push(m); return; }
      if (i <= lastWork) work.push(m); else answer.push(m);
    });
    const tools = work.filter(m => m.type === 'tool').length;
    const startedAt = t.user?.timestamp ?? t.items[0]?.timestamp ?? Date.now();
    const lastItem = t.items[t.items.length - 1];
    const running = last && busy;
    return {
      key: t.user?.id ?? `turn-${index}-${t.items[0]?.id ?? ''}`,
      user: t.user,
      work,
      answer,
      onlyThought: tools === 0 && work.some(m => m.type === 'reasoning') && !work.some(m => m.type === 'assistant'),
      toolCount: tools,
      startedAt,
      endedAt: running ? undefined : (lastItem ? lastItem.timestamp + (lastItem.durationMs ?? 0) : undefined),
      running,
    };
  });
}

/** What the agent is doing right now, for the live "Working…" line. */
export function currentActivity(turn: Turn): string {
  for (let i = turn.work.length - 1; i >= 0; i--) {
    const m = turn.work[i]!;
    if (m.type === 'tool' && m.toolRunning) return describeTool(m);
    if (m.type === 'reasoning' && m.streaming) return 'Thinking';
  }
  const lastTool = [...turn.work].reverse().find(m => m.type === 'tool');
  if (turn.answer.some(m => m.streaming)) return 'Writing';
  return lastTool ? describeTool(lastTool) : 'Thinking';
}

export function describeTool(m: ChatMessage): string {
  const name = m.toolName ?? 'tool';
  const a = (m.toolArgs ?? {}) as Record<string, unknown>;
  const pick = (...keys: string[]): string => {
    for (const k of keys) if (typeof a[k] === 'string' && a[k]) return String(a[k]);
    return '';
  };
  const short = (s: string): string => {
    const clean = s.replace(/\s+/g, ' ').trim();
    const parts = clean.split(/[\\/]/);
    const tail = parts.length > 2 ? parts.slice(-2).join('/') : clean;
    return tail.length > 60 ? tail.slice(0, 57) + '…' : tail;
  };
  switch (name) {
    case 'Read': return `Reading ${short(pick('file_path', 'path'))}`;
    case 'Write': return `Writing ${short(pick('file_path', 'path'))}`;
    case 'Edit': case 'MultiEdit': return `Editing ${short(pick('file_path', 'path'))}`;
    case 'Bash': case 'PowerShell': return `Running ${short(pick('command'))}`;
    case 'Grep': return `Searching for ${short(pick('pattern'))}`;
    case 'Glob': return `Finding ${short(pick('pattern'))}`;
    case 'WebFetch': return `Fetching ${short(pick('url'))}`;
    case 'WebSearch': return `Searching the web for ${short(pick('query'))}`;
    case 'Task': case 'Agent': return `Delegating: ${short(pick('description', 'prompt'))}`;
    default: {
      if (name.startsWith('mcp__aico-desktop__browser_')) return `Browser: ${name.replace('mcp__aico-desktop__browser_', '').replace(/_/g, ' ')}`;
      if (name.startsWith('mcp__aico-desktop__ide_')) return `IDE: ${name.replace('mcp__aico-desktop__ide_', '').replace(/_/g, ' ')}`;
      return `Using ${name.replace(/^mcp__/, '').replace(/__/g, ' · ')}`;
    }
  }
}
