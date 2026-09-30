/**
 * The secure prompt window's preload (secure-prompt.ts): exactly two calls,
 * `submit(values)` and `cancel()`, on a channel whose id main hands only to
 * this window's own web contents.
 *
 * Deliberately separate from the app's preload.ts: that bridge serves a large
 * interface and an allowlist of prefixes; this one serves a form, and the app
 * interface can reach neither this preload nor its channel.
 *
 * @module desktop/electron/secure-prompt-preload
 */

import { contextBridge, ipcRenderer } from 'electron';

const channel: Promise<string | null> = ipcRenderer.invoke('secure-prompt:channel') as Promise<string | null>;

contextBridge.exposeInMainWorld('securePrompt', {
  submit(values: Record<string, string>): void {
    const copy: Record<string, string> = {};
    for (const [k, v] of Object.entries(values ?? {})) if (typeof v === 'string') copy[k] = v;
    void channel.then((id) => { if (id) void ipcRenderer.invoke(`secure-prompt:answer:${id}`, { values: copy }); });
  },
  cancel(): void {
    void channel.then((id) => { if (id) void ipcRenderer.invoke(`secure-prompt:answer:${id}`, null); });
  },
});
