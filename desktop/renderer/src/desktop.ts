/**
 * The typed face of `window.aicoDesktop` — everything the interface can ask
 * the main process to do.
 *
 * @module desktop/renderer/desktop
 */

import type { DesktopPrefs } from '@desk/prefs';
import type { UpdateState } from '@desk/updates';

export type { UpdateState };

interface RawBridge {
  platform: NodeJS.Platform | string;
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  on(channel: string, listener: (payload: unknown) => void): () => void;
  pathForFile(file: File): string;
}

declare global {
  interface Window { aicoDesktop?: RawBridge }
}

/** A stand-in so the interface can render in a plain browser tab during development. */
const offline: RawBridge = {
  platform: 'web',
  invoke: async (channel) => { throw new Error(`Desktop bridge unavailable (${channel})`); },
  on: () => () => {},
  pathForFile: () => '',
};

export const raw: RawBridge = window.aicoDesktop ?? offline;
export const isDesktop = Boolean(window.aicoDesktop);
export const platform = raw.platform;

export function invoke<T = unknown>(channel: string, ...args: unknown[]): Promise<T> {
  // Electron wraps every main-process error as "Error invoking remote method
  // 'x': Error: <message>". The message is what a person should read.
  return (raw.invoke(channel, ...args) as Promise<T>).catch((err: Error) => {
    const clean = String(err?.message ?? err).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '');
    throw new Error(clean);
  });
}

export function on<T = unknown>(channel: string, listener: (payload: T) => void): () => void {
  return raw.on(channel, listener as (p: unknown) => void);
}

export type EngineState =
  | { status: 'starting'; attempt: number }
  | { status: 'ready'; origin: string; startedAt: number }
  | { status: 'crashed'; message: string; attempt: number; retryInMs: number }
  | { status: 'stopped' };

export interface AppInfo {
  app: string; engine: string; electron: string; chrome: string; node: string;
  platform: string; arch: string; osRelease: string; hostname: string; user: string;
  home: string; aicoHome: string; desktopDir: string; pluginsDir: string; packaged: boolean;
}

export interface PickedFile { path: string; name: string; size: number }

export interface BackupManifest {
  format: string; version: number; createdAt: string; app: string; engine: string; platform: string;
  includes: string[]; apiKeys: boolean; chats: boolean; files: number; counts: Record<string, number>;
}
export interface BackupExportResult { file: string; files: number; bytes: number; manifest: BackupManifest }
export interface BackupPreview {
  file: string;
  manifest: BackupManifest;
  summary: Array<{ id: string; label: string; files: number }>;
  ignored: number;
  /** Work in flight that a restore (which restarts the engine) would stop. */
  busy: string[];
}

export const desktop = {
  info: () => invoke<AppInfo>('app:info'),
  relaunch: () => invoke('app:relaunch'),
  quit: () => invoke('app:quit'),

  engine: {
    status: () => invoke<EngineState>('engine:status'),
    restart: () => invoke('engine:restart'),
    log: () => invoke<string[]>('engine:log'),
    webUrl: () => invoke<string | null>('engine:webUrl'),
    onStatus: (fn: (s: EngineState) => void) => on('engine:status', fn),
  },

  prefs: {
    get: () => invoke<DesktopPrefs>('prefs:get'),
    set: (patch: Partial<DesktopPrefs>) => invoke<DesktopPrefs>('prefs:set', patch),
  },

  win: {
    minimize: () => invoke('win:minimize'),
    toggleMaximize: () => invoke<boolean>('win:toggleMaximize'),
    close: () => invoke('win:close'),
    isMaximized: () => invoke<boolean>('win:isMaximized'),
    setOverlay: (color: string, symbolColor: string) => invoke('win:setOverlay', { color, symbolColor }),
    setThemeSource: (mode: 'system' | 'light' | 'dark') => invoke('win:setThemeSource', mode),
    zoom: (delta: number) => invoke<number>('win:zoom', delta),
    devtools: () => invoke('win:devtools'),
    onFocus: (fn: (focused: boolean) => void) => on('win:focus', fn),
  },

  shell: {
    openExternal: (url: string) => invoke('shell:openExternal', url),
    showItemInFolder: (p: string) => invoke('shell:showItemInFolder', p),
    openPath: (p: string) => invoke('shell:openPath', p),
  },

  dialog: {
    pickFolder: (title?: string) => invoke<string | null>('dialog:pickFolder', title),
    pickFiles: (opts?: { title?: string; multi?: boolean; filters?: Array<{ name: string; extensions: string[] }> }) =>
      invoke<PickedFile[]>('dialog:pickFiles', opts),
    readFileBase64: (p: string) => invoke<string>('dialog:readFileBase64', p),
    saveFile: (o: { defaultName: string; content: string; encoding?: 'utf8' | 'base64'; filters?: Array<{ name: string; extensions: string[] }> }) =>
      invoke<string | null>('dialog:saveFile', o),
    confirm: (o: { title: string; message: string; detail?: string; ok?: string; cancel?: string; danger?: boolean }) =>
      invoke<boolean>('dialog:confirm', o),
  },

  notify: (o: { title: string; body: string; data?: unknown; onlyWhenUnfocused?: boolean; silent?: boolean }) =>
    invoke<boolean>('notify:show', o).catch(() => false),
  onNotificationClick: (fn: (data: unknown) => void) => on('notify:click', fn),
  badge: (count: number) => invoke('notify:badge', count).catch(() => {}),

  clipboard: {
    writeRich: (text: string, html?: string) => invoke('clipboard:writeRich', { text, html }),
    writeImage: (dataUrl: string) => invoke('clipboard:writeImage', dataUrl),
  },

  exportPdf: (html: string, defaultName: string) => invoke<string | null>('export:pdf', { html, defaultName }),

  updates: {
    state: () => invoke<UpdateState>('updates:state'),
    check: () => invoke<UpdateState>('updates:check'),
    download: () => invoke<UpdateState>('updates:download'),
    /** 'ask' (default) restarts if idle and otherwise asks; 'when-idle' waits for running work. */
    install: (mode?: 'ask' | 'now' | 'when-idle') => invoke<UpdateState>('updates:install', mode),
    cancelWait: () => invoke<UpdateState>('updates:cancelWait'),
    onState: (fn: (s: UpdateState) => void) => on('updates:state', fn),
  },

  backup: {
    /** Asks where to save; resolves null when cancelled. */
    export: (o: { includeApiKeys?: boolean; includeChats?: boolean }) => invoke<BackupExportResult | null>('backup:export', o),
    /** Asks for a backup and describes it; nothing changes until `import`. */
    pick: () => invoke<BackupPreview | null>('backup:pick'),
    import: (file: string) => invoke<{ restored: number; safetyCopy: string; keptKeys: number }>('backup:import', file),
  },

  /** Zip a folder; with `rootName` everything sits under that one top-level folder (the `.skill` layout). */
  zipDir: (srcDir: string, destFile: string, rootName?: string) =>
    invoke<{ file: string; entries: number; bytes: number }>('fs:zipDir', srcDir, destFile, rootName),

  onCommand: (fn: (cmd: { id: string; args?: unknown }) => void) => on('command:run', fn),
  pathForFile: (f: File) => raw.pathForFile(f),
};
