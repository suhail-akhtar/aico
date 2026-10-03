/**
 * Updates from GitHub releases (electron-updater), without losing work.
 *
 * WHEN IT RUNS. Only in a packaged build, and only where the installer can be
 * replaced: the Windows NSIS install, a Linux AppImage, and (best effort) the
 * deb, which installs through `pkexec dpkg`. Anything else — a development
 * run, an unpacked folder — reports `unsupported` and the interface offers
 * the release page instead.
 *
 * It checks ten seconds after start and then whenever `checkDue` says so —
 * six hours of WALL-CLOCK time since the last check (half an hour after a
 * failed one), asked every 15 minutes and on wake from sleep. Until 0.37.x it
 * used a bare six-hour `setInterval`, which counts process time: a laptop that
 * slept went far longer between checks, and a check that failed (0.37.0 was
 * published before its latest.yml was attached) waited six more hours. The
 * checking always runs; the "Download updates automatically" setting (on by
 * default) only decides whether a found update downloads by itself or waits
 * for a Download click. Either way the status bar shows a badge, a toast
 * says so, and a downloaded update installs on Restart or on the next
 * ordinary quit (`autoInstallOnAppQuit`, like VS Code) — never on its own.
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

import { app, dialog, Notification, powerMonitor } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import type { AppUpdater, ProgressInfo, UpdateInfo } from 'electron-updater';
import type { DesktopContext } from './context';
import { engineBusy } from './engine-busy';
import { RELEASES_URL, type UpdateState } from '../shared/updates';
import { checkDue, reduceUpdate, TICK_MS, type UpdateEvent } from '../shared/update-policy';

declare const __DESKTOP_VERSION__: string;

const FIRST_CHECK_MS = 10_000;
const AFTER_WAKE_MS = 30_000;
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
  let waitTimer: NodeJS.Timeout | null = null;
  let notifiedVersion: string | null = null;
  let installing = false;
  // When the last check started and whether it failed: the wall-clock schedule (checkDue).
  let lastAttemptAt = 0;
  let lastFailed = false;

  const set = (patch: Partial<UpdateState>, replace = false): void => {
    state = replace
      ? { current, releaseUrl: RELEASES_URL, lastCheckedAt: state.lastCheckedAt, ...patch } as UpdateState
      : { ...state, ...patch };
    ctx.emit('updates:state', state);
  };
  const apply = (e: UpdateEvent): void => {
    if (e.type === 'error') lastFailed = true;
    state = reduceUpdate(state, e);
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
      // The transitions (and the rule that a failed check never hides Restart) are reduceUpdate's.
      u.on('checking-for-update', () => apply({ type: 'checking' }));
      u.on('update-not-available', () => { markChecked(); apply({ type: 'not-available' }); });
      u.on('update-available', (info: UpdateInfo) => {
        markChecked();
        apply({ type: 'available', version: info.version, autoDownload: u.autoDownload });
        if (!u.autoDownload) announce(info.version, 'available');
      });
      u.on('download-progress', (p: ProgressInfo) => apply({ type: 'progress', percent: p.percent, bytesPerSecond: p.bytesPerSecond }));
      u.on('update-downloaded', (info: UpdateInfo) => {
        apply({ type: 'downloaded', version: info.version });
        announce(info.version, 'ready');
      });
      u.on('error', (err: Error) => apply({ type: 'error', message: cleanError(err) }));
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

  /** A native notification once per version and stage, only while AICO is not in front (the badge and toast cover that). */
  const announce = (version: string, stage: 'available' | 'ready'): void => {
    if (notifiedVersion === `${stage}:${version}`) return;
    notifiedVersion = `${stage}:${version}`;
    const w = ctx.window();
    if (Notification.isSupported() && !(w && w.isFocused() && w.isVisible())) {
      const n = stage === 'ready'
        ? new Notification({ title: `AICO ${version} is ready`, body: 'Restart to update — or it installs the next time you quit.', silent: true })
        : new Notification({ title: `AICO ${version} is available`, body: 'Open AICO to download it.', silent: true });
      n.on('click', () => ctx.reveal());
      n.show();
    }
  };

  const check = async (): Promise<UpdateState> => {
    const u = await load();
    if (!u) return state;
    if (state.status === 'downloading' || state.status === 'ready' || state.status === 'waiting') return state;
    u.autoDownload = enabled();
    lastAttemptAt = Date.now();
    lastFailed = false; // the 'error' event (or the catch) sets it again
    try {
      await u.checkForUpdates();
    } catch (err) {
      apply({ type: 'error', message: cleanError(err as Error) });
    }
    return state;
  };

  const download = async (): Promise<UpdateState> => {
    const u = await load();
    if (!u) return state;
    if (state.status !== 'available') return state;
    set({ status: 'downloading', percent: 0 });
    try { await u.downloadUpdate(); } catch (err) { apply({ type: 'error', message: cleanError(err as Error) }); }
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

  /** Check if the wall-clock schedule says so (after a sleep, the first tick or the wake event catches up). */
  const tick = (): void => {
    if (checkDue({ now: Date.now(), lastAttemptAt, failed: lastFailed })) void check();
  };

  // Checking always runs where updates are possible; the setting only decides
  // whether a found update downloads by itself (see the module header).
  const schedule = (): void => {
    if (!supported.ok) return;
    setTimeout(() => { void check(); }, FIRST_CHECK_MS).unref();
    setInterval(tick, TICK_MS).unref();
    powerMonitor.on('resume', () => { setTimeout(tick, AFTER_WAKE_MS).unref(); });
  };

  let wasEnabled = enabled();
  ctx.prefs.on('change', () => {
    const now = enabled();
    if (now === wasEnabled) return;
    wasEnabled = now;
    if (updater) updater.autoDownload = now;
    // Turned on while an update was waiting for a Download click: fetch it now.
    if (now && state.status === 'available') void download();
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
