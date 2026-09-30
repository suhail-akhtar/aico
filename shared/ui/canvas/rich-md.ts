/**
 * The small rich-text model behind AICO Docs' in-place editing of prose
 * blocks: Markdown → model → editable HTML, and editable DOM → model →
 * Markdown, for exactly one block at a time.
 *
 * ## Why a model this small, and the round-trip rule
 *
 * Only headings, paragraphs, lists (bullets, numbers, checklists, nested) and
 * quotes of paragraphs are edited richly; their inline content is text,
 * bold, italic, strikethrough, code, links and line breaks. Everything richer
 * (tables, code, maths, charts, images, HTML) is edited as source.
 *
 * A block is offered for rich editing **only if** `serialize(parse(text))`
 * gives back its exact text ({@link richEditable}). So a block this model
 * would normalise — `*` bullets written with odd spacing, an entity, an inline
 * formula, a lazy continuation line — never enters the rich editor; it gets
 * the source editor instead and keeps its bytes. And a block that does enter
 * is serialised on save only if the person actually changed it (the editor
 * compares the model it opened with the model it closes). Between the two,
 * an edit can never rewrite text nobody touched.
 *
 * The DOM side reads a structural interface ({@link DomLike}) rather than the
 * browser's types, so Node tests can drive the real serialiser with fake
 * nodes — that is the code path a save goes through.
 *
 * @module shared/ui/canvas/rich-md
 */

import { splitBlocks } from './blocks';

// ── Model ────────────────────────────────────────────────────────────

export type Inline =
  | { t: 'text'; v: string }
  | { t: 'strong' | 'em' | 'del'; mark: string; c: Inline[] }
  | { t: 'code'; v: string; ticks: number }
  | { t: 'link'; href: string; title?: string; c: Inline[] }
  | { t: 'br'; kind: 'soft' | 'spaces' | 'backslash' };

export interface ListItem {
  /** undefined: not a task; else checked or not. */
  task?: boolean;
  c: Inline[];
  sub?: ListBlock;
}

export interface ListBlock {
  t: 'list';
  ordered: boolean;
  /** Bullet character, or the ordered delimiter. */
  marker: string;
  start: number;
  loose: boolean;
  /** Indentation of this list relative to its parent item's line (nested lists only). */
  indent: string;
  items: ListItem[];
}

export type RichBlock =
  | { t: 'p'; c: Inline[] }
  | { t: 'h'; level: number; c: Inline[] }
  | ListBlock
  | { t: 'quote'; paras: Inline[][] };

// ── Markdown → model ─────────────────────────────────────────────────

const PUNCT = /[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/;
const isSpace = (c: string | undefined): boolean => c === undefined || /\s/.test(c);
const isAlnum = (c: string | undefined): boolean => c !== undefined && /[\p{L}\p{N}]/u.test(c);

/** Find the closing code-tick run of exactly `n` ticks at or after `from`. */
function closeTicks(s: string, from: number, n: number): number {
  for (let i = from; i < s.length; i++) {
    if (s[i] !== '`') continue;
    let j = i;
    while (s[j] === '`') j++;
    if (j - i === n) return i;
    i = j - 1;
  }
  return -1;
}

/** Index of the `]` matching the `[` at `open`, skipping code spans and escapes. */
function closeBracket(s: string, open: number): number {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    const c = s[i];
    if (c === '\\') { i++; continue; }
    if (c === '`') {
      let j = i; while (s[j] === '`') j++;
      const e = closeTicks(s, j, j - i);
      if (e >= 0) { i = e + (j - i) - 1; continue; }
      i = j - 1; continue;
    }
    if (c === '[') depth++;
    else if (c === ']') { depth--; if (depth === 0) return i; }
  }
  return -1;
}

/** Find a closing emphasis delimiter for `mark` opened before `from`. */
function closeDelim(s: string, from: number, mark: string): number {
  for (let i = from; i < s.length; i++) {
    const c = s[i];
    if (c === '\\') { i++; continue; }
    if (c === '`') {
      let j = i; while (s[j] === '`') j++;
      const e = closeTicks(s, j, j - i);
      if (e >= 0) { i = e + (j - i) - 1; continue; }
      i = j - 1; continue;
    }
    if (c === '[') {
      const e = closeBracket(s, i);
      if (e > 0 && s[e + 1] === '(') {
        const p = s.indexOf(')', e);
        if (p > 0) { i = p; continue; }
      }
    }
    if (!s.startsWith(mark, i)) continue;
    const ch = mark[0]!;
    let j = i;
    while (s[j] === ch) j++;
    // Exactly this run length: a `*` must not close on half of a `**`, nor `**` on a `***`.
    if (j - i !== mark.length) { i = j - 1; continue; }
    if (i === from || isSpace(s[i - 1])) continue;
    if (ch === '_' && isAlnum(s[i + mark.length])) continue;
    return i;
  }
  return -1;
}

/** Parse inline Markdown into the model. Anything it cannot represent fails the round trip instead. */
export function parseInline(s: string): Inline[] {
  const out: Inline[] = [];
  let buf = '';
  const flush = (): void => { if (buf) { out.push({ t: 'text', v: buf }); buf = ''; } };
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (c === '\\' && s[i + 1] === '\n') { flush(); out.push({ t: 'br', kind: 'backslash' }); i++; continue; }
    if (c === '\\' && s[i + 1] !== undefined && PUNCT.test(s[i + 1]!)) { buf += s[i + 1]; i++; continue; }
    if (c === '\n') {
      const hard = / {2,}$/.test(buf);
      buf = buf.replace(/ +$/, '');
      flush();
      out.push({ t: 'br', kind: hard ? 'spaces' : 'soft' });
      continue;
    }
    if (c === '`') {
      let j = i; while (s[j] === '`') j++;
      const n = j - i;
      const e = closeTicks(s, j, n);
      if (e >= 0) { flush(); out.push({ t: 'code', v: s.slice(j, e), ticks: n }); i = e + n - 1; continue; }
      buf += s.slice(i, j); i = j - 1; continue;
    }
    if (c === '[') {
      const e = closeBracket(s, i);
      if (e > 0 && s[e + 1] === '(') {
        const close = s.indexOf(')', e + 2);
        if (close > 0) {
          const inside = s.slice(e + 2, close);
          const m = /^(\S*?)(?: "([^"]*)")?$/.exec(inside);
          if (m && m[1]) {
            flush();
            out.push({ t: 'link', href: m[1], ...(m[2] !== undefined ? { title: m[2] } : {}), c: parseInline(s.slice(i + 1, e)) });
            i = close;
            continue;
          }
        }
      }
      buf += c; continue;
    }
    if (c === '*' || c === '_' || c === '~') {
      const two = s[i + 1] === c;
      const mark = c === '~' ? (two ? '~~' : '') : two ? c + c : c;
      if (mark && !isSpace(s[i + mark.length]) && !(c === '_' && isAlnum(s[i - 1]))) {
        const e = closeDelim(s, i + mark.length, mark);
        if (e > 0) {
          flush();
          const t = c === '~' ? 'del' : mark.length === 2 ? 'strong' : 'em';
          out.push({ t, mark, c: parseInline(s.slice(i + mark.length, e)) });
          i = e + mark.length - 1;
          continue;
        }
      }
      buf += c; continue;
    }
    buf += c;
  }
  flush();
  return out;
}

const ITEM = /^(\s*)([-*+]|\d{1,9}[.)]) (\[[ xX]\] )?(\S.*|)$/;

interface RawItem { indent: number; marker: string; task?: boolean; text: string; blankBefore: boolean }

function parseList(lines: string[]): ListBlock | null {
  const raw: RawItem[] = [];
  let blank = false;
  for (const line of lines) {
    if (!line.trim()) { blank = true; continue; }
    const m = ITEM.exec(line);
    if (m) {
      raw.push({
        indent: m[1]!.length, marker: m[2]!, text: m[4]!, blankBefore: blank,
        ...(m[3] ? { task: m[3] !== '[ ] ' } : {}),
      });
      blank = false;
      continue;
    }
    // A continuation line of the previous item: indented to its content column.
    const prev = raw[raw.length - 1];
    if (!prev || blank) return null;
    const col = prev.indent + prev.marker.length + 1;
    if (!line.startsWith(' '.repeat(col)) || /^\s/.test(line.slice(col))) return null;
    prev.text += `\n${line.slice(col)}`;
  }
  if (!raw.length) return null;
  let pos = 0;
  const build = (indent: number, relIndent: string): ListBlock | null => {
    const first = raw[pos]!;
    const ordered = /\d/.test(first.marker);
    const marker = ordered ? first.marker.slice(-1) : first.marker;
    const start = ordered ? Number(first.marker.slice(0, -1)) : 1;
    const list: ListBlock = { t: 'list', ordered, marker, start, loose: false, indent: relIndent, items: [] };
    while (pos < raw.length) {
      const r = raw[pos]!;
      if (r.indent < indent) break;
      if (r.indent > indent) {
        const parent = list.items[list.items.length - 1];
        if (!parent || parent.sub) return null;
        const parentRaw = raw[pos - 1]!;
        const sub = build(r.indent, ' '.repeat(r.indent - indent));
        if (!sub) return null;
        void parentRaw;
        parent.sub = sub;
        continue;
      }
      const o = /\d/.test(r.marker);
      if (o !== ordered || (o ? r.marker.slice(-1) : r.marker) !== marker) return null;
      if (o && Number(r.marker.slice(0, -1)) !== start + list.items.length) return null;
      if (r.blankBefore && list.items.length) list.loose = true;
      list.items.push({ ...(r.task !== undefined ? { task: r.task } : {}), c: parseInline(r.text) });
      pos++;
    }
    return list;
  };
  const top = build(raw[0]!.indent, '');
  if (!top || pos !== raw.length || raw[0]!.indent !== 0) return null;
  return top;
}

/**
 * Parse one block's Markdown into rich blocks, or null when it is not a kind
 * the rich editor takes. Callers still check {@link richEditable}.
 */
export function parseRichBlock(md: string): RichBlock[] | null {
  const text = md.replace(/\r\n/g, '\n');
  if (!text.trim() || /\r/.test(text)) return null;
  // Out of the model's reach: inline HTML, maths, images, entities, footnotes, tables.
  if (/[<$]|!\[|&[#\w]+;|\[\^|\|/.test(text)) return null;
  const lines = text.split('\n');
  const h = /^(#{1,6}) (.*)$/.exec(text);
  if (h && lines.length === 1 && !/\s#+\s*$/.test(text)) return [{ t: 'h', level: h[1]!.length, c: parseInline(h[2]!) }];
  if (/^\s*([-*+]|\d{1,9}[.)]) /.test(lines[0]!)) {
    const l = parseList(lines);
    return l ? [l] : null;
  }
  if (lines.every(l => l.startsWith('>'))) {
    const inner = lines.map(l => l.replace(/^> ?/, ''));
    if (inner.some(l => /^(\s*[-*+>#]|\s*\d+[.)] |```|~~~| {4})/.test(l))) return null;
    const paras: Inline[][] = [];
    let cur: string[] = [];
    for (const l of inner) {
      if (!l.trim()) { if (cur.length) { paras.push(parseInline(cur.join('\n'))); cur = []; } continue; }
      cur.push(l);
    }
    if (cur.length) paras.push(parseInline(cur.join('\n')));
    return [{ t: 'quote', paras }];
  }
  if (/^(#|```|~~~| {4}|\t|>)/.test(text)) return null;
  if (lines.some(l => /^\s/.test(l))) return null;
  return [{ t: 'p', c: parseInline(text) }];
}

// ── Model → Markdown ─────────────────────────────────────────────────

/** Escape what would otherwise read as Markdown, and only that — so ordinary prose round-trips. */
function escapeText(v: string, atLineStart: boolean): string {
  let out = '';
  for (let i = 0; i < v.length; i++) {
    const c = v[i]!;
    const prev = v[i - 1];
    const next = v[i + 1];
    if (c === '\\' && next !== undefined && PUNCT.test(next)) out += '\\\\';
    else if (c === '`') out += '\\`';
    else if (c === '*' && !(isSpace(prev) && isSpace(next))) out += '\\*';
    else if (c === '_' && !(isAlnum(prev) && isAlnum(next)) && !(isSpace(prev) && isSpace(next))) out += '\\_';
    else if (c === '~' && (next === '~' || prev === '~')) out += '\\~';
    // Only a `[` that could open a link (a later `](`) needs escaping; a lone bracket is text.
    else if (c === '[' && v.indexOf('](', i) > i) out += '\\[';
    else out += c;
  }
  if (atLineStart) {
    // A line that would start a block: `# `, `- `, `* `, `1. `, `> `.
    out = out.replace(/^(\s*)(#{1,6} |[-+*] |>)/, '$1\\$2').replace(/^(\s*\d+)([.)] )/, '$1\\$2');
  }
  return out;
}

/** Inline model to Markdown. Whitespace at a mark's edges moves outside it, or the Markdown breaks. */
export function serializeInline(nodes: readonly Inline[], contIndent = ''): string {
  let out = '';
  for (const n of nodes) {
    switch (n.t) {
      case 'text': out += escapeText(n.v, out === '' || out.endsWith('\n' + contIndent)); break;
      case 'br':
        out += n.kind === 'spaces' ? '  \n' : n.kind === 'backslash' ? '\\\n' : '\n';
        out += contIndent;
        break;
      case 'code': {
        const ticks = '`'.repeat(Math.max(n.ticks, longestRun(n.v) + 1));
        out += `${ticks}${n.v}${ticks}`;
        break;
      }
      case 'link': {
        const label = serializeInline(n.c, contIndent);
        out += `[${label}](${n.href}${n.title !== undefined ? ` "${n.title}"` : ''})`;
        break;
      }
      default: {
        const inner = serializeInline(n.c, contIndent);
        const lead = /^\s*/.exec(inner)![0];
        const trail = /\s*$/.exec(inner.slice(lead.length))![0];
        const core = inner.slice(lead.length, inner.length - trail.length);
        out += core ? `${lead}${n.mark}${core}${n.mark}${trail}` : inner;
      }
    }
  }
  return out;
}

function longestRun(s: string): number {
  let best = 0;
  for (const m of s.match(/`+/g) ?? []) best = Math.max(best, m.length);
  return best === 0 ? 0 : best;
}

function serializeList(list: ListBlock, base: string): string {
  const parts: string[] = [];
  list.items.forEach((item, i) => {
    const marker = list.ordered ? `${list.start + i}${list.marker}` : list.marker;
    const cont = base + ' '.repeat(marker.length + 1);
    const task = item.task === undefined ? '' : item.task ? '[x] ' : '[ ] ';
    let s = `${base}${marker} ${task}${serializeInline(item.c, cont)}`;
    if (item.sub) s += `\n${serializeList(item.sub, base + (item.sub.indent || ' '.repeat(marker.length + 1)))}`;
    parts.push(s);
  });
  return parts.join(list.loose ? '\n\n' : '\n');
}

export function serializeBlock(b: RichBlock): string {
  switch (b.t) {
    case 'p': return serializeInline(b.c);
    case 'h': return `${'#'.repeat(b.level)} ${serializeInline(b.c).replace(/\n/g, ' ')}`;
    case 'list': return serializeList(b, '');
    case 'quote': return b.paras.map(p => serializeInline(p).split('\n').map(l => `> ${l}`).join('\n')).join('\n>\n');
  }
}

/** Several rich blocks as Markdown, one blank line apart. Empty paragraphs are dropped. */
export function serializeBlocks(blocks: readonly RichBlock[]): string {
  return blocks
    .filter(b => !(b.t === 'p' && !serializeInline(b.c).trim()))
    .map(serializeBlock)
    .join('\n\n');
}

/** True when a block's Markdown survives parse → serialise byte for byte. */
export function richEditable(md: string): boolean {
  return parseRichRegion(md) !== null;
}

/**
 * Parse a run of blocks (a region being edited may be several — the person
 * pressed Enter, or a pending card became a heading and a paragraph). Null
 * unless every block is rich-editable and the run round-trips exactly,
 * including the single blank line between blocks.
 */
export function parseRichRegion(md: string): RichBlock[] | null {
  const parts = splitBlocks(md);
  if (!parts.length) return null;
  const out: RichBlock[] = [];
  for (const b of parts) {
    const parsed = parseRichBlock(b.text);
    if (!parsed) return null;
    out.push(...parsed);
  }
  return serializeBlocks(out) === md ? out : null;
}

// ── Model → editable HTML ────────────────────────────────────────────

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function inlineToHtml(nodes: readonly Inline[]): string {
  return nodes.map((n) => {
    switch (n.t) {
      case 'text': return esc(n.v);
      case 'br': return `<br data-md="${n.kind}">`;
      case 'code': return `<code data-ticks="${n.ticks}">${esc(n.v)}</code>`;
      case 'link': return `<a href="${esc(n.href)}"${n.title !== undefined ? ` data-title="${esc(n.title)}"` : ''}>${inlineToHtml(n.c)}</a>`;
      case 'strong': return `<strong data-md="${esc(n.mark)}">${inlineToHtml(n.c)}</strong>`;
      case 'em': return `<em data-md="${esc(n.mark)}">${inlineToHtml(n.c)}</em>`;
      case 'del': return `<del data-md="${esc(n.mark)}">${inlineToHtml(n.c)}</del>`;
    }
  }).join('');
}

function listToHtml(l: ListBlock): string {
  const tag = l.ordered ? 'ol' : 'ul';
  const tasks = l.items.some(i => i.task !== undefined);
  const attrs = ` data-marker="${esc(l.marker)}"${l.loose ? ' data-loose="1"' : ''}${l.indent ? ` data-indent="${l.indent.length}"` : ''}`
    + `${l.ordered && l.start !== 1 ? ` start="${l.start}"` : ''}${tasks ? ' data-tasks="1"' : ''}`;
  const items = l.items.map((it) => {
    const box = it.task === undefined ? '' : `<input type="checkbox" contenteditable="false"${it.task ? ' checked' : ''}>`;
    return `<li${it.task !== undefined ? ' data-task="1"' : ''}>${box}${inlineToHtml(it.c) || '<br>'}${it.sub ? listToHtml(it.sub) : ''}</li>`;
  }).join('');
  return `<${tag}${attrs}>${items}</${tag}>`;
}

/** The HTML the rich editor opens with. Marks remember their Markdown spelling in `data-md`. */
export function blocksToHtml(blocks: readonly RichBlock[]): string {
  return blocks.map((b) => {
    switch (b.t) {
      case 'p': return `<p>${inlineToHtml(b.c) || '<br>'}</p>`;
      case 'h': return `<h${b.level}>${inlineToHtml(b.c) || '<br>'}</h${b.level}>`;
      case 'list': return listToHtml(b);
      case 'quote': return `<blockquote>${b.paras.map(p => `<p>${inlineToHtml(p) || '<br>'}</p>`).join('')}</blockquote>`;
    }
  }).join('');
}

// ── Editable DOM → model ─────────────────────────────────────────────

/** The part of a DOM node the serialiser reads — real nodes satisfy it, and so do test fakes. */
export interface DomLike {
  nodeType: number;
  nodeName: string;
  nodeValue?: string | null;
  childNodes: ArrayLike<DomLike>;
  getAttribute?(name: string): string | null;
  /** Live checkbox state; falls back to the `checked` attribute. */
  checked?: boolean;
}

const TEXT = 3;
const ELEMENT = 1;
const kids = (n: DomLike): DomLike[] => Array.from(n.childNodes);
const tag = (n: DomLike): string => n.nodeName.toLowerCase();
const attr = (n: DomLike, a: string): string | null => n.getAttribute?.(a) ?? null;

const BLOCK_TAGS = new Set(['p', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'blockquote', 'pre', 'li']);

function domInline(nodes: DomLike[]): Inline[] {
  const out: Inline[] = [];
  const push = (n: Inline): void => {
    const last = out[out.length - 1];
    if (n.t === 'text' && last?.t === 'text') last.v += n.v;
    else out.push(n);
  };
  for (const n of nodes) {
    if (n.nodeType === TEXT) {
      const v = (n.nodeValue ?? '').replace(/ /g, ' ').replace(/​/g, '').replace(/\r?\n/g, ' ');
      if (v) push({ t: 'text', v });
      continue;
    }
    if (n.nodeType !== ELEMENT) continue;
    const t = tag(n);
    if (t === 'input') continue;
    if (t === 'br') {
      const k = attr(n, 'data-md');
      push({ t: 'br', kind: k === 'soft' || k === 'backslash' ? k : 'spaces' });
      continue;
    }
    const c = domInline(kids(n));
    if (t === 'strong' || t === 'b') push({ t: 'strong', mark: attr(n, 'data-md') || '**', c });
    else if (t === 'em' || t === 'i') push({ t: 'em', mark: attr(n, 'data-md') || '*', c });
    else if (t === 'del' || t === 's' || t === 'strike') push({ t: 'del', mark: '~~', c });
    else if (t === 'code') push({ t: 'code', v: textOf(n), ticks: Number(attr(n, 'data-ticks')) || 1 });
    else if (t === 'a') {
      const title = attr(n, 'data-title');
      push({ t: 'link', href: attr(n, 'href') || '', ...(title !== null ? { title } : {}), c });
    } else for (const x of c) push(x);
  }
  // A trailing <br> is the browser's placeholder in an empty or just-split block, not a break.
  while (out.length && out[out.length - 1]!.t === 'br') out.pop();
  return out;
}

function textOf(n: DomLike): string {
  if (n.nodeType === TEXT) return (n.nodeValue ?? '').replace(/ /g, ' ');
  return kids(n).map(textOf).join('');
}

function domList(n: DomLike, relIndent: string): ListBlock {
  const ordered = tag(n) === 'ol';
  const marker = attr(n, 'data-marker') || (ordered ? '.' : '-');
  const indentAttr = attr(n, 'data-indent');
  const list: ListBlock = {
    t: 'list', ordered, marker, start: Number(attr(n, 'start')) || 1,
    loose: attr(n, 'data-loose') === '1', indent: indentAttr ? ' '.repeat(Number(indentAttr)) : relIndent, items: [],
  };
  const tasks = attr(n, 'data-tasks') === '1';
  for (const li of kids(n)) {
    if (li.nodeType !== ELEMENT) continue;
    if (tag(li) !== 'li') {
      // A stray nested list the browser put directly in the list (indent in some engines).
      if ((tag(li) === 'ul' || tag(li) === 'ol') && list.items.length) {
        const prev = list.items[list.items.length - 1]!;
        if (!prev.sub) prev.sub = domList(li, '');
      }
      continue;
    }
    const children = kids(li);
    const box = children.find(c => c.nodeType === ELEMENT && tag(c) === 'input');
    const subNode = children.find(c => c.nodeType === ELEMENT && (tag(c) === 'ul' || tag(c) === 'ol'));
    const inline = children.filter(c => c !== box && c !== subNode && !(c.nodeType === ELEMENT && (tag(c) === 'ul' || tag(c) === 'ol')));
    // A <p> the browser wrapped the item's text in reads as its text.
    const flat = inline.flatMap(c => (c.nodeType === ELEMENT && (tag(c) === 'p' || tag(c) === 'div') ? kids(c) : [c]));
    const isTask = Boolean(box) || attr(li, 'data-task') === '1' || tasks;
    const checked = box ? (box.checked ?? attr(box, 'checked') !== null) : false;
    const item: ListItem = { ...(isTask ? { task: checked } : {}), c: domInline(flat) };
    if (subNode) item.sub = domList(subNode, '');
    list.items.push(item);
  }
  return list;
}

/** Read the rich editor's DOM back into blocks. Loose inline content at the top becomes a paragraph. */
export function domToBlocks(root: DomLike): RichBlock[] {
  const out: RichBlock[] = [];
  let loose: DomLike[] = [];
  const flushLoose = (): void => {
    if (loose.length) { const c = domInline(loose); if (c.length) out.push({ t: 'p', c }); loose = []; }
  };
  for (const n of kids(root)) {
    if (n.nodeType === ELEMENT && BLOCK_TAGS.has(tag(n))) {
      flushLoose();
      const t = tag(n);
      if (/^h[1-6]$/.test(t)) out.push({ t: 'h', level: Number(t[1]), c: domInline(kids(n)) });
      else if (t === 'ul' || t === 'ol') out.push(domList(n, ''));
      else if (t === 'blockquote') {
        const paras: Inline[][] = [];
        let run: DomLike[] = [];
        for (const k of kids(n)) {
          if (k.nodeType === ELEMENT && BLOCK_TAGS.has(tag(k))) {
            if (run.length) { paras.push(domInline(run)); run = []; }
            paras.push(domInline(kids(k)));
          } else run.push(k);
        }
        if (run.length) paras.push(domInline(run));
        const kept = paras.filter(p => p.length);
        if (kept.length) out.push({ t: 'quote', paras: kept });
      } else if (t === 'li') out.push({ t: 'p', c: domInline(kids(n)) });
      else out.push({ t: 'p', c: domInline(kids(n)) });
    } else {
      loose.push(n);
    }
  }
  flushLoose();
  return out.filter(b => !(b.t === 'p' && b.c.length === 0) && !(b.t === 'h' && b.c.length === 0));
}

/** Compare two models by what they would save as. */
export function sameMarkdown(a: readonly RichBlock[], b: readonly RichBlock[]): boolean {
  return serializeBlocks(a) === serializeBlocks(b);
}
