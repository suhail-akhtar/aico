/**
 * Rendering a session as a document.
 *
 * A transcript is worth keeping — pasted into a ticket, attached to a PR,
 * mailed to someone who was not watching. So it exports as Markdown, which
 * survives being pasted anywhere and stays readable if nothing renders it.
 *
 * What it includes is a judgement, not a dump. Reasoning is folded into
 * `<details>` because it is long and secondary; tool calls become one line each
 * with their output in a fenced block; bookkeeping events are dropped entirely.
 * An export that reproduces the event log is not a document, it is a log with
 * different punctuation.
 *
 * @module session/export
 */

import type { Session } from './session.js';
import { currentTitle } from './title.js';
import { currentGoal, deliverables } from './projections.js';

export interface ExportOptions {
  /** Include the model's reasoning. Default: true, collapsed. */
  includeReasoning?: boolean;
  /** Include tool calls and their results. Default: true. */
  includeTools?: boolean;
  /** How much of a tool result to keep, in characters. */
  maxToolResult?: number;
}

const DEFAULT_MAX_TOOL_RESULT = 2000;

/**
 * Render the session as Markdown.
 *
 * Deliberately not the model-facing projection: that one drops shadowed events
 * and merges compaction summaries, which is right for a request and wrong for a
 * record of what happened.
 */
export function toMarkdown(session: Session, opts: ExportOptions = {}): string {
  const includeReasoning = opts.includeReasoning ?? true;
  const includeTools = opts.includeTools ?? true;
  const maxToolResult = opts.maxToolResult ?? DEFAULT_MAX_TOOL_RESULT;

  const title = currentTitle(session)?.title ?? session.header.id;
  const goal = currentGoal(session);
  const started = new Date(session.header.startedAt);

  const out: string[] = [
    `# ${title}`,
    '',
    `*${started.toLocaleString()} · ${session.header.cwd}*`,
    '',
  ];

  if (goal) {
    out.push(`> **Goal:** ${goal.text}${goal.status === 'paused' ? ' *(paused)*' : ''}`, '');
  }

  // Tool calls are matched to their results by call id, which is the only
  // reliable pairing: up to eight run in parallel and finish out of order.
  const resultsByCall = new Map<string, { content: string; isError: boolean }>();
  for (const event of session.events) {
    if (event.type !== 'tool/result') continue;
    const data = event.data as { callId: string; content: string; isError?: boolean };
    resultsByCall.set(data.callId, { content: data.content, isError: data.isError === true });
  }

  for (const event of session.events) {
    switch (event.type) {
      case 'user/message': {
        const content = String((event.data as { content: string }).content ?? '').trim();
        if (content) out.push('## You', '', content, '');
        break;
      }

      case 'assistant/message': {
        const data = event.data as { content?: string; reasoning?: { content?: string } };
        const reasoning = includeReasoning ? readReasoning(data.reasoning) : '';
        if (reasoning) {
          out.push(
            '<details>',
            '<summary>Thinking</summary>',
            '',
            reasoning,
            '',
            '</details>',
            '',
          );
        }
        const content = String(data.content ?? '').trim();
        if (content) out.push('## AICO', '', content, '');
        break;
      }

      case 'tool/call': {
        if (!includeTools) break;
        const data = event.data as { name: string; callId: string; arguments: string };
        const result = resultsByCall.get(data.callId);
        const args = summarizeArgs(data.arguments);
        out.push(`**${data.name}**${args ? ` — \`${args}\`` : ''}`, '');
        if (result?.content?.trim()) {
          const body = clip(result.content, maxToolResult);
          out.push('```', body, '```', '');
        }
        break;
      }

      default:
        // turn/step boundaries, request headers, titles, feedback: bookkeeping.
        break;
    }
  }

  const produced = deliverables(session);
  if (produced.length > 0) {
    out.push('---', '', '## Files produced', '');
    for (const file of produced) {
      out.push(`- \`${file.path}\` — ${file.action}${file.touches > 1 ? ` (×${file.touches})` : ''}`);
    }
    out.push('');
  }

  return out.join('\n').replace(/\n{3,}/g, '\n\n');
}

/**
 * Render the session as plain text.
 *
 * For anywhere Markdown is noise rather than structure — a terminal, a plain
 * email, an issue tracker that renders nothing.
 */
export function toPlainText(session: Session, opts: ExportOptions = {}): string {
  return toMarkdown(session, opts)
    // Fenced blocks lose their fences but keep their content.
    .replace(/^```.*$/gm, '')
    .replace(/^<\/?details>$/gm, '')
    .replace(/^<summary>(.*)<\/summary>$/gm, '$1:')
    .replace(/^#+\s*/gm, '')
    .replace(/^>\s?/gm, '')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/\*(.+?)\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\n{3,}/g, '\n\n')
    .trim() + '\n';
}

/** A filename that is safe everywhere and still says what it holds. */
export function exportFilename(session: Session, extension: 'md' | 'txt'): string {
  const title = currentTitle(session)?.title ?? session.header.id;
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'session';
  const date = new Date(session.header.startedAt).toISOString().slice(0, 10);
  return `${date}-${slug}.${extension}`;
}

/** Reasoning traces are provider-opaque; render prose, never JSON. */
function readReasoning(trace: unknown): string {
  if (!trace || typeof trace !== 'object') return '';
  const { content } = trace as { content?: unknown };
  if (typeof content !== 'string' || !content.trim()) return '';
  if (!content.trimStart().startsWith('[')) return content.trim();
  try {
    const blocks = JSON.parse(content) as unknown;
    if (!Array.isArray(blocks)) return content.trim();
    const text = blocks
      .map(b => (b && typeof b === 'object' ? (b as { thinking?: string; text?: string }) : {}))
      .map(b => b.thinking ?? b.text ?? '')
      .filter(Boolean)
      .join('\n\n');
    return text.trim() || content.trim();
  } catch {
    return content.trim();
  }
}

/** One readable line of a tool's arguments. */
function summarizeArgs(raw: string): string {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    for (const key of ['command', 'query', 'pattern', 'url', 'file_path', 'path', 'description']) {
      const value = parsed[key];
      if (typeof value === 'string' && value.trim()) {
        return value.trim().replace(/\s+/g, ' ').slice(0, 120);
      }
    }
    return '';
  } catch {
    return '';
  }
}

function clip(text: string, max: number): string {
  const trimmed = text.replace(/\s+$/, '');
  if (trimmed.length <= max) return trimmed;
  const omitted = trimmed.length - max;
  return `${trimmed.slice(0, max)}\n… ${omitted.toLocaleString()} more characters`;
}
