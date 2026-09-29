/**
 * Backup and restore, for moving AICO to another machine: the dialogs, the
 * engine stop/start around a restore, and the IPC. What goes into a backup
 * and how a restore avoids losing anything is in backup-core.ts.
 *
 * A restore stops the engine first (nothing may write a session log while it
 * is replaced), reloads the desktop prefs from the restored file (keeping
 * this machine's window position), starts the engine again, and reloads the
 * window so every view reads the restored state.
 *
 * @module desktop/electron/backup
 */

import { app, dialog } from 'electron';
import path from 'node:path';
import type { DesktopContext } from './context';
import { applyPowerPrefs } from './core-ipc';
import { engineBusy } from './engine-busy';
import { exportBackup, readBackup, restoreBackup, type BackupPreview } from './backup-core';

declare const __AICO_VERSION__: string;
declare const __DESKTOP_VERSION__: string;

export interface ExportOptions {
  includeApiKeys?: boolean;
  includeChats?: boolean;
  /** Write here instead of asking (scripts and tests); the interface leaves it out. */
  file?: string;
}

const meta = (): { app: string; engine: string } => ({ app: __DESKTOP_VERSION__, engine: __AICO_VERSION__ });

export function registerBackup(ctx: DesktopContext): void {
  const home = ctx.paths.aicoHome;

  ctx.handle('backup:export', async (opts?: ExportOptions) => {
    let file = opts?.file;
    if (!file) {
      const w = ctx.window();
      const day = new Date().toISOString().slice(0, 10);
      const o: Electron.SaveDialogOptions = {
        title: 'Export an AICO backup',
        defaultPath: path.join(app.getPath('documents'), `aico-backup-${day}.zip`),
        filters: [{ name: 'AICO backup', extensions: ['zip'] }],
      };
      const r = w ? await dialog.showSaveDialog(w, o) : await dialog.showSaveDialog(o);
      if (r.canceled || !r.filePath) return null;
      file = r.filePath;
    }
    ctx.prefs.flush(); // the prefs on disk are the prefs you see
    const out = await exportBackup(home, file, { includeApiKeys: opts?.includeApiKeys, includeChats: opts?.includeChats }, meta());
    return { file: out.file, files: out.files, bytes: out.bytes, manifest: out.manifest };
  });

  /** Pick a backup and describe it — nothing is changed until `backup:import`. */
  ctx.handle('backup:pick', async (): Promise<(BackupPreview & { busy: string[] }) | null> => {
    const w = ctx.window();
    const o: Electron.OpenDialogOptions = {
      title: 'Restore an AICO backup',
      properties: ['openFile'],
      filters: [{ name: 'AICO backup', extensions: ['zip'] }],
    };
    const r = w ? await dialog.showOpenDialog(w, o) : await dialog.showOpenDialog(o);
    if (r.canceled || !r.filePaths[0]) return null;
    return { ...(await readBackup(r.filePaths[0])), busy: await engineBusy(ctx.engine) };
  });

  ctx.handle('backup:preview', async (file: string) => ({ ...(await readBackup(file)), busy: await engineBusy(ctx.engine) }));

  let restoring = false;
  ctx.handle('backup:import', async (file: string) => {
    if (!file) throw new Error('Choose a backup to restore.');
    if (restoring) throw new Error('A restore is already running.');
    restoring = true;
    const keepWindow = ctx.prefs.get().window;
    ctx.prefs.flush();
    await ctx.engine.stop(false);
    try {
      const out = await restoreBackup(home, file, meta());
      ctx.prefs.reload();
      ctx.prefs.set({ window: keepWindow });
      applyPowerPrefs(ctx);
      // After the reply has gone back, so the interface can say what happened first.
      setTimeout(() => {
        const w = ctx.window();
        if (w && !w.isDestroyed()) w.webContents.reload();
      }, 1500);
      return { restored: out.restored, safetyCopy: out.safetyCopy, keptKeys: out.keptKeys };
    } finally {
      restoring = false;
      ctx.engine.start();
    }
  });
}
