/**
 * The plugin contract.
 *
 * Shared by main (which reads plugin folders from disk and serves the desktop
 * MCP tools that let the agent write them) and the renderer (which turns
 * contributions into sidebar entries, pages, commands, themes and widgets).
 *
 * A manifest is plain JSON on purpose: it is what the orchestrator writes when
 * it customises the IDE for someone, so it must be something a model can
 * produce and a person can read and edit.
 *
 * @module desktop/shared/plugin-types
 */

export const PLUGIN_API_VERSION = 1;

/** Icons a manifest may name. The renderer maps these to its icon set. */
export const ICON_NAMES = [
  'chat', 'search', 'library', 'clock', 'plug', 'folder', 'folder-open', 'globe', 'git', 'github',
  'terminal', 'code', 'file', 'apps', 'activity', 'settings', 'star', 'bolt', 'book', 'chart',
  'table', 'grid', 'bell', 'user', 'image', 'sparkles', 'wrench', 'shield', 'database', 'cloud',
  'cpu', 'bug', 'flask', 'rocket', 'palette', 'layers', 'list', 'check', 'map', 'calendar', 'mail', 'history', 'stack', 'eye', 'zap', 'git-pr', 'git-branch', 'play', 'shield',
  'heart', 'bookmark', 'compass', 'box', 'puzzle', 'brain', 'calculator', 'atom', 'function',
] as const;
export type IconName = typeof ICON_NAMES[number];

export interface NavItemContribution {
  id: string;
  title: string;
  icon?: IconName;
  /** A view id: a built-in one (`library`, `git`, …) or `<pluginId>:<viewId>`. */
  view: string;
  /** `primary` shows in the sidebar list; `more` sits under "More". Default primary. */
  placement?: 'primary' | 'more';
  order?: number;
}

/** A page. Declarative kinds need no code; `frame` runs the plugin's own HTML in a sandbox. */
export type ViewContribution =
  | { id: string; title: string; icon?: IconName; kind: 'markdown'; markdown: string }
  | { id: string; title: string; icon?: IconName; kind: 'frame'; entry: string; height?: number }
  | { id: string; title: string; icon?: IconName; kind: 'prompt-board'; description?: string; prompts: Array<{ title: string; prompt: string; icon?: IconName }> }
  | { id: string; title: string; icon?: IconName; kind: 'links'; description?: string; links: Array<{ title: string; url: string; description?: string }> };

export type CommandAction =
  /** Start a new chat (or send in the current one) with this prompt. */
  | { type: 'prompt'; prompt: string; newChat?: boolean; send?: boolean }
  | { type: 'open-view'; view: string }
  | { type: 'open-url'; url: string }
  /** Open the built-in browser at a URL. */
  | { type: 'browse'; url: string }
  /** Run in the terminal panel; always shown to the user before it runs. */
  | { type: 'terminal'; command: string; cwd?: string }
  /** Run another command by id. */
  | { type: 'command'; command: string; args?: unknown }
  /** Apply a theme this plugin (or any plugin) contributes. */
  | { type: 'theme'; theme: string };

export interface CommandContribution {
  id: string;
  title: string;
  category?: string;
  icon?: IconName;
  /** e.g. "Ctrl+Alt+G". */
  keybinding?: string;
  action: CommandAction;
}

export interface ThemeContribution {
  id: string;
  label: string;
  mode: 'light' | 'dark';
  background: string;
  foreground: string;
  accent: string;
}

export interface QuickPromptContribution {
  id: string;
  title: string;
  prompt: string;
  icon?: IconName;
  /** Show on the home screen under the composer. */
  home?: boolean;
}

export interface StatusItemContribution {
  id: string;
  text: string;
  tooltip?: string;
  command?: string;
  align?: 'left' | 'right';
}

/**
 * A chat fence language this plugin renders. The fence body is posted to the
 * plugin's `entry` HTML in a sandboxed frame, which draws it.
 */
export interface WidgetContribution {
  language: string;
  title?: string;
  entry: string;
  height?: number;
}

/** Text added to every chat's instructions while the plugin is on. */
export interface InstructionContribution {
  id: string;
  text: string;
}

export interface PluginContributes {
  navItems?: NavItemContribution[];
  views?: ViewContribution[];
  commands?: CommandContribution[];
  themes?: ThemeContribution[];
  prompts?: QuickPromptContribution[];
  statusItems?: StatusItemContribution[];
  widgets?: WidgetContribution[];
  instructions?: InstructionContribution[];
}

export interface PluginManifest {
  /** Lower-case, dots and dashes: `acme.release-helper`. */
  id: string;
  name: string;
  version: string;
  description?: string;
  author?: string;
  icon?: IconName;
  apiVersion?: number;
  contributes: PluginContributes;
  /** Set by the host for plugins that ship with the app. */
  builtin?: boolean;
  /** Plugins that ship on and cannot be switched off (Chat, Settings). */
  required?: boolean;
  /** Category shown on the Plugins page. */
  category?: string;
}

export interface InstalledPlugin {
  manifest: PluginManifest;
  source: 'builtin' | 'user';
  /** Folder on disk, for user plugins. */
  dir?: string;
  enabled: boolean;
  /** A user plugin whose manifest did not validate. */
  error?: string;
  /** Contains frame views or widgets (runs its own script, sandboxed). */
  hasScript: boolean;
  trusted: boolean;
}

const ID_RE = /^[a-z0-9][a-z0-9.-]{1,62}$/;

/** Validate and normalise a manifest. Throws with a message a person (or model) can act on. */
export function validateManifest(input: unknown): PluginManifest {
  if (!input || typeof input !== 'object') throw new Error('The manifest must be a JSON object.');
  const m = input as Record<string, unknown>;
  const id = String(m.id ?? '');
  if (!ID_RE.test(id)) throw new Error(`"id" must be lower-case letters, digits, dots or dashes (got "${id}").`);
  if (typeof m.name !== 'string' || !m.name.trim()) throw new Error('"name" is required.');
  const version = typeof m.version === 'string' && m.version ? m.version : '0.1.0';
  const c = (m.contributes && typeof m.contributes === 'object' ? m.contributes : {}) as Record<string, unknown>;
  const arr = <T>(key: string): T[] => {
    const v = c[key];
    if (v === undefined) return [];
    if (!Array.isArray(v)) throw new Error(`"contributes.${key}" must be an array.`);
    return v as T[];
  };
  const needId = (kind: string, items: Array<{ id?: unknown }>): void => {
    const seen = new Set<string>();
    for (const it of items) {
      if (typeof it.id !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,62}$/i.test(it.id)) throw new Error(`Every ${kind} needs an "id" (letters, digits, dot, dash).`);
      if (seen.has(it.id)) throw new Error(`Duplicate ${kind} id "${it.id}".`);
      seen.add(it.id);
    }
  };
  const views = arr<ViewContribution>('views');
  needId('view', views);
  for (const v of views) {
    if (!['markdown', 'frame', 'prompt-board', 'links'].includes((v as { kind: string }).kind)) {
      throw new Error(`View "${v.id}" has an unknown kind; use markdown, frame, prompt-board or links.`);
    }
    if (v.kind === 'frame' && (typeof v.entry !== 'string' || v.entry.includes('..'))) throw new Error(`Frame view "${v.id}" needs an "entry" file inside the plugin folder.`);
  }
  const commands = arr<CommandContribution>('commands');
  needId('command', commands);
  for (const cmd of commands) {
    if (!cmd.action || typeof cmd.action !== 'object' || typeof (cmd.action as { type?: unknown }).type !== 'string') {
      throw new Error(`Command "${cmd.id}" needs an "action" with a "type".`);
    }
  }
  const navItems = arr<NavItemContribution>('navItems');
  needId('nav item', navItems);
  const themes = arr<ThemeContribution>('themes');
  needId('theme', themes);
  for (const t of themes) {
    for (const k of ['background', 'foreground', 'accent'] as const) {
      if (typeof t[k] !== 'string' || !/^#[0-9a-f]{3,8}$/i.test(t[k])) throw new Error(`Theme "${t.id}" needs "${k}" as a #hex colour.`);
    }
    if (t.mode !== 'light' && t.mode !== 'dark') throw new Error(`Theme "${t.id}" needs "mode": "light" or "dark".`);
  }
  const prompts = arr<QuickPromptContribution>('prompts');
  needId('prompt', prompts);
  const statusItems = arr<StatusItemContribution>('statusItems');
  needId('status item', statusItems);
  const instructions = arr<InstructionContribution>('instructions');
  needId('instruction', instructions);
  const widgets = arr<WidgetContribution>('widgets');
  for (const w of widgets) {
    if (typeof w.language !== 'string' || !/^[a-z][a-z0-9-]{1,40}$/.test(w.language)) throw new Error('Every widget needs a lower-case fence "language".');
    if (typeof w.entry !== 'string' || w.entry.includes('..')) throw new Error(`Widget "${w.language}" needs an "entry" file inside the plugin folder.`);
  }
  return {
    id, name: m.name.trim(), version,
    description: typeof m.description === 'string' ? m.description : undefined,
    author: typeof m.author === 'string' ? m.author : undefined,
    icon: typeof m.icon === 'string' && (ICON_NAMES as readonly string[]).includes(m.icon) ? m.icon as IconName : undefined,
    category: typeof m.category === 'string' ? m.category : undefined,
    apiVersion: PLUGIN_API_VERSION,
    contributes: { views, commands, navItems, themes, prompts, statusItems, instructions, widgets },
  };
}

export function manifestHasScript(m: PluginManifest): boolean {
  return (m.contributes.views ?? []).some(v => v.kind === 'frame') || (m.contributes.widgets ?? []).length > 0;
}
