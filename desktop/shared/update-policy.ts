/**
 * The updater's decisions, as pure functions: when to check, how an updater
 * event changes what the interface shows, and what the status bar says.
 *
 * WHY. Installed 0.36.0 did not see 0.37.0 for hours although nothing was
 * broken: it checked ten seconds after launch and then on a plain six-hour
 * `setInterval` — process time, which stops while the laptop sleeps — and the
 * release was published 24 minutes before its feed was attached, so a check
 * in that window failed and the next one was six hours away. The only sign of
 * a new version was a toast once the download had finished. Now the schedule
 * is wall-clock (`checkDue`, re-asked on a short tick and on wake), a failed
 * check retries in half an hour, and the status bar carries a badge for as
 * long as an update is waiting (`updateBadge`). Kept free of Electron so the
 * desktop unit tests can run it.
 *
 * Deliberately NOT here: deciding to install. Nothing restarts the app except
 * the user's click, or the ordinary quit after a download (electron-updater's
 * `autoInstallOnAppQuit`, the way VS Code does it).
 *
 * @module desktop/shared/update-policy
 */

import type { UpdateState } from './updates';

/** A full check every six hours of wall-clock time. */
export const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;
/** After a failed check (offline, or a release whose feed is not attached yet). */
export const RETRY_AFTER_ERROR_MS = 30 * 60 * 1000;
/** How often the schedule is re-asked; also what bounds a missed check after sleep. */
export const TICK_MS = 15 * 60 * 1000;

/**
 * Compare two versions `X.Y.Z[-pre]`: negative if a < b, 0 if equal, positive
 * if a > b. A leading `v` is ignored; a pre-release sorts before its release.
 */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string): { nums: number[]; pre: string } => {
    const [main = '', pre = ''] = String(v).trim().replace(/^v/i, '').split('+')[0]!.split(/-(.*)/s);
    return { nums: main.split('.').map(n => Number.parseInt(n, 10) || 0), pre };
  };
  const pa = parse(a); const pb = parse(b);
  for (let i = 0; i < Math.max(pa.nums.length, pb.nums.length, 3); i++) {
    const d = (pa.nums[i] ?? 0) - (pb.nums[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  if (pa.pre === pb.pre) return 0;
  if (!pa.pre) return 1;
  if (!pb.pre) return -1;
  return pa.pre < pb.pre ? -1 : 1;
}

export const isNewer = (candidate: string, current: string): boolean => compareVersions(candidate, current) > 0;

/**
 * Whether a scheduled check is due. `lastAttemptAt` is the last check started
 * (ok or not), `failed` whether it failed. Wall-clock, so a machine that slept
 * through the six hours checks as soon as it wakes and ticks.
 */
export function checkDue(o: { now: number; lastAttemptAt: number; failed: boolean; everyMs?: number; retryMs?: number }): boolean {
  if (!o.lastAttemptAt) return true;
  const since = o.now - o.lastAttemptAt;
  if (since < 0) return true; // the clock went backwards: do not wait for it to catch up
  return since >= (o.failed ? (o.retryMs ?? RETRY_AFTER_ERROR_MS) : (o.everyMs ?? CHECK_EVERY_MS));
}

/** What electron-updater reported, reduced to what the interface needs. */
export type UpdateEvent =
  | { type: 'checking' }
  | { type: 'not-available' }
  | { type: 'available'; version: string; autoDownload: boolean }
  | { type: 'progress'; percent: number; bytesPerSecond: number }
  | { type: 'downloaded'; version: string }
  | { type: 'error'; message: string };

/**
 * The next interface state for an updater event. Two rules the event stream
 * alone gets wrong: a failed background check must not hide a downloaded
 * update's Restart button, and an error after an update was found keeps its
 * version so the fallback ("Download from GitHub") can name it.
 */
export function reduceUpdate(s: UpdateState, e: UpdateEvent): UpdateState {
  const base = { current: s.current, releaseUrl: s.releaseUrl, lastCheckedAt: s.lastCheckedAt };
  switch (e.type) {
    case 'checking':
      if (s.status === 'ready' || s.status === 'waiting' || s.status === 'downloading') return s;
      return { ...base, status: 'checking' };
    case 'not-available':
      return { ...base, status: 'up-to-date' };
    case 'available':
      return { ...base, status: e.autoDownload ? 'downloading' : 'available', version: e.version, ...(e.autoDownload ? { percent: 0 } : {}) };
    case 'progress':
      return { ...s, status: 'downloading', percent: Math.max(0, Math.min(100, Math.round(e.percent))), bytesPerSecond: Math.round(e.bytesPerSecond) };
    case 'downloaded':
      return { ...base, status: 'ready', version: e.version, percent: 100 };
    case 'error':
      if (s.status === 'ready' || s.status === 'waiting') return s;
      return { ...base, status: 'error', message: e.message, ...(s.version && (s.status === 'available' || s.status === 'downloading') ? { version: s.version } : {}) };
  }
}

/** What clicking the status-bar badge does. */
export type BadgeAction = 'install' | 'download' | 'settings' | 'release-page';

/**
 * The status-bar badge while an update is on its way or waiting for the
 * user, or null when there is nothing to say (up to date, checking, a
 * development build). A failed update that had found a version links the
 * release page, so the user is never left with only an error.
 */
export function updateBadge(s: UpdateState | null): { text: string; title: string; action: BadgeAction; tone: 'accent' | 'muted' | 'warning' } | null {
  if (!s) return null;
  const v = s.version ?? '';
  switch (s.status) {
    case 'ready':
      return { text: `Update ${v} — Restart to install`, title: `AICO ${v} is downloaded. Restart now, or it installs the next time you quit.`, action: 'install', tone: 'accent' };
    case 'waiting':
      return { text: `Update ${v} — restarts when idle`, title: 'Restarts to install when the running work finishes. Open Settings to cancel or restart now.', action: 'settings', tone: 'muted' };
    case 'downloading':
      return { text: `Downloading${v ? ` ${v}` : ''} · ${s.percent ?? 0}%`, title: `Downloading AICO ${v} in the background.`, action: 'settings', tone: 'muted' };
    case 'available':
      return { text: `Update ${v} available — Download`, title: `AICO ${v} is available (you are on ${s.current}).`, action: 'download', tone: 'accent' };
    case 'error':
      return s.version
        ? { text: `Update ${v} — Download from GitHub`, title: `${s.message ?? 'The update failed.'} Download it from the release page instead.`, action: 'release-page', tone: 'warning' }
        : null;
    default:
      return null;
  }
}
