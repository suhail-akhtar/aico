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
 * ## Families and document control (ADR 0022)
 *
 * `docType` names the document type, which picks a layout family
 * (`shared/ui/canvas/doc-blueprints`); the family's defaults (cover, contents,
 * margins) sit under the theme's. `control` holds what the cover, the
 * document-control page and the running header say; it merges field by field
 * and is never invented — a draft says version 0.1, status Draft.
 *
 * @module canvas/doc-settings
 */

import { cleanHex, PAGE_WIDTHS, themeById, type PageWidth, type ThemeId } from '../../shared/ui/canvas/doc-themes.js';
import { blueprintById, resolveBlueprint, type BlueprintId } from '../../shared/ui/canvas/doc-blueprints.js';

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
  /** The document type (`canvas/doc-types` id) — it picks the layout family. */
  docType?: string;
  /** A layout family chosen explicitly, over the type's (`shared/ui/canvas/doc-blueprints`). */
  blueprint?: BlueprintId;
  /** Document control: what the cover, the control page and the running header/footer say. */
  control?: DocControl;
}

/**
 * Document control (ADR 0022). Everything is optional: an export shows what
 * is given, a draft's version (0.1) and status (Draft) when nothing is, and
 * empty approval rows to sign — never invented names.
 */
export interface DocControl {
  client?: string;
  reference?: string;
  version?: string;
  status?: string;
  owner?: string;
  preparedBy?: string;
  revisions?: { version: string; date?: string; author?: string; description?: string }[];
  approvals?: { role: string; name?: string; date?: string }[];
  distribution?: { name: string; organisation?: string; role?: string }[];
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
  if (has('docType')) {
    if (typeof r.docType === 'string' && /^[a-z0-9-]{1,40}$/.test(r.docType)) out.docType = r.docType;
    else if (r.docType === null || r.docType === '') out.docType = null;
  }
  if (has('blueprint')) {
    const b = blueprintById(r.blueprint);
    if (b) out.blueprint = b.id; else if (r.blueprint === null || r.blueprint === '') out.blueprint = null;
  }
  if (has('control')) {
    if (r.control === null) out.control = null;
    else {
      const c = cleanControl(r.control);
      if (c) out.control = c;
    }
  }
  if (has('cover')) {
    const c = r.cover;
    // false is kept (not cleared): it switches off a cover the document's family would draw.
    if (c === false) out.cover = { enabled: false };
    else if (c === null) out.cover = null;
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

function rows<T>(value: unknown, one: (o: Record<string, unknown>) => T | undefined): T[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out = value.slice(0, 30).flatMap(v => (v && typeof v === 'object' && !Array.isArray(v) ? [one(v as Record<string, unknown>)] : []))
    .filter((v): v is T => v !== undefined);
  return out;
}

/** Whitelist a document-control object; undefined when nothing in it is usable. */
function cleanControl(raw: unknown): DocControl | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const o = raw as Record<string, unknown>;
  const out: DocControl = {};
  for (const k of ['client', 'reference', 'version', 'status', 'owner', 'preparedBy'] as const) {
    const v = text(o[k], 120);
    if (v) out[k] = v;
  }
  const revisions = rows(o.revisions, r => (text(r.version, 20) ? {
    version: text(r.version, 20)!, ...(text(r.date, 40) ? { date: text(r.date, 40) } : {}),
    ...(text(r.author, 80) ? { author: text(r.author, 80) } : {}), ...(text(r.description, 200) ? { description: text(r.description, 200) } : {}),
  } : undefined));
  if (revisions?.length) out.revisions = revisions;
  const approvals = rows(o.approvals, r => (text(r.role, 80) ? {
    role: text(r.role, 80)!, ...(text(r.name, 80) ? { name: text(r.name, 80) } : {}), ...(text(r.date, 40) ? { date: text(r.date, 40) } : {}),
  } : undefined));
  if (approvals) out.approvals = approvals;
  const distribution = rows(o.distribution, r => (text(r.name, 80) ? {
    name: text(r.name, 80)!, ...(text(r.organisation, 80) ? { organisation: text(r.organisation, 80) } : {}), ...(text(r.role, 80) ? { role: text(r.role, 80) } : {}),
  } : undefined));
  if (distribution?.length) out.distribution = distribution;
  return Object.keys(out).length ? out : undefined;
}

/** Merge a cleaned patch over stored settings (`null` removes the key). */
export function mergeSettings(base: Partial<DocSettings> | undefined, patch: unknown): Partial<DocSettings> {
  const next: Record<string, unknown> = { ...(base ?? {}) };
  for (const [k, v] of Object.entries(cleanSettings(patch))) {
    if (v === null) delete next[k];
    // Document control merges field by field: setting the status must not drop the client.
    else if (k === 'control' && next.control && typeof next.control === 'object') next[k] = { ...(next.control as object), ...(v as object) };
    else next[k] = v;
  }
  return next as Partial<DocSettings>;
}

/** Stored (partial) settings with every default filled in. */
export function resolveSettings(stored: Partial<DocSettings> | undefined, override?: unknown): DocSettings {
  const merged = override === undefined ? (stored ?? {}) : mergeSettings(stored, override);
  const bp = resolveBlueprint(merged);
  const theme = themeById(merged.theme) ?? themeById(bp.theme);
  // Layers, weakest first: global defaults, the family's (blueprint), the theme's, what the document stores.
  const d = bp.defaults;
  const family: Partial<DocSettings> = {
    ...(d.margins ? { margins: d.margins } : {}), ...(d.toc !== undefined ? { toc: d.toc } : {}),
    ...(d.pageNumbers !== undefined ? { pageNumbers: d.pageNumbers } : {}), ...(d.cover ? { cover: { enabled: true } } : {}),
    ...(theme && !merged.theme ? { theme: theme.id } : {}),
  };
  const implied = theme ? mergeSettings(undefined, { font: theme.font, ...theme.defaults }) : {};
  const out = { ...DEFAULT_SETTINGS, ...family, ...implied, ...merged } as DocSettings;
  // '' was stored to switch a theme default off; nothing downstream should see it.
  if (out.watermark === '') delete out.watermark;
  if (out.classification === '') delete out.classification;
  return out;
}

/** The values `{client}`, `{reference}`, `{version}`, `{status}`, `{classification}` expand to. */
export interface ControlValues { client: string; reference: string; version: string; status: string; classification: string; preparedBy: string }

/** Document control with the draft defaults filled in (version 0.1, status Draft). */
export function controlValues(s: DocSettings): ControlValues {
  const c = s.control ?? {};
  return {
    client: c.client ?? '', reference: c.reference ?? '', version: c.version ?? '0.1', status: c.status ?? 'Draft',
    classification: s.classification ?? '', preparedBy: c.preparedBy ?? c.owner ?? s.cover?.author ?? '',
  };
}

type FieldValues = { title: string; date: string; page?: string; pages?: string } & Partial<ControlValues>;

/** Expand `{title}`, `{date}`, `{page}`, `{pages}` (and the control fields) in header/footer text. */
export function expandFields(template: string, values: FieldValues): string {
  return template
    .replace(/\{title\}/gi, values.title)
    .replace(/\{date\}/gi, values.date)
    .replace(/\{(client|reference|version|status|classification)\}/gi, (m, k: string) => values[k.toLowerCase() as keyof ControlValues] ?? m)
    .replace(/\{page\}/gi, values.page ?? '{page}')
    .replace(/\{pages\}/gi, values.pages ?? '{pages}');
}

/**
 * Running header/footer text for a blueprint slot: segments joined by " · "
 * whose fields are all empty are dropped, so "{classification} · Version
 * {version}" reads "Version 0.1" for an unclassified document rather than
 * " · Version 0.1".
 */
export function expandRunning(template: string | undefined, values: FieldValues): string {
  if (!template) return '';
  return template.split(' · ').filter((seg) => {
    const fields = [...seg.matchAll(/\{(\w+)\}/g)].map(m => m[1]!.toLowerCase()).filter(f => f !== 'page' && f !== 'pages');
    return fields.length === 0 || fields.some(f => String((values as Record<string, unknown>)[f] ?? '').trim());
  }).map(seg => expandFields(seg, values)).join(' · ').trim();
}

// Templates moved to `canvas/doc-types` (the document-type catalogue): sections, look, visuals and length per type.
