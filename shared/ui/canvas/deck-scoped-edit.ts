/**
 * Scoped ("inline") AI edits on a presentation: one slide, or one element of
 * it — its title, a bullet, the bullet list, the table or some of its cells,
 * the chart, the diagram, the KPI tiles, a milestone, the quote, the image
 * caption, the speaker notes, or words selected inside any of those — changed
 * and provably nothing else. ADR 0024 (deck section), on the deck model of
 * ADR 0023.
 *
 * ## Why decks need their own half
 *
 * Documents name blocks of Markdown; a slide is a layout plus structured
 * fields (`deck-model.ts`), and "fits" is a question only the layout engine
 * (`deck-layout.ts`) can answer — a punchier title that wraps to three lines,
 * or a seventh bullet on a pitch slide, is a broken slide even though every
 * word is right. So a deck element resolves into the same `ResolvedPart` the
 * document editor uses (text, table/cells, ECharts chart, Mermaid, or JSON for
 * the structured fields), reuses its contract, model call and prose checks
 * unchanged, and adds what only a deck can check:
 *
 * - **Scope by construction and by hash**: {@link applyDeckPatch} writes only
 *   the targeted field of the targeted slide; {@link validateDeckPatch} then
 *   compares every other slide and every other field of the slide (stable
 *   JSON) before and after, and refuses any difference.
 * - **Type and layout kept unless asked**: an element keeps its kind (the
 *   answer must be the element's own patch kind — never Markdown), a slide
 *   keeps its layout unless the instruction asks for another ("turn the
 *   bullets into big numbers" → `kpi`), and then into exactly that layout
 *   with every figure carried over.
 * - **The fit check**: the slide is laid out before and after; a layout error
 *   the edit introduces (overflow, too many bullets for the deck type, a
 *   table too big, a title past two lines) refuses the edit; one that was
 *   already there on the edited element refuses it when the instruction was
 *   to shorten or fit, and is a warning otherwise.
 *
 * What the instruction allows is read from its words by {@link deckIntentOf}
 * (the document reader, plus a target layout, "fewer" and "fit"); a quick
 * action is a well-worded instruction, as for documents ({@link deckActions}).
 *
 * DOM-free: the engine (`src/canvas/deck-inline-edit.ts`, the route, the
 * Canvas tool's `edit_part`) and the deck editor (which re-applies an accepted
 * patch to the deck it holds) run this same code.
 *
 * Infographics (ADR 0025) are elements too: `infographic` (its kind, items,
 * centre, axes) and `infographic.N` (one item). Their kind changes only when
 * asked ("Change infographic style" picks among the kinds that can draw the
 * same items), they keep 2–8 items, every icon must be in the vendored icon
 * set, and the infographic layout's own fit check decides whether they fit.
 *
 * Deliberately not here: element ids for sub-parts of a column (`left`/`right`
 * are edited whole), cell-level chart edits (the chart's data is one part), or
 * a planned slide's content (the agent fills plans; a plan's title and notes
 * can be edited).
 *
 * @module shared/ui/canvas/deck-scoped-edit
 */

import {
  checkMermaid, checkTextFacts, definedTerms, describeTarget, intentOf, locateSelection, mermaidKind, numbersIn, styleRules,
  validatePatch, type CellRange, type EditContext, type EditIntent, type PartAction, type PartPatch, type PartTarget, type ResolvedPart, type Verdict,
} from './scoped-edit';
import {
  INFOGRAPHICS, infographicInfo, isPending, layoutInfo, normalizeSlide, plainOf, slideText, toBullets, toInfographic, toKpis, toLayout, toTimeline,
  type Bullet, type Deck, type DeckColumn, type DeckInfographic, type DeckLayout, type InfoItem, type InfographicKind, type Slide,
} from './deck-model';
import { isDeckIcon } from './deck-icons';
import { layoutSlide, type Problem } from './deck-layout';
import { deckTheme } from './deck-themes';
import { deckTypeById } from './deck-types';
import { textWidth } from './deck-fonts';
import { tableToMarkdown, type TableModel } from './visual';

// ── Targets ──────────────────────────────────────────────────────────

/** A deck target: the slide, the element on it (default the whole slide), and optionally a text range or table cells. */
export type DeckTarget = Pick<PartTarget, 'slideId' | 'elementId' | 'range' | 'cells'>;

/** A resolved deck part: the generic part plus where it is in the deck. */
export interface DeckPart extends ResolvedPart {
  slideId: string;
  /** "title", "bullets", "bullets.2" (1-based item), "table", "slide"… */
  elementId: string;
  /** The slide field the element lives in ("slide" for the whole slide). */
  field: string;
  /** 1-based item of a list field (a bullet, a KPI tile, a milestone). */
  item?: number;
  /** The slide's index in the deck. */
  index: number;
}

type Resolve = { ok: true; part: DeckPart } | { ok: false; error: string };

const TEXT_FIELDS = ['title', 'subtitle', 'body', 'quote', 'attribution', 'source', 'notes'] as const;
type TextField = typeof TEXT_FIELDS[number];
const ITEM_FIELDS = new Set(['bullets', 'kpis', 'timeline', 'infographic']);
const ELEMENT = /^(slide|title|subtitle|body|quote|attribution|source|notes|bullets|left|right|table|chart|diagram|kpis|timeline|infographic|image)(?:\.(\d{1,2}))?$/;
/** The element ids, for errors and the tool help. */
export const ELEMENT_IDS = 'title, subtitle, body, bullets, bullets.2, left, right, table, chart, diagram, kpis, kpis.1, timeline, timeline.1, infographic, infographic.1, quote, attribution, image, source, notes, slide';

/** An element id read: its field and 1-based item; null when it names nothing. */
export function parseElement(id: string | undefined): { field: string; item?: number } | null {
  const raw = (id ?? 'slide').trim().toLowerCase().replace(/\s+/g, '') || 'slide';
  const alias: Record<string, string> = { bullet: 'bullets', kpi: 'kpis', milestone: 'timeline', milestones: 'timeline', caption: 'image', speakernotes: 'notes', note: 'notes', heading: 'title', lead: 'body', mermaid: 'diagram', whole: 'slide', step: 'infographic', item: 'infographic', infographics: 'infographic' };
  const [head, n] = raw.split(/[.#:]/);
  const m = ELEMENT.exec(`${alias[head!] ?? head}${n !== undefined ? `.${n}` : ''}`);
  if (!m) return null;
  const item = m[2] !== undefined ? Number(m[2]) : undefined;
  if (item !== undefined && (!ITEM_FIELDS.has(m[1]!) || item < 1)) return null;
  return { field: m[1]!, ...(item !== undefined ? { item } : {}) };
}

function bodyName(s: Slide): { label: string; what: string } {
  if (s.layout === 'title' || s.layout === 'closing') return { label: 'Presenter line', what: 'presenter line' };
  if (s.layout === 'kpi') return { label: 'Commentary', what: 'commentary line' };
  return { label: 'Lead line', what: 'lead line' };
}

const TEXT_NAMES: Record<TextField, { label: string; what: string }> = {
  title: { label: 'Title', what: 'slide title' },
  subtitle: { label: 'Subtitle', what: 'subtitle' },
  body: { label: 'Lead line', what: 'lead line' },
  quote: { label: 'Quote', what: 'quotation' },
  attribution: { label: 'Attribution', what: 'attribution' },
  source: { label: 'Source', what: 'source line' },
  notes: { label: 'Speaker notes', what: 'speaker notes' },
};

/** Fields that are one line on a slide: a newline in them is a mistake, not a choice. */
const ONE_LINE = new Set(['title', 'attribution', 'source', 'bullet', 'image']);

/** Bullets as a Markdown list — what the model edits ("  - " is a sub-point). */
export function bulletsMarkdown(b: Bullet[] | undefined): string {
  return (b ?? []).map(x => `${x.level ? '  ' : ''}- ${x.text}`).join('\n');
}

function columnJson(c: DeckColumn | undefined): Record<string, unknown> {
  return {
    ...(c?.heading ? { heading: c.heading } : {}),
    ...(c?.bullets?.length ? { bullets: c.bullets.map(b => `${b.level ? '  ' : ''}${b.text}`) } : {}),
    ...(c?.body ? { body: c.body } : {}),
  };
}

/** An infographic item as the model sees it: a picture stands in as "(image)". */
function itemJson(it: InfoItem): Record<string, unknown> {
  return { ...it, ...(it.image ? { image: { ...it.image, src: '(image)' } } : {}) };
}
function infographicJson(ig: DeckInfographic): Record<string, unknown> {
  return { ...ig, items: ig.items.map(itemJson) };
}
/** "(image)" (or no src) back to the item's own picture. */
function restoreImage(raw: unknown, was: InfoItem | undefined): unknown {
  if (!raw || typeof raw !== 'object' || !was?.image) return raw;
  const o = raw as { image?: { src?: unknown } };
  if (o.image && typeof o.image === 'object' && (o.image.src === '(image)' || o.image.src === undefined)) return { ...o, image: { ...was.image, ...o.image, src: was.image.src } };
  return raw;
}
function itemLine(it: InfoItem): string { return `${it.value ? `${it.value} — ` : ''}${it.title}${it.text ? `: ${it.text.replace(/\n/g, '; ')}` : ''}${it.icon ? ` [${it.icon}]` : ''}`; }
function infographicLines(ig: DeckInfographic): string[] {
  return [`Infographic: ${infographicInfo(ig.kind).label}${ig.centre ? ` · centre ${ig.centre}` : ''}${ig.axes ? ` · axes ${ig.axes.join(' / ')}` : ''}`, ...ig.items.map(it => `- ${itemLine(it)}`)];
}

/**
 * The infographic kinds that can draw these items instead (ADR 0025): room for
 * as many items, and the fields a kind needs — a percentage for rings and
 * stat bars, a value for tiles, a picture for the photo kinds.
 */
export function compatibleKinds(ig: DeckInfographic): InfographicKind[] {
  const n = ig.items.length;
  const all = (f: (it: InfoItem) => boolean): boolean => ig.items.every(f);
  return INFOGRAPHICS.filter((k) => {
    if (k.id === ig.kind || n < k.min || n > k.max) return false;
    if (k.id === 'rings' || k.id === 'stat-bars') return all(it => /\d\s*%/.test(it.value ?? ''));
    if (k.id === 'tiles') return all(it => Boolean(it.value));
    if (k.id === 'team' || k.id === 'quote-photo') return all(it => Boolean(it.image));
    if (k.id === 'swot' || k.id === 'matrix' || k.id === 'pros-cons' || k.id === 'before-after') return false; // positions mean something
    return true;
  }).map(k => k.id);
}

function chartJson(s: Slide): Record<string, unknown> {
  const c = s.chart!;
  return { type: c.type, categories: c.categories, series: c.series, ...(c.unit ? { unit: c.unit } : {}) };
}

/** The slide as the model sees it whole: layout and fields; an embedded picture stands in as "(image)". */
export function slideJson(s: Slide): Record<string, unknown> {
  const { id: _id, intent: _intent, transition: _t, ...rest } = s;
  const out: Record<string, unknown> = { ...rest };
  if (s.image) out.image = { ...s.image, src: '(image)' };
  if (s.bullets) out.bullets = s.bullets.map(b => `${b.level ? '  ' : ''}${b.text}`);
  for (const k of ['left', 'right'] as const) if (s[k]) out[k] = columnJson(s[k]);
  if (s.chart && !s.chart.echarts) out.chart = chartJson(s);
  if (s.infographic) out.infographic = infographicJson(s.infographic);
  if (s.images) out.images = s.images.map(im => ({ ...im, src: '(image)' }));
  return out;
}

const tableModel = (t: { header: string[]; rows: string[][] }): TableModel => ({ header: t.header, rows: t.rows, align: t.header.map(() => 'none' as const) });

/** One line per KPI tile, milestone, chart series — the readable form the review diffs. */
function kpiLine(k: { value: string; label: string; delta?: string }): string { return `${k.value} — ${k.label}${k.delta ? ` (${k.delta})` : ''}`; }
function milestoneLine(m: { date: string; title: string; text?: string }): string { return `${m.date} — ${m.title}${m.text ? `: ${m.text}` : ''}`; }
function chartLines(s: Slide): string[] {
  const c = s.chart!;
  if (c.echarts) return [JSON.stringify(c.echarts, null, 2)];
  return [`Chart: ${c.type}${c.unit ? ` · ${c.unit}` : ''}`, `Categories: ${c.categories.join(', ')}`, ...c.series.map(x => `${x.name}: ${x.values.join(', ')}`)];
}

/** Every word and figure on a slide (and its notes) as text: what a whole-slide edit is diffed and fact-checked on. */
export function slideView(s: Slide): string {
  const out: string[] = [];
  const line = (k: string, v?: string): void => { if (v?.trim()) out.push(`${k}: ${v}`); };
  line('Title', s.title);
  line('Subtitle', s.subtitle);
  line(bodyName(s).label, s.body);
  if (s.bullets?.length) out.push(bulletsMarkdown(s.bullets));
  for (const [k, c] of [['Left', s.left], ['Right', s.right]] as const) {
    if (!c) continue;
    line(k, c.heading ?? '');
    if (c.bullets?.length) out.push(bulletsMarkdown(c.bullets));
    if (c.body) out.push(c.body);
  }
  if (s.image) line('Image', s.image.alt ?? '');
  if (s.chart) out.push(...chartLines(s));
  if (s.diagram) out.push(s.diagram);
  if (s.table) out.push(tableToMarkdown(tableModel(s.table)));
  s.kpis?.forEach(k => out.push(`- ${kpiLine(k)}`));
  line('Quote', s.quote);
  line('Attribution', s.attribution);
  s.timeline?.forEach(m => out.push(`- ${milestoneLine(m)}`));
  if (s.infographic) out.push(...infographicLines(s.infographic));
  s.images?.forEach(im => line('Picture', im.caption ?? im.alt ?? ''));
  line('Source', s.source);
  line('Notes', s.notes);
  return out.join('\n');
}

/** The readable form of one element — the part's `before`, and the proposal's `after`. */
export function elementView(s: Slide, elementId: string): string {
  const el = parseElement(elementId);
  if (!el) return '';
  const f = el.field;
  if ((TEXT_FIELDS as readonly string[]).includes(f)) return (s[f as TextField] as string | undefined) ?? '';
  switch (f) {
    case 'bullets': return el.item ? s.bullets?.[el.item - 1]?.text ?? '' : bulletsMarkdown(s.bullets);
    case 'left': case 'right': {
      const c = s[f];
      return [c?.heading ?? '', bulletsMarkdown(c?.bullets), c?.body ?? ''].filter(Boolean).join('\n');
    }
    case 'table': return s.table ? tableToMarkdown(tableModel(s.table)) : '';
    case 'chart': return s.chart ? chartLines(s).join('\n') : '';
    case 'diagram': return s.diagram ?? '';
    case 'kpis': return el.item ? (s.kpis?.[el.item - 1] ? kpiLine(s.kpis[el.item - 1]!) : '') : (s.kpis ?? []).map(kpiLine).join('\n');
    case 'timeline': return el.item ? (s.timeline?.[el.item - 1] ? milestoneLine(s.timeline[el.item - 1]!) : '') : (s.timeline ?? []).map(milestoneLine).join('\n');
    case 'infographic': return !s.infographic ? '' : el.item ? (s.infographic.items[el.item - 1] ? itemLine(s.infographic.items[el.item - 1]!) : '') : infographicLines(s.infographic).join('\n');
    case 'image': return s.image?.alt ?? '';
    default: return slideView(s);
  }
}

/** Bullets a slide of this layout may hold (the layout engine's own limits). */
export function bulletLimit(deck: Deck, s: Slide): number {
  const max = deckTypeById(deck.type)?.maxBullets ?? 6;
  switch (s.layout) {
    case 'agenda': return 8;
    case 'chart': case 'diagram': return 4;
    case 'image-text': return Math.min(max, 5);
    case 'two-column': case 'comparison': return Math.max(3, max - 1);
    default: return max;
  }
}

/** About how many characters the slide's title takes before it no longer fits (the layout's lines at its smallest size). */
export function titleCapacity(deck: Deck, s: Slide): number {
  const theme = deckTheme(deck.theme);
  const W = deck.aspect === '4:3' ? 720 : 960;
  const CW = W - 2 * (W === 960 ? 56 : 44);
  const sample = 'the quick brown fox jumps over the lazy dog';
  const at = (size: number): number => textWidth(sample, theme.fonts.heading, size, theme.headingBold) / sample.length;
  if (s.layout === 'title' || s.layout === 'closing') return Math.floor((4 * W * 0.7 * 0.955) / at(28));
  if (s.layout === 'section') return Math.floor((3 * CW * 0.955) / at(26));
  if (s.layout === 'quote') return Math.floor((CW * 0.955) / at(10) / 1.3);
  return Math.floor((2 * CW * 0.955) / at(22));
}

/** The layout's limits for a slide, as short lines for the model (and the tool help). */
export function slideLimits(deck: Deck, index: number): string[] {
  const s = deck.slides[index]!;
  const info = layoutInfo(s.layout);
  const type = deckTypeById(deck.type);
  const cap = titleCapacity(deck, s);
  // The catalogue's hint carries generic counts ("bullets (≤6)"); the deck type's own limit is the one that holds, below.
  const out = [`layout "${s.layout}" (${info.label}): ${info.hint.replace(/\s*\(≤\s*\d+[^)]*\)/g, '')}`,
    `title: under about ${Math.round(cap / 2)} characters reads best; past about ${cap} it no longer fits`];
  if (info.fields.includes('bullets')) out.push(`bullets: at most ${bulletLimit(deck, s)}, each one line (about 12 words)`);
  if (s.layout === 'two-column' || s.layout === 'comparison') out.push(`each column: at most ${bulletLimit(deck, s)} bullets; headings a few words`);
  if (s.layout === 'table') out.push('table: at most 6 columns and 8 rows, short cells');
  if (s.layout === 'kpi') out.push('KPI tiles: 1–4; each value a short figure ("£4.2m", "38%"), each label a few words');
  if (s.layout === 'timeline') out.push('timeline: 2–6 milestones, each a short title and one line');
  if (s.layout === 'chart') out.push('chart: one value per category in every series; ≤ 8 pie slices');
  if (s.layout === 'diagram') out.push('diagram: ≤ ~15 nodes; a left-to-right chain of 7+ boxes is too wide');
  if (s.infographic) {
    const k = infographicInfo(s.infographic.kind);
    out.push(`infographic "${k.id}" (${k.hint}): ${k.min}–${k.max} items, each a short title and one line; item fields it draws: ${k.uses.join(', ')}; icons only from the deck icon set`);
  }
  if (type) out.push(`a ${type.title.toLowerCase()} slide carries about ${type.words[0]}–${type.words[1]} words`);
  const now = layoutSlide(deck, index).problems.filter(p => p.severity === 'error');
  if (now.length) out.push(`it does not fit now: ${now.slice(0, 4).map(p => p.message).join('; ')}`);
  return out;
}

/**
 * Resolve a deck target against the deck. Fails with a reason a person (or
 * the agent, through `edit_part`) can act on.
 */
export function resolveDeckTarget(deck: Deck, target: DeckTarget): Resolve {
  const index = deck.slides.findIndex(s => s.id === target.slideId);
  if (index < 0) return { ok: false, error: target.slideId ? `slide ${target.slideId} is no longer in the deck — select it again` : 'no slide named' };
  const s = deck.slides[index]!;
  const el = parseElement(target.elementId);
  if (!el) return { ok: false, error: `"${target.elementId}" is not a slide element (${ELEMENT_IDS})` };
  const elementId = `${el.field}${el.item ? `.${el.item}` : ''}`;
  if (isPending(s) && !['title', 'notes'].includes(el.field)) return { ok: false, error: `slide ${index + 1} is still a plan — ask AICO in the chat to write it first; its title and notes can be edited here` };
  const n = index + 1;
  const where = `Slide ${n} · ${layoutInfo(s.layout).label}`;
  const make = (p: Omit<DeckPart, 'span' | 'before' | 'blocks' | 'blockKinds' | 'where' | 'slideId' | 'elementId' | 'field' | 'index' | 'fixedKind'>): Resolve => {
    const before = elementView(s, elementId);
    const part: DeckPart = {
      ...p, span: { start: 0, end: before.length }, before, blocks: { from: index, to: index + 1 }, blockKinds: [], where,
      slideId: s.id, elementId, field: el.field, ...(el.item ? { item: el.item } : {}), index, fixedKind: true,
    };
    if (target.range) {
      if (part.kind !== 'text' || (el.field === 'bullets' && !el.item)) return { ok: false, error: `a text range cannot be edited inside ${part.what === 'slide' ? 'a whole slide' : `the ${part.what}`} — target the element` };
      const { start, end } = target.range;
      if (!(Number.isInteger(start) && Number.isInteger(end)) || start < 0 || end > part.editable.length || end <= start) return { ok: false, error: 'the selected range is not inside that text' };
      if (/\n[ \t]*\n/.test(part.editable.slice(start, end))) return { ok: false, error: 'the selection crosses a paragraph break — target the whole element' };
      if (!(start === 0 && end === part.editable.length)) {
        part.selection = { start, end };
        part.label = `Selection in ${part.label.toLowerCase()}`;
      }
    }
    if (target.cells && part.kind !== 'cells') return { ok: false, error: 'cells can only be given for a table' };
    part.describe = describeDeckPart(deck, part);
    return { ok: true, part };
  };
  const missing = (what: string): Resolve => ({ ok: false, error: `slide ${n} has no ${what}` });

  if ((TEXT_FIELDS as readonly string[]).includes(el.field)) {
    const f = el.field as TextField;
    const value = s[f] as string | undefined;
    const name = f === 'body' ? bodyName(s) : TEXT_NAMES[f];
    if (!value?.trim() && f !== 'notes') {
      if (!layoutInfo(s.layout).fields.includes(f)) return { ok: false, error: `a ${layoutInfo(s.layout).label.toLowerCase()} slide has no ${name.what}` };
      return missing(name.what);
    }
    return make({ kind: 'text', label: name.label, what: name.what, editable: value ?? '' });
  }
  switch (el.field) {
    case 'bullets': {
      if (!s.bullets?.length) return missing('bullets');
      const noun = s.layout === 'agenda' ? 'agenda item' : s.layout === 'chart' || s.layout === 'diagram' ? 'takeaway' : 'bullet';
      if (el.item) {
        const b = s.bullets[el.item - 1];
        if (!b) return { ok: false, error: `slide ${n} has ${s.bullets.length} ${noun}s, not ${el.item}` };
        return make({ kind: 'text', label: `${noun.charAt(0).toUpperCase()}${noun.slice(1)} ${el.item}`, what: noun, editable: b.text });
      }
      return make({ kind: 'text', label: `${s.layout === 'agenda' ? 'Agenda items' : noun === 'takeaway' ? 'Takeaways' : 'Bullets'} · ${s.bullets.length}`, what: 'bulleted list', editable: bulletsMarkdown(s.bullets) });
    }
    case 'left': case 'right': {
      const c = s[el.field];
      if (!c) return missing(`${el.field} column`);
      const label = `${el.field === 'left' ? 'Left' : 'Right'} ${s.layout === 'comparison' ? 'card' : 'column'}`;
      return make({ kind: 'json', label, what: label.toLowerCase(), editable: JSON.stringify(columnJson(c), null, 2) });
    }
    case 'table': {
      if (!s.table?.header.length) return missing('table');
      const t = tableModel(s.table);
      if (target.cells) {
        const nc = t.header.length;
        const c: CellRange = { r0: Math.max(-1, target.cells.r0), r1: Math.min(target.cells.r1, t.rows.length - 1), c0: Math.max(0, target.cells.c0), c1: Math.min(nc - 1, target.cells.c1) };
        if (c.r0 > c.r1 || c.c0 > c.c1) return { ok: false, error: 'that cell range is outside the table' };
        const whole = c.r0 <= 0 && c.r1 === t.rows.length - 1 && c.c0 === 0 && c.c1 === nc - 1;
        if (!whole) return make({ kind: 'cells', label: `Table · ${cellsLabel(c, t)}`, what: 'table cells', editable: tableToMarkdown(t), table: t, cells: c });
      }
      return make({ kind: 'table', label: `Table · ${t.rows.length} rows × ${t.header.length} columns`, what: 'table', editable: tableToMarkdown(t), table: t });
    }
    case 'chart': {
      if (!s.chart) return missing('chart');
      if (s.chart.echarts) return make({ kind: 'chart', label: 'Chart', what: 'chart', editable: JSON.stringify(s.chart.echarts), chart: s.chart.echarts });
      return make({ kind: 'json', label: `Chart · ${s.chart.type}`, what: `${s.chart.type} chart`, editable: JSON.stringify(chartJson(s), null, 2) });
    }
    case 'diagram': {
      if (!s.diagram?.trim()) return missing('diagram');
      const k = mermaidKind(s.diagram);
      return make({ kind: 'mermaid', label: `Diagram · ${k ?? 'mermaid'}`, what: `${k ?? 'mermaid'} diagram`, editable: s.diagram });
    }
    case 'kpis': {
      if (!s.kpis?.length) return missing('KPI tiles');
      if (el.item) {
        const k = s.kpis[el.item - 1];
        if (!k) return { ok: false, error: `slide ${n} has ${s.kpis.length} KPI tiles, not ${el.item}` };
        return make({ kind: 'json', label: `KPI ${el.item}`, what: 'KPI tile', editable: JSON.stringify(k, null, 2) });
      }
      return make({ kind: 'json', label: `KPI tiles · ${s.kpis.length}`, what: 'KPI tiles', editable: JSON.stringify({ kpis: s.kpis }, null, 2) });
    }
    case 'timeline': {
      if (!s.timeline?.length) return missing('timeline');
      if (el.item) {
        const m = s.timeline[el.item - 1];
        if (!m) return { ok: false, error: `slide ${n} has ${s.timeline.length} milestones, not ${el.item}` };
        return make({ kind: 'json', label: `Milestone ${el.item}`, what: 'milestone', editable: JSON.stringify(m, null, 2) });
      }
      return make({ kind: 'json', label: `Timeline · ${s.timeline.length}`, what: 'timeline', editable: JSON.stringify({ items: s.timeline }, null, 2) });
    }
    case 'infographic': {
      const ig = s.infographic;
      if (!ig?.items.length) return missing('infographic');
      const label = infographicInfo(ig.kind).label;
      if (el.item) {
        const it = ig.items[el.item - 1];
        if (!it) return { ok: false, error: `slide ${n}'s infographic has ${ig.items.length} items, not ${el.item}` };
        return make({ kind: 'json', label: `${label} · item ${el.item}`, what: 'infographic item', editable: JSON.stringify(itemJson(it), null, 2) });
      }
      return make({ kind: 'json', label: `Infographic · ${label}`, what: 'infographic', editable: JSON.stringify(infographicJson(ig), null, 2) });
    }
    case 'image':
      if (!s.image) return missing('picture');
      return make({ kind: 'text', label: 'Image caption', what: 'image caption', editable: s.image.alt ?? '' });
    default:
      return make({ kind: 'json', label: `Slide ${n} · ${layoutInfo(s.layout).label}`, what: 'slide', editable: JSON.stringify(slideJson(s), null, 2) });
  }
}

function cellsLabel(r: CellRange, t: TableModel): string {
  const allCols = r.c0 === 0 && r.c1 === t.header.length - 1;
  const allRows = r.r0 <= 0 && r.r1 === t.rows.length - 1;
  const col = r.c0 === r.c1 ? `column “${t.header[r.c0] ?? r.c0 + 1}”` : `columns ${r.c0 + 1}–${r.c1 + 1}`;
  const row = r.r0 === r.r1 ? (r.r0 < 0 ? 'header row' : `row ${r.r0 + 1}`) : `rows ${r.r0 < 0 ? 'header' : r.r0 + 1}–${r.r1 + 1}`;
  if (allRows) return col;
  if (allCols) return row;
  return `${row} · ${col}`;
}

/** How the part is put to the model: what it is, its JSON shape where it has one, and the slide's limits. */
function describeDeckPart(deck: Deck, part: DeckPart): string {
  const s = deck.slides[part.index]!;
  const limits = slideLimits(deck, part.index).map(l => `- ${l}`).join('\n');
  const head = `Slide ${part.index + 1} of ${deck.slides.length}, layout "${s.layout}". Its limits (the result is laid out and refused if it does not fit):\n${limits}\n`;
  const plain = describeTarget({ ...part, describe: undefined });
  switch (part.field) {
    case 'slide':
      return `${head}The whole slide as JSON — "layout" and its fields (bullets are strings, "  " in front = a sub-point; "(image)" stands for its picture: keep it as is). `
        + 'Change "layout" only if the instruction asks for another kind of slide, and then fill that layout\'s fields (a layout draws only its own fields — move the content, do not leave it in fields the layout does not draw):\n'
        + part.editable;
    case 'bullets':
      return part.item ? `${head}${plain.replace(/^The bullet \(Markdown\):/, 'The bullet (one line):')}` : `${head}The bullets as a Markdown list ("  - " = a sub-point):\n${part.editable}`;
    case 'left': case 'right':
      return `${head}The ${part.what} as JSON {heading?, bullets?: [strings], body?}:\n${part.editable}`;
    case 'chart':
      return s.chart?.echarts ? `${head}${plain}` : `${head}The chart as JSON {type: column|bar|stacked|line|area|pie|doughnut, categories, series: [{name, values}], unit?}:\n${part.editable}`;
    case 'kpis':
      return `${head}The ${part.item ? 'KPI tile as JSON {value, label, delta?, trend?: up|down|flat}' : 'KPI tiles as JSON {"kpis": [{value, label, delta?, trend?}]}'}:\n${part.editable}`;
    case 'timeline':
      return `${head}The ${part.item ? 'milestone as JSON {date, title, text?}' : 'timeline as JSON {"items": [{date, title, text?}]}'}:\n${part.editable}`;
    case 'infographic': {
      const ig = s.infographic!;
      return part.item
        ? `${head}The infographic item as JSON {title, text?, value?, icon?} ("(image)" stands for its picture: keep it):\n${part.editable}`
        : `${head}The infographic as JSON {kind, items: [{title, text?, value?, icon?}], centre?, axes?}. Keep "kind" unless asked; if asked to change the style, use one of: ${compatibleKinds(ig).join(', ') || '(none fits these items)'}:\n${part.editable}`;
    }
    case 'notes':
      return part.editable.trim()
        ? `${head}${plain}`
        : `${head}The slide has no speaker notes yet. What it shows:\n${slideView({ ...s, notes: undefined })}`;
    default:
      return `${head}${plain}`;
  }
}

// ── What the instruction allows, for a deck ──────────────────────────

export interface DeckIntent extends EditIntent {
  /** The layout a whole-slide edit is asked to become ("turn the bullets into big numbers" → kpi). */
  layout: DeckLayout | null;
  /** Fewer bullets/points/items asked for. */
  fewer: boolean;
  /** Make it fit (a shorten). */
  fit: boolean;
}

const LAYOUT_WORDS: [RegExp, DeckLayout][] = [
  [/^(?:big numbers?|kpis?(?: tiles)?|key (?:figures|metrics)|stat(?:istic)?s?(?: tiles)?|headline numbers)\b/, 'kpi'],
  [/^(?:timeline|milestones|roadmap)\b/, 'timeline'],
  [/^(?:two[- ]?columns?|columns|side[- ]by[- ]side)\b/, 'two-column'],
  [/^(?:comparison|versus|cards)\b/, 'comparison'],
  [/^(?:table)\b/, 'table'],
  [/^(?:chart|graph)\b/, 'chart'],
  [/^(?:diagram|flowchart|flow)\b/, 'diagram'],
  [/^(?:quote|quotation)\b/, 'quote'],
  [/^(?:agenda)\b/, 'agenda'],
  [/^(?:section (?:header|divider)|divider)\b/, 'section'],
  [/^(?:bullets?|bullet points|list)\b/, 'bullets'],
];

/** What a thread of instructions allows on a deck part: the document reading, plus a target layout, "fewer" and "fit". */
export function deckIntentOf(instructions: readonly string[]): DeckIntent {
  const base = intentOf(instructions);
  const t = instructions.join(' \n ').toLowerCase();
  let layout: DeckLayout | null = null;
  const named = /\blayout\s*(?:to|:|=)?\s*["“]?([a-z][a-z-]+)/.exec(t);
  if (named) layout = toLayout(named[1]) ?? null;
  if (!layout) {
    // "into big numbers", "as a timeline", "to a two-column slide" — the word right after into/as/to (an article allowed).
    for (const m of t.matchAll(/\b(?:into|as|to)\s+(?:an?\s+|the\s+|some\s+|three\s+|two\s+|four\s+)?((?:[a-z]+[- ]?){1,3})/g)) {
      const words = m[1]!;
      const hit = LAYOUT_WORDS.find(([re]) => re.test(words));
      if (hit) { layout = hit[1]; break; }
    }
  }
  const fewer = /\bfewer\b|\b(?:cut|reduce|trim)\b[^.;\n]{0,20}\b(?:to|down to)\s+(?:\d|two|three|four|five)\b/.test(t);
  const fit = /\bfits?\b|\boverflow/.test(t);
  return { ...base, shorten: base.shorten || fit, remove: base.remove || fewer, convert: base.convert || Boolean(layout), layout, fewer, fit };
}

// ── Applying ─────────────────────────────────────────────────────────

function textOf(part: DeckPart, patch: PartPatch): string | null {
  if (patch.kind !== 'text') return null;
  const t = part.selection ? part.editable.slice(0, part.selection.start) + patch.text + part.editable.slice(part.selection.end) : patch.text;
  return t.replace(/\r\n?/g, '\n').trim();
}

/**
 * The slide after a patch to one of its parts: only the targeted field is
 * written (loose input normalised by the deck model, as an agent's write is).
 */
export function applyDeckPatch(deck: Deck, part: DeckPart, patch: PartPatch): { ok: true; slide: Slide } | { ok: false; error: string } {
  const s = deck.slides[part.index];
  if (!s || s.id !== part.slideId) return { ok: false, error: 'that slide moved or is gone — try again' };
  const set = (fields: Record<string, unknown>): { ok: true; slide: Slide } => ({ ok: true, slide: normalizeSlide(fields, s.id, s) });
  const want = (kind: PartPatch['kind']): { ok: false; error: string } => ({ ok: false, error: `the ${part.what} is answered as ${kind === 'text' ? '"text"' : kind === 'json' ? '"json"' : kind === 'mermaid' ? '"source"' : kind === 'chart' ? '"spec"' : '"header" and "rows"'}` });
  try {
    if ((TEXT_FIELDS as readonly string[]).includes(part.field)) {
      const t = textOf(part, patch);
      if (t === null) return want('text');
      return set({ [part.field]: t || null });
    }
    switch (part.field) {
      case 'bullets': {
        const t = textOf(part, patch);
        if (t === null) return want('text');
        if (part.item) {
          const bullets = s.bullets!.map((b, i) => (i === part.item! - 1 ? { ...b, text: t.replace(/^\s*(?:[-*•–]|\d+[.)])\s+/, '').replace(/\s*\n\s*/g, ' ') } : b));
          return set({ bullets: bullets.filter(b => b.text) });
        }
        // A list indented as a whole (found live: a translation came back with every line two spaces in) is not a list of sub-points.
        const lines = patch.kind === 'text' ? patch.text.replace(/\r\n?/g, '\n').split('\n').filter(l => l.trim()) : [];
        const common = Math.min(...lines.map(l => l.length - l.replace(/^[ \t]+/, '').length));
        return set({ bullets: lines.length ? lines.map(l => l.slice(Number.isFinite(common) ? common : 0)) : null });
      }
      case 'left': case 'right':
        if (patch.kind !== 'json') return want('json');
        return set({ [part.field]: patch.json });
      case 'table': {
        if (patch.kind === 'table') return set({ table: { header: patch.header, rows: patch.rows } });
        if (patch.kind === 'cells' && part.cells) {
          const t = s.table!;
          const header = [...t.header];
          const rows = t.rows.map(r => [...r]);
          const c = part.cells;
          patch.cells.forEach((row, i) => row.forEach((v, j) => {
            const r = c.r0 + i;
            const col = c.c0 + j;
            if (r > c.r1 || col > c.c1) return;
            if (r < 0) header[col] = v; else rows[r]![col] = v;
          }));
          return set({ table: { header, rows } });
        }
        return want(part.kind === 'cells' ? 'cells' : 'table');
      }
      case 'chart':
        if (patch.kind === 'chart') return set({ chart: patch.spec });
        if (patch.kind === 'json') return set({ chart: patch.json });
        return want('json');
      case 'diagram':
        if (patch.kind !== 'mermaid') return want('mermaid');
        return set({ diagram: patch.source });
      case 'kpis': {
        if (patch.kind !== 'json') return want('json');
        if (part.item) {
          const one = toKpis([patch.json])?.[0];
          if (!one) return { ok: false, error: 'a KPI tile needs a value and a label' };
          return set({ kpis: s.kpis!.map((k, i) => (i === part.item! - 1 ? one : k)) });
        }
        const j = patch.json as { kpis?: unknown };
        return set({ kpis: Array.isArray(patch.json) ? patch.json : j?.kpis ?? null });
      }
      case 'timeline': {
        if (patch.kind !== 'json') return want('json');
        if (part.item) {
          const one = toTimeline([patch.json])?.[0];
          if (!one) return { ok: false, error: 'a milestone needs a date or a title' };
          return set({ timeline: s.timeline!.map((m, i) => (i === part.item! - 1 ? one : m)) });
        }
        const j = patch.json as { items?: unknown; timeline?: unknown };
        return set({ timeline: Array.isArray(patch.json) ? patch.json : j?.items ?? j?.timeline ?? null });
      }
      case 'infographic': {
        if (patch.kind !== 'json' || !patch.json || typeof patch.json !== 'object') return want('json');
        const ig = s.infographic!;
        if (part.item) {
          const raw = restoreImage(patch.json, ig.items[part.item - 1]);
          const one = toInfographic({ kind: ig.kind, items: [raw] })?.items[0];
          if (!one) return { ok: false, error: 'an infographic item needs a title, text or value' };
          return set({ infographic: { ...ig, items: ig.items.map((it, i) => (i === part.item! - 1 ? one : it)) } });
        }
        const o = (Array.isArray(patch.json) ? { items: patch.json } : patch.json) as { kind?: unknown; items?: unknown };
        const items = Array.isArray(o.items) ? o.items.map((x, i) => restoreImage(x, ig.items[i])) : o.items;
        return set({ infographic: { kind: ig.kind, ...o, items } });
      }
      case 'image': {
        const t = textOf(part, patch);
        if (t === null) return want('text');
        const { alt: _alt, ...img } = s.image!;
        return set({ image: { ...img, ...(t ? { alt: t.replace(/\s+/g, ' ') } : {}) } });
      }
      default: {
        if (patch.kind !== 'json' || !patch.json || typeof patch.json !== 'object' || Array.isArray(patch.json)) return want('json');
        const o = { ...(patch.json as Record<string, unknown>) };
        delete o.id;
        delete o.intent;
        if (o.layout === undefined) o.layout = s.layout;
        // The picture is never sent to the model: "(image)" (or its absence while the layout still draws one) means the same picture.
        const img = o.image as { src?: unknown } | undefined;
        if (s.image && img && typeof img === 'object' && (img.src === '(image)' || img.src === undefined)) o.image = { ...s.image, ...img, src: s.image.src };
        const slide = normalizeSlide(o, s.id);
        if (s.transition) slide.transition = s.transition;
        return { ok: true, slide };
      }
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** A JSON with its keys sorted, so two equal slides compare equal whatever order their fields were written in. */
export function stableJson(v: unknown): string {
  return JSON.stringify(v, (_k, x: unknown) => (x && typeof x === 'object' && !Array.isArray(x)
    ? Object.fromEntries(Object.keys(x as object).sort().map(k => [k, (x as Record<string, unknown>)[k]])) : x));
}

/** A short content hash of each slide (FNV-1a over its stable JSON) — what scope is checked and reported on. */
export function slideHashes(deck: Deck): string[] {
  return deck.slides.map((s) => {
    let h = 0x811c9dc5;
    const str = stableJson(s);
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    return `${s.id}:${h.toString(36)}`;
  });
}

/** The deck with one slide replaced. */
export function withSlide(deck: Deck, index: number, slide: Slide): Deck {
  return { ...deck, slides: deck.slides.map((s, i) => (i === index ? slide : s)) };
}

// ── Validation ───────────────────────────────────────────────────────

export interface DeckVerdict extends Verdict {
  /** The slide after the edit (when it could be built). */
  slide?: Slide;
  /** Every other slide, and every other field of this one, compared and found identical. */
  scopeHeld: boolean;
  /** The slide's layout errors after the edit (empty = it fits). */
  fit: string[];
}

const problemKey = (p: Problem): string => `${p.field ?? ''}|${p.message.replace(/\d+(?:\.\d+)?/g, '#')}`;

function entries(part: DeckPart, s: Slide): number {
  switch (part.field) {
    case 'bullets': return (s.bullets ?? []).length;
    case 'kpis': return (s.kpis ?? []).length;
    case 'timeline': return (s.timeline ?? []).length;
    case 'infographic': return (s.infographic?.items ?? []).length;
    case 'left': case 'right': return (s[part.field]?.bullets ?? []).length;
    default: return 0;
  }
}

/**
 * Check a patch to a deck part: the element's own rules (through the document
 * validator where the part is text, a table, cells, an ECharts chart or a
 * diagram), the deck's (layout and type kept unless asked, list lengths, no
 * figure invented), the scope (every other slide and every other field of
 * this slide identical), and the layout fit check. `after` is the element's
 * readable form; `slide` the slide it builds.
 */
export function validateDeckPatch(deck: Deck, part: DeckPart, patch: PartPatch, instructions: readonly string[]): DeckVerdict {
  const errors: string[] = [];
  const warnings: string[] = [];
  const intent = deckIntentOf(instructions);
  const old = deck.slides[part.index]!;
  const fail = (): DeckVerdict => ({ ok: false, errors, warnings, after: part.before, unchanged: false, scopeHeld: false, fit: [] });

  if (patch.kind === 'blocks') {
    errors.push(`answer with the ${part.what}'s own shape (${part.kind === 'text' ? '"text"' : part.kind === 'json' ? '"json"' : part.kind === 'mermaid' ? '"source"' : part.kind === 'chart' ? '"spec"' : '"header" and "rows"'}), not "markdown" — a slide element keeps its kind${part.field !== 'slide' ? '; to change the kind of slide, edit the whole slide' : ''}`);
    return fail();
  }
  const built = applyDeckPatch(deck, part, patch);
  if (!built.ok) { errors.push(built.error); return fail(); }
  const slide = built.slide;
  const after = elementView(slide, part.elementId);

  // ── The element's own rules ──
  if (['text', 'table', 'cells', 'mermaid', 'chart'].includes(part.kind) && part.field !== 'notes') {
    const v = validatePatch(part, patch, instructions);
    errors.push(...v.errors);
    warnings.push(...v.warnings);
  } else if (part.field === 'notes') {
    const before = part.selection ? part.editable.slice(part.selection.start, part.selection.end) : part.editable;
    const now = patch.kind === 'text' ? patch.text : '';
    const f = checkTextFacts(before, now, { ...intent, add: true }, { inline: true });
    errors.push(...f.errors);
    warnings.push(...f.warnings);
    // Notes say what the slide shows: a figure that is on no slide nearby is invented.
    const known = new Set(numbersIn([part.editable, slideView({ ...old, notes: undefined }), ...deck.slides.slice(Math.max(0, part.index - 1), part.index + 2).map(x => slideView(x))].join('\n')));
    const invented = [...new Set(numbersIn(now))].filter(x => !known.has(x));
    if (invented.length && !intent.data) errors.push(`the notes give figures that are not on the slide (${invented.slice(0, 6).join(', ')}) — never invent figures; use [To confirm] where one is needed`);
    if (!now.trim() && !intent.remove) errors.push('the notes are empty');
  } else {
    // JSON parts: the structured fields, checked as the words and figures they show. Only a whole slide changes
    // shape (the document reader calls "change the chart type to a line chart" a conversion; on a deck it is not one).
    const f = checkTextFacts(part.before, after, { ...intent, convert: part.field === 'slide' && slide.layout !== old.layout });
    errors.push(...f.errors);
    warnings.push(...f.warnings);
  }

  // ── The deck's rules ──
  if (ONE_LINE.has(part.field === 'bullets' && part.item ? 'bullet' : part.field) && patch.kind === 'text' && /\n/.test(patch.text.trim())) {
    errors.push(`the ${part.what} is one line — no line breaks`);
  }
  const n0 = entries(part, old);
  const n1 = entries(part, slide);
  if (!part.item && ['bullets', 'kpis', 'timeline', 'infographic', 'left', 'right'].includes(part.field)) {
    const noun = part.field === 'kpis' ? 'KPI tiles' : part.field === 'timeline' ? 'milestones' : part.field === 'infographic' ? 'infographic items' : 'bullets';
    if (intent.fewer && n1 >= n0) errors.push(`asked for fewer ${noun}, but there are still ${n1}`);
    else if (n1 > n0 && !intent.add && !intent.expand && !intent.convert) errors.push(`${noun} were added (${n0} → ${n1}) — keep the same ones unless asked to add`);
    else if (n1 < n0 && !intent.remove && !intent.shorten && !intent.convert) errors.push(`${noun} were dropped (${n0} → ${n1}) — keep every one unless asked to cut`);
  }
  if (part.field === 'bullets' && !part.item && n0 === n1 && !intent.convert && !/\b(sub-?points?|indent|nest|levels?|outdent|promote|demote)\b/i.test(instructions.join(' '))) {
    const lv = (x: Slide): string => (x.bullets ?? []).map(b => b.level ?? 0).join();
    if (lv(old) !== lv(slide)) errors.push('which bullets are sub-points changed — keep each bullet at its level ("  - " only where the original had it)');
  }
  if (part.field === 'chart' && old.chart && slide.chart && !old.chart.echarts) {
    const a = old.chart;
    const b = slide.chart;
    if (b.echarts) errors.push('the chart must stay {type, categories, series} — not an ECharts option');
    else {
      if (a.type !== b.type && !intent.chartType) errors.push(`the chart type changed (${a.type} → ${b.type}) — keep it unless asked`);
      const lost = a.categories.filter(c => !b.categories.includes(c));
      if (lost.length && !intent.remove && !intent.rename && !intent.translate && !intent.data) errors.push(`categories were dropped or renamed (${lost.slice(0, 6).join(', ')})`);
      if (b.series.length !== a.series.length && !intent.add && !intent.remove && !intent.data) errors.push(`the chart had ${a.series.length} series and now has ${b.series.length} — keep them unless asked`);
    }
  }
  if (part.field === 'infographic' && old.infographic && slide.infographic) {
    const a = old.infographic;
    const b = slide.infographic;
    if (a.kind !== b.kind) {
      const asked = intent.convert || /\b(style|kind|type|look)\b/i.test(instructions.join(' ')) || INFOGRAPHICS.some(k => new RegExp(`\\b${k.id.replace('-', '[- ]?')}\\b`, 'i').test(instructions.join(' ')));
      if (!asked || part.item) errors.push(`the infographic kind changed (${a.kind} → ${b.kind}) — keep it unless asked`);
      else if (!compatibleKinds(a).includes(b.kind)) errors.push(`a ${infographicInfo(b.kind).label.toLowerCase()} cannot draw these items — use one of: ${compatibleKinds(a).join(', ') || 'none (keep the kind)'}`);
    }
    if (!part.item && (b.items.length < 2 || b.items.length > 8)) errors.push(`an infographic has 2–8 items, not ${b.items.length}`);
    const bad = b.items.map(it => it.icon).filter((x): x is string => Boolean(x) && !isDeckIcon(x));
    if (bad.length) errors.push(`icon${bad.length === 1 ? '' : 's'} not in the icon set: ${[...new Set(bad)].join(', ')} — use an icon the set has, or none`);
  }
  if (part.field === 'diagram' && slide.diagram) errors.push(...checkMermaid(slide.diagram).filter(e => !errors.includes(e)));
  if (part.field === 'slide') {
    if (slide.layout !== old.layout) {
      if (!intent.layout) errors.push(`the layout changed (${old.layout} → ${slide.layout}) — keep it unless the instruction asks for another kind of slide`);
      else if (slide.layout !== intent.layout) errors.push(`asked for a ${layoutInfo(intent.layout).label.toLowerCase()} slide ("${intent.layout}"), but the answer is "${slide.layout}"`);
      // A new shape, the same facts: every figure on the slide survives the conversion.
      const gone = intent.remove || intent.shorten || intent.data ? [] : [...new Set(numbersIn(slideView(old)))].filter(x => !numbersIn(slideView(slide)).includes(x));
      if (gone.length) errors.push(`figures were lost in the conversion (${gone.slice(0, 6).join(', ')}) — carry every number over`);
      const drawn = layoutInfo(slide.layout).fields;
      const stranded = (['bullets', 'left', 'right', 'chart', 'diagram', 'table', 'kpis', 'quote', 'timeline', 'infographic'] as const).filter(k => slide[k] !== undefined && !drawn.includes(k));
      if (stranded.length) errors.push(`a ${slide.layout} slide does not draw ${stranded.join(', ')} — move that content into the layout's own fields (${drawn.join(', ')})`);
    } else {
      if (intent.layout && intent.layout !== old.layout) errors.push(`asked for a ${layoutInfo(intent.layout).label.toLowerCase()} slide, but the layout is still "${old.layout}" — set "layout": "${intent.layout}"`);
      const lost = (Object.keys(slideJson(old)) as (keyof Slide)[]).filter(k => k !== 'layout' && slide[k] === undefined);
      if (lost.length && !intent.remove) errors.push(`fields were removed (${lost.join(', ')}) — keep every part of the slide unless asked`);
    }
    if (old.notes && !slide.notes && !intent.remove) errors.push('the speaker notes were dropped — keep them');
  }

  // ── Scope: nothing else on the slide, and no other slide, changed ──
  const nextDeck = withSlide(deck, part.index, slide);
  let scopeHeld = slideHashes(deck).every((h, i) => i === part.index || h === slideHashes(nextDeck)[i]);
  if (part.field !== 'slide') {
    const rest = (x: Slide): string => { const { [part.field as keyof Slide]: _f, intent: _i, ...o } = x; return stableJson(o); };
    if (rest(old) !== rest(slide)) {
      scopeHeld = false;
      errors.push(`the edit changed more of the slide than the ${part.what}`);
    }
    if (part.item) {
      // A bullet/tile/milestone edit leaves its siblings as they were.
      const arr = (x: Slide): unknown[] => (part.field === 'bullets' ? x.bullets ?? [] : part.field === 'kpis' ? x.kpis ?? [] : part.field === 'infographic' ? x.infographic?.items ?? [] : x.timeline ?? []);
      const a = arr(old);
      const b = arr(slide);
      if (a.length !== b.length || a.some((v, i) => i !== part.item! - 1 && stableJson(v) !== stableJson(b[i]))) {
        scopeHeld = false;
        errors.push(`the edit changed other ${part.field === 'kpis' ? 'tiles' : part.field === 'timeline' ? 'milestones' : part.field === 'infographic' ? 'items' : 'bullets'} than number ${part.item}`);
      }
    }
  }

  // ── The fit check ──
  const was = layoutSlide(deck, part.index).problems;
  const now = layoutSlide(nextDeck, part.index).problems;
  const touched = (p: Problem): boolean => part.field === 'slide' || !p.field || p.field === part.field || (part.field === 'body' && p.field === 'bullets');
  const fit: string[] = [];
  for (const p of now) {
    if (p.severity !== 'error') {
      if (!was.some(q => problemKey(q) === problemKey(p)) && touched(p)) warnings.push(p.message);
      continue;
    }
    fit.push(p.message);
    const isNew = !was.some(q => problemKey(q) === problemKey(p));
    if (isNew) errors.push(`the slide no longer fits its layout: ${p.message}`);
    else if (touched(p) && (intent.shorten || intent.fit || intent.fewer)) errors.push(`it still does not fit: ${p.message}`);
    else if (touched(p)) warnings.push(`still does not fit: ${p.message}`);
  }

  const unchanged = stableJson(slide) === stableJson(old);
  return { ok: errors.length === 0, errors: [...new Set(errors)], warnings: [...new Set(warnings)], after, unchanged, slide, scopeHeld, fit };
}

// ── Context for the model ────────────────────────────────────────────

/** Bounds: the context is sized by these, never by the deck. */
export const DECK_CONTEXT_LIMITS = { outline: 40, titleChars: 90, neighbours: 2, neighbourChars: 320 } as const;

function clip(s: string, n: number): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

/**
 * What the model sees besides the part: the deck's type and theme, the target
 * slide's layout and limits, the deck's outline (slide titles, the target
 * marked) and its neighbours — bounded and deterministic.
 */
export function buildDeckEditContext(deck: Deck, part: Pick<DeckPart, 'index' | 'where'>, doc: { title: string }): EditContext {
  const L = DECK_CONTEXT_LIMITS;
  const type = deckTypeById(deck.type);
  const theme = deckTheme(deck.theme);
  const s = deck.slides[part.index]!;
  const all = deck.slides.map(x => slideView(x)).join('\n');
  const from = Math.max(0, Math.min(part.index - Math.floor(L.outline / 2), deck.slides.length - L.outline));
  const outline = deck.slides.slice(from, from + L.outline).map((x, k) => {
    const i = from + k;
    return `${i === part.index ? '→ ' : '  '}${i + 1}. [${x.layout}] ${clip(plainOf(x.title ?? '') || (isPending(x) ? `(planned) ${x.intent ?? ''}` : '(no title)'), L.titleChars)}`;
  });
  const near = (i: number): string => {
    const x = deck.slides[i]!;
    return `Slide ${i + 1} [${x.layout}]: ${clip(slideText(x) || (x.intent ?? ''), L.neighbourChars)}`;
  };
  const idx = (a: number, b: number): number[] => Array.from({ length: Math.max(0, b - a) }, (_, k) => a + k);
  return {
    title: doc.title,
    docType: type ? `Presentation — ${type.title}: ${type.description}` : 'Presentation (slides)',
    typeNote: `${type ? `${type.brief} ` : ''}Theme "${theme.name}" (${deck.aspect}). The part is on slide ${part.index + 1} of ${deck.slides.length}, a "${layoutInfo(s.layout).label}" slide. `
      + 'Slide text is short: titles say what the slide shows, bullets are one line each, detail goes in the speaker notes.',
    where: part.where,
    style: styleRules(all),
    outline,
    terms: definedTerms(all),
    before: idx(Math.max(0, part.index - L.neighbours), part.index).map(near),
    after: idx(part.index + 1, Math.min(deck.slides.length, part.index + 1 + L.neighbours)).map(near),
  };
}

// ── Quick actions ────────────────────────────────────────────────────

const A = {
  fit: { id: 'fit', label: 'Shorten to fit', instruction: 'Shorten the text so it fits the slide\'s layout — keep every fact and figure.' },
  title: { id: 'title', label: 'Punchier title', instruction: 'Rewrite the slide title as a short, punchy claim that says what the slide shows — keep its figures.' },
  fewer: { id: 'fewer', label: 'Fewer bullets', instruction: 'Cut it to fewer bullets: keep the strongest points, merge or drop the rest.' },
  kpi: { id: 'kpi', label: 'Bullets → big numbers', instruction: 'Turn the bullets into big numbers (layout kpi): 2–4 tiles, each a short figure from the bullets with a label — keep every figure.' },
  timeline: { id: 'timeline', label: 'Bullets → timeline', instruction: 'Turn the bullets into a timeline (layout timeline): one milestone per point with its date, [To confirm] where it has none — keep every date and figure.' },
  columns: { id: 'columns', label: 'Bullets → two columns', instruction: 'Turn the bullets into two columns (layout two-column): split the points into two groups with short headings — keep every point.' },
  chartType: { id: 'chart-type', label: 'Change chart type…', instruction: 'Change the chart type to a ', ask: true },
  simplify: { id: 'simplify', label: 'Simplify diagram', instruction: 'Simplify the diagram: fewer crossing edges and shorter labels — keep its meaning.' },
  notes: { id: 'notes', label: 'Write speaker notes', instruction: 'Write speaker notes for this slide: what to say, 60–120 words, from the slide\'s own content — no new facts or figures.' },
  translate: { id: 'translate', label: 'Translate…', instruction: 'Translate it into ', ask: true },
  grammar: { id: 'grammar', label: 'Fix grammar', instruction: 'Fix spelling, grammar and punctuation only. Change nothing else.' },
  shorten: { id: 'shorten', label: 'Shorten', instruction: 'Shorten it — keep every fact and figure.' },
} satisfies Record<string, PartAction>;

const onTitle = (a: PartAction): PartAction => ({ ...a, target: { elementId: 'title', label: 'Title' } });
const onNotes = (a: PartAction): PartAction => ({ ...a, target: { elementId: 'notes', label: 'Speaker notes' } });
const onDiagram = (a: PartAction): PartAction => ({ ...a, target: { elementId: 'diagram', label: 'Diagram' } });
const onChart = (a: PartAction): PartAction => ({ ...a, target: { elementId: 'chart', label: 'Chart' } });
const onBullets = (a: PartAction): PartAction => ({ ...a, target: { elementId: 'bullets', label: 'Bullets' } });
const onInfographic = (a: PartAction): PartAction => ({ ...a, target: { elementId: 'infographic', label: 'Infographic' } });
const infoStyle = (ig: DeckInfographic): PartAction => ({
  id: 'info-style', label: 'Change infographic style',
  instruction: `Change the infographic style to another kind that suits these items (one of: ${compatibleKinds(ig).join(', ')}) — keep every item.`,
});
const addStep: PartAction = { id: 'add-step', label: 'Add a step', instruction: 'Add one more step (item) that follows from the others, in the same style — [To confirm] for anything the slide does not say.' };

/** Quick actions for a deck part. A slide's "Punchier title" or "Write speaker notes" runs on that element (`target`). */
export function deckActions(deck: Deck, part: Pick<DeckPart, 'kind' | 'field' | 'item' | 'index' | 'selection' | 'editable'>): PartAction[] {
  const s = deck.slides[part.index];
  if (!s) return [];
  const listy = ['bullets', 'agenda', 'image-text'].includes(s.layout) && (s.bullets?.length ?? 0) > 1;
  if (part.selection) return [A.grammar, A.shorten, A.translate];
  switch (part.field) {
    case 'slide': return [
      A.fit,
      ...(s.title ? [onTitle(A.title)] : []),
      ...((s.bullets?.length ?? 0) > 2 ? [onBullets(A.fewer)] : []),
      ...(listy ? [A.kpi, A.timeline, A.columns] : []),
      ...(s.chart && !s.chart.echarts ? [onChart(A.chartType)] : []),
      ...(s.diagram ? [onDiagram(A.simplify)] : []),
      ...(s.infographic?.items.length ? [
        ...(compatibleKinds(s.infographic).length ? [onInfographic(infoStyle(s.infographic))] : []),
        ...(s.infographic.items.length < Math.min(8, infographicInfo(s.infographic.kind).max) ? [onInfographic(addStep)] : []),
      ] : []),
      onNotes(A.notes),
      A.translate,
    ];
    case 'title': return [{ ...A.title, label: 'Punchier' }, A.fit, A.grammar, A.translate];
    case 'bullets': return part.item
      ? [A.shorten, { id: 'punchier', label: 'Punchier', instruction: 'Make this bullet punchier — one short line, same facts and figures.' }, A.grammar, A.translate]
      : [A.fit, ...((s.bullets?.length ?? 0) > 2 ? [A.fewer] : []), A.grammar, A.translate];
    case 'notes': return part.editable.trim()
      ? [A.shorten, { id: 'expand', label: 'Expand', instruction: 'Expand the notes with what to say about each point on the slide — no new facts or figures.' }, A.grammar, A.translate]
      : [A.notes];
    case 'table': return [
      { id: 'grammar', label: 'Fix grammar', instruction: 'Fix spelling, grammar and punctuation in the cells only. Change nothing else.' },
      { id: 'shorten', label: 'Shorten cells', instruction: 'Shorten the text in the cells so the table fits — keep every figure.' },
      { id: 'sort', label: 'Sort…', instruction: 'Sort the rows by ', ask: true },
      A.translate,
    ];
    case 'chart': return s.chart?.echarts ? [A.translate] : [
      { id: 'line', label: 'Line chart', instruction: 'Change the chart type to a line chart.' },
      { id: 'bar', label: 'Bar chart', instruction: 'Change the chart type to a bar chart.' },
      { id: 'pie', label: 'Pie chart', instruction: 'Change the chart type to a pie chart.' },
      A.chartType,
    ];
    case 'diagram': return [
      A.simplify,
      { id: 'direction', label: 'Top to bottom', instruction: 'Lay it out top to bottom (flowchart TD) so it fits the slide.' },
      { id: 'fix', label: 'Fix syntax', instruction: 'Fix any Mermaid syntax problems; change nothing else.' },
    ];
    case 'kpis': case 'timeline': return [A.fit, A.grammar, A.translate];
    case 'infographic': {
      if (part.item) return [A.shorten, { id: 'punchier', label: 'Punchier', instruction: 'Make this item punchier — a short title and one line, same facts and figures.' }, A.grammar, A.translate];
      const ig = s.infographic;
      return [
        ...(ig && compatibleKinds(ig).length ? [infoStyle(ig)] : []),
        ...(ig && ig.items.length < Math.min(8, infographicInfo(ig.kind).max) ? [addStep] : []),
        A.fit, A.grammar, A.translate,
      ];
    }
    case 'left': case 'right': return [A.fit, A.grammar, A.translate];
    default: return [A.shorten, A.grammar, A.translate];
  }
}

// ── From what the person points at ───────────────────────────────────

/**
 * The element a click or hover on the slide names: the frame's field, made
 * precise by the frame's name ("Value 2" → KPI 2, "Milestone 3" → milestone
 * 3, "Item 4" → agenda item 4) or by which paragraph of a bullet list it was.
 */
export function elementAt(slide: Slide, field: string, frame?: string, para?: number): string {
  const n = /(\d+)$/.exec(frame ?? '')?.[1];
  if (field === 'kpis') return n && slide.kpis && Number(n) <= slide.kpis.length ? `kpis.${n}` : 'kpis';
  if (field === 'infographic') {
    // "Step title 3", "Badge 2", "Segment 4"… name their item; "Icon <name>" frames name an icon, not an item.
    return n && !/^Icon (?!disc)/.test(frame ?? '') && slide.infographic && Number(n) <= slide.infographic.items.length ? `infographic.${n}` : 'infographic';
  }
  if (field === 'timeline') return n && slide.timeline && Number(n) <= slide.timeline.length ? `timeline.${n}` : 'timeline';
  if (field === 'bullets') {
    if (/^(Item|Takeaway) \d+$/.test(frame ?? '') && n) return `bullets.${n}`;
    if (para !== undefined && slide.bullets?.length) {
      // The "Content" frame is [lead line?, ...bullets]; "Takeaways" is bullets only.
      const k = para - (frame === 'Content' && slide.body?.trim() ? 1 : 0);
      if (k < 0) return 'body';
      if (k < slide.bullets.length) return `bullets.${k + 1}`;
    }
    return 'bullets';
  }
  if (field === 'left' || field === 'right') return field;
  return parseElement(field) ? field : 'slide';
}

/** The ways to scope an edit that starts at an element: the element, its list, the whole slide. */
export function deckScopes(slide: Slide, elementId: string, cell?: { r: number; c: number }): Array<{ label: string; target: DeckTarget }> {
  const el = parseElement(elementId);
  const t = (id: string, extra: Partial<DeckTarget> = {}): DeckTarget => ({ slideId: slide.id, elementId: id, ...extra });
  const whole = { label: 'Whole slide', target: t('slide') };
  if (!el || el.field === 'slide') return [whole];
  const list = el.field === 'bullets' ? 'All bullets' : el.field === 'kpis' ? 'All tiles' : el.field === 'infographic' ? 'Whole infographic' : 'Whole timeline';
  const one = el.field === 'bullets' ? 'This bullet' : el.field === 'kpis' ? 'This tile' : el.field === 'infographic' ? 'This step' : 'This milestone';
  if (el.item) return [{ label: one, target: t(elementId) }, { label: list, target: t(el.field) }, whole];
  if (el.field === 'table' && cell && slide.table) {
    const last = slide.table.rows.length - 1;
    const nc = slide.table.header.length - 1;
    return [
      ...(cell.r >= 0 ? [{ label: 'This cell', target: t('table', { cells: { r0: cell.r, r1: cell.r, c0: cell.c, c1: cell.c } }) }] : []),
      ...(cell.r >= 0 ? [{ label: 'Row', target: t('table', { cells: { r0: cell.r, r1: cell.r, c0: 0, c1: nc } }) }] : []),
      { label: 'Column', target: t('table', { cells: { r0: 0, r1: last, c0: cell.c, c1: cell.c } }) },
      { label: 'Whole table', target: t('table') },
      whole,
    ];
  }
  const name = (TEXT_FIELDS as readonly string[]).includes(el.field) ? (el.field === 'body' ? bodyName(slide).label : TEXT_NAMES[el.field as TextField].label)
    : ({ bullets: 'Bullets', kpis: 'KPI tiles', timeline: 'Timeline', infographic: 'Infographic', left: 'Left column', right: 'Right column', table: 'Table', chart: 'Chart', diagram: 'Diagram', image: 'Caption' } as Record<string, string>)[el.field] ?? 'This';
  return el.field === 'notes' ? [{ label: name, target: t('notes') }] : [{ label: name, target: t(el.field) }, whole];
}

/**
 * Text the person selected — in an inspector field (a textarea's offsets) or
 * on the slide (its rendered words) — as a target: the element, and the range
 * inside it when the selection is part of it. Null when it cannot be placed
 * (the caller targets the element).
 */
export function selectionTarget(slide: Slide, field: string, sel: { text?: string; value?: string; start?: number; end?: number }): DeckTarget | null {
  const T = (elementId: string, range?: { start: number; end: number }, len?: number): DeckTarget => ({
    slideId: slide.id, elementId, ...(range && !(range.start === 0 && range.end === len) ? { range } : {}),
  });
  if ((TEXT_FIELDS as readonly string[]).includes(field)) {
    const src = (slide[field as TextField] as string | undefined) ?? '';
    if (!src) return null;
    if (sel.start !== undefined && sel.end !== undefined && sel.value !== undefined) {
      if (sel.value !== src || sel.end <= sel.start) return null;
      return T(field, { start: sel.start, end: sel.end }, src.length);
    }
    const r = sel.text ? locateSelection(src, sel.text) : null;
    return r ? T(field, r, src.length) : null;
  }
  if (field === 'bullets' && slide.bullets?.length) {
    if (sel.start !== undefined && sel.end !== undefined && sel.value !== undefined) {
      // The inspector's bullets box: one line per bullet, "  " in front of a sub-point.
      const lines = sel.value.split('\n');
      if (lines.length !== slide.bullets.length) return null;
      let at = 0;
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        const end = at + line.length;
        if (sel.start >= at && sel.end <= end) {
          const indent = line.length - line.trimStart().length;
          const text = slide.bullets[i]!.text;
          const s0 = Math.max(0, sel.start - at - indent);
          const e0 = Math.min(text.length, sel.end - at - indent);
          if (line.trim() !== text || e0 <= s0) return null;
          return T(`bullets.${i + 1}`, { start: s0, end: e0 }, text.length);
        }
        at = end + 1;
      }
      return null;
    }
    if (!sel.text) return null;
    const hits = slide.bullets.map((b, i) => ({ i, r: locateSelection(b.text, sel.text!) })).filter(h => h.r);
    if (hits.length !== 1) return null;
    return T(`bullets.${hits[0]!.i + 1}`, hits[0]!.r!, slide.bullets[hits[0]!.i]!.text.length);
  }
  return null;
}
