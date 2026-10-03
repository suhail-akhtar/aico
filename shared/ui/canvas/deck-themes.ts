/**
 * Deck themes — the design systems a presentation is drawn in: a font pair,
 * a ten-slot colour scheme, how title and section slides are treated, the
 * accent motif content slides carry, and the chart palette.
 *
 * ## Why colours are scheme slots, not hex
 *
 * A PowerPoint theme is ten colour slots (dk1, lt1, dk2, lt2, accent1–6) and
 * two fonts (major, minor). When the text and shapes of a slide refer to
 * those slots (`schemeClr`, `+mj-lt`) instead of fixed values, the person can
 * pick another variant in PowerPoint's Design tab and the whole deck — titles,
 * accent bars, table headers, chart series — follows. So every colour here is
 * a {@link ColorRef}: a slot plus PowerPoint's own luminance modifiers
 * (`lumMod`/`lumOff`) and alpha. {@link resolveColor} computes the same
 * colour for the HTML renderer with PowerPoint's HSL arithmetic, so the app
 * and PowerPoint show one colour, and the .pptx writer emits the slot.
 *
 * ## What makes the themes different
 *
 * Not just colour: each theme chooses a title treatment (full colour field,
 * split panel, band, minimal, framed), a section treatment (colour field,
 * giant number, side panel), a content motif (accent bar beside the title,
 * underline, corner block, top band, side rule…), card corner radius and a
 * font pair from the fonts Windows and Office ship (measured in
 * `deck-fonts.ts`), with web-safe fallbacks for the browser on other systems.
 *
 * @module shared/ui/canvas/deck-themes
 */

export type SchemeSlot = 'dk1' | 'lt1' | 'dk2' | 'lt2' | 'accent1' | 'accent2' | 'accent3' | 'accent4' | 'accent5' | 'accent6';

/** A colour as PowerPoint names it: a scheme slot, optionally lightened/darkened and transparent. */
export interface ColorRef {
  s: SchemeSlot;
  /** lumMod, 0–1 (multiply luminance). */
  mod?: number;
  /** lumOff, 0–1 (add luminance). */
  off?: number;
  /** Opacity 0–1. */
  a?: number;
}

export type TitleStyle = 'field' | 'split' | 'band' | 'minimal' | 'frame';
export type SectionStyle = 'field' | 'number' | 'side';
export type Motif = 'bar' | 'underline' | 'corner' | 'band' | 'side' | 'rule' | 'dot';

export interface DeckTheme {
  id: string;
  name: string;
  description: string;
  fonts: { heading: string; body: string };
  /** Titles in bold (a font that is already heavy, like Franklin Gothic Medium, is not). */
  headingBold: boolean;
  scheme: Record<SchemeSlot, string>;
  title: TitleStyle;
  section: SectionStyle;
  motif: Motif;
  /** Content slides on the dark slot (dk2) rather than lt1. */
  dark: boolean;
  /** Card corner radius in points (0 = square). */
  radius: number;
  /** Small labels (kickers, section numbers) in capitals with tracking. */
  caps: boolean;
}

export interface ThemeRoles {
  bg: ColorRef;
  text: ColorRef;
  muted: ColorRef;
  title: ColorRef;
  accent: ColorRef;
  accent2: ColorRef;
  line: ColorRef;
  surface: ColorRef;
  /** Text on an accent or dark fill. */
  onFill: ColorRef;
  titleBg: ColorRef;
  titleText: ColorRef;
  titleMuted: ColorRef;
  sectionBg: ColorRef;
  sectionText: ColorRef;
  good: string;
  bad: string;
}

const T = (s: SchemeSlot, mod?: number, off?: number, a?: number): ColorRef => ({
  s, ...(mod !== undefined ? { mod } : {}), ...(off !== undefined ? { off } : {}), ...(a !== undefined ? { a } : {}),
});

/** What each part of a slide is coloured with. */
export function roles(t: DeckTheme): ThemeRoles {
  if (t.dark) {
    return {
      bg: T('dk2'), text: T('lt1', 0.92), muted: T('lt1', 0.68), title: T('lt1'), accent: T('accent1'), accent2: T('accent2'),
      line: T('dk2', 1, 0.16), surface: T('dk2', 1, 0.07), onFill: T('dk2'),
      titleBg: T('dk2'), titleText: T('lt1'), titleMuted: T('lt1', 0.72),
      sectionBg: T('dk1'), sectionText: T('lt1'), good: '#34D399', bad: '#F87171',
    };
  }
  return {
    bg: T('lt1'), text: T('dk1'), muted: T('dk1', 0.55, 0.42), title: T('dk2'), accent: T('accent1'), accent2: T('accent2'),
    line: T('dk1', 0.12, 0.86), surface: T('lt2'), onFill: T('lt1'),
    titleBg: T('dk2'), titleText: T('lt1'), titleMuted: T('lt1', 0.8),
    sectionBg: t.section === 'field' ? T('accent1') : T('dk2'), sectionText: T('lt1'), good: '#15803D', bad: '#B91C1C',
  };
}

export const DECK_THEMES: readonly DeckTheme[] = [
  {
    id: 'slate', name: 'Slate', description: 'Charcoal and teal, split title — technical briefings',
    fonts: { heading: 'Segoe UI Semibold', body: 'Segoe UI' }, headingBold: false,
    scheme: { dk1: '#1F2A30', lt1: '#FFFFFF', dk2: '#22313A', lt2: '#EEF3F4', accent1: '#0F9D8A', accent2: '#3B82C4', accent3: '#F2A93B', accent4: '#7A8C99', accent5: '#C2577A', accent6: '#5BB98C' },
    title: 'split', section: 'side', motif: 'bar', dark: false, radius: 6, caps: true,
  },
  {
    id: 'boardroom', name: 'Boardroom', description: 'Navy and gold with a serif — board and investor updates',
    fonts: { heading: 'Georgia', body: 'Segoe UI' }, headingBold: false,
    scheme: { dk1: '#1D2433', lt1: '#FFFFFF', dk2: '#14213D', lt2: '#F3F1EA', accent1: '#B8892B', accent2: '#2F5D8C', accent3: '#7D8BA1', accent4: '#C9A86A', accent5: '#4E7F6B', accent6: '#A3473E' },
    title: 'field', section: 'number', motif: 'rule', dark: false, radius: 0, caps: true,
  },
  {
    id: 'ember', name: 'Ember', description: 'Warm orange on charcoal, bold sans — pitch decks',
    fonts: { heading: 'Franklin Gothic Medium', body: 'Segoe UI' }, headingBold: false,
    scheme: { dk1: '#1C1917', lt1: '#FFFFFF', dk2: '#1C1917', lt2: '#FBF3EC', accent1: '#EA580C', accent2: '#F59E0B', accent3: '#57534E', accent4: '#FB923C', accent5: '#A8A29E', accent6: '#B45309' },
    title: 'field', section: 'number', motif: 'underline', dark: false, radius: 10, caps: true,
  },
  {
    id: 'ocean', name: 'Ocean', description: 'Corporate blues with a title band — project status and sales',
    fonts: { heading: 'Calibri', body: 'Calibri' }, headingBold: true,
    scheme: { dk1: '#1B2B3A', lt1: '#FFFFFF', dk2: '#0B3B60', lt2: '#EAF2FA', accent1: '#1E78C8', accent2: '#16A3A3', accent3: '#F0A830', accent4: '#5D6D7E', accent5: '#8E5BC4', accent6: '#E2574C' },
    title: 'band', section: 'field', motif: 'band', dark: false, radius: 4, caps: false,
  },
  {
    id: 'meadow', name: 'Meadow', description: 'Fresh greens, friendly humanist sans — training',
    fonts: { heading: 'Trebuchet MS', body: 'Trebuchet MS' }, headingBold: true,
    scheme: { dk1: '#1F2D24', lt1: '#FFFFFF', dk2: '#1E4D35', lt2: '#EEF6EF', accent1: '#2E8B57', accent2: '#E9A23B', accent3: '#4A90A4', accent4: '#9BC53D', accent5: '#C5523F', accent6: '#7A6F9B' },
    title: 'split', section: 'field', motif: 'dot', dark: false, radius: 12, caps: false,
  },
  {
    id: 'mono', name: 'Mono', description: 'Black, white and one red — conference talks',
    fonts: { heading: 'Arial', body: 'Arial' }, headingBold: true,
    scheme: { dk1: '#111111', lt1: '#FFFFFF', dk2: '#111111', lt2: '#F2F2F2', accent1: '#E63946', accent2: '#457B9D', accent3: '#8D99AE', accent4: '#1D3557', accent5: '#F4A261', accent6: '#2A9D8F' },
    title: 'minimal', section: 'number', motif: 'underline', dark: false, radius: 0, caps: true,
  },
  {
    id: 'aurora', name: 'Aurora', description: 'Indigo and violet, geometric — keynotes',
    fonts: { heading: 'Century Gothic', body: 'Segoe UI' }, headingBold: true,
    scheme: { dk1: '#1E1B3A', lt1: '#FFFFFF', dk2: '#25215C', lt2: '#F1EFFB', accent1: '#7C5CFA', accent2: '#E0569B', accent3: '#22B8CF', accent4: '#F6A93B', accent5: '#4B4891', accent6: '#9AA5B1' },
    title: 'field', section: 'field', motif: 'corner', dark: false, radius: 14, caps: true,
  },
  {
    id: 'midnight', name: 'Midnight', description: 'Dark slides with cyan accents — engineering talks',
    fonts: { heading: 'Bahnschrift', body: 'Segoe UI' }, headingBold: false,
    scheme: { dk1: '#060B16', lt1: '#F8FAFC', dk2: '#0F172A', lt2: '#1E293B', accent1: '#22D3EE', accent2: '#A78BFA', accent3: '#F472B6', accent4: '#FBBF24', accent5: '#34D399', accent6: '#94A3B8' },
    title: 'minimal', section: 'side', motif: 'band', dark: true, radius: 8, caps: true,
  },
  {
    id: 'sandstone', name: 'Sandstone', description: 'Terracotta, cream and a book serif — editorial',
    fonts: { heading: 'Palatino Linotype', body: 'Gill Sans MT' }, headingBold: false,
    scheme: { dk1: '#2E2420', lt1: '#FFFDF9', dk2: '#3E2C23', lt2: '#F4ECE2', accent1: '#B4532A', accent2: '#6B8F71', accent3: '#D4A24C', accent4: '#8C6A5A', accent5: '#4F6D8A', accent6: '#A35C7A' },
    title: 'frame', section: 'number', motif: 'rule', dark: false, radius: 2, caps: true,
  },
  {
    id: 'coral', name: 'Coral', description: 'Coral on navy, slab headings — sales and marketing',
    fonts: { heading: 'Rockwell', body: 'Calibri' }, headingBold: false,
    scheme: { dk1: '#22313F', lt1: '#FFFFFF', dk2: '#22313F', lt2: '#FFF1EE', accent1: '#F25F4C', accent2: '#2C7DA0', accent3: '#F7B32B', accent4: '#5C6B73', accent5: '#69B578', accent6: '#9C6ADE' },
    title: 'band', section: 'field', motif: 'corner', dark: false, radius: 8, caps: false,
  },
  {
    id: 'forest', name: 'Forest', description: 'Deep green and brass, classic serif — strategy',
    fonts: { heading: 'Cambria', body: 'Calibri' }, headingBold: true,
    scheme: { dk1: '#1D2A22', lt1: '#FFFFFF', dk2: '#1F3B2D', lt2: '#F1F4EE', accent1: '#C08B3E', accent2: '#3F7D5A', accent3: '#7A9E7E', accent4: '#D9B26F', accent5: '#56707F', accent6: '#A2513B' },
    title: 'field', section: 'side', motif: 'side', dark: false, radius: 0, caps: true,
  },
  {
    id: 'scholar', name: 'Scholar', description: 'Blue and amber, readable serif — teaching',
    fonts: { heading: 'Constantia', body: 'Corbel' }, headingBold: true,
    scheme: { dk1: '#1E2A38', lt1: '#FFFFFF', dk2: '#1D4E89', lt2: '#EEF3FA', accent1: '#1D6FD1', accent2: '#F2A541', accent3: '#3AA17E', accent4: '#C0504D', accent5: '#7E57C2', accent6: '#6D7B8D' },
    title: 'frame', section: 'field', motif: 'bar', dark: false, radius: 6, caps: false,
  },
];

export function deckTheme(id: string | undefined): DeckTheme {
  const k = (id ?? '').trim().toLowerCase();
  return DECK_THEMES.find(t => t.id === k || t.name.toLowerCase() === k) ?? DECK_THEMES[0]!;
}

export function isDeckTheme(id: unknown): boolean {
  return typeof id === 'string' && DECK_THEMES.some(t => t.id === id.trim().toLowerCase() || t.name.toLowerCase() === id.trim().toLowerCase());
}

// ── Colour arithmetic (PowerPoint's) ─────────────────────────────────

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  return [parseInt(h.slice(0, 2), 16) / 255, parseInt(h.slice(2, 4), 16) / 255, parseInt(h.slice(4, 6), 16) / 255];
}

function rgbToHsl([r, g, b]: [number, number, number]): [number, number, number] {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h / 6, s, l];
}

function hslToRgb([h, s, l]: [number, number, number]): [number, number, number] {
  if (s === 0) return [l, l, l];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const f = (t: number): number => {
    let x = t;
    if (x < 0) x += 1;
    if (x > 1) x -= 1;
    if (x < 1 / 6) return p + (q - p) * 6 * x;
    if (x < 1 / 2) return q;
    if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6;
    return p;
  };
  return [f(h + 1 / 3), f(h), f(h - 1 / 3)];
}

const hex2 = (n: number): string => Math.round(Math.max(0, Math.min(1, n)) * 255).toString(16).padStart(2, '0');

/** The colour PowerPoint draws for a reference, as #RRGGBB (alpha separately). */
export function resolveHex(theme: DeckTheme, ref: ColorRef): string {
  const base = theme.scheme[ref.s];
  if (ref.mod === undefined && ref.off === undefined) return base.toUpperCase();
  const [h, s, l] = rgbToHsl(hexToRgb(base));
  const nl = Math.max(0, Math.min(1, l * (ref.mod ?? 1) + (ref.off ?? 0)));
  const [r, g, b] = hslToRgb([h, s, nl]);
  return `#${hex2(r)}${hex2(g)}${hex2(b)}`.toUpperCase();
}

/** CSS colour for a reference (rgba when it is transparent). */
export function cssColor(theme: DeckTheme, ref: ColorRef | string): string {
  if (typeof ref === 'string') return ref;
  const hex = resolveHex(theme, ref);
  if (ref.a === undefined || ref.a >= 1) return hex;
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)}, ${ref.a})`;
}

/** The six chart colours (accent1–6), resolved. */
export function chartPalette(theme: DeckTheme): string[] {
  return (['accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6'] as const).map(s => theme.scheme[s]);
}

// ── Fonts in CSS ─────────────────────────────────────────────────────

const FALLBACK: Record<string, string> = {
  'Segoe UI': '"Segoe UI", -apple-system, "Helvetica Neue", Arial, sans-serif',
  'Segoe UI Semibold': '"Segoe UI Semibold", "Segoe UI", -apple-system, "Helvetica Neue", Arial, sans-serif',
  'Segoe UI Light': '"Segoe UI Light", "Segoe UI", -apple-system, "Helvetica Neue", Arial, sans-serif',
  Georgia: 'Georgia, "Times New Roman", serif',
  Arial: 'Arial, "Helvetica Neue", Helvetica, sans-serif',
  'Trebuchet MS': '"Trebuchet MS", "Lucida Grande", sans-serif',
  Calibri: 'Calibri, Carlito, "Segoe UI", sans-serif',
  Cambria: 'Cambria, Caladea, Georgia, serif',
  'Century Gothic': '"Century Gothic", "Avenir Next", Futura, sans-serif',
  'Franklin Gothic Medium': '"Franklin Gothic Medium", "Arial Narrow", "Helvetica Neue", sans-serif',
  'Palatino Linotype': '"Palatino Linotype", Palatino, "Book Antiqua", serif',
  'Gill Sans MT': '"Gill Sans MT", "Gill Sans", Calibri, sans-serif',
  Bahnschrift: 'Bahnschrift, "DIN Alternate", "Segoe UI", sans-serif',
  Rockwell: 'Rockwell, "Roboto Slab", Georgia, serif',
  Constantia: 'Constantia, Georgia, serif',
  Corbel: 'Corbel, "Segoe UI", sans-serif',
  Consolas: 'Consolas, "Cascadia Code", Menlo, monospace',
};

export function cssFont(font: string): string {
  return FALLBACK[font] ?? `"${font.replace(/"/g, '')}", sans-serif`;
}
