/**
 * Designing a deck before writing it — the design brief (audience, industry,
 * tone, brand) turned into a theme, a palette, a layout mix and a picture
 * style; brand colours turned into a palette that keeps the contrast rules;
 * and "Make this slide visual", which turns a list of bullets into the
 * infographic that says the same thing.
 *
 * ## Why rules here and not a model's taste
 *
 * The agent writes the content; consistency of design is better decided by a
 * table it can read in one line than re-imagined on every deck. The brief
 * maps audience and industry to the themes that suit them (investors: dark,
 * bold, numbers first; IT managers: clean light, diagrams and processes; new
 * staff: friendly, rounded, people and timelines), returns *why*, and the
 * agent or the person can overrule it. Brand colours become theme slots
 * (`themeOfDeck`), adjusted until text keeps WCAG AA on them — a brand's
 * yellow is kept as an accent, not used behind white text.
 *
 * `makeVisual` never invents content: it keeps every word of the bullets,
 * splitting "Title: detail" into an item's title and text, and only chooses
 * the kind (numbers → tiles or rings, dates → timeline, steps → process,
 * strengths/weaknesses → SWOT…) and an icon per item from the vendored set.
 *
 * @module shared/ui/canvas/deck-design
 */

import { infographicInfo, plainOf, toInfographicKind, type DeckImage, type DesignBrief, type InfoItem, type InfographicKind, type Slide } from './deck-model';
import { DECK_THEMES, contrastRatio, deckTheme, hexToHsl, hslToHex, themeContrastProblems, themeOfDeck, type SchemeSlot } from './deck-themes';
import { iconFor } from './deck-icons';
import { percentOf } from './deck-infographics';

// ── The brief → a plan ───────────────────────────────────────────────

export interface DesignPlan {
  theme: string;
  dark: boolean;
  /** Why this theme, in one line. */
  why: string;
  /** Infographic kinds and layouts that suit the audience, best first. */
  layoutMix: string[];
  imageStyle: NonNullable<DesignBrief['imageStyle']>;
  /** Short search phrases for pictures that fit the subject. */
  imageQueries: string[];
  /** Density for the audience. */
  maxBullets: number;
  words: [number, number];
  tips: string[];
}

interface Profile { match: RegExp; themes: string[]; mix: string[]; image: DesignPlan['imageStyle']; maxBullets: number; words: [number, number]; tip: string }

const AUDIENCES: Profile[] = [
  { match: /investor|vc|venture|fundrais|pitch|angel/i, themes: ['nebula', 'graphite', 'sapphire', 'ember'], mix: ['tiles', 'rings', 'roadmap', 'team', 'versus', 'image-text'], image: 'photo', maxBullets: 3, words: [8, 30], tip: 'numbers first: one big figure per slide, traction as a chart, the ask as tiles' },
  { match: /board|executive|c-suite|ceo|cfo|leadership|director/i, themes: ['sapphire', 'boardroom', 'harbor', 'forest'], mix: ['tiles', 'stat-bars', 'matrix', 'chart', 'table'], image: 'none', maxBullets: 4, words: [12, 45], tip: 'answer first: the conclusion is the title; show change vs. plan' },
  { match: /it manager|technical|engineer|developer|architect|admin|ops|devops|it team|sysadmin|infrastructure/i, themes: ['lagoon', 'slate', 'carbon', 'midnight'], mix: ['process', 'cycle', 'hexagons', 'diagram', 'icon-grid', 'table', 'matrix'], image: 'illustration', maxBullets: 5, words: [20, 60], tip: 'precise and checkable: versions, sizes, owners; diagrams over prose' },
  { match: /customer|client|prospect|buyer|sales|partner/i, themes: ['harbor', 'coral', 'sunrise', 'aurora'], mix: ['cards', 'versus', 'before-after', 'quote-photo', 'image-text', 'tiles'], image: 'photo', maxBullets: 4, words: [12, 40], tip: 'about them, not us: their problem, the outcome, proof' },
  { match: /new staff|new hire|employee|onboard|hr|people|internal|team|staff|colleague/i, themes: ['sunrise', 'blossom', 'citrus', 'meadow'], mix: ['agenda', 'timeline', 'team', 'icon-grid', 'cards', 'image-text', 'radial'], image: 'photo', maxBullets: 4, words: [12, 40], tip: 'warm and practical: faces, the first weeks as a timeline, who to ask' },
  { match: /student|class|learner|pupil|course|training|workshop|teach/i, themes: ['scholar', 'meadow', 'citrus', 'sunrise'], mix: ['agenda', 'process', 'icon-grid', 'cycle', 'pyramid', 'quote'], image: 'illustration', maxBullets: 4, words: [12, 45], tip: 'one concept per slide with an example; recap at the end' },
  { match: /conference|keynote|public|audience|community|meetup/i, themes: ['aurora', 'mono', 'graphite', 'nebula'], mix: ['image', 'quote', 'tiles', 'radial', 'semicircle'], image: 'photo', maxBullets: 3, words: [5, 25], tip: 'few words, big type; the speaker carries the detail' },
];

const INDUSTRIES: { match: RegExp; themes: string[] }[] = [
  { match: /fintech|crypto|payments?|neobank/i, themes: ['nebula', 'sapphire', 'graphite'] },
  { match: /bank|finance|insurance|invest|wealth|accounting|audit/i, themes: ['sapphire', 'boardroom', 'harbor'] },
  { match: /health|medic|pharma|clinic|hospital|care/i, themes: ['lagoon', 'pine', 'ocean'] },
  { match: /educat|school|university|academ|learning/i, themes: ['scholar', 'meadow', 'citrus'] },
  { match: /sharepoint|microsoft|it\b|software|saas|cloud|data|cyber|security|tech|platform|infrastructure|network/i, themes: ['lagoon', 'slate', 'carbon', 'midnight'] },
  { match: /\bhr\b|human resources|people|recruit|talent|onboard/i, themes: ['blossom', 'sunrise', 'citrus'] },
  { match: /energy|sustainab|climate|green|environment|agri|farm/i, themes: ['pine', 'forest', 'meadow'] },
  { match: /retail|consumer|food|hospitality|travel|fashion/i, themes: ['coral', 'citrus', 'sunrise'] },
  { match: /legal|law|consult|government|public sector|policy/i, themes: ['harbor', 'boardroom', 'sandstone'] },
  { match: /creative|design|marketing|media|agency|brand/i, themes: ['aurora', 'graphite', 'coral'] },
];

const TONES: { match: RegExp; prefer: (id: string) => number }[] = [
  { match: /friendly|warm|welcom|fun|casual|playful/i, prefer: id => (['sunrise', 'blossom', 'citrus', 'meadow', 'coral'].includes(id) ? 3 : 0) },
  { match: /formal|serious|conservative|corporate|trust/i, prefer: id => (['sapphire', 'boardroom', 'harbor', 'slate', 'forest'].includes(id) ? 3 : 0) },
  { match: /bold|modern|dark|dramatic|premium|confident/i, prefer: id => (deckTheme(id).dark ? 3 : 0) + (deckTheme(id).gradient ? 1 : 0) },
  { match: /minimal|clean|simple/i, prefer: id => (['mono', 'slate', 'lagoon', 'carbon'].includes(id) ? 3 : 0) },
  { match: /light|bright/i, prefer: id => (deckTheme(id).dark ? -3 : 1) },
];

function subjectQueries(text: string): string[] {
  const t = text.toLowerCase();
  const out: string[] = [];
  if (/fintech|payment|bank/.test(t)) out.push('mobile banking app', 'city skyline at night', 'team working on laptops');
  if (/sharepoint|server|farm|infrastructure|data ?cent/.test(t)) out.push('data center servers', 'network cables', 'IT engineer at work');
  if (/onboard|new staff|hr|welcome|employee/.test(t)) out.push('team welcome meeting office', 'colleagues collaborating', 'office workspace');
  if (/health|medic/.test(t)) out.push('doctor with patient', 'hospital corridor');
  if (/educat|student|school/.test(t)) out.push('students in a classroom', 'library study');
  if (/energy|sustainab|green/.test(t)) out.push('wind turbines', 'solar panels');
  if (!out.length) out.push('modern office teamwork', 'abstract architecture');
  return out.slice(0, 3);
}

/** A design plan for a brief (and the deck's title or type, which say a lot about the audience). */
export function planDesign(brief: DesignBrief, context: { title?: string; type?: string } = {}): DesignPlan {
  const text = [brief.audience, brief.industry, brief.tone, brief.notes, context.title, context.type].filter(Boolean).join(' · ');
  const scores = new Map<string, number>(DECK_THEMES.map(t => [t.id, 0]));
  const reasons: string[] = [];
  const add = (ids: string[], w: number, why: string): void => {
    ids.forEach((id, i) => scores.set(id, (scores.get(id) ?? 0) + w - i * 0.5));
    reasons.push(why);
  };
  const aud = AUDIENCES.find(a => a.match.test(brief.audience ?? '')) ?? AUDIENCES.find(a => a.match.test(text));
  if (aud) add(aud.themes, 6, `audience: ${brief.audience ?? aud.match.source.split('|')[0]}`);
  const ind = INDUSTRIES.find(i => i.match.test(brief.industry ?? '')) ?? INDUSTRIES.find(i => i.match.test(text));
  if (ind) add(ind.themes, 5, `industry: ${brief.industry ?? 'from the subject'}`);
  for (const tone of TONES) if (tone.match.test(brief.tone ?? '')) { for (const id of scores.keys()) scores.set(id, scores.get(id)! + tone.prefer(id)); reasons.push(`tone: ${brief.tone}`); }
  const best = [...scores.entries()].sort((a, b) => b[1] - a[1])[0]![0];
  const theme = deckTheme(best);
  const imageStyle = brief.imageStyle ?? aud?.image ?? 'photo';
  return {
    theme: theme.id, dark: theme.dark,
    why: `${theme.name} (${theme.description}) — ${reasons.length ? reasons.join('; ') : 'a neutral default'}`,
    layoutMix: aud?.mix ?? ['process', 'cards', 'image-text', 'tiles', 'timeline', 'icon-grid'],
    imageStyle,
    imageQueries: imageStyle === 'none' ? [] : imageStyle === 'abstract' ? ['art:mesh', 'art:circles', 'art:waves'] : imageStyle === 'illustration' ? ['art:scene'] : subjectQueries(text),
    maxBullets: aud?.maxBullets ?? 5, words: aud?.words ?? [15, 50],
    tips: [aud?.tip ?? 'one message per slide', 'titles state the point', 'a visual on most slides; no more than three of one layout in a row', 'section slides between parts'],
  };
}

// ── Brand colours → a palette that keeps the rules ───────────────────

function shiftL(hex: string, l: number, s?: number): string {
  const [h, sat] = hexToHsl(hex);
  return hslToHex(h, s ?? sat, l);
}

function hueDistance(a: string, b: string): number {
  const d = Math.abs(hexToHsl(a)[0] - hexToHsl(b)[0]);
  return Math.min(d, 1 - d) * 360;
}

/**
 * Theme slots from brand colours. accent1 is the first brand colour, accent2
 * the next one far enough in hue (or a derived complement), accents 3–5
 * hue steps from them, dk2 (titles, title fields) a deep shade of the brand
 * and lt2 (cards) a pale tint. Then the result is held to the theme contrast
 * rules: dk2 is darkened until titles and white-on-field text pass AA.
 */
export function paletteFromBrand(colors: string[], themeId: string): Partial<Record<SchemeSlot, string>> {
  const base = deckTheme(themeId);
  const list = colors.filter(c => /^#[0-9a-f]{6}$/i.test(c)).map(c => c.toUpperCase());
  if (!list.length) return {};
  const a1 = list[0]!;
  const a2 = list.slice(1).find(c => hueDistance(c, a1) >= 28) ?? shiftL(hslToHex(hexToHsl(a1)[0] + 0.45, Math.max(0.45, hexToHsl(a1)[1]), 0.45), 0.45);
  const [h1, s1] = hexToHsl(a1);
  const rot = (dh: number, l: number): string => hslToHex(h1 + dh, Math.min(0.75, Math.max(0.4, s1)), l);
  const p: Partial<Record<SchemeSlot, string>> = {
    accent1: a1, accent2: a2,
    accent3: list.slice(2).find(c => hueDistance(c, a1) >= 28 && hueDistance(c, a2) >= 28) ?? rot(0.12, 0.5),
    accent4: rot(-0.08, 0.4), accent5: rot(0.55, 0.5),
  };
  if (base.dark) {
    p.dk2 = hslToHex(h1, Math.min(0.5, s1), 0.1);
    p.dk1 = hslToHex(h1, Math.min(0.4, s1), 0.05);
    p.lt2 = hslToHex(h1, Math.min(0.35, s1), 0.2);
  } else {
    p.dk2 = hslToHex(h1, Math.min(0.65, s1), 0.2);
    p.lt2 = hslToHex(h1, Math.min(0.4, s1), 0.96);
  }
  // Hold it to the rules: deepen dk2 until every text role passes.
  for (let i = 0; i < 6 && themeContrastProblems(themeOfDeck({ theme: themeId, palette: p })).length; i++) {
    const [h, s, l] = hexToHsl(p.dk2!);
    p.dk2 = hslToHex(h, s, Math.max(0.04, l - 0.04));
    if (p.dk1) p.dk1 = shiftL(p.dk1, Math.max(0.02, hexToHsl(p.dk1)[2] - 0.02));
  }
  return p;
}

/** Whether white text keeps 4.5:1 on a colour (for the editor's palette swatches). */
export function whiteReadable(hex: string): boolean {
  return contrastRatio(hex, '#FFFFFF') >= 4.5;
}

// ── Make this slide visual ───────────────────────────────────────────

const DATE = /\b(?:q[1-4]|h[12]|20\d\d|19\d\d|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|week\s*\d+|day\s*\d+|month\s*\d+|phase\s*\d+|year\s*\d+)\b/i;
const NUMBER = /^[^\w]*(?:[£$€¥₹]\s?)?\d[\d.,]*\s?(?:%|[kmb]n?|x|×|bn|m|k)?\b/i;

function splitItem(text: string): InfoItem {
  const t = plainOf(text).trim();
  const m = /^(.{2,48}?)\s*(?::|—|–|\s-\s)\s+(.+)$/.exec(t);
  if (m) return { title: m[1]!.trim(), text: m[2]!.trim() };
  return { title: t };
}

/** Pull a leading figure ("42% of users…", "£4.2m ARR") out as the item's value. */
function withValue(it: InfoItem): InfoItem {
  const src = it.title;
  const m = NUMBER.exec(src);
  if (!m || m[0].trim().length > 12) return it;
  const value = m[0].trim().replace(/[^\w%£$€¥₹.,×]+$/, '');
  const rest = src.slice(m.index + m[0].length).replace(/^\s*(?:[-–—:]|of|in)?\s*/i, '').trim();
  if (!rest) return it;
  return { ...it, value, title: rest.charAt(0).toUpperCase() + rest.slice(1) };
}

/** The best infographic kind for some items and a slide title. */
export function chooseKind(items: InfoItem[], title = '', layout?: Slide['layout']): InfographicKind {
  const text = `${title} ${items.map(i => `${i.title} ${i.text ?? ''}`).join(' ')}`.toLowerCase();
  const n = items.length;
  const titles = items.map(i => i.title.toLowerCase());
  if (layout === 'agenda') return 'agenda';
  if (n === 4 && /strength/.test(titles[0] ?? '') && /weak/.test(titles[1] ?? '')) return 'swot';
  if (n === 2 && /\bpros?\b|advantage|benefit/.test(titles[0] ?? '') && /\bcons?\b|disadvantage|risk|drawback/.test(titles[1] ?? '')) return 'pros-cons';
  if (n === 2 && /before|today|current|as-is|old/.test(titles[0] ?? '') && /after|future|to-be|new|tomorrow/.test(titles[1] ?? '')) return 'before-after';
  if (n === 2 && /\bvs\.?\b|versus|compare|option|alternative/.test(text)) return 'versus';
  if (n >= 2 && n <= 5 && /\b(decid|decision|approv|sign[- ]?off|we ask)/i.test(title)) return 'decisions';
  const values = items.filter(i => i.value).length;
  if (values >= Math.max(2, n - 1)) {
    const pcts = items.filter(i => /%/.test(i.value ?? '') && percentOf(i.value) !== undefined).length;
    if (pcts >= n - 1) return n >= 4 ? 'stat-bars' : 'rings';
    if (/funnel|conversion|pipeline|leads|visitors/.test(text)) return 'funnel';
    if (n <= 4) return 'tiles';
  }
  if (items.filter(i => DATE.test(`${i.value ?? ''} ${i.title}`)).length >= Math.max(2, n - 1)) return /roadmap|plan|phase|milestone/.test(text) ? 'roadmap' : 'timeline';
  if (/cycle|loop|continuous|iterat|recurring|lifecycle|feedback/.test(text) && n >= 3 && n <= 6) return 'cycle';
  if (/funnel|conversion|pipeline/.test(text) && n >= 3 && n <= 6) return 'funnel';
  if (/pyramid|hierarchy|level|tier|foundation|maturity/.test(text) && n >= 3 && n <= 6) return /maturity|level/.test(text) ? 'stairs' : 'pyramid';
  if (/step|process|how it works|how to|workflow|stage|journey|first|then|finally|onboard/.test(text) && n >= 3 && n <= 6) return n <= 5 ? 'process' : 'arrows';
  if (/pillar|capabilit|component|module|service|feature/.test(text) && n >= 3 && n <= 7) return n <= 4 ? 'cards' : 'hexagons';
  if (/core|centre|center|around|hub|ecosystem/.test(text) && n >= 3 && n <= 7) return 'radial';
  if (n <= 4 && n >= 2) return 'cards';
  if (n <= 8) return 'icon-grid';
  return 'icon-grid';
}

/**
 * A text slide as an infographic slide: same title, notes and source; every
 * bullet kept as an item (sub-points join their item's text); a kind chosen
 * from the content (or the one asked for); an icon per item where one fits.
 * Returns undefined when the slide has nothing to turn into items.
 */
export function makeVisual(slide: Slide, kindAsked?: string): Slide | undefined {
  const items: InfoItem[] = [];
  const from = (b: { text: string; level?: 0 | 1 }): void => {
    if (b.level === 1 && items.length) {
      const last = items[items.length - 1]!;
      last.text = last.text ? `${last.text}\n${plainOf(b.text)}` : plainOf(b.text);
    } else items.push(splitItem(b.text));
  };
  if (slide.bullets?.length) slide.bullets.forEach(from);
  else if (slide.left || slide.right) {
    for (const col of [slide.left, slide.right]) {
      if (!col) continue;
      items.push({ title: col.heading ?? '', text: [col.body, ...(col.bullets ?? []).map(b => plainOf(b.text))].filter(Boolean).join('\n') });
    }
  } else if (slide.kpis?.length) slide.kpis.forEach(k => items.push({ title: k.label, value: k.value, ...(k.delta ? { text: k.delta } : {}) }));
  else if (slide.timeline?.length) slide.timeline.forEach(m => items.push({ title: m.title, value: m.date, ...(m.text ? { text: m.text } : {}) }));
  if (!items.length) return undefined;
  const valued = items.map(withValue);
  const useValues = valued.filter(i => i.value).length >= Math.max(2, items.length - 1);
  const list = useValues ? valued : items;
  const asked = toInfographicKind(kindAsked);
  const kind = asked ?? chooseKind(list, slide.title, slide.layout);
  const info = infographicInfo(kind);
  const taken = new Set<string>();
  const withIcons = list.map((it) => {
    if (!info.uses.includes('icon') || it.icon) return it;
    const icon = iconFor(`${it.title} ${it.text ?? ''}`, taken);
    if (icon) taken.add(icon);
    return icon ? { ...it, icon } : it;
  });
  const next: Slide = {
    id: slide.id, layout: 'infographic', ...(slide.title ? { title: slide.title } : {}),
    infographic: { kind, items: withIcons.slice(0, Math.max(info.max, withIcons.length)) },
    ...(slide.body && slide.bullets?.length ? { body: slide.body } : {}),
    ...(slide.notes ? { notes: slide.notes } : {}), ...(slide.source ? { source: slide.source } : {}), ...(slide.transition ? { transition: slide.transition } : {}),
  };
  return next;
}

/** An abstract art picture in the theme's colours, for a slot with no photo. */
export function artImage(style: 'mesh' | 'circles' | 'waves' | 'grid' | 'blocks' = 'mesh', alt = 'Abstract pattern in the theme colours'): DeckImage {
  return { src: `art:${style}`, alt };
}
