/**
 * JavaScript dialogs (alert / confirm / prompt) in the built-in browser.
 *
 * Electron draws these as native message boxes, and it does not close them
 * when the DevTools protocol answers the dialog — so answering from the
 * interface or the agent left an orphaned native box behind (verified live),
 * and `prompt()` is not supported at all. Instead, a tiny preload replaces the
 * three functions in every frame with ones that ask main synchronously
 * (`ipcRenderer.sendSync` — the page blocks exactly as it would on a real
 * dialog) and main asks the interface (`browser:dialog`), or the agent
 * (`browser_dialog`).
 *
 * The preload is a plain string written to the browser data folder at start,
 * so it needs no separate bundle. It only exposes nothing to the page: the
 * replacement functions close over a bridged `ask`, no global is added.
 *
 * @module desktop/electron/browser-preload
 */

import fs from 'node:fs';
import path from 'node:path';
import type { Session } from 'electron';

export const DIALOG_CHANNEL = 'aico-browser:dialog';

export const DIALOG_PRELOAD_JS = `(() => {
  const { contextBridge, ipcRenderer } = require('electron');
  const ask = (type, message, defaultPrompt) => {
    try { return ipcRenderer.sendSync(${JSON.stringify(DIALOG_CHANNEL)}, { type, message: String(message), defaultPrompt: defaultPrompt === undefined ? undefined : String(defaultPrompt) }); }
    catch (e) { return null; }
  };
  try {
    contextBridge.executeInMainWorld({
      func: (ask) => {
        const define = (name, fn) => { try { Object.defineProperty(window, name, { value: fn, writable: true, configurable: true, enumerable: true }); } catch (e) { /* frozen */ } };
        define('alert', function alert(message) { ask('alert', message === undefined ? '' : message); });
        define('confirm', function confirm(message) { const r = ask('confirm', message === undefined ? '' : message); return Boolean(r && r.accept); });
        define('prompt', function prompt(message, defaultValue) {
          const r = ask('prompt', message === undefined ? '' : message, defaultValue === undefined ? '' : defaultValue);
          return r && r.accept ? String(r.text == null ? '' : r.text) : null;
        });
      },
      args: [ask],
    });
  } catch (e) { /* the page keeps the native dialogs */ }
})();
`;

/** Write the preload next to the browser's data and register it for every frame of the partition. */
export function installDialogPreload(ses: Session, dataDir: string): void {
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    const file = path.join(dataDir, 'dialog-preload.js');
    if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== DIALOG_PRELOAD_JS) fs.writeFileSync(file, DIALOG_PRELOAD_JS);
    ses.registerPreloadScript({ type: 'frame', id: 'aico-dialogs', filePath: file });
  } catch (err) {
    console.error('Browser dialog preload not installed:', err);
  }
}
