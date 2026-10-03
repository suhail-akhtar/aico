/**
 * xterm's colours from the app's CSS variables, so terminals follow light and
 * dark mode and the person's accent. Shared by the shell tabs and the
 * read-only Agent tab.
 *
 * @module desktop/renderer/ide/terminal-theme
 */

export function themeFromCss(): Record<string, string> {
  const css = getComputedStyle(document.documentElement);
  const v = (n: string): string => css.getPropertyValue(n).trim();
  const dark = document.documentElement.classList.contains('dark');
  return {
    background: v('--aico-bg'), foreground: v('--aico-text-primary'), cursor: v('--aico-accent'),
    selectionBackground: dark ? 'rgba(120,160,255,0.3)' : 'rgba(40,90,220,0.22)',
    black: dark ? '#1e1e1e' : '#000000', red: '#e5534b', green: dark ? '#57ab5a' : '#1a7f37', yellow: dark ? '#c69026' : '#9a6700', blue: '#539bf5',
    magenta: '#b083f0', cyan: dark ? '#39c5cf' : '#1b7c83', white: dark ? '#d0d0d0' : '#6e7781',
    brightBlack: '#6e7681', brightRed: '#ff7b72', brightGreen: dark ? '#7ee787' : '#2da44e', brightYellow: dark ? '#e3b341' : '#bf8700', brightBlue: '#79c0ff',
    brightMagenta: '#d2a8ff', brightCyan: dark ? '#56d4dd' : '#3192aa', brightWhite: dark ? '#ffffff' : '#24292f',
  };
}
