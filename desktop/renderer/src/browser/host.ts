/**
 * Where the browser is: in the AICO window, or in a window of its own.
 *
 * The browser lives in one window at a time (electron/browser-window.ts).
 * Popped out, the AICO window's Browser page and side dock show a placeholder
 * instead of the browser, and everything that would show the browser — a
 * Ctrl+click on a link in the chat, "Open the browser", the copilot's command
 * — brings the browser's own window forward instead. That window's document
 * (browser-main.tsx) calls `markBrowserWindow()` before it renders: there the
 * browser is always on screen, and "pop out" means "move back".
 *
 * Main says where the browser is (`browser:host`); the AICO window, getting
 * it back, re-reads the tabs, bookmarks and downloads it stopped hearing
 * about while it was away.
 *
 * @module desktop/renderer/browser/host
 */

import { create } from 'zustand';
import { on } from '@/desktop';
import { go, useDesk } from '@/state/desk';
import { call, fire } from './ipc';
import { refreshBookmarks, refreshDownloads, refreshState } from './store';
import { setFullView } from './fullview';

export const useBrowserHost = create<{ popped: boolean }>(() => ({ popped: false }));

let own = false;

/** This document is the browser's own window (browser-main.tsx). */
export function markBrowserWindow(): void { own = true; }
export function inBrowserWindow(): boolean { return own; }

/** The browser is in another window than this one: this is the AICO window, and the browser has popped out. */
export function useBrowserElsewhere(): boolean {
  return useBrowserHost(s => s.popped) && !own;
}
export function browserElsewhere(): boolean { return useBrowserHost.getState().popped && !own; }

export function popOutBrowser(): void { fire('browser:window:popOut'); }
export function popInBrowser(): void { fire('browser:window:popIn'); }
/** Ctrl+Shift+N and the menus: out to its own window, or (from there) back. */
export function toggleBrowserWindow(): void { if (own) popInBrowser(); else popOutBrowser(); }
export function focusBrowserWindow(): void { fire('browser:window:focus'); }
/** From the browser's window: bring the AICO window forward. */
export function openAicoWindow(): void { fire('browser:window:showMain'); }

/** Show the browser: this window's Browser page, or the browser's own window while it has one. */
export function showBrowser(params?: Record<string, string>): void {
  if (own) return;
  if (browserElsewhere()) { focusBrowserWindow(); return; }
  go('browser', params);
}

let installed = false;
let applyHost: ((popped: boolean, show?: boolean) => void) | null = null;

/** Ask main where the browser is (main said this window's pane is not where it is). */
export function refreshBrowserHost(): void {
  void call<{ popped: boolean }>('browser:window:state').then((s) => { if (s) applyHost?.(Boolean(s.popped)); }).catch(() => {});
}

export function installBrowserHost(): void {
  if (installed) return;
  installed = true;
  const apply = (popped: boolean, show = false): void => {
    const was = useBrowserHost.getState().popped;
    if (was === popped) return;
    useBrowserHost.setState({ popped });
    if (own) return;
    if (popped) {
      // Nothing of the browser is left here to fill the window with.
      setFullView(false);
    } else {
      // Back here: catch up on what the browser's window heard instead.
      void refreshState();
      void refreshBookmarks();
      void refreshDownloads();
      if (show) go('browser');
    }
  };
  applyHost = apply;
  on<{ popped?: boolean; show?: boolean }>('browser:host', (h) => apply(Boolean(h?.popped), Boolean(h?.show)));
  refreshBrowserHost();
  // The browser's window has no settings of its own: it asks this one to show them.
  if (!own) on<string>('browser:window:openSettings', (section) => useDesk.getState().openSettings(section as never));
}
