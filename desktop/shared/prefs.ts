/**
 * The desktop's own preferences.
 *
 * Only things that belong to *this window on this machine*: how it looks, how
 * it behaves on close, which plugins are on, where the window was. Everything
 * the engine reads — providers, models, permissions, skills, MCP — stays in the
 * engine's settings, shared with every other client. (The first desktop client
 * kept a second settings database; that is a large part of why it was removed.)
 *
 * @module desktop/shared/prefs
 */

export type ThemeMode = 'system' | 'light' | 'dark';

export interface ThemeColors {
  preset: string;
  background: string;
  foreground: string;
  accent: string;
}

export interface DesktopPrefs {
  theme: ThemeMode;
  contrast: 'default' | 'strong';
  light: ThemeColors;
  dark: ThemeColors;
  /** Base UI font size in px. */
  fontSize: number;
  uiFont: string;
  codeFont: string;
  conversationWidth: 'default' | 'wide' | 'full';
  /** Show the agent's intermediate steps and reasoning expanded. */
  verboseAgent: boolean;
  /** When a reply finishes, scroll up to where it starts instead of leaving you at its last line. */
  jumpToAnswer: boolean;
  /** Send with Enter (Shift+Enter for a newline), or Ctrl+Enter. */
  sendKey: 'enter' | 'ctrl-enter';
  preventSleep: boolean;
  keepInTray: boolean;
  launchAtLogin: boolean;
  notifications: { turnEnd: boolean; attention: boolean; background: boolean; sound: boolean };
  sidebar: { collapsed: boolean; width: number };
  /**
   * `trustedHashes`: the content hash each trusted plugin had when the person
   * trusted it (security-core.ts pluginContentHash). Files that change after
   * that — the agent's ide_plugin_save, a hand edit — revoke the trust.
   */
  plugins: { disabled: string[]; trusted: string[]; trustedHashes?: Record<string, string> };
  window: { x?: number; y?: number; width: number; height: number; maximized: boolean };
  /** Where the browser's home button goes. */
  browserHome: string;
  /** Agent may drive the built-in browser without asking each time. */
  browserAgentAccess: 'ask' | 'allow' | 'deny';
  /** On startup the browser continues where you left off (its tabs and signed-in sessions), or opens a new tab. */
  browserStartup: 'restore' | 'newTab';
  shortcuts: Record<string, string>;
  /**
   * Updates from GitHub releases. `lastCheckedAt` is kept here (not only in
   * the updater's memory) so "last checked" survives a restart.
   */
  autoUpdate: { enabled: boolean; channel: 'latest'; lastCheckedAt: number };
  /** Show "Inspect element" in right-click menus of a packaged build. */
  developerMenus: boolean;
}

export const THEME_PRESETS: Record<'light' | 'dark', Record<string, Omit<ThemeColors, 'preset'>>> = {
  light: {
    'Default Light': { background: '#FFFFFF', foreground: '#0D0D0D', accent: '#2563EB' },
    'Paper': { background: '#F9F9F7', foreground: '#1F1F1C', accent: '#B45309' },
    'Mist': { background: '#F4F6F8', foreground: '#101418', accent: '#0E7490' },
    'Solarized Light': { background: '#FDF6E3', foreground: '#073642', accent: '#268BD2' },
  },
  dark: {
    'Default Dark': { background: '#171717', foreground: '#ECECEC', accent: '#3B82F6' },
    'Midnight': { background: '#0B1020', foreground: '#DDE3F0', accent: '#7C9CFF' },
    'Graphite': { background: '#1E1F22', foreground: '#DFE1E5', accent: '#10A37F' },
    'Solarized Dark': { background: '#002B36', foreground: '#EEE8D5', accent: '#2AA198' },
  },
};

export const DEFAULT_PREFS: DesktopPrefs = {
  theme: 'system',
  contrast: 'default',
  light: { preset: 'Default Light', ...THEME_PRESETS.light['Default Light']! },
  dark: { preset: 'Default Dark', ...THEME_PRESETS.dark['Default Dark']! },
  fontSize: 14,
  uiFont: 'Inter, "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif',
  codeFont: '"JetBrains Mono", "Cascadia Code", Consolas, "DejaVu Sans Mono", monospace',
  conversationWidth: 'default',
  verboseAgent: false,
  jumpToAnswer: true,
  sendKey: 'enter',
  preventSleep: false,
  keepInTray: false,
  launchAtLogin: false,
  notifications: { turnEnd: true, attention: true, background: true, sound: false },
  sidebar: { collapsed: false, width: 272 },
  plugins: { disabled: [], trusted: [] },
  window: { width: 1360, height: 880, maximized: false },
  browserHome: 'https://duckduckgo.com',
  browserAgentAccess: 'allow',
  browserStartup: 'restore',
  shortcuts: {},
  autoUpdate: { enabled: true, channel: 'latest', lastCheckedAt: 0 },
  developerMenus: false,
};

/** Deep-merge a partial prefs object over the defaults, dropping unknown keys' wrong types. */
export function mergePrefs(base: DesktopPrefs, patch: unknown): DesktopPrefs {
  if (!patch || typeof patch !== 'object') return base;
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
    if (!(key in base)) continue;
    const current = (base as unknown as Record<string, unknown>)[key];
    if (current && typeof current === 'object' && !Array.isArray(current) && value && typeof value === 'object' && !Array.isArray(value)) {
      out[key] = { ...(current as object), ...(value as object) };
    } else if (value === undefined) {
      continue;
    } else if (current === undefined || (typeof current === typeof value && Array.isArray(current) === Array.isArray(value))) {
      out[key] = value;
    }
  }
  return out as unknown as DesktopPrefs;
}
