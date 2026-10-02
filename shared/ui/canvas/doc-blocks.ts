/**
 * AICO Docs' document blocks — signature, key-value box, line items (BOQ /
 * invoice with computed totals), risk matrix, action items, two columns,
 * cover band, meta line, references — plus the callout icon set and the
 * sizing rule that keeps KPI values from breaking mid-word.
 *
 * ## One parser, one HTML, for the app and every export
 *
 * The blocks are fenced JSON (columns: fenced Markdown) like the round-2
 * infographics, for the same reasons: a model writes them reliably and a
 * plain viewer shows readable text. This module parses, normalises and
 * serialises them, computes line-item totals, and renders each to HTML. The
 * editor draws that HTML and the engine's HTML/PDF export embeds the very
 * same string, so the page and the PDF cannot disagree; the DOCX writer
 * reads the same parsed values. Syntax: `docs/engineering/canvas-docs-contract.md`
 * (round 3).
 *
 * ## Totals are computed, never typed
 *
 * An invoice whose total does not add up is worse than no invoice. Amounts
 * are qty × rate per row in integer minor units of the currency (pence,
 * cents; yen has none), then subtotal, discount, tax on the discounted
 * subtotal, total — so 0.1 × 3 is 0.30 and 1.005 rounds to 1.01. A total
 * written into the JSON is ignored.
 *
 * ## Words never break
 *
 * The owner's screenshot showed "$100/mo" and "Desktop" split mid-word in a
 * fixed four-column grid. `statLayout` picks a value size by length and a
 * minimum tile width wide enough for the longest unbroken token at that
 * size; grids use auto-fit over that minimum, so tiles wrap to the next row
 * instead of squeezing words.
 *
 * Text fields may carry inline Markdown (bold, italic, code, links) and
 * nothing else; everything is escaped first (`inlineMd`).
 *
 * @module shared/ui/canvas/doc-blocks
 */

// ── Inline text ──────────────────────────────────────────────────────

export function esc(v: string): string {
  return v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Escaped HTML with `**bold**`, `*italic*`/`_italic_`, `` `code` `` and `[text](http…)` links. */
export function inlineMd(text: string): string {
  let out = esc(text);
  out = out.replace(/`([^`]+)`/g, '<code>$1</code>');
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/(^|[^*\w])\*([^*\s][^*]*)\*(?!\w)/g, '$1<em>$2</em>');
  out = out.replace(/(^|\W)_([^_\s][^_]*)_(?!\w)/g, '$1<em>$2</em>');
  out = out.replace(/\[([^\]]+)\]\(((?:https?:|mailto:)[^)\s]+)\)/g, (_m, t: string, u: string) => `<a href="${u}">${t}</a>`);
  return out;
}

/** The text without inline Markdown marks (for Word runs and plain contexts). */
export function plainInline(text: string): string {
  return text.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/\*\*([^*]+)\*\*/g, '$1').replace(/`([^`]+)`/g, '$1')
    .replace(/(^|[^*\w])\*([^*\s][^*]*)\*(?!\w)/g, '$1$2').replace(/(^|\W)_([^_\s][^_]*)_(?!\w)/g, '$1$2');
}

// ── Icons ────────────────────────────────────────────────────────────

/** A small built-in set (24×24, stroke). Callouts take one by name. */
export const ICONS = {
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6"/><path d="M12 7.5v.5"/>',
  warning: '<path d="M10.3 4.2 2.6 17.5A2 2 0 0 0 4.3 20.5h15.4a2 2 0 0 0 1.7-3L13.7 4.2a2 2 0 0 0-3.4 0z"/><path d="M12 9.5v4"/><path d="M12 17v.5"/>',
  check: '<circle cx="12" cy="12" r="9"/><path d="m8 12.5 2.7 2.7L16.5 9.5"/>',
  tip: '<path d="M9 18h6"/><path d="M10 21h4"/><path d="M12 3a6 6 0 0 0-3.6 10.8c.7.6 1.1 1.3 1.1 2.2h5c0-.9.4-1.6 1.1-2.2A6 6 0 0 0 12 3z"/>',
  shield: '<path d="M12 3 4.5 6v5.5c0 4.6 3.2 8.4 7.5 9.5 4.3-1.1 7.5-4.9 7.5-9.5V6z"/>',
  lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7.5a4 4 0 0 1 8 0V11"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  flag: '<path d="M5 21V4"/><path d="M5 4h11l-2 4 2 4H5"/>',
  star: '<path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2L12 17.3 6.4 20.2l1.1-6.2L3 9.6l6.2-.9z"/>',
  money: '<rect x="3" y="6" width="18" height="12" rx="2"/><circle cx="12" cy="12" r="2.5"/><path d="M6.5 9.5v5"/><path d="M17.5 9.5v5"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  calendar: '<rect x="3.5" y="5" width="17" height="15.5" rx="2"/><path d="M3.5 10h17"/><path d="M8 3v4"/><path d="M16 3v4"/>',
  doc: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/><path d="M9 13h6"/><path d="M9 17h6"/>',
  link: '<path d="M10 14a4.5 4.5 0 0 0 6.4 0l3-3a4.5 4.5 0 0 0-6.4-6.4l-1 1"/><path d="M14 10a4.5 4.5 0 0 0-6.4 0l-3 3a4.5 4.5 0 0 0 6.4 6.4l1-1"/>',
  alert: '<path d="M8.3 3h7.4L21 8.3v7.4L15.7 21H8.3L3 15.7V8.3z"/><path d="M12 8v5"/><path d="M12 16.5v.5"/>',
} as const;

export type IconName = keyof typeof ICONS;
export const ICON_NAMES = Object.keys(ICONS) as IconName[];

/** A glyph Word can show for each icon (Segoe UI Symbol has all of them). */
export const ICON_GLYPHS: Record<IconName, string> = {
  info: 'ℹ', warning: '⚠', check: '✔', tip: '✦', shield: '⛨', lock: '⚿', clock: '⏱', flag: '⚑', star: '★',
  money: '¤', user: '☺', calendar: '☷', doc: '☰', link: '⛓', alert: '⛔',
};

export function isIcon(v: unknown): v is IconName {
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(ICONS, v);
}

export function iconSvg(name: IconName, size = 16): string {
  return `<svg class="db-icon" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" `
    + `stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;
}

/** `icon=<name>` in a fence's info string. */
export function iconFromInfo(info: string | null | undefined): IconName | undefined {
  const m = /(?:^|\s)icon=([\w-]+)/.exec(info ?? '');
  return m && isIcon(m[1]) ? m[1] : undefined;
}

// ── KPI values that never break mid-word ─────────────────────────────

/** The value's font size in px (app/HTML) — shorter values may be bigger. */
export function statValueSize(value: string): number {
  const n = value.trim().length;
  return n <= 6 ? 28 : n <= 9 ? 24 : n <= 13 ? 20 : 17;
}

/**
 * Tile minimum width (px) for a set of values: at least 136 (four tiles fit
 * an A4 text column), and wide enough for the longest unbroken token at its
 * value's size (bold glyphs ≈ 0.66em, plus 30px of tile padding and border).
 */
export function statsMinWidth(values: readonly string[]): number {
  let need = 136;
  for (const v of values) {
    const size = statValueSize(v);
    const longest = Math.max(0, ...v.split(/\s+/).map(t => t.length));
    need = Math.max(need, Math.ceil(longest * size * 0.66) + 30);
  }
  return Math.min(need, 420);
}

/**
 * Columns for `n` tiles when `fit` fit across: as few as give the same number
 * of rows, so four tiles in a three-wide space sit 2 + 2, not 3 + 1.
 */
export function balancedColumns(n: number, fit: number): number {
  let c = Math.max(1, Math.min(n, Math.floor(fit)));
  while (c > 1 && Math.ceil(n / (c - 1)) === Math.ceil(n / c)) c--;
  return c;
}

/** Inline style for a grid of tiles: auto-fit over the minimum, rows of equal height. */
export function autoGrid(minPx: number): string {
  return `grid-template-columns: repeat(auto-fit, minmax(min(${minPx}px, 100%), 1fr)); grid-auto-rows: 1fr`;
}

// ── Blocks ───────────────────────────────────────────────────────────

export type DocBlockKind = 'signature' | 'keyvalue' | 'lineitems' | 'riskmatrix' | 'actions' | 'columns' | 'cover' | 'meta' | 'references';

export const DOC_BLOCK_KINDS: readonly DocBlockKind[] = ['signature', 'keyvalue', 'lineitems', 'riskmatrix', 'actions', 'columns', 'cover', 'meta', 'references'];

const ALIASES: Record<string, DocBlockKind> = {
  signature: 'signature', signatures: 'signature', sign: 'signature',
  keyvalue: 'keyvalue', kv: 'keyvalue', info: 'keyvalue', details: 'keyvalue',
  lineitems: 'lineitems', 'line-items': 'lineitems', boq: 'lineitems', invoice: 'lineitems', quote: 'lineitems', pricing: 'lineitems',
  riskmatrix: 'riskmatrix', 'risk-matrix': 'riskmatrix', risks: 'riskmatrix',
  actions: 'actions', 'action-items': 'actions', actionitems: 'actions',
  columns: 'columns', cols: 'columns',
  cover: 'cover', hero: 'cover',
  meta: 'meta', byline: 'meta',
  references: 'references', footnotes: 'references', bibliography: 'references', refs: 'references',
};

export function docBlockKind(lang: string | null | undefined): DocBlockKind | undefined {
  return lang ? ALIASES[lang.toLowerCase()] : undefined;
}

export interface Party { label?: string; name?: string; title?: string; date?: string }
export interface KeyValue { key: string; value: string }
export interface LineRow { item?: string; description?: string; qty?: number; unit?: string; rate?: number; section?: string }
export interface Risk { id: string; title: string; likelihood: number; impact: number; owner?: string; mitigation?: string }
export interface ActionItem { action: string; owner?: string; due?: string; status: ActionStatus }
export type ActionStatus = 'open' | 'in progress' | 'done' | 'blocked';
export interface Reference { text: string; url?: string }
export type ColumnsLayout = 'sidebar' | 'sidebar-right' | 'even';

export type DocBlock =
  | { kind: 'signature'; parties: Party[] }
  | { kind: 'keyvalue'; title?: string; items: KeyValue[] }
  | { kind: 'lineitems'; currency: string; taxRate?: number; taxLabel?: string; discount?: string; notes?: string; items: LineRow[] }
  | { kind: 'riskmatrix'; risks: Risk[] }
  | { kind: 'actions'; items: ActionItem[] }
  | { kind: 'columns'; layout: ColumnsLayout; columns: string[] }
  | { kind: 'cover'; kicker?: string; title: string; subtitle?: string; meta: string[]; pageBreak?: boolean }
  | { kind: 'meta'; items: string[] }
  | { kind: 'references'; items: Reference[] };

const s = (v: unknown): string => (v === undefined || v === null ? '' : String(v)).trim();
const opt = <K extends string>(k: K, v: string): Partial<Record<K, string>> => (v ? { [k]: v } as Record<K, string> : {});

/** A number from `12`, `"1,200.50"`, `"£650"`; undefined when there is none. */
export function num(v: unknown): number | undefined {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (typeof v !== 'string') return undefined;
  const t = v.replace(/[^0-9.\-]/g, '');
  if (!t || t === '-' || t === '.') return undefined;
  const n = Number(t);
  return Number.isFinite(n) ? n : undefined;
}

function json(body: string): unknown {
  const t = body.trim();
  if (!t) return {};
  return JSON.parse(t);
}

function list(parsed: unknown, key: string): unknown[] {
  if (Array.isArray(parsed)) return parsed;
  if (parsed && typeof parsed === 'object') {
    const l = (parsed as Record<string, unknown>)[key] ?? (parsed as Record<string, unknown>).items;
    if (Array.isArray(l)) return l;
  }
  return [];
}

const LIKELIHOOD: Record<string, number> = { rare: 1, 'very low': 1, unlikely: 2, low: 2, possible: 3, medium: 3, moderate: 3, likely: 4, high: 4, 'almost certain': 5, certain: 5, 'very high': 5 };
const IMPACT: Record<string, number> = { insignificant: 1, negligible: 1, 'very low': 1, minor: 2, low: 2, moderate: 3, medium: 3, major: 4, high: 4, severe: 5, catastrophic: 5, critical: 5, 'very high': 5 };

/** 1–5 from a number or a word. */
export function level(v: unknown, words: Record<string, number>): number {
  const n = num(v);
  if (n !== undefined) return Math.max(1, Math.min(5, Math.round(n)));
  return words[s(v).toLowerCase()] ?? 3;
}

export type RiskRating = 'Low' | 'Medium' | 'High' | 'Critical';
export function riskRating(score: number): RiskRating {
  return score <= 4 ? 'Low' : score <= 9 ? 'Medium' : score <= 16 ? 'High' : 'Critical';
}
export const RATING_COLORS: Record<RiskRating, { fill: string; ink: string }> = {
  Low: { fill: 'DCFCE7', ink: '166534' }, Medium: { fill: 'FEF3C7', ink: '92400E' }, High: { fill: 'FFEDD5', ink: '9A3412' }, Critical: { fill: 'FEE2E2', ink: '991B1B' },
};

function status(v: unknown): ActionStatus {
  const t = s(v).toLowerCase().replace(/[_-]+/g, ' ');
  if (/^(done|closed|complete|completed|resolved)$/.test(t)) return 'done';
  if (/^(in progress|ongoing|started|wip|doing)$/.test(t)) return 'in progress';
  if (/^(blocked|stuck|on hold)$/.test(t)) return 'blocked';
  return 'open';
}

/** Split a `columns` body on lines of `+++`. */
export function splitColumns(body: string): string[] {
  return body.replace(/\r\n/g, '\n').split(/^\s*\+\+\+\s*$/m).map(c => c.replace(/^\n+|\n+$/g, ''));
}

export function columnsLayout(info: string | null | undefined): ColumnsLayout {
  const w = (info ?? '').trim().split(/\s+/).slice(1).map(x => x.toLowerCase());
  if (w.includes('sidebar-right') || w.includes('right')) return 'sidebar-right';
  if (w.includes('sidebar') || w.includes('left')) return 'sidebar';
  return 'even';
}

/** Parse a block, or say why not. `info` is the fence's whole info string (columns read their layout from it). */
export function parseDocBlock(kind: DocBlockKind, body: string, info?: string | null): { ok: true; value: DocBlock } | { ok: false; error: string } {
  try {
    switch (kind) {
      case 'columns': {
        const columns = splitColumns(body);
        return { ok: true, value: { kind, layout: columnsLayout(info), columns: columns.length >= 2 ? columns.slice(0, 3) : [columns[0] ?? '', ''] } };
      }
      case 'signature': {
        const parties = list(json(body), 'parties').map((raw) => {
          const o = (typeof raw === 'string' ? { name: raw } : raw ?? {}) as Record<string, unknown>;
          return { ...opt('label', s(o.label ?? o.for ?? o.party)), ...opt('name', s(o.name)), ...opt('title', s(o.title ?? o.role)), ...opt('date', s(o.date)) };
        }).slice(0, 4);
        return { ok: true, value: { kind, parties: parties.length ? parties : [{}] } };
      }
      case 'keyvalue': {
        const parsed = json(body);
        let items: KeyValue[];
        const o = (parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}) as Record<string, unknown>;
        if (Array.isArray(parsed) || Array.isArray(o.items)) {
          items = list(parsed, 'items').map((raw) => {
            const r = (raw ?? {}) as Record<string, unknown>;
            return { key: s(r.key ?? r.label ?? r.name), value: s(r.value ?? r.text) };
          });
        } else {
          items = Object.entries(o).filter(([k]) => k !== 'title').map(([k, v]) => ({ key: k, value: s(v) }));
        }
        items = items.filter(i => i.key || i.value);
        if (!items.length) throw new Error('no rows');
        return { ok: true, value: { kind, ...opt('title', s(o.title)), items } };
      }
      case 'lineitems': {
        const parsed = json(body);
        const o = (parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}) as Record<string, unknown>;
        const items: LineRow[] = list(parsed, 'items').map((raw) => {
          const r = (raw ?? {}) as Record<string, unknown>;
          if (r.section !== undefined && r.item === undefined && r.description === undefined && r.rate === undefined) return { section: s(r.section) };
          const qty = num(r.qty ?? r.quantity);
          const rate = num(r.rate ?? r.price ?? r.unitPrice ?? r.unit_price);
          return {
            ...opt('item', s(r.item ?? r.name ?? r.title)), ...opt('description', s(r.description ?? r.detail)),
            ...(qty !== undefined ? { qty } : {}), ...opt('unit', s(r.unit)), ...(rate !== undefined ? { rate } : {}),
          };
        }).filter(r => r.section !== undefined || r.item || r.description || r.rate !== undefined);
        if (!items.some(r => r.section === undefined)) throw new Error('no line items');
        const taxRate = num(o.taxRate ?? o.tax ?? o.vat);
        const discount = s(o.discount);
        return {
          ok: true,
          value: {
            kind, currency: currencyCode(o.currency), ...(taxRate !== undefined ? { taxRate } : {}), ...opt('taxLabel', s(o.taxLabel)),
            ...(discount && num(discount) ? { discount } : {}), ...opt('notes', s(o.notes)), items,
          },
        };
      }
      case 'riskmatrix': {
        const risks = list(json(body), 'risks').map((raw, i) => {
          const r = (raw ?? {}) as Record<string, unknown>;
          return {
            id: s(r.id) || `R${i + 1}`, title: s(r.title ?? r.risk ?? r.name), likelihood: level(r.likelihood ?? r.probability, LIKELIHOOD),
            impact: level(r.impact ?? r.severity ?? r.consequence, IMPACT), ...opt('owner', s(r.owner)), ...opt('mitigation', s(r.mitigation ?? r.control ?? r.response)),
          };
        }).filter(r => r.title);
        if (!risks.length) throw new Error('no risks');
        return { ok: true, value: { kind, risks } };
      }
      case 'actions': {
        const items = list(json(body), 'items').map((raw) => {
          const r = (typeof raw === 'string' ? { action: raw } : raw ?? {}) as Record<string, unknown>;
          return { action: s(r.action ?? r.title ?? r.task ?? r.text), ...opt('owner', s(r.owner ?? r.who)), ...opt('due', s(r.due ?? r.when ?? r.date)), status: status(r.status) };
        }).filter(i => i.action);
        if (!items.length) throw new Error('no action items');
        return { ok: true, value: { kind, items } };
      }
      case 'cover': {
        const o = (json(body) ?? {}) as Record<string, unknown>;
        const meta = Array.isArray(o.meta) ? o.meta.map(s).filter(Boolean) : s(o.meta) ? [s(o.meta)] : [];
        const title = s(o.title);
        if (!title) throw new Error('a cover needs a title');
        return { ok: true, value: { kind, ...opt('kicker', s(o.kicker ?? o.eyebrow ?? o.label)), title, ...opt('subtitle', s(o.subtitle)), meta, ...(o.pageBreak === true ? { pageBreak: true } : {}) } };
      }
      case 'meta': {
        const parsed = json(body);
        let items: string[];
        if (Array.isArray(parsed) || Array.isArray((parsed as Record<string, unknown> | null)?.items)) items = list(parsed, 'items').map(v => (v && typeof v === 'object' ? s((v as Record<string, unknown>).value ?? (v as Record<string, unknown>).text) : s(v)));
        else {
          const o = (parsed ?? {}) as Record<string, unknown>;
          const order = ['author', 'date', 'version', 'status'];
          items = [...order.filter(k => s(o[k])).map(k => s(o[k])), ...Object.entries(o).filter(([k, v]) => !order.includes(k) && s(v)).map(([k, v]) => `${k}: ${s(v)}`)];
        }
        items = items.filter(Boolean);
        if (!items.length) throw new Error('nothing to show');
        return { ok: true, value: { kind, items } };
      }
      case 'references': {
        const items = list(json(body), 'items').map((raw) => {
          const r = (typeof raw === 'string' ? { text: raw } : raw ?? {}) as Record<string, unknown>;
          return { text: s(r.text ?? r.title ?? r.citation), ...opt('url', s(r.url ?? r.link)) };
        }).filter(r => r.text);
        if (!items.length) throw new Error('no references');
        return { ok: true, value: { kind, items } };
      }
    }
  } catch (err) {
    return { ok: false, error: `${kind} block: ${err instanceof Error ? err.message : String(err)}` };
  }
}

// ── Serialising ──────────────────────────────────────────────────────

function fenceFor(lang: string, body: string): string {
  const longest = Math.max(2, ...(body.match(/`{3,}/g) ?? []).map(x => x.length));
  const f = '`'.repeat(longest + 1);
  return `${f}${lang}\n${body.replace(/\n+$/, '')}\n${f}`;
}

/** The fence body for a block (pretty JSON; columns' Markdown joined by `+++`). Empty fields are left out. */
export function docBlockBody(b: DocBlock): string {
  const clean = (o: Record<string, unknown>): Record<string, unknown> =>
    Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== '' && !(Array.isArray(v) && !v.length)));
  switch (b.kind) {
    case 'columns': return b.columns.map(c => c.trim()).join('\n\n+++\n\n');
    case 'signature': return JSON.stringify({ parties: b.parties.map(p => clean({ ...p })) }, null, 2);
    case 'keyvalue': return JSON.stringify(clean({ title: b.title, items: b.items.filter(i => i.key.trim() || i.value.trim()) }), null, 2);
    case 'lineitems': return JSON.stringify(clean({
      currency: b.currency, taxRate: b.taxRate, taxLabel: b.taxLabel, discount: b.discount, notes: b.notes,
      items: b.items.map(r => (r.section !== undefined ? { section: r.section } : clean({ ...r }))),
    }), null, 2);
    case 'riskmatrix': return JSON.stringify({ risks: b.risks.map(r => clean({ ...r })) }, null, 2);
    case 'actions': return JSON.stringify({ items: b.items.map(i => clean({ ...i })) }, null, 2);
    case 'cover': return JSON.stringify(clean({ kicker: b.kicker, title: b.title, subtitle: b.subtitle, meta: b.meta, pageBreak: b.pageBreak || undefined }), null, 2);
    case 'meta': return JSON.stringify({ items: b.items }, null, 2);
    case 'references': return JSON.stringify({ items: b.items.map(r => clean({ ...r })) }, null, 2);
  }
}

/** The whole fenced block. Columns use four backticks so they may hold fences. */
export function docBlockMarkdown(b: DocBlock): string {
  if (b.kind === 'columns') {
    const body = docBlockBody(b);
    const longest = Math.max(3, ...(body.match(/`{3,}/g) ?? []).map(x => x.length));
    const f = '`'.repeat(longest + 1);
    return `${f}columns${b.layout === 'even' ? '' : ` ${b.layout}`}\n${body}\n${f}`;
  }
  return fenceFor(b.kind, docBlockBody(b));
}

/** A starting example for each block (the editor's Insert menu). */
export function docBlockTemplate(kind: DocBlockKind): string {
  const examples: Record<DocBlockKind, DocBlock> = {
    signature: { kind: 'signature', parties: [{ label: 'For the Client', name: 'Name', title: 'Title' }, { label: 'For the Supplier', name: 'Name', title: 'Title' }] },
    keyvalue: { kind: 'keyvalue', title: 'Details', items: [{ key: 'Reference', value: 'INV-0042' }, { key: 'Date', value: '3 October 2026' }, { key: 'Due', value: '2 November 2026' }] },
    lineitems: { kind: 'lineitems', currency: 'GBP', taxRate: 20, taxLabel: 'VAT', items: [
      { item: 'Discovery workshop', description: 'Two half-day sessions', qty: 2, unit: 'day', rate: 650 },
      { item: 'Design', qty: 5, unit: 'day', rate: 600 },
      { item: 'Hosting (annual)', qty: 1, rate: 480 },
    ] },
    riskmatrix: { kind: 'riskmatrix', risks: [
      { id: 'R1', title: 'Supplier delay', likelihood: 4, impact: 3, owner: 'Ops', mitigation: 'Second supplier on standby' },
      { id: 'R2', title: 'Data breach', likelihood: 2, impact: 5, owner: 'Security', mitigation: 'Encryption and access reviews' },
      { id: 'R3', title: 'Scope creep', likelihood: 3, impact: 2, owner: 'PM', mitigation: 'Change control' },
    ] },
    actions: { kind: 'actions', items: [
      { action: 'Send the revised proposal', owner: 'Sam', due: '10 Oct', status: 'open' },
      { action: 'Book the pilot venue', owner: 'Priya', due: '14 Oct', status: 'in progress' },
    ] },
    columns: { kind: 'columns', layout: 'sidebar', columns: ['**Contact**\n\nname@example.com\n\n**Skills**\n\n- Strategy\n- Analysis', '## Experience\n\n**Role**, Company — 2022–now\n\nWhat you achieved, with a number.'] },
    cover: { kind: 'cover', kicker: 'Proposal', title: 'Document title', subtitle: 'A one-line promise of what this document gives the reader', meta: ['Prepared for Client', '3 October 2026'] },
    meta: { kind: 'meta', items: ['Author name', '3 October 2026', 'Version 1.0'] },
    references: { kind: 'references', items: [{ text: 'Author, A. (2025). *Title of the work*. Publisher.', url: 'https://example.com' }, { text: 'Second source.' }] },
  };
  return docBlockMarkdown(examples[kind]);
}

// ── Money ────────────────────────────────────────────────────────────

/** A three-letter ISO code (default GBP); `£`/`$`/`€` read as GBP/USD/EUR. */
export function currencyCode(v: unknown): string {
  const t = s(v).toUpperCase();
  const sym: Record<string, string> = { '£': 'GBP', $: 'USD', '€': 'EUR', '¥': 'JPY', '₹': 'INR' };
  if (sym[t]) return sym[t]!;
  return /^[A-Z]{3}$/.test(t) ? t : 'GBP';
}

/** Digits after the point for a currency (2, or 0 for yen and the like). */
export function minorDigits(currency: string): number {
  try { return new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits ?? 2; } catch { return 2; }
}

/** Round to integer minor units without binary-fraction surprises (1.005 → 101). */
function toMinor(x: number, digits: number): number {
  return Math.round(Number((x * 10 ** digits).toPrecision(12)));
}

export function formatMoney(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat('en-GB', { style: 'currency', currency }).format(amount);
  } catch {
    return `${currency} ${amount.toFixed(2)}`;
  }
}

export function formatQty(n: number): string {
  return Number.isInteger(n) ? String(n) : String(Number(n.toFixed(4)));
}

export interface Totals {
  /** Amount per row (major units); undefined for section rows. */
  lines: Array<number | undefined>;
  subtotal: number;
  discount: number;
  /** "10%" or the amount, as given. */
  discountLabel?: string;
  tax: number;
  total: number;
  digits: number;
}

/** Line amounts, subtotal, discount, tax and total, each exact to the currency's minor unit. */
export function computeTotals(b: Extract<DocBlock, { kind: 'lineitems' }>): Totals {
  const d = minorDigits(b.currency);
  const lines = b.items.map(r => (r.section !== undefined ? undefined : toMinor((r.qty ?? 1) * (r.rate ?? 0), d)));
  const sub = lines.reduce<number>((a, x) => a + (x ?? 0), 0);
  let disc = 0;
  if (b.discount) {
    const pct = /%\s*$/.test(b.discount);
    const v = num(b.discount) ?? 0;
    disc = pct ? toMinor(sub * v / 100 / 10 ** d, d) : toMinor(v, d);
    disc = Math.max(0, Math.min(sub, disc));
  }
  const taxable = sub - disc;
  const tax = b.taxRate ? toMinor(taxable * b.taxRate / 100 / 10 ** d, d) : 0;
  const major = (m: number): number => m / 10 ** d;
  return {
    lines: lines.map(x => (x === undefined ? undefined : major(x))), subtotal: major(sub), discount: major(disc),
    ...(b.discount ? { discountLabel: b.discount } : {}), tax: major(tax), total: major(taxable + tax), digits: d,
  };
}

// ── HTML (the app and the HTML/PDF export) ───────────────────────────

const STATUS_LABEL: Record<ActionStatus, string> = { open: 'Open', 'in progress': 'In progress', done: 'Done', blocked: 'Blocked' };

/**
 * A block as HTML. `md` renders Markdown (the columns' content) — the engine
 * passes its export renderer; the app draws columns itself.
 */
export function docBlockHtml(b: DocBlock, md: (source: string) => string = t => `<p>${inlineMd(t)}</p>`): string {
  switch (b.kind) {
    case 'signature':
      return `<div class="db-sign" style="${autoGrid(200)}">${b.parties.map(p => `<div class="db-sign-party">`
        + `${p.label ? `<div class="db-sign-label">${inlineMd(p.label)}</div>` : ''}<div class="db-sign-line"></div>`
        + `<div class="db-sign-name">${inlineMd(p.name || 'Name')}</div>${p.title ? `<div class="db-sign-title">${inlineMd(p.title)}</div>` : ''}`
        + `<div class="db-sign-date">Date: ${p.date ? inlineMd(p.date) : '<span class="db-sign-blank"></span>'}</div></div>`).join('')}</div>`;
    case 'keyvalue':
      return `<div class="db-kv">${b.title ? `<div class="db-kv-title">${inlineMd(b.title)}</div>` : ''}<dl>${b.items.map(i =>
        `<div class="db-kv-row"><dt>${inlineMd(i.key)}</dt><dd>${inlineMd(i.value)}</dd></div>`).join('')}</dl></div>`;
    case 'lineitems': {
      const t = computeTotals(b);
      const money = (n: number): string => esc(formatMoney(n, b.currency));
      const units = b.items.some(r => r.unit);
      const cols = units ? 5 : 4;
      const rows = b.items.map((r, i) => (r.section !== undefined
        ? `<tr class="db-li-section"><td colspan="${cols}">${inlineMd(r.section)}</td></tr>`
        : `<tr><td>${r.item ? `<div class="db-li-item">${inlineMd(r.item)}</div>` : ''}${r.description ? `<div class="db-li-desc">${inlineMd(r.description)}</div>` : ''}</td>`
          + `<td class="db-num">${esc(formatQty(r.qty ?? 1))}</td>${units ? `<td>${esc(r.unit ?? '')}</td>` : ''}`
          + `<td class="db-num">${money(r.rate ?? 0)}</td><td class="db-num">${money(t.lines[i] ?? 0)}</td></tr>`)).join('');
      const foot = [
        ['Subtotal', money(t.subtotal), ''],
        ...(t.discount ? [[`Discount${t.discountLabel && /%/.test(t.discountLabel) ? ` (${esc(t.discountLabel)})` : ''}`, `−${money(t.discount)}`, '']] : []),
        ...(b.taxRate ? [[`${esc(b.taxLabel || 'Tax')} (${esc(formatQty(b.taxRate))}%)`, money(t.tax), '']] : []),
        ['Total', money(t.total), ' db-li-total'],
      ].map(([l, v, cls]) => `<tr class="db-li-sum${cls}"><td colspan="${cols - 1}">${l}</td><td class="db-num">${v}</td></tr>`).join('');
      return `<div class="db-li"><table class="db-table db-li-table"><thead><tr><th>Item</th><th class="db-num">Qty</th>${units ? '<th>Unit</th>' : ''}`
        + `<th class="db-num">Rate</th><th class="db-num">Amount</th></tr></thead><tbody>${rows}</tbody><tbody class="db-li-foot">${foot}</tbody></table>`
        + `${b.notes ? `<div class="db-li-notes">${inlineMd(b.notes)}</div>` : ''}</div>`;
    }
    case 'riskmatrix': {
      const sorted = [...b.risks].sort((x, y) => y.likelihood * y.impact - x.likelihood * x.impact);
      const cells: string[] = [];
      for (let l = 5; l >= 1; l--) {
        cells.push(`<div class="db-rm-axis db-rm-l">${l}</div>`);
        for (let i = 1; i <= 5; i++) {
          const r = riskRating(l * i);
          const here = b.risks.filter(x => x.likelihood === l && x.impact === i);
          cells.push(`<div class="db-rm-cell" style="background:#${RATING_COLORS[r].fill};color:#${RATING_COLORS[r].ink}" title="${r}">${here.map(x => `<span class="db-rm-id">${esc(x.id)}</span>`).join(' ')}</div>`);
        }
      }
      cells.push('<div class="db-rm-axis"></div>', ...[1, 2, 3, 4, 5].map(i => `<div class="db-rm-axis">${i}</div>`));
      const register = `<table class="db-table db-rm-register"><thead><tr><th>ID</th><th>Risk</th><th class="db-num">L</th><th class="db-num">I</th><th>Rating</th><th>Owner</th><th>Mitigation</th></tr></thead><tbody>${sorted.map((x) => {
        const r = riskRating(x.likelihood * x.impact);
        return `<tr><td><strong>${esc(x.id)}</strong></td><td>${inlineMd(x.title)}</td><td class="db-num">${x.likelihood}</td><td class="db-num">${x.impact}</td>`
          + `<td><span class="db-pill" style="background:#${RATING_COLORS[r].fill};color:#${RATING_COLORS[r].ink}">${r} · ${x.likelihood * x.impact}</span></td>`
          + `<td>${inlineMd(x.owner ?? '')}</td><td>${inlineMd(x.mitigation ?? '')}</td></tr>`;
      }).join('')}</tbody></table>`;
      return `<div class="db-rm"><div class="db-rm-wrap"><div class="db-rm-ylabel">Likelihood</div><div class="db-rm-grid">${cells.join('')}</div></div>`
        + `<div class="db-rm-xlabel">Impact</div>${register}</div>`;
    }
    case 'actions':
      return `<table class="db-table db-actions"><thead><tr><th class="db-num">#</th><th>Action</th><th>Owner</th><th>Due</th><th>Status</th></tr></thead><tbody>${b.items.map((i, n) =>
        `<tr><td class="db-num">${n + 1}</td><td>${inlineMd(i.action)}</td><td>${inlineMd(i.owner ?? '')}</td><td class="db-nowrap">${inlineMd(i.due ?? '')}</td>`
        + `<td><span class="db-pill db-st-${i.status.replace(' ', '-')}">${STATUS_LABEL[i.status]}</span></td></tr>`).join('')}</tbody></table>`;
    case 'columns':
      return `<div class="db-cols db-cols-${b.layout}">${b.columns.map((c, i) => `<div class="db-col${(b.layout === 'sidebar' && i === 0) || (b.layout === 'sidebar-right' && i === b.columns.length - 1) ? ' db-col-side' : ''}">${md(c)}</div>`).join('')}</div>`;
    case 'cover':
      return `<section class="db-cover${b.pageBreak ? ' db-break' : ''}">${b.kicker ? `<div class="db-cover-kicker">${inlineMd(b.kicker)}</div>` : ''}`
        + `<div class="db-cover-title">${inlineMd(b.title)}</div>${b.subtitle ? `<div class="db-cover-sub">${inlineMd(b.subtitle)}</div>` : ''}`
        + `${b.meta.length ? `<div class="db-cover-meta">${b.meta.map(m => `<span>${inlineMd(m)}</span>`).join('')}</div>` : ''}</section>`;
    case 'meta':
      return `<div class="db-meta">${b.items.map(m => `<span>${inlineMd(m)}</span>`).join('<span class="db-meta-sep" aria-hidden="true">·</span>')}</div>`;
    case 'references':
      return `<ol class="db-refs">${b.items.map((r, i) => `<li><span class="db-ref-n">[${i + 1}]</span><span>${inlineMd(r.text)}`
        + `${r.url ? ` <a href="${esc(r.url)}">${esc(r.url)}</a>` : ''}</span></li>`).join('')}</ol>`;
  }
}

/**
 * Styles for the blocks, written against `--dt-*` variables with print-safe
 * fallbacks, so they work unthemed, themed, in the app (which maps the
 * variables to its tokens) and in exports.
 */
export const DOC_BLOCK_CSS = `
.db-icon { display: inline-block; vertical-align: -0.18em; flex: none; }
.db-sign { display: grid; gap: 28px 36px; margin: 8px 0 4px; break-inside: avoid; }
.db-sign-label { font-size: 0.78em; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; color: var(--dt-muted, #52525b); margin-bottom: 34px; }
.db-sign-line { border-bottom: 1.5px solid var(--dt-ink, #1a1a1a); margin-bottom: 6px; }
.db-sign-name { font-weight: 650; }
.db-sign-title, .db-sign-date { font-size: 0.9em; color: var(--dt-muted, #52525b); }
.db-sign-blank { display: inline-block; width: 110px; border-bottom: 1px solid var(--dt-rule, #d4d4d8); }
.db-kv { border: 1px solid var(--dt-rule, #e4e4e7); border-left: 3px solid var(--dt-accent-ui, #2563eb); border-radius: 6px; padding: 10px 14px; background: var(--dt-tint, #f8fafc); break-inside: avoid; }
.db-kv-title { font-size: 0.78em; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; color: var(--dt-accent-ui, #2563eb); margin-bottom: 6px; }
.db-kv dl { margin: 0; display: grid; grid-template-columns: repeat(auto-fit, minmax(min(260px, 100%), 1fr)); gap: 2px 24px; }
.db-kv-row { display: grid; grid-template-columns: minmax(90px, 38%) 1fr; gap: 12px; padding: 3px 0; }
.db-kv dt { margin: 0; font-weight: 650; color: var(--dt-muted, #52525b); font-size: 0.92em; }
.db-kv dd { margin: 0; color: var(--dt-ink, #1a1a1a); overflow-wrap: break-word; }
table.db-table { width: 100%; border-collapse: collapse; margin: 0; font-size: 0.93em; break-inside: auto; }
table.db-table th { text-align: left; font-weight: 650; padding: 8px 10px; border: 0; border-bottom: 2px solid var(--dt-accent-ui, #2563eb); color: var(--dt-ink, #1a1a1a); white-space: nowrap; background: none; }
table.db-table td { padding: 8px 10px; border: 0; border-bottom: 1px solid var(--dt-rule, #e4e4e7); vertical-align: top; background: none; }
table.db-table tr { break-inside: avoid; }
table.db-table .db-num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
table.db-table .db-nowrap { white-space: nowrap; }
.db-li-item { font-weight: 600; }
.db-li-desc { font-size: 0.9em; color: var(--dt-muted, #52525b); }
table.db-table tr.db-li-section td { font-weight: 700; font-size: 0.82em; letter-spacing: 0.05em; text-transform: uppercase; color: var(--dt-accent-ui, #2563eb); background: var(--dt-tint, #f8fafc); }
/* Totals are a tbody, not a tfoot: a printed tfoot repeats on every page a long table spans. */
table.db-table tbody.db-li-foot td { border-bottom: 0; padding: 5px 10px; background: none; }
table.db-table tbody.db-li-foot tr { break-inside: avoid; break-before: avoid; }
table.db-table tr.db-li-sum td:first-child { text-align: right; color: var(--dt-muted, #52525b); }
table.db-table tr.db-li-total td { font-weight: 750; font-size: 1.08em; color: var(--dt-ink, #1a1a1a); border-top: 2px solid var(--dt-ink, #1a1a1a); padding-top: 8px; }
table.db-table tr.db-li-total td:first-child { color: var(--dt-ink, #1a1a1a); }
.db-li-notes { margin-top: 8px; font-size: 0.9em; color: var(--dt-muted, #52525b); }
.db-pill { display: inline-block; padding: 1px 9px; border-radius: 999px; font-size: 0.82em; font-weight: 650; white-space: nowrap; }
.db-st-open { background: #DBEAFE; color: #1E40AF; } .db-st-in-progress { background: #FEF3C7; color: #92400E; }
.db-st-done { background: #DCFCE7; color: #166534; } .db-st-blocked { background: #FEE2E2; color: #991B1B; }
.db-rm-wrap, .db-rm-xlabel { break-inside: avoid; }
.db-rm-wrap { break-after: avoid; }
.db-rm-wrap { display: flex; align-items: stretch; gap: 6px; max-width: 460px; }
.db-rm-ylabel { writing-mode: vertical-rl; transform: rotate(180deg); text-align: center; font-size: 0.75em; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; color: var(--dt-muted, #52525b); }
.db-rm-grid { flex: 1; display: grid; grid-template-columns: 22px repeat(5, minmax(0, 1fr)); grid-auto-rows: minmax(44px, auto); gap: 3px; }
.db-rm-cell { border-radius: 4px; display: flex; flex-wrap: wrap; align-content: center; justify-content: center; gap: 3px; padding: 3px; font-size: 0.78em; }
.db-rm-id { font-weight: 750; background: rgba(255,255,255,0.75); border-radius: 3px; padding: 0 4px; }
.db-rm-axis { display: grid; place-items: center; font-size: 0.78em; font-weight: 650; color: var(--dt-muted, #52525b); }
.db-rm-xlabel { max-width: 460px; padding-left: 50px; text-align: center; font-size: 0.75em; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; color: var(--dt-muted, #52525b); margin: 4px 0 14px; }
.db-cols { display: grid; gap: 28px; align-items: start; }
.db-cols-even { grid-template-columns: repeat(auto-fit, minmax(min(240px, 100%), 1fr)); }
.db-cols-sidebar { grid-template-columns: minmax(0, 1fr) minmax(0, 2.1fr); }
.db-cols-sidebar-right { grid-template-columns: minmax(0, 2.1fr) minmax(0, 1fr); }
.db-col { min-width: 0; }
.db-col > :first-child { margin-top: 0; }
.db-col-side { background: var(--dt-tint, #f4f4f5); border-radius: 8px; padding: 16px 18px; font-size: 0.93em; }
.db-cover { border-left: 5px solid var(--dt-accent-ui, #2563eb); padding: 18px 0 18px 22px; margin: 0 0 8px; break-inside: avoid; }
.db-cover.db-break { break-after: page; }
.db-cover-kicker { font-size: 0.8em; font-weight: 750; letter-spacing: 0.12em; text-transform: uppercase; color: var(--dt-accent-ui, #2563eb); margin-bottom: 8px; }
.db-cover-title { font-family: var(--dt-head, inherit); font-size: 2.3em; font-weight: 700; line-height: 1.12; letter-spacing: -0.015em; color: var(--dt-ink, #1a1a1a); }
.db-cover-sub { font-size: 1.18em; color: var(--dt-muted, #52525b); margin-top: 10px; line-height: 1.45; }
.db-cover-meta { display: flex; flex-wrap: wrap; gap: 6px 22px; margin-top: 16px; font-size: 0.9em; color: var(--dt-muted, #52525b); }
.db-meta { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 10px; font-size: 0.92em; color: var(--dt-muted, #52525b); }
.db-meta-sep { color: var(--dt-rule, #a1a1aa); }
ol.db-refs { list-style: none; margin: 0; padding: 0; font-size: 0.92em; }
ol.db-refs li { display: grid; grid-template-columns: 2.6em 1fr; margin: 0 0 6px; }
.db-ref-n { color: var(--dt-muted, #52525b); font-variant-numeric: tabular-nums; }
ol.db-refs a { overflow-wrap: anywhere; }
`;
