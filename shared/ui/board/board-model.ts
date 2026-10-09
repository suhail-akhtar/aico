/**
 * Design boards — the format, its validation, the canvas layout and the
 * camera. Pure: the engine's `DesignBoard` tool, its routes and every client's
 * board viewer all read a board through this one module (ADR 0037).
 *
 * ## What a board is
 *
 * A folder in a chat's artifacts folder: `board.json` plus standalone HTML
 * screens (and the shared CSS, scripts, fonts and pictures they use). The
 * screens are ordinary pages that link to each other with plain relative
 * links (`<a href="Workspace.html">`), so the mockup is clickable end to end
 * and still works when the folder is opened on its own. `board.json` only
 * says how the screens are arranged: titled sections of titled frames, each
 * with the device size it was designed for.
 *
 * ## Why validation lives here and is strict about paths
 *
 * `board.json` is written by a model and read by the engine (export, zip) and
 * by the viewer (which fetches each file through the artifacts route). A
 * frame's `file` is therefore a path someone else will open: it must be a
 * plain relative path inside the board folder — no `..`, no absolute or drive
 * paths, no backslashes, no NUL — and an `.html` file. Anything else is a
 * problem reported by name, never a guess. Loose input whose meaning is clear
 * (a device name instead of a size, a missing id) is normalised instead,
 * because refusing a board over a spelling wastes a model turn.
 *
 * ## What it deliberately does not do
 *
 * No I/O, no DOM, no React. Drawing tools (pen, shapes, free text) are not
 * part of the format: a board is a set of real screens, and a mark-up layer
 * is a different product. Person-written notes are the one annotation kept,
 * because they are how a reviewer talks back to the agent.
 *
 * @module shared/ui/board/board-model
 */

export const BOARD_FILE = 'board.json';
export const BOARD_VERSION = 1;

/** Device sizes a frame can name instead of numbers. */
export const DEVICES: Record<string, { width: number; height: number; label: string }> = {
  desktop: { width: 1440, height: 900, label: 'Desktop' },
  laptop: { width: 1280, height: 800, label: 'Laptop' },
  tablet: { width: 834, height: 1112, label: 'Tablet' },
  mobile: { width: 390, height: 844, label: 'Mobile' },
};

export const LIMITS = {
  sections: 20,
  frames: 60,
  notes: 200,
  title: 120,
  frameTitle: 80,
  note: 600,
  minSize: 240,
  maxWidth: 3840,
  maxHeight: 4320,
} as const;

export interface BoardFrame {
  id: string;
  title: string;
  /** Path of the screen, relative to the board folder (`Today.html`, `screens/today.html`). */
  file: string;
  width: number;
  height: number;
  /** One line under the frame: what the screen is for, a state it shows. */
  note?: string;
}

export interface BoardSection {
  title: string;
  frames: BoardFrame[];
}

/** A sticky note a person put on the board; world coordinates. */
export interface BoardNote {
  id: string;
  text: string;
  x: number;
  y: number;
  /** The frame it is about, when it was dropped on one. */
  frame?: string;
  at?: number;
}

export interface Board {
  version: number;
  title: string;
  description?: string;
  sections: BoardSection[];
  notes: BoardNote[];
}

export interface ParsedBoard {
  board: Board;
  /** Problems a model must fix (bad paths, duplicate ids, sizes out of range). Empty when the board is sound. */
  problems: string[];
}

/** A frame id or board id: lower-case words joined by dashes. */
export function slugify(text: string, max = 48): string {
  const s = text.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, max).replace(/-+$/, '');
  return s || 'screen';
}

const ID = /^[a-z0-9][a-z0-9-]{0,47}$/;

/**
 * A path inside the board folder, as forward-slash segments, or null when it
 * could step outside or is not plain: `..`, `.`, empty segments, absolute or
 * drive paths, backslashes, colons, NUL, a leading dot (hidden files), and
 * percent-encoded forms of the same.
 */
export function safeRelPath(rel: unknown): string | null {
  if (typeof rel !== 'string') return null;
  const raw = rel.trim();
  if (!raw || raw.length > 200 || raw.startsWith('/') || /^[a-z]:/i.test(raw) || /[\\\0:]/.test(raw)) return null;
  let decoded: string;
  try { decoded = decodeURIComponent(raw); } catch { return null; }
  if (decoded !== raw && safeRelPath(decoded) === null) return null;
  const parts = raw.split('/');
  for (const p of parts) {
    if (!p || p === '.' || p === '..' || p.startsWith('.') || /[<>"|?*]/.test(p)) return null;
  }
  return parts.join('/');
}

function clampSize(value: unknown, min: number, max: number): number | null {
  const n = typeof value === 'string' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isFinite(n)) return null;
  const r = Math.round(n);
  return r < min || r > max ? null : r;
}

/** `{device}` or `{width, height}` → a size, or an error naming what is allowed. */
export function frameSize(input: { device?: unknown; width?: unknown; height?: unknown }, fallback?: { width: number; height: number }): { width: number; height: number } | { error: string } {
  if (typeof input.device === 'string' && input.device.trim()) {
    const d = DEVICES[input.device.trim().toLowerCase()];
    if (!d) return { error: `device must be one of ${Object.keys(DEVICES).join(', ')} (or give width and height)` };
    return { width: d.width, height: d.height };
  }
  if (input.width === undefined && input.height === undefined && fallback) return { width: fallback.width, height: fallback.height };
  const width = clampSize(input.width, LIMITS.minSize, LIMITS.maxWidth);
  const height = clampSize(input.height, LIMITS.minSize, LIMITS.maxHeight);
  if (width === null || height === null) {
    return { error: `width must be ${LIMITS.minSize}–${LIMITS.maxWidth} and height ${LIMITS.minSize}–${LIMITS.maxHeight} px (or name a device: ${Object.keys(DEVICES).join(', ')})` };
  }
  return { width, height };
}

function str(value: unknown, max: number): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '';
}

/**
 * Read a board from parsed JSON. Always returns a usable board (bad frames
 * are dropped) plus the problems found, so the viewer can draw what is sound
 * and the tool can tell the model exactly what to fix.
 */
export function parseBoard(raw: unknown): ParsedBoard {
  const problems: string[] = [];
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const title = str(o.title, LIMITS.title) || 'Untitled board';
  const sectionsIn = Array.isArray(o.sections) ? o.sections : [];
  if (!Array.isArray(o.sections)) problems.push('`sections` must be an array of {title, frames}');
  if (sectionsIn.length > LIMITS.sections) problems.push(`at most ${LIMITS.sections} sections (found ${sectionsIn.length})`);
  const ids = new Set<string>();
  const files = new Set<string>();
  let count = 0;
  const sections: BoardSection[] = [];
  sectionsIn.slice(0, LIMITS.sections).forEach((s, si) => {
    const so = (s && typeof s === 'object' ? s : {}) as Record<string, unknown>;
    const frames: BoardFrame[] = [];
    const framesIn = Array.isArray(so.frames) ? so.frames : [];
    for (const f of framesIn) {
      const fo = (f && typeof f === 'object' ? f : {}) as Record<string, unknown>;
      const ftitle = str(fo.title, LIMITS.frameTitle);
      const file = safeRelPath(fo.file);
      const where = `section ${si + 1}, frame "${ftitle || String(fo.file ?? '?')}"`;
      if (!file || !/\.html?$/i.test(file)) { problems.push(`${where}: file must be a relative .html path inside the board folder (got ${JSON.stringify(fo.file ?? null)})`); continue; }
      if (files.has(file.toLowerCase())) { problems.push(`${where}: ${file} is already another frame`); continue; }
      if (count >= LIMITS.frames) { problems.push(`at most ${LIMITS.frames} frames; ${file} and later ones are left out`); break; }
      let id = typeof fo.id === 'string' && ID.test(fo.id) ? fo.id : slugify(ftitle || file.replace(/\.html?$/i, ''));
      if (ids.has(id)) { let n = 2; while (ids.has(`${id}-${n}`)) n++; id = `${id}-${n}`; }
      const size = frameSize({ device: fo.device, width: fo.width, height: fo.height }, DEVICES.desktop);
      if ('error' in size) { problems.push(`${where}: ${size.error}`); continue; }
      ids.add(id); files.add(file.toLowerCase()); count++;
      const note = str(fo.note, LIMITS.note);
      frames.push({ id, title: ftitle || file.replace(/\.html?$/i, ''), file, ...size, ...(note ? { note } : {}) });
    }
    sections.push({ title: str(so.title, LIMITS.title) || `Section ${si + 1}`, frames });
  });
  const notes: BoardNote[] = [];
  for (const n of (Array.isArray(o.notes) ? o.notes : []).slice(0, LIMITS.notes)) {
    const no = (n && typeof n === 'object' ? n : {}) as Record<string, unknown>;
    const text = typeof no.text === 'string' ? no.text.trim().slice(0, LIMITS.note) : '';
    const x = Number(no.x); const y = Number(no.y);
    if (!text || !Number.isFinite(x) || !Number.isFinite(y)) continue;
    const id = typeof no.id === 'string' && /^[\w-]{1,40}$/.test(no.id) ? no.id : `n${notes.length + 1}`;
    notes.push({ id, text, x: Math.round(x), y: Math.round(y), ...(typeof no.frame === 'string' && ids.has(no.frame) ? { frame: no.frame } : {}), ...(Number.isFinite(Number(no.at)) && no.at ? { at: Number(no.at) } : {}) });
  }
  const description = str(o.description, 400);
  return { board: { version: BOARD_VERSION, title, ...(description ? { description } : {}), sections, notes }, problems };
}

/** The board as it is written to `board.json`: stable key order, two-space indent. */
export function serializeBoard(board: Board): string {
  return `${JSON.stringify({
    version: BOARD_VERSION,
    title: board.title,
    ...(board.description ? { description: board.description } : {}),
    sections: board.sections.map(s => ({ title: s.title, frames: s.frames.map(f => ({ id: f.id, title: f.title, file: f.file, width: f.width, height: f.height, ...(f.note ? { note: f.note } : {}) })) })),
    notes: board.notes,
  }, null, 2)}\n`;
}

/** Every frame in reading order (section by section, left to right): the order Present walks. */
export function orderedFrames(board: Board): BoardFrame[] {
  return board.sections.flatMap(s => s.frames);
}

export function findFrame(board: Board, id: string): BoardFrame | undefined {
  return orderedFrames(board).find(f => f.id === id);
}

/** Directory part of a board-relative path ('' for the board folder itself). */
export function dirOf(rel: string): string {
  const i = rel.lastIndexOf('/');
  return i < 0 ? '' : rel.slice(0, i);
}

/**
 * Resolve `href` written in the screen at `fromFile` to a board-relative path,
 * or null when it leaves the board, is absolute or is not a file link (a
 * fragment, `mailto:`, `javascript:`, any scheme). Query and fragment are dropped.
 */
export function resolveHref(fromFile: string, href: string): string | null {
  const h = href.trim();
  if (!h || h.startsWith('#') || h.startsWith('/') || /^[a-z][a-z0-9+.-]*:/i.test(h) || h.startsWith('//')) return null;
  const pathPart = h.split(/[?#]/)[0] ?? '';
  if (!pathPart) return null;
  let decoded: string;
  try { decoded = decodeURIComponent(pathPart); } catch { return null; }
  const out = dirOf(fromFile) ? dirOf(fromFile).split('/') : [];
  for (const seg of decoded.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') { if (!out.length) return null; out.pop(); continue; }
    out.push(seg);
  }
  return safeRelPath(out.join('/'));
}

/** The frame a link in `fromFile` opens, if it opens one. */
export function frameForHref(board: Board, fromFile: string, href: string): BoardFrame | undefined {
  const target = resolveHref(fromFile, href);
  if (!target) return undefined;
  const lower = target.toLowerCase();
  return orderedFrames(board).find(f => f.file.toLowerCase() === lower);
}

// ── What a screen links to and loads ─────────────────────────────────

/** Script, style and font CDNs a preview may load from (ADR 0020), and only for scripts, styles and fonts. */
export const BOARD_CDNS = ['cdnjs.cloudflare.com', 'cdn.jsdelivr.net', 'unpkg.com'] as const;

/** Every `<a href>` in a page, as written. */
export function linksIn(html: string): string[] {
  const out: string[] = [];
  const re = /<a\b[^>]*?\bhref\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/gi;
  for (let m = re.exec(html); m; m = re.exec(html)) out.push((m[2] ?? m[3] ?? m[4] ?? '').trim());
  return out;
}

/** Local files a page loads (stylesheets, scripts, pictures, fonts in inline CSS), as written. */
export function assetsIn(html: string): string[] {
  const out = new Set<string>();
  const attr = /<(?:link|script|img|source|video|audio)\b[^>]*?\b(?:href|src)\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/gi;
  for (let m = attr.exec(html); m; m = attr.exec(html)) out.add((m[2] ?? m[3] ?? m[4] ?? '').trim());
  for (const u of cssUrls(html)) out.add(u);
  return [...out].filter(u => u && !/^(data:|blob:|#)/i.test(u));
}

/** `url(…)` and `@import "…"` references in CSS text. */
export function cssUrls(css: string): string[] {
  const out: string[] = [];
  const re = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)\s]*))\s*\)|@import\s+(?:"([^"]*)"|'([^']*)')/gi;
  for (let m = re.exec(css); m; m = re.exec(css)) out.push((m[1] ?? m[2] ?? m[3] ?? m[4] ?? m[5] ?? '').trim());
  return out.filter(Boolean);
}

/**
 * What in a screen will not work in a preview (no network, ADR 0020), named so
 * the model can fix it: a remote picture, stylesheet or script from anywhere
 * but the three CDNs, a picture from a CDN (images are local or data: only),
 * and code that fetches.
 */
export function networkProblems(text: string): string[] {
  const problems = new Set<string>();
  const tag = /<(img|link|script|source|video|audio|iframe)\b[^>]*?\b(?:href|src)\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/gi;
  for (let m = tag.exec(text); m; m = tag.exec(text)) {
    const url = (m[3] ?? m[4] ?? m[5] ?? '').trim();
    const el = m[1]!.toLowerCase();
    if (!/^(https?:)?\/\//i.test(url)) continue;
    const host = /^(?:https?:)?\/\/([^/?#]+)/i.exec(url)?.[1]?.toLowerCase() ?? '';
    const cdn = (BOARD_CDNS as readonly string[]).includes(host);
    if (el === 'iframe') problems.add(`<iframe src="${url}"> — previews cannot frame other pages`);
    else if (!cdn) problems.add(`<${el}> loads ${url} — previews have no network; put the file in the board folder (or inline it)`);
    else if (el !== 'script' && el !== 'link') problems.add(`<${el}> loads ${url} — pictures and media must be in the board folder or data: URLs`);
  }
  for (const u of cssUrls(text)) {
    if (!/^(https?:)?\/\//i.test(u)) continue;
    const host = /^(?:https?:)?\/\/([^/?#]+)/i.exec(u)?.[1]?.toLowerCase() ?? '';
    if (!(BOARD_CDNS as readonly string[]).includes(host)) problems.add(`CSS url(${u}) — previews have no network; bundle it in the board folder`);
  }
  if (/\bfetch\s*\(|\bXMLHttpRequest\b|\bnew\s+WebSocket\b|\bnavigator\.sendBeacon\b/.test(text)) {
    problems.add('the page calls fetch/XHR/WebSocket — previews have no network; put the data inline in the page');
  }
  return [...problems];
}

/** Links between screens: which work, which point at no screen, and which screens nothing links to. */
export function linkReport(board: Board, htmlByFile: ReadonlyMap<string, string>): {
  edges: Array<{ from: string; to: string }>;
  broken: Array<{ from: string; href: string }>;
  unreachable: string[];
} {
  const frames = orderedFrames(board);
  const edges: Array<{ from: string; to: string }> = [];
  const broken: Array<{ from: string; href: string }> = [];
  const linkedTo = new Set<string>();
  for (const f of frames) {
    const html = htmlByFile.get(f.file);
    if (html === undefined) continue;
    for (const href of new Set(linksIn(html))) {
      if (!href || href.startsWith('#') || /^(mailto:|tel:|javascript:)/i.test(href)) continue;
      if (/^(https?:)?\/\//i.test(href)) continue;
      const target = frameForHref(board, f.file, href);
      if (target) { edges.push({ from: f.id, to: target.id }); if (target.id !== f.id) linkedTo.add(target.id); }
      else broken.push({ from: f.id, href });
    }
  }
  const unreachable = frames.length > 1 ? frames.slice(1).filter(f => !linkedTo.has(f.id)).map(f => f.id) : [];
  return { edges, broken, unreachable };
}

// ── Layout on the canvas ─────────────────────────────────────────────

export interface Rect { x: number; y: number; w: number; h: number }

export interface BoardLayout {
  sections: Array<Rect & { title: string; index: number }>;
  frames: Array<Rect & { id: string; section: number }>;
  bounds: Rect;
}

/** World-space spacing, in CSS px at 100%. */
export const LAYOUT = { gap: 120, sectionGap: 260, heading: 140, label: 56, noteSpace: 64, pad: 160 } as const;

/**
 * Sections stacked top to bottom, each a row of frames left to right, aligned
 * on their top edge — the arrangement people read as a flow. Deterministic:
 * the same board always lands in the same place, so a camera kept across a
 * refresh still points at the same screen.
 */
export function layoutBoard(board: Board): BoardLayout {
  const sections: BoardLayout['sections'] = [];
  const frames: BoardLayout['frames'] = [];
  let y = 0;
  let maxX = 0;
  board.sections.forEach((s, index) => {
    const top = y;
    let x = 0;
    let rowH = 0;
    const hasNotes = s.frames.some(f => f.note);
    for (const f of s.frames) {
      frames.push({ id: f.id, section: index, x, y: top + LAYOUT.heading + LAYOUT.label, w: f.width, h: f.height });
      x += f.width + LAYOUT.gap;
      rowH = Math.max(rowH, f.height);
    }
    const w = Math.max(0, x - LAYOUT.gap);
    const h = LAYOUT.heading + LAYOUT.label + rowH + (hasNotes ? LAYOUT.noteSpace : 0);
    sections.push({ title: s.title, index, x: 0, y: top, w: Math.max(w, 600), h });
    maxX = Math.max(maxX, w);
    y = top + h + LAYOUT.sectionGap;
  });
  const height = Math.max(0, y - LAYOUT.sectionGap);
  return { sections, frames, bounds: { x: 0, y: 0, w: Math.max(maxX, 600), h: Math.max(height, 400) } };
}

// ── The camera ───────────────────────────────────────────────────────

/** World point at the centre of the view, and the scale (1 = 100%). */
export interface Camera { x: number; y: number; k: number }

export const ZOOM_MIN = 0.02;
export const ZOOM_MAX = 4;
/** The steps the − / + buttons move through. */
export const ZOOM_STEPS = [0.05, 0.1, 0.15, 0.25, 0.33, 0.5, 0.67, 0.75, 1, 1.25, 1.5, 2, 3, 4] as const;

export function clampZoom(k: number): number {
  return Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, k));
}

export function toScreen(cam: Camera, vw: number, vh: number, wx: number, wy: number): [number, number] {
  return [(wx - cam.x) * cam.k + vw / 2, (wy - cam.y) * cam.k + vh / 2];
}

export function toWorld(cam: Camera, vw: number, vh: number, sx: number, sy: number): [number, number] {
  return [(sx - vw / 2) / cam.k + cam.x, (sy - vh / 2) / cam.k + cam.y];
}

/** Zoom to `k` keeping the world point under screen point (sx, sy) where it is. */
export function zoomAt(cam: Camera, vw: number, vh: number, sx: number, sy: number, k: number): Camera {
  const nk = clampZoom(k);
  const [wx, wy] = toWorld(cam, vw, vh, sx, sy);
  return { k: nk, x: wx - (sx - vw / 2) / nk, y: wy - (sy - vh / 2) / nk };
}

/** The next zoom step in a direction from `k`. */
export function stepZoom(k: number, dir: 1 | -1): number {
  if (dir > 0) return ZOOM_STEPS.find(s => s > k + 1e-6) ?? ZOOM_MAX;
  return [...ZOOM_STEPS].reverse().find(s => s < k - 1e-6) ?? ZOOM_MIN;
}

/** A camera that shows `r` whole inside a vw × vh view with `pad` screen px around it, never above `maxK`. */
export function fitRect(r: Rect, vw: number, vh: number, pad = 48, maxK = 1): Camera {
  const k = clampZoom(Math.min(maxK, (vw - pad * 2) / Math.max(1, r.w), (vh - pad * 2) / Math.max(1, r.h)));
  return { k, x: r.x + r.w / 2, y: r.y + r.h / 2 };
}

/** Pan by a screen-space delta. */
export function panBy(cam: Camera, dx: number, dy: number): Camera {
  return { ...cam, x: cam.x - dx / cam.k, y: cam.y - dy / cam.k };
}

/** The world rectangle the view shows. */
export function viewRect(cam: Camera, vw: number, vh: number): Rect {
  return { x: cam.x - vw / 2 / cam.k, y: cam.y - vh / 2 / cam.k, w: vw / cam.k, h: vh / cam.k };
}

export function intersects(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/**
 * Which frames get a live page: those in view (with a margin of half a view),
 * nearest the centre first, at most `max`. Every other frame is a placeholder,
 * so a 40-screen board costs the pages you can see, not forty documents.
 */
export function framesToMount(layout: BoardLayout, cam: Camera, vw: number, vh: number, max = 12): string[] {
  const v = viewRect(cam, vw, vh);
  const margin = { x: v.x - v.w / 2, y: v.y - v.h / 2, w: v.w * 2, h: v.h * 2 };
  return layout.frames
    .filter(f => intersects(f, margin))
    .map(f => ({ id: f.id, d: Math.hypot(f.x + f.w / 2 - cam.x, f.y + f.h / 2 - cam.y) }))
    .sort((a, b) => a.d - b.d)
    .slice(0, max)
    .map(f => f.id);
}

/** The frame under a world point, if any. */
export function frameAt(layout: BoardLayout, wx: number, wy: number): string | undefined {
  return layout.frames.find(f => wx >= f.x && wx <= f.x + f.w && wy >= f.y && wy <= f.y + f.h)?.id;
}

/** How large a frame of `w × h` may be drawn inside `vw × vh` (≤ 1: a phone stays phone-sized). */
export function playScale(w: number, h: number, vw: number, vh: number): number {
  return Math.min(1, vw / Math.max(1, w), vh / Math.max(1, h));
}
