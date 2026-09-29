/**
 * Full view: the browser fills the whole window, the way a browser looks —
 * no AICO sidebar, top bar or status bar; the tabs sit at the very top beside
 * the window's own controls (which the tab strip keeps clear of).
 *
 * Two ways in. "Full view" (toolbar button, ⋮ menu, Shift+F11) keeps the
 * window as it is. Full screen (F11) makes the window full screen as well,
 * and turns full view on with it — leaving full screen turns it back off if
 * full screen is what turned it on. Ways out: the button at the end of the
 * tab strip, Esc (when the page does not have the keyboard), F11 / Shift+F11.
 *
 * A video's own full screen (HTML full screen) is main's business: the page
 * fills the window above everything, and Esc leaves it.
 *
 * @module desktop/renderer/browser/fullview
 */

import { create } from 'zustand';
import { on } from '@/desktop';
import { toast } from '@/state/desk';
import { call } from './ipc';

interface FullView {
  on: boolean;
  /** The window is full screen (F11). */
  windowFs: boolean;
  /** Full view was turned on by going full screen, so leaving full screen turns it off. */
  auto: boolean;
}

export const useFullView = create<FullView>(() => ({ on: false, windowFs: false, auto: false }));

let hinted = false;
function hint(): void {
  if (hinted) return;
  hinted = true;
  toast.info('Full view', 'Press F11 or Esc — or use the button at the top right — to bring AICO back.');
}

export function setFullView(next: boolean): void {
  const s = useFullView.getState();
  if (s.on === next) return;
  useFullView.setState({ on: next, auto: false });
  if (next) hint();
  // Leaving full view leaves full screen too: there is nothing to be full screen for.
  else if (s.windowFs) void call('browser:windowFullscreen', false).catch(() => {});
}

export function toggleFullView(): void {
  setFullView(!useFullView.getState().on);
}

/** F11: the window full screen, with the browser filling it. */
export function toggleFullscreen(): void {
  void call<boolean>('browser:windowFullscreen').catch(() => {});
}

let installed = false;

/** Follow the window's full-screen state (F11 from the page, the window's own control, a video leaving). */
export function installFullView(): void {
  if (installed) return;
  installed = true;
  on<boolean>('win:fullscreen', (fs) => {
    const s = useFullView.getState();
    if (fs) {
      if (s.on) useFullView.setState({ windowFs: true });
      else { useFullView.setState({ windowFs: true, on: true, auto: true }); hint(); }
    } else {
      useFullView.setState({ windowFs: false, ...(s.auto ? { on: false, auto: false } : {}) });
    }
  });
  void call<boolean>('browser:isWindowFullscreen').then((fs) => { if (fs) useFullView.setState({ windowFs: true }); }).catch(() => {});
}
