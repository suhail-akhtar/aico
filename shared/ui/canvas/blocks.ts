/**
 * A Markdown document as a list of top-level blocks, each with its exact
 * source span — the unit AICO Docs reads, edits and saves.
 *
 * ## Why blocks with spans, not a parsed tree
 *
 * The editor's promise (see `CanvasEditor`'s header) is that a save changes
 * exactly what the person changed. A tree editor re-serialises the whole
 * document; this module instead cuts the text into top-level blocks and
 * remembers where each one starts and ends. Editing a paragraph replaces that
 * paragraph's span and nothing else — every other byte, including the blank
 * lines between blocks, odd list markers and table padding, is copied through
 * untouched. {@link replaceBlock} is the only way an edit reaches the text.
 *
 * The splitter follows CommonMark/GFM closely enough for block *boundaries*
 * (fences, display maths, HTML comments, headings, setext headings, rules,
 * tables, quotes, lists with nesting and loose items, indented code,
 * paragraphs). It does not need to understand what is inside a block: the
 * chat's renderer draws each block, and a block this module splits slightly
 * differently from remark still renders and still round-trips, because a span
 * is only ever replaced by what the person typed into it.
 *
 * Deliberately not handled: reference-link definitions and footnotes that
 * live in another block still split fine, but render per block — a
 * `[text][ref]` whose definition is elsewhere shows as text in the reading
 * view (the export and the source mode are unaffected).
 *
 * Also here: pending placeholders (`<!-- aico:pending id="…" intent="…" -->`)
 * and sections (a heading until the next heading of the same or higher level,
 * or a pending block), which is how the agent's live writing is located.
 *
 * @module shared/ui/canvas/blocks
 */

export type BlockKind =
  | 'heading' | 'paragraph' | 'list' | 'quote' | 'code' | 'math' | 'table' | 'html' | 'pending' | 'rule';

export interface Block {
  kind: BlockKind;
  /** Offset of the first character in the document. */
  start: number;
  /** Offset just past the last character (the final line break is not part of the block). */
  end: number;
  /** `source.slice(start, end)`. */
  text: string;
  /** Headings: 1–6. */
  level?: number;
  /** Fenced code: the info string's first word, lower-cased. */
  lang?: string;
  /** Pending placeholders. */
  pending?: PendingBlock;
}

export interface PendingBlock { id: string; intent: string; heading?: string }

interface Line { text: string; start: number; end: number }

function linesOf(source: string): Line[] {
  const out: Line[] = [];
  let at = 0;
  while (at <= source.length) {
    const nl = source.indexOf('\n', at);
    const stop = nl < 0 ? source.length : nl;
    // A CRLF document: the '\r' belongs to the line break, not to the text.
    const end = stop > at && source[stop - 1] === '\r' ? stop - 1 : stop;
    out.push({ text: source.slice(at, end), start: at, end });
    if (nl < 0) break;
    at = nl + 1;
  }
  return out;
}

const BLANK = /^\s*$/;
const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([^\s`]*)?/;
const ATX = /^ {0,3}(#{1,6})(?:[ \t]+|$)/;
const RULE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const SETEXT = /^ {0,3}(=+|-+)[ \t]*$/;
const BULLET = /^( {0,3})([-*+])([ \t]+|$)/;
const ORDERED = /^( {0,3})(\d{1,9})([.)])([ \t]+|$)/;
const ANY_ITEM = /^(\s*)([-*+]|\d{1,9}[.)])([ \t]+|$)/;
const QUOTE = /^ {0,3}>/;
const TABLE_DELIM = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
const HTML_OPEN = /^ {0,3}<(\/?[a-zA-Z][\w-]*|!--)/;
const INDENTED = /^( {4}|\t)/;

const PENDING = /^\s*<!--\s*aico:pending\b([^]*?)-->\s*$/;

/** Read a pending placeholder line, or null. Attribute values may use `&quot;` for a quote. */
export function parsePending(text: string): PendingBlock | null {
  const m = PENDING.exec(text);
  if (!m) return null;
  const attrs: Record<string, string> = {};
  const re = /([a-zA-Z][\w-]*)\s*=\s*"([^"]*)"/g;
  for (let a = re.exec(m[1]!); a; a = re.exec(m[1]!)) attrs[a[1]!.toLowerCase()] = unescapeAttr(a[2]!);
  if (!attrs.id) return null;
  return { id: attrs.id, intent: attrs.intent ?? '', ...(attrs.heading ? { heading: attrs.heading } : {}) };
}

/** Attribute values are entity-encoded by the engine (`&quot; &amp; &lt; &gt;`, and `--` as `-&#45;`). */
function unescapeAttr(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n: string) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/--/g, '-&#45;').replace(/\s+/g, ' ');
}

/** The Markdown line for a pending placeholder. */
export function pendingLine(id: string, intent: string, heading?: string): string {
  return `<!-- aico:pending id="${escapeAttr(id)}" intent="${escapeAttr(intent)}"${heading ? ` heading="${escapeAttr(heading)}"` : ''} -->`;
}

function isTableStart(lines: Line[], i: number): boolean {
  const head = lines[i]?.text ?? '';
  const delim = lines[i + 1]?.text ?? '';
  return head.includes('|') && TABLE_DELIM.test(delim) && delim.includes('-') && (delim.includes('|') || head.trim().startsWith('|'));
}

/** Does this line start a block that interrupts a paragraph? */
function interrupts(lines: Line[], i: number): boolean {
  const t = lines[i]!.text;
  if (FENCE.test(t) || ATX.test(t) || QUOTE.test(t) || /^ {0,3}<!--/.test(t) || /^ {0,3}\$\$/.test(t)) return true;
  if (RULE.test(t) && !/^ {0,3}-+[ \t]*$/.test(t)) return true; // `---` under a paragraph is a setext heading, handled by the caller
  if (BULLET.test(t) && !BLANK.test(t.replace(BULLET, ''))) return true;
  const o = ORDERED.exec(t);
  if (o && o[2] === '1' && !BLANK.test(t.replace(ORDERED, ''))) return true;
  if (isTableStart(lines, i)) return true;
  return false;
}

/**
 * Cut a document into top-level blocks. Blank lines between blocks belong to
 * no block; everything else belongs to exactly one, in order.
 */
export function splitBlocks(source: string): Block[] {
  const lines = linesOf(source);
  const blocks: Block[] = [];
  const push = (kind: BlockKind, from: number, to: number, extra: Partial<Block> = {}): void => {
    const start = lines[from]!.start;
    const end = lines[to]!.end;
    blocks.push({ kind, start, end, text: source.slice(start, end), ...extra });
  };

  let i = 0;
  while (i < lines.length) {
    const t = lines[i]!.text;
    if (BLANK.test(t)) { i++; continue; }

    // Fenced code (and the widget fences: mermaid, chart, math…).
    const fence = FENCE.exec(t);
    if (fence) {
      const mark = fence[1]!;
      const lang = (fence[2] ?? '').toLowerCase();
      let j = i + 1;
      const close = new RegExp(`^ {0,3}${mark[0] === '`' ? '`' : '~'}{${mark.length},}\\s*$`);
      while (j < lines.length && !close.test(lines[j]!.text)) j++;
      const last = Math.min(j, lines.length - 1);
      push(lang === 'math' || lang === 'latex' || lang === 'tex' ? 'math' : 'code', i, last, lang ? { lang } : {});
      i = last + 1;
      continue;
    }

    // Display maths.
    if (/^ {0,3}\$\$/.test(t)) {
      const rest = t.trim().slice(2);
      let j = i;
      if (!(rest.length >= 2 && rest.endsWith('$$'))) {
        j = i + 1;
        while (j < lines.length && !/\$\$\s*$/.test(lines[j]!.text)) j++;
      }
      const last = Math.min(j, lines.length - 1);
      push('math', i, last);
      i = last + 1;
      continue;
    }

    // HTML comments — a pending placeholder, or any other comment.
    if (/^ {0,3}<!--/.test(t)) {
      let j = i;
      while (j < lines.length && !lines[j]!.text.includes('-->')) j++;
      const last = Math.min(j, lines.length - 1);
      const pending = last === i ? parsePending(t) : null;
      push(pending ? 'pending' : 'html', i, last, pending ? { pending } : {});
      i = last + 1;
      continue;
    }

    const atx = ATX.exec(t);
    if (atx) {
      push('heading', i, i, { level: atx[1]!.length });
      i++;
      continue;
    }

    if (RULE.test(t)) {
      push('rule', i, i);
      i++;
      continue;
    }

    if (isTableStart(lines, i)) {
      let j = i + 2;
      while (j < lines.length && !BLANK.test(lines[j]!.text) && lines[j]!.text.includes('|')) j++;
      push('table', i, j - 1);
      i = j;
      continue;
    }

    if (QUOTE.test(t)) {
      let j = i + 1;
      // Lazy continuation: a non-blank line that starts no other block stays in the quote.
      while (j < lines.length && !BLANK.test(lines[j]!.text) && (QUOTE.test(lines[j]!.text) || !interrupts(lines, j))) j++;
      push('quote', i, j - 1);
      i = j;
      continue;
    }

    if (BULLET.test(t) || ORDERED.test(t)) {
      let j = i + 1;
      let lastContent = i;
      while (j < lines.length) {
        const l = lines[j]!.text;
        if (BLANK.test(l)) { j++; continue; }
        const afterBlank = j > lastContent + 1;
        const indented = /^\s/.test(l);
        if (ANY_ITEM.test(l) && !RULE.test(l)) { lastContent = j; j++; continue; }
        if (indented) { lastContent = j; j++; continue; }
        // Unindented, not an item: lazy continuation directly under an item, else the list is over.
        if (!afterBlank && !interrupts(lines, j) && !RULE.test(l)) { lastContent = j; j++; continue; }
        break;
      }
      push('list', i, lastContent);
      i = lastContent + 1;
      continue;
    }

    if (INDENTED.test(t)) {
      let j = i + 1;
      let lastContent = i;
      while (j < lines.length && (BLANK.test(lines[j]!.text) || INDENTED.test(lines[j]!.text))) {
        if (!BLANK.test(lines[j]!.text)) lastContent = j;
        j++;
      }
      push('code', i, lastContent);
      i = lastContent + 1;
      continue;
    }

    if (HTML_OPEN.test(t)) {
      let j = i + 1;
      while (j < lines.length && !BLANK.test(lines[j]!.text)) j++;
      push('html', i, j - 1);
      i = j;
      continue;
    }

    // A paragraph — or a setext heading, if an underline ends it.
    let j = i + 1;
    let setext = 0;
    while (j < lines.length && !BLANK.test(lines[j]!.text)) {
      const s = SETEXT.exec(lines[j]!.text);
      if (s) { setext = s[1]![0] === '=' ? 1 : 2; break; }
      if (interrupts(lines, j)) break;
      j++;
    }
    if (setext) {
      push('heading', i, j, { level: setext });
      i = j + 1;
    } else {
      push('paragraph', i, j - 1);
      i = j;
    }
  }
  return blocks;
}

/** Replace one block's span. Every byte outside `[block.start, block.end)` is kept. */
export function replaceBlock(source: string, block: Pick<Block, 'start' | 'end'>, next: string): string {
  return source.slice(0, block.start) + next + source.slice(block.end);
}

/**
 * Put a new block after `after` (or at the top when null), separated by one
 * blank line on each side it touches. Returns the text and the new block's span.
 */
export function insertBlockAfter(source: string, after: Pick<Block, 'end'> | null, text: string): { source: string; start: number; end: number } {
  if (!after) {
    if (!source.trim()) return { source: `${text}\n`, start: 0, end: text.length };
    const rest = source.replace(/^\s*\n/, '');
    return { source: `${text}\n\n${rest}`, start: 0, end: text.length };
  }
  const head = source.slice(0, after.end);
  const tail = source.slice(after.end);
  // Keep whatever separated `after` from the next block; add a blank line of our own.
  const insert = `\n\n${text}`;
  const start = head.length + 2;
  return { source: head + insert + tail, start, end: start + text.length };
}

/** Remove a block and one blank-line separator next to it. */
export function removeBlock(source: string, block: Pick<Block, 'start' | 'end'>): string {
  let a = block.start;
  let b = block.end;
  const after = /^(\r?\n)+/.exec(source.slice(b));
  if (after) b += after[0].length;
  else {
    const before = /(\r?\n)+$/.exec(source.slice(0, a));
    if (before) a -= before[0].length;
  }
  return source.slice(0, a) + source.slice(b);
}

// ── Sections ─────────────────────────────────────────────────────────

/** A heading's text without its marks: `## **Goals** ##` → `Goals`. */
export function headingText(block: Pick<Block, 'text' | 'kind'>): string {
  let t = block.text.split(/\r?\n/)[0]!;
  t = t.replace(/^ {0,3}#{1,6}[ \t]*/, '').replace(/[ \t]+#+[ \t]*$/, '');
  return plainInline(t).trim();
}

/** Inline Markdown to its visible text — marks, links and code ticks removed. */
export function plainInline(s: string): string {
  return s
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__|~~)(.+?)\1/g, '$2')
    .replace(/(^|[^\w*])[*_](\S(?:.*?\S)?)[*_](?=[^\w*]|$)/g, '$1$2')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\\([\\`*_{}[\]()#+\-.!|~>])/g, '$1');
}

const norm = (s: string): string => s.replace(/\s+/g, ' ').trim().toLowerCase();

/**
 * The blocks `[from, to)` a section key names: a pending id, or a heading's
 * text (exact, then case/space-insensitive). Null when nothing matches.
 */
export function findSection(
  blocks: readonly Block[], key: string | undefined, sectionIds?: Record<string, string>,
): { from: number; to: number } | null {
  if (!key) return null;
  let k = key.replace(/^#+\s*/, '');
  const p = blocks.findIndex(b => b.kind === 'pending' && b.pending?.id === k);
  if (p >= 0) return { from: p, to: p + 1 };
  // A written section keeps its id: the engine maps it to the heading it became.
  if (sectionIds?.[k]) k = sectionIds[k]!;
  let h = blocks.findIndex(b => b.kind === 'heading' && headingText(b) === plainInline(k).trim());
  if (h < 0) h = blocks.findIndex(b => b.kind === 'heading' && norm(headingText(b)) === norm(plainInline(k)));
  if (h < 0) return null;
  const level = blocks[h]!.level ?? 1;
  let to = h + 1;
  while (to < blocks.length && !(blocks[to]!.kind === 'heading' && (blocks[to]!.level ?? 1) <= level) && blocks[to]!.kind !== 'pending') to++;
  return { from: h, to };
}

/** The heading path above a block — a stable name for "where this block is" across edits. */
export function sectionPath(blocks: readonly Block[], index: number): string {
  const path: Array<{ level: number; text: string }> = [];
  for (let i = 0; i <= index && i < blocks.length; i++) {
    const b = blocks[i]!;
    if (b.kind !== 'heading') continue;
    const level = b.level ?? 1;
    while (path.length && path[path.length - 1]!.level >= level) path.pop();
    path.push({ level, text: headingText(b) });
  }
  return path.map(p => p.text).join(' › ');
}

/** Stable React keys: the block's text, numbered when the same text repeats. */
export function blockKeys(blocks: readonly Block[]): string[] {
  const seen = new Map<string, number>();
  return blocks.map((b) => {
    const base = `${b.kind}:${b.text.length}:${hash(b.text)}`;
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return n ? `${base}#${n}` : base;
  });
}

function hash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

// ── Keeping edits across somebody else's write ───────────────────────

/** A change the person made to one block: its text before, and after. */
export interface BlockEdit { before: string; after: string }

/**
 * Re-apply the person's unsaved block edits on top of a newer document.
 *
 * Each edit is located by its exact old text; when that text occurs exactly
 * once in the newer document it is replaced there. An edit whose old text is
 * gone (the agent rewrote that block) or ambiguous fails the rebase — the
 * caller then shows the conflict banner rather than guessing.
 */
export function rebaseEdits(latest: string, edits: readonly BlockEdit[]): { ok: true; text: string } | { ok: false; failed: BlockEdit } {
  let text = latest;
  for (const e of edits) {
    if (e.before === e.after) continue;
    if (!e.before) {
      // A new block (inserted): it has nowhere to be found; append it.
      text = text.replace(/\s*$/, '') + `\n\n${e.after}\n`;
      continue;
    }
    const at = text.indexOf(e.before);
    if (at < 0 || text.indexOf(e.before, at + 1) >= 0) return { ok: false, failed: e };
    text = text.slice(0, at) + e.after + text.slice(at + e.before.length);
  }
  return { ok: true, text };
}

/** Blocks whose text is not in `before` — what somebody just wrote, for a brief highlight. */
export function changedBlocks(before: string, blocks: readonly Block[]): number[] {
  if (!before) return [];
  const old = new Set(splitBlocks(before).map(b => b.text));
  const out: number[] = [];
  blocks.forEach((b, i) => { if (!old.has(b.text)) out.push(i); });
  return out;
}

/** Remove pending placeholders — what "Copy as Markdown" hands out. */
export function stripPending(source: string): string {
  const blocks = splitBlocks(source).filter(b => b.kind === 'pending');
  let out = source;
  for (const b of [...blocks].reverse()) out = removeBlock(out, b);
  return out;
}

// ── Inserting ────────────────────────────────────────────────────────

/** A Markdown table with `rows` body rows and `cols` columns. */
export function tableMarkdown(rows: number, cols: number): string {
  const c = Math.max(1, Math.min(12, cols | 0));
  const r = Math.max(1, Math.min(50, rows | 0));
  const head = `| ${Array.from({ length: c }, (_, i) => `Column ${i + 1}`).join(' | ')} |`;
  const delim = `| ${Array.from({ length: c }, () => '---').join(' | ')} |`;
  const body = Array.from({ length: r }, () => `| ${Array.from({ length: c }, () => '   ').join(' | ')} |`);
  return [head, delim, ...body].join('\n');
}

export type InsertKind = 'paragraph' | 'heading' | 'table' | 'checklist' | 'bullets' | 'numbers' | 'quote' | 'divider'
  | 'callout' | 'code' | 'mermaid' | 'chart' | 'math';

/** The starter Markdown for an inserted block. */
export function insertTemplate(kind: InsertKind): string {
  switch (kind) {
    case 'paragraph': return 'New paragraph';
    case 'heading': return '## New section';
    case 'table': return tableMarkdown(2, 3);
    case 'checklist': return '- [ ] First item\n- [ ] Second item';
    case 'bullets': return '- First item\n- Second item';
    case 'numbers': return '1. First item\n2. Second item';
    case 'quote': return '> Quoted text';
    case 'divider': return '---';
    case 'callout': return '> **Note:** Something the reader should not miss.';
    case 'code': return '```\ncode\n```';
    case 'mermaid': return '```mermaid\nflowchart LR\n  A[Start] --> B[Next step] --> C[Done]\n```';
    case 'chart': return '```chart\n{\n  "xAxis": { "type": "category", "data": ["Q1", "Q2", "Q3", "Q4"] },\n  "yAxis": { "type": "value" },\n  "series": [{ "type": "bar", "data": [12, 19, 15, 24] }]\n}\n```';
    case 'math': return '$$\nE = mc^2\n$$';
  }
}
