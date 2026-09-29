/**
 * Updates from GitHub releases (electron-updater), without losing work.
 *
 * WHEN IT RUNS. Only in a packaged build, and only where the installer can be
 * replaced: the Windows NSIS install, a Linux AppImage, and (best effort) the
 * deb, which installs through `pkexec dpkg`. Anything else — a development
 * run, an unpacked folder — reports `unsupported` and the interface offers
 * the release page instead.
 *
 * With automatic updates on, it checks ten seconds after start and every six
 * hours, downloads what it finds, and says so: a native notification and a
 * toast with Restart. A downloaded update also installs on the next ordinary
 * quit (`autoInstallOnAppQuit`), so ignoring the toast is fine.
 *
 * NOT LOSING WORK. Restarting stops the engine, and with it any reply still
 * streaming and any background agent mid-task. So Restart first asks the
 * engine what is in flight (engine-busy.ts). Idle: install now. Busy: the
 * choice is "Restart when it finishes" — poll until idle, then install — or
 * "Restart now". Chats and settings are on disk either way. The engine is
 * stopped cleanly before the installer is launched, and the app relaunches
 * after the install.
 *
 * UNSIGNED BUILDS. No `publisherName` is configured, so the NSIS updater does
 * not demand an Authenticode signature (it only verifies when one is named).
 * Integrity still comes from the sha512 in `latest.yml`.
 *
 * @module desktop/electron/updater
 */

import { app, dialog, Notification } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import type { AppUpdater, ProgressInfo, UpdateInfo } from 'electron-updater';
import type { DesktopContext } from './context';
import { engineBusy } from './engine-busy';
import { RELEASES_URL, type UpdateState } from '../shared/updates';

declare const __DESKTOP_VERSION__: string;

const FIRST_CHECK_MS = 10_000;
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;
const IDLE_POLL_MS = 5_000;

/** Whether this install can update itself, and if not, why. */
function support(): { ok: true; kind: 'nsis' | 'appimage' | 'deb' } | { ok: false; reason: string } {
  if (!app.isPackaged) return { ok: false, reason: 'This is a development build; updates apply to installed copies.' };
  if (process.platform === 'win32') return { ok: true, kind: 'nsis' };
  if (process.platform === 'linux') {
    if (process.env.APPIMAGE) return { ok: true, kind: 'appimage' };
    try {
      const type = fs.readFileSync(path.join(process.resourcesPath, 'package-type'), 'utf8').trim();
      if (type === 'deb') return { ok: true, kind: 'deb' };
    } catch { /* not installed from a package */ }
    return { ok: false, reason: 'This copy of AICO cannot update itself. Download the new version from the release page.' };
  }
  return { ok: false, reason: 'Automatic updates are not available on this platform.' };
}

export function registerUpdater(ctx: DesktopContext): void {
  const current = __DESKTOP_VERSION__;
  let state: UpdateState = { status: 'idle', current, releaseUrl: RELEASES_URL, lastCheckedAt: ctx.prefs.get().autoUpdate.lastCheckedAt || undefined };
  let updater: AppUpdater | null = null;
  let loading: Promise<AppUpdater | null> | null = null;
  let firstTimer: NodeJS.Timeout | null = null;
  let everyTimer: NodeJS.Timeout | null = null;
  let waitTimer: NodeJS.Timeout | null = null;
  let notifiedVersion: string | null = null;
  let installing = false;

  const set = (patch: Partial<UpdateState>, replace = false): void => {
    state = replace
      ? { current, releaseUrl: RELEASES_URL, lastCheckedAt: state.lastCheckedAt, ...patch } as UpdateState
      : { ...state, ...patch };
    ctx.emit('updates:state', state);
  };

  const supported = support();
  if (!supported.ok) state = { ...state, status: 'unsupported', message: supported.reason };

  const enabled = (): boolean => ctx.prefs.get().autoUpdate.enabled;

  /** Loaded lazily: a development run never touches electron-updater at all. */
  const load = (): Promise<AppUpdater | null> => {
    if (!supported.ok) return Promise.resolve(null);
    if (updater) return Promise.resolve(updater);
    // `require`, not `import()`: esbuild keeps a dynamic import as a real ESM
    // import, and Node cannot see electron-updater's getter-defined
    // `autoUpdater` as a named export of a CommonJS module — it came back
    // undefined in the packaged build.
    loading ??= Promise.resolve().then(() => {
      const mod = require('electron-updater') as typeof import('electron-updater');
      const u = mod.autoUpdater;
      u.autoDownload = enabled();
      u.autoInstallOnAppQuit = true;
      u.allowPrerelease = false;
      u.logger = { info: () => {}, warn: (m: unknown) => console.warn('[updater]', m), error: (m: unknown) => console.error('[updater]', m), debug: () => {} };
      u.on('checking-for-update', () => set({ status: 'checking', message: undefined }));
      u.on('update-not-available', () => { markChecked(); set({ status: 'up-to-date', version: undefined, percent: undefined }, true); });
      u.on('update-available', (info: UpdateInfo) => {
        markChecked();
        set({ status: u.autoDownload ? 'downloading' : 'available', version: info.version, percent: 0 }, true);
      });
      u.on('download-progress', (p: ProgressInfo) => {
        set({ status: 'downloading', percent: Math.round(p.percent), bytesPerSecond: Math.round(p.bytesPerSecond) });
      });
      u.on('update-downloaded', (info: UpdateInfo) => {
        set({ status: 'ready', version: info.version, percent: 100 }, true);
        announceReady(info.version);
      });
      u.on('error', (err: Error) => {
        // A failed check while something is already downloaded must not hide the Restart button.
        if (state.status === 'ready' || state.status === 'waiting') return;
        set({ status: 'error', message: cleanError(err) }, true);
      });
      updater = u;
      return u;
    }).catch((err: Error) => {
      set({ status: 'unsupported', message: `The updater could not load: ${err.message}` }, true);
      return null;
    });
    return loading;
  };

  const markChecked = (): void => {
    const at = Date.now();
    state = { ...state, lastCheckedAt: at };
    ctx.prefs.set({ autoUpdate: { ...ctx.prefs.get().autoUpdate, lastCheckedAt: at } });
  };

  const announceReady = (version: string): void => {
    if (notifiedVersion === version) return;
    notifiedVersion = version;
    const w = ctx.window();
    if (Notification.isSupported() && !(w && w.isFocused() && w.isVisible())) {
      const n = new Notification({ title: `AICO ${version} is ready`, body: 'Restart to update — or it installs the next time you quit.', silent: true });
      n.on('click', () => ctx.reveal());
      n.show();
    }
  };

  const check = async (): Promise<UpdateState> => {
    const u = await load();
    if (!u) return state;
    if (state.status === 'downloading' || state.status === 'ready' || state.status === 'waiting') return state;
    u.autoDownload = enabled();
    try {
      await u.checkForUpdates();
    } catch (err) {
      set({ status: 'error', message: cleanError(err as Error) }, true);
    }
    return state;
  };

  const download = async (): Promise<UpdateState> => {
    const u = await load();
    if (!u) return state;
    if (state.status !== 'available') return state;
    set({ status: 'downloading', percent: 0 });
    try { await u.downloadUpdate(); } catch (err) { set({ status: 'error', message: cleanError(err as Error) }, true); }
    return state;
  };

  const installNow = async (): Promise<void> => {
    if (installing || !updater) return;
    installing = true;
    if (waitTimer) { clearInterval(waitTimer); waitTimer = null; }
    set({ status: 'ready', busy: undefined, message: 'Restarting to install…' });
    ctx.prefs.flush();
    // Stop the engine ourselves, cleanly, before the installer starts replacing
    // files. Not a final stop: if the installer fails to launch, it comes back.
    await ctx.engine.stop(false).catch(() => {});
    const recover = (message: string): void => {
      installing = false;
      set({ status: 'error', message }, true);
      ctx.engine.start();
    };
    try {
      updater.quitAndInstall(true, true);
      // quitAndInstall reports a failed launch as an 'error' event, not a throw;
      // if the app is still here a while later, the install did not start.
      setTimeout(() => { if (installing) recover('The update installer did not start. Try again, or download it from the release page.'); }, 20_000).unref();
    } catch (err) {
      recover(cleanError(err as Error));
    }
  };

  const waitForIdle = (busy: string[]): void => {
    set({ status: 'waiting', busy });
    if (waitTimer) return;
    waitTimer = setInterval(() => {
      void engineBusy(ctx.engine).then((now) => {
        if (state.status !== 'waiting') return;
        if (now.length === 0) void installNow();
        else set({ busy: now });
      });
    }, IDLE_POLL_MS);
  };

  const cancelWait = (): UpdateState => {
    if (waitTimer) { clearInterval(waitTimer); waitTimer = null; }
    if (state.status === 'waiting') set({ status: 'ready', busy: undefined });
    return state;
  };

  /**
   * Restart to install. `mode`: 'now' installs regardless; 'when-idle' waits
   * for running work; 'ask' (the default) installs if idle and otherwise asks.
   */
  const install = async (mode: 'ask' | 'now' | 'when-idle' = 'ask'): Promise<UpdateState> => {
    if (state.status !== 'ready' && state.status !== 'waiting') return state;
    if (mode === 'now') { await installNow(); return state; }
    const busy = await engineBusy(ctx.engine);
    if (busy.length === 0) { await installNow(); return state; }
    if (mode === 'when-idle') { waitForIdle(busy); return state; }
    const w = ctx.window();
    const opts: Electron.MessageBoxOptions = {
      type: 'question',
      title: 'Restart to update',
      message: `AICO ${state.version ?? ''} is ready, but work is still running.`,
      detail: `${busy.slice(0, 6).join('\n')}${busy.length > 6 ? `\n…and ${busy.length - 6} more` : ''}\n\nRestarting now stops it. Your chats and settings are kept either way.`,
      buttons: ['Restart when it finishes', 'Restart now', 'Cancel'],
      defaultId: 0, cancelId: 2, noLink: true,
    };
    const r = w ? await dialog.showMessageBox(w, opts) : await dialog.showMessageBox(opts);
    if (r.response === 0) waitForIdle(busy);
    else if (r.response === 1) await installNow();
    return state;
  };

  const schedule = (): void => {
    if (firstTimer) { clearTimeout(firstTimer); firstTimer = null; }
    if (everyTimer) { clearInterval(everyTimer); everyTimer = null; }
    if (!supported.ok || !enabled()) return;
    firstTimer = setTimeout(() => { firstTimer = null; void check(); }, FIRST_CHECK_MS);
    everyTimer = setInterval(() => { void check(); }, CHECK_EVERY_MS);
  };

  let wasEnabled = enabled();
  ctx.prefs.on('change', () => {
    const now = enabled();
    if (now === wasEnabled) return;
    wasEnabled = now;
    if (updater) updater.autoDownload = now;
    schedule();
  });
  schedule();

  ctx.handle('updates:state', () => state);
  ctx.handle('updates:check', () => check());
  ctx.handle('updates:download', () => download());
  ctx.handle('updates:install', (mode?: 'ask' | 'now' | 'when-idle') => install(mode));
  ctx.handle('updates:cancelWait', () => cancelWait());
}

/** electron-updater's errors carry whole HTTP bodies; keep the sentence a person can act on. */
function cleanError(err: Error): string {
  const msg = String(err?.message ?? err);
  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|net::ERR_/i.test(msg)) return 'Could not reach GitHub to check for updates.';
  if (/404/.test(msg) && /latest.*\.yml/i.test(msg)) return 'The latest release has no update information yet.';
  return msg.split('\n')[0]!.slice(0, 240);
}
