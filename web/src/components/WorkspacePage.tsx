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
import { api, type CommitInfo, type GitLogPage, type ProjectStats } from '../api';
import { basename, matchesSession, searchTerms, type MatchContext } from '../grouping';
import { ProjectCommands } from './ProjectCommands';
import { ProjectSettings } from './ProjectSettings';
import { Icon } from './Icon';

interface Props {
  projectPath: string;
  /** The session was opened; switch the destination back to the chat. */
  onOpenChat: () => void;
}

export function WorkspacePage({ projectPath, onOpenChat }: Props): React.ReactElement {
  const projects = useStore(s => s.projects);
  const groups = useStore(s => s.groups);
  const sessions = useStore(s => s.sessions);
  const openSession = useStore(s => s.openSession);
  const updateProject = useStore(s => s.updateProject);
  const showArchived = useStore(s => s.showArchived);
  const toggleArchived = useStore(s => s.toggleArchived);

  const project = projects.find(p => p.path === projectPath);
  const label = project?.name ?? basename(projectPath);

  const [filter, setFilter] = useState('');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [stats, setStats] = useState<ProjectStats | null>(null);
  const [log, setLog] = useState<GitLogPage | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  // Both fetches are keyed on the path, not the project object, so switching
  // workspaces (or the same workspace losing/gaining a `Project` entry) always
  // reloads rather than showing the last one's numbers under a new name.
  useEffect(() => {
    setStats(null);
    void api.projectStats(projectPath).then(setStats).catch(() => setStats(null));
  }, [projectPath]);

  useEffect(() => {
    setLog(null);
    void api.gitLog(projectPath, { limit: 20 }).then(setLog).catch(() => setLog(null));
  }, [projectPath]);

  const loadMoreCommits = async (): Promise<void> => {
    const last = log?.commits[log.commits.length - 1];
    if (!log?.hasMore || !last || loadingMore) return;
    setLoadingMore(true);
    try {
      const next = await api.gitLog(projectPath, { limit: 20, before: last.hash });
      setLog(prev => (prev ? { ...next, commits: [...prev.commits, ...next.commits] } : next));
    } finally {
      setLoadingMore(false);
    }
  };

  const ctx: MatchContext = useMemo(() => ({
    projects: new Map(projects.map(p => [p.path, p])),
    groups: new Map(groups.map(g => [g.id, g])),
  }), [projects, groups]);

  const chats = useMemo(() => {
    const terms = searchTerms(filter);
    return sessions
      .filter(s => s.project === projectPath)
      .filter(s => showArchived || !s.archived)
      .filter(s => matchesSession(s, terms, ctx))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }, [sessions, projectPath, showArchived, filter, ctx]);

  const openChat = (id: string): void => { void openSession(id).then(onOpenChat); };

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
          <button
            onClick={() => setSettingsOpen(true)}
            className="shrink-0 rounded-full border border-aico-border px-3 py-1.5 text-[12px] text-aico-primary
                       transition-colors hover:bg-aico-hover"
          >
            Edit properties
          </button>
        </header>

        <StatsTiles stats={stats} />

        <Section title="Stack &amp; commands" icon="sliders">
          <ProjectCommands cwd={projectPath} />
        </Section>

        <Section title="Chats" icon="stack" count={chats.length}>
          <div className="mb-2 flex items-center gap-2">
            <div className="relative flex-1">
              <Icon name="search" size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-aico-muted" />
              <input
                value={filter}
                onChange={e => setFilter(e.target.value)}
                placeholder="Search chats in this workspace…"
                className="w-full rounded-lg border border-aico-border-subtle bg-aico-surface py-1.5 pl-8 pr-3
                           text-[12px] text-aico-primary placeholder:text-aico-muted
                           transition-colors focus:border-aico-accent/60 focus:outline-none"
              />
            </div>
            <button
              onClick={() => toggleArchived()}
              aria-pressed={showArchived}
              title={showArchived ? 'Hide archived chats' : 'Show archived chats'}
              className={`flex shrink-0 items-center gap-1 rounded-lg border px-2.5 py-1.5 text-[12px] transition-colors
                          ${showArchived ? 'border-aico-accent/50 bg-aico-accent-soft text-aico-accent' : 'border-aico-border-subtle text-aico-muted hover:text-aico-primary'}`}
            >
              <Icon name="archive" size={14} /> Archived
            </button>
          </div>
          {chats.length === 0 ? (
            <p className="py-3 text-[12px] text-aico-muted">
              {filter ? 'No chats match.' : 'No chats here yet.'}
            </p>
          ) : (
            <ul className="divide-y divide-aico-border-subtle">
              {chats.map(chat => (
                <li key={chat.id}>
                  <button
                    onClick={() => openChat(chat.id)}
                    className="flex w-full items-center gap-2 py-2 text-left transition-colors hover:bg-aico-hover"
                  >
                    <span className="min-w-0 flex-1 truncate text-[13px] text-aico-primary">
                      {chat.title?.trim() || 'New session'}
                    </span>
                    {chat.archived && <Icon name="archive" size={12} className="shrink-0 text-aico-muted" />}
                    <span className="shrink-0 tabular-nums text-[11px] text-aico-muted">
                      {chat.turns ?? 0} turn{chat.turns === 1 ? '' : 's'}
                    </span>
                    <span className="shrink-0 text-[11px] text-aico-muted">
                      {new Date(chat.updatedAt).toLocaleDateString()}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Section>

        <Section title="Git history" icon="fork">
          {!log ? (
            <p className="py-3 text-[12px] text-aico-muted">Loading…</p>
          ) : !log.isRepo ? (
            <p className="py-3 text-[12px] text-aico-muted">This workspace is not a git repository.</p>
          ) : log.commits.length === 0 ? (
            <p className="py-3 text-[12px] text-aico-muted">No commits yet.</p>
          ) : (
            <>
              <ul className="divide-y divide-aico-border-subtle">
                {log.commits.map(commit => <CommitRow key={commit.hash} commit={commit} />)}
              </ul>
              {log.hasMore && (
                <button
                  onClick={() => void loadMoreCommits()}
                  disabled={loadingMore}
                  className="mt-2 w-full rounded-lg border border-aico-border-subtle py-1.5 text-[12px] text-aico-secondary
                             transition-colors hover:bg-aico-hover disabled:opacity-50"
                >
                  {loadingMore ? 'Loading…' : 'Load more'}
                </button>
              )}
            </>
          )}
        </Section>
      </div>

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

function CommitRow({ commit }: { commit: CommitInfo }): React.ReactElement {
  return (
    <li className="flex items-center gap-2.5 py-1.5">
      <span className="shrink-0 rounded bg-aico-hover px-1.5 py-0.5 font-mono text-[11px] text-aico-secondary" title={commit.hash}>
        {commit.shortHash}
      </span>
      <span className="min-w-0 flex-1 truncate text-[13px] text-aico-primary">{commit.subject}</span>
      <span className="shrink-0 text-[11px] text-aico-muted">{commit.author}</span>
      <span className="shrink-0 text-[11px] text-aico-muted" title={commit.date}>
        {Number.isNaN(Date.parse(commit.date)) ? '' : new Date(commit.date).toLocaleDateString()}
      </span>
    </li>
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
