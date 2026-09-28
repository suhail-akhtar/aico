/**
 * What a declarative plugin command does when run.
 *
 * Every action is something the user could do by hand; a terminal command is
 * always shown and confirmed before it runs, whoever asked for it.
 *
 * @module desktop/renderer/plugins/run-action
 */

import type { CommandAction } from '@desk/plugin-types';
import { useDesk, go, toast } from '@/state/desk';
import { desktop } from '@/desktop';
import { newChat, sendPrompt } from '@/chat/actions';
import { commandsNow, runCommand, setActionRunner } from './registry';
import { useRegistry } from './registry';

export function installActionRunner(): void {
  setActionRunner(async (action: CommandAction, pluginId: string) => {
    switch (action.type) {
      case 'prompt':
        if (action.newChat !== false) newChat({ prompt: action.prompt, send: action.send !== false });
        else if (action.send === false) (await import('@web/store')).useStore.getState().prefillComposer(action.prompt);
        else await sendPrompt(action.prompt);
        return;
      case 'open-view':
        go(action.view.includes(':') || !pluginId || isBuiltinView(action.view) ? action.view : `${pluginId}:${action.view}`);
        return;
      case 'open-url':
        await desktop.shell.openExternal(action.url);
        return;
      case 'browse':
        go('browser', { url: action.url });
        return;
      case 'terminal': {
        const ok = await desktop.dialog.confirm({
          title: 'Run a command',
          message: `Run this in the terminal?`,
          detail: `${action.command}${action.cwd ? `\n\nin ${action.cwd}` : ''}\n\nRequested by the plugin “${pluginId}”.`,
          ok: 'Run',
        });
        if (!ok) return;
        useDesk.getState().setPanel({ open: true, tab: 'terminal' });
        window.dispatchEvent(new CustomEvent('desk:terminal', { detail: { cwd: action.cwd, run: action.command } }));
        return;
      }
      case 'command':
        if (!runCommand(action.command, action.args)) toast.warning('No such command', action.command);
        return;
      case 'theme': {
        const all = [...useRegistry.getState().builtins.flatMap(b => b.manifest.contributes.themes ?? []), ...useRegistry.getState().user.flatMap(u => u.manifest.contributes.themes ?? [])];
        const t = all.find(x => x.id === action.theme || x.label === action.theme);
        if (!t) { toast.warning('No such theme', action.theme); return; }
        await applyContributedTheme(t);
        return;
      }
    }
  });
}

function isBuiltinView(id: string): boolean {
  return useRegistry.getState().builtins.some(b => b.views?.some(v => v.id === id));
}

export async function applyContributedTheme(t: { label: string; mode: 'light' | 'dark'; background: string; foreground: string; accent: string }): Promise<void> {
  const st = useDesk.getState();
  const colors = { preset: t.label, background: t.background, foreground: t.foreground, accent: t.accent };
  await st.setPrefs(t.mode === 'dark' ? { dark: colors, theme: 'dark' } : { light: colors, theme: 'light' });
}

export { commandsNow };
