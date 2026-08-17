/**
 * Putting the chosen theme on the page.
 *
 * The stylesheet keys everything off `data-theme` on `<html>`, so switching is
 * one attribute rather than a rebuild. This is the only thing that ever sets
 * it.
 *
 * `auto` follows the operating system *and keeps following it*: a laptop that
 * flips to dark at sunset should take an open tab with it, which means holding
 * on to the media-query listener rather than reading `matches` once at boot.
 *
 * @module theme
 */

export type ThemeChoice = 'light' | 'dark' | 'auto';

const DARK_QUERY = '(prefers-color-scheme: dark)';

let stopFollowing: (() => void) | null = null;

/**
 * Apply a theme, and follow the system if that is what was asked for.
 *
 * Safe to call repeatedly with the same value; each call replaces the previous
 * subscription, so a settings screen that writes on every keystroke cannot
 * accumulate listeners.
 */
export function applyTheme(choice: ThemeChoice | undefined): void {
  stopFollowing?.();
  stopFollowing = null;

  const root = document.documentElement;
  const resolved = choice ?? 'auto';

  if (resolved !== 'auto') {
    root.dataset.theme = resolved;
    return;
  }

  const media = window.matchMedia(DARK_QUERY);
  const sync = (): void => { root.dataset.theme = media.matches ? 'dark' : 'light'; };
  sync();
  media.addEventListener('change', sync);
  stopFollowing = () => media.removeEventListener('change', sync);
}
