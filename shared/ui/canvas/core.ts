/**
 * The canvas's pure logic — parsing the card, the Markdown formatting
 * commands, file names, the "Ask AI" message — kept out of the components so
 * it can be tested in Node without a DOM.
 *
 * @module shared/ui/canvas/core
 */

import type { CanvasAuthor, CanvasKind, CanvasRef } from './host';

const ID = /^[a-z0-9][a-z0-9-]{2,63}$/i;

/** Read a ```canvas block. Throws with a reason when it is not one. */
export function parseCanvasRef(source: string): CanvasRef {
  const text = source.trim();
  if (ID.test(text)) return { id: text };
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { throw new Error('a canvas block is JSON: {"id":"…","title":"…","kind":"document"}'); }
  const o = raw as Record<string, unknown>;
  if (!o || typeof o !== 'object' || typeof o.id !== 'string' || !ID.test(o.id)) {
    throw new Error('a canvas block needs the "id" the Canvas tool returned');
  }
  const kind: CanvasKind | undefined = o.kind === 'code' || o.kind === 'document' || o.kind === 'sheet' ? o.kind : undefined;
  return {
    id: o.id,
    ...(typeof o.title === 'string' && o.title.trim() ? { title: o.title.trim().slice(0, 120) } : {}),
    ...(kind ? { kind } : {}),
    ...(typeof o.language === 'string' && o.language.trim() ? { language: o.language.trim().toLowerCase() } : {}),
  };
}

// ── Files ────────────────────────────────────────────────────────────

const EXTENSIONS: Record<string, string> = {
  typescript: 'ts', ts: 'ts', tsx: 'tsx', javascript: 'js', js: 'js', jsx: 'jsx', python: 'py', py: 'py',
  ruby: 'rb', rb: 'rb', go: 'go', golang: 'go', rust: 'rs', rs: 'rs', java: 'java', kotlin: 'kt', kt: 'kt',
  csharp: 'cs', cs: 'cs', 'c#': 'cs', cpp: 'cpp', 'c++': 'cpp', c: 'c', php: 'php', swift: 'swift', sql: 'sql',
  bash: 'sh', sh: 'sh', shell: 'sh', zsh: 'sh', powershell: 'ps1', ps1: 'ps1', html: 'html', css: 'css',
  scss: 'scss', json: 'json', yaml: 'yaml', yml: 'yml', toml: 'toml', markdown: 'md', md: 'md', xml: 'xml',
  dockerfile: 'Dockerfile', graphql: 'graphql', lua: 'lua', r: 'r', dart: 'dart', scala: 'scala', vue: 'vue',
  svelte: 'svelte', text: 'txt', plaintext: 'txt',
};

/** The extension a canvas downloads with: .md for a document, the language's own for code. */
export function canvasExtension(kind: CanvasKind, language?: string): string {
  if (kind === 'document') return 'md';
  if (kind === 'sheet') return 'xlsx';
  return EXTENSIONS[(language ?? '').toLowerCase()] ?? 'txt';
}

/** A file name from a title: "Q3 plan: draft #2" → "q3-plan-draft-2". */
export function fileBase(title: string): string {
  return title.normalize('NFKD').replace(/[^\w\- ]+/g, ' ').trim().replace(/[\s_]+/g, '-').replace(/-+/g, '-')
    .toLowerCase().slice(0, 60).replace(/^-|-$/g, '') || 'canvas';
}

/** The file to download a canvas as. Dockerfile has no extension, it is the name. */
export function canvasFileName(title: string, kind: CanvasKind, language?: string, ext?: string): string {
  const e = ext ?? canvasExtension(kind, language);
  return e === 'Dockerfile' ? 'Dockerfile' : `${fileBase(title)}.${e}`;
}

// ── Showing it ───────────────────────────────────────────────────────

/** The first few lines worth showing on a card, without Markdown noise. */
export function previewLines(content: string, kind: CanvasKind, max = 4): string[] {
  const lines = content.replace(/\r\n?/g, '\n').split('\n');
  if (kind === 'code') return lines.filter(l => l.trim()).slice(0, max).map(l => l.slice(0, 160));
  const out: string[] = [];
  let fence = false;
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) { fence = !fence; continue; }
    if (fence) continue;
    const t = line
      .replace(/^\s{0,3}#{1,6}\s+/, '')
      .replace(/^\s*>\s?/, '')
      .replace(/^\s*[-*+]\s+(\[[ xX]\]\s+)?/, '• ')
      .replace(/^\s*(\d+)\.\s+/, '$1. ')
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/(\*\*|__|~~)(.+?)\1/g, '$2')
      .replace(/(^|[^\w*])[*_](\S(?:.*?\S)?)[*_](?=[^\w*]|$)/g, '$1$2')
      .replace(/`([^`]+)`/g, '$1')
      .trim();
    if (!t || /^\|?\s*:?-{2,}/.test(t) || /^(-{3,}|\*{3,}|_{3,})$/.test(t)) continue;
    out.push(t.length > 180 ? `${t.slice(0, 177)}…` : t);
    if (out.length >= max) break;
  }
  return out;
}

export function wordCount(text: string): number {
  return text.split(/\s+/).filter(w => /[\p{L}\p{N}]/u.test(w)).length;
}

/** "just now", "5 min ago", "3 h ago", "yesterday", or a date. */
export function relativeTime(at: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  if (d === 1) return 'yesterday';
  if (d < 7) return `${d} days ago`;
  return new Date(at).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

export function authorLabel(author: CanvasAuthor): string {
  return author === 'user' ? 'You' : 'AICO';
}

// ── Asking the agent ─────────────────────────────────────────────────

/** Longest selection quoted back to the agent; it reads the canvas for the rest. */
export const MAX_QUOTE = 1200;

/**
 * The chat message an "Ask AI" action sends.
 *
 * Names the canvas by id, because that is what the Canvas tool takes, and
 * quotes the selection so the agent can find the passage — trimmed from the
 * middle when long, since the start and the end are what locate it.
 */
export function askMessage(input: { id: string; title?: string; instruction: string; selection?: string }): string {
  const name = input.title ? `canvas ${input.id} ("${input.title}")` : `canvas ${input.id}`;
  const instruction = input.instruction.trim().replace(/\s+$/, '');
  const sel = (input.selection ?? '').trim();
  if (!sel) return `Edit ${name} — ${instruction}`;
  const quoted = sel.length > MAX_QUOTE
    ? `${sel.slice(0, MAX_QUOTE * 0.6)} … ${sel.slice(-MAX_QUOTE * 0.3)}`
    : sel;
  return `Edit ${name} — in the selected passage "${quoted}": ${instruction}`;
}

export interface QuickAction { id: string; label: string; instruction: string }

export const DOCUMENT_ACTIONS: readonly QuickAction[] = [
  { id: 'improve', label: 'Improve writing', instruction: 'improve the writing — clearer, tighter, same meaning and tone' },
  { id: 'shorter', label: 'Make shorter', instruction: 'make it shorter without losing anything important' },
  { id: 'longer', label: 'Make longer', instruction: 'make it longer — add useful detail, not padding' },
  { id: 'grammar', label: 'Fix grammar', instruction: 'fix spelling, grammar and punctuation only; change nothing else' },
  { id: 'formal', label: 'More formal', instruction: 'make the tone more formal and professional' },
  { id: 'casual', label: 'More casual', instruction: 'make the tone friendlier and more casual' },
];

export const CODE_ACTIONS: readonly QuickAction[] = [
  { id: 'comments', label: 'Add comments', instruction: 'add concise comments where the code is not self-explanatory' },
  { id: 'explain', label: 'Explain', instruction: 'explain what this code does (answer in the chat; do not change the canvas unless something is wrong)' },
  { id: 'bugs', label: 'Fix bugs', instruction: 'find and fix bugs; say in the chat what you changed and why' },
  { id: 'readable', label: 'Improve readability', instruction: 'refactor for readability without changing behaviour' },
  { id: 'tests', label: 'Add tests', instruction: 'add tests for this code at the end of the file (or say where they should go)' },
];

// ── Markdown formatting ──────────────────────────────────────────────

export type FormatOp =
  | 'bold' | 'italic' | 'strike' | 'code' | 'link'
  | 'h1' | 'h2' | 'h3' | 'bullet' | 'number' | 'task' | 'quote' | 'codeblock' | 'table' | 'rule';

/**
 * One edit to make: replace `[from, to)` with `insert`, then select
 * `[selStart, selEnd)`. Returned as a splice rather than a whole new text so
 * the editor can apply it with the browser's own insert command — which is
 * what keeps Ctrl+Z working across toolbar actions.
 */
export interface Splice { from: number; to: number; insert: string; selStart: number; selEnd: number }

const INLINE: Record<string, { mark: string; placeholder: string }> = {
  bold: { mark: '**', placeholder: 'bold text' },
  italic: { mark: '_', placeholder: 'italic text' },
  strike: { mark: '~~', placeholder: 'struck text' },
  code: { mark: '`', placeholder: 'code' },
};

/** The Markdown edit a toolbar button or shortcut makes to `text` at the selection. */
export function formatSplice(text: string, start: number, end: number, op: FormatOp): Splice {
  const a = Math.max(0, Math.min(start, end));
  const b = Math.min(text.length, Math.max(start, end));
  const selected = text.slice(a, b);

  const inline = INLINE[op];
  if (inline) {
    const { mark: m, placeholder } = inline;
    // Already wrapped, just outside the selection — unwrap.
    if (a >= m.length && text.slice(a - m.length, a) === m && text.slice(b, b + m.length) === m) {
      return { from: a - m.length, to: b + m.length, insert: selected, selStart: a - m.length, selEnd: b - m.length };
    }
    // Wrapped inside the selection — unwrap.
    if (selected.length >= m.length * 2 && selected.startsWith(m) && selected.endsWith(m)) {
      const inner = selected.slice(m.length, selected.length - m.length);
      return { from: a, to: b, insert: inner, selStart: a, selEnd: a + inner.length };
    }
    // Whitespace at the edges stays outside the marks, or the Markdown breaks.
    const lead = selected.match(/^\s*/)![0];
    const trail = selected.slice(lead.length).match(/\s*$/)![0];
    const core = selected.slice(lead.length, selected.length - trail.length) || placeholder;
    const insert = `${lead}${m}${core}${m}${trail}`;
    const s = a + lead.length + m.length;
    return { from: a, to: b, insert, selStart: s, selEnd: s + core.length };
  }

  if (op === 'link') {
    const label = selected.trim() || 'link text';
    const insert = `[${label}](https://)`;
    const urlAt = a + label.length + 3;
    return { from: a, to: b, insert, selStart: urlAt, selEnd: urlAt + 'https://'.length };
  }

  if (op === 'codeblock') {
    const body = selected || 'code';
    const before = a > 0 && text[a - 1] !== '\n' ? '\n' : '';
    const after = b < text.length && text[b] !== '\n' ? '\n' : '';
    const insert = `${before}\`\`\`\n${body}\n\`\`\`${after}`;
    const s = a + before.length + 4;
    return { from: a, to: b, insert, selStart: s, selEnd: s + body.length };
  }

  if (op === 'table' || op === 'rule') {
    const block = op === 'table'
      ? '| Column 1 | Column 2 |\n| --- | --- |\n| Cell | Cell |'
      : '---';
    const before = a === 0 ? '' : text[a - 1] === '\n' ? (text[a - 2] === '\n' || a < 2 ? '' : '\n') : '\n\n';
    const after = b >= text.length ? '\n' : text[b] === '\n' ? '\n' : '\n\n';
    const insert = `${before}${block}${after}`;
    const s = a + before.length + (op === 'table' ? 2 : block.length);
    return { from: a, to: b, insert, selStart: s, selEnd: op === 'table' ? s + 'Column 1'.length : s };
  }

  // Line operations work on whole lines.
  const lineStart = text.lastIndexOf('\n', a - 1) + 1;
  let lineEnd = text.indexOf('\n', b > a && text[b - 1] === '\n' ? b - 1 : b);
  if (lineEnd < 0) lineEnd = text.length;
  const lines = text.slice(lineStart, lineEnd).split('\n');
  const LIST = /^(\s*)([-*+]\s+\[[ xX]\]\s+|[-*+]\s+|\d+[.)]\s+)/;
  let next: string[];

  if (op === 'h1' || op === 'h2' || op === 'h3') {
    const hashes = '#'.repeat(Number(op[1]));
    const all = lines.every(l => l.startsWith(`${hashes} `));
    next = lines.map(l => {
      const bare = l.replace(/^#{1,6}\s+/, '');
      return all ? bare : (bare.trim() ? `${hashes} ${bare}` : l);
    });
  } else if (op === 'quote') {
    const all = lines.filter(l => l.trim()).every(l => /^\s*>/.test(l));
    next = lines.map(l => (all ? l.replace(/^(\s*)>\s?/, '$1') : (l.trim() ? `> ${l}` : l)));
  } else {
    const marker = (i: number): string => (op === 'number' ? `${i + 1}. ` : op === 'task' ? '- [ ] ' : '- ');
    const is = (l: string): boolean => {
      const m = LIST.exec(l);
      if (!m) return false;
      const token = m[2]!;
      if (op === 'number') return /^\d/.test(token);
      if (op === 'task') return /\[[ xX]\]/.test(token);
      return /^[-*+]\s+$/.test(token) || (/^[-*+]/.test(token) && !/\[/.test(token));
    };
    const content = lines.filter(l => l.trim());
    const all = content.length > 0 && content.every(is);
    let n = 0;
    next = lines.map(l => {
      if (!l.trim()) return l;
      const bare = l.replace(LIST, '$1');
      return all ? bare : bare.replace(/^(\s*)/, `$1${marker(n++)}`);
    });
  }

  const insert = next.join('\n');
  return { from: lineStart, to: lineEnd, insert, selStart: lineStart, selEnd: lineStart + insert.length };
}

/**
 * Enter at the end of a list item: continue the list — or, on an empty item,
 * end it. Returns null when Enter should just be Enter.
 */
export function continueList(text: string, pos: number): Splice | null {
  const lineStart = text.lastIndexOf('\n', pos - 1) + 1;
  let lineEnd = text.indexOf('\n', pos);
  if (lineEnd < 0) lineEnd = text.length;
  if (text.slice(pos, lineEnd).trim()) return null; // mid-line: an ordinary break
  const line = text.slice(lineStart, pos);
  const m = /^(\s*)(?:([-*+])\s+(\[[ xX]\]\s+)?|(\d+)([.)])\s+|>\s?)/.exec(line);
  if (!m) return null;
  const rest = line.slice(m[0].length);
  if (!rest.trim()) {
    // An empty item ends the list: clear the marker, leave the line.
    return { from: lineStart, to: pos, insert: m[1] ?? '', selStart: lineStart + (m[1] ?? '').length, selEnd: lineStart + (m[1] ?? '').length };
  }
  const indent = m[1] ?? '';
  const marker = m[2] ? `${m[2]} ${m[3] ? '[ ] ' : ''}` : m[4] ? `${Number(m[4]) + 1}${m[5]} ` : '> ';
  const insert = `\n${indent}${marker}`;
  return { from: pos, to: pos, insert, selStart: pos + insert.length, selEnd: pos + insert.length };
}

/** Apply a splice to a string — what the editor falls back to without `execCommand`. */
export function applySplice(text: string, s: Splice): string {
  return text.slice(0, s.from) + s.insert + text.slice(s.to);
}

// ── Export ───────────────────────────────────────────────────────────

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

/**
 * A self-contained HTML file of a rendered canvas.
 *
 * Its own small stylesheet rather than the app's: the file is for someone who
 * has never seen AICO, opened in whatever browser they have, and it must look
 * like a clean document there — not like a screenshot of a chat client.
 */
export function standaloneHtml(title: string, bodyHtml: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  body { margin: 0; background: #fff; color: #1a1a1a; font: 16px/1.65 -apple-system, "Segoe UI", system-ui, sans-serif; }
  main { max-width: 760px; margin: 0 auto; padding: 48px 28px 72px; }
  h1, h2, h3, h4 { line-height: 1.25; margin: 1.6em 0 0.5em; }
  h1 { font-size: 2em; margin-top: 0; } h2 { font-size: 1.5em; } h3 { font-size: 1.2em; }
  p, ul, ol, blockquote, pre, table { margin: 0 0 1em; }
  a { color: #2563eb; }
  blockquote { border-left: 3px solid #d4d4d8; padding-left: 14px; color: #52525b; }
  code { font: 0.9em ui-monospace, "Cascadia Code", Consolas, monospace; background: #f4f4f5; padding: 1px 5px; border-radius: 4px; }
  pre { background: #f4f4f5; padding: 12px 14px; border-radius: 8px; overflow-x: auto; }
  pre code { background: none; padding: 0; }
  table { border-collapse: collapse; } th, td { border: 1px solid #e4e4e7; padding: 6px 10px; text-align: left; }
  img, svg { max-width: 100%; }
  hr { border: 0; border-top: 1px solid #e4e4e7; margin: 2em 0; }
  @media print { main { padding: 0; } }
</style>
</head>
<body>
<main>
${bodyHtml}
</main>
</body>
</html>
`;
}
