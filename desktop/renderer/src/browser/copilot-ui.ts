/**
 * Where the copilot is and how it looks: open or minimised to its launcher,
 * docked beside the page or floating over it, and its size and place.
 * Remembered per window (localStorage), so it comes back as it was left.
 *
 * @module desktop/renderer/browser/copilot-ui
 */

import { create } from 'zustand';
import { useDesk } from '@/state/desk';

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

useCopilotUi.subscribe((s) => {
  const { prefill: _p, ...keep } = s;
  void _p;
  try { localStorage.setItem(KEY, JSON.stringify(keep)); } catch { /* a per-window convenience */ }
});

/** The copilot lives in the full-size browser; asking for it from the side dock goes there. */
function toFullBrowser(): void {
  const d = useDesk.getState();
  if (d.route.view === 'browser') return;
  if (d.dock.open) d.setDock({ open: false });
  d.navigate({ view: 'browser' });
}

export function toggleCopilot(force?: boolean): void {
  const s = useCopilotUi.getState();
  if (force !== false && useDesk.getState().route.view !== 'browser') { toFullBrowser(); force = true; }
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
