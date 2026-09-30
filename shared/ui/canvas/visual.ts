/**
 * AICO Docs' visual blocks as Markdown: images with size/alignment/caption,
 * callouts, tables, charts, infographics (stats, timeline, steps,
 * comparison) and the table of contents — each a parser and a serialiser,
 * DOM-free so Node tests (and the engine's exporters) can use them.
 *
 * ## Why these spellings
 *
 * The document stays plain Markdown that any viewer can show (see
 * `CanvasEditor`'s header). So every visual block is written in a form that
 * degrades to something readable where AICO is not rendering it:
 *
 * - an image's caption is its own Markdown title, and size/alignment are a
 *   Pandoc-style attribute block after it (`{width=60% align=center}`);
 * - callouts are ```callout info|warn|success fences with a Markdown body;
 * - infographics (stats, timeline, steps, comparison) are fenced JSON, the
 *   shape the engine's exporters read;
 * - charts keep the chat's ```chart ECharts fence, restricted to a shape the
 *   chart editor can read back (anything else is edited as source);
 * - the table of contents is an HTML comment, invisible elsewhere.
 *
 * The syntax is the engine's (round 2 of `docs/engineering/canvas-docs-contract.md`),
 * because the engine renders every export. The reader is lenient: it also
 * takes GitHub alerts (`> [!NOTE]`), line-based infographic bodies
 * (`Label | Value | Note`) and the `#aico:` image fragment an earlier draft
 * of the contract proposed, so a model writing either form is drawn.
 *
 * A visual editor only ever rewrites its own block, and only when the person
 * changed something in it; parse → serialise need not be byte-exact here
 * (unlike `rich-md`), because an untouched block is never re-serialised.
 *
 * @module shared/ui/canvas/visual
 */

import { headingText, type Block } from './blocks';

// ── Images ───────────────────────────────────────────────────────────

export type ImageAlign = 'left' | 'center' | 'right' | 'full';

export interface ImageModel {
  alt: string;
  src: string;
  /** Percent of the text column, 10–100. */
  width?: number;
  /** A width given in pixels (kept as written; the resize handle writes percent). */
  widthPx?: number;
  align?: ImageAlign;
  caption?: string;
}

const IMAGE_LINE = /^!\[([^\]\n]*)\]\((\S+?)(?:\s+"((?:[^"\\]|\\.)*)")?\)(\{[^}\n]*\})?\s*$/;

/** An image that is a paragraph of its own, or null. */
export function parseImageLine(text: string): ImageModel | null {
  const m = IMAGE_LINE.exec(text.trim());
  if (!m) return null;
  let src = m[2]!;
  const out: ImageModel = { alt: m[1]!, src };
  const setWidth = (v: string): void => {
    const pct = /^(\d{1,3}(?:\.\d+)?)%$/.exec(v);
    const px = /^(\d{1,5})(?:px)?$/.exec(v);
    if (pct) out.width = Math.max(10, Math.min(100, Math.round(Number(pct[1]))));
    else if (px) out.widthPx = Number(px[1]);
  };
  const setAlign = (v: string): void => { if (v === 'left' || v === 'center' || v === 'right' || v === 'full') out.align = v; };
  // The engine's form: a Pandoc attribute block after the image.
  if (m[4]) {
    for (const a of m[4].slice(1, -1).matchAll(/([\w-]+)=("[^"]*"|\S+)/g)) {
      const v = a[2]!.replace(/^"|"$/g, '');
      if (a[1] === 'width') setWidth(v);
      if (a[1] === 'align') setAlign(v);
    }
  }
  // An earlier draft's form: options in a URL fragment.
  const at = src.lastIndexOf('#aico:');
  if (at >= 0) {
    for (const pair of src.slice(at + 6).split(',')) {
      const [k, v] = pair.split('=');
      if (k === 'w' && v) setWidth(`${v}%`);
      if (k === 'align' && v) setAlign(v);
    }
    src = src.slice(0, at);
    out.src = src;
  }
  if (m[3] !== undefined) out.caption = m[3].replace(/\\"/g, '"');
  return out;
}

/** The engine's spelling: `![alt](src "Caption"){width=60% align=center}` — attributes only when not the default. */
export function imageLine(img: ImageModel): string {
  const attrs: string[] = [];
  if (img.align === 'full') attrs.push('width=100%');
  else if (img.width !== undefined && img.width !== 100) attrs.push(`width=${Math.round(Math.max(10, Math.min(100, img.width)))}%`);
  else if (img.width === undefined && img.widthPx) attrs.push(`width=${img.widthPx}px`);
  if (img.align && img.align !== 'center' && img.align !== 'full') attrs.push(`align=${img.align}`);
  else if (img.align === 'center' && attrs.length) attrs.push('align=center');
  const alt = img.alt.replace(/[[\]\n]/g, ' ').trim();
  const cap = img.caption?.trim() ? ` "${img.caption.trim().replace(/"/g, '\\"').replace(/\n/g, ' ')}"` : '';
  return `![${alt}](${img.src}${cap})${attrs.length ? `{${attrs.join(' ')}}` : ''}`;
}

// ── Callouts ─────────────────────────────────────────────────────────

export type CalloutType = 'info' | 'warn' | 'success';
export const CALLOUTS: ReadonlyArray<{ type: CalloutType; label: string }> = [
  { type: 'info', label: 'Info' }, { type: 'success', label: 'Success' }, { type: 'warn', label: 'Warning' },
];

export interface CalloutModel { type: CalloutType; title?: string; body: string }

const ALERT_TYPE: Record<string, CalloutType> = { NOTE: 'info', IMPORTANT: 'info', TIP: 'success', WARNING: 'warn', CAUTION: 'warn' };

/** A ```callout fence (the engine's form) or a GitHub alert quote (read only). */
export function parseCallout(text: string): CalloutModel | null {
  const f = parseFence(text);
  if (f && f.lang === 'callout') {
    const info = /^\S*\s+(\w+)/.exec(f.info)?.[1]?.toLowerCase();
    const type: CalloutType = info === 'warn' || info === 'warning' || info === 'danger' ? 'warn' : info === 'success' || info === 'tip' ? 'success' : 'info';
    const body = f.body.trim();
    if (body.startsWith('{')) {
      try {
        const o = JSON.parse(body) as { type?: string; title?: string; text?: string };
        const t = o.type === 'warn' || o.type === 'success' ? o.type : type;
        return { type: t, ...(o.title ? { title: o.title } : {}), body: o.text ?? '' };
      } catch { /* Markdown after all */ }
    }
    const title = /^\*\*(.+?)\*\*\s*$/m.exec(body.split('\n')[0] ?? '');
    return title ? { type, title: title[1]!, body: body.split('\n').slice(1).join('\n').trim() } : { type, body };
  }
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const m = /^>\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*$/i.exec(lines[0] ?? '');
  if (!m || !lines.every(l => l.startsWith('>'))) return null;
  return { type: ALERT_TYPE[m[1]!.toUpperCase()]!, body: lines.slice(1).map(l => l.replace(/^> ?/, '')).join('\n').trim() };
}

export function calloutMarkdown(c: CalloutModel): string {
  const title = c.title?.trim() ? `**${c.title.trim()}**\n` : '';
  return fenced(`callout ${c.type}`, `${title}${c.body.trim()}`);
}

// ── Tables ───────────────────────────────────────────────────────────

export type ColAlign = 'none' | 'left' | 'center' | 'right';
export interface TableModel { align: ColAlign[]; header: string[]; rows: string[][] }

function cells(line: string): string[] {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  const out: string[] = [];
  let cur = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && s[i + 1] === '|') { cur += '|'; i++; continue; }
    if (s[i] === '|') { out.push(cur.trim()); cur = ''; continue; }
    cur += s[i];
  }
  out.push(cur.trim());
  return out;
}

export function parseTable(text: string): TableModel | null {
  const lines = text.replace(/\r\n/g, '\n').split('\n').filter(l => l.trim());
  if (lines.length < 2) return null;
  const header = cells(lines[0]!);
  const delim = cells(lines[1]!);
  if (!delim.every(d => /^:?-+:?$/.test(d))) return null;
  const n = header.length;
  const align = Array.from({ length: n }, (_, i): ColAlign => {
    const d = delim[i] ?? '---';
    return d.startsWith(':') && d.endsWith(':') ? 'center' : d.endsWith(':') ? 'right' : d.startsWith(':') ? 'left' : 'none';
  });
  const rows = lines.slice(2).map((l) => {
    const c = cells(l);
    return Array.from({ length: n }, (_, i) => c[i] ?? '');
  });
  return { align, header, rows };
}

const escCell = (s: string): string => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');

/** A GFM table, columns padded so the source reads as a table too. */
export function tableToMarkdown(t: TableModel): string {
  const n = Math.max(1, t.header.length);
  const all = [t.header, ...t.rows].map(r => Array.from({ length: n }, (_, i) => escCell(r[i] ?? '')));
  const width = Array.from({ length: n }, (_, i) => Math.max(3, ...all.map(r => r[i]!.length)));
  const line = (r: string[]): string => `| ${r.map((c, i) => c.padEnd(width[i]!)).join(' | ')} |`;
  const delim = `| ${width.map((w, i) => {
    const a = t.align[i] ?? 'none';
    // GFM needs one dash; the rest pad the delimiter to the column so the source lines up.
    const dashes = '-'.repeat(Math.max(1, w - (a === 'center' ? 2 : a === 'none' ? 0 : 1)));
    return a === 'center' ? `:${dashes}:` : a === 'left' ? `:${dashes}` : a === 'right' ? `${dashes}:` : dashes;
  }).join(' | ')} |`;
  return [line(all[0]!), delim, ...all.slice(1).map(line)].join('\n');
}

/** Cells pasted from a spreadsheet (tab-separated rows), or null when it is not a grid. */
export function parseTsv(text: string): string[][] | null {
  const rows = text.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n');
  if (!rows.some(r => r.includes('\t'))) return null;
  return rows.map(r => r.split('\t').map(c => c.trim()));
}

// ── Infographics ─────────────────────────────────────────────────────

export type InfographicKind = 'stats' | 'timeline' | 'steps' | 'comparison';
/** Fence words the engine also accepts for an infographic. */
export const INFOGRAPHIC_ALIASES: Record<string, InfographicKind> = { process: 'steps' };
export const INFOGRAPHICS: readonly InfographicKind[] = ['stats', 'timeline', 'steps', 'comparison'];

/** The fence's info word (and whole info string) and body, or null for anything that is not one fenced block. */
export function parseFence(text: string): { lang: string; info: string; body: string; fence: string } | null {
  const m = /^( {0,3})(`{3,}|~{3,})([^\n`]*)\n([\s\S]*?)\n?\1?\2\s*$/.exec(text.replace(/\r\n/g, '\n'));
  if (!m) return null;
  return { lang: m[3]!.trim().split(/\s+/)[0]!.toLowerCase(), info: m[3]!.trim(), body: m[4]!, fence: m[2]! };
}

export function fenced(lang: string, body: string): string {
  const longest = Math.max(2, ...(body.match(/`{3,}/g) ?? []).map(s => s.length));
  const f = '`'.repeat(longest + 1);
  return `${f}${lang}\n${body.replace(/\n+$/, '')}\n${f}`;
}

/** Rows of `a | b | c`, each padded to `cols` fields (the line-based form, read for leniency). */
export function parseRows(body: string, cols: number): string[][] {
  return body.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'))
    .map((l) => {
      const c = l.split(/\s*\|\s*/);
      return Array.from({ length: cols }, (_, i) => (i === cols - 1 ? c.slice(i).join(' | ') : c[i] ?? '').trim());
    });
}

/** The JSON fields of each infographic's items, in the order the editor shows them, with their labels. */
export const INFOGRAPHIC_FIELDS: Record<Exclude<InfographicKind, 'comparison'>, Array<{ key: string; label: string }>> = {
  stats: [{ key: 'label', label: 'Label' }, { key: 'value', label: 'Value' }, { key: 'delta', label: 'Change' }],
  timeline: [{ key: 'date', label: 'When' }, { key: 'title', label: 'Title' }, { key: 'text', label: 'Detail' }],
  steps: [{ key: 'title', label: 'Title' }, { key: 'text', label: 'Detail' }],
};

export type InfoItem = Record<string, string>;

function jsonBody(body: string): unknown {
  const t = body.trim();
  if (!t.startsWith('{') && !t.startsWith('[')) return undefined;
  try { return JSON.parse(t); } catch { return undefined; }
}

/** An infographic's items: from the engine's JSON (`{"items":[…]}` or a bare array), or the line form. */
export function infographicItems(kind: Exclude<InfographicKind, 'comparison'>, body: string): InfoItem[] {
  const fields = INFOGRAPHIC_FIELDS[kind];
  const j = jsonBody(body);
  const arr = Array.isArray(j) ? j : j && typeof j === 'object' && Array.isArray((j as { items?: unknown }).items) ? (j as { items: unknown[] }).items : null;
  if (arr) {
    return arr.filter(x => x && typeof x === 'object').map((x) => {
      const o = x as Record<string, unknown>;
      const item: InfoItem = {};
      for (const f of fields) if (o[f.key] !== undefined && o[f.key] !== null) item[f.key] = String(o[f.key]);
      if (kind === 'stats' && typeof o.trend === 'string') item.trend = o.trend;
      return item;
    });
  }
  // Line form: stats lines are `Label | Value | Note`, the others in field order.
  return parseRows(body, fields.length).map(r => Object.fromEntries(fields.map((f, i) => [f.key, r[i] ?? ''])));
}

/** The engine's JSON body for an infographic's items. Empty fields are left out. */
export function infographicBody(kind: Exclude<InfographicKind, 'comparison'>, items: readonly InfoItem[]): string {
  const keys = [...INFOGRAPHIC_FIELDS[kind].map(f => f.key), ...(kind === 'stats' ? ['trend'] : [])];
  const clean = items
    .map(it => Object.fromEntries(keys.filter(k => it[k]?.trim()).map(k => [k, it[k]!.trim()])))
    .filter(it => Object.keys(it).length);
  return JSON.stringify({ items: clean }, null, 2);
}

/** Up, down or flat: the stored trend, else the sign of the change. */
export function trendOf(item: InfoItem): 'up' | 'down' | 'flat' {
  if (item.trend === 'up' || item.trend === 'down' || item.trend === 'flat') return item.trend;
  const d = (item.delta ?? '').trim();
  return /^\+/.test(d) ? 'up' : /^[-−–]/.test(d) ? 'down' : 'flat';
}

export interface ComparisonColumn { title: string; items: string[]; footer?: string; highlight?: boolean }

export function parseComparison(body: string): ComparisonColumn[] {
  const j = jsonBody(body);
  const cols = Array.isArray(j) ? j : j && typeof j === 'object' && Array.isArray((j as { columns?: unknown }).columns) ? (j as { columns: unknown[] }).columns : null;
  if (cols) {
    return cols.filter(c => c && typeof c === 'object').map((c) => {
      const o = c as Record<string, unknown>;
      return {
        title: String(o.title ?? ''), items: Array.isArray(o.items) ? o.items.map(String) : [],
        ...(o.footer ? { footer: String(o.footer) } : {}), ...(o.highlight === true ? { highlight: true } : {}),
      };
    });
  }
  // Line form: `## Title`, `> note`, `- item`.
  const out: ComparisonColumn[] = [];
  for (const raw of body.split('\n')) {
    const l = raw.trim();
    if (!l) continue;
    const h = /^#{1,6}\s+(.*)$/.exec(l);
    if (h) { out.push({ title: h[1]!.trim(), items: [] }); continue; }
    if (!out.length) out.push({ title: 'Option', items: [] });
    const col = out[out.length - 1]!;
    const item = /^[-*+]\s+(.*)$/.exec(l);
    if (item) col.items.push(item[1]!.trim());
    else if (l.startsWith('>')) col.footer = l.replace(/^>\s?/, '').trim();
    else col.items.push(l);
  }
  return out;
}

export function comparisonBody(cols: readonly ComparisonColumn[]): string {
  const clean = cols
    .filter(c => c.title.trim() || c.items.some(i => i.trim()))
    .map(c => ({
      title: c.title.trim() || 'Option', items: c.items.map(i => i.trim()).filter(Boolean),
      ...(c.footer?.trim() ? { footer: c.footer.trim() } : {}), ...(c.highlight ? { highlight: true } : {}),
    }));
  return JSON.stringify({ columns: clean }, null, 2);
}

export function infographicTemplate(kind: InfographicKind): string {
  switch (kind) {
    case 'stats': return fenced('stats', infographicBody('stats', [
      { label: 'Active users', value: '12,400', delta: '+18%' }, { label: 'NPS', value: '62', delta: '+7' }, { label: 'Response time', value: '1.8 days', delta: '-0.6 days', trend: 'up' },
    ]));
    case 'timeline': return fenced('timeline', infographicBody('timeline', [
      { date: 'Oct 2026', title: 'Discovery', text: 'Interview 20 customers' }, { date: 'Jan 2027', title: 'Pilot', text: 'Two teams live' }, { date: 'Mar 2027', title: 'Launch', text: 'General availability' },
    ]));
    case 'steps': return fenced('steps', infographicBody('steps', [
      { title: 'Collect', text: 'Every channel lands in one inbox' }, { title: 'Triage', text: 'Merge duplicates, tag by segment' },
      { title: 'Decide', text: 'Rank by demand and effort' }, { title: 'Close the loop', text: 'Tell customers what changed' },
    ]));
    case 'comparison': return fenced('comparison', comparisonBody([
      { title: 'Build in-house', items: ['6 months to launch', 'Needs two engineers'], footer: 'Full control' },
      { title: 'Buy a product', items: ['Live in 2 weeks', 'Per-seat pricing'], footer: 'Fastest start', highlight: true },
    ]));
  }
}

// ── Charts ───────────────────────────────────────────────────────────

export type ChartType = 'bar' | 'line' | 'area' | 'pie';
export interface ChartModel { type: ChartType; title: string; categories: string[]; series: Array<{ name: string; data: number[] }> }

/** Read a ```chart body the chart editor wrote (or one shaped like it); null for anything else. */
export function chartFromOption(json: string): ChartModel | null {
  let o: Record<string, unknown>;
  try { o = JSON.parse(json) as Record<string, unknown>; } catch { return null; }
  if (!o || typeof o !== 'object') return null;
  const title = typeof (o.title as { text?: unknown } | undefined)?.text === 'string' ? (o.title as { text: string }).text : '';
  const series = Array.isArray(o.series) ? o.series as Array<Record<string, unknown>> : [];
  if (!series.length) return null;
  if (series.length === 1 && series[0]!.type === 'pie') {
    const data = Array.isArray(series[0]!.data) ? series[0]!.data as Array<{ name?: unknown; value?: unknown }> : [];
    if (!data.every(d => d && typeof d === 'object' && typeof d.value === 'number')) return null;
    return { type: 'pie', title, categories: data.map(d => String(d.name ?? '')), series: [{ name: String(series[0]!.name ?? 'Series 1'), data: data.map(d => d.value as number) }] };
  }
  const x = o.xAxis as { data?: unknown } | undefined;
  if (!x || !Array.isArray(x.data)) return null;
  const types = new Set(series.map(s => s.type));
  if (types.size !== 1 || !(types.has('bar') || types.has('line'))) return null;
  if (!series.every(s => Array.isArray(s.data) && (s.data as unknown[]).every(v => typeof v === 'number'))) return null;
  const type: ChartType = types.has('bar') ? 'bar' : series.every(s => s.areaStyle) ? 'area' : 'line';
  return {
    type, title, categories: (x.data as unknown[]).map(String),
    series: series.map((s, i) => ({ name: String(s.name ?? `Series ${i + 1}`), data: s.data as number[] })),
  };
}

/** The ECharts option for a chart model, as the ```chart body (pretty JSON). */
export function chartOption(m: ChartModel): string {
  const n = m.categories.length;
  const nums = (d: number[]): number[] => Array.from({ length: n }, (_, i) => (Number.isFinite(d[i]) ? d[i]! : 0));
  const title = m.title.trim() ? { title: { text: m.title.trim() } } : {};
  if (m.type === 'pie') {
    const s = m.series[0] ?? { name: 'Series 1', data: [] };
    return JSON.stringify({
      ...title, tooltip: { trigger: 'item' }, legend: { bottom: 0 },
      series: [{ type: 'pie', name: s.name, radius: ['0%', '65%'], data: m.categories.map((c, i) => ({ name: c, value: nums(s.data)[i] })) }],
    }, null, 2);
  }
  return JSON.stringify({
    ...title, tooltip: { trigger: 'axis' }, ...(m.series.length > 1 ? { legend: { bottom: 0 } } : {}),
    xAxis: { type: 'category', data: m.categories }, yAxis: { type: 'value' },
    series: m.series.map(s => ({ name: s.name, type: m.type === 'bar' ? 'bar' : 'line', data: nums(s.data), ...(m.type === 'area' ? { areaStyle: {} } : {}) })),
  }, null, 2);
}

export function chartTemplate(type: ChartType): string {
  const m: ChartModel = type === 'pie'
    ? { type, title: 'Share by channel', categories: ['Email', 'Chat', 'Survey', 'Other'], series: [{ name: 'Share', data: [42, 28, 18, 12] }] }
    : { type, title: 'Feedback per quarter', categories: ['Q1', 'Q2', 'Q3', 'Q4'], series: [{ name: '2026', data: [120, 180, 150, 240] }] };
  return fenced('chart', chartOption(m));
}

// ── Diagrams ─────────────────────────────────────────────────────────

export const MERMAID_TEMPLATES: ReadonlyArray<{ id: string; label: string; body: string }> = [
  { id: 'flowchart', label: 'Flowchart', body: 'flowchart LR\n  A[Request] --> B{Approved?}\n  B -- Yes --> C[Build]\n  B -- No --> D[Revise]\n  D --> A' },
  { id: 'sequence', label: 'Sequence', body: 'sequenceDiagram\n  participant C as Customer\n  participant P as Portal\n  participant T as Team\n  C->>P: Submit feedback\n  P->>T: Notify\n  T-->>C: Status update' },
  { id: 'org', label: 'Org chart', body: 'flowchart TD\n  CEO[Chief Executive] --> CTO[Technology]\n  CEO --> COO[Operations]\n  CTO --> ENG[Engineering]\n  CTO --> PM[Product]\n  COO --> SUP[Support]' },
  { id: 'timeline', label: 'Timeline', body: 'timeline\n  title Project Lighthouse\n  Oct 2026 : Discovery\n  Jan 2027 : Pilot\n  Mar 2027 : Launch' },
  { id: 'mindmap', label: 'Mind map', body: 'mindmap\n  root((Feedback portal))\n    Collect\n      Email\n      Chat\n    Decide\n      Votes\n      Segments\n    Close the loop' },
];

export function mermaidTemplate(id: string): string {
  return fenced('mermaid', (MERMAID_TEMPLATES.find(t => t.id === id) ?? MERMAID_TEMPLATES[0]!).body);
}

// ── Table of contents ────────────────────────────────────────────────

export const TOC_LINE = '<!-- aico:toc -->';
export const isToc = (text: string): boolean => /^\s*<!--\s*aico:toc\s*-->\s*$/.test(text);

export interface TocEntry { level: number; text: string; index: number; pending?: boolean }

/**
 * The headings a TOC lists — every heading, and every pending section by the
 * heading it will have (a new document is all placeholders, and its contents
 * should still read as its plan). The document title is left out when it is
 * the first block.
 */
export function tocEntries(blocks: readonly Block[]): TocEntry[] {
  const all = blocks.map((b, index) => ({ b, index })).filter(({ b }) => b.kind === 'heading' || (b.kind === 'pending' && b.pending));
  const skipTitle = all.length > 1 && all[0]!.index === 0 && all[0]!.b.kind === 'heading' && (all[0]!.b.level ?? 1) === 1;
  return all.slice(skipTitle ? 1 : 0).map(({ b, index }) => (b.kind === 'pending'
    ? { level: 2, text: b.pending!.heading || b.pending!.intent || 'Section', index, pending: true }
    : { level: b.level ?? 1, text: headingText(b), index }));
}
