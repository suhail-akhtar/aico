/**
 * Browser shortcuts pressed while a web page has focus.
 *
 * The page's WebContentsView takes keyboard focus away from the interface, so
 * Ctrl+T, Ctrl+F, Alt+← … would reach the page instead of the browser chrome.
 * Main catches the ones every browser reserves and forwards them to the
 * interface as `browser:shortcut` ({ key: "Ctrl+Shift+Tab" }), which maps them
 * to the same actions as its own key handler. Everything else (Ctrl+A/C/V,
 * Escape, plain typing) stays with the page.
 *
 * @module desktop/electron/browser-keys
 */

export interface KeyInput { type: string; key: string; control: boolean; meta: boolean; shift: boolean; alt: boolean }

const WITH_MOD = new Set(['t', 'w', 'Tab', 'l', 'r', 'f', 'd', 'h', 'j', 'p', '=', '+', '-', '_', '0', '1', '2', '3', '4', '5', '6', '7', '8', '9', 'PageUp', 'PageDown']);
const WITH_MOD_SHIFT = new Set(['Tab', 'a', 'r', 't', '+', '=', 'PageUp', 'PageDown', 'b', 'd', 'o', 'n']);

/** The shortcut spec to forward ("Ctrl+F"), or null when the key belongs to the page. */
export function browserShortcutSpec(input: KeyInput, mac = process.platform === 'darwin'): string | null {
  if (input.type !== 'keyDown') return null;
  const key = input.key.length === 1 ? input.key.toLowerCase() : input.key;
  const mod = mac ? input.meta : input.control;
  // Always spelled Ctrl: the interface reads forwarded shortcuts platform-neutrally.
  const modName = 'Ctrl';
  if (input.alt && !mod && !input.shift && (key === 'ArrowLeft' || key === 'ArrowRight')) return `Alt+${key}`;
  if (!mod && !input.alt && !input.shift && (key === 'F5' || key === 'F11' || key === 'F12')) return key;
  if (!mod && !input.alt && input.shift && key === 'F11') return 'Shift+F11';
  if (!mod || input.alt) return null;
  if (input.shift) return WITH_MOD_SHIFT.has(key) ? `${modName}+Shift+${key}` : null;
  return WITH_MOD.has(key) ? `${modName}+${key}` : null;
}
