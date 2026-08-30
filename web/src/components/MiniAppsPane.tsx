/**
 * The Mini Apps a workspace has, and the way into them.
 *
 * Deliberately not a place to *build* one. Building is a conversation — what
 * the app is for, what it stores, what happens when a number is wrong — and a
 * panel that tried to collect that in a form would be a worse version of the
 * chat that is already open. So this lists what exists, opens it, and starts
 * the conversation that makes a new one.
 *
 * ## When the plugin is off
 *
 * The panel still lists what is on disk, and says plainly that nothing is
 * being served. That is better than an empty screen: apps built before the
 * switch was flipped are still there, and someone who turned it off wants to
 * know what they have, not to be told the feature does not exist.
 *
 * @module components/MiniAppsPane
 */

import React, { useCallback, useEffect, useState } from 'react';
import { api, type MiniAppProcess, type MiniAppSummary, type MiniAppsView } from '../api';
import { useStore } from '../store';
import { Icon } from './Icon';

interface Props {
  /** Switch to the conversation view once an app's section is open. */
  onOpenChat: () => void;
}

export function MiniAppsPane({ onOpenChat }: Props): React.ReactElement {
  const busy = useStore(s => s.busy);
  // Its own thread, not whatever chat is open. Building an app is a task, and
  // burying it in the middle of unrelated work loses it twice over.
  const askAgentFor = useStore(s => s.askAgentFor);
  // Each app has one conversation, rejoined rather than restarted.
  const openMiniApp = useStore(s => s.openMiniApp);

  const [view, setView] = useState<MiniAppsView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<MiniAppSummary | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      setView(await api.miniApps());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  // On open, and again when a turn ends — an agent that just built one should
  // not need a manual refresh to make it appear.
  useEffect(() => { void refresh(); }, [refresh, busy]);

  /*
    While something is installing or starting, keep asking.

    A first `npm install` runs for minutes and prints nothing this side of the
    process boundary. A card that does not change during it is indistinguishable
    from one that has hung, which is the reading people act on. Polling stops the
    moment nothing is in flight, so an idle panel costs nothing.
  */
  const inFlight = (view?.processes ?? []).some(
    p => p.state === 'installing' || p.state === 'starting');
  useEffect(() => {
    if (!inFlight) return;
    const timer = setInterval(() => { void refresh(); }, 2000);
    return () => clearInterval(timer);
  }, [inFlight, refresh]);

  const build = (): void => askAgentFor(
    'Build me a Mini App. Ask me what it should do and what it needs to store before you start.',
  );

  const openSection = (slug: string): void => {
    void openMiniApp(slug).then(onOpenChat);
  };

  if (error) {
    return (
      <div className="p-6">
        <p className="text-[13px] text-aico-danger">{error}</p>
      </div>
    );
  }

  const apps = view?.apps ?? [];

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <div className="flex items-center gap-3 border-b border-aico-border-subtle px-5 py-3">
        <div>
          <h2 className="text-[14px] font-semibold text-aico-primary">Mini Apps</h2>
          <p className="text-[12px] text-aico-muted">
            Single-page apps with their own database, served locally.
          </p>
        </div>
        <div className="flex-1" />
        <button
          onClick={build}
          className="rounded-lg border border-aico-border bg-aico-bg px-3 py-1.5 text-[13px]
                     font-medium text-aico-primary transition-colors hover:bg-aico-hover"
        >
          Build one
        </button>
      </div>

      {view && !view.enabled && (
        <div className="mx-5 mt-4 rounded-lg border border-aico-border-subtle bg-aico-hover/40 px-4 py-3">
          <p className="text-[13px] text-aico-primary">Mini Apps are switched off.</p>
          <p className="mt-1 text-[12px] text-aico-muted">
            Nothing is being served. Turn them on in Settings — it takes effect
            straight away, no restart — and anything listed here will be waiting.
          </p>
        </div>
      )}

      {view?.enabled && !view.host && (
        <div className="mx-5 mt-4 rounded-lg border border-aico-danger/30 bg-aico-danger/5 px-4 py-3">
          <p className="text-[13px] text-aico-danger">The Mini Apps host is not running.</p>
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

      {apps.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 py-12 text-center">
          <p className="text-[14px] text-aico-primary">No Mini Apps yet</p>
          <p className="max-w-sm text-[12px] text-aico-muted">
            An invoice ledger, a stock list, a reading log — anything with records and
            forms. Describe it and one gets built, with a real database behind it.
          </p>
        </div>
      ) : (
        <div className="grid gap-3 p-5 sm:grid-cols-2 lg:grid-cols-3">
          {apps.map(app => (
            <AppCard
              key={app.slug}
              app={app}
              host={view?.host ?? null}
              process={(view?.processes ?? []).find(p => p.slug === app.slug)}
              onRun={async (action) => {
                await api.runMiniApp(app.slug, action).catch(() => undefined);
                void refresh();
              }}
              onOpenSession={() => openSection(app.slug)}
              onDelete={() => setConfirming(app)}
            />
          ))}
        </div>
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
};

function AppCard(
  { app, host, process, onRun, onOpenSession, onDelete }: {
    app: MiniAppSummary;
    host: string | null;
    process?: MiniAppProcess;
    onRun: (action: 'start' | 'stop') => void;
    onOpenSession: () => void;
    onDelete: () => void;
  },
): React.ReactElement {
  const isNext = app.kind === 'nextjs';
  /*
    Two kinds, two ideas of "where it is".

    A single-page app lives at a fixed address on the shared host and is up
    whenever that host is. A Next.js app is a process: it has no address until
    it is started, and quoting one before then would be a link to nothing.
  */
  const url = isNext
    ? (process?.state === 'running' ? process.url ?? null : null)
    : (host ? `${host}/${app.slug}/` : null);
  const openable = Boolean(url) && app.built;
  const busyState = process?.state === 'installing' || process?.state === 'starting';

  return (
    <div className="group flex flex-col rounded-xl border border-aico-border-subtle bg-aico-surface p-4">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <p className="truncate text-[14px] font-medium text-aico-primary">{app.title}</p>
          {app.description && (
            <p className="mt-0.5 line-clamp-2 text-[12px] text-aico-muted">{app.description}</p>
          )}
        </div>
        {!app.built && (
          <span className="shrink-0 rounded bg-aico-hover px-1.5 py-0.5 text-[10px] text-aico-muted">
            unfinished
          </span>
        )}
      </div>

      <p className="mt-2 truncate font-mono text-[11px] text-aico-muted" title={url ?? undefined}>
        {url ?? (isNext
          ? (process ? PROCESS_LABEL[process.state] : 'not running')
          : 'not being served')}
      </p>

      {/*
        The process's own words when it fails. "Failed to start" sends the
        reader to a terminal; the last lines of output usually name the file
        and the line.
      */}
      {isNext && process?.state === 'failed' && (
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

      <div className="mt-3 flex items-center gap-1.5">
        {/*
          A plain link, opened in a new tab. Not an iframe: the whole point of
          the separate port is that the app is a different origin, and framing
          it back into this page would be a good way to slowly undo that.
        */}
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
        {isNext && (
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
 * "Delete the app" undersells it — the page can be rebuilt from a sentence,
 * and the records in it cannot. The confirmation names the database.
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
          The app and its database go together. Every record in it is gone for good —
          that part cannot be rebuilt from a description.
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
