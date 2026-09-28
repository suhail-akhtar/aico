/**
 * The plugin registry: where every sidebar entry, page, command, theme, quick
 * prompt, status item and chat widget comes from.
 *
 * Built-in features register here exactly as a user plugin does — they just
 * bring React components where a user plugin brings declarative views or a
 * sandboxed frame. Switching a plugin off removes all of its contributions at
 * once, and nothing in the shell hard-codes a feature, which is what lets the
 * orchestrator reshape the IDE without touching its code.
 *
 * @module desktop/renderer/plugins/registry
 */

import type React from 'react';
import { create } from 'zustand';
import type {
  CommandAction, InstalledPlugin, NavItemContribution, PluginManifest, QuickPromptContribution,
  StatusItemContribution, ThemeContribution, ViewContribution, WidgetContribution, InstructionContribution,
} from '@desk/plugin-types';
import { invoke, on } from '@/desktop';
import { useDesk } from '@/state/desk';

export interface ViewProps { params?: Record<string, string> }

export interface BuiltinView {
  id: string;
  title: string;
  icon?: string;
  component: React.ComponentType<ViewProps>;
  /** Hide the page's own top bar (the chat draws its own). */
  chromeless?: boolean;
}

export interface RuntimeCommand {
  id: string;
  title: string;
  category?: string;
  icon?: string;
  keybinding?: string;
  run: (args?: unknown) => void | Promise<void>;
  pluginId: string;
  /** A declarative action, for commands that came from a manifest. */
  action?: CommandAction;
}

export interface SettingsContribution {
  id: string;
  title: string;
  icon?: string;
  group?: 'app' | 'agent' | 'integrations';
  order?: number;
  component: React.ComponentType;
}

export interface BuiltinPlugin {
  manifest: PluginManifest;
  views?: BuiltinView[];
  commands?: Array<Omit<RuntimeCommand, 'pluginId'>>;
  settings?: SettingsContribution[];
  /** Runs when the plugin is switched on; the returned function when it is switched off. */
  activate?: () => void | (() => void);
}

export interface ResolvedView {
  id: string;
  title: string;
  icon?: string;
  pluginId: string;
  component?: React.ComponentType<ViewProps>;
  declarative?: ViewContribution;
  plugin?: InstalledPlugin;
  chromeless?: boolean;
}

interface RegistryState {
  builtins: BuiltinPlugin[];
  user: InstalledPlugin[];
  loaded: boolean;
  registerBuiltin: (p: BuiltinPlugin) => void;
  reloadUser: () => Promise<void>;
}

export const useRegistry = create<RegistryState>((set, get) => ({
  builtins: [],
  user: [],
  loaded: false,
  registerBuiltin: (p) => {
    if (get().builtins.some(b => b.manifest.id === p.manifest.id)) return;
    set({ builtins: [...get().builtins, { ...p, manifest: { ...p.manifest, builtin: true } }] });
  },
  reloadUser: async () => {
    try {
      const user = await invoke<InstalledPlugin[]>('plugins:list');
      set({ user, loaded: true });
    } catch {
      set({ loaded: true });
    }
  },
}));

let watching = false;
export function watchUserPlugins(): void {
  if (watching) return;
  watching = true;
  on('plugins:changed', () => { void useRegistry.getState().reloadUser(); });
  void useRegistry.getState().reloadUser();
}

/** Is this plugin on? Required plugins always are. */
export function isEnabled(id: string, required?: boolean): boolean {
  if (required) return true;
  return !useDesk.getState().prefs.plugins.disabled.includes(id);
}

// ── Selectors ────────────────────────────────────────────────────────────────
// Hooks that recompute when the registry or the enabled set changes.

function useEnabledState(): { builtins: BuiltinPlugin[]; user: InstalledPlugin[] } {
  const builtins = useRegistry(s => s.builtins);
  const user = useRegistry(s => s.user);
  const disabled = useDesk(s => s.prefs.plugins.disabled);
  const trusted = useDesk(s => s.prefs.plugins.trusted);
  return {
    builtins: builtins.filter(b => b.manifest.required || !disabled.includes(b.manifest.id)),
    user: user
      .filter(u => !u.error && !disabled.includes(u.manifest.id))
      .map(u => ({ ...u, trusted: !u.hasScript || trusted.includes(u.manifest.id) })),
  };
}

export function allManifests(): Array<{ manifest: PluginManifest; source: 'builtin' | 'user'; installed?: InstalledPlugin }> {
  const { builtins, user } = useRegistry.getState();
  return [
    ...builtins.map(b => ({ manifest: b.manifest, source: 'builtin' as const })),
    ...user.map(u => ({ manifest: u.manifest, source: 'user' as const, installed: u })),
  ];
}

export function useNavItems(): Array<NavItemContribution & { pluginId: string }> {
  const { builtins, user } = useEnabledState();
  const items: Array<NavItemContribution & { pluginId: string }> = [];
  for (const b of builtins) for (const n of b.manifest.contributes.navItems ?? []) items.push({ ...n, pluginId: b.manifest.id });
  for (const u of user) {
    for (const n of u.manifest.contributes.navItems ?? []) {
      const view = n.view.includes(':') ? n.view : `${u.manifest.id}:${n.view}`;
      items.push({ ...n, view, pluginId: u.manifest.id, order: n.order ?? 500 });
    }
  }
  return items.sort((a, b) => (a.order ?? 100) - (b.order ?? 100));
}

export function resolveView(id: string): ResolvedView | null {
  const { builtins, user } = useRegistry.getState();
  const disabled = useDesk.getState().prefs.plugins.disabled;
  for (const b of builtins) {
    if (!b.manifest.required && disabled.includes(b.manifest.id)) continue;
    const v = b.views?.find(x => x.id === id);
    if (v) return { id: v.id, title: v.title, icon: v.icon, pluginId: b.manifest.id, component: v.component, chromeless: v.chromeless };
  }
  const colon = id.indexOf(':');
  if (colon > 0) {
    const pid = id.slice(0, colon);
    const vid = id.slice(colon + 1);
    const p = user.find(u => u.manifest.id === pid && !u.error && !disabled.includes(pid));
    const v = p?.manifest.contributes.views?.find(x => x.id === vid);
    if (p && v) return { id, title: v.title, icon: v.icon, pluginId: pid, declarative: v, plugin: p };
  }
  return null;
}

export function useCommands(): RuntimeCommand[] {
  const { builtins, user } = useEnabledState();
  const out: RuntimeCommand[] = [];
  for (const b of builtins) for (const c of b.commands ?? []) out.push({ ...c, pluginId: b.manifest.id });
  for (const u of user) {
    for (const c of u.manifest.contributes.commands ?? []) {
      out.push({
        id: `${u.manifest.id}:${c.id}`,
        title: c.title,
        category: c.category ?? u.manifest.name,
        icon: c.icon,
        keybinding: c.keybinding,
        pluginId: u.manifest.id,
        action: c.action,
        run: () => runAction(c.action, u.manifest.id),
      });
    }
  }
  return out;
}

/** Every command right now, outside React (for keybindings and the agent). */
export function commandsNow(): RuntimeCommand[] {
  const { builtins, user } = useRegistry.getState();
  const disabled = useDesk.getState().prefs.plugins.disabled;
  const out: RuntimeCommand[] = [];
  for (const b of builtins) {
    if (!b.manifest.required && disabled.includes(b.manifest.id)) continue;
    for (const c of b.commands ?? []) out.push({ ...c, pluginId: b.manifest.id });
  }
  for (const u of user) {
    if (u.error || disabled.includes(u.manifest.id)) continue;
    for (const c of u.manifest.contributes.commands ?? []) {
      out.push({ id: `${u.manifest.id}:${c.id}`, title: c.title, category: c.category ?? u.manifest.name, icon: c.icon, keybinding: c.keybinding, pluginId: u.manifest.id, action: c.action, run: () => runAction(c.action, u.manifest.id) });
    }
  }
  return out;
}

export function runCommand(id: string, args?: unknown): boolean {
  const cmd = commandsNow().find(c => c.id === id);
  if (!cmd) return false;
  void Promise.resolve(cmd.run(args)).catch((err: Error) => {
    useDesk.getState().toast({ kind: 'error', title: `“${cmd.title}” failed`, body: err.message });
  });
  return true;
}

export function useThemes(): Array<ThemeContribution & { pluginId: string }> {
  const { builtins, user } = useEnabledState();
  const out: Array<ThemeContribution & { pluginId: string }> = [];
  for (const b of builtins) for (const t of b.manifest.contributes.themes ?? []) out.push({ ...t, pluginId: b.manifest.id });
  for (const u of user) for (const t of u.manifest.contributes.themes ?? []) out.push({ ...t, pluginId: u.manifest.id });
  return out;
}

export function usePrompts(): Array<QuickPromptContribution & { pluginId: string }> {
  const { builtins, user } = useEnabledState();
  const out: Array<QuickPromptContribution & { pluginId: string }> = [];
  for (const b of builtins) for (const p of b.manifest.contributes.prompts ?? []) out.push({ ...p, pluginId: b.manifest.id });
  for (const u of user) for (const p of u.manifest.contributes.prompts ?? []) out.push({ ...p, pluginId: u.manifest.id });
  return out;
}

export function useStatusItems(): Array<StatusItemContribution & { pluginId: string }> {
  const { builtins, user } = useEnabledState();
  const out: Array<StatusItemContribution & { pluginId: string }> = [];
  for (const b of builtins) for (const s of b.manifest.contributes.statusItems ?? []) out.push({ ...s, pluginId: b.manifest.id });
  for (const u of user) for (const s of u.manifest.contributes.statusItems ?? []) out.push({ ...s, pluginId: u.manifest.id });
  return out;
}

export function useSettingsSections(): Array<SettingsContribution & { pluginId: string }> {
  const { builtins } = useEnabledState();
  const out: Array<SettingsContribution & { pluginId: string }> = [];
  for (const b of builtins) for (const s of b.settings ?? []) out.push({ ...s, pluginId: b.manifest.id });
  return out.sort((a, b) => (a.order ?? 100) - (b.order ?? 100));
}

/** Fence languages rendered by trusted user plugins. */
export function pluginWidgetsNow(): Array<WidgetContribution & { pluginId: string }> {
  const { user } = useRegistry.getState();
  const { disabled, trusted } = useDesk.getState().prefs.plugins;
  const out: Array<WidgetContribution & { pluginId: string }> = [];
  for (const u of user) {
    if (u.error || disabled.includes(u.manifest.id) || !trusted.includes(u.manifest.id)) continue;
    for (const w of u.manifest.contributes.widgets ?? []) out.push({ ...w, pluginId: u.manifest.id });
  }
  return out;
}

/** Instructions every enabled plugin adds to a chat. */
export function pluginInstructionsNow(): Array<InstructionContribution & { pluginId: string }> {
  const { user, builtins } = useRegistry.getState();
  const disabled = useDesk.getState().prefs.plugins.disabled;
  const out: Array<InstructionContribution & { pluginId: string }> = [];
  for (const b of builtins) {
    if (!b.manifest.required && disabled.includes(b.manifest.id)) continue;
    for (const i of b.manifest.contributes.instructions ?? []) out.push({ ...i, pluginId: b.manifest.id });
  }
  for (const u of user) {
    if (u.error || disabled.includes(u.manifest.id)) continue;
    for (const i of u.manifest.contributes.instructions ?? []) out.push({ ...i, pluginId: u.manifest.id });
  }
  return out;
}

// ── Declarative actions ──────────────────────────────────────────────────────
// Set by the app at start-up so this module does not import the chat store.

type ActionRunner = (action: CommandAction, pluginId: string) => void | Promise<void>;
let actionRunner: ActionRunner = () => { throw new Error('Actions are not ready yet.'); };

export function setActionRunner(fn: ActionRunner): void { actionRunner = fn; }
export function runAction(action: CommandAction, pluginId: string): void | Promise<void> {
  return actionRunner(action, pluginId);
}
