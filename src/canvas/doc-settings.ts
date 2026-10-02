/**
 * Document setup for exports — page, margins, header/footer, cover, watermark,
 * font, table of contents (the document types that pick sensible values live in
 * `canvas/doc-types`).
 *
 * ## Why stored with the canvas
 *
 * A letter is always exported as a letter. Settings chosen once in the export
 * dialog (or by the agent from a template) belong to the document, so the next
 * export — from any client, or by the agent — produces the same file. An export
 * call may still override them for one file without saving.
 *
 * ## Why sanitised here, not trusted
 *
 * Settings arrive from HTTP bodies and model tool calls. Every field is
 * whitelisted and clamped (margins 5–60 mm, text 200 characters), so a bad
 * value becomes the default rather than a broken .docx or a 0-margin PDF.
 *
 * ## Themes (round 3)
 *
 * `theme` names a designed look per document type (`shared/ui/canvas/doc-themes`).
 * A theme also implies defaults — a confidential document's watermark and
 * banner, a letter's wide margins — that `resolveSettings` fills in *under*
 * whatever the document stores, so an owner's explicit choice always wins.
 *
 * @module canvas/doc-settings
 */

import { cleanHex, PAGE_WIDTHS, themeById, type PageWidth, type ThemeId } from '../../shared/ui/canvas/doc-themes.js';

export type PageSize = 'A4' | 'Letter';

export interface CoverPage {
  enabled: boolean;
  title?: string;
  subtitle?: string;
  author?: string;
  date?: string;
  /** A data URL or a path inside the project. */
  logo?: string;
}

export interface Margins { top: number; right: number; bottom: number; left: number }

export interface DocSettings {
  pageSize: PageSize;
  orientation: 'portrait' | 'landscape';
  /** Millimetres. */
  margins: Margins;
  font: 'sans' | 'serif';
  header?: string;
  footer?: string;
  pageNumbers: boolean;
  toc: boolean;
  watermark?: string;
  cover?: CoverPage;
  /** A document theme (round 3). */
  theme?: ThemeId;
  /** `#RRGGBB`, overriding the theme's accent. */
  accent?: string;
  /** A banner at the top and bottom of every page, e.g. CONFIDENTIAL. */
  classification?: string;
  /** The editor's page width; exports ignore it. */
  pageWidth?: PageWidth;
}

export const MARGIN_PRESETS: Record<'normal' | 'narrow' | 'wide', Margins> = {
  normal: { top: 25.4, right: 25.4, bottom: 25.4, left: 25.4 },
  narrow: { top: 12.7, right: 12.7, bottom: 12.7, left: 12.7 },
  wide: { top: 25.4, right: 50.8, bottom: 25.4, left: 50.8 },
};

export const DEFAULT_SETTINGS: DocSettings = {
  pageSize: 'A4', orientation: 'portrait', margins: MARGIN_PRESETS.normal, font: 'sans', pageNumbers: true, toc: false,
};

/** Page size in millimetres, portrait. */
export const PAGE_MM: Record<PageSize, { w: number; h: number }> = { A4: { w: 210, h: 297 }, Letter: { w: 215.9, h: 279.4 } };

function text(value: unknown, max = 200): string | undefined {
  if (typeof value !== 'string') return undefined;
  const t = value.replace(/[\u0000-\u001F]/g, ' ').trim();
  return t ? t.slice(0, max) : undefined;
}

function mm(value: unknown, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? Math.min(60, Math.max(5, n)) : fallback;
}

/** Clean a partial settings object. Unknown keys are dropped; bad values are ignored. `null` means "clear". */
export function cleanSettings(raw: unknown): Partial<Record<keyof DocSettings, unknown>> {
  const out: Partial<Record<keyof DocSettings, unknown>> = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  const r = raw as Record<string, unknown>;
  const has = (k: string): boolean => Object.prototype.hasOwnProperty.call(r, k);
  if (has('pageSize')) {
    const v = String(r.pageSize ?? '').toLowerCase();
    if (v === 'a4') out.pageSize = 'A4'; else if (v === 'letter') out.pageSize = 'Letter'; else if (r.pageSize === null) out.pageSize = null;
  }
  if (has('orientation')) {
    if (r.orientation === 'portrait' || r.orientation === 'landscape') out.orientation = r.orientation;
    else if (r.orientation === null) out.orientation = null;
  }
  if (has('margins')) {
    const m = r.margins;
    if (typeof m === 'string' && m in MARGIN_PRESETS) out.margins = MARGIN_PRESETS[m as keyof typeof MARGIN_PRESETS];
    else if (m && typeof m === 'object') {
      const o = m as Record<string, unknown>;
      const d = MARGIN_PRESETS.normal;
      out.margins = { top: mm(o.top, d.top), right: mm(o.right, d.right), bottom: mm(o.bottom, d.bottom), left: mm(o.left, d.left) };
    } else if (m === null) out.margins = null;
  }
  if (has('font')) {
    if (r.font === 'sans' || r.font === 'serif') out.font = r.font; else if (r.font === null) out.font = null;
  }
  for (const k of ['header', 'footer', 'watermark', 'classification'] as const) {
    // An empty watermark/classification is kept: it switches off a theme's default one.
    if (has(k)) out[k] = r[k] === null ? null : (k === 'watermark' || k === 'classification') && r[k] === '' ? '' : text(r[k], k === 'header' || k === 'footer' ? 200 : 40) ?? null;
  }
  if (has('theme')) {
    const t = themeById(r.theme);
    if (t) out.theme = t.id; else if (r.theme === null || r.theme === '' || r.theme === 'default' || r.theme === 'none') out.theme = null;
  }
  if (has('accent')) {
    const c = cleanHex(r.accent);
    if (c) out.accent = c; else if (r.accent === null || r.accent === '') out.accent = null;
  }
  if (has('pageWidth')) {
    if (PAGE_WIDTHS.some(w => w.id === r.pageWidth)) out.pageWidth = r.pageWidth as PageWidth; else if (r.pageWidth === null) out.pageWidth = null;
  }
  for (const k of ['pageNumbers', 'toc'] as const) {
    if (has(k)) { if (typeof r[k] === 'boolean') out[k] = r[k]; else if (r[k] === null) out[k] = null; }
  }
  if (has('cover')) {
    const c = r.cover;
    if (c === null || c === false) out.cover = null;
    else if (c === true) out.cover = { enabled: true };
    else if (c && typeof c === 'object') {
      const o = c as Record<string, unknown>;
      const logo = typeof o.logo === 'string' && o.logo.length <= 8_000_000 ? o.logo.trim() : undefined;
      out.cover = {
        enabled: o.enabled !== false,
        ...(text(o.title) ? { title: text(o.title) } : {}),
        ...(text(o.subtitle) ? { subtitle: text(o.subtitle) } : {}),
        ...(text(o.author) ? { author: text(o.author) } : {}),
        ...(text(o.date, 60) ? { date: text(o.date, 60) } : {}),
        ...(logo ? { logo } : {}),
      };
    }
  }
  return out;
}

/** Merge a cleaned patch over stored settings (`null` removes the key). */
export function mergeSettings(base: Partial<DocSettings> | undefined, patch: unknown): Partial<DocSettings> {
  const next: Record<string, unknown> = { ...(base ?? {}) };
  for (const [k, v] of Object.entries(cleanSettings(patch))) {
    if (v === null) delete next[k];
    else next[k] = v;
  }
  return next as Partial<DocSettings>;
}

/** Stored (partial) settings with every default filled in. */
export function resolveSettings(stored: Partial<DocSettings> | undefined, override?: unknown): DocSettings {
  const merged = override === undefined ? (stored ?? {}) : mergeSettings(stored, override);
  const theme = themeById(merged.theme);
  // The theme's defaults sit between the global defaults and what the document stores.
  const implied = theme ? mergeSettings(undefined, { font: theme.font, ...theme.defaults }) : {};
  const out = { ...DEFAULT_SETTINGS, ...implied, ...merged } as DocSettings;
  // '' was stored to switch a theme default off; nothing downstream should see it.
  if (out.watermark === '') delete out.watermark;
  if (out.classification === '') delete out.classification;
  return out;
}

/** Expand `{title}`, `{date}`, `{page}`, `{pages}` in header/footer text. */
export function expandFields(template: string, values: { title: string; date: string; page?: string; pages?: string }): string {
  return template
    .replace(/\{title\}/gi, values.title)
    .replace(/\{date\}/gi, values.date)
    .replace(/\{page\}/gi, values.page ?? '{page}')
    .replace(/\{pages\}/gi, values.pages ?? '{pages}');
}

// Templates moved to `canvas/doc-types` (the document-type catalogue): sections, look, visuals and length per type.
