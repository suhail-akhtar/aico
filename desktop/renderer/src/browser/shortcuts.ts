/**
 * Which browser shortcut a key press is. Pure, so it is unit-tested without a DOM.
 *
 * @module desktop/renderer/browser/shortcuts
 */

export type BrowserAction =
  | 'newTab' | 'closeTab' | 'nextTab' | 'prevTab' | 'focusAddress' | 'reload' | 'hardReload' | 'find'
  | 'bookmark' | 'history' | 'downloads' | 'zoomIn' | 'zoomOut' | 'zoomReset' | 'back' | 'forward'
  | 'escape' | 'print' | 'devtools' | 'copilot' | 'bookmarksBar' | 'bookmarkAll' | 'bookmarkManager'
  | 'reopenTab' | 'fullView' | 'fullscreen' | 'savePage' | 'viewSource' | 'moveTabLeft' | 'moveTabRight' | 'popOut'
  | 'tab1' | 'tab2' | 'tab3' | 'tab4' | 'tab5' | 'tab6' | 'tab7' | 'tab8' | 'tab9';

export interface KeyLike { key: string; code?: string; ctrlKey: boolean; shiftKey: boolean; altKey: boolean; metaKey: boolean }

export function browserShortcut(e: KeyLike, mac = false): BrowserAction | null {
  const mod = mac ? e.metaKey : e.ctrlKey;
  const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  if (e.altKey && !mod && !e.shiftKey) {
    if (k === 'ArrowLeft') return 'back';
    if (k === 'ArrowRight') return 'forward';
    return null;
  }
  if (!mod && !e.altKey) {
    if (k === 'F5') return e.shiftKey ? 'hardReload' : 'reload';
    if (k === 'F12') return 'devtools';
    if (k === 'F11') return e.shiftKey ? 'fullView' : 'fullscreen';
    if (k === 'Escape' && !e.shiftKey) return 'escape';
    return null;
  }
  if (!mod || e.altKey) return null;
  if (e.shiftKey) {
    if (k === 'Tab') return 'prevTab';
    if (k === 'PageUp') return 'moveTabLeft';
    if (k === 'PageDown') return 'moveTabRight';
    if (k === 't') return 'reopenTab';
    if (k === 'a') return 'copilot';
    if (k === 'b') return 'bookmarksBar';
    if (k === 'd') return 'bookmarkAll';
    if (k === 'o') return 'bookmarkManager';
    if (k === 'n') return 'popOut';
    if (k === 'r') return 'hardReload';
    if (k === '+' || k === '=') return 'zoomIn';
    return null;
  }
  switch (k) {
    case 't': return 'newTab';
    case 'w': return 'closeTab';
    case 'Tab': case 'PageDown': return 'nextTab';
    case 'PageUp': return 'prevTab';
    case 's': return 'savePage';
    case 'u': return 'viewSource';
    case '1': case '2': case '3': case '4': case '5': case '6': case '7': case '8': case '9': return `tab${k}` as BrowserAction;
    case 'l': return 'focusAddress';
    case 'r': return 'reload';
    case 'f': return 'find';
    case 'd': return 'bookmark';
    case 'h': return 'history';
    case 'j': return 'downloads';
    case 'p': return 'print';
    case '=': case '+': return 'zoomIn';
    case '-': case '_': return 'zoomOut';
    case '0': return 'zoomReset';
    default: return null;
  }
}

/** Parse "Ctrl+Shift+Tab"-style text (as main may forward it from inside the page). */
export function parseShortcut(spec: string): KeyLike {
  // "Ctrl++" names the plus key itself.
  const plus = spec.endsWith('++');
  const cut = plus ? spec.length - 2 : spec.lastIndexOf('+');
  const key = plus ? '+' : spec.slice(cut + 1).trim();
  const parts = cut > 0 ? spec.slice(0, cut).split('+').map(p => p.trim()) : [];
  const has = (m: string): boolean => parts.some(p => p.toLowerCase() === m);
  return { key: key.length === 1 ? key.toLowerCase() : key, ctrlKey: has('ctrl') || has('control'), shiftKey: has('shift'), altKey: has('alt'), metaKey: has('meta') || has('cmd') };
}
