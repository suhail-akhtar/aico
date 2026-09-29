/**
 * The browser's own window — its pure rules, unit-tested without Electron
 * (scripts/test-browser-window.mjs).
 *
 *   - WHERE IT OPENS. Where it was left, when that place is still on a screen
 *     (a monitor unplugged since would open it where no one can reach it);
 *     otherwise beside the AICO window, like a new browser window — never
 *     larger than the screen it opens on, never smaller than it can be used.
 *   - WHAT IS REMEMBERED. Its place, size, maximised state, and whether it was
 *     open when the app quit (so it comes back popped out).
 *   - WHO HEARS WHAT. While the browser is in its own window, everything the
 *     browser says (its prompts, shortcuts, find results, downloads) goes to
 *     that window; the AICO window keeps hearing the tab list (its
 *     placeholder shows it), the bookmarks, and what every window needs
 *     (prefs, engine).
 *
 * @module desktop/electron/browser-window-core
 */

export interface Rect { x: number; y: number; width: number; height: number }

export interface SavedBrowserWindow {
  x?: number;
  y?: number;
  width: number;
  height: number;
  maximized: boolean;
  /** Open when the app last quit: it opens again at start. */
  open: boolean;
}

export const MIN_SIZE = { width: 640, height: 420 } as const;
export const DEFAULT_WINDOW: SavedBrowserWindow = { width: 1280, height: 860, maximized: false, open: false };
/** How far a new window sits from the AICO window, down and to the right, as browsers place a new window. */
export const CASCADE = 32;
/** The height of the title bar (the tab strip): what must stay on a screen for the window to be grabbed. */
const BAR = 40;

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : undefined);

export function normaliseWindowState(raw: unknown): SavedBrowserWindow {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const x = num(r.x); const y = num(r.y);
  return {
    ...(x !== undefined && y !== undefined ? { x, y } : {}),
    width: Math.max(MIN_SIZE.width, num(r.width) ?? DEFAULT_WINDOW.width),
    height: Math.max(MIN_SIZE.height, num(r.height) ?? DEFAULT_WINDOW.height),
    maximized: r.maximized === true,
    open: r.open === true,
  };
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(Math.max(v, lo), Math.max(lo, hi));

/** How many pixels of the title bar lie on this area (0 when its top is off it). */
function barOn(w: Rect, a: Rect): number {
  if (w.y < a.y - 8 || w.y > a.y + a.height - BAR / 2) return 0;
  return Math.max(0, Math.min(w.x + w.width, a.x + a.width) - Math.max(w.x, a.x));
}

/**
 * Where the window opens. `areas` are the displays' work areas; `near` is the
 * AICO window (null when it is hidden or closed).
 */
export function placeWindow(saved: SavedBrowserWindow, areas: Rect[], near?: Rect | null): Rect {
  const screens = areas.length ? areas : [{ x: 0, y: 0, width: 1280, height: 800 }];
  const fit = (a: Rect): { width: number; height: number } => ({
    width: clamp(saved.width, Math.min(MIN_SIZE.width, a.width), a.width),
    height: clamp(saved.height, Math.min(MIN_SIZE.height, a.height), a.height),
  });
  if (saved.x !== undefined && saved.y !== undefined) {
    const was = { x: saved.x, y: saved.y, width: saved.width, height: saved.height };
    // Kept where it was when enough of its title bar is on a screen to grab it.
    const home = screens
      .map(a => ({ a, on: barOn(was, a) }))
      .filter(s => s.on >= Math.min(120, was.width))
      .sort((p, q) => q.on - p.on)[0]?.a;
    if (home) return { x: saved.x, y: saved.y, ...fit(home) };
  }
  // The screen the AICO window is on (by its centre), else the first.
  const cx = near ? near.x + near.width / 2 : NaN;
  const cy = near ? near.y + near.height / 2 : NaN;
  const a = screens.find(s => cx >= s.x && cx < s.x + s.width && cy >= s.y && cy < s.y + s.height) ?? screens[0]!;
  const size = fit(a);
  const x = near ? near.x + CASCADE : a.x + (a.width - size.width) / 2;
  const y = near ? near.y + CASCADE : a.y + (a.height - size.height) / 2;
  return {
    x: Math.round(clamp(x, a.x, a.x + a.width - size.width)),
    y: Math.round(clamp(y, a.y, a.y + a.height - size.height)),
    ...size,
  };
}

/**
 * Heard by both windows while the browser is in its own: what every window needs, the tab list (the AICO
 * window's placeholder shows it) and the bookmarks (that window's bar must be right when the browser comes back).
 */
const BOTH = /^(prefs:changed|engine:status|plugins:changed|browser:(state|tabs|bookmarks))$/;
/** The browser's own events, and full screen (only ever the browser's window's). */
const FOLLOWS_BROWSER = /^(browser:|win:fullscreen$)/;
/** Browser events for what only the AICO window shows: the import centre's wizard. */
const STAYS = /^browser:import:/;

/** Which window an event goes to: `main` the AICO window, `browser` the browser's own (only while it has one). */
export function eventRoute(channel: string, poppedOut: boolean): { main: boolean; browser: boolean } {
  if (!poppedOut) return { main: true, browser: false };
  if (BOTH.test(channel)) return { main: true, browser: true };
  if (FOLLOWS_BROWSER.test(channel) && !STAYS.test(channel)) return { main: false, browser: true };
  return { main: true, browser: false };
}
