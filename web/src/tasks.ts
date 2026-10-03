/**
 * The Tasks panel's client half: one live subscription to the engine's
 * `tasks/events` topic, shared by every component that shows tasks, and the
 * one place an action on a task turns into an API call.
 *
 * Shared by the web drawer and the desktop (which imports `@web/*`), so both
 * clients follow the same stream and call the same routes. Reference-counted:
 * the stream is open while anything that shows tasks is mounted — the status
 * bar's count keeps it open in the desktop, the header button in the web.
 *
 * Actions go only to routes that already exist, each with its own human
 * check on the server: approving a parked call or a long job is sent "as a
 * person" (`api.decideParked` / `api.decideLongJob`), allowing a tool call is
 * never offered here at all — it opens the chat, whose prompt is the window
 * the decision gate trusts — and refusing needs nothing. This module cannot
 * make a yes count that the server would not.
 *
 * @module web/tasks
 */

import { create } from 'zustand';
import { api, streamTopic, type StreamHandle } from './api';
import type { TaskActionId, TaskItem, TasksSnapshot } from '../../shared/tasks';

interface TasksState {
  snapshot: TasksSnapshot | null;
  connection: 'connecting' | 'live' | 'lost';
}

export const useTasks = create<TasksState>(() => ({ snapshot: null, connection: 'connecting' }));

let handle: StreamHandle | undefined;
let refs = 0;

/** Follow the engine's task list. Returns the release; the stream closes with the last one. */
export function connectTasks(): () => void {
  refs++;
  if (!handle) {
    handle = streamTopic<TasksSnapshot>('tasks/events', (event) => {
      if ((event.type === 'full' || event.type === 'tasks') && event.data && Array.isArray(event.data.items)) {
        useTasks.setState({ snapshot: event.data });
      }
    }, (connection) => useTasks.setState({ connection }));
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    refs = Math.max(0, refs - 1);
    if (refs === 0 && handle) { handle.close(); handle = undefined; }
  };
}

/** What only the host can do: navigate, and tell the person what happened. */
export interface TaskActionHost {
  openChat: (sessionId: string) => void | Promise<void>;
  viewTranscript: (transcriptId: string, item: TaskItem) => void | Promise<void>;
  notify: (kind: 'success' | 'info' | 'error', title: string, body?: string) => void;
}

function message(r: unknown): string | undefined {
  return r && typeof r === 'object' && 'message' in r && typeof (r as { message: unknown }).message === 'string'
    ? (r as { message: string }).message : undefined;
}

/** Perform one action on one task. Errors become a notification, never a throw. */
export async function runTaskAction(action: TaskActionId, item: TaskItem, host: TaskActionHost): Promise<void> {
  const ref = item.ref ?? {};
  try {
    switch (action) {
      case 'approve': {
        if (ref.inboxId) {
          const r = await api.decideParked(ref.inboxId, 'approve');
          host.notify(r.ok ? 'success' : 'error', r.ok ? 'Approved — the parked call ran' : 'Not approved', r.message);
        } else if (ref.longJobId) {
          const r = await api.decideLongJob(ref.longJobId, 'approve');
          host.notify(r.ok ? 'success' : 'error', r.ok ? 'Long job approved' : 'Not approved', r.message);
        }
        return;
      }
      case 'deny': {
        if (ref.inboxId) {
          const r = await api.decideParked(ref.inboxId, 'deny');
          host.notify('info', 'Denied', r.message);
        } else if (ref.longJobId) {
          const r = await api.decideLongJob(ref.longJobId, 'decline');
          host.notify('info', 'Long job declined', r.message);
        } else if (ref.permissionId && item.sessionId) {
          await api.permit(item.sessionId, ref.permissionId, false);
          host.notify('info', 'Refused', `${item.title.replace(/^Allow /, '').replace(/\?$/, '')} was not allowed.`);
        }
        return;
      }
      case 'review':
      case 'open-chat':
        if (item.sessionId) await host.openChat(item.sessionId);
        return;
      case 'transcript':
        if (item.transcriptId) await host.viewTranscript(item.transcriptId, item);
        return;
      case 'stop': {
        const id = ref.ledgerId ?? item.id;
        const r = await api.stopWork(id, 'Stopped from the Tasks panel');
        host.notify('info', r.stopped || r.state === 'cancelled' ? 'Stopping' : 'Already finished', item.title);
        return;
      }
      case 'pause':
      case 'resume': {
        if (ref.longJobId) {
          const r = await api.controlLongJob(ref.longJobId, action);
          host.notify(r.ok ? 'info' : 'error', r.ok ? (action === 'pause' ? 'Paused' : 'Resumed') : `Could not ${action}`, message(r) ?? item.title);
        }
        return;
      }
      case 'retry': {
        if (!item.sessionId) return;
        const why = item.error ? ` It ended with: ${item.error.slice(0, 300)}` : '';
        const r = await api.followup(item.sessionId, `Retry the delegated task "${item.title}" — it ${item.status === 'stopped' ? 'was stopped' : 'failed'}.${why} Decide whether to run it again as it was or with a corrected brief.`);
        host.notify(r.ok ? 'info' : 'error', r.ok ? 'Asked the chat to retry it' : 'Could not retry', r.ok ? item.title : 'Open the chat first, then retry.');
        return;
      }
      case 'copy-command':
      case 'show':
        return; // the panel (clipboard) or the desktop host (terminal, browser) handles these
    }
  } catch (err) {
    host.notify('error', 'That did not work', (err as Error).message);
  }
}

/** Pause or resume a scheduled job (the cron store, not one firing). */
export async function runScheduleAction(action: 'pause' | 'resume', jobId: string, host: Pick<TaskActionHost, 'notify'>): Promise<void> {
  try {
    await api.cronAction(action, jobId);
    host.notify('info', action === 'pause' ? 'Schedule paused' : 'Schedule resumed');
  } catch (err) {
    host.notify('error', `Could not ${action} it`, (err as Error).message);
  }
}
