/**
 * The Tasks panel in the browser client: a header button that says how much
 * is running (and how much waits for you), and a drawer from the right with
 * the same shared panel the desktop shows (shared/ui/tasks/TasksPanel).
 *
 * A drawer rather than a column, because this client also has to work on a
 * phone — the reason the page has no fixed layout at all — and a 420 px
 * rail beside a chat on a 390 px screen is a rail on top of the chat.
 *
 * What it does not do: toasts. The web client has no notification surface of
 * its own; an action's outcome is shown at the foot of the drawer instead.
 *
 * @module components/TasksDrawer
 */

import React, { useEffect, useMemo, useState } from 'react';
import { TasksPanel } from '../../../shared/ui/tasks/TasksPanel';
import { summarise, type TaskActionId, type TaskItem } from '../../../shared/tasks';
import { connectTasks, runScheduleAction, runTaskAction, useTasks, type TaskActionHost } from '../tasks';
import { useStore } from '../store';
import { Icon } from './Icon';

/** The header button: live counts, opens the drawer. Keeps the task stream open while mounted. */
export function TasksButton({ onOpen }: { onOpen: () => void }): React.ReactElement {
  useEffect(() => connectTasks(), []);
  const items = useTasks(s => s.snapshot?.items);
  const { running, waiting } = useMemo(() => summarise(items ?? [], Date.now()), [items]);
  return (
    <button
      onClick={onOpen}
      className={`flex items-center gap-1.5 rounded-md px-2 py-1 text-[12px] transition-colors hover:bg-aico-hover ${running ? 'text-aico-accent' : 'text-aico-muted'}`}
      title="Tasks — what is running and what waits for you"
      aria-label={`Tasks: ${running} running, ${waiting} waiting for you`}
    >
      <Icon name="activity" size={14} />
      <span className="hidden sm:inline">{running ? `${running} running` : 'Tasks'}</span>
      {waiting > 0 && <span className="text-aico-warning">· {waiting}</span>}
    </button>
  );
}

export function TasksDrawer({ open, onClose, onOpenChat, onViewTranscript }: {
  open: boolean;
  onClose: () => void;
  onOpenChat: (sessionId: string) => void;
  onViewTranscript: (transcriptId: string) => void;
}): React.ReactElement | null {
  const snapshot = useTasks(s => s.snapshot);
  const connection = useTasks(s => s.connection);
  const sessionId = useStore(s => s.sessionId);
  const logged = useStore(s => s.logged.size);
  const sessions = useStore(s => s.sessions);
  const titles = useMemo(() => new Map(sessions.map(s => [s.id, s.title || 'New chat'])), [sessions]);
  const [notice, setNotice] = useState<{ kind: string; text: string } | null>(null);

  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 5000);
    return () => clearTimeout(t);
  }, [notice]);

  if (!open) return null;

  const host: TaskActionHost = {
    openChat: (id) => { onOpenChat(id); onClose(); },
    viewTranscript: (id) => { onViewTranscript(id); onClose(); },
    notify: (kind, title, body) => setNotice({ kind, text: body ? `${title} — ${body}` : title }),
  };

  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/20 md:bg-transparent" onClick={onClose} aria-hidden="true" />
      <aside
        className="fixed inset-y-0 right-0 z-50 flex w-full max-w-[440px] flex-col border-l border-aico-border-subtle bg-aico-bg shadow-2xl"
        aria-label="Tasks"
      >
        <div className="min-h-0 flex-1">
          <TasksPanel
            snapshot={snapshot}
            connection={connection}
            {...(logged > 0 ? { sessionId } : {})}
            sessionTitle={(id) => titles.get(id)}
            layout="drawer"
            autoFocus
            onClose={onClose}
            onAction={(action: TaskActionId, item: TaskItem) => runTaskAction(action, item, host)}
            onScheduleAction={(action, s) => runScheduleAction(action, s.id, host)}
          />
        </div>
        {notice && (
          <div role="status" className={`shrink-0 border-t border-aico-border-subtle px-4 py-2 text-[12.5px] ${notice.kind === 'error' ? 'text-aico-danger' : 'text-aico-secondary'}`}>
            {notice.text}
          </div>
        )}
      </aside>
    </>
  );
}
