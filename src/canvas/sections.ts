/**
 * Sections of a canvas document: pending placeholders and heading sections.
 *
 * ## Why a document has addressable sections
 *
 * A long document written in one `update` is minutes of silence followed by a
 * wall of text, and a single mistake means resending all of it. AICO Docs
 * writes the other way round: `outline` lays down one placeholder per section
 * — `<!-- aico:pending id="s2" intent="…" -->`, a Markdown comment, so any
 * plain viewer ignores it — and `write_section` replaces exactly one section
 * at a time. The person watches the document fill in, and each write is small
 * enough to be version-checked and retried on its own.
 *
 * ## What a section is
 *
 * Either a pending block (one line, its own paragraph), or a heading plus
 * everything after it until the next heading of the same or higher level —
 * or the next pending block, so a written section never swallows the
 * placeholders that follow it. Headings inside fenced code are not headings:
 * a `# comment` in a shell block is the classic way a naive splitter cuts a
 * document in half.
 *
 * ## What it deliberately does not do
 *
 * No Setext (`Title\n=====`) headings: the agent writes ATX, and treating an
 * underline as a heading boundary would make a table's `---` row ambiguous.
 * No fuzzy heading match: a heading that matches twice is an error listing
 * both, because guessing which "Overview" was meant is how the wrong section
 * gets replaced.
 *
 * @module canvas/sections
 */

export interface PendingBlock {
  id: string;
  intent: string;
  heading?: string;
}

export interface Section {
  /** `pending` — a placeholder; `heading` — a written heading section. */
  type: 'pending' | 'heading';
  /** Pending id, when a placeholder. */
  id?: string;
  intent?: string;
  /** Heading text (placeholders: the planned heading, if any). */
  heading?: string;
  /** Heading level 1–6 (placeholders: undefined). */
  level?: number;
  /** First line of the section (0-based). */
  startLine: number;
  /** One past the last content line (trailing blank lines excluded). */
  endLine: number;
}

const PENDING_LINE = /^\s{0,3}<!--\s*aico:pending\b([\s\S]*?)-->\s*$/;
const ATTR = /([a-z][a-z0-9_-]*)\s*=\s*"([^"]*)"/gi;
const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;
export const SECTION_ID = /^[A-Za-z0-9_-]{1,40}$/;

function decode(value: string): string {
  return value
    .replace(/&#45;/g, '-')
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function encode(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\r?\n/g, ' ')
    // `--` may not appear inside an HTML comment; `-->` would end it early.
    .replace(/--/g, '-&#45;');
}

/** The pending line for a placeholder. */
export function pendingLine(block: PendingBlock): string {
  const heading = block.heading?.trim() ? ` heading="${encode(block.heading.trim())}"` : '';
  return `<!-- aico:pending id="${encode(block.id)}" intent="${encode(block.intent.trim())}"${heading} -->`;
}

/** Read one line as a pending block, or nothing. */
export function parsePendingLine(line: string): PendingBlock | undefined {
  const m = PENDING_LINE.exec(line);
  if (!m) return undefined;
  const attrs: Record<string, string> = {};
  for (const a of m[1]!.matchAll(ATTR)) attrs[a[1]!.toLowerCase()] = decode(a[2]!);
  if (!attrs.id) return undefined;
  return { id: attrs.id, intent: attrs.intent ?? '', ...(attrs.heading ? { heading: attrs.heading } : {}) };
}

/** Heading text with inline markup flattened, closing #s dropped. */
function headingText(raw: string | undefined): string {
  return (raw ?? '').replace(/[ \t]+#+[ \t]*$/, '').replace(/^#+$/, '').trim();
}

interface LineInfo {
  kind: 'text' | 'heading' | 'pending' | 'fenced';
  level?: number;
  heading?: string;
  pending?: PendingBlock;
}

/** Classify every line, honouring fenced code. */
function classify(lines: string[]): LineInfo[] {
  const out: LineInfo[] = [];
  let fence: { char: string; len: number } | undefined;
  for (const line of lines) {
    if (fence) {
      const m = FENCE.exec(line);
      if (m && m[1]![0] === fence.char && m[1]!.length >= fence.len && line.trim() === m[1]) fence = undefined;
      out.push({ kind: 'fenced' });
      continue;
    }
    const f = FENCE.exec(line);
    if (f) {
      fence = { char: f[1]![0]!, len: f[1]!.length };
      out.push({ kind: 'fenced' });
      continue;
    }
    const pending = parsePendingLine(line);
    if (pending) { out.push({ kind: 'pending', pending }); continue; }
    const h = HEADING.exec(line);
    if (h) { out.push({ kind: 'heading', level: h[1]!.length, heading: headingText(h[2]) }); continue; }
    out.push({ kind: 'text' });
  }
  return out;
}

function trimEnd(lines: string[], start: number, end: number): number {
  let e = end;
  while (e > start + 1 && lines[e - 1]!.trim() === '') e--;
  return e;
}

/** Every section of a document, in order. */
export function listSections(content: string): Section[] {
  const lines = content.split('\n');
  const info = classify(lines);
  const sections: Section[] = [];
  for (let i = 0; i < lines.length; i++) {
    const li = info[i]!;
    if (li.kind === 'pending') {
      sections.push({
        type: 'pending', id: li.pending!.id, intent: li.pending!.intent,
        ...(li.pending!.heading ? { heading: li.pending!.heading } : {}),
        startLine: i, endLine: i + 1,
      });
    } else if (li.kind === 'heading') {
      let end = lines.length;
      for (let j = i + 1; j < lines.length; j++) {
        const lj = info[j]!;
        if (lj.kind === 'pending' || (lj.kind === 'heading' && lj.level! <= li.level!)) { end = j; break; }
      }
      sections.push({ type: 'heading', heading: li.heading!, level: li.level!, startLine: i, endLine: trimEnd(lines, i, end) });
    }
  }
  return sections;
}

/** The placeholders still waiting to be written. */
export function pendingBlocks(content: string): PendingBlock[] {
  return listSections(content)
    .filter(s => s.type === 'pending')
    .map(s => ({ id: s.id!, intent: s.intent ?? '', ...(s.heading ? { heading: s.heading } : {}) }));
}

function describeSection(s: Section): string {
  return s.type === 'pending'
    ? `pending "${s.id}"${s.heading ? ` (${s.heading})` : ''}`
    : `${'#'.repeat(s.level!)} ${s.heading} (line ${s.startLine + 1})`;
}

/** A short list of what can be addressed, for error messages. */
export function sectionMenu(content: string): string {
  const all = listSections(content);
  if (all.length === 0) return 'This tab has no headings or pending sections.';
  return `Sections here: ${all.map(describeSection).join('; ')}.`;
}

export type FindResult =
  | { ok: true; section: Section }
  | { ok: false; error: string };

/**
 * Find a section by pending id, or by exact heading text (`## Goals` and
 * `Goals` both address the heading "Goals"). `aliases` maps an id that has
 * already been written to the heading it became.
 */
export function findSection(content: string, address: string, aliases: Record<string, string> = {}): FindResult {
  const wanted = String(address ?? '').trim();
  if (!wanted) return { ok: false, error: '`section` is required — a pending id (e.g. "s2") or the exact heading text.' };
  const all = listSections(content);
  const byId = all.filter(s => s.type === 'pending' && s.id === wanted);
  if (byId.length === 1) return { ok: true, section: byId[0]! };
  if (byId.length > 1) {
    return { ok: false, error: `pending id "${wanted}" occurs ${byId.length} times — the document has duplicate placeholders; address one by rewriting the tab with update.` };
  }
  const text = headingText(wanted.replace(/^#{1,6}\s+/, ''));
  const candidates = [text];
  if (aliases[wanted] && aliases[wanted] !== text) candidates.push(aliases[wanted]!);
  for (const name of candidates) {
    const hits = all.filter(s => s.type === 'heading' && s.heading === name);
    if (hits.length === 1) return { ok: true, section: hits[0]! };
    if (hits.length > 1) {
      return {
        ok: false,
        error: `the heading "${name}" occurs ${hits.length} times: ${hits.map(describeSection).join('; ')}. `
          + 'Rename one of them (write the section with a distinct heading, or use edit) so each can be addressed.',
      };
    }
  }
  return { ok: false, error: `no section "${wanted}". ${sectionMenu(content)}` };
}

function firstNonBlank(lines: string[]): string | undefined {
  return lines.find(l => l.trim() !== '');
}

/**
 * Replace one section with new Markdown. Pure — the caller version-checks.
 *
 * The new text is trimmed of surrounding blank lines and separated from its
 * neighbours by exactly one blank line, so repeated writes never grow or eat
 * paragraph breaks.
 */
export function replaceSection(content: string, section: Section, replacement: string):
  { content: string; heading?: string } {
  const lines = content.split('\n');
  let body = String(replacement ?? '').replace(/\r\n?/g, '\n').split('\n');
  while (body.length && body[0]!.trim() === '') body.shift();
  while (body.length && body[body.length - 1]!.trim() === '') body.pop();

  const first = firstNonBlank(body);
  const startsWithHeading = first !== undefined && HEADING.test(first) && !FENCE.test(first);
  if (!startsWithHeading) {
    if (section.type === 'pending' && section.heading) body = [`## ${section.heading}`, '', ...body];
    else if (section.type === 'heading') body = [lines[section.startLine]!, '', ...body];
  }
  const newHeading = (() => {
    const h = HEADING.exec(firstNonBlank(body) ?? '');
    return h ? headingText(h[2]) : undefined;
  })();

  const before = lines.slice(0, section.startLine);
  const after = lines.slice(section.endLine);
  while (before.length && before[before.length - 1]!.trim() === '') before.pop();
  while (after.length && after[0]!.trim() === '') after.shift();
  const parts: string[] = [];
  if (before.length) parts.push(before.join('\n'));
  if (body.length) parts.push(body.join('\n'));
  if (after.length) parts.push(after.join('\n'));
  const trailing = content.endsWith('\n') ? '\n' : '';
  return { content: parts.join('\n\n') + trailing, ...(newHeading ? { heading: newHeading } : {}) };
}

/** Which section a character offset falls in (for activity labels), if any. */
export function sectionAt(content: string, offset: number): Section | undefined {
  const lineNo = content.slice(0, Math.max(0, offset)).split('\n').length - 1;
  let found: Section | undefined;
  for (const s of listSections(content)) {
    if (s.startLine <= lineNo && lineNo < Math.max(s.endLine, s.startLine + 1)) found = s;
  }
  return found;
}

/** Markdown with the pending placeholders removed — what an export shows. */
export function stripPending(content: string): string {
  const lines = content.split('\n');
  const info = classify(lines);
  const kept = lines.filter((_, i) => info[i]!.kind !== 'pending');
  return kept.join('\n').replace(/\n{3,}/g, '\n\n').replace(/^\n+/, '');
}
