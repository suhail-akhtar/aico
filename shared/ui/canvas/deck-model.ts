/**
 * AICO Slides — the deck a `deck` canvas holds: its slides as structured
 * content, never as coordinates.
 *
 * ## Why slides are layouts plus fields
 *
 * A model asked to place text boxes by position produces overlapping boxes,
 * ragged margins and a different grid on every slide; a person dragging boxes
 * does the same more slowly. So a slide names one of a fixed catalogue of
 * {@link LAYOUTS} and fills that layout's fields (title, bullets, two columns,
 * chart data, a Mermaid diagram, table rows, KPIs, a quote, timeline items…).
 * Where everything goes is decided by one layout engine (`deck-layout.ts`),
 * the same for the editor, the PDF and PowerPoint. ADR 0023.
 *
 * ## The canvas contract
 *
 * The deck is serialised as JSON into the canvas's one tab, versioned and
 * conflict-checked like a sheet's workbook; the store refuses a write that
 * does not parse ({@link parseDeck}). Edits are {@link DeckOp}s: the editor
 * keeps the ones not yet saved and, when the agent wrote first, replays them
 * on the agent's version by slide id ({@link replayDeck}) — a person retitling
 * slide 3 while the agent adds slide 9 is not a conflict.
 *
 * Loose input is normalised, not refused, wherever the meaning is clear (a
 * bullet as a string, a level-2 bullet as an indented string, an ECharts
 * option instead of our chart shape when it is a plain category chart):
 * models send all of these, and rejecting a deck over the spelling of a
 * bullet wastes a turn. Hard caps keep a deck a deck (at most
 * {@link MAX_SLIDES} slides, bounded field lengths); the soft limits that
 * make a slide readable are the layout engine's problems, reported back.
 *
 * @module shared/ui/canvas/deck-model
 */

export type DeckLayout =
  | 'title' | 'section' | 'bullets' | 'two-column' | 'comparison' | 'image-text' | 'image'
  | 'chart' | 'diagram' | 'table' | 'kpi' | 'quote' | 'timeline' | 'agenda' | 'closing';

export type DeckAspect = '16:9' | '4:3';
export type DeckTransition = 'none' | 'fade';

export interface Bullet { text: string; level?: 0 | 1 }

export interface DeckColumn { heading?: string; bullets?: Bullet[]; body?: string }

export type DeckChartType = 'bar' | 'column' | 'stacked' | 'line' | 'area' | 'pie' | 'doughnut';

export interface DeckChart {
  type: DeckChartType;
  categories: string[];
  series: { name: string; values: number[] }[];
  /** Shown on the value axis and data labels, e.g. "%", "£k". */
  unit?: string;
  /**
   * An ECharts option kept as given when it is not a plain category chart
   * (scatter, radar, sankey…): drawn by ECharts in the app and as a picture in
   * PowerPoint. `type`/`categories`/`series` are then empty.
   */
  echarts?: Record<string, unknown>;
}

export interface DeckImage { src: string; alt?: string; fit?: 'cover' | 'contain' }
export interface DeckTable { header: string[]; rows: string[][] }
export interface DeckKpi { value: string; label: string; delta?: string; trend?: 'up' | 'down' | 'flat' }
export interface DeckMilestone { date: string; title: string; text?: string }

export interface Slide {
  id: string;
  layout: DeckLayout;
  title?: string;
  subtitle?: string;
  bullets?: Bullet[];
  /** A paragraph: the lead line of a bullets slide, the presenter line of a title slide. */
  body?: string;
  left?: DeckColumn;
  right?: DeckColumn;
  image?: DeckImage;
  chart?: DeckChart;
  /** Mermaid source. */
  diagram?: string;
  table?: DeckTable;
  kpis?: DeckKpi[];
  quote?: string;
  attribution?: string;
  timeline?: DeckMilestone[];
  /** A source or footnote line under the content. */
  source?: string;
  notes?: string;
  transition?: DeckTransition;
  /** Set while the slide is still a plan: what it will say. Cleared by any content write. */
  intent?: string;
}

export interface Deck {
  v: 1;
  aspect: DeckAspect;
  /** A theme id (`deck-themes.ts`). */
  theme: string;
  /** A deck type id (`deck-types.ts`), when the deck was made from one. */
  type?: string;
  /** Footer text on content slides ("Acme · Confidential"). */
  footer?: string;
  /** Slide numbers on content slides; default on. */
  slideNumbers?: boolean;
  slides: Slide[];
}

export const MAX_SLIDES = 80;
const MAX_TEXT = 1200;
const MAX_NOTES = 8000;
const MAX_LIST = 24;

export interface LayoutInfo {
  id: DeckLayout;
  label: string;
  /** One line for the tool help and the layout picker. */
  hint: string;
  /** The fields this layout draws (others are kept but not shown). */
  fields: (keyof Slide)[];
}

/** The catalogue — order is the picker's. */
export const LAYOUTS: readonly LayoutInfo[] = [
  { id: 'title', label: 'Title', hint: 'opening slide: title, subtitle, body (presenter · date)', fields: ['title', 'subtitle', 'body'] },
  { id: 'section', label: 'Section header', hint: 'divider: title, subtitle', fields: ['title', 'subtitle'] },
  { id: 'bullets', label: 'Title and bullets', hint: 'title, body? (lead line), bullets (≤6)', fields: ['title', 'body', 'bullets', 'source'] },
  { id: 'two-column', label: 'Two columns', hint: 'title, left/right {heading, bullets|body}', fields: ['title', 'left', 'right', 'source'] },
  { id: 'comparison', label: 'Comparison', hint: 'title, left/right {heading, bullets} as two cards', fields: ['title', 'left', 'right', 'source'] },
  { id: 'image-text', label: 'Image and text', hint: 'title, image {src, alt}, bullets|body', fields: ['title', 'image', 'body', 'bullets'] },
  { id: 'image', label: 'Full-bleed image', hint: 'image {src}, title?, subtitle? over it', fields: ['image', 'title', 'subtitle'] },
  { id: 'chart', label: 'Chart', hint: 'title, chart {type, categories, series}, bullets? (≤4 takeaways), source', fields: ['title', 'chart', 'bullets', 'source'] },
  { id: 'diagram', label: 'Diagram', hint: 'title, diagram (Mermaid), bullets? (≤4), source', fields: ['title', 'diagram', 'bullets', 'source'] },
  { id: 'table', label: 'Table', hint: 'title, table {header, rows} (≤8 rows, ≤6 columns), source', fields: ['title', 'table', 'source'] },
  { id: 'kpi', label: 'Big numbers', hint: 'title, kpis [{value, label, delta?, trend?}] (1–4), body?', fields: ['title', 'kpis', 'body', 'source'] },
  { id: 'quote', label: 'Quote', hint: 'quote, attribution, title? (small label)', fields: ['quote', 'attribution', 'title'] },
  { id: 'timeline', label: 'Timeline', hint: 'title, timeline [{date, title, text?}] (2–6)', fields: ['title', 'timeline', 'source'] },
  { id: 'agenda', label: 'Agenda', hint: 'title, bullets (the items, ≤8)', fields: ['title', 'bullets'] },
  { id: 'closing', label: 'Closing', hint: 'title ("Thank you", "Questions?"), subtitle, body (contact)', fields: ['title', 'subtitle', 'body'] },
];

const LAYOUT_IDS = new Set<string>(LAYOUTS.map(l => l.id));
const ALIASES: Record<string, DeckLayout> = {
  'title-bullets': 'bullets', 'title+bullets': 'bullets', content: 'bullets', 'title-content': 'bullets', list: 'bullets',
  twocolumn: 'two-column', 'two-columns': 'two-column', columns: 'two-column', compare: 'comparison', vs: 'comparison',
  imagetext: 'image-text', 'image+text': 'image-text', picture: 'image', photo: 'image', 'full-bleed': 'image', 'full-bleed-image': 'image',
  graph: 'chart', mermaid: 'diagram', architecture: 'diagram', kpis: 'kpi', 'big-number': 'kpi', 'big-numbers': 'kpi', stats: 'kpi', metrics: 'kpi',
  'section-header': 'section', divider: 'section', cover: 'title', thanks: 'closing', 'thank-you': 'closing', end: 'closing', questions: 'closing',
  roadmap: 'timeline', milestones: 'timeline', contents: 'agenda',
};

export function layoutInfo(id: string): LayoutInfo {
  return LAYOUTS.find(l => l.id === id) ?? LAYOUTS[2]!;
}

/** A layout id from what a model or person typed, or undefined. */
export function toLayout(value: unknown): DeckLayout | undefined {
  if (typeof value !== 'string') return undefined;
  const k = value.trim().toLowerCase().replace(/[\s_]+/g, '-');
  if (LAYOUT_IDS.has(k)) return k as DeckLayout;
  return ALIASES[k] ?? ALIASES[k.replace(/-/g, '')];
}

// ── Normalising loose input ──────────────────────────────────────────

function str(v: unknown, max = MAX_TEXT): string | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  if (typeof v !== 'string') return undefined;
  const t = v.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim();
  return t ? t.slice(0, max) : undefined;
}

/** "Point", "  Sub-point", "- Point", {text, level}. */
export function toBullets(v: unknown): Bullet[] | undefined {
  if (typeof v === 'string') v = v.split('\n').filter(l => l.trim());
  if (!Array.isArray(v)) return undefined;
  const out: Bullet[] = [];
  for (const item of v.slice(0, MAX_LIST)) {
    if (item && typeof item === 'object' && !Array.isArray(item)) {
      const o = item as { text?: unknown; level?: unknown };
      const text = str(o.text, 400);
      if (text) out.push({ text, ...(Number(o.level) >= 1 ? { level: 1 as const } : {}) });
      continue;
    }
    if (typeof item !== 'string') continue;
    const nested = /^(\s{2,}|\t)/.test(item);
    const text = str(item.replace(/^\s*(?:[-*•–]|\d+[.)])\s+/, ''), 400);
    if (text) out.push({ text, ...(nested ? { level: 1 as const } : {}) });
  }
  return out.length ? out : undefined;
}

function toColumn(v: unknown): DeckColumn | undefined {
  if (typeof v === 'string' || Array.isArray(v)) {
    const bullets = toBullets(v);
    return bullets ? { bullets } : undefined;
  }
  if (!v || typeof v !== 'object') return undefined;
  const o = v as Record<string, unknown>;
  const heading = str(o.heading ?? o.title, 200);
  const bullets = toBullets(o.bullets ?? o.items ?? o.points);
  const body = str(o.body ?? o.text);
  if (!heading && !bullets && !body) return undefined;
  return { ...(heading ? { heading } : {}), ...(bullets ? { bullets } : {}), ...(body ? { body } : {}) };
}

function num(v: unknown): number {
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  if (typeof v === 'string') {
    const n = Number(v.replace(/[,%£$€\s]/g, ''));
    return Number.isFinite(n) ? n : 0;
  }
  if (v && typeof v === 'object' && 'value' in v) return num((v as { value: unknown }).value);
  return 0;
}

const CHART_TYPES = new Set<DeckChartType>(['bar', 'column', 'stacked', 'line', 'area', 'pie', 'doughnut']);

/**
 * Our chart shape, or an ECharts option converted to it when it is a plain
 * category chart (category x-axis with bar/line series, or a pie), or kept as
 * `echarts` when it is something else.
 */
export function toChart(v: unknown): DeckChart | undefined {
  if (typeof v === 'string') {
    try { v = JSON.parse(v); } catch { return undefined; }
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
  const o = v as Record<string, unknown>;
  const series = o.series;
  // Our own shape: series[].values.
  if (Array.isArray(o.categories) || (Array.isArray(series) && series.some(s => s && typeof s === 'object' && 'values' in s))) {
    const rawType = String(o.type ?? 'column').toLowerCase();
    const type: DeckChartType = CHART_TYPES.has(rawType as DeckChartType) ? rawType as DeckChartType
      : rawType === 'donut' ? 'doughnut' : rawType.includes('stack') ? 'stacked' : rawType === 'hbar' || rawType === 'horizontal' ? 'bar' : 'column';
    const categories = (Array.isArray(o.categories) ? o.categories : []).slice(0, 40).map(c => str(c, 60) ?? '');
    const list = (Array.isArray(series) ? series : []).slice(0, 8).map((s, i) => {
      const so = (s && typeof s === 'object' ? s : {}) as { name?: unknown; values?: unknown; data?: unknown };
      const values = (Array.isArray(so.values) ? so.values : Array.isArray(so.data) ? so.data : []).slice(0, 40).map(num);
      return { name: str(so.name, 60) ?? `Series ${i + 1}`, values };
    });
    const unit = str(o.unit, 12);
    return { type, categories, series: list, ...(unit ? { unit } : {}) };
  }
  // An ECharts option.
  if (Array.isArray(series) || (series && typeof series === 'object')) {
    const ss = (Array.isArray(series) ? series : [series]) as Record<string, unknown>[];
    const first = ss[0] ?? {};
    if (first.type === 'pie' && Array.isArray(first.data)) {
      const data = first.data as unknown[];
      const radius = first.radius;
      const hole = Array.isArray(radius) && parseFloat(String(radius[0])) > 0;
      return {
        type: hole ? 'doughnut' : 'pie',
        categories: data.slice(0, 40).map(d => str((d as { name?: unknown })?.name, 60) ?? ''),
        series: [{ name: str(first.name, 60) ?? 'Share', values: data.slice(0, 40).map(num) }],
      };
    }
    const x = (Array.isArray(o.xAxis) ? o.xAxis[0] : o.xAxis) as Record<string, unknown> | undefined;
    const y = (Array.isArray(o.yAxis) ? o.yAxis[0] : o.yAxis) as Record<string, unknown> | undefined;
    const horizontal = y?.type === 'category' && Array.isArray(y.data);
    const cats = horizontal ? y!.data : x?.data;
    const plain = Array.isArray(cats) && ss.every(s => (s.type === 'bar' || s.type === 'line') && Array.isArray(s.data));
    if (plain) {
      const kinds = new Set(ss.map(s => s.type));
      const stacked = ss.some(s => s.stack);
      const area = ss.every(s => s.type === 'line' && s.areaStyle);
      const type: DeckChartType = kinds.has('bar') ? (stacked ? 'stacked' : horizontal ? 'bar' : 'column') : area ? 'area' : 'line';
      return {
        type,
        categories: (cats as unknown[]).slice(0, 40).map(c => str(c, 60) ?? ''),
        series: ss.slice(0, 8).map((s, i) => ({ name: str(s.name, 60) ?? `Series ${i + 1}`, values: (s.data as unknown[]).slice(0, 40).map(num) })),
      };
    }
    return { type: 'column', categories: [], series: [], echarts: o };
  }
  return undefined;
}

function toTable(v: unknown): DeckTable | undefined {
  let rows: unknown[] | undefined;
  let header: unknown;
  if (typeof v === 'string') {
    // A Markdown table, or tab/pipe separated lines.
    const lines = v.split('\n').map(l => l.trim()).filter(l => l && !/^\|?\s*:?-{2,}/.test(l));
    rows = lines.map(l => l.replace(/^\||\|$/g, '').split(l.includes('\t') ? '\t' : '|').map(c => c.trim()));
    header = rows.shift();
  } else if (Array.isArray(v)) {
    rows = v.slice();
    header = rows.shift();
  } else if (v && typeof v === 'object') {
    const o = v as { header?: unknown; headers?: unknown; columns?: unknown; rows?: unknown };
    header = o.header ?? o.headers ?? o.columns;
    rows = Array.isArray(o.rows) ? o.rows : [];
  }
  if (!Array.isArray(header) || !header.length) return undefined;
  const h = header.slice(0, 12).map(c => str(c, 120) ?? '');
  const r = (rows ?? []).filter(Array.isArray).slice(0, 30)
    .map(row => h.map((_, i) => str((row as unknown[])[i], 300) ?? ''));
  return { header: h, rows: r };
}

function toKpis(v: unknown): DeckKpi[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: DeckKpi[] = [];
  for (const k of v.slice(0, 8)) {
    if (!k || typeof k !== 'object') continue;
    const o = k as Record<string, unknown>;
    const value = str(o.value, 24);
    const label = str(o.label ?? o.title ?? o.name, 120);
    if (!value && !label) continue;
    const delta = str(o.delta ?? o.change, 40);
    const t = String(o.trend ?? '').toLowerCase();
    const trend = t === 'up' || t === 'down' || t === 'flat' ? t
      : delta ? (/^\s*[-−▼↓]/.test(delta) ? 'down' : /^\s*[+▲↑]/.test(delta) ? 'up' : undefined) : undefined;
    out.push({ value: value ?? '—', label: label ?? '', ...(delta ? { delta } : {}), ...(trend ? { trend: trend as DeckKpi['trend'] } : {}) });
  }
  return out.length ? out : undefined;
}

function toTimeline(v: unknown): DeckMilestone[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: DeckMilestone[] = [];
  for (const m of v.slice(0, 12)) {
    if (!m || typeof m !== 'object') continue;
    const o = m as Record<string, unknown>;
    const title = str(o.title ?? o.label ?? o.name, 120);
    const date = str(o.date ?? o.when ?? o.time, 40);
    const text = str(o.text ?? o.description ?? o.detail, 300);
    if (!title && !date) continue;
    out.push({ date: date ?? '', title: title ?? '', ...(text ? { text } : {}) });
  }
  return out.length ? out : undefined;
}

function toImage(v: unknown): DeckImage | undefined {
  if (typeof v === 'string') return str(v, 2000) ? { src: str(v, 2000)! } : undefined;
  if (!v || typeof v !== 'object') return undefined;
  const o = v as Record<string, unknown>;
  const src = str(o.src ?? o.path ?? o.url, 2000);
  if (!src) return undefined;
  const alt = str(o.alt, 300);
  return { src, ...(alt ? { alt } : {}), ...(o.fit === 'contain' ? { fit: 'contain' as const } : {}) };
}

/** The content fields, for "is this slide still only a plan?" */
const CONTENT_KEYS: (keyof Slide)[] = ['title', 'subtitle', 'bullets', 'body', 'left', 'right', 'image', 'chart', 'diagram', 'table', 'kpis', 'quote', 'timeline'];

/**
 * A slide from loose input. `base` is the slide being changed: fields the
 * input names replace its, `null` clears one, the rest are kept.
 */
export function normalizeSlide(input: unknown, id: string, base?: Slide): Slide {
  const o = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const out: Slide = base ? { ...base, id } : { id, layout: 'bullets' };
  const has = (k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);
  const set = <K extends keyof Slide>(k: K, v: Slide[K] | undefined): void => {
    if (v === undefined) delete out[k]; else out[k] = v;
  };
  if (has('layout')) {
    const l = toLayout(o.layout);
    if (!l) throw new Error(`slide ${id}: layout "${String(o.layout)}" is not one of ${LAYOUTS.map(x => x.id).join(', ')}`);
    out.layout = l;
  }
  if (has('title')) set('title', str(o.title, 300));
  if (has('subtitle')) set('subtitle', str(o.subtitle, 400));
  if (has('bullets') || has('items') || has('points')) set('bullets', toBullets(o.bullets ?? o.items ?? o.points));
  if (has('body') || has('text')) set('body', str(o.body ?? o.text));
  if (has('left')) set('left', toColumn(o.left));
  if (has('right')) set('right', toColumn(o.right));
  if (has('columns') && Array.isArray(o.columns)) { set('left', toColumn(o.columns[0])); set('right', toColumn(o.columns[1])); }
  if (has('image')) set('image', toImage(o.image));
  if (has('chart')) set('chart', toChart(o.chart));
  if (has('diagram') || has('mermaid')) set('diagram', str(o.diagram ?? o.mermaid, 6000));
  if (has('table')) set('table', toTable(o.table));
  if (has('kpis') || has('stats') || has('metrics')) set('kpis', toKpis(o.kpis ?? o.stats ?? o.metrics));
  if (has('quote')) set('quote', str(o.quote, 600));
  if (has('attribution') || has('by')) set('attribution', str(o.attribution ?? o.by, 200));
  if (has('timeline') || has('milestones')) set('timeline', toTimeline(o.timeline ?? o.milestones));
  if (has('source')) set('source', str(o.source, 300));
  if (has('notes')) set('notes', str(o.notes, MAX_NOTES));
  if (has('transition')) set('transition', o.transition === 'fade' ? 'fade' : o.transition === 'none' ? 'none' : undefined);
  if (has('intent')) set('intent', str(o.intent, 400));
  else if (CONTENT_KEYS.some(k => k !== 'title' && has(k as string) && out[k] !== undefined)) delete out.intent;
  return out;
}

/** Is the slide still a plan (an intent and no content beyond a title)? */
export function isPending(s: Slide): boolean {
  return Boolean(s.intent) && !CONTENT_KEYS.some(k => k !== 'title' && s[k] !== undefined);
}

// ── Parsing and ids ──────────────────────────────────────────────────

const SLIDE_ID = /^[A-Za-z0-9_-]{1,24}$/;

export function emptyDeck(theme = 'slate', aspect: DeckAspect = '16:9'): Deck {
  return { v: 1, aspect, theme, slides: [] };
}

/** The next free id: s1, s2, … (never reusing a gap, so a deleted slide's id does not come back meaning something else). */
export function nextSlideId(deck: Deck, taken: Set<string> = new Set()): string {
  let n = 0;
  for (const s of deck.slides) { const m = /^s(\d+)$/.exec(s.id); if (m) n = Math.max(n, Number(m[1])); }
  for (const t of taken) { const m = /^s(\d+)$/.exec(t); if (m) n = Math.max(n, Number(m[1])); }
  return `s${n + 1}`;
}

/** Parse a deck's text. Throws naming what is wrong. */
export function parseDeck(text: string): Deck {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch (err) { throw new Error(`a deck is JSON (${(err as Error).message})`); }
  return deckFrom(raw);
}

/** A deck from a parsed object, every slide normalised. */
export function deckFrom(raw: unknown): Deck {
  const o = raw as Partial<Deck> | null;
  if (!o || typeof o !== 'object' || !Array.isArray(o.slides)) throw new Error('a deck is {"v":1,"theme","aspect","slides":[…]}');
  if (o.slides.length > MAX_SLIDES) throw new Error(`a deck holds at most ${MAX_SLIDES} slides`);
  const seen = new Set<string>();
  const slides = o.slides.map((s, i) => {
    let id = typeof (s as Slide)?.id === 'string' && SLIDE_ID.test((s as Slide).id) ? (s as Slide).id : `s${i + 1}`;
    while (seen.has(id)) id = `${id}x`;
    seen.add(id);
    const slide = normalizeSlide(s, id);
    if (!(s as Slide)?.layout) slide.layout = 'bullets';
    return slide;
  });
  return {
    v: 1,
    aspect: o.aspect === '4:3' ? '4:3' : '16:9',
    theme: typeof o.theme === 'string' && o.theme.trim() ? o.theme.trim().slice(0, 40) : 'slate',
    ...(typeof o.type === 'string' && o.type.trim() ? { type: o.type.trim().slice(0, 40) } : {}),
    ...(typeof o.footer === 'string' && o.footer.trim() ? { footer: o.footer.trim().slice(0, 120) } : {}),
    ...(o.slideNumbers === false ? { slideNumbers: false } : {}),
    slides,
  };
}

export function serializeDeck(deck: Deck): string {
  return JSON.stringify(deck);
}

// ── Operations (the editor's edits, replayable over the agent's) ─────

export type DeckOp =
  | { op: 'set'; slide: Slide }
  | { op: 'insert'; at: number; slide: Slide }
  | { op: 'delete'; id: string }
  | { op: 'move'; id: string; to: number }
  | { op: 'meta'; patch: Partial<Pick<Deck, 'theme' | 'aspect' | 'type' | 'footer' | 'slideNumbers'>> }
  | { op: 'replace'; deck: Deck };

/** Apply one operation. Throws when it no longer applies (its slide is gone). */
export function applyDeckOp(deck: Deck, op: DeckOp): Deck {
  const at = (id: string): number => {
    const i = deck.slides.findIndex(s => s.id === id);
    if (i < 0) throw new Error(`no slide ${id}`);
    return i;
  };
  switch (op.op) {
    case 'set': {
      const i = at(op.slide.id);
      return { ...deck, slides: deck.slides.map((s, j) => (j === i ? op.slide : s)) };
    }
    case 'insert': {
      if (deck.slides.length >= MAX_SLIDES) throw new Error(`a deck holds at most ${MAX_SLIDES} slides`);
      const slide = deck.slides.some(s => s.id === op.slide.id) ? { ...op.slide, id: nextSlideId(deck) } : op.slide;
      const k = Math.max(0, Math.min(deck.slides.length, Math.trunc(op.at)));
      return { ...deck, slides: [...deck.slides.slice(0, k), slide, ...deck.slides.slice(k)] };
    }
    case 'delete': {
      const i = at(op.id);
      return { ...deck, slides: deck.slides.filter((_, j) => j !== i) };
    }
    case 'move': {
      const i = at(op.id);
      const rest = deck.slides.filter((_, j) => j !== i);
      const k = Math.max(0, Math.min(rest.length, Math.trunc(op.to)));
      return { ...deck, slides: [...rest.slice(0, k), deck.slides[i]!, ...rest.slice(k)] };
    }
    case 'meta': {
      const next: Deck = { ...deck };
      const p = op.patch;
      if (p.theme !== undefined) next.theme = p.theme;
      if (p.aspect !== undefined) next.aspect = p.aspect === '4:3' ? '4:3' : '16:9';
      if (p.type !== undefined) { if (p.type) next.type = p.type; else delete next.type; }
      if (p.footer !== undefined) { if (p.footer) next.footer = p.footer; else delete next.footer; }
      if (p.slideNumbers !== undefined) { if (p.slideNumbers === false) next.slideNumbers = false; else delete next.slideNumbers; }
      return next;
    }
    case 'replace':
      return op.deck;
  }
}

/** Replay pending operations on a newer deck; those whose slide is gone are skipped and counted. */
export function replayDeck(latest: Deck, ops: DeckOp[]): { deck: Deck; skipped: number } {
  let deck = latest;
  let skipped = 0;
  for (const op of ops) {
    try { deck = applyDeckOp(deck, op); } catch { skipped++; }
  }
  return { deck, skipped };
}

/** A copy of a slide under a new id, for "duplicate". */
export function duplicateSlide(deck: Deck, id: string): { deck: Deck; slide: Slide } {
  const i = deck.slides.findIndex(s => s.id === id);
  if (i < 0) throw new Error(`no slide ${id}`);
  const slide = { ...structuredClone(deck.slides[i]!), id: nextSlideId(deck) };
  return { deck: applyDeckOp(deck, { op: 'insert', at: i + 1, slide }), slide };
}

/** A fresh slide of a layout, with placeholder text a person replaces. */
export function blankSlide(layout: DeckLayout, id: string): Slide {
  switch (layout) {
    case 'title': return { id, layout, title: 'Presentation title', subtitle: 'Subtitle' };
    case 'section': return { id, layout, title: 'Section title' };
    case 'two-column': case 'comparison':
      return { id, layout, title: 'Slide title', left: { heading: 'Option A', bullets: [{ text: 'Point' }] }, right: { heading: 'Option B', bullets: [{ text: 'Point' }] } };
    case 'image-text': return { id, layout, title: 'Slide title', bullets: [{ text: 'Point' }] };
    case 'image': return { id, layout, title: 'Caption' };
    case 'chart': return { id, layout, title: 'Slide title', chart: { type: 'column', categories: ['Q1', 'Q2', 'Q3', 'Q4'], series: [{ name: 'Series 1', values: [10, 14, 12, 18] }] } };
    case 'diagram': return { id, layout, title: 'Slide title', diagram: 'flowchart LR\n  A[Start] --> B[Step] --> C[Finish]' };
    case 'table': return { id, layout, title: 'Slide title', table: { header: ['Item', 'Detail'], rows: [['', ''], ['', '']] } };
    case 'kpi': return { id, layout, title: 'Slide title', kpis: [{ value: '0', label: 'Metric' }, { value: '0', label: 'Metric' }, { value: '0', label: 'Metric' }] };
    case 'quote': return { id, layout, quote: 'Quote', attribution: 'Name' };
    case 'timeline': return { id, layout, title: 'Slide title', timeline: [{ date: 'Q1', title: 'Milestone' }, { date: 'Q2', title: 'Milestone' }, { date: 'Q3', title: 'Milestone' }] };
    case 'agenda': return { id, layout, title: 'Agenda', bullets: [{ text: 'Item' }, { text: 'Item' }, { text: 'Item' }] };
    case 'closing': return { id, layout, title: 'Thank you', subtitle: 'Questions?' };
    default: return { id, layout: 'bullets', title: 'Slide title', bullets: [{ text: 'Point' }] };
  }
}

// ── Inline formatting ────────────────────────────────────────────────

export interface TextRun { text: string; b?: boolean; i?: boolean; /** `code` — set in a monospace face. */ c?: boolean }

/** `**bold**`, `*italic*` (or `_italic_`) and `` `code` `` inside slide text; everything else is literal. */
export function parseRuns(text: string): TextRun[] {
  const out: TextRun[] = [];
  const re = /`([^`]+)`|\*\*([^*]+)\*\*|(?<![\w*])\*([^*\s][^*]*?)\*(?![\w*])|(?<![\w_])_([^_\s][^_]*?)_(?![\w_])/g;
  let last = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > last) out.push({ text: text.slice(last, m.index) });
    if (m[1] !== undefined) out.push({ text: m[1], c: true });
    else if (m[2] !== undefined) out.push({ text: m[2], b: true });
    else out.push({ text: (m[3] ?? m[4])!, i: true });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last) });
  return out.length ? out : [{ text: '' }];
}

export function plainOf(text: string): string {
  return parseRuns(text).map(r => r.text).join('');
}

/** The words on a slide, for a summary or a thumbnail's accessible name. */
export function slideText(s: Slide): string {
  const parts: string[] = [];
  const push = (t?: string): void => { if (t) parts.push(plainOf(t)); };
  push(s.title); push(s.subtitle); push(s.body);
  s.bullets?.forEach(b => push(b.text));
  for (const c of [s.left, s.right]) { push(c?.heading); c?.bullets?.forEach(b => push(b.text)); push(c?.body); }
  push(s.quote); push(s.attribution);
  s.kpis?.forEach(k => push(`${k.value} ${k.label}`));
  s.timeline?.forEach(m => push(`${m.date} ${m.title}`));
  return parts.join(' · ');
}
