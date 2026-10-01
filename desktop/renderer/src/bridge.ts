/**
 * The interface's side of the agent's IDE tools.
 *
 * Main's MCP endpoint receives a tool call (`ide_navigate`, `ide_state`, …),
 * and anything that is about the interface — where you are, which views and
 * commands exist, showing a notification — is asked of the renderer through
 * this bridge: `command:call { id, method, params }` in, `command:reply` out.
 *
 * @module desktop/renderer/bridge
 */

import { useStore } from '@web/store';
import { invoke, on } from '@/desktop';
import { useDesk, toast } from '@/state/desk';
import { commandsNow, runCommand, resolveView, useRegistry, useNavItems } from '@/plugins/registry';
import { newChat, openChat } from '@/chat/actions';
import { applyContributedTheme } from '@/plugins/run-action';
import { THEME_PRESETS } from '@desk/prefs';
import { FRAME_METHODS } from '@/plugins/frame-rpc';
import { browserElsewhere } from '@/browser/host';
import { useCopilot } from '@/browser/copilot-session';

void useNavItems;

type Handler = (params: Record<string, unknown>) => unknown | Promise<unknown>;

const HANDLERS: Record<string, Handler> = {
  /** Everything the agent needs to know about the IDE right now. */
  state: () => {
    const d = useDesk.getState();
    const s = useStore.getState();
    const reg = useRegistry.getState();
    return {
      route: d.route,
      theme: { mode: d.mode, setting: d.prefs.theme, light: d.prefs.light, dark: d.prefs.dark, contrast: d.prefs.contrast },
      layout: { sidebarCollapsed: d.prefs.sidebar.collapsed, bottomPanel: d.panel, sideDock: d.dock, fontSize: d.prefs.fontSize, conversationWidth: d.prefs.conversationWidth },
      chat: { sessionId: s.sessionId, title: s.title, project: s.project, busy: s.busy, model: s.model ?? s.defaultModel },
      projects: s.projects.map(p => ({ name: p.name, path: p.path, workspace: p.isWorkspace })),
      plugins: [
        ...reg.builtins.map(b => ({ id: b.manifest.id, name: b.manifest.name, builtin: true, enabled: b.manifest.required || !d.prefs.plugins.disabled.includes(b.manifest.id), required: Boolean(b.manifest.required), description: b.manifest.description })),
        ...reg.user.map(u => ({ id: u.manifest.id, name: u.manifest.name, builtin: false, enabled: !d.prefs.plugins.disabled.includes(u.manifest.id), error: u.error, description: u.manifest.description })),
      ],
      views: [
        ...reg.builtins.flatMap(b => (b.views ?? []).map(v => ({ id: v.id, title: v.title, plugin: b.manifest.id }))),
        ...reg.user.flatMap(u => (u.manifest.contributes.views ?? []).map(v => ({ id: `${u.manifest.id}:${v.id}`, title: v.title, plugin: u.manifest.id, kind: v.kind }))),
      ],
      commands: commandsNow().map(c => ({ id: c.id, title: c.title, category: c.category, keybinding: d.prefs.shortcuts[c.id] ?? c.keybinding })),
      themePresets: { light: Object.keys(THEME_PRESETS.light), dark: Object.keys(THEME_PRESETS.dark) },
      frameMethods: FRAME_METHODS,
    };
  },
  navigate: (p) => {
    const view = String(p.view ?? '');
    if (view === 'chat' && p.sessionId) { void openChat(String(p.sessionId)); return { ok: true }; }
    if (view !== 'home' && !resolveView(view)) throw new Error(`No view "${view}". Call ide_state for the list.`);
    useDesk.getState().navigate({ view, params: (p.params as Record<string, string> | undefined) });
    return { ok: true, view };
  },
  runCommand: (p) => {
    const id = String(p.command ?? '');
    if (!runCommand(id, p.args)) throw new Error(`No command "${id}". Call ide_state for the list.`);
    return { ok: true };
  },
  notify: (p) => {
    const kind = (['info', 'success', 'warning', 'error'].includes(String(p.kind)) ? String(p.kind) : 'info') as 'info';
    toast[kind](String(p.title ?? ''), p.body ? String(p.body) : undefined);
    return { ok: true };
  },
  setAppearance: async (p) => {
    const d = useDesk.getState();
    const patch: Record<string, unknown> = {};
    if (p.theme === 'light' || p.theme === 'dark' || p.theme === 'system') patch.theme = p.theme;
    if (p.contrast === 'default' || p.contrast === 'strong') patch.contrast = p.contrast;
    if (typeof p.fontSize === 'number') patch.fontSize = Math.max(12, Math.min(18, p.fontSize));
    if (p.conversationWidth === 'default' || p.conversationWidth === 'wide' || p.conversationWidth === 'full') patch.conversationWidth = p.conversationWidth;
    for (const mode of ['light', 'dark'] as const) {
      const c = p[mode] as Record<string, string> | undefined;
      if (c && typeof c === 'object') {
        const preset = c.preset && THEME_PRESETS[mode][c.preset] ? { ...THEME_PRESETS[mode][c.preset]!, preset: c.preset } : null;
        const hex = (v: unknown, fallback: string): string => (typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v) ? v.toUpperCase() : fallback);
        const base = preset ?? d.prefs[mode];
        patch[mode] = { preset: preset ? preset.preset : 'Custom', background: hex(c.background, base.background), foreground: hex(c.foreground, base.foreground), accent: hex(c.accent, base.accent) };
      }
    }
    if (typeof p.contributedTheme === 'string') {
      const all = [...useRegistry.getState().user.flatMap(u => u.manifest.contributes.themes ?? [])];
      const t = all.find(x => x.id === p.contributedTheme || x.label === p.contributedTheme);
      if (!t) throw new Error(`No plugin theme "${p.contributedTheme}".`);
      await applyContributedTheme(t);
    }
    if (Object.keys(patch).length) await d.setPrefs(patch as never);
    return { ok: true, applied: Object.keys(patch) };
  },
  setLayout: async (p) => {
    const d = useDesk.getState();
    if (typeof p.sidebarCollapsed === 'boolean') await d.setPrefs({ sidebar: { ...d.prefs.sidebar, collapsed: p.sidebarCollapsed } });
    if (typeof p.bottomPanel === 'boolean') d.setPanel({ open: p.bottomPanel });
    if (typeof p.sideDock === 'boolean') d.setDock({ open: p.sideDock });
    return { ok: true };
  },
  setPluginEnabled: async (p) => {
    const id = String(p.id ?? '');
    const d = useDesk.getState();
    const builtin = useRegistry.getState().builtins.find(b => b.manifest.id === id);
    if (builtin?.manifest.required) throw new Error(`"${id}" is required and cannot be switched off.`);
    const disabled = new Set(d.prefs.plugins.disabled);
    if (p.enabled) disabled.delete(id); else disabled.add(id);
    await d.setPrefs({ plugins: { ...d.prefs.plugins, disabled: [...disabled] } });
    return { ok: true };
  },
  /**
   * Who is who, for the browser's tab ownership (electron/browser-owners.ts):
   * which session is the browser copilot (it works on the page in front; every
   * other chat gets tabs of its own), the chat on screen (a tab handed over
   * goes to it), and the chats' titles and whether they are running.
   */
  browserSessions: () => {
    const s = useStore.getState();
    // The copilot's conversation, as both documents that show it share it (browser/copilot-session.ts).
    let copilot: string | null = null;
    try { copilot = localStorage.getItem('aico.browser.copilot.session'); } catch { /* storage unavailable */ }
    copilot ??= useCopilot.getState().sessionId;
    return {
      copilot,
      onScreen: s.sessionId ? { sessionId: s.sessionId, title: s.title ?? '' } : null,
      sessions: s.sessions.slice(0, 300).map(x => ({ id: x.id, title: x.title, running: x.id === s.sessionId ? Boolean(s.busy || x.running) : Boolean(x.running) })),
    };
  },
  /** The agent is about to use the browser: make sure the page is on screen so it lays out. */
  ensureBrowserVisible: async () => {
    // In its own window, the browser is always on screen — unless that window is minimised.
    if (browserElsewhere()) { await invoke('browser:window:ensureShown').catch(() => {}); return { visible: true, window: 'its own' }; }
    const d = useDesk.getState();
    if (d.route.view === 'browser' || d.dock.open) return { visible: true };
    d.setDock({ open: true });
    await new Promise(r => setTimeout(r, 450));
    return { visible: true, opened: 'side dock' };
  },
  newChat: (p) => { newChat({ prompt: p.prompt ? String(p.prompt) : undefined, send: Boolean(p.send), project: p.project ? String(p.project) : undefined }); return { ok: true }; },
  openFile: (p) => {
    useDesk.getState().navigate({ view: 'files', params: { root: String(p.root ?? useStore.getState().project ?? ''), open: String(p.path ?? ''), line: String(p.line ?? '') } });
    return { ok: true };
  },
};

export function installRendererBridge(): void {
  on<{ id: string; method: string; params?: Record<string, unknown> }>('command:call', async (msg) => {
    const fn = HANDLERS[msg.method];
    try {
      if (!fn) throw new Error(`Unknown IDE method ${msg.method}`);
      const result = await fn(msg.params ?? {});
      await invoke('command:reply', msg.id, { result: result ?? null });
    } catch (err) {
      await invoke('command:reply', msg.id, { error: (err as Error).message });
    }
  });
}
