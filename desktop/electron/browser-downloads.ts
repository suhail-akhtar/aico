/**
 * The built-in browser's downloads: saved to the user's Downloads folder under
 * a name that never overwrites anything, listed with live progress, and — when
 * the agent started one — always visible in the list. An executable the agent
 * downloads is paused until the user confirms it.
 *
 * @module desktop/electron/browser-downloads
 */

import { app, shell, type DownloadItem as ElectronDownload, type Session, type WebContents } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import type { DesktopContext } from './context';
import type { ConfirmRequest, DownloadItem } from '../shared/browser-types';
import { isExecutableName, uniqueName } from './browser-safety';
import { JsonFile, asArray } from './browser-store';

export interface DownloadsHooks {
  /** Did the agent (not the person) cause this download? */
  byAgent(wc: WebContents | undefined): boolean;
  /** Ask the user; resolves true to allow. */
  confirm(req: Omit<ConfirmRequest, 'id'>): Promise<boolean>;
  /** Tell the rest of the browser a download started (for action results). */
  started?(item: DownloadItem, wc: WebContents | undefined): void;
}

export interface Downloads {
  attach(ses: Session): void;
  list(): DownloadItem[];
  open(id: string): Promise<void>;
  show(id: string): void;
  cancel(id: string): void;
  retry(id: string): void;
  clear(): void;
  flush(): void;
}

export function createDownloads(ctx: DesktopContext, hooks: DownloadsHooks): Downloads {
  const file = new JsonFile<DownloadItem[]>(path.join(ctx.paths.desktopDir, 'browser', 'downloads.json'), [], (raw) => asArray<DownloadItem>(raw)
    // A download in flight when the app closed did not finish.
    .map(d => (d.state === 'progressing' || d.state === 'awaiting-confirmation' ? { ...d, state: 'interrupted' as const } : d)));
  const live = new Map<string, { item: ElectronDownload; wc?: WebContents }>();
  let seq = 0;
  let session: Session | null = null;
  const lastEmit = new Map<string, number>();

  const items = (): DownloadItem[] => file.get();
  const update = (id: string, patch: Partial<DownloadItem>, force = false): void => {
    const next = items().map(d => (d.id === id ? { ...d, ...patch } : d));
    file.set(next);
    const d = next.find(x => x.id === id);
    if (!d) return;
    const now = Date.now();
    if (!force && now - (lastEmit.get(id) ?? 0) < 200) return;
    lastEmit.set(id, now);
    ctx.emit('browser:download', { ...d, file: d.path });
  };

  const downloadsDir = (): string => {
    try { return app.getPath('downloads'); } catch { return path.join(ctx.paths.desktopDir, 'browser', 'downloads'); }
  };

  const attach = (ses: Session): void => {
    session = ses;
    ses.on('will-download', (_e, item, wc) => {
      const dir = downloadsDir();
      fs.mkdirSync(dir, { recursive: true });
      // Names already taken on disk or by another download in flight.
      const taken = new Set(items().filter(d => d.state === 'progressing' || d.state === 'awaiting-confirmation').map(d => path.basename(d.path).toLowerCase()));
      const name = uniqueName(item.getFilename(), n => taken.has(n.toLowerCase()) || fs.existsSync(path.join(dir, n)));
      const savePath = path.join(dir, name);
      item.setSavePath(savePath);
      const id = `d${Date.now().toString(36)}${++seq}`;
      const byAgent = hooks.byAgent(wc);
      const needsOk = byAgent && isExecutableName(name);
      const entry: DownloadItem = {
        id, url: item.getURL(), filename: name, path: savePath,
        state: needsOk ? 'awaiting-confirmation' : 'progressing',
        received: 0, total: item.getTotalBytes(), startedAt: Date.now(), byAgent,
      };
      live.set(id, { item, wc });
      file.set([entry, ...items()].slice(0, 300));
      ctx.emit('browser:download', { ...entry, file: entry.path });
      hooks.started?.(entry, wc);
      if (needsOk) {
        item.pause();
        let origin = '';
        try { origin = wc ? new URL(wc.getURL()).origin : new URL(entry.url).origin; } catch { /* no origin */ }
        void hooks.confirm({
          kind: 'download', origin,
          title: `Allow the agent to download ${name}?`,
          detail: `The agent started downloading a program file (${name}) from ${origin || entry.url}. Programs can harm your computer; allow it only if you expected it. It will be saved to ${dir}.`,
          files: [name],
        }).then((ok) => {
          if (item.getState() !== 'progressing') return;
          if (ok) { item.resume(); update(id, { state: 'progressing' }, true); } else { item.cancel(); }
        });
      }
      item.on('updated', (_ev, state) => {
        const cur = items().find(d => d.id === id);
        if (cur?.state === 'awaiting-confirmation' && item.isPaused()) return;
        update(id, { state: state === 'interrupted' ? 'interrupted' : 'progressing', received: item.getReceivedBytes(), total: item.getTotalBytes() });
      });
      item.once('done', (_ev, state) => {
        live.delete(id);
        update(id, { state, received: item.getReceivedBytes(), total: item.getTotalBytes() || item.getReceivedBytes() }, true);
        file.flush();
      });
    });
  };

  const find = (id: string): DownloadItem => {
    const d = items().find(x => x.id === id);
    if (!d) throw new Error(`No download ${id}.`);
    return d;
  };

  return {
    attach,
    list: () => items(),
    async open(id) {
      const d = find(id);
      if (d.state !== 'completed') throw new Error('That download has not finished.');
      const err = await shell.openPath(d.path);
      if (err) throw new Error(err);
    },
    show(id) { shell.showItemInFolder(find(id).path); },
    cancel(id) {
      const l = live.get(id);
      if (l) l.item.cancel(); else update(id, { state: 'cancelled' }, true);
    },
    retry(id) {
      const d = find(id);
      if (!session) throw new Error('The browser is not ready.');
      // A fresh download of the same URL, through the browser's own session (its cookies, its sign-ins).
      session.downloadURL(d.url);
    },
    clear() {
      file.set(items().filter(d => d.state === 'progressing' || d.state === 'awaiting-confirmation'));
      file.flush();
    },
    flush() { file.flush(); },
  };
}
