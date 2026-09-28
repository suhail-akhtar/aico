/**
 * Turns three colours into a whole theme.
 *
 * The Appearance screen offers what Antigravity offers — background,
 * foreground, accent per mode, plus a contrast switch — and every other token
 * the interface and the shared renderers use (surfaces, borders, muted text,
 * code, diff, sidebar) is derived from those three by mixing. One source of
 * truth per mode, so a custom theme can never end up with unreadable muted text
 * or a border invisible against its background.
 *
 * @module desktop/renderer/theme
 */

import type { DesktopPrefs, ThemeColors } from '@desk/prefs';

type RGB = [number, number, number];

function parse(hex: string): RGB {
  let h = hex.trim().replace('#', '');
  if (h.length === 3) h = h.split('').map(c => c + c).join('');
  const n = parseInt(h.slice(0, 6), 16);
  if (Number.isNaN(n)) return [128, 128, 128];
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function hex([r, g, b]: RGB): string {
  return '#' + [r, g, b].map(v => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('');
}

/** `a` moved toward `b` by `t` (0..1). */
function mix(a: RGB, b: RGB, t: number): RGB {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

function rgba([r, g, b]: RGB, alpha: number): string {
  return `rgba(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)}, ${alpha})`;
}

function luminance([r, g, b]: RGB): number {
  const f = (v: number): number => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

export function isDarkColors(c: ThemeColors): boolean {
  return luminance(parse(c.background)) < 0.35;
}

export function resolveMode(prefs: DesktopPrefs): 'light' | 'dark' {
  if (prefs.theme === 'system') return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  return prefs.theme;
}

/** Every CSS variable for one mode. */
export function tokensFor(colors: ThemeColors, strong: boolean): Record<string, string> {
  const bg = parse(colors.background);
  const fg = parse(colors.foreground);
  const accent = parse(colors.accent);
  const dark = luminance(bg) < 0.35;
  const k = strong ? 1.6 : 1;
  const white: RGB = [255, 255, 255];
  const black: RGB = [0, 0, 0];

  const onAccent = luminance(accent) > 0.45 ? '#0b0b0b' : '#ffffff';
  const accentHover = hex(mix(accent, dark ? white : black, 0.12));
  const success: RGB = dark ? [78, 209, 126] : [26, 156, 83];
  const warning: RGB = dark ? [247, 173, 49] : [184, 121, 26];
  const danger: RGB = dark ? [242, 90, 90] : [209, 51, 51];
  const info: RGB = dark ? [86, 182, 216] : [43, 127, 168];

  return {
    '--aico-bg': hex(bg),
    '--aico-surface': hex(mix(bg, fg, dark ? 0.035 : 0.025)),
    '--aico-elevated': hex(mix(bg, fg, dark ? 0.07 : 0.045)),
    '--aico-hover': rgba(fg, (dark ? 0.07 : 0.05) * k),
    '--aico-text-primary': hex(fg),
    '--aico-text-secondary': hex(mix(fg, bg, strong ? 0.2 : 0.33)),
    '--aico-text-muted': hex(mix(fg, bg, strong ? 0.38 : 0.52)),
    '--aico-border': rgba(fg, (dark ? 0.13 : 0.11) * k),
    '--aico-border-subtle': rgba(fg, (dark ? 0.08 : 0.065) * k),
    '--aico-accent': hex(accent),
    '--aico-accent-hover': accentHover,
    '--aico-accent-soft': rgba(accent, dark ? 0.18 : 0.11),
    '--aico-on-accent': onAccent,
    '--aico-success': hex(success),
    '--aico-warning': hex(warning),
    '--aico-danger': hex(danger),
    '--aico-info': hex(info),
    '--aico-code-bg': hex(mix(bg, fg, dark ? 0.05 : 0.035)),
    '--aico-diff-add-bg': dark ? 'rgba(63, 185, 80, 0.15)' : '#e6ffec',
    '--aico-diff-add-gutter': dark ? '#3fb950' : '#1a7f37',
    '--aico-diff-remove-bg': dark ? 'rgba(248, 81, 73, 0.15)' : '#ffebe9',
    '--aico-diff-remove-gutter': dark ? '#f85149' : '#cf222e',
    '--aico-diff-context': hex(mix(fg, bg, 0.45)),
    // Desktop chrome: the sidebar sits a shade off the page, like ChatGPT's.
    '--desk-sidebar': hex(mix(bg, fg, dark ? 0.03 : 0.022)),
    '--desk-pill': hex(mix(bg, fg, dark ? 0.085 : 0.055)),
    '--desk-shadow': dark ? '0 8px 30px rgba(0,0,0,0.45)' : '0 8px 30px rgba(0,0,0,0.10)',
    // Tokens the widget kit reads (ported from the ops console).
    '--bg': hex(bg),
    '--bg2': hex(mix(bg, fg, 0.04)),
    '--bg3': hex(mix(bg, fg, 0.08)),
    '--line': rgba(fg, 0.12 * k),
    '--line2': rgba(fg, 0.2 * k),
    '--ink': hex(fg),
    '--ink2': hex(mix(fg, bg, 0.25)),
    '--ink3': hex(mix(fg, bg, 0.45)),
    '--ink4': hex(mix(fg, bg, 0.62)),
    '--ok': hex(success),
    '--warn': hex(warning),
    '--crit': hex(danger),
    '--info': hex(info),
    '--ev': hex(accent),
  };
}

let mediaListener: ((e: MediaQueryListEvent) => void) | null = null;

/** Apply prefs to the document, and keep following the OS when the mode is `system`. */
export function applyTheme(prefs: DesktopPrefs, onModeChange?: (mode: 'light' | 'dark') => void): 'light' | 'dark' {
  const mode = resolveMode(prefs);
  const colors = mode === 'dark' ? prefs.dark : prefs.light;
  const tokens = tokensFor(colors, prefs.contrast === 'strong');
  const root = document.documentElement;
  for (const [k, v] of Object.entries(tokens)) root.style.setProperty(k, v);
  root.style.setProperty('--aico-font', prefs.uiFont);
  root.style.setProperty('--sans', prefs.uiFont);
  root.style.setProperty('--aico-font-mono', prefs.codeFont);
  root.style.setProperty('--mono', prefs.codeFont);
  root.style.setProperty('--desk-font-size', `${prefs.fontSize}px`);
  root.style.setProperty('--aico-column', prefs.conversationWidth === 'full' ? '100%' : prefs.conversationWidth === 'wide' ? '960px' : '768px');
  root.classList.toggle('dark', mode === 'dark');
  root.dataset.theme = mode;
  root.style.colorScheme = mode;

  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  if (mediaListener) mq.removeEventListener('change', mediaListener);
  mediaListener = null;
  if (prefs.theme === 'system') {
    mediaListener = () => { const m = applyTheme(prefs, onModeChange); onModeChange?.(m); };
    mq.addEventListener('change', mediaListener);
  }
  return mode;
}
