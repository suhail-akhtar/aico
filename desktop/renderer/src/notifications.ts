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
import { api } from '@web/api';
import { newlyPending, originLabel, type ParkedAction } from '@web/inbox';
import { freshNotices } from '@web/brief';
import { toast, useDesk } from '@/state/desk';
import { desktop } from '@/desktop';
import { markSeen } from '@/lib/local';
import { openChat } from '@/chat/actions';

let focused = true;

export function installNotifications(): void {
  desktop.win.onFocus((f) => { focused = f; if (f) void desktop.badge(0); });
  desktop.onNotificationClick((data) => {
    const d = data as { sessionId?: string; view?: string } | null;
    if (d?.sessionId) void openChat(d.sessionId);
    else if (d?.view) {
      // Home is an empty chat: the brief card lives there, under a fresh composer.
      if (d.view === 'home' && useStore.getState().logged.size > 0) useStore.getState().newSession();
      useDesk.getState().navigate({ view: d.view });
    }
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

  watchInbox(bump);
  watchBrief(bump);
}

/**
 * A call an unattended run parked for you (the approve-later inbox, Phase 7).
 * Polled, because parking happens in schedules and background jobs that no
 * open chat streams; a native notification when the window is behind, a
 * toast when it is in front. Clicking either opens "Waiting for you".
 */
function watchInbox(bump: () => void): void {
  let last: ParkedAction[] | undefined;
  const poll = async (): Promise<void> => {
    try {
      const { actions } = await api.inbox('pending');
      const fresh = last ? newlyPending(last, actions) : [];
      last = actions;
      if (!useDesk.getState().prefs.notifications.attention) return;
      for (const a of fresh.slice(0, 3)) {
        const title = `Waiting for you: ${a.tool}`;
        const body = `${originLabel(a)} — ${a.why}`;
        if (focused) toast.warning(title, body);
        else { void desktop.notify({ title, body, data: { view: 'inbox' }, onlyWhenUnfocused: true }); bump(); }
      }
    } catch { /* the engine is starting or restarting; the next poll catches up */ }
  };
  void poll();
  setInterval(() => void poll(), 30_000);
}

/**
 * The morning brief and the monitors (engine: brief/). Polled like the inbox:
 * the brief is made by a timer in the engine, not in any chat. A new brief is
 * announced once (unless the engine says it is quiet hours or the brief's
 * notification is off); a monitor alert as soon as the engine releases it —
 * held alerts arrive when quiet hours end. Both obey the Background work
 * switch. The first poll is a baseline, so starting the app announces only a
 * brief made in the last few minutes.
 */
function watchBrief(bump: () => void): void {
  let lastBrief: string | undefined;
  let lastNotice = 0;
  let first = true;
  const poll = async (): Promise<void> => {
    try {
      const r = await api.brief();
      const enabled = useDesk.getState().prefs.notifications.background;
      const b = r.brief;
      const isNew = b && b.id !== lastBrief && (!first || Date.now() - b.createdAt < 5 * 60_000);
      if (b) lastBrief = b.id;
      const notices = first ? [] : freshNotices(r.notices, lastNotice);
      for (const n of r.notices) lastNotice = Math.max(lastNotice, n.releasedAt ?? 0);
      first = false;
      if (!enabled) return;
      if (isNew && r.settings.notify && !r.quietNow) {
        const urgent = b.items.filter(i => i.urgency === 'urgent').length;
        const title = urgent ? `Your brief: ${urgent} urgent` : 'Your brief is ready';
        if (focused) toast.info(title, b.summary);
        else { void desktop.notify({ title, body: b.summary.slice(0, 180), data: { view: 'home' }, onlyWhenUnfocused: true }); bump(); }
      }
      for (const n of notices.slice(0, 3)) {
        if (focused) toast.warning(n.title, n.body);
        else { void desktop.notify({ title: n.title, body: n.body.slice(0, 180), data: { view: 'home' }, onlyWhenUnfocused: true }); bump(); }
      }
    } catch { /* the engine is starting or restarting, or predates the brief; the next poll catches up */ }
  };
  void poll();
  setInterval(() => void poll(), 60_000);
}
