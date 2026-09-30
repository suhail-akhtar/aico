/**
 * The renderer's only bridge to the main process.
 *
 * Deliberately generic — `invoke` and `on` over an allowlist of channel
 * prefixes — so a feature module adds channels without touching this file,
 * while the renderer still cannot reach anything main did not register. The
 * typed surface lives in the renderer (`src/desktop.ts`).
 *
 * Plugins never see this: their views run in sandboxed frames with an opaque
 * origin and talk to the host through postMessage.
 *
 * @module desktop/electron/preload
 */

import { contextBridge, ipcRenderer, webUtils } from 'electron';

const PREFIXES = [
  'app:', 'engine:', 'prefs:', 'win:', 'shell:', 'dialog:', 'notify:', 'clipboard:', 'export:',
  'fs:', 'term:', 'gh:', 'git:', 'browser:', 'plugins:', 'mcp:', 'activity:', 'command:', 'updates:', 'backup:',
  // The Credential Manager (credential-manager.ts). None of its channels returns a value.
  'vault:',
];

function allowed(channel: string): boolean {
  return typeof channel === 'string' && PREFIXES.some(p => channel.startsWith(p));
}

contextBridge.exposeInMainWorld('aicoDesktop', {
  platform: process.platform,
  invoke(channel: string, ...args: unknown[]): Promise<unknown> {
    if (!allowed(channel)) return Promise.reject(new Error(`Channel not allowed: ${channel}`));
    return ipcRenderer.invoke(channel, ...args);
  },
  on(channel: string, listener: (payload: unknown) => void): () => void {
    if (!allowed(channel)) throw new Error(`Channel not allowed: ${channel}`);
    const wrapped = (_e: unknown, payload: unknown): void => listener(payload);
    ipcRenderer.on(channel, wrapped);
    return () => { ipcRenderer.removeListener(channel, wrapped); };
  },
  /** The real path of a dropped or picked File (Electron no longer puts it on File). */
  pathForFile(file: File): string {
    try { return webUtils.getPathForFile(file); } catch { return ''; }
  },
});
