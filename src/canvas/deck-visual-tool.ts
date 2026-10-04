/**
 * The Canvas tool's deck *visual* actions (ADR 0025): find licensed pictures,
 * find icons, derive a design brief (with a brand's colours from its site),
 * and turn a text slide into an infographic.
 *
 * ## Why separate actions, and what each one guarantees
 *
 * - `find_images` returns scored, licence-filtered candidates and remembers
 *   them; a picture URL in `set_slides` is downloaded only if a search
 *   returned it (`deck-media.ts`), so the credit and licence are the
 *   provider's, never the model's guess. Two HTTP calls per search at most.
 * - `find_icons` answers from the vendored set, so an icon name the agent
 *   writes always exists.
 * - `design_brief` decides theme, palette, layout mix and picture style from
 *   the audience, industry, tone and brand — in code (`deck-design.ts`), with
 *   the reason — and stores the brief on the deck so the person sees and edits
 *   it. A brand URL is fetched through the SSRF guard and only colours, a
 *   measured font and a name come back.
 * - `make_visual` rewrites chosen slides through `set_slides`, so it is
 *   version-checked and validated like any other write.
 *
 * @module canvas/deck-visual-tool
 */

import { layoutDeck, type ImageFrame } from '../../shared/ui/canvas/deck-layout.js';
import { INFOGRAPHICS, toBrief, type DesignBrief, type Slide } from '../../shared/ui/canvas/deck-model.js';
import { findIcons } from '../../shared/ui/canvas/deck-icons.js';
import { makeVisual, paletteFromBrand, planDesign } from '../../shared/ui/canvas/deck-design.js';
import { deckTheme, isDeckTheme } from '../../shared/ui/canvas/deck-themes.js';
import { candidateLines, searchImages, type SearchOptions } from './deck-image-search.js';
import { extractBrand } from './deck-brand.js';
import { DECK_VISUAL_GUIDE, deckOfDoc, setSlides, stale } from './deck-tool.js';
import type { CanvasContext, CanvasDoc } from './store.js';

export interface DeckVisualInput {
  id?: string;
  version?: number;
  query?: string;
  orientation?: string;
  count?: number;
  slides?: unknown[];
  /** make_visual: the infographic kind to use (default: chosen from the content). */
  kind?: string;
  brief?: Record<string, unknown>;
  theme?: string;
}

/** Stock keys from the vault, used for one request each; absent when none is stored. */
async function stockKeys(): Promise<SearchOptions['keys']> {
  try {
    const { list } = await import('../vault/index.js');
    const names = new Set((await list({})).map(c => c.name.toLowerCase()));
    const { useCredential } = await import('../tools/ops/common.js');
    const get = (name: string, origin: string) => async () => {
      const s = await useCredential(name, { tool: 'Canvas', origin, purpose: 'search stock photos for a presentation slide' });
      return { value: s.value(), release: () => s.release() };
    };
    return {
      ...(names.has('pexels') ? { pexels: get('pexels', 'https://api.pexels.com:443') } : {}),
      ...(names.has('unsplash') ? { unsplash: get('unsplash', 'https://api.unsplash.com:443') } : {}),
    };
  } catch {
    return {}; // no vault, or locked: the open sources need no key
  }
}

/** find_images. */
export async function findImagesAction(_ctx: CanvasContext, doc: CanvasDoc | undefined, input: DeckVisualInput): Promise<string> {
  const query = String(input.query ?? '').trim();
  if (!query) throw new Error('find_images needs query: what the picture should show, in a few concrete words ("engineers in a server room").');
  // The slot the picture is for (the first image frame of the named slide), so resolution and shape are scored for it.
  let slot: { w: number; h: number } | undefined;
  const sid = Array.isArray(input.slides) && typeof input.slides[0] === 'string' ? input.slides[0] : undefined;
  if (doc && sid) {
    const deck = deckOfDoc(doc);
    const i = deck.slides.findIndex(s => s.id === sid);
    const frame = i >= 0 ? layoutDeck(deck)[i]!.frames.find((f): f is ImageFrame => f.kind === 'image') : undefined;
    if (frame) slot = { w: frame.w, h: frame.h };
  }
  const o = String(input.orientation ?? '').toLowerCase();
  const orientation = o === 'portrait' || o === 'square' || o === 'landscape' ? o : slot && slot.h > slot.w ? 'portrait' : 'landscape';
  const r = await searchImages(query, { orientation, ...(slot ? { slot } : {}), count: input.count ?? 6, keys: await stockKeys() });
  if (!r.candidates.length) {
    return `No licensed pictures found for "${query}"${r.notes.length ? ` (${r.notes.join('; ')})` : ''}. Try simpler, concrete words, or use an illustration: image {src: "art:scene"} (or art:landscape|city|network|data|people|civic|water; abstract: art:mesh|circles|waves|grid|blocks).`;
  }
  return [
    `${r.candidates.length} licensed pictures for "${query}" from ${r.providers.join(' + ')} (commercial use allowed: CC0, public domain, CC BY, CC BY-SA${r.providers.some(p => p === 'pexels' || p === 'unsplash') ? ', stock licence' : ''}):`,
    ...candidateLines(r.candidates),
    'Place one with set_slides: image {src: "<src above>", alt: "what it shows"} (add mask: circle|hexagon|diagonal|rounded, side: left|right as the layout allows). '
      + 'AICO downloads it, keeps the creator and licence as an on-slide credit and in the notes. Only URLs listed here are accepted.',
    ...(r.notes.length ? [`Notes: ${r.notes.join('; ')}`] : []),
  ].join('\n');
}

/** find_icons. */
export function findIconsAction(input: DeckVisualInput): string {
  const query = String(input.query ?? '').trim();
  if (!query) throw new Error('find_icons needs query: a word or two ("security", "growth", "onboarding").');
  const hits = findIcons(query, Math.max(4, Math.min(20, input.count ?? 10)));
  if (!hits.length) return `No icon matches "${query}". Try a simpler word (money, people, time, security, growth, idea, cloud, data).`;
  return `Icons for "${query}" (use the name in an infographic item's icon): ${hits.map(h => h.name).join(', ')}.`;
}

/** design_brief: a plan (and, with a deck id, the brief, theme and brand palette stored on it). */
export async function designBriefAction(ctx: CanvasContext, doc: CanvasDoc | undefined, input: DeckVisualInput): Promise<string> {
  const brief: DesignBrief = toBrief(input.brief) ?? {};
  const lines: string[] = [];
  let colors = brief.brand?.colors ?? [];
  let font: string | undefined;
  if (brief.brand?.url && !colors.length) {
    try {
      const b = await extractBrand(brief.brand.url);
      colors = b.colors;
      font = b.font;
      brief.brand = { ...brief.brand, ...(b.name && !brief.brand.name ? { name: b.name } : {}), ...(colors.length ? { colors } : {}), ...(font ? { font } : {}) };
      lines.push(`Brand from ${b.url}: ${colors.length ? colors.join(' ') : 'no colours found'}${font ? `, font ${font}` : ''}.${b.notes.length ? ` (${b.notes.join('; ')})` : ''}`);
    } catch (err) {
      lines.push(`Brand site not read: ${err instanceof Error ? err.message : String(err)} — give brand.colors instead.`);
    }
  }
  const deck = doc ? deckOfDoc(doc) : undefined;
  const plan = planDesign(brief, { title: doc?.title, type: deck?.type });
  const theme = input.theme && isDeckTheme(input.theme) ? deckTheme(input.theme).id : plan.theme;
  const palette = colors.length ? paletteFromBrand(colors, theme) : undefined;
  lines.unshift(
    `Design plan: theme ${theme}${theme === plan.theme ? ` — ${plan.why}` : ` (yours; suggested ${plan.theme})`}.`,
    `Layout mix for this audience: ${plan.layoutMix.join(', ')}. Pictures: ${plan.imageStyle}${plan.imageQueries.length ? ` (e.g. find_images "${plan.imageQueries.join('", "')}")` : ''}.`,
    `Density: at most ${plan.maxBullets} bullets, about ${plan.words[0]}–${plan.words[1]} words a slide. ${plan.tips.join('; ')}.`,
    ...(palette ? [`Brand palette: ${Object.entries(palette).map(([k, v]) => `${k} ${v}`).join(', ')} (checked for contrast).`] : []),
  );
  if (doc) {
    if (typeof input.version !== 'number') throw stale(doc, input.version);
    const written = await setSlides(ctx, doc, {
      version: input.version, theme, brief: brief as Record<string, unknown>,
      ...(palette ? { palette } : {}), ...(font ? { fonts: { heading: font, body: font } } : {}), note: 'Design brief',
    });
    lines.push(written);
  } else {
    lines.push('Create the deck with this theme (create {kind:"deck", theme, brief}), or pass id and version to apply it to a deck.');
  }
  lines.push(DECK_VISUAL_GUIDE);
  return lines.join('\n');
}

/** make_visual: chosen text slides become infographics. */
export async function makeVisualAction(ctx: CanvasContext, doc: CanvasDoc, input: DeckVisualInput): Promise<string> {
  const ids = (Array.isArray(input.slides) ? input.slides : []).map(String);
  if (!ids.length) throw new Error('make_visual needs slides: ["s3", …] — the slides to turn into infographics.');
  if (input.kind && !INFOGRAPHICS.some(i => i.id === input.kind)) throw new Error(`kind "${input.kind}" is not one of ${INFOGRAPHICS.map(i => i.id).join(', ')}.`);
  const deck = deckOfDoc(doc);
  const changes: Record<string, unknown>[] = [];
  const skipped: string[] = [];
  for (const id of ids) {
    const s = deck.slides.find(x => x.id === id);
    if (!s) throw new Error(`NOT APPLIED — no slide ${id}. Slides: ${deck.slides.map(x => x.id).join(', ')}.`);
    const next = makeVisual(s, input.kind);
    if (!next) { skipped.push(`${id} (no bullets, columns, KPIs or milestones to turn into items)`); continue; }
    // Clear what the old layout drew, keep the rest.
    const cleared: Partial<Record<keyof Slide, null>> = { bullets: null, left: null, right: null, kpis: null, timeline: null };
    changes.push({ ...cleared, ...next, ...(next.body ? {} : { body: null }) });
  }
  if (!changes.length) return `Nothing to make visual: ${skipped.join('; ')}.`;
  const out = await setSlides(ctx, doc, { version: input.version, slides: changes, note: `Made ${changes.length} slide${changes.length === 1 ? '' : 's'} visual` });
  return `${out}${skipped.length ? `\nSkipped: ${skipped.join('; ')}.` : ''}\nCheck the kind fits the message (pass kind to choose another: ${INFOGRAPHICS.map(i => i.id).join(', ')}).`;
}

/**
 * The paragraph of the tool description about deck visuals — short, because
 * it rides on every request; the full guide (`DECK_VISUAL_GUIDE`) comes back
 * from design_brief and from creating a deck, when it is about to be used.
 */
export const DECK_VISUAL_HELP = 'Deck visuals: design_brief {brief:{audience, industry, tone, brand?}, id?, version?} first (returns theme, palette, infographic and picture guide); find_images {query}, find_icons {query}, make_visual {id, version, slides}.';
