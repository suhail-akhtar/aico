/**
 * The `Canvas` tool's deck actions — how the agent builds and changes an
 * AICO Slides presentation without ever sending the deck's JSON.
 *
 * ## Plan, then fill, then fix what the layout engine reports
 *
 * `create {kind: "deck", template}` lays the deck type's storyline down as
 * planned slides (layout, title, intent), so the person sees the skeleton at
 * once — the same "outline first" rhythm as documents. `set_slides` then
 * fills or changes slides by id, sending only the fields that change; new
 * slides are added, `remove` and `order` restructure. Each write is
 * version-checked like every canvas write (a person editing slide 4 meanwhile
 * makes it a refusal carrying the current deck, not an overwrite).
 *
 * Every write returns the layout engine's verdict on the deck: text that
 * does not fit even at the smallest allowed size, too many bullets for the
 * deck type, a slide without a title, a chart without data, a table too big
 * to read. That is the enforcement (ADR 0023, principle 6): the model is not
 * asked to keep slides short — it is shown, slide by slide, where they are
 * not, and the result tells it to fix every `FIX` line.
 *
 * `read` returns a compact outline (one line per slide plus its content in
 * the notation `set_slides` takes), not the JSON.
 *
 * @module canvas/deck-tool
 */

import {
  INFOGRAPHICS, LAYOUTS, MAX_SLIDES, applyDeckOp, deckFrom, isPending, nextSlideId, normalizeSlide, parseDeck, plainOf, serializeDeck, toInfographicKind, toLayout,
  type Deck, type DeckAspect, type Slide,
} from '../../shared/ui/canvas/deck-model.js';
import { importDeckImages } from './deck-media.js';
import { problemLines, validateDeck } from '../../shared/ui/canvas/deck-layout.js';
import { DECK_THEMES, deckTheme, isDeckTheme } from '../../shared/ui/canvas/deck-themes.js';
import { DECK_TYPES, deckTypeById, pickDeckType, type DeckType } from '../../shared/ui/canvas/deck-types.js';
import { createCanvas, writeCanvas, type CanvasContext, type CanvasDoc } from './store.js';

export interface DeckInput {
  id?: string;
  title?: string;
  version?: number;
  template?: string;
  theme?: string;
  aspect?: string;
  footer?: string;
  slides?: unknown[];
  remove?: string[];
  order?: string[];
  note?: string;
  // ADR 0025: the design brief, brand colours per theme slot, measured fonts.
  brief?: Record<string, unknown>;
  palette?: Record<string, unknown>;
  fonts?: Record<string, unknown>;
}

export function deckOfDoc(doc: CanvasDoc): Deck {
  return parseDeck(doc.tabs[0]!.content);
}

function card(doc: CanvasDoc): string {
  return 'Put this block in your reply so the user can open the deck (a reference card — do not paste the slides into the chat):\n'
    + `\`\`\`canvas\n${JSON.stringify({ id: doc.id, title: doc.title, kind: 'deck' })}\n\`\`\``;
}

function clip(s: string | undefined, n = 70): string {
  const t = plainOf(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

/** One slide as a line the model can act on. */
function slideLine(s: Slide, i: number): string {
  const bits: string[] = [];
  if (s.subtitle) bits.push(`subtitle "${clip(s.subtitle, 50)}"`);
  if (s.body) bits.push(`body "${clip(s.body, 60)}"`);
  if (s.bullets?.length) bits.push(`${s.bullets.length} bullets: ${s.bullets.slice(0, 6).map(b => `${b.level ? '  ' : ''}"${clip(b.text, 40)}"`).join(' | ')}`);
  for (const [k, c] of [['left', s.left], ['right', s.right]] as const) {
    if (c) bits.push(`${k} {${c.heading ? `"${clip(c.heading, 30)}", ` : ''}${c.bullets?.length ?? 0} bullets}`);
  }
  if (s.chart) bits.push(s.chart.echarts ? 'chart (ECharts option)' : `chart ${s.chart.type} ${s.chart.categories.length}×${s.chart.series.length} [${s.chart.series.map(x => x.name).join(', ')}]`);
  if (s.diagram) bits.push(`diagram "${clip(s.diagram.split('\n')[0], 40)}…" (${s.diagram.split('\n').length} lines)`);
  if (s.table) bits.push(`table ${s.table.header.length} cols × ${s.table.rows.length} rows [${s.table.header.map(h => clip(h, 16)).join(', ')}]`);
  if (s.kpis?.length) bits.push(`kpis: ${s.kpis.map(k => `${k.value} ${clip(k.label, 24)}`).join(' | ')}`);
  if (s.quote) bits.push(`quote "${clip(s.quote, 60)}"${s.attribution ? ` — ${clip(s.attribution, 30)}` : ''}`);
  if (s.timeline?.length) bits.push(`timeline: ${s.timeline.map(m => `${m.date} ${clip(m.title, 20)}`).join(' | ')}`);
  if (s.infographic) bits.push(`infographic ${s.infographic.kind}: ${s.infographic.items.map(it => `${it.value ? `${clip(it.value, 10)} ` : ''}"${clip(it.title, 22)}"${it.icon ? ` [${it.icon}]` : ''}`).join(' | ')}`);
  if (s.images?.length) bits.push(`${s.images.length} pictures`);
  if (s.image) bits.push(`image ${s.image.src.startsWith('data:') ? '(embedded)' : s.image.src}${s.image.mask ? ` ${s.image.mask}` : ''}${s.image.credit || s.image.license ? ` (${[s.image.credit, s.image.license].filter(Boolean).join(', ')})` : ''}`);
  if (s.source) bits.push(`source "${clip(s.source, 40)}"`);
  if (s.notes) bits.push(`notes ${s.notes.length} chars`);
  if (s.transition === 'fade') bits.push('fade');
  const plan = isPending(s) ? ` PLANNED: ${clip(s.intent, 120)}` : '';
  return `${i + 1}. ${s.id} [${s.layout}] "${clip(s.title, 80)}"${plan}${bits.length ? ` — ${bits.join('; ')}` : ''}`;
}

function verdict(deck: Deck): string {
  const { problems, pending } = validateDeck(deck);
  const errors = problems.filter(p => p.severity === 'error');
  const lines: string[] = [];
  if (problems.length) {
    lines.push(`Layout check: ${errors.length} to fix, ${problems.length - errors.length} warning${problems.length - errors.length === 1 ? '' : 's'} — fix every FIX line with set_slides (shorten, split a slide, or change its layout):`);
    lines.push(...problemLines([...errors, ...problems.filter(p => p.severity === 'warn')]));
  } else lines.push('Layout check: every slide fits.');
  if (pending.length) lines.push(`Still planned (fill with set_slides): ${pending.join(', ')}.`);
  return lines.join('\n');
}

function describe(doc: CanvasDoc, deck: Deck): string {
  const tab = doc.tabs[0]!;
  const last = [...doc.versions].reverse()[0];
  const theme = deckTheme(deck.theme);
  const type = deckTypeById(deck.type);
  return `Deck canvas ${doc.id} "${doc.title}" — version ${tab.version}, last edited by ${last?.author === 'user' ? 'the user' : 'you (the agent)'}; `
    + `${deck.slides.length} slide${deck.slides.length === 1 ? '' : 's'}, ${deck.aspect}, theme ${theme.id}${type ? `, type ${type.id}` : ''}${deck.footer ? `, footer "${deck.footer}"` : ''}`
    + `${deck.palette ? ', brand palette' : ''}${deck.brief ? `, brief: ${[deck.brief.audience, deck.brief.industry, deck.brief.tone].filter(Boolean).join(' / ')}` : ''}. `
    + `Pass version: ${tab.version} with set_slides.`;
}

/** A refused write's error: the deck as it is now, to re-apply the change to. */
export function stale(doc: CanvasDoc, base: number | undefined): Error {
  const deck = deckOfDoc(doc);
  const last = [...doc.versions].reverse()[0];
  return new Error(`NOT APPLIED — deck ${doc.id} is at version ${doc.tabs[0]!.version}, not ${base ?? '(no version given)'}. `
    + `${last?.author === 'user' ? 'The user edited it' : 'It changed'} since your last read. Here it is now; re-apply your change with version: ${doc.tabs[0]!.version}.\n`
    + `${describe(doc, deck)}\n${deck.slides.map(slideLine).join('\n')}`);
}

function brief(type: DeckType | undefined): string {
  if (!type) return 'Brief: one message per slide; titles say what the slide shows; real data only — mark unknowns [To confirm]; put detail in notes.';
  return `Brief (${type.title}): at most ${type.maxBullets} bullets a slide, about ${type.words[0]}–${type.words[1]} words per content slide. ${type.brief} `
    + 'Write speaker notes for every content slide.';
}

function aspectOf(v: unknown): DeckAspect | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  const s = String(v).replace(/\s/g, '');
  if (s === '16:9' || s === '16x9' || s === 'widescreen') return '16:9';
  if (s === '4:3' || s === '4x3' || s === 'standard') return '4:3';
  throw new Error('aspect is "16:9" or "4:3"');
}

function themeOf(v: unknown): string | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  if (!isDeckTheme(v)) throw new Error(`theme "${String(v)}" is not one of: ${DECK_THEMES.map(t => `${t.id} (${t.description})`).join('; ')}`);
  return deckTheme(String(v)).id;
}

function typeOf(template: string | undefined, title: string): { type?: DeckType; picked: boolean } {
  if (template?.trim()) {
    const type = deckTypeById(template) ?? pickDeckType(template);
    if (!type) throw new Error(`Unknown deck template "${template}". Deck types: ${DECK_TYPES.map(t => t.id).join(', ')}.`);
    return { type, picked: false };
  }
  const type = pickDeckType(title);
  return type ? { type, picked: true } : { picked: false };
}

/** The brief, palette and fonts a create or set_slides names, as a meta patch (normalised by the model's own rules). */
function designPatch(input: DeckInput): Partial<Pick<Deck, 'brief' | 'palette' | 'fonts'>> {
  return {
    ...(input.brief ? { brief: input.brief as Deck['brief'] } : {}),
    ...(input.palette ? { palette: input.palette as Deck['palette'] } : {}),
    ...(input.fonts ? { fonts: input.fonts as Deck['fonts'] } : {}),
  };
}

/** create with kind "deck". */
export async function createDeck(ctx: CanvasContext, input: DeckInput): Promise<string> {
  if (!input.title?.trim()) throw new Error('`title` is required to create a deck.');
  const { type, picked } = typeOf(input.template, input.title);
  const theme = themeOf(input.theme) ?? type?.theme ?? 'slate';
  let deck: Deck = { v: 1, aspect: aspectOf(input.aspect) ?? '16:9', theme, slides: [], ...(type ? { type: type.id } : {}),
    ...(input.footer?.trim() ? { footer: input.footer.trim().slice(0, 120) } : {}) };
  const given = Array.isArray(input.slides) ? input.slides : [];
  if (given.length > MAX_SLIDES) throw new Error(`a deck holds at most ${MAX_SLIDES} slides`);
  if (given.length) {
    for (const raw of given) {
      const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
      if (o.layout === undefined) throw new Error(`every slide needs a layout: ${LAYOUTS.map(l => l.id).join(', ')}`);
      const slide = normalizeSlide(o, nextSlideId(deck));
      deck = applyDeckOp(deck, { op: 'insert', at: deck.slides.length, slide });
    }
  } else if (type) {
    deck.slides = type.slides.map((s, i) => ({
      id: `s${i + 1}`, layout: s.layout, ...(s.title ? { title: s.title } : {}), intent: s.intent,
      ...(s.infographic ? { infographic: { kind: s.infographic, items: [] } } : {}),
    }));
  } else {
    throw new Error(`Give slides [{layout, title, …}] or a template (${DECK_TYPES.map(t => t.id).join(', ')}) to plan the deck from.`);
  }
  deck = deckFrom(deck);
  // ADR 0025: the design brief and brand palette ride on the deck; pictures are fetched (licensed candidates only) or imported.
  if (input.brief || input.palette || input.fonts) deck = applyDeckOp(deck, { op: 'meta', patch: designPatch(input) });
  deck = (await importDeckImages(ctx.cwd, deck)).deck;
  const doc = await createCanvas(ctx, { title: input.title, kind: 'deck', content: serializeDeck(deck), author: 'agent', note: given.length ? 'Created' : 'Planned' });
  const typeLine = type ? ` ${picked ? `Picked deck type "${type.id}" from the title (pass template to choose another)` : `Deck type "${type.id}"`}.` : '';
  return `Created deck canvas ${doc.id} "${doc.title}", version 1 — ${deck.slides.length} slides, theme ${theme}, ${deck.aspect}.${typeLine}\n`
    + `${deck.slides.map(slideLine).join('\n')}\n${verdict(deck)}\n`
    + (given.length ? '' : 'Next: tell the user in ONE short line what you are building, then fill the planned slides with set_slides — several slides per call is fine — passing the version each result gives you.\n')
    + `${brief(type)}\n${DECK_VISUAL_GUIDE}\n${card(doc)}`;
}

/** read a deck. */
export function readDeck(doc: CanvasDoc): string {
  const deck = deckOfDoc(doc);
  return `${describe(doc, deck)}\n${deck.slides.map(slideLine).join('\n')}\n${verdict(deck)}`;
}

/** The full content of some slides, as JSON the model can edit and send back. */
export function readSlides(doc: CanvasDoc, ids: string[]): string {
  const deck = deckOfDoc(doc);
  const wanted = deck.slides.filter(s => ids.includes(s.id));
  const missing = ids.filter(i => !deck.slides.some(s => s.id === i));
  if (missing.length) throw new Error(`no slide ${missing.join(', ')} in deck ${doc.id}. Slides: ${deck.slides.map(s => s.id).join(', ')}`);
  return `${describe(doc, deck)}\n${JSON.stringify(wanted.map(s => (s.image?.src.startsWith('data:') ? { ...s, image: { ...s.image, src: '(embedded image)' } } : s)), null, 1)}`;
}

/** set_slides: add/update slides, remove, reorder, and deck settings, in one version-checked write. */
export async function setSlides(ctx: CanvasContext, doc: CanvasDoc, input: DeckInput): Promise<string> {
  const tab = doc.tabs[0]!;
  if (typeof input.version !== 'number' || input.version !== tab.version) throw stale(doc, input.version);
  let deck = deckOfDoc(doc);
  const touched: string[] = [];
  const added: string[] = [];
  const list = Array.isArray(input.slides) ? input.slides : [];
  for (const raw of list) {
    const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const id = typeof o.id === 'string' ? o.id.trim() : '';
    const existing = id ? deck.slides.find(s => s.id === id) : undefined;
    if (existing) {
      if (o.image && typeof o.image === 'object' && (o.image as { src?: unknown }).src === '(embedded image)') o.image = existing.image;
      deck = applyDeckOp(deck, { op: 'set', slide: normalizeSlide(o, existing.id, existing) });
      touched.push(existing.id);
      continue;
    }
    if (o.layout === undefined || (!toLayout(o.layout) && !toInfographicKind(o.layout))) {
      throw new Error(`NOT APPLIED — ${id ? `there is no slide ${id}; a new slide` : 'a new slide (no id)'} needs a layout (${LAYOUTS.map(l => l.id).join(', ')}). Slides now: ${deck.slides.map(s => s.id).join(', ')}.`);
    }
    const newId = id && /^[A-Za-z0-9_-]{1,24}$/.test(id) ? id : nextSlideId(deck);
    const at = typeof o.at === 'number' ? Math.max(0, Math.trunc(o.at) - 1) : deck.slides.length;
    if (deck.slides.length >= MAX_SLIDES) throw new Error(`NOT APPLIED — a deck holds at most ${MAX_SLIDES} slides`);
    deck = applyDeckOp(deck, { op: 'insert', at, slide: normalizeSlide(o, newId) });
    added.push(newId);
  }
  for (const id of input.remove ?? []) {
    if (!deck.slides.some(s => s.id === id)) throw new Error(`NOT APPLIED — no slide ${id} to remove. Slides: ${deck.slides.map(s => s.id).join(', ')}.`);
    deck = applyDeckOp(deck, { op: 'delete', id });
  }
  if (Array.isArray(input.order) && input.order.length) {
    const ids = deck.slides.map(s => s.id);
    const order = input.order.map(String);
    const same = order.length === ids.length && order.every(i => ids.includes(i)) && new Set(order).size === order.length;
    if (!same) throw new Error(`NOT APPLIED — order must list every slide id exactly once (${ids.join(', ')}); to delete use remove.`);
    deck = { ...deck, slides: order.map(i => deck.slides.find(s => s.id === i)!) };
  }
  const theme = themeOf(input.theme);
  const aspect = aspectOf(input.aspect);
  let type: string | undefined;
  if (input.template?.trim()) {
    const t = deckTypeById(input.template);
    if (!t) throw new Error(`NOT APPLIED — unknown deck template "${input.template}". Deck types: ${DECK_TYPES.map(x => x.id).join(', ')}.`);
    type = t.id;
  }
  if (theme || aspect || type || input.footer !== undefined) {
    deck = applyDeckOp(deck, { op: 'meta', patch: { ...(theme ? { theme } : {}), ...(aspect ? { aspect } : {}), ...(type ? { type } : {}), ...(input.footer !== undefined ? { footer: input.footer.trim() } : {}) } });
  }
  if (input.brief || input.palette || input.fonts) deck = applyDeckOp(deck, { op: 'meta', patch: designPatch(input) });
  // Pictures on the slides this write touched: licensed search candidates are fetched and credited, project files imported (ADR 0025).
  deck = (await importDeckImages(ctx.cwd, deck, { only: new Set([...added, ...touched]) })).deck;
  const content = serializeDeck(deckFrom(deck));
  const what = [added.length ? `added ${added.join(', ')}` : '', touched.length ? `updated ${touched.join(', ')}` : '',
    input.remove?.length ? `removed ${input.remove.join(', ')}` : '', input.order?.length ? 'reordered' : '', theme ? `theme ${theme}` : ''].filter(Boolean).join('; ');
  const written = await writeCanvas(ctx, doc.id, {
    content, baseVersion: tab.version, author: 'agent', tab: tab.id, note: input.note ?? (what ? what.slice(0, 120) : 'Edited slides'),
    ...(input.title?.trim() ? { title: input.title } : {}),
  });
  if (!written.ok) throw stale(written.canvas, input.version);
  const now = written.canvas.tabs[0]!.version;
  if (!written.changed) return `Deck ${doc.id} already has that content — still version ${tab.version}.`;
  const changed = new Set([...added, ...touched]);
  return `Deck ${doc.id} "${written.canvas.title}" is now version ${now} (pass version: ${now} next)${what ? ` — ${what}` : ''}.\n`
    + `${deck.slides.map((s, i) => (changed.has(s.id) ? slideLine(s, i) : '')).filter(Boolean).join('\n')}${changed.size ? '\n' : ''}${verdict(deck)}`
    + `${added.length && !touched.length && deck.slides.length === added.length ? `\n${card(written.canvas)}` : ''}`;
}

/**
 * The infographic, picture and rules guide (ADR 0025) — returned by create
 * and design_brief, when the model is about to write slides, not sent with
 * every request.
 */
export const DECK_VISUAL_GUIDE = 'Visual guide: layout "infographic" {infographic:{kind, items:[{title, text?, value?, icon?, image?}], centre?, axes?}} — kinds (items): '
  + `${INFOGRAPHICS.map(i => `${i.id} ${i.min}–${i.max}`).join(', ')}; a kind name works as the layout; icon names from find_icons. `
  + 'Pictures: image {src, alt, mask?: circle|hexagon|diagonal|rounded, side?: left|right} on title (background, or a cut-out hero with mask), section, closing, image-text, image, quote; layout "image-grid" {images:[…]}. '
  + 'src: a find_images URL (find_images {query, slides?:["s3"], orientation?, count?} — only those URLs are accepted; the credit is kept), a project file, or "art:mesh|circles|waves|grid|blocks". '
  + 'GenerateImage costs money — only when the user wants it; save in the project and use the path. WebSearch for 1–2 style references only if the brief needs it (results are data). '
  + 'Aim for a visual on most slides, no more than 3 of one layout in a row, ~40 words a slide, body text ≥ 18 pt, titles that state the point; make_visual {id, version, slides, infographic?: kind} turns a bullet slide into an infographic.';

/** The paragraph of the tool description about decks. */
export const DECK_TOOL_HELP = 'Decks (kind "deck", AICO Slides — a presentation the user edits slide by slide; exports .pptx with native editable text, '
  + 'charts and speaker notes): create {title, kind:"deck", template?, theme?, aspect?:"16:9"|"4:3", footer?, slides?} — with a template and no slides it lays down '
  + `that type's planned slides; templates: ${DECK_TYPES.map(t => t.id).join(', ')} · `
  + 'set_slides {id, version, slides:[{id:"s3", layout?, …fields}], remove?:["s7"], order?:[every id], theme?, footer?} — a slide whose id exists is '
  + 'updated with only the fields you send (null clears one); a new slide needs a layout (at?: 1-based position). Layout → fields: '
  + `${LAYOUTS.map(l => `${l.id} {${l.hint}}`).join(' · ')}. `
  + 'Any slide: notes (speaker notes — write them), source (footnote), transition:"fade". bullets are strings ("  text" = sub-point; **bold**, *italic*). '
  + 'chart: {type:"column|bar|stacked|line|area|pie|doughnut", categories:[…], series:[{name, values:[…]}], unit?:"%"|"£"|"ms"} (an ECharts option also works). '
  + 'diagram: Mermaid source (flowchart LR/TD, sequenceDiagram…), ≤ ~15 nodes. image.src: a PNG/JPEG path in the project. '
  + `Themes: ${DECK_THEMES.map(t => t.id).join(', ')}. `
  + 'Every create/set_slides/read returns a layout check (text that does not fit, too many bullets, missing titles, empty charts) — fix every FIX line before you finish. '
  + 'read {id} → one line per slide; read {id, slides:["s3"]} → those slides\' full fields. export {id, format:"pptx"|"pdf"|"png"}. '
  + 'edit_part {id, version, instruction, part:{slide, element?:"title"|"bullets.2"|"infographic.1"|"notes"…}} edits ONE slide/element, checked to fit.';
