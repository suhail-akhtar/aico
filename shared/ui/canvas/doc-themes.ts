/**
 * AICO Docs' document themes — one designed look per kind of document
 * (report, research paper, letter, CV, invoice, legal, …) — and the page
 * widths of the editor.
 *
 * ## Why one table, read by the app and by every export
 *
 * The owner's report was that documents "look plain" next to Claude
 * Desktop's: every document had the same Georgia headings, the same grey
 * tables and the same blue. A theme fixes that per *type*, not per
 * document: typography pair, accent colour, heading style, header/footer
 * and cover variant, table style. The editor page and the HTML/PDF/DOCX
 * writers (`src/canvas/export.ts`, `src/canvas/docx.ts`) read this same
 * table, so the page you edit is the page you export. The CSS rules are
 * generated here with a scope (`themeRules`) for the same reason — one set
 * of rules, two places they apply.
 *
 * ## Restraint, on purpose
 *
 * Every theme is a few switches over one base, not a stylesheet of its
 * own: a muted accent, at most two font families, four heading styles, four
 * table styles. Sixteen hand-styled sheets would drift and be impossible to
 * keep consistent across Word and PDF; switches map one-to-one onto both.
 * Colours in the app are mixed with the UI's own text colour
 * (`--dt-accent-ui`) so a dark navy accent stays readable in dark mode.
 *
 * A theme supplies *defaults* for other settings (a confidential document
 * gets a watermark and a classification banner; a letter wide margins);
 * values stored on the document always win.
 *
 * DOM-free and Node-importable (the engine imports it).
 *
 * @module shared/ui/canvas/doc-themes
 */

export type ThemeId =
  | 'report' | 'research' | 'letter' | 'memo' | 'cv' | 'proposal' | 'invoice' | 'sop'
  | 'legal' | 'spec' | 'release-notes' | 'minutes' | 'case-study' | 'press-release' | 'risk' | 'confidential';

export type HeadingStyle = 'classic' | 'rule' | 'bar' | 'caps';
export type TableStyle = 'grid' | 'lined' | 'banded' | 'minimal';
export type CoverStyle = 'classic' | 'band' | 'minimal';
export type HeaderStyle = 'plain' | 'rule' | 'letterhead';

export interface DocTheme {
  id: ThemeId;
  label: string;
  description: string;
  /** `#RRGGBB`. Muted on purpose. */
  accent: string;
  /** The body face this theme starts with (the document may change it). */
  font: 'sans' | 'serif';
  /** Headings: their own face, or the body's. */
  heading: 'sans' | 'serif' | 'body';
  headingStyle: HeadingStyle;
  /** Number H2/H3 as 1, 1.1 (research, legal, SOP, spec). */
  numbered: boolean;
  table: TableStyle;
  cover: CoverStyle;
  header: HeaderStyle;
  justify?: boolean;
  /** Block quotes as large pull quotes (case studies). */
  pullQuotes?: boolean;
  /** The title centred (press release). */
  centerTitle?: boolean;
  /** H3 as a small accent label (release notes: Added / Fixed / Changed). */
  labelH3?: boolean;
  /** Settings this theme implies unless the document sets them. */
  defaults: {
    margins?: 'narrow' | 'normal' | 'wide';
    watermark?: string;
    classification?: string;
    pageNumbers?: boolean;
    toc?: boolean;
    footer?: string;
  };
}

const T = (t: DocTheme): DocTheme => t;

export const DOC_THEMES: readonly DocTheme[] = [
  T({ id: 'report', label: 'Report / Whitepaper', description: 'Serif headings over a clean sans body, navy accent, banded tables, a full-bleed cover band.',
    accent: '#1F3A5F', font: 'sans', heading: 'serif', headingStyle: 'classic', numbered: false, table: 'banded', cover: 'band', header: 'rule', defaults: { pageNumbers: true } }),
  T({ id: 'research', label: 'Research paper', description: 'Academic: serif, justified, numbered sections, ruled (booktabs) tables, abstract and references.',
    accent: '#7F1D1D', font: 'serif', heading: 'serif', headingStyle: 'classic', numbered: true, table: 'lined', cover: 'minimal', header: 'plain', justify: true, defaults: { pageNumbers: true } }),
  T({ id: 'letter', label: 'Letter', description: 'Letterhead from the header text, serif body, wide margins, signature block.',
    accent: '#1E3A8A', font: 'serif', heading: 'serif', headingStyle: 'classic', numbered: false, table: 'minimal', cover: 'minimal', header: 'letterhead', defaults: { margins: 'wide', pageNumbers: false } }),
  T({ id: 'memo', label: 'Memo', description: 'Internal memo: compact sans, small-caps headings, To/From details box.',
    accent: '#374151', font: 'sans', heading: 'body', headingStyle: 'caps', numbered: false, table: 'lined', cover: 'minimal', header: 'rule', defaults: { pageNumbers: false } }),
  T({ id: 'cv', label: 'CV / Résumé', description: 'Two columns with a shaded sidebar, teal accent, small-caps section heads.',
    accent: '#0F766E', font: 'sans', heading: 'body', headingStyle: 'caps', numbered: false, table: 'minimal', cover: 'minimal', header: 'plain', defaults: { margins: 'narrow', pageNumbers: false } }),
  T({ id: 'proposal', label: 'Proposal / SOW / RFP', description: 'Cover band, summary box, pricing tables with computed totals, indigo accent.',
    accent: '#3730A3', font: 'sans', heading: 'serif', headingStyle: 'rule', numbered: false, table: 'banded', cover: 'band', header: 'rule', defaults: { pageNumbers: true } }),
  T({ id: 'invoice', label: 'Invoice / Quote / BOQ', description: 'Line items with subtotal, tax and total; details box; quiet ink accent.',
    accent: '#1D4ED8', font: 'sans', heading: 'body', headingStyle: 'caps', numbered: false, table: 'minimal', cover: 'minimal', header: 'plain', defaults: { margins: 'narrow', pageNumbers: false } }),
  T({ id: 'sop', label: 'SOP / Procedure', description: 'Numbered sections and procedures, warning callouts, document-control box.',
    accent: '#B45309', font: 'sans', heading: 'body', headingStyle: 'bar', numbered: true, table: 'grid', cover: 'minimal', header: 'rule', defaults: { pageNumbers: true, footer: 'Controlled document — {date}' } }),
  T({ id: 'legal', label: 'Legal / NDA', description: 'Serif, numbered clauses (1, 1.1), restrained black, signature blocks.',
    accent: '#1C1917', font: 'serif', heading: 'serif', headingStyle: 'classic', numbered: true, table: 'grid', cover: 'minimal', header: 'plain', justify: true, defaults: { pageNumbers: true } }),
  T({ id: 'spec', label: 'PRD / Technical spec', description: 'Code-friendly: sans, numbered sections, monospaced code, blue accent.',
    accent: '#2563EB', font: 'sans', heading: 'body', headingStyle: 'rule', numbered: true, table: 'grid', cover: 'minimal', header: 'rule', defaults: { pageNumbers: true, toc: true } }),
  T({ id: 'release-notes', label: 'Release notes', description: 'Version headings, Added / Fixed / Changed labels, green accent.',
    accent: '#047857', font: 'sans', heading: 'body', headingStyle: 'rule', numbered: false, table: 'minimal', cover: 'minimal', header: 'plain', labelH3: true, defaults: { pageNumbers: false } }),
  T({ id: 'minutes', label: 'Meeting minutes', description: 'Attendees box, decisions, an action-items table, slate accent.',
    accent: '#475569', font: 'sans', heading: 'body', headingStyle: 'caps', numbered: false, table: 'lined', cover: 'minimal', header: 'rule', defaults: { pageNumbers: true } }),
  T({ id: 'case-study', label: 'Case study', description: 'Big numbers, pull quotes, warm accent.',
    accent: '#C2410C', font: 'sans', heading: 'serif', headingStyle: 'bar', numbered: false, table: 'banded', cover: 'band', header: 'plain', pullQuotes: true, defaults: { pageNumbers: false } }),
  T({ id: 'press-release', label: 'Press release', description: 'Centred headline, dateline, boilerplate; black and white.',
    accent: '#111827', font: 'serif', heading: 'serif', headingStyle: 'classic', numbered: false, table: 'lined', cover: 'minimal', header: 'plain', centerTitle: true, defaults: { pageNumbers: false } }),
  T({ id: 'risk', label: 'Risk assessment', description: 'Likelihood × impact matrix, risk register, red accent.',
    accent: '#B91C1C', font: 'sans', heading: 'body', headingStyle: 'bar', numbered: true, table: 'grid', cover: 'minimal', header: 'rule', defaults: { pageNumbers: true } }),
  T({ id: 'confidential', label: 'Confidential', description: 'Classification banner on every page and a watermark; sober dark red.',
    accent: '#991B1B', font: 'sans', heading: 'serif', headingStyle: 'rule', numbered: false, table: 'grid', cover: 'classic', header: 'rule',
    defaults: { watermark: 'CONFIDENTIAL', classification: 'CONFIDENTIAL', pageNumbers: true } }),
];

const ALIASES: Record<string, ThemeId> = {
  whitepaper: 'report', 'white-paper': 'report', academic: 'research', paper: 'research', resume: 'cv', 'résumé': 'cv',
  sow: 'proposal', rfp: 'proposal', quote: 'invoice', quotation: 'invoice', boq: 'invoice', nda: 'legal', contract: 'legal',
  prd: 'spec', api: 'spec', technical: 'spec', 'technical-spec': 'spec', changelog: 'release-notes', release: 'release-notes',
  'meeting-minutes': 'minutes', press: 'press-release', 'risk-assessment': 'risk', procedure: 'sop', policy: 'sop',
};

/** A theme by id or alias; undefined for none/unknown (the plain look). */
export function themeById(id: unknown): DocTheme | undefined {
  if (typeof id !== 'string') return undefined;
  const key = id.toLowerCase().trim().replace(/[\s_/]+/g, '-');
  const want = ALIASES[key] ?? key;
  return DOC_THEMES.find(t => t.id === want);
}

// ── Fonts ────────────────────────────────────────────────────────────

export const FONT_STACKS = {
  sans: "'Inter', 'Segoe UI', system-ui, -apple-system, 'Helvetica Neue', Arial, sans-serif",
  serif: "'Source Serif 4', 'Source Serif Pro', Georgia, 'Iowan Old Style', 'Times New Roman', serif",
  mono: "'Cascadia Code', 'JetBrains Mono', Consolas, ui-monospace, monospace",
} as const;

/** Word's faces for the same choices (installed with Office). */
export const DOCX_FONTS = { sans: 'Calibri', serif: 'Georgia', mono: 'Consolas' } as const;

/** Body and heading faces for a theme and the document's font choice. */
export function themeFaces(theme: DocTheme | undefined, font: 'sans' | 'serif' | undefined): { body: 'sans' | 'serif'; heading: 'sans' | 'serif' } {
  const body = font ?? theme?.font ?? 'sans';
  if (!theme) return { body, heading: body };
  return { body, heading: theme.heading === 'body' ? body : theme.heading };
}

// ── Colour ───────────────────────────────────────────────────────────

/** `#RRGGBB` or undefined. */
export function cleanHex(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const m = /^#?([0-9a-f]{6})$/i.exec(v.trim());
  return m ? `#${m[1]!.toUpperCase()}` : undefined;
}

/** `a` mixed toward white by `1 - amount` — the tint Word needs as a literal (it has no color-mix). */
export function tint(hex: string, amount: number): string {
  const h = cleanHex(hex) ?? '#2563EB';
  const c = [1, 3, 5].map(i => Number.parseInt(h.slice(i, i + 2), 16));
  return c.map(x => Math.round(x * amount + 255 * (1 - amount)).toString(16).padStart(2, '0')).join('').toUpperCase();
}

// ── Page widths (the editor only) ────────────────────────────────────

export type PageWidth = 'narrow' | 'normal' | 'wide' | 'full';
export const PAGE_WIDTHS: ReadonlyArray<{ id: PageWidth; label: string; px: number | null }> = [
  { id: 'narrow', label: 'Narrow', px: 680 },
  // Letter paper at 96 dpi: a page that reads like a page.
  { id: 'normal', label: 'Normal', px: 816 },
  { id: 'wide', label: 'Wide', px: 1120 },
  { id: 'full', label: 'Full width', px: null },
];

/** The width to draw: the document's choice, else Normal beside the chat and Wide in full screen. */
export function pageWidthFor(stored: unknown, fullscreen: boolean): PageWidth {
  return PAGE_WIDTHS.some(w => w.id === stored) ? stored as PageWidth : fullscreen ? 'wide' : 'normal';
}

export function pageWidthPx(w: PageWidth): number | null {
  return PAGE_WIDTHS.find(x => x.id === w)?.px ?? null;
}

// ── Resolving a document's look ──────────────────────────────────────

export interface ThemeInput {
  theme?: unknown;
  accent?: unknown;
  font?: 'sans' | 'serif';
  classification?: unknown;
  watermark?: unknown;
}

export interface ResolvedLook {
  theme?: DocTheme;
  accent: string;
  faces: { body: 'sans' | 'serif'; heading: 'sans' | 'serif' };
  classification?: string;
  watermark?: string;
}

/**
 * What a document looks like: its theme, accent (override or the theme's),
 * faces, and the classification/watermark after the theme's defaults. An
 * explicit empty string clears a theme default (a "confidential" document
 * whose owner removed the watermark keeps it removed).
 */
export function resolveLook(s: ThemeInput, fallbackAccent = '#2563EB'): ResolvedLook {
  const theme = themeById(s.theme);
  const str = (v: unknown, d: string | undefined): string | undefined => (typeof v === 'string' ? (v.trim() || undefined) : d);
  return {
    ...(theme ? { theme } : {}),
    accent: cleanHex(s.accent) ?? theme?.accent ?? fallbackAccent,
    faces: themeFaces(theme, s.font),
    ...(str(s.classification, theme?.defaults.classification) ? { classification: str(s.classification, theme?.defaults.classification)! } : {}),
    ...(str(s.watermark, theme?.defaults.watermark) ? { watermark: str(s.watermark, theme?.defaults.watermark)! } : {}),
  };
}

/** Data attributes and CSS variables that switch the generated rules on for one page/body. */
export function themeAttrs(look: ResolvedLook): { attrs: Record<string, string>; vars: Record<string, string> } {
  const t = look.theme;
  const attrs: Record<string, string> = {};
  if (t) {
    attrs['data-dt'] = t.id;
    attrs['data-dt-heading'] = t.headingStyle;
    attrs['data-dt-table'] = t.table;
    if (t.numbered) attrs['data-dt-numbered'] = '1';
    if (t.justify) attrs['data-dt-justify'] = '1';
    if (t.pullQuotes) attrs['data-dt-pull'] = '1';
    if (t.centerTitle) attrs['data-dt-center'] = '1';
    if (t.labelH3) attrs['data-dt-label3'] = '1';
  }
  return {
    attrs,
    vars: {
      '--dt-accent': look.accent,
      '--dt-body': FONT_STACKS[look.faces.body],
      '--dt-head': FONT_STACKS[look.faces.heading],
    },
  };
}

/** `--a: b; --c: d` for a style attribute. */
export function styleText(vars: Record<string, string>): string {
  return Object.entries(vars).map(([k, v]) => `${k}: ${v}`).join('; ');
}

/**
 * The theme rules under `scope` (e.g. `body` in an export, the editor's page
 * element in the app). Everything keys off the attributes `themeAttrs` sets,
 * so an unthemed page is untouched. Colours come from `--dt-*` variables the
 * caller defines: in an export they are literal print colours; in the app
 * they are mixed with the UI's tokens so light and dark both read.
 */
export function themeRules(scope: string): string {
  const s = scope;
  const on = (attr: string): string => `${s}[${attr}]`;
  const h = (sel: string, tags: string[]): string => tags.map(t => `${sel} ${t}`).join(', ');
  return `
${on('data-dt')} { font-family: var(--dt-body); }
${h(on('data-dt'), ['h1', 'h2', 'h3', 'h4'])} { font-family: var(--dt-head); color: var(--dt-ink); }
${h(on('data-dt'), ['code', 'pre', 'kbd'])} { font-family: ${FONT_STACKS.mono}; }
${on('data-dt')} a { color: var(--dt-accent-ui); }
${on('data-dt-justify')} p { text-align: justify; hyphens: auto; }
${on('data-dt-center')} h1 { text-align: center; }
${on('data-dt-heading="classic"')} h1 { padding-bottom: 0.25em; border-bottom: 2px solid var(--dt-accent-ui); }
${on('data-dt-heading="classic"')} h2 { color: var(--dt-accent-ui); }
${on('data-dt-heading="rule"')} h2 { color: var(--dt-accent-ui); padding-bottom: 0.2em; border-bottom: 1px solid var(--dt-rule); }
${on('data-dt-heading="bar"')} h2 { padding-left: 0.55em; border-left: 4px solid var(--dt-accent-ui); }
${on('data-dt-heading="bar"')} h1 { color: var(--dt-accent-ui); }
${on('data-dt-heading="caps"')} h2 { font-size: 0.95em; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; color: var(--dt-accent-ui); padding-bottom: 0.25em; border-bottom: 1px solid var(--dt-accent-ui); }
${on('data-dt-heading="caps"')} h1 { letter-spacing: -0.01em; }
${on('data-dt-label3')} h3 { display: inline-block; font-size: 0.78em; font-weight: 700; text-transform: uppercase; letter-spacing: 0.07em; color: var(--dt-accent-ui); background: var(--dt-tint); padding: 0.15em 0.6em; border-radius: 4px; }
${on('data-dt-numbered')} { counter-reset: dt-h2 dt-h3; }
${on('data-dt-numbered')} h2 { counter-increment: dt-h2; counter-reset: dt-h3; }
${on('data-dt-numbered')} .adoc-block:has(h2) { counter-reset: dt-h3; }
${on('data-dt-numbered')} h3 { counter-increment: dt-h3; }
${on('data-dt-numbered')} h2::before { content: counter(dt-h2) ".\\00a0\\00a0"; color: var(--dt-accent-ui); }
${on('data-dt-numbered')} h3::before { content: counter(dt-h2) "." counter(dt-h3) "\\00a0\\00a0"; color: var(--dt-accent-ui); }
${on('data-dt-pull')} blockquote { border-left: 3px solid var(--dt-accent-ui); padding: 0.2em 0 0.2em 1em; font-family: var(--dt-head); font-size: 1.22em; font-style: italic; line-height: 1.45; color: var(--dt-ink); }
${on('data-dt')} table { border-collapse: collapse; }
${h(on('data-dt'), ['th', 'td'])} { padding: 7px 12px; }
${on('data-dt')} th { white-space: normal; }
${h(on('data-dt-table="grid"'), ['th', 'td'])} { border: 1px solid var(--dt-rule); }
${on('data-dt-table="grid"')} th { background: var(--dt-tint); }
${on('data-dt-table="lined"')} table { border-top: 2px solid var(--dt-ink); border-bottom: 2px solid var(--dt-ink); }
${h(on('data-dt-table="lined"'), ['th', 'td'])} { border: 0; border-bottom: 1px solid var(--dt-rule); }
${on('data-dt-table="lined"')} th { border-bottom: 1px solid var(--dt-ink); }
${on('data-dt-table="lined"')} tr:last-child td { border-bottom: 0; }
${h(on('data-dt-table="banded"'), ['th', 'td'])} { border: 0; border-bottom: 1px solid var(--dt-rule); }
${on('data-dt-table="banded"')} th { background: var(--dt-accent-fill); color: #fff; }
${on('data-dt-table="banded"')} tbody:not(.db-li-foot) tr:nth-child(even) td { background: var(--dt-tint); }
${h(on('data-dt-table="minimal"'), ['th', 'td'])} { border: 0; border-bottom: 1px solid var(--dt-rule); }
${on('data-dt-table="minimal"')} th { border-bottom: 2px solid var(--dt-accent-ui); }
`;
}
