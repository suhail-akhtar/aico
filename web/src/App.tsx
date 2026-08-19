/**
 * The shell.
 *
 * Layout is a two-column grid that collapses to a drawer under `md`. That is
 * not decoration: the point of moving off the desktop app is that a run you
 * started at a desk can be watched from a phone, and a fixed 1200px layout
 * would make that a zoom-and-pan exercise.
 *
 * @module App
 */

import React, { useEffect, useState } from 'react';
import { Sidebar, type View } from './components/Sidebar';
import { ChatPane } from './components/ChatPane';
import { Composer } from './components/Composer';

import { SystemPanel } from './components/SystemPanel';
import { Trajectory } from './components/Trajectory';
import { GoalBar } from './components/GoalBar';
import { ActivityLine } from './components/ActivityLine';
import { SidePanels } from './components/SidePanels';
import { ChangesPane } from './components/ChangesPane';
import { SessionMenu } from './components/SessionMenu';
import { SettingsModal } from './components/settings/SettingsModal';
import { ProjectPicker } from './components/ProjectPicker';
import { Icon } from './components/Icon';
import { applyTheme, type ThemeChoice } from './theme';
import { getToken, setToken, setTokenRejectedHandler } from './api';
import { useStore } from './store';

export function App(): React.ReactElement {
  const [view, setView] = useState<View>('chat');
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [hasToken, setHasToken] = useState(Boolean(getToken()));
  /** True when a token we had was refused — a restarted server, not a first visit. */
  const [wasRejected, setWasRejected] = useState(false);

  // A stale token otherwise 401s every request silently, leaving a page that
  // looks connected and does nothing.
  useEffect(() => {
    setTokenRejectedHandler(() => { setWasRejected(true); setHasToken(false); });
  }, []);

  const connect = useStore(s => s.connect);
  const disconnect = useStore(s => s.disconnect);
  const sessionId = useStore(s => s.sessionId);
  const refreshSessions = useStore(s => s.refreshSessions);
  const refreshProviders = useStore(s => s.refreshProviders);
  const refreshSettings = useStore(s => s.refreshSettings);
  const refreshProjects = useStore(s => s.refreshProjects);
  const theme = useStore(s => s.settings.theme as ThemeChoice | undefined);
  const title = useStore(s => s.title);
  const busy = useStore(s => s.busy);
  const status = useStore(s => s.status);

  useEffect(() => {
    if (!hasToken) return;
    connect(sessionId);
    void refreshSessions();
    void refreshProviders();
    void refreshSettings();
    void refreshProjects();
    return disconnect;
    // Deliberately once: `connect` is what changes the session, not this effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasToken]);

  // The page starts in the system's theme so a dark-mode machine never gets a
  // flash of white, and switches the moment the stored preference is known.
  useEffect(() => { applyTheme(theme); }, [theme]);

  if (!hasToken) {
    return (
      <TokenGate
        rejected={wasRejected}
        onToken={() => { setWasRejected(false); setHasToken(true); }}
      />
    );
  }

  return (
    <div className="flex h-full bg-aico-bg">
      <Sidebar
        view={view}
        onView={setView}
        open={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
        onSettings={() => setSettingsOpen(true)}
        onAddProject={() => setPickerOpen(true)}
      />

      <main className="flex min-w-0 flex-1 flex-col">
        <header className="flex shrink-0 items-center gap-3 border-b border-aico-border-subtle px-4 py-2.5">
          <button
            onClick={() => setSidebarOpen(true)}
            className="text-aico-secondary hover:text-aico-primary md:hidden"
            aria-label="Open sidebar"
          >
            <Icon name="sliders" size={19} />
          </button>

          <span className="min-w-0 max-w-[40%] truncate text-[14px] font-medium text-aico-primary">
            {view === 'system' ? 'System' : (title || 'New session')}
          </span>

          {/* Three readings of one session — what was said, what it did to the
              tree, and what happened in what order — so they are tabs on it
              rather than separate destinations in the sidebar. */}
          <nav className="flex items-center gap-1">
            <Tab active={view === 'chat'} onClick={() => setView('chat')}>Chat</Tab>
            <Tab active={view === 'changes'} onClick={() => setView('changes')}>Changes</Tab>
            <Tab active={view === 'trajectory'} onClick={() => setView('trajectory')}>Trajectory</Tab>
          </nav>

          <div className="flex-1" />

          <SessionMenu />

          <span
            className="flex items-center gap-1.5 text-[12px] text-aico-muted"
            title={status === 'live' ? 'Connected to the server' : status}
          >
            <span className={
              status !== 'live' ? 'text-aico-danger'
              : busy ? 'aico-thinking text-aico-success'
              : 'text-aico-success'
            }>
              ●
            </span>
            <span className="hidden sm:inline">{status === 'live' ? (busy ? 'running' : 'ready') : status}</span>
          </span>
        </header>

        {view === 'chat' && (
          <>
            <ChatPane />
            <SidePanels />
            <GoalBar />
            <ActivityLine />
            <Composer />
          </>
        )}
        {view === 'changes' && <ChangesPane />}
        {view === 'trajectory' && <Trajectory />}
        {view === 'system' && <SystemPanel />}
      </main>

      {settingsOpen && <SettingsModal onClose={() => setSettingsOpen(false)} />}
      {pickerOpen && <ProjectPicker onClose={() => setPickerOpen(false)} />}
    </div>
  );
}

function Tab(
  { active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode },
): React.ReactElement {
  return (
    <button
      onClick={onClick}
      className={`relative px-2 py-1 text-[13px] transition-colors ${
        active ? 'text-aico-primary' : 'text-aico-muted hover:text-aico-secondary'
      }`}
    >
      {children}
      {active && (
        <span className="absolute inset-x-2 -bottom-[11px] h-[2px] rounded-full bg-aico-accent" />
      )}
    </button>
  );
}

/**
 * Shown when the page has no usable token.
 *
 * Two different situations reach here and they need different words. A *first*
 * visit means the page was opened without the tokenised link — usually a
 * bookmark of the bare address. A *rejected* token means the server was
 * restarted and minted a new one, which is not the visitor's fault and is
 * fixed by looking at the terminal again rather than by hunting for something
 * they typed wrong.
 *
 * Neither is an error state, so neither is styled as one.
 */
function TokenGate(
  { onToken, rejected }: { onToken: () => void; rejected: boolean },
): React.ReactElement {
  const [value, setValue] = useState('');

  const submit = (event: React.FormEvent): void => {
    event.preventDefault();
    const token = value.trim();
    if (!token) return;
    setToken(token);
    onToken();
  };

  return (
    <div className="flex h-full items-center justify-center bg-aico-bg px-6">
      <form onSubmit={submit} className="w-full max-w-md">
        <div className="mb-6">
          <h1 className="text-[22px] font-semibold tracking-tight text-aico-primary">
            {rejected ? 'AICO was restarted' : 'Connect to AICO'}
          </h1>
          <p className="mt-2 text-[15px] leading-relaxed text-aico-secondary">
            {rejected
              ? 'The server restarted and issued a new access token, so the old one no longer works.'
              : 'This page is authorised by the link AICO printed when it started.'}
          </p>
          <p className="mt-3 text-[14px] leading-relaxed text-aico-secondary">
            Look at the terminal running AICO and open the link it shows:
          </p>
          <pre className="mt-2 overflow-x-auto rounded-lg bg-aico-code px-3 py-2 font-mono text-[12px] text-aico-primary">
            http://127.0.0.1:7317/?token=…
          </pre>
          <p className="mt-3 text-[13px] text-aico-muted">
            Lost it? Stop AICO and run{' '}
            <code className="rounded bg-aico-code px-1 py-0.5 font-mono">aico serve</code>{' '}
            again — it prints a fresh link and opens it for you.
          </p>
        </div>

        <label className="block text-[13px] text-aico-secondary" htmlFor="aico-token">
          Or paste the token
        </label>
        <input
          id="aico-token"
          type="password"
          value={value}
          onChange={e => setValue(e.target.value)}
          placeholder="Access token"
          autoFocus
          className="mt-1 w-full rounded-lg border border-aico-border bg-aico-bg px-3.5 py-2.5
                     font-mono text-[14px] text-aico-primary placeholder:text-aico-muted
                     focus:border-aico-accent/50 focus:outline-none"
        />
        <button
          type="submit"
          disabled={!value.trim()}
          className="mt-3 w-full rounded-lg bg-aico-accent px-4 py-2.5 text-[14px] font-medium
                     text-aico-on-accent transition-colors hover:bg-aico-accent-hover disabled:opacity-30"
        >
          Connect
        </button>

        <p className="mt-6 text-[12px] leading-relaxed text-aico-muted">
          The token exists because this server can run commands and edit files on
          your machine. It listens only on 127.0.0.1, and the token means that
          reaching the port is not the same as being able to drive it.
        </p>
      </form>
    </div>
  );
}
