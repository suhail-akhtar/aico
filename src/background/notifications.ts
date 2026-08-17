import { runHooks } from '../hooks.js';
import type { AicoSettings } from '../settings.js';

export interface Notification {
  id: string;
  title: string;
  body: string;
  level: 'info' | 'success' | 'warning' | 'error';
  createdAt: number;
  read: boolean;
  /** Agent or job ID that generated this notification */
  sourceId?: string;
}

const MAX_NOTIFICATIONS = 50;
const _notifications: Notification[] = [];
let _notifId = 1;
const _subscribers: Array<(notifications: Notification[]) => void> = [];
let _hookSettings: AicoSettings | undefined;

export function setNotificationHookSettings(settings: AicoSettings | undefined): void {
  _hookSettings = settings;
}

function _emit(): void {
  const snapshot = [..._notifications];
  for (const fn of _subscribers) fn(snapshot);
}

export function pushNotification(opts: {
  title: string;
  body: string;
  level?: Notification['level'];
  sourceId?: string;
}): Notification {
  const notif: Notification = {
    id: `notif-${_notifId++}`,
    title: opts.title,
    body: opts.body,
    level: opts.level ?? 'info',
    createdAt: Date.now(),
    read: false,
    sourceId: opts.sourceId,
  };

  _notifications.unshift(notif);
  if (_notifications.length > MAX_NOTIFICATIONS) {
    _notifications.length = MAX_NOTIFICATIONS;
  }

  _emit();
  if (_hookSettings) {
    runHooks('Notification', {
      event: 'Notification',
      notificationTitle: notif.title,
      notificationBody: notif.body,
      notificationLevel: notif.level,
      agentId: notif.sourceId,
    }, _hookSettings).catch(() => {});
  }
  return notif;
}

export function markNotificationRead(id: string): void {
  const notif = _notifications.find((n) => n.id === id);
  if (notif) { notif.read = true; _emit(); }
}

export function markAllRead(): void {
  for (const n of _notifications) n.read = true;
  _emit();
}

export function getUnreadCount(): number {
  return _notifications.filter((n) => !n.read).length;
}

export function subscribeToNotifications(fn: (notifications: Notification[]) => void): () => void {
  _subscribers.push(fn);
  fn([..._notifications]);
  return () => {
    const idx = _subscribers.indexOf(fn);
    if (idx !== -1) _subscribers.splice(idx, 1);
  };
}

// ── Tool definitions ──────────────────────────────────────────────────

export const pushNotificationToolDefinition = {
  name: 'PushNotification',
  description: 'Push a notification to the user. Use this to alert the user about important events, completions, or errors from background agents.',
  inputSchema: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Short notification title' },
      body: { type: 'string', description: 'Notification body text' },
      level: {
        type: 'string',
        enum: ['info', 'success', 'warning', 'error'],
        description: 'Notification level (default: info)',
      },
    },
    required: ['title', 'body'],
  },
};

export function executePushNotification(args: {
  title: string;
  body: string;
  level?: Notification['level'];
}): { id: string; message: string } {
  const notif = pushNotification({ title: args.title, body: args.body, level: args.level });
  return { id: notif.id, message: 'Notification sent.' };
}
