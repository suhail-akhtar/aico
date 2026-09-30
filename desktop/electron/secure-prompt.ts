/**
 * The secure prompt: a small window main owns, for typing a secret in.
 *
 * Why not a dialog in the app's interface: the app renderer is a large React
 * application with a store, devtools, logs and plugins beside it. A value
 * typed there passes through its state, may be kept by an undo stack or a
 * draft saver, and is one bug away from a log line. This window is none of
 * that: a few lines of HTML from a string, no framework, no store, its own
 * sandboxed preload that exposes exactly `submit` and `cancel`, a strict
 * content-security policy (no network at all), and it is closed and destroyed
 * the moment it answers. What is typed goes from its inputs to main over a
 * one-time channel id, and from main to the engine over the private port.
 *
 * The app renderer never learns the value — it cannot open this window, read
 * it, or reach its channel (the preload allowlist has no `secure-prompt:`).
 *
 * @module desktop/electron/secure-prompt
 */

import { BrowserWindow, ipcMain, nativeTheme } from 'electron';
import crypto from 'node:crypto';
import path from 'node:path';
import type { DesktopContext } from './context';

export interface SecureField {
  id: string;
  label: string;
  /** A secret: shown as dots, never autocompleted, never spell-checked. */
  secret: boolean;
  multiline?: boolean;
  value?: string;
  placeholder?: string;
  /** Must match another field (a passphrase typed twice). */
  confirms?: string;
  optional?: boolean;
  minLength?: number;
}

export interface SecurePromptSpec {
  title: string;
  heading: string;
  explain?: string;
  note?: string;
  fields: SecureField[];
  submitLabel?: string;
  cancelLabel?: string;
  timeoutMs?: number;
}

export const SECURE_PROMPT_CHANNEL = 'secure-prompt:answer';

const esc = (s: string): string => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

function pageHtml(spec: SecurePromptSpec, dark: boolean): string {
  const fields = spec.fields.map((f) => {
    const common = `id="${esc(f.id)}" name="${esc(f.id)}" autocomplete="off" autocapitalize="off" spellcheck="false"${f.optional ? '' : ' required'}${f.minLength ? ` minlength="${f.minLength}"` : ''}${f.placeholder ? ` placeholder="${esc(f.placeholder)}"` : ''}`;
    const input = f.multiline
      ? `<textarea ${common} rows="5" class="${f.secret ? 'masked' : ''}">${f.secret ? '' : esc(f.value ?? '')}</textarea>`
      : `<input ${common} type="${f.secret ? 'password' : 'text'}" value="${f.secret ? '' : esc(f.value ?? '')}">`;
    return `<label for="${esc(f.id)}">${esc(f.label)}</label>${input}`;
  }).join('\n');
  const bg = dark ? '#1f1f1f' : '#ffffff';
  const fg = dark ? '#ececec' : '#1a1a1a';
  const muted = dark ? '#a0a0a0' : '#5f5f5f';
  const border = dark ? '#3a3a3a' : '#d6d6d6';
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; form-action 'none'; base-uri 'none'">
<title>${esc(spec.title)}</title>
<style>
  :root { color-scheme: ${dark ? 'dark' : 'light'}; }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 20px 22px; font: 13.5px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; background: ${bg}; color: ${fg}; }
  h1 { font-size: 15px; font-weight: 600; margin: 0 0 4px; }
  .explain { color: ${muted}; margin: 0 0 12px; white-space: pre-wrap; word-break: break-word; }
  label { display: block; font-size: 12px; font-weight: 600; color: ${muted}; margin: 10px 0 4px; }
  input, textarea { width: 100%; padding: 7px 9px; border: 1px solid ${border}; border-radius: 8px; background: transparent; color: inherit; font: 13px ui-monospace, "Cascadia Mono", Consolas, monospace; }
  textarea.masked { -webkit-text-security: disc; }
  input:focus, textarea:focus { outline: 2px solid #4f7cff; outline-offset: -1px; }
  .note { margin-top: 12px; font-size: 12px; color: ${muted}; }
  .err { min-height: 16px; margin-top: 6px; font-size: 12px; color: #d9534f; }
  .row { display: flex; justify-content: flex-end; gap: 8px; margin-top: 14px; }
  button { padding: 6px 14px; border-radius: 8px; border: 1px solid ${border}; background: transparent; color: inherit; font: inherit; cursor: pointer; }
  button.primary { background: #4f7cff; border-color: #4f7cff; color: #fff; }
</style></head><body>
<h1>${esc(spec.heading)}</h1>
${spec.explain ? `<p class="explain">${esc(spec.explain)}</p>` : ''}
<form id="f" autocomplete="off">
${fields}
<div class="err" id="err"></div>
${spec.note ? `<div class="note">${esc(spec.note)}</div>` : ''}
<div class="row"><button type="button" id="cancel">${esc(spec.cancelLabel ?? 'Cancel')}</button><button type="submit" class="primary">${esc(spec.submitLabel ?? 'Save')}</button></div>
</form>
<script>
  const confirms = ${JSON.stringify(Object.fromEntries(spec.fields.filter(f => f.confirms).map(f => [f.id, f.confirms])))};
  const form = document.getElementById('f');
  const clear = () => { for (const el of form.querySelectorAll('input, textarea')) el.value = ''; };
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const values = {};
    for (const el of form.querySelectorAll('input, textarea')) values[el.name] = el.value;
    for (const [a, b] of Object.entries(confirms)) {
      if (values[a] !== values[b]) { document.getElementById('err').textContent = 'The two entries do not match.'; return; }
    }
    window.securePrompt.submit(values);
    clear();
  });
  document.getElementById('cancel').addEventListener('click', () => { clear(); window.securePrompt.cancel(); });
  addEventListener('keydown', (e) => { if (e.key === 'Escape') { clear(); window.securePrompt.cancel(); } });
  const first = form.querySelector('input:not([value]), input[value=""], textarea');
  if (first) first.focus();
</script></body></html>`;
}

/**
 * Ask for values in the secure prompt. Resolves the typed values keyed by
 * field id, or null when cancelled, closed or timed out. The caller must
 * send them on and drop them.
 */
export function openSecurePrompt(ctx: DesktopContext, spec: SecurePromptSpec): Promise<Record<string, string> | null> {
  return new Promise((resolve) => {
    const parent = BrowserWindow.getFocusedWindow() ?? ctx.window() ?? undefined;
    const lines = spec.fields.reduce((n, f) => n + (f.multiline ? 6 : 2), 0);
    const win = new BrowserWindow({
      width: 480,
      height: Math.min(720, 230 + lines * 26 + (spec.explain ? 40 : 0) + (spec.note ? 30 : 0)),
      parent: parent && !parent.isDestroyed() ? parent : undefined,
      modal: Boolean(parent && !parent.isDestroyed()),
      show: false,
      resizable: true,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      autoHideMenuBar: true,
      title: spec.title,
      backgroundColor: nativeTheme.shouldUseDarkColors ? '#1f1f1f' : '#ffffff',
      webPreferences: {
        preload: path.join(ctx.paths.distDir, 'secure-prompt-preload.cjs'),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        spellcheck: false,
        devTools: false,
        webviewTag: false,
        // Its own in-memory session: nothing it does is cached or shared with the app.
        partition: `secure-prompt-${crypto.randomBytes(6).toString('hex')}`,
      },
    });
    win.setMenu(null);
    const channelId = crypto.randomBytes(16).toString('hex');
    let settled = false;
    const finish = (values: Record<string, string> | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ipcMain.removeHandler(`${SECURE_PROMPT_CHANNEL}:${channelId}`);
      if (!win.isDestroyed()) win.destroy();
      resolve(values);
    };
    const timer = setTimeout(() => finish(null), spec.timeoutMs ?? 10 * 60_000);
    ipcMain.handle(`${SECURE_PROMPT_CHANNEL}:${channelId}`, (e, answer: { values?: Record<string, unknown> } | null) => {
      // Only this window's page may answer on this channel.
      if (e.sender !== win.webContents) return false;
      if (!answer || !answer.values || typeof answer.values !== 'object') { finish(null); return true; }
      const out: Record<string, string> = {};
      for (const f of spec.fields) {
        const v = (answer.values as Record<string, unknown>)[f.id];
        out[f.id] = typeof v === 'string' ? v : '';
      }
      finish(out);
      return true;
    });
    win.on('closed', () => finish(null));
    // No navigation anywhere, no new windows, nothing the page could open.
    win.webContents.on('will-navigate', (e) => e.preventDefault());
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.once('ready-to-show', () => { win.show(); win.focus(); });
    // The preload asks main for its channel id (secure-prompt:channel); only
    // this window's own web contents gets this one.
    const wcId = win.webContents.id;
    pendingChannels.set(wcId, channelId);
    win.webContents.once('destroyed', () => pendingChannels.delete(wcId));
    const html = pageHtml(spec, nativeTheme.shouldUseDarkColors);
    // The spec carries no secret (labels and non-secret prefills only).
    void win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`).catch(() => finish(null));
  });
}

/** Which channel id belongs to which prompt window (asked for by its preload). */
const pendingChannels = new Map<number, string>();

/** Registered once: a prompt window's preload asks for its own channel id. */
export function registerSecurePromptIpc(): void {
  ipcMain.removeHandler('secure-prompt:channel');
  ipcMain.handle('secure-prompt:channel', (e) => pendingChannels.get(e.sender.id) ?? null);
}
