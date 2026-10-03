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

/** A credential's policy as the vault reports it (src/vault/types.ts). */
export interface PolicyView {
  allowedHosts: string[]; allowedOrigins: string[]; allowedTools: string[];
  approval: 'every-use' | 'session' | 'auto'; allowShell: boolean; shellApproval?: 'every-use' | 'auto';
  allowInsecureHttp?: boolean; allowSelfSigned?: boolean; expiresAt?: number; rateLimit?: { max: number; perSeconds: number };
}
/** A credential's metadata — everything but its values. */
export interface CredentialView {
  id: string; name: string; kind: string; username?: string; host?: string; port?: number; url?: string; description?: string;
  tags: string[]; createdBy: string; createdAt: number; updatedAt: number; quarantined?: boolean; lastUsedAt?: number; useCount?: number;
  public?: { publicKey?: string; fingerprint?: string; certificate?: string }; policy: PolicyView; fields: string[];
}
export interface AuditView {
  at: number; action: string; outcome: string; name?: string; credentialId?: string; tool?: string; target?: string; purpose?: string;
  sessionId?: string; actor?: string; reason?: string;
}
export interface VaultManagerStatus {
  exists?: boolean; unlocked?: boolean; provider?: string; count?: number; interactive?: boolean; host?: boolean;
  pendingApprovals?: unknown[]; pendingRequests?: unknown[]; keyProblem: string | null; lockedByYou: boolean; error?: string;
}

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

  /**
   * A URL on the scripted-preview origin (`aico://preview/<token>/…`, ADR 0020) for an HTML
   * file in a chat's artifacts folder, or for a page held in memory. Frame it with
   * `sandbox="allow-scripts"` and nothing else.
   */
  preview: {
    register: (o: { session: string; path: string } | { html: string }) => invoke<{ url: string }>('preview:register', o),
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

  /**
   * The Credential Manager (electron/credential-manager.ts). No call returns a
   * secret value: adding and rotating open main's secure prompt, revealing
   * and copying happen in main after a native confirmation.
   */
  vault: {
    status: () => invoke<VaultManagerStatus>('vault:status'),
    list: (filter?: { host?: string; kind?: string }) => invoke<CredentialView[]>('vault:list', filter),
    audit: (o?: { id?: string; limit?: number }) => invoke<AuditView[]>('vault:audit', o),
    fields: () => invoke<Record<string, Array<{ field: string; label: string; optional?: boolean }>>>('vault:fields'),
    add: (o: { name: string; kind: string; username?: string; host?: string; url?: string; port?: number; description?: string; tags?: string[]; policy?: Partial<PolicyView> }) =>
      invoke<{ credential: CredentialView; warnings: string[] } | null>('vault:add', o),
    generate: (o: { name: string; kind: string; username?: string; host?: string; url?: string; port?: number; description?: string; length?: number; symbols?: boolean; allowSelfSigned?: boolean }) =>
      invoke<{ name: string; publicKey?: string; fingerprint?: string; warnings: string[] }>('vault:generate', o),
    rotate: (id: string, mode: 'generate' | 'enter') => invoke<CredentialView | null>('vault:rotate', id, mode),
    policy: (id: string, policy: Partial<PolicyView>) => invoke<CredentialView>('vault:policy', id, policy),
    update: (id: string, patch: Record<string, unknown>) => invoke<CredentialView>('vault:update', id, patch),
    remove: (id: string) => invoke<boolean>('vault:delete', id),
    reveal: (id: string) => invoke<boolean>('vault:reveal', id),
    copy: (id: string, field?: string) => invoke<boolean>('vault:copy', id, field),
    lock: () => invoke<boolean>('vault:lock'),
    unlock: () => invoke<boolean>('vault:unlock'),
    exportEncrypted: () => invoke<{ file: string; count: number } | null>('vault:export'),
    importEncrypted: () => invoke<{ added: number; skipped: number } | null>('vault:import'),
    exportCsv: () => invoke<{ file: string; count: number } | null>('vault:exportCsv'),
    onChanged: (fn: () => void) => on('vault:changed', fn),
  },

  onCommand: (fn: (cmd: { id: string; args?: unknown }) => void) => on('command:run', fn),
  pathForFile: (f: File) => raw.pathForFile(f),
};
