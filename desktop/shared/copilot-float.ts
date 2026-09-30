/**
 * Where the floating copilot goes, for both sides of the window.
 *
 * The floating copilot is its own native view laid over the page (see
 * electron/browser-overlay.ts), so the same arithmetic runs in two places: the
 * interface keeps its remembered box sensible, and main turns that box into
 * the overlay view's bounds. Pure, so it is unit-tested
 * (scripts/test-browser-overlay.mjs).
 *
 * Boxes are in the interface's CSS pixels, relative to the browser area (the
 * page and whatever sits beside it). Window bounds are device-independent
 * pixels, which differ from CSS pixels when the interface is zoomed.
 *
 * @module desktop/shared/copilot-float
 */

export interface FloatBox { x: number; y: number; w: number; h: number }
export interface Rect { x: number; y: number; width: number; height: number }

/** Room kept between the panel and the edges of the area. */
export const FLOAT_MARGIN = 8;
/** Transparent room round the panel inside the overlay view, for its shadow. Never more than FLOAT_MARGIN, so it stays inside the area. */
export const FLOAT_SHADOW = 8;
export const FLOAT_MIN = { w: 320, h: 300 };

/** Keep a floating panel inside the area it floats over. `x < 0` means "not placed yet": top-right. */
export function clampFloat(ui: FloatBox, area: { width: number; height: number }): FloatBox {
  const m = FLOAT_MARGIN;
  const w = Math.max(FLOAT_MIN.w, Math.min(ui.w, area.width - 2 * m));
  const h = Math.max(FLOAT_MIN.h, Math.min(ui.h, area.height - 2 * m));
  const x0 = ui.x < 0 ? area.width - w - 16 : ui.x;
  const x = Math.max(m, Math.min(x0, area.width - w - m));
  const y = Math.max(m, Math.min(ui.y, area.height - h - m));
  return { x, y, w, h };
}

/** Dragging the header: the box follows the pointer, and stays in the area (a left edge past 0 is not "unplaced"). */
export function dragFloat(start: FloatBox, dx: number, dy: number, area: { width: number; height: number }): FloatBox {
  return clampFloat({ x: Math.max(FLOAT_MARGIN, start.x + dx), y: start.y + dy, w: start.w, h: start.h }, area);
}

/** Dragging the bottom-left grip: the right edge and the top stay where they are. */
export function resizeFloat(start: FloatBox, dx: number, dy: number, area: { width: number; height: number }): FloatBox {
  const right = start.x + start.w;
  const w = Math.max(FLOAT_MIN.w, Math.min(right - FLOAT_MARGIN, start.w - dx));
  const h = Math.max(FLOAT_MIN.h, Math.min(area.height - start.y - FLOAT_MARGIN, start.h + dy));
  return { x: right - w, y: start.y, w, h };
}

/**
 * The overlay view's bounds in the window (DIPs), and where the panel sits
 * inside it (CSS pixels): the clamped panel grown by the shadow margin, cut to
 * the area so it never covers the toolbar or the status line.
 */
export function overlayLayout(area: Rect, box: FloatBox, zoom = 1): { bounds: Rect; panel: Rect } {
  const b = clampFloat(box, area);
  const s = FLOAT_SHADOW;
  const left = Math.max(area.x, area.x + b.x - s);
  const top = Math.max(area.y, area.y + b.y - s);
  const right = Math.min(area.x + area.width, area.x + b.x + b.w + s);
  const bottom = Math.min(area.y + area.height, area.y + b.y + b.h + s);
  const z = zoom > 0 ? zoom : 1;
  const bounds = {
    x: Math.round(left * z), y: Math.round(top * z),
    width: Math.max(1, Math.round((right - left) * z)), height: Math.max(1, Math.round((bottom - top) * z)),
  };
  return { bounds, panel: { x: area.x + b.x - left, y: area.y + b.y - top, width: b.w, height: b.h } };
}

/** The copilot's remembered look, as both windows persist it (localStorage). */
export interface SyncedUi { open: boolean; minimized: boolean; mode: 'dock' | 'float'; x: number; y: number; w: number; h: number; dockWidth: number; attachPage: boolean; shareTabs: boolean }

const SYNCED: Array<keyof SyncedUi> = ['open', 'minimized', 'mode', 'x', 'y', 'w', 'h', 'dockWidth', 'attachPage', 'shareTabs'];

/**
 * What another window wrote to the shared copilot record, as a patch for this
 * one: only the synced fields that differ, or null when nothing does (or the
 * record is unreadable). Things that belong to one window — a prefill in
 * flight — are never touched.
 */
export function remoteUiPatch<T extends SyncedUi>(local: T, raw: string | null): Partial<SyncedUi> | null {
  if (!raw) return null;
  let theirs: Partial<SyncedUi>;
  try { theirs = JSON.parse(raw) as Partial<SyncedUi>; } catch { return null; }
  if (!theirs || typeof theirs !== 'object') return null;
  const patch: Partial<SyncedUi> = {};
  for (const k of SYNCED) {
    const v = theirs[k];
    if (v === undefined || typeof v !== typeof local[k] || v === local[k]) continue;
    if (k === 'mode' && v !== 'dock' && v !== 'float') continue;
    (patch as Record<string, unknown>)[k] = v;
  }
  return Object.keys(patch).length ? patch : null;
}

// ── The overlay's IPC contract (electron/browser-overlay.ts) ──

/** `browser:overlay:set`, from the main window: whether the float is on, whether it may be seen, and the area it floats over (CSS px, window coordinates). */
export interface OverlayRequest {
  /** The copilot floats in the full-size browser (its view holds the conversation), even if something covers it now. */
  active: boolean;
  /** Nothing of the window's own covers the area: the view may be on screen. */
  show: boolean;
  area: Rect | null;
  /** Hiding because something covers it: capture it first, so a still can stand in. */
  capture?: boolean;
}

/** The overlay as it was when it was hidden, placed in the area (CSS px). */
export interface OverlayStill { dataUrl: string; x: number; y: number; width: number; height: number }

/** `browser:overlay:state`, to the overlay's document. */
export interface OverlayState {
  active: boolean;
  visible: boolean;
  /** Where the panel sits inside the view (CSS px). */
  panel: Rect | null;
  area: { width: number; height: number } | null;
}

/** `browser:overlay:relay` → `browser:overlay:message`: what one document asks of the other. */
export type OverlayMessage =
  | { type: 'prefill'; text: string; at: number }
  | { type: 'focus' }
  | { type: 'openChat'; sessionId: string };
