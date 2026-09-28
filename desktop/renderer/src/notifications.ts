/**
 * Turning engine events into things you notice: native notifications when
 * the window is not in front, unread dots, the taskbar badge, and the
 * Activity feed.
 *
 * Watches the shared store rather than the event stream directly, so it sees
 * exactly what the interface sees.
 *
 * @module desktop/renderer/notifications
 */

import { useStore } from '@web/store';
import { useDesk } from '@/state/desk';
import { desktop } from '@/desktop';
import { markSeen } from '@/lib/local';
import { openChat } from '@/chat/actions';

let focused = true;

export function installNotifications(): void {
  desktop.win.onFocus((f) => { focused = f; if (f) void desktop.badge(0); });
  desktop.onNotificationClick((data) => {
    const d = data as { sessionId?: string; view?: string } | null;
    if (d?.sessionId) void openChat(d.sessionId);
    else if (d?.view) useDesk.getState().navigate({ view: d.view });
  });

  let unseen = 0;
  const bump = (): void => { if (!focused) { unseen += 1; void desktop.badge(unseen); } };
  desktop.win.onFocus((f) => { if (f) unseen = 0; });

  useStore.subscribe((state, prev) => {
    const prefs = useDesk.getState().prefs.notifications;
    const title = state.title || 'Your chat';

    // A turn in the open chat finished.
    if (prev.busy && !state.busy && state.sessionId === prev.sessionId) {
      const failed = Boolean(state.error);
      useDesk.getState().upsertActivity({ id: `turn:${state.sessionId}`, kind: 'turn', title, status: failed ? 'failed' : 'done', startedAt: prev.turnStartedAt ?? Date.now(), endedAt: Date.now(), route: { view: 'chat', params: { id: state.sessionId } } });
      if (prefs.turnEnd && !focused) {
        void desktop.notify({ title: failed ? `${title} — stopped` : title, body: failed ? (state.error ?? 'The turn failed.') : 'The reply is ready.', data: { sessionId: state.sessionId }, onlyWhenUnfocused: true });
        bump();
      }
    }
    if (!prev.busy && state.busy) {
      useDesk.getState().upsertActivity({ id: `turn:${state.sessionId}`, kind: 'turn', title, status: 'running', startedAt: Date.now(), route: { view: 'chat', params: { id: state.sessionId } } });
    }

    // The agent needs you.
    if (prefs.attention && !focused) {
      if (state.permission && state.permission.id !== prev.permission?.id) {
        void desktop.notify({ title: `${title} needs permission`, body: `${state.permission.tool}: ${state.permission.detail.slice(0, 140)}`, data: { sessionId: state.sessionId }, onlyWhenUnfocused: true });
        bump();
      }
      if (state.question && state.question !== prev.question) {
        void desktop.notify({ title: `${title} has a question`, body: state.question.slice(0, 180), data: { sessionId: state.sessionId }, onlyWhenUnfocused: true });
        bump();
      }
    }

    // Chats finishing in the background (not the open one) become unread.
    if (state.sessions !== prev.sessions) {
      const was = new Map(prev.sessions.map(s => [s.id, s.running]));
      for (const s of state.sessions) {
        if (was.get(s.id) && !s.running && s.id !== state.sessionId) {
          markSeen(s.id, 0);
          if (prefs.background && !focused) {
            void desktop.notify({ title: s.title || 'A chat', body: 'Finished in the background.', data: { sessionId: s.id }, onlyWhenUnfocused: true });
            bump();
          }
        }
      }
    }
  });
}
