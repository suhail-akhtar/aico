/**
 * The panel shell.
 *
 * Structurally this is the browser client's `App` with everything a side bar
 * cannot use taken out: no sidebar, no drawer, no theme switch, no token gate.
 * What is left is the conversation, the sessions behind it, and a composer —
 * which is what a 300px column is actually good for.
 *
 * Three differences from the browser are worth naming, because each is a
 * decision rather than an omission:
 *
 * **No token gate.** The extension host holds the token and attaches it in the
 * tunnel. There is nothing for a person to paste, and a prompt asking them to
 * would be asking for a secret they have never seen.
 *
 * **No theme switch.** VS Code owns the theme. `vscode-theme.css` derives every
 * colour from it, so the panel follows a theme change with no listener.
 *
 * **The folder comes from the editor.** The browser client asks the server which
 * project to work in; here the answer is already known — it is the folder the
 * user has open — and using anything else is how an agent ends up writing files
 * into the directory the extension host happened to launch from.
 *
 * @module Panel
 */

import React, { useEffect, useState } from 'react';
import { useStore } from '@web/store';
import { setTokenRejectedHandler } from '@web/api';
import { onBoot, signalReady, host, remember, type BootInfo } from './host';
import { sameFolder } from './paths';
import { Header } from './components/Header';
import { SessionList } from './components/SessionList';
import { Transcript } from './components/Transcript';
import { Progress } from './components/Progress';
import { SubAgents } from './components/SubAgents';
import { PlanCard } from './components/PlanCard';
import { GoalBar } from './components/GoalBar';
import { Composer } from './components/Composer';
import { PermissionBridge } from './components/PermissionBridge';
import { EditBridge } from './components/EditBridge';
import { HostBridge } from './components/HostBridge';

export function Panel(): React.ReactElement {
  const [boot, setBoot] = useState<BootInfo | null>(null);
  const [showSessions, setShowSessions] = useState(false);
  /**
   * Set when the host cannot reach the server at all.
   *
   * Distinct from the store's `error`, which reports a request that failed for
   * a reason the server explained. This one means there is nothing to explain
   * it — usually that `aico` is not installed, which needs a different answer.
   */
  const [fatal, setFatal] = useState<string | null>(null);
  /**
   * Which of the three waits the panel is in.
   *
   * Named rather than a boolean, because "loading" is the least useful thing a
   * loading state can say. A server that never starts and a log that never
   * replays look identical behind one spinner and have completely different
   * causes.
   */
  const [stage, setStage] = useState<'server' | 'history' | 'ready'>('server');

  const connect = useStore(s => s.connect);
  const disconnect = useStore(s => s.disconnect);
  const sessionId = useStore(s => s.sessionId);
  const refreshSessions = useStore(s => s.refreshSessions);
  const refreshProviders = useStore(s => s.refreshProviders);
  const refreshSettings = useStore(s => s.refreshSettings);
  const refreshProjects = useStore(s => s.refreshProjects);

  useEffect(() => onBoot(setBoot), []);
  useEffect(() => { signalReady(); }, []);

  /*
    Keep the folder's memory current as the conversation and the model change.

    Written on every change rather than on unload: a webview is disposed without
    warning when the view is hidden, and `beforeunload` is not reliable there —
    so anything saved only on the way out is saved only sometimes.

    Guarded on `boot` so the values recorded are ones this panel actually
    established. Writing during the first render would store the store's initial
    placeholders over the very thing being restored.
  */
  const model = useStore(s => s.model);
  useEffect(() => {
    if (!boot?.folder) return;
    remember({ sessionId, model });
  }, [boot, sessionId, model]);

  /*
    A rejected token means the server restarted and minted a new one. In the
    browser that returns the user to a prompt; here there is nobody to prompt —
    the host will pick the new token up on its next request, so the only useful
    response is to reconnect rather than to sit on a dead stream.
  */
  useEffect(() => {
    setTokenRejectedHandler(() => { void refreshSessions(); });
  }, [refreshSessions]);

  useEffect(() => {
    if (!boot) return;
    let cancelled = false;

    void (async () => {
      try {
        await refreshProjects();
        if (cancelled) return;

        /*
          Point the session at the open folder before connecting.

          `connect` sends the project along on subscribe, because subscribing is
          what opens a session server-side. Selecting afterwards would file the
          first session of the day under whichever directory the server was
          launched in — the same bug that once sent every scheduled job's output
          to the wrong place.

          The match is case-insensitive, and the server's spelling wins. Windows
          paths are case-insensitive but the registry compares them as strings,
          so an exact match registered a *second* project for a folder aico
          already knew — after which sessions started from a terminal no longer
          appeared in this list, because they were filed under the other
          spelling of the same directory.
        */
        if (boot.folder) {
          const registered = useStore.getState().projects
            .find(p => sameFolder(p.path, boot.folder));
          if (!registered) {
            await useStore.getState().addProject(boot.folder, boot.folderName ?? undefined);
          }
          useStore.getState().selectProject(registered?.path ?? boot.folder);
        }
        if (cancelled) return;

        /*
          `selectProject` starts a fresh session when the folder changes — a
          session belongs to one directory for its whole life. So the id is read
          back rather than captured before, or this would reconnect to whatever
          session the previous folder left behind.
        */
        /*
          The first request through the tunnel is what starts the server, so
          reaching here means it is up. Anything after this is the log.
        */
        if (!cancelled) setStage('history');

        connect(useStore.getState().sessionId);
        await refreshSessions();
        if (cancelled) return;

        /*
          Pick up where this folder left off.

          Opening the panel used to mint a brand-new conversation every single
          time — and with it lose the model, which the server pins *per session*
          by design. The complaint was "it forgets my model"; the cause was that
          it forgot the session the model was pinned to.

          Only a conversation with something in it is resumed. A remembered id
          for a session nobody ever wrote to would restore an empty screen and
          look like nothing happened.
        */
        const remembered = boot.lastSession
          ? useStore.getState().sessions.find(s =>
            s.id === boot.lastSession && !s.archived && (s.turns ?? 0) > 0)
          : undefined;

        if (remembered) {
          await useStore.getState().openSession(remembered.id);
        } else if (boot.lastModel) {
          /*
            A new conversation inherits the model, not the default.

            Choosing a model is a statement about the work in this folder, not
            about one conversation in it — so a fresh session in the same
            project starts on it rather than reverting and making the choice
            something you re-make every morning.
          */
          useStore.getState().setModel(boot.lastModel);
        }

        if (!cancelled) setStage('ready');
        void refreshProviders();
        void refreshSettings();
      } catch (err) {
        if (!cancelled) setFatal(err instanceof Error ? err.message : String(err));
      }
    })();

    return () => { cancelled = true; disconnect(); };
    // Runs once the folder is known. `connect` is what changes sessions, not this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boot]);

  /*
    Say what is happening while it happens.

    Three waits stack up before a panel is usable and none of them used to show
    anything: the extension activating, `aico serve` starting for the folder,
    and the session's log replaying. On a cold start that is several seconds of
    blank column, which is indistinguishable from a panel that is broken — and
    the honest fix is not to make it faster but to say which of the three it is
    in, because each has a different remedy if it never finishes.
  */
  if (!boot) {
    return <Loading what="Starting up…" detail="Waiting for the extension to hand over the folder." />;
  }

  if (boot.folder && stage !== 'ready') {
    return (
      <Loading
        what={stage === 'server' ? 'Starting aico…' : 'Loading this conversation…'}
        detail={stage === 'server'
          ? `In ${boot.folderName ?? boot.folder}. The first start compiles nothing but does open a server.`
          : 'Replaying the session log — the whole conversation, not a summary.'}
      />
    );
  }

  if (boot && !boot.folder) {
    return (
      <Empty
        title="No folder open"
        detail="aico works in a project directory — a session's log is filed under one, and its file tools are confined to it."
        action={{ label: 'Open a folder…', onClick: host.openFolder }}
      />
    );
  }

  if (fatal) {
    return (
      <Empty
        title="Could not reach aico"
        detail={fatal}
        hint="Check that aico is installed and on your PATH, or set aico.command in Settings. Run “aico: Check the Setup” for a fuller answer."
      />
    );
  }

  return (
    <div className="flex h-full flex-col bg-aico-bg text-aico-primary">
      <Header
        onToggleSessions={() => setShowSessions(v => !v)}
        sessionsOpen={showSessions}
      />
      {showSessions && (
        <SessionList
          activeId={sessionId}
          onPick={() => setShowSessions(false)}
        />
      )}
      <Transcript />
      <SubAgents />
      <Progress />
      {/*
        Above the goal, below the task list. A plan is a decision waiting on the
        reader, so it sits closest to the thing they are about to type into.
      */}
      <PlanCard />
      {/*
        Directly above the composer, which is where it is read: the last thing
        seen before writing the next message.
      */}
      <GoalBar />
      <Composer />
      <PermissionBridge />
      <EditBridge />
      <HostBridge />
    </div>
  );
}

function Empty({ title, detail, hint, action }: {
  title: string;
  detail: string;
  hint?: string;
  /** The thing that resolves the state, offered rather than described. */
  action?: { label: string; onClick: () => void };
}): React.ReactElement {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
      <p className="text-[13px] font-medium text-aico-primary">{title}</p>
      <p className="text-[12px] leading-relaxed text-aico-secondary">{detail}</p>
      {action && (
        <button
          type="button"
          onClick={action.onClick}
          className="mt-1 rounded bg-aico-accent px-2.5 py-1 text-[12px] text-aico-on-accent hover:bg-aico-accent-hover"
        >
          {action.label}
        </button>
      )}
      {hint && <p className="text-[11px] leading-relaxed text-aico-muted">{hint}</p>}
    </div>
  );
}

/**
 * A wait with a name on it.
 *
 * Deliberately not a spinner alone. A spinner says "something is happening",
 * which the reader already assumed; the sentence says *what*, which is the part
 * that tells them whether waiting is reasonable.
 */
function Loading({ what, detail }: { what: string; detail: string }): React.ReactElement {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
      <span
        aria-hidden
        className="size-4 animate-spin rounded-full border-2 border-aico-border border-t-aico-accent"
      />
      <p className="text-[12px] text-aico-secondary" role="status">{what}</p>
      <p className="text-[11px] leading-relaxed text-aico-muted">{detail}</p>
    </div>
  );
}
