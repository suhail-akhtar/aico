/**
 * The features that ship with AICO Desktop — each one a plugin.
 *
 * Nothing in the shell names a feature. Each entry here declares what it adds
 * (sidebar entries, pages, commands, settings sections, quick prompts) through
 * the same contract a user plugin uses, which is what makes every one of them
 * switchable from the Plugins page and describable to the agent.
 *
 * @module desktop/renderer/plugins/builtins
 */

import { lazy } from 'react';
import { useStore } from '@web/store';
import type { PluginManifest } from '@desk/plugin-types';
import { useRegistry, type BuiltinPlugin } from './registry';
import { useDesk, go, toast } from '@/state/desk';
import { desktop } from '@/desktop';
import { newChat } from '@/chat/actions';
import { ChatView } from '@/chat/ChatView';
import { GeneralSection, ApplicationSection, AppearanceSection, ShortcutsSection, BrowserSection, AboutSection } from '@/settings/sections/AppSections';
import { ModelsSection, SkillsSection, McpSection, AgentsSection, enginePaneSection } from '@/settings/sections/AgentSections';

const lazyPage = <T extends string>(load: () => Promise<Record<T, React.ComponentType<{ params?: Record<string, string> }>>>, name: T) =>
  lazy(() => load().then(m => ({ default: m[name] })));

const PluginsPage = lazyPage(() => import('@/pages/PluginsPage'), 'PluginsPage');
const ChatsPage = lazyPage(() => import('@/pages/ChatsPage'), 'ChatsPage');
const LibraryPage = lazyPage(() => import('@/pages/LibraryPage'), 'LibraryPage');
const ScheduledPage = lazyPage(() => import('@/pages/ScheduledPage'), 'ScheduledPage');
const ProjectsPage = lazyPage(() => import('@/pages/ProjectsPage'), 'ProjectsPage');
const ProjectPage = lazyPage(() => import('@/pages/ProjectPage'), 'ProjectPage');
const GroupPage = lazyPage(() => import('@/pages/GroupPage'), 'GroupPage');
const ActivityPage = lazyPage(() => import('@/pages/ActivityPage'), 'ActivityPage');
const AppsPage = lazyPage(() => import('@/pages/AppsPage'), 'AppsPage');
const ChangesPage = lazyPage(() => import('@/pages/ChangesPage'), 'ChangesPage');
const TrajectoryPage = lazyPage(() => import('@/pages/ChangesPage'), 'TrajectoryPage');
const BrowserView = lazyPage(() => import('@/ide/BrowserPane'), 'BrowserView');
const GitPage = lazyPage(() => import('@/ide/GitPage'), 'GitPage');
const GitHubPage = lazyPage(() => import('@/ide/GitHubPage'), 'GitHubPage');
const FilesPage = lazyPage(() => import('@/ide/FilesPage'), 'FilesPage');

function manifest(m: Omit<PluginManifest, 'version' | 'contributes'> & { contributes?: PluginManifest['contributes'] }): PluginManifest {
  return { version: __DESKTOP_VERSION__, contributes: {}, ...m } as PluginManifest;
}

declare const __DESKTOP_VERSION__: string;

export const BUILTINS: BuiltinPlugin[] = [
  {
    manifest: manifest({ id: 'aico.core', name: 'Chat', icon: 'chat', required: true, category: 'Core', description: 'Conversations with the agent: the home screen, the transcript and the composer.' }),
    views: [{ id: 'chat', title: 'Chat', icon: 'chat', component: ChatView }],
    commands: [
      { id: 'chat.new', title: 'New chat', category: 'Chat', icon: 'new-chat', keybinding: 'Ctrl+N', run: () => newChat() },
      { id: 'chat.focus', title: 'Focus the composer', category: 'Chat', icon: 'edit', run: () => { window.dispatchEvent(new Event('desk:focus-composer')); } },
      { id: 'chat.stop', title: 'Stop the running turn', category: 'Chat', icon: 'stop', run: () => useStore.getState().cancel() },
      { id: 'chat.planMode', title: 'Plan first (toggle)', category: 'Chat', icon: 'list', run: async () => { const { getSendOptions, setSendOptions } = await import('@/chat/actions'); setSendOptions({ planMode: !getSendOptions().planMode }); } },
      { id: 'palette.open', title: 'Command palette', category: 'View', icon: 'command', run: () => useDesk.getState().setPalette(true) },
      { id: 'search.open', title: 'Search chats', category: 'View', icon: 'search', run: () => useDesk.getState().setSearch(true) },
      { id: 'settings.open', title: 'Settings', category: 'View', icon: 'settings', run: () => useDesk.getState().openSettings('general') },
      { id: 'sidebar.toggle', title: 'Toggle sidebar', category: 'View', icon: 'sidebar', run: () => { const s = useDesk.getState(); void s.setPrefs({ sidebar: { ...s.prefs.sidebar, collapsed: !s.prefs.sidebar.collapsed } }); } },
      { id: 'panel.toggle', title: 'Toggle bottom panel', category: 'View', icon: 'panel-bottom', run: () => { const s = useDesk.getState(); s.setPanel({ open: !s.panel.open }); } },
      { id: 'dock.toggle', title: 'Toggle side browser', category: 'View', icon: 'panel-right', run: () => { const s = useDesk.getState(); s.setDock({ open: !s.dock.open }); } },
      { id: 'theme.toggle', title: 'Toggle light / dark theme', category: 'View', icon: 'moon', run: () => { const s = useDesk.getState(); const next = s.mode === 'dark' ? 'light' : 'dark'; void s.setPrefs({ theme: next }); void desktop.win.setThemeSource(next); } },
      { id: 'zoom.in', title: 'Zoom in', category: 'View', icon: 'plus', run: () => void desktop.win.zoom(0.1) },
      { id: 'zoom.out', title: 'Zoom out', category: 'View', icon: 'minus', run: () => void desktop.win.zoom(-0.1) },
      { id: 'zoom.reset', title: 'Reset zoom', category: 'View', icon: 'refresh', run: () => void desktop.win.zoom(0) },
      { id: 'engine.restart', title: 'Restart the engine', category: 'Application', icon: 'refresh', run: () => { void desktop.engine.restart(); toast.info('Restarting the engine…'); } },
      { id: 'engine.web', title: 'Open in the web client', category: 'Application', icon: 'globe', run: () => void desktop.engine.webUrl().then(u => u && desktop.shell.openExternal(u)) },
      { id: 'app.devtools', title: 'Toggle developer tools', category: 'Application', icon: 'code', run: () => void desktop.win.devtools() },
      { id: 'app.reload', title: 'Reload window', category: 'Application', icon: 'refresh', run: () => location.reload() },
      { id: 'project.open', title: 'Open a folder as a project…', category: 'Projects', icon: 'folder-plus', run: async () => { const d = await desktop.dialog.pickFolder('Open a project folder'); if (d) { await useStore.getState().addProject(d); go('project', { path: d }); } } },
    ],
    settings: [
      { id: 'general', title: 'General', icon: 'settings', group: 'app', order: 1, component: GeneralSection },
      { id: 'application', title: 'Application', icon: 'monitor', group: 'app', order: 2, component: ApplicationSection },
      { id: 'appearance', title: 'Appearance', icon: 'palette', group: 'app', order: 3, component: AppearanceSection },
      { id: 'shortcuts', title: 'Shortcuts', icon: 'keyboard', group: 'app', order: 90, component: ShortcutsSection },
      { id: 'about', title: 'About', icon: 'info', group: 'app', order: 99, component: AboutSection },
      { id: 'models', title: 'Models', icon: 'sparkles', group: 'agent', order: 10, component: ModelsSection },
      { id: 'personalization', title: 'Personalization', icon: 'brain', group: 'agent', order: 11, component: enginePaneSection('memory') },
      { id: 'permissions', title: 'Permissions', icon: 'shield', group: 'agent', order: 12, component: enginePaneSection('agent') },
      { id: 'context', title: 'Context & long runs', icon: 'layers', group: 'agent', order: 13, component: enginePaneSection('context') },
      { id: 'limits', title: 'Limits & spend', icon: 'activity', group: 'agent', order: 14, component: enginePaneSection('limits') },
      { id: 'agents', title: 'Agents', icon: 'user', group: 'agent', order: 15, component: AgentsSection },
      { id: 'skills', title: 'Skills', icon: 'book', group: 'integrations', order: 20, component: SkillsSection },
      { id: 'mcp', title: 'MCP servers', icon: 'plug', group: 'integrations', order: 21, component: McpSection },
    ],
  },
  {
    manifest: manifest({ id: 'aico.chats', name: 'Chat history', icon: 'history', category: 'Core', description: 'Every chat, searchable, with bulk archive and delete.', contributes: {
      navItems: [{ id: 'chats', title: 'Search', icon: 'search', view: 'chats', order: 10 }],
    } }),
    views: [{ id: 'chats', title: 'Chats', icon: 'history', component: ChatsPage }],
  },
  {
    manifest: manifest({ id: 'aico.library', name: 'Library', icon: 'library', category: 'Core', description: 'Everything the agent made — files, images, exports and screenshots — in one place.', contributes: {
      navItems: [{ id: 'library', title: 'Library', icon: 'library', view: 'library', order: 20 }],
    } }),
    views: [{ id: 'library', title: 'Library', icon: 'library', component: LibraryPage }],
  },
  {
    manifest: manifest({ id: 'aico.scheduled', name: 'Scheduled', icon: 'clock', category: 'Automation', description: 'Recurring agent jobs: create, pause, resume and review them.', contributes: {
      navItems: [{ id: 'scheduled', title: 'Scheduled', icon: 'clock', view: 'scheduled', order: 30 }],
    } }),
    views: [{ id: 'scheduled', title: 'Scheduled', icon: 'clock', component: ScheduledPage }],
  },
  {
    manifest: manifest({ id: 'aico.plugins', name: 'Plugins', icon: 'puzzle', required: true, category: 'Core', description: 'Switch features on and off; create and manage your own plugins.', contributes: {
      navItems: [{ id: 'plugins', title: 'Plugins', icon: 'puzzle', view: 'plugins', order: 40 }],
    } }),
    views: [{ id: 'plugins', title: 'Plugins', icon: 'puzzle', component: PluginsPage }],
    commands: [{ id: 'plugins.open', title: 'Manage plugins', category: 'Plugins', icon: 'puzzle', run: () => go('plugins') }],
  },
  {
    manifest: manifest({ id: 'aico.projects', name: 'Projects', icon: 'folder', category: 'Core', description: 'Project folders and groups, each with its own page: chats, files, git and settings.', contributes: {
      navItems: [{ id: 'projects', title: 'Projects', icon: 'folder', view: 'projects', order: 50 }],
    } }),
    views: [
      { id: 'projects', title: 'Projects', icon: 'folder', component: ProjectsPage },
      { id: 'project', title: 'Project', icon: 'folder', component: ProjectPage },
      { id: 'group', title: 'Group', icon: 'stack', component: GroupPage },
      { id: 'changes', title: 'Changes', icon: 'file-text', component: ChangesPage },
      { id: 'trajectory', title: 'Trajectory', icon: 'activity', component: TrajectoryPage },
    ],
  },
  {
    manifest: manifest({ id: 'aico.files', name: 'Files & editor', icon: 'code', category: 'IDE', description: 'A file explorer and a full code editor (Monaco) with search, quick open and live reload.', contributes: {
      navItems: [{ id: 'files', title: 'Files', icon: 'code', view: 'files', order: 60 }],
    } }),
    views: [{ id: 'files', title: 'Files', icon: 'code', component: FilesPage }],
  },
  {
    manifest: manifest({ id: 'aico.git', name: 'Source control', icon: 'git', category: 'IDE', description: 'Status, staging, commits, diffs, branches, history, push and pull — for any project.', contributes: {
      navItems: [{ id: 'git', title: 'Source control', icon: 'git', view: 'git', order: 61, placement: 'more' }],
    } }),
    views: [{ id: 'git', title: 'Source control', icon: 'git', component: GitPage }],
  },
  {
    manifest: manifest({ id: 'aico.github', name: 'GitHub', icon: 'github', category: 'Integrations', description: 'Pull requests, issues, checks and repositories through the GitHub CLI.', contributes: {
      navItems: [{ id: 'github', title: 'GitHub', icon: 'github', view: 'github', order: 62, placement: 'more' }],
    } }),
    views: [{ id: 'github', title: 'GitHub', icon: 'github', component: GitHubPage }],
  },
  {
    manifest: manifest({ id: 'aico.browser', name: 'Browser', icon: 'globe', category: 'IDE', description: 'A built-in browser you and the agent share — for testing web apps and automating the web.', contributes: {
      navItems: [{ id: 'browser', title: 'Browser', icon: 'globe', view: 'browser', order: 63 }],
    } }),
    views: [{ id: 'browser', title: 'Browser', icon: 'globe', component: BrowserView }],
    commands: [{ id: 'browser.open', title: 'Open the browser', category: 'Browser', icon: 'globe', run: () => go('browser') }],
    settings: [{ id: 'browser', title: 'Browser', icon: 'globe', group: 'integrations', order: 22, component: BrowserSection }],
  },
  {
    manifest: manifest({ id: 'aico.terminal', name: 'Terminal', icon: 'terminal', category: 'IDE', description: 'Real terminals (PowerShell, bash) in the bottom panel.' }),
    commands: [
      { id: 'terminal.new', title: 'New terminal', category: 'Terminal', icon: 'terminal', keybinding: 'Ctrl+Shift+`', run: () => { useDesk.getState().setPanel({ open: true, tab: 'terminal' }); window.dispatchEvent(new CustomEvent('desk:terminal', { detail: {} })); } },
    ],
  },
  {
    manifest: manifest({ id: 'aico.apps', name: 'Apps', icon: 'apps', category: 'Build', description: 'Apps the agent builds and runs for you — start, stop, open and deploy them.', contributes: {
      navItems: [{ id: 'apps', title: 'Apps', icon: 'apps', view: 'apps', order: 64, placement: 'more' }],
    } }),
    views: [{ id: 'apps', title: 'Apps', icon: 'apps', component: AppsPage }],
  },
  {
    manifest: manifest({ id: 'aico.activity', name: 'Activity monitor', icon: 'activity', category: 'Core', description: 'Everything running in the background: chats, sub-agents, scheduled jobs, processes, app servers.', contributes: {
      navItems: [{ id: 'activity', title: 'Activity', icon: 'activity', view: 'activity', order: 65, placement: 'more' }],
    } }),
    views: [{ id: 'activity', title: 'Activity', icon: 'activity', component: ActivityPage }],
  },
  {
    manifest: manifest({ id: 'aico.statusbar', name: 'Status bar', icon: 'list', category: 'Core', description: 'The line at the foot of the window: engine health and background activity.' }),
  },
  {
    manifest: manifest({ id: 'aico.starters', name: 'Starter prompts', icon: 'sparkles', category: 'Productivity', description: 'Suggestions under the composer on the home screen.', contributes: {
      prompts: [
        { id: 'explain', title: 'Explain this project', prompt: 'Explain this project: what it does, how it is organised, and where to start reading.', icon: 'map', home: true },
        { id: 'fix', title: 'Find and fix a bug', prompt: 'Run the tests, find what is failing or fragile, and fix it.', icon: 'bug', home: true },
        { id: 'build', title: 'Build an app', prompt: 'Build me an app that ', icon: 'rocket', home: true },
        { id: 'qa', title: 'Test a website', prompt: 'Open http://localhost:3000 in the built-in browser and test the main user flows end to end. Report what breaks with screenshots.', icon: 'globe', home: true },
        { id: 'chart', title: 'Visualise data', prompt: 'Analyse this and show it as an interactive dashboard with charts and a table: ', icon: 'chart', home: true },
        { id: 'math', title: 'Solve and plot', prompt: 'Solve step by step, show the formulas, and plot the result: ', icon: 'function', home: true },
      ],
    } }),
  },
];

export function registerBuiltins(): void {
  const reg = useRegistry.getState();
  for (const b of BUILTINS) reg.registerBuiltin(b);
}
