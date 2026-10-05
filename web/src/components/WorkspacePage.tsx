/**
 * A workspace's own page.
 *
 * Everything about one folder gathered in one place: its editable properties
 * (reusing {@link ProjectSettings} rather than a second form), the stack and
 * commands already shown in System (reusing {@link ProjectCommands} as-is),
 * every chat that has ever happened in it, its commit history, and totals
 * across its whole life. Nothing here is fetched twice — the chat list is a
 * filter over the sessions the store already has; only the commit log and the
 * cross-session totals are new requests, because nothing else in the product
 * already answers them.
 *
 * @module components/WorkspacePage
 */

import React, { useEffect, useMemo, useState } from 'react';
import { useStore } from '../store';
import { api, type ProjectStats } from '../api';
import { basename } from '../grouping';
import { ChatList } from './ChatList';
import { GitPanel } from './GitPanel';
import { ProjectCommands } from './ProjectCommands';
import { ProjectSettings } from './ProjectSettings';
import { Icon } from './Icon';
import { CodeGraphView } from './codegraph/CodeGraphView';
import { MODES, type Mode } from './codegraph/model';
import { openFile } from '../file-open';

interface Props {
  projectPath: string;
  /** The session was opened; switch the destination back to the chat. */
  onOpenChat: () => void;
  /** Open the Code map at once, on this file and view (the brief's "Show in Code map"). `at` makes each request new. */
  openMap?: { file?: string; mode?: string; at: number };
}

export function WorkspacePage({ projectPath, onOpenChat, openMap }: Props): React.ReactElement {
  const projects = useStore(s => s.projects);
  const sessions = useStore(s => s.sessions);
  const openSession = useStore(s => s.openSession);
  const updateProject = useStore(s => s.updateProject);
  const newSessionIn = useStore(s => s.newSessionIn);
  const isTarget = useStore(s => s.project === projectPath && s.targetGroup === null);
  const selectTarget = useStore(s => s.selectTarget);
  const clearTarget = useStore(s => s.clearTarget);

  const project = projects.find(p => p.path === projectPath);
  const label = project?.name ?? basename(projectPath);

  const [settingsOpen, setSettingsOpen] = useState(false);
  const [mapOpen, setMapOpen] = useState(false);
  const [mapAt, setMapAt] = useState<{ file?: string; mode?: Mode } | null>(null);
  useEffect(() => {
    if (!openMap) return;
    const mode = MODES.find(m => m.id === openMap.mode)?.id;
    setMapAt({ ...(openMap.file ? { file: openMap.file } : {}), ...(mode ? { mode } : {}) });
    setMapOpen(true);
  }, [openMap?.at]); // eslint-disable-line react-hooks/exhaustive-deps
  const prefillComposer = useStore(s => s.prefillComposer);
  const [stats, setStats] = useState<ProjectStats | null>(null);

  // Keyed on the path, not the project object, so switching workspaces always
  // reloads rather than showing the last one's numbers under a new name.
  useEffect(() => {
    setStats(null);
    void api.projectStats(projectPath).then(setStats).catch(() => setStats(null));
  }, [projectPath]);

  const chats = useMemo(() => sessions.filter(s => s.project === projectPath), [sessions, projectPath]);
  const openChat = (id: string): void => { void openSession(id).then(onOpenChat); };
  const startHere = (): void => { newSessionIn(projectPath); onOpenChat(); };

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-4xl space-y-6 px-6 py-6">
        <header className="flex items-start gap-3">
          <Icon
            name={project?.pinned ? 'pin' : 'folder'}
            size={26}
            filled={Boolean(project?.color)}
            className={project?.color ? undefined : 'shrink-0 text-aico-muted'}
            {...(project?.color ? { style: { color: project.color } } : {})}
          />
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-[19px] font-semibold text-aico-primary">{label}</h1>
            <p className="mt-0.5 break-all font-mono text-[12px] text-aico-muted">{projectPath}</p>
            <p className="mt-2 text-[13px] leading-relaxed text-aico-secondary">
              {project?.description || <span className="text-aico-muted">No description set.</span>}
            </p>
            {project?.instructions && (
              <p className="mt-1 text-[11px] text-aico-muted">
                Custom instructions are set for this workspace.
              </p>
            )}
          </div>
          <div className="flex shrink-0 flex-wrap justify-end gap-2">
            <button
              onClick={startHere}
              className="flex items-center gap-1.5 rounded-full bg-aico-accent px-3 py-1.5 text-[12px] font-medium
                         text-aico-on-accent transition-colors hover:bg-aico-accent-hover"
            >
              <Icon name="plus" size={14} /> New session
            </button>
            <button
              onClick={() => (isTarget ? clearTarget() : selectTarget({ kind: 'project', path: projectPath }))}
              aria-pressed={isTarget}
              title={isTarget ? 'New chats go here. Click to send them to the default workspace instead.'
                : 'Send new chats here by default'}
              className={`rounded-full border px-3 py-1.5 text-[12px] transition-colors
                          ${isTarget ? 'border-aico-accent/50 bg-aico-accent-soft text-aico-accent' : 'border-aico-border text-aico-primary hover:bg-aico-hover'}`}
            >
              {isTarget ? 'Default for new chats ✓' : 'Use for new chats'}
            </button>
            <button
              onClick={() => setMapOpen(true)}
              title="The project's dependency graph: modules, impact, paths, cycles, hotspots"
              className="rounded-full border border-aico-border px-3 py-1.5 text-[12px] text-aico-primary
                         transition-colors hover:bg-aico-hover"
            >
              Code map
            </button>
            <button
              onClick={() => setSettingsOpen(true)}
              className="rounded-full border border-aico-border px-3 py-1.5 text-[12px] text-aico-primary
                         transition-colors hover:bg-aico-hover"
            >
              Edit properties
            </button>
          </div>
        </header>

        <StatsTiles stats={stats} />

        <Section title="Stack &amp; commands" icon="sliders">
          <ProjectCommands cwd={projectPath} />
        </Section>

        <Section title="Chats" icon="stack" count={chats.length}>
          <ChatList chats={chats} scope="workspace" onOpen={openChat} />
        </Section>

        <Section title="Git" icon="fork">
          <GitPanel path={projectPath} />
        </Section>
      </div>

      {mapOpen && (
        // The Code map (ADR 0028), full screen over the page; "Ask AICO" starts a chat here with the context ready.
        <div className="fixed inset-0 z-40 flex flex-col bg-aico-bg" role="dialog" aria-label="Code map">
          <div className="flex justify-end border-b border-aico-border px-3 py-1.5">
            <button onClick={() => { setMapOpen(false); setMapAt(null); }} className="flex items-center gap-1 rounded-md px-2 py-1 text-[12px] text-aico-secondary hover:bg-aico-hover">
              <Icon name="close" size={13} /> Close
            </button>
          </div>
          <CodeGraphView
            key={`${mapAt?.file ?? ''}|${mapAt?.mode ?? ''}`}
            projectPath={projectPath}
            projectName={label}
            {...(mapAt?.file ? { initialFile: mapAt.file } : {})}
            {...(mapAt?.mode ? { initialMode: mapAt.mode } : {})}
            host={{
              ask: prompt => { setMapOpen(false); newSessionIn(projectPath); prefillComposer(prompt); onOpenChat(); },
              // The person's editor when the engine can start one, else the viewer (web/file-open, ADR 0030).
              openFile: (rel, line) => openFile(rel, line, projectPath),
            }}
          />
        </div>
      )}

      {settingsOpen && project && (
        <ProjectSettings
          entry={project}
          kind="project"
          onSave={patch => void updateProject(projectPath, patch)}
          onClose={() => setSettingsOpen(false)}
        />
      )}
    </div>
  );
}

function Section(
  { title, icon, count, children }: { title: string; icon: 'sliders' | 'stack' | 'fork'; count?: number; children: React.ReactNode },
): React.ReactElement {
  return (
    <section>
      <h2 className="mb-2 flex items-center gap-1.5 text-[13px] font-semibold text-aico-primary">
        <Icon name={icon} size={15} className="text-aico-muted" />
        {title}
        {typeof count === 'number' && <span className="tabular-nums text-aico-muted">({count})</span>}
      </h2>
      {children}
    </section>
  );
}

function StatsTiles({ stats }: { stats: ProjectStats | null }): React.ReactElement {
  const tiles: Array<{ label: string; value: string }> = stats ? [
    { label: 'Chats', value: String(stats.sessions) },
    { label: 'Turns', value: String(stats.turns) },
    { label: 'Cost', value: `$${stats.costUsd.toFixed(2)}` },
    { label: 'Last active', value: stats.lastActive ? relativeDay(stats.lastActive) : '—' },
  ] : [
    { label: 'Chats', value: '…' }, { label: 'Turns', value: '…' }, { label: 'Cost', value: '…' }, { label: 'Last active', value: '…' },
  ];
  const max = stats ? Math.max(1, ...stats.byDay.map(d => d.count)) : 1;

  return (
    <section>
      <div className="grid grid-cols-4 gap-2">
        {tiles.map(t => (
          <div key={t.label} className="rounded-xl border border-aico-border-subtle bg-aico-surface px-3 py-2.5">
            <div className="text-[11px] text-aico-muted">{t.label}</div>
            <div className="mt-0.5 text-[17px] font-semibold tabular-nums text-aico-primary">{t.value}</div>
          </div>
        ))}
      </div>
      {stats && stats.byDay.length > 0 && (
        <div className="mt-2 flex h-10 items-end gap-[2px] rounded-lg border border-aico-border-subtle bg-aico-surface px-2 py-1.5" title="Turns per day, last 30 days">
          {stats.byDay.map(d => (
            <span
              key={d.date}
              title={`${d.date}: ${d.count} turn${d.count === 1 ? '' : 's'}`}
              className="min-w-[3px] flex-1 rounded-t bg-aico-accent/70"
              style={{ height: `${Math.max(8, (d.count / max) * 100)}%` }}
            />
          ))}
        </div>
      )}
    </section>
  );
}

/** "today", "yesterday", or a short date — matching how the sidebar reads recency. */
function relativeDay(ts: number): string {
  const days = Math.floor((Date.now() - ts) / (24 * 60 * 60 * 1000));
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days}d ago`;
  return new Date(ts).toLocaleDateString();
}
