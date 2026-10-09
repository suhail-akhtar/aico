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

import React, { lazy } from 'react';
import { useStore } from '@web/store';
import type { PluginManifest } from '@desk/plugin-types';
import { useRegistry, type BuiltinPlugin } from './registry';
import { useDesk, go, toast } from '@/state/desk';
import { desktop } from '@/desktop';
import { newChat } from '@/chat/actions';
import { newTab, showInternal } from '@/browser/store';
import { toggleCopilot, useCopilotUi } from '@/browser/copilot-ui';
import { browserElsewhere, popInBrowser, popOutBrowser, showBrowser } from '@/browser/host';
import { ChatView } from '@/chat/ChatView';
import { TasksPage, openTasksPage, toggleTasks } from '@/tasks/TasksHost';
import { GeneralSection, ApplicationSection, AppearanceSection, ShortcutsSection, BrowserSection, AboutSection } from '@/settings/sections/AppSections';
import { CredentialManager } from '@/settings/CredentialManager';
import { ToolsPane } from '@web/components/settings/ToolsPane';
import { LearnedPane } from '@web/components/settings/LearnedPane';

import { ModelsSection, SkillsSection, McpSection, AgentsSection, enginePaneSection } from '@/settings/sections/AgentSections';

// Settings → Credentials & passwords: the whole vault (the browser's Passwords page is the same manager, filtered).
const CredentialsSection = (): React.ReactElement => <CredentialManager />;
// Settings → Custom tools: the engine's shared panel (web ToolsPane) — list, read, enable, test.
const ToolsSection = (): React.ReactElement => <ToolsPane />;
// Settings → What AICO learned: the engine's shared page (web LearnedPane) plus its two switches (ADR 0016).
const LearnedPaneSettings = enginePaneSection('learned');
const LearnedSection = (): React.ReactElement => <><LearnedPane /><div className="mt-6"><LearnedPaneSettings /></div></>;

const lazyPage = <T extends string>(load: () => Promise<Record<T, React.ComponentType<{ params?: Record<string, string> }>>>, name: T) =>
  lazy(() => load().then(m => ({ default: m[name] })));

const PluginsPage = lazyPage(() => import('@/pages/PluginsPage'), 'PluginsPage');
const ChatsPage = lazyPage(() => import('@/pages/ChatsPage'), 'ChatsPage');
const LibraryPage = lazyPage(() => import('@/pages/LibraryPage'), 'LibraryPage');
const ScheduledPage = lazyPage(() => import('@/pages/ScheduledPage'), 'ScheduledPage');
const InboxPage = lazyPage(() => import('@/pages/InboxPage'), 'InboxPage');
const AboutYouPage = lazyPage(() => import('@/pages/AboutYouPage'), 'AboutYouPage');
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
const CodeMapPage = lazyPage(() => import('@/pages/CodeMapPage'), 'CodeMapPage');
const DeliveryPage = lazyPage(() => import('@/pages/DeliveryPage'), 'DeliveryPage');

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
      { id: 'credentials.open', title: 'Credentials & passwords', category: 'Application', icon: 'key', run: () => useDesk.getState().openSettings('credentials') },
      { id: 'engine.web', title: 'Open in the web client', category: 'Application', icon: 'globe', run: () => void desktop.engine.webUrl().then(u => u && desktop.shell.openExternal(u)) },
      { id: 'app.devtools', title: 'Toggle developer tools', category: 'Application', icon: 'code', run: () => void desktop.win.devtools() },
      { id: 'app.reload', title: 'Reload window', category: 'Application', icon: 'refresh', run: () => location.reload() },
      { id: 'project.open', title: 'Open a folder as a project…', category: 'Projects', icon: 'folder-plus', run: async () => { const d = await desktop.dialog.pickFolder('Open a project folder'); if (d) { await useStore.getState().addProject(d); go('project', { path: d }); } } },
    ],
    settings: [
      { id: 'general', title: 'General', icon: 'settings', group: 'app', order: 1, component: GeneralSection },
      { id: 'application', title: 'Application', icon: 'monitor', group: 'app', order: 2, component: ApplicationSection },
      { id: 'appearance', title: 'Appearance', icon: 'palette', group: 'app', order: 3, component: AppearanceSection },
      // One manager for the vault: agent-made credentials, your keys and tokens, and the browser's saved logins.
      { id: 'credentials', title: 'Credentials & passwords', icon: 'key', group: 'app', order: 4, component: CredentialsSection },
      { id: 'shortcuts', title: 'Shortcuts', icon: 'keyboard', group: 'app', order: 90, component: ShortcutsSection },
      { id: 'about', title: 'About', icon: 'info', group: 'app', order: 99, component: AboutSection },
      { id: 'models', title: 'Models', icon: 'sparkles', group: 'agent', order: 10, component: ModelsSection },
      { id: 'personalization', title: 'Personalization', icon: 'brain', group: 'agent', order: 11, component: enginePaneSection('memory') },
      { id: 'learned', title: 'What AICO learned', icon: 'sparkles', group: 'agent', order: 11.5, component: LearnedSection },
      { id: 'permissions', title: 'Permissions', icon: 'shield', group: 'agent', order: 12, component: enginePaneSection('agent') },
      { id: 'context', title: 'Context & long runs', icon: 'layers', group: 'agent', order: 13, component: enginePaneSection('context') },
      { id: 'limits', title: 'Limits & spend', icon: 'activity', group: 'agent', order: 14, component: enginePaneSection('limits') },
      { id: 'agents', title: 'Agents', icon: 'user', group: 'agent', order: 15, component: AgentsSection },
      { id: 'skills', title: 'Skills', icon: 'book', group: 'integrations', order: 20, component: SkillsSection },
      { id: 'mcp', title: 'MCP servers', icon: 'plug', group: 'integrations', order: 21, component: McpSection },
      { id: 'tools', title: 'Custom tools', icon: 'wrench', group: 'integrations', order: 22, component: ToolsSection },
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
    manifest: manifest({ id: 'aico.inbox', name: 'Waiting for you', icon: 'bell', required: true, category: 'Automation', description: 'Steps unattended runs parked for your approval: the exact call and its preview, approve once or deny.', contributes: {
      navItems: [{ id: 'inbox', title: 'Waiting for you', icon: 'bell', view: 'inbox', order: 31 }],
    } }),
    views: [{ id: 'inbox', title: 'Waiting for you', icon: 'inbox', component: InboxPage }],
    commands: [{ id: 'inbox.open', title: 'Waiting for you (approve-later inbox)', category: 'Automation', icon: 'inbox', run: () => go('inbox') }],
  },
  {
    manifest: manifest({ id: 'aico.about', name: 'About you', icon: 'user', category: 'Core', description: 'What AICO has learned about you from your work and browsing, with the evidence — confirm, edit, hide or forget each fact.', contributes: {
      navItems: [{ id: 'about', title: 'About you', icon: 'user', view: 'about', order: 32, placement: 'more' }],
    } }),
    views: [{ id: 'about', title: 'About you', icon: 'user', component: AboutYouPage }],
    commands: [{ id: 'about.open', title: 'About you (what AICO has learned about you)', category: 'Core', icon: 'user', run: () => go('about') }],
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
      // The project's dependency graph (ADR 0028): params path, file, mode.
      { id: 'codemap', title: 'Code map', icon: 'map', component: CodeMapPage },
    ],
    commands: [
      { id: 'codemap.open', title: 'Code map: open for the current project', category: 'Projects', icon: 'map', keybinding: 'Ctrl+Shift+M', run: () => go('codemap', { path: useStore.getState().project ?? '' }) },
      { id: 'codemap.changes', title: 'Code map: what my uncommitted change affects', category: 'Projects', icon: 'map', run: () => go('codemap', { path: useStore.getState().project ?? '', mode: 'changes' }) },
    ],
  },
  {
    manifest: manifest({ id: 'aico.delivery', name: 'Delivery', icon: 'rocket', category: 'Projects', description: 'A work board: agents take tasks in parallel, you review the diff and evidence and land their work.', contributes: {
      navItems: [{ id: 'delivery', title: 'Delivery', icon: 'rocket', view: 'delivery', order: 51 }],
    } }),
    views: [{ id: 'delivery', title: 'Delivery', icon: 'rocket', component: DeliveryPage }],
    commands: [
      { id: 'delivery.open', title: 'Delivery: open the board for the current project', category: 'Projects', icon: 'rocket', run: () => go('delivery', { path: useStore.getState().project ?? '' }) },
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
    commands: [
      { id: 'browser.open', title: 'Open the browser', category: 'Browser', icon: 'globe', run: () => showBrowser() },
      { id: 'browser.copilot', title: 'Ask AICO about this page', category: 'Browser', icon: 'sparkles', keybinding: 'Ctrl+Shift+A', run: () => {
        if (browserElsewhere()) { toggleCopilot(true); return; }
        if (useDesk.getState().route.view !== 'browser') { go('browser'); toggleCopilot(true); return; }
        const u = useCopilotUi.getState(); toggleCopilot(!(u.open && !u.minimized));
      } },
      { id: 'browser.popOut', title: 'Open the browser in its own window', category: 'Browser', icon: 'pop-out', run: () => { if (browserElsewhere()) showBrowser(); else popOutBrowser(); } },
      { id: 'browser.popIn', title: 'Move the browser back into this window', category: 'Browser', icon: 'pop-in', run: () => popInBrowser() },
      // Wherever the browser is: this window's Browser page, or its own window (brought forward; its own pages are opened there).
      { id: 'browser.newTab', title: 'New browser tab', category: 'Browser', icon: 'plus', run: () => { showBrowser(); newTab(); } },
      { id: 'browser.history', title: 'Browser history', category: 'Browser', icon: 'history', run: () => { showBrowser(); if (!browserElsewhere()) showInternal('history'); } },
      { id: 'browser.bookmarks', title: 'Browser bookmarks', category: 'Browser', icon: 'star', run: () => { showBrowser(); if (!browserElsewhere()) showInternal('bookmarks'); } },
      { id: 'browser.insights', title: 'Browsing insights', category: 'Browser', icon: 'chart', run: () => { showBrowser(); if (!browserElsewhere()) showInternal('insights'); } },
      { id: 'browser.privacy', title: 'Browser privacy & security', category: 'Browser', icon: 'shield-check', run: () => { showBrowser(); if (!browserElsewhere()) showInternal('privacy'); } },
    ],
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
    // The Tasks panel (tasks/TasksHost): a side panel from the status bar, the chip under a chat, the palette or Ctrl+Shift+Y; this is its full page.
    manifest: manifest({ id: 'aico.tasks', name: 'Tasks', icon: 'check', category: 'Core', description: 'Running and delegated work beside your chats — sub-agents, background agents, long jobs, scheduled runs, commands, terminals, browser procedures — and what is waiting for you.' }),
    views: [{ id: 'tasks', title: 'Tasks', icon: 'check-circle', component: TasksPage }],
    commands: [
      { id: 'tasks.toggle', title: 'Tasks: show or hide the panel', category: 'View', icon: 'check-circle', keybinding: 'Ctrl+Shift+Y', run: () => toggleTasks(undefined, true) },
      { id: 'tasks.page', title: 'Tasks: open as a page', category: 'View', icon: 'expand', run: () => openTasksPage() },
    ],
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
