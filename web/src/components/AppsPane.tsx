/**
 * The Apps destination: what a workspace has built, what is running, and what
 * an app can start from.
 *
 * ## Three bands
 *
 * Running first, because a process that is installing or has failed is the
 * thing the reader came to check. Then the apps themselves, grouped by
 * category, each with its kind, its address and how far its backlog has got.
 * Then the templates — the shipped starting points — as the way to make a new
 * one, alongside "build one by talking", which is still the right start for a
 * one-screen tool nobody has designed yet.
 *
 * ## When the host is off
 *
 * The pane still lists what is on disk and says plainly that page and static
 * apps are not being served. Apps built before the switch was flipped are still
 * there; someone who turned it off wants to know what they have.
 *
 * @module components/AppsPane
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { api, type AppTemplate, type MiniAppProcess, type MiniAppSummary, type MiniAppsView } from '../api';
import { useStore } from '../store';
import { Icon } from './Icon';
import { AppCreateWizard } from './AppCreateWizard';

interface Props {
  /** Switch to the conversation view once an app's session is open. */
  onOpenChat: () => void;
}

/** Whether an app runs as its own process (and so has a start/stop and a moving address). */
export function ownsProcess(kind: MiniAppSummary['kind']): boolean {
  return kind === 'process' || kind === 'nextjs' || kind === 'mobile';
}

const CATEGORY_LABEL: Record<string, string> = {
  'internal-tool': 'Internal tools',
  landing: 'Sites',
  saas: 'Web apps',
  api: 'Services',
  dashboard: 'Dashboards',
  cli: 'Command-line tools',
  docs: 'Documentation',
  agent: 'Agents',
  mobile: 'Mobile',
};

export function categoryLabel(category: string | undefined): string {
  if (!category) return 'Other apps';
  return CATEGORY_LABEL[category] ?? category.replace(/[-_]/g, ' ').replace(/^\w/, c => c.toUpperCase());
}

export function AppsPane({ onOpenChat }: Props): React.ReactElement {
  const busy = useStore(s => s.busy);
  // Its own thread, not whatever chat is open. Building an app is a task, and
  // burying it in the middle of unrelated work loses it twice over.
  const askAgentFor = useStore(s => s.askAgentFor);
  // Each app has one conversation, rejoined rather than restarted.
  const openMiniApp = useStore(s => s.openMiniApp);

  /*
    Live, not polled. The store holds one stream for the Apps topic: a full
    frame on connect, process state the moment the runner emits it — an install
    finishing, a dev server printing its port, a deploy failing — and a refetch
    when the list itself changed. A first `npm install` used to be a card that
    did not move for minutes; now it moves as the output does.
  */
  const view = useStore(s => s.apps);
  const live = useStore(s => s.appsLive);
  const connectApps = useStore(s => s.connectApps);
  const refresh = useStore(s => s.refreshApps);
  const [templates, setTemplates] = useState<AppTemplate[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<MiniAppSummary | null>(null);
  const [wizard, setWizard] = useState<{ template?: AppTemplate } | null>(null);

  useEffect(() => connectApps(), [connectApps]);
  // A turn that just built an app announces nothing on the topic (the agent
  // wrote files, not a process), so the list is refetched when a turn ends.
  useEffect(() => { void refresh().catch(err => setError(err instanceof Error ? err.message : String(err))); }, [refresh, busy]);
  useEffect(() => {
    void api.templates().then(r => setTemplates(r.templates)).catch(() => setTemplates([]));
  }, []);

  const buildByTalking = (): void => askAgentFor(
    'Build me an app. Ask me what it should do and who uses it, then pick a template with AppManage templates before you start.',
  );

  const openSession = (slug: string): void => {
    void openMiniApp(slug).then(onOpenChat);
  };

  const apps = view?.apps ?? [];
  const processes = view?.processes ?? [];
  const running = processes.filter(p => p.state !== 'stopped' && p.state !== 'done');

  const grouped = useMemo(() => {
    const byCategory = new Map<string, MiniAppSummary[]>();
    for (const app of apps) {
      const key = app.category ?? (app.kind === 'page' || !app.kind ? 'internal-tool' : 'other');
      const list = byCategory.get(key) ?? [];
      list.push(app);
      byCategory.set(key, list);
    }
    return [...byCategory.entries()].sort((a, b) => categoryLabel(a[0]).localeCompare(categoryLabel(b[0])));
  }, [apps]);

  if (error) {
    return (
      <div className="p-6">
        <p className="text-[13px] text-aico-danger">{error}</p>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col overflow-y-auto" data-apps-pane>
      <div className="flex items-center gap-3 border-b border-aico-border-subtle px-5 py-3">
        <div>
          <h2 className="flex items-center gap-2 text-[14px] font-semibold text-aico-primary">
            Apps
            <span
              data-apps-live={live}
              title={live === 'live' ? 'Live: process state arrives as it happens' : live === 'lost' ? 'Connection lost; reconnecting' : 'Connecting'}
              className={`inline-block h-1.5 w-1.5 rounded-full ${live === 'live' ? 'bg-emerald-500' : live === 'lost' ? 'bg-aico-danger' : 'bg-amber-400'}`}
            />
          </h2>
          <p className="text-[12px] text-aico-muted">
            Applications kept in this workspace, from one-screen tools to full-stack services.
          </p>
        </div>
        <div className="flex-1" />
        <button
          onClick={buildByTalking}
          className="rounded-lg border border-aico-border bg-aico-bg px-3 py-1.5 text-[13px]
                     font-medium text-aico-primary transition-colors hover:bg-aico-hover"
        >
          Build one by talking
        </button>
        <button
          onClick={() => setWizard({})}
          data-create-app
          className="rounded-lg bg-aico-accent px-3 py-1.5 text-[13px] font-medium text-white
                     transition-opacity hover:opacity-90"
        >
          Create app
        </button>
      </div>

      {view && !view.enabled && (
        <div className="mx-5 mt-4 rounded-lg border border-aico-border-subtle bg-aico-hover/40 px-4 py-3">
          <p className="text-[13px] text-aico-primary">Apps are switched off.</p>
          <p className="mt-1 text-[12px] text-aico-muted">
            Page and static apps are not being served. Turn Apps on in Settings — it takes
            effect straight away, no restart — and anything listed here will be waiting.
          </p>
        </div>
      )}

      {view?.enabled && !view.host && (
        <div className="mx-5 mt-4 rounded-lg border border-aico-danger/30 bg-aico-danger/5 px-4 py-3">
          <p className="text-[13px] text-aico-danger">The Apps host is not running.</p>
          {/*
            The server's own reason, not a guess. "Did not start" sent the
            reader to the terminal to find out which port was taken.
          */}
          <p className="mt-1 text-[12px] text-aico-muted">
            {view.error ?? 'It did not start, and gave no reason.'}
          </p>
          <button
            onClick={() => void refresh()}
            className="mt-2 rounded-lg border border-aico-border bg-aico-bg px-2.5 py-1
                       text-[12px] text-aico-primary transition-colors hover:bg-aico-hover"
          >
            Try again
          </button>
        </div>
      )}

      {running.length > 0 && (
        <section className="px-5 pt-4" data-apps-running>
          <h3 className="text-[11px] font-semibold uppercase tracking-wide text-aico-muted">Running</h3>
          <ul className="mt-2 divide-y divide-aico-border-subtle rounded-xl border border-aico-border-subtle">
            {running.map(p => {
              const app = apps.find(a => a.slug === p.slug);
              return (
                <li key={p.slug} className="flex items-center gap-3 px-3 py-2">
                  <span className={`h-2 w-2 shrink-0 rounded-full ${
                    p.state === 'running' ? 'bg-emerald-500' : p.state === 'failed' ? 'bg-aico-danger' : 'bg-amber-400 animate-pulse'
                  }`} />
                  <span className="min-w-0 flex-1 truncate text-[13px] text-aico-primary">
                    {app?.title ?? p.slug}
                    <span className="ml-2 text-[12px] text-aico-muted">{PROCESS_LABEL[p.state]}</span>
                  </span>
                  {p.url && p.state === 'running' && (
                    <a href={p.url} target="_blank" rel="noreferrer noopener"
                       className="truncate font-mono text-[11px] text-aico-accent hover:underline">{p.url}</a>
                  )}
                  <button
                    onClick={async () => { await api.runMiniApp(p.slug, 'stop').catch(() => undefined); void refresh(); }}
                    className="rounded-lg px-2 py-1 text-[12px] text-aico-secondary hover:bg-aico-hover hover:text-aico-primary"
                  >
                    Stop
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {apps.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-2 px-6 py-12 text-center">
          <p className="text-[14px] text-aico-primary">No apps yet</p>
          <p className="max-w-sm text-[12px] text-aico-muted">
            Start from a template below — a records tool, a landing page, a JSON API, a web app
            with accounts — or describe what you need and let the agent choose.
          </p>
        </div>
      ) : (
        grouped.map(([category, list]) => (
          <section key={category} className="px-5 pt-5" data-apps-category={category}>
            <h3 className="text-[11px] font-semibold uppercase tracking-wide text-aico-muted">
              {categoryLabel(category)}
              <span className="ml-1.5 font-normal normal-case tracking-normal">{list.length}</span>
            </h3>
            <div className="mt-2 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {list.map(app => (
                <AppCard
                  key={app.slug}
                  app={app}
                  host={view?.host ?? null}
                  process={processes.find(p => p.slug === app.slug)}
                  deploy={processes.find(p => p.slug === `${app.slug}#deploy`)}
                  onRun={async (action) => {
                    await api.runMiniApp(app.slug, action).catch(() => undefined);
                    void refresh();
                  }}
                  onDeploy={async (target) => {
                    try {
                      await api.deployApp(app.slug, target);
                    } catch (err) {
                      // The server's own sentence — "needs docker on this machine" —
                      // is the useful one, and it belongs on the card, not in a toast.
                      setError(err instanceof Error ? err.message : String(err));
                    }
                  }}
                  onOpenSession={() => openSession(app.slug)}
                  onDuplicate={async () => {
                    try {
                      await api.duplicateApp(app.slug);
                      void refresh();
                    } catch (err) {
                      setError(err instanceof Error ? err.message : String(err));
                    }
                  }}
                  onDelete={() => setConfirming(app)}
                />
              ))}
            </div>
          </section>
        ))
      )}

      {templates.length > 0 && (
        <section className="px-5 pb-6 pt-6" data-apps-templates>
          <h3 className="text-[11px] font-semibold uppercase tracking-wide text-aico-muted">Start from a template</h3>
          <p className="mt-1 text-[12px] text-aico-muted">
            Each arrives with a worked feature, tests, notes for the agent and a Dockerfile. Nothing is generated;
            the files are copied.
          </p>
          <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {templates.map(t => (
              <button
                key={t.id}
                onClick={() => setWizard({ template: t })}
                data-template={t.id}
                className="group flex flex-col rounded-xl border border-aico-border-subtle bg-aico-surface p-4 text-left
                           transition-colors hover:border-aico-accent/50 hover:bg-aico-hover/40"
              >
                <div className="flex items-start gap-2">
                  <p className="min-w-0 flex-1 text-[14px] font-medium text-aico-primary">{t.name}</p>
                  <KindBadge kind={t.kind} />
                </div>
                <p className="mt-1 line-clamp-3 text-[12px] text-aico-muted">{t.summary}</p>
                <p className="mt-2 text-[11px] text-aico-muted">
                  {categoryLabel(t.category)}
                  {t.requires?.node ? ` · Node ${t.requires.node}` : ''}
                  {t.source !== 'bundled' ? ` · ${t.source}` : ''}
                </p>
              </button>
            ))}
          </div>
        </section>
      )}

      {wizard && (
        <AppCreateWizard
          templates={templates}
          initial={wizard.template}
          onClose={() => setWizard(null)}
          onCreated={(slug) => {
            setWizard(null);
            void refresh();
            openSession(slug);
          }}
        />
      )}

      {confirming && (
        <ConfirmDelete
          app={confirming}
          onCancel={() => setConfirming(null)}
          onConfirm={async () => {
            await api.deleteMiniApp(confirming.slug);
            setConfirming(null);
            void refresh();
          }}
        />
      )}
    </div>
  );
}

const PROCESS_LABEL: Record<MiniAppProcess['state'], string> = {
  stopped: 'stopped',
  installing: 'installing dependencies…',
  starting: 'starting…',
  running: 'running',
  failed: 'failed',
  working: 'working…',
  done: 'done',
};

const KIND_LABEL: Record<NonNullable<MiniAppSummary['kind']>, string> = {
  page: 'page',
  static: 'static',
  process: 'process',
  nextjs: 'process',
  cli: 'cli',
  mobile: 'mobile',
};

export function KindBadge({ kind }: { kind: MiniAppSummary['kind'] }): React.ReactElement {
  const label = KIND_LABEL[kind ?? 'page'];
  return (
    <span
      title={label === 'process'
        ? 'Runs as its own process with your permissions'
        : label === 'page' ? 'One page over the shared SQLite host' : label}
      className="shrink-0 rounded bg-aico-hover px-1.5 py-0.5 font-mono text-[10px] text-aico-muted"
    >
      {label}
    </span>
  );
}

function AppCard(
  { app, host, process, deploy, onRun, onDeploy, onOpenSession, onDuplicate, onDelete }: {
    app: MiniAppSummary;
    host: string | null;
    process?: MiniAppProcess;
    /** The last deploy's record, kept under `<slug>#deploy`. */
    deploy?: MiniAppProcess;
    onRun: (action: 'start' | 'stop') => void;
    onDeploy: (target?: string) => void;
    onOpenSession: () => void;
    onDuplicate: () => void;
    onDelete: () => void;
  },
): React.ReactElement {
  const targets = app.deploy ?? [];
  const deploying = deploy?.state === 'working';
  const isProcess = ownsProcess(app.kind);
  const isCli = app.kind === 'cli';
  /*
    Two ideas of "where it is".

    A page or static app lives at a fixed address on the shared host and is up
    whenever that host is. A process app has no address until it is started,
    and quoting one before then would be a link to nothing. A CLI has none.
  */
  const url = isCli
    ? null
    : isProcess
      ? (process?.state === 'running' ? process.url ?? null : null)
      : (host ? `${host}/${app.slug}/` : null);
  const openable = Boolean(url) && app.built;
  const busyState = process?.state === 'installing' || process?.state === 'starting' || process?.state === 'working';
  const progress = app.backlog && app.backlog.total > 0 ? app.backlog : null;

  return (
    <div className="group flex flex-col rounded-xl border border-aico-border-subtle bg-aico-surface p-4" data-app-card={app.slug}>
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <p className="truncate text-[14px] font-medium text-aico-primary">{app.title}</p>
          {app.description && (
            <p className="mt-0.5 line-clamp-2 text-[12px] text-aico-muted">{app.description}</p>
          )}
        </div>
        <KindBadge kind={app.kind} />
        {!app.built && (
          <span className="shrink-0 rounded bg-aico-hover px-1.5 py-0.5 text-[10px] text-aico-muted">
            unfinished
          </span>
        )}
      </div>

      <p className="mt-2 truncate font-mono text-[11px] text-aico-muted" title={url ?? undefined}>
        {url ?? (isCli
          ? 'command-line tool'
          : isProcess
            ? (process ? PROCESS_LABEL[process.state] : 'not running')
            : 'not being served')}
      </p>

      {progress && (
        <div className="mt-2 flex items-center gap-2" title={`${progress.done} of ${progress.total} stories done`}>
          <div className="h-1 flex-1 overflow-hidden rounded bg-aico-hover">
            <div className="h-full bg-aico-accent" style={{ width: `${Math.round((progress.done / progress.total) * 100)}%` }} />
          </div>
          <span className="text-[10px] tabular-nums text-aico-muted">{progress.done}/{progress.total}</span>
        </div>
      )}

      {/*
        The process's own words when it fails. "Failed to start" sends the
        reader to a terminal; the last lines of output usually name the file
        and the line.
      */}
      {isProcess && process?.state === 'failed' && (
        <details className="mt-2">
          <summary className="cursor-pointer text-[11px] text-aico-danger">
            {process.error ?? 'it did not start'}
          </summary>
          <pre className="mt-1 max-h-40 overflow-auto rounded bg-aico-bg p-2
                          font-mono text-[10px] leading-relaxed text-aico-secondary">
            {process.output.slice(-20).join('\n') || 'no output'}
          </pre>
        </details>
      )}

      {/*
        The deploy's own words. A build that fails says where in its log, and a
        build that finished printed the command to run the image.
      */}
      {deploy && deploy.state !== 'stopped' && (
        <details className="mt-2" open={deploy.state === 'failed'} data-deploy-record>
          <summary className={`cursor-pointer text-[11px] ${deploy.state === 'failed' ? 'text-aico-danger' : 'text-aico-muted'}`}>
            {deploy.state === 'working' ? 'deploying…' : deploy.state === 'done' ? 'deployed' : `deploy failed${deploy.error ? ` — ${deploy.error}` : ''}`}
          </summary>
          <pre className="mt-1 max-h-40 overflow-auto rounded bg-aico-bg p-2 font-mono text-[10px] leading-relaxed text-aico-secondary">
            {deploy.output.slice(-30).join('\n') || 'no output yet'}
          </pre>
        </details>
      )}

      <div className="mt-3 flex items-center gap-1.5">
        {/*
          A plain link, opened in a new tab. Not an iframe: the whole point of
          the separate port is that the app is a different origin, and framing
          it back into this page would be a good way to slowly undo that.
        */}
        {!isCli && (
          <a
            href={openable ? url! : undefined}
            target="_blank"
            rel="noreferrer noopener"
            aria-disabled={!openable}
            onClick={e => { if (!openable) e.preventDefault(); }}
            className={`rounded-lg px-2.5 py-1.5 text-[12px] font-medium transition-colors ${
              openable
                ? 'bg-aico-accent/10 text-aico-accent hover:bg-aico-accent/20'
                : 'cursor-not-allowed text-aico-muted'
            }`}
          >
            Open
          </a>
        )}
        {isProcess && (
          <button
            onClick={() => onRun(process?.state === 'running' ? 'stop' : 'start')}
            disabled={busyState}
            className="rounded-lg px-2.5 py-1.5 text-[12px] text-aico-secondary
                       transition-colors hover:bg-aico-hover hover:text-aico-primary
                       disabled:opacity-50"
          >
            {busyState ? PROCESS_LABEL[process!.state]
              : process?.state === 'running' ? 'Stop' : 'Start'}
          </button>
        )}
        <button
          onClick={onOpenSession}
          className="rounded-lg px-2.5 py-1.5 text-[12px] text-aico-secondary
                     transition-colors hover:bg-aico-hover hover:text-aico-primary"
        >
          Work on it
        </button>
        <button
          onClick={onDuplicate}
          title="A copy under a new name: the files and profiles, not the data or the install"
          className="rounded-lg px-2.5 py-1.5 text-[12px] text-aico-secondary
                     transition-colors hover:bg-aico-hover hover:text-aico-primary"
          data-duplicate
        >
          Duplicate
        </button>
        {targets.length > 0 && app.built && (
          /*
            One target is a button; several are a select. The script and the
            tool it needs are the app's own (app.json), and the server refuses
            plainly when the tool is missing — that sentence lands on the pane.
          */
          targets.length === 1 ? (
            <button
              onClick={() => onDeploy(targets[0]!.id)}
              disabled={deploying}
              data-deploy
              title={`${targets[0]!.label}${targets[0]!.requires?.length ? ` (needs ${targets[0]!.requires.join(', ')})` : ''}`}
              className="rounded-lg px-2.5 py-1.5 text-[12px] text-aico-secondary
                         transition-colors hover:bg-aico-hover hover:text-aico-primary disabled:opacity-50"
            >
              {deploying ? 'Deploying…' : 'Deploy'}
            </button>
          ) : (
            <select
              onChange={e => { if (e.target.value) { onDeploy(e.target.value); e.target.value = ''; } }}
              disabled={deploying}
              data-deploy
              className="rounded-lg border border-aico-border bg-aico-bg px-2 py-1 text-[12px] text-aico-secondary"
              defaultValue=""
            >
              <option value="">{deploying ? 'Deploying…' : 'Deploy…'}</option>
              {targets.map(t => <option key={t.id} value={t.id}>{t.label}</option>)}
            </select>
          )
        )}
        <div className="flex-1" />
        <button
          onClick={onDelete}
          aria-label={`Delete ${app.title}`}
          className="rounded-lg p-1.5 text-aico-muted opacity-0 transition
                     hover:bg-aico-danger/10 hover:text-aico-danger
                     focus-visible:opacity-100 group-hover:opacity-100"
        >
          <Icon name="trash" size={14} />
        </button>
      </div>
    </div>
  );
}

/**
 * The one destructive control here, so it says what is lost.
 *
 * "Delete the app" undersells it — the code can be rebuilt from a template,
 * and the records in its database cannot. The confirmation names the data.
 */
function ConfirmDelete(
  { app, onCancel, onConfirm }: {
    app: MiniAppSummary; onCancel: () => void; onConfirm: () => void;
  },
): React.ReactElement {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-6"
      onClick={onCancel}
      onKeyDown={e => { if (e.key === 'Escape') onCancel(); }}
    >
      <div
        role="alertdialog"
        aria-modal="true"
        onClick={e => e.stopPropagation()}
        className="w-full max-w-sm rounded-xl border border-aico-border bg-aico-surface p-5"
      >
        <p className="text-[14px] font-medium text-aico-primary">Delete “{app.title}”?</p>
        <p className="mt-2 text-[12px] text-aico-muted">
          The app and its data go together. Every record in it is gone for good —
          that part cannot be rebuilt from a template.
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <button
            onClick={onCancel}
            className="rounded-lg border border-aico-border px-3 py-1.5 text-[13px] text-aico-primary
                       transition-colors hover:bg-aico-hover"
          >
            Keep it
          </button>
          <button
            onClick={onConfirm}
            className="rounded-lg bg-aico-danger px-3 py-1.5 text-[13px] font-medium text-white
                       transition-opacity hover:opacity-90"
          >
            Delete
          </button>
        </div>
      </div>
    </div>
  );
}
