/**
 * Tailwind for the panel.
 *
 * The colour scale is not redefined here — it already resolves to `--aico-*`
 * custom properties in the browser client's config, and `src/vscode-theme.css`
 * redefines those in terms of the user's VS Code theme. So `bg-aico-elevated` in
 * a shared component becomes the editor's widget background with nothing else
 * changed, on any theme anyone installs.
 *
 * The one thing that must differ is `content`. Tailwind only emits classes it
 * can see in a file, and the panel renders components that live in two other
 * directories — miss either glob and those components render unstyled with no
 * error to explain it.
 *
 * @type {import('tailwindcss').Config}
 */
import web from '../../web/tailwind.config.js';

export default {
  ...web,
  content: [
    './src/**/*.{ts,tsx}',
    '../../shared/ui/**/*.{ts,tsx}',
    // The store and reducer carry no classes, but `web/src` does supply a few
    // components the panel reuses directly.
    '../../web/src/**/*.{ts,tsx}',
  ],
  /*
   * No `darkMode: 'class'` toggle here.
   *
   * The browser client switches a class on <html>. VS Code owns the theme, sets
   * its own class on the body, and changes it live — so the panel derives
   * everything from `--vscode-*` variables and never has a dark mode of its own
   * to switch.
   */
  darkMode: 'media',
};
