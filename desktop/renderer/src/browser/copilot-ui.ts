/**
 * Where the copilot is and how it looks: open or minimised to its launcher,
 * docked beside the page or floating over it, and its size and place.
 * Remembered in localStorage, so it comes back as it was left.
 *
 * Two documents share this record: the main window (the docked copilot, the
 * launcher, the toolbar button) and the floating copilot's own view laid over
 * the page (copilot-main.tsx). Each applies what the other writes (`storage`
 * events), so closing, docking or moving the copilot in one is seen by the
 * other. A prefill is not part of the record; it is relayed (copilot-float.ts).
 *
 * @module desktop/renderer/browser/copilot-ui
 */

import { create } from 'zustand';
import { useDesk } from '@/state/desk';
import { remoteUiPatch } from '@desk/copilot-float';
import { browserElsewhere, focusBrowserWindow } from './host';

export interface CopilotUi {
  open: boolean;
  minimized: boolean;
  mode: 'dock' | 'float';
  /** Floating: top-left within the browser area, and size. */
  x: number; y: number; w: number; h: number;
  dockWidth: number;
  /** Send the page header with each message. */
  attachPage: boolean;
  /** Text to put in the copilot's input (a quick start), stamped so the same text twice still arrives. */
  prefill: { text: string; at: number } | null;
}

const KEY = 'aico.browser.copilot.ui';
const DEFAULTS: CopilotUi = { open: false, minimized: false, mode: 'dock', x: -1, y: 16, w: 400, h: 560, dockWidth: 400, attachPage: true, prefill: null };

function load(): CopilotUi {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { ...DEFAULTS, ...JSON.parse(raw), prefill: null };
  } catch { /* defaults */ }
  return DEFAULTS;
}

export const useCopilotUi = create<CopilotUi>(() => load());

/** Which document this is: the main window, or the floating copilot's own view. */
export type CopilotSurface = 'window' | 'overlay';
let surface: CopilotSurface = 'window';
export function setCopilotSurface(s: CopilotSurface): void { surface = s; }
export function copilotSurface(): CopilotSurface { return surface; }

let applyingRemote = false;

useCopilotUi.subscribe((s) => {
  // Writing back what the other document just wrote would race its next write (a drag writes many).
  if (applyingRemote) return;
  const { prefill: _p, ...keep } = s;
  void _p;
  try { localStorage.setItem(KEY, JSON.stringify(keep)); } catch { /* a per-window convenience */ }
});

if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key !== KEY) return;
    const patch = remoteUiPatch(useCopilotUi.getState(), e.newValue);
    if (!patch) return;
    applyingRemote = true;
    try { useCopilotUi.setState(patch); } finally { applyingRemote = false; }
  });
}

/** The copilot lives in the full-size browser; asking for it from the side dock goes there (or to the browser's own window). */
function toFullBrowser(): void {
  if (surface === 'overlay') return;
  if (browserElsewhere()) { focusBrowserWindow(); return; }
  const d = useDesk.getState();
  if (d.route.view === 'browser') return;
  if (d.dock.open) d.setDock({ open: false });
  d.navigate({ view: 'browser' });
}

export function toggleCopilot(force?: boolean): void {
  const s = useCopilotUi.getState();
  if (surface === 'window' && force !== false && useDesk.getState().route.view !== 'browser') { toFullBrowser(); force = true; }
  const visible = s.open && !s.minimized;
  const next = force ?? !visible;
  useCopilotUi.setState({ open: next, minimized: false });
  if (next) window.dispatchEvent(new Event('aico:copilot-focus'));
}

export function minimizeCopilot(): void {
  useCopilotUi.setState({ open: true, minimized: true });
}

export function prefillCopilot(text: string): void {
  toFullBrowser();
  useCopilotUi.setState({ open: true, minimized: false, prefill: { text, at: Date.now() } });
  window.dispatchEvent(new Event('aico:copilot-focus'));
}

export { clampFloat } from './geometry';
