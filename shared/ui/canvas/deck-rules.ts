/**
 * Deck-level presentation rules — what makes a deck read as designed rather
 * than as a document cut into slides, checked across slides (the per-slide
 * rules — body size, bullets, overflow, alt text, picture sharpness, contrast
 * of text over photos — live in the layout engine where the frames are).
 *
 * ## Why rules in code
 *
 * ADR 0025 collects the presentation practice the deck system follows (one
 * idea per slide, assertion titles, a visual on most slides, variety and
 * rhythm…). A model told these in a prompt follows them for three slides;
 * a validator that reports them after every write, slide by slide, is what
 * keeps slide nine honest (principle 6). Every rule here is a *warning* with
 * the fix in its text — they are judgement calls a person may overrule —
 * except where the layout engine already makes a breach an error.
 *
 * @module shared/ui/canvas/deck-rules
 */

import type { Problem, SlideLayout } from './deck-layout';
import { plainOf, type Deck, type DeckLayout, type Slide } from './deck-model';
import { deckTypeById } from './deck-types';

/** Layouts that are words only. */
const TEXT_ONLY = new Set<DeckLayout>(['bullets', 'two-column', 'comparison', 'agenda']);
/** Structural slides the content rules skip. */
const FRAME = new Set<DeckLayout>(['title', 'section', 'closing']);

export function isVisualSlide(s: Slide): boolean {
  if (FRAME.has(s.layout)) return false;
  if (TEXT_ONLY.has(s.layout)) return false;
  if (s.layout === 'quote') return Boolean(s.image?.src);
  return true;
}

/** The words the audience reads on a slide (not its notes). */
export function slideWords(s: Slide): number {
  const parts: string[] = [];
  const add = (t?: string): void => { if (t) parts.push(plainOf(t)); };
  add(s.subtitle); add(s.body);
  s.bullets?.forEach(b => add(b.text));
  for (const c of [s.left, s.right]) { add(c?.heading); add(c?.body); c?.bullets?.forEach(b => add(b.text)); }
  add(s.quote);
  s.kpis?.forEach(k => add(k.label));
  s.timeline?.forEach(m => { add(m.title); add(m.text); });
  s.infographic?.items.forEach(it => { add(it.title); add(it.text); });
  s.table?.rows.forEach(r => r.forEach(add));
  return parts.join(' ').split(/\s+/).filter(Boolean).length;
}

function range(a: number, b: number): string {
  return a === b ? `slide ${a}` : `slides ${a}–${b}`;
}

/** Problems across the deck: variety, rhythm, visual share, density, titles. */
export function deckRuleProblems(deck: Deck, layouts: SlideLayout[]): Problem[] {
  const out: Problem[] = [];
  const slides = deck.slides;
  const live = slides.map((s, i) => ({ s, i, pending: layouts[i]?.pending ?? false })).filter(x => !x.pending);
  const warn = (i: number, message: string, field?: string): void => {
    out.push({ slide: slides[i]!.id, n: i + 1, severity: 'warn', message, ...(field ? { field } : {}) });
  };

  // Variety: more than three slides in a row on one layout (or one infographic kind) reads as a template.
  let runStart = 0;
  const key = (s: Slide): string => (s.layout === 'infographic' ? `infographic:${s.infographic?.kind ?? ''}` : s.layout);
  for (let i = 1; i <= slides.length; i++) {
    const same = i < slides.length && !FRAME.has(slides[i]!.layout) && key(slides[i]!) === key(slides[runStart]!);
    if (!same) {
      if (i - runStart > 3) warn(runStart, `${range(runStart + 1, i)} all use the same layout (${key(slides[runStart]!)}) — vary it: an infographic, a picture, a chart, big numbers`);
      runStart = i;
    }
  }

  // Text-only runs and the share of slides with a visual.
  let textRun: number[] = [];
  const flush = (): void => {
    if (textRun.length >= 3) warn(textRun[0]!, `${range(textRun[0]! + 1, textRun.at(-1)! + 1)} are text only — make one of them visual (make_visual {id, version, slides:["${slides[textRun[1]!]!.id}"]}) or add a picture`);
    textRun = [];
  };
  for (const { s, i } of live) {
    if (FRAME.has(s.layout)) { flush(); continue; }
    if (isVisualSlide(s)) flush(); else textRun.push(i);
  }
  flush();
  const content = live.filter(x => !FRAME.has(x.s.layout));
  if (content.length >= 6) {
    const visual = content.filter(x => isVisualSlide(x.s)).length;
    if (visual / content.length < 0.5) {
      const textIds = content.filter(x => !isVisualSlide(x.s)).map(x => x.s.id);
      warn(content[0]!.i, `only ${visual} of ${content.length} content slides have a visual — aim for most: make text slides visual (${textIds.slice(0, 6).join(', ')}) with make_visual, pictures, charts or infographics`);
    }
  }

  // Rhythm: a long deck needs section dividers.
  if (slides.length > 12 && !slides.some(s => s.layout === 'section')) {
    warn(0, `a deck of ${slides.length} slides has no section slides — add a section divider before each part so the audience knows where they are`);
  }

  // Density: one idea per slide, ~40 words on it.
  const type = deckTypeById(deck.type);
  const limit = Math.round((type?.words[1] ?? 45) * 1.25);
  for (const { s, i } of content) {
    if (s.layout === 'table') continue;
    const words = slideWords(s);
    if (words > limit) warn(i, `${words} words on the slide — one idea per slide, about ${type?.words[1] ?? 40} words: cut, split it, or move detail to the speaker notes`);
  }

  // Assertion titles: a content title of one or two words is a label, not the point.
  const labels = content.filter(x => {
    const t = plainOf(x.s.title ?? '').trim();
    return t && !['agenda', 'quote'].includes(x.s.layout) && t.split(/\s+/).length <= 2 && !/\d/.test(t);
  });
  if (labels.length) {
    warn(labels[0]!.i, `title${labels.length > 1 ? 's' : ''} ${labels.slice(0, 5).map(x => `"${plainOf(x.s.title!)}"`).join(', ')} ${labels.length > 1 ? 'are labels' : 'is a label'} — say what the slide shows ("Revenue tripled in 2026", not "Revenue")`, 'title');
  }

  // Charts: data-ink — few series, few slices.
  for (const { s, i } of content) {
    const ch = s.chart;
    if (!ch || ch.echarts) continue;
    if (ch.series.length > 4) warn(i, `a chart with ${ch.series.length} series is hard to read on a slide — show the 2–3 that make the point, or split it`, 'chart');
    if ((ch.type === 'pie' || ch.type === 'doughnut') && ch.categories.length > 6 && ch.categories.length <= 8) warn(i, `a ${ch.type} with ${ch.categories.length} slices — keep 5–6 and group the rest as "Other"`, 'chart');
  }
  return out;
}
