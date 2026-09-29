/**
 * What the updater tells the interface. Shared by main (electron/updater.ts)
 * and the renderer (Settings → Application → Updates, and the ready toast).
 *
 * @module desktop/shared/updates
 */

export type UpdateStatus =
  /** A development build, or a Linux install the updater cannot replace (offer the release page). */
  | 'unsupported'
  | 'idle'
  | 'checking'
  | 'up-to-date'
  /** Found, not downloaded (automatic updates are off). */
  | 'available'
  | 'downloading'
  /** Downloaded; installs on restart (or on the next normal quit). */
  | 'ready'
  /** Ready, and waiting for running work to finish before restarting. */
  | 'waiting'
  | 'error';

export interface UpdateState {
  status: UpdateStatus;
  /** The running app's version. */
  current: string;
  /** The version found / downloading / ready. */
  version?: string;
  /** 0–100 while downloading. */
  percent?: number;
  bytesPerSecond?: number;
  /** Why it is unsupported, or what went wrong. */
  message?: string;
  /** Epoch ms of the last completed check (persisted in prefs). */
  lastCheckedAt?: number;
  /** While waiting: what is still running. */
  busy?: string[];
  /** Where to download by hand. */
  releaseUrl: string;
}

export const RELEASES_URL = 'https://github.com/suhail-akhtar/aico/releases/latest';
