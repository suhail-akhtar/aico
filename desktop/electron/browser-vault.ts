/**
 * The built-in browser's password manager — local only, and walled off.
 *
 * STORAGE. `<AICO_HOME>/desktop/browser/vault.bin`, sealed with Electron's
 * `safeStorage` (the OS keychain / DPAPI). When safeStorage cannot encrypt —
 * or on Linux can only use its fixed-key fallback — nothing is stored and the
 * interface says why. A vault that exists but will not open is left exactly
 * as it is (never overwritten with an empty one). It is not in AICO backups:
 * backup-core.ts refuses the path, and it could not be opened on another
 * machine anyway.
 *
 * WHAT CROSSES WHICH LINE.
 *   - The interface gets origins and usernames to list, and one entry's
 *     password and note only when the person reveals it (after a native
 *     confirm main shows itself). Copying goes straight to the clipboard from
 *     here and is cleared again after 45 s.
 *   - A web page gets one login, sent to the frame by main, only when the
 *     person picks it (the key in the address bar, or the chooser that opens
 *     when they click an empty sign-in field), and only if browser-vault-core's
 *     `canFill` agrees: same origin exactly, secure, never another site's frame.
 *   - The engine, the copilot, the model, the MCP browser tools, logs,
 *     insights and backups get nothing. The agent still cannot type into a
 *     password field (browser-safety.ts), and while a page holds a password
 *     AICO filled, `browser_evaluate` there is refused until it navigates.
 *
 * DETECTING A SIGN-IN. A small preload, in its own isolated world in every
 * frame (the page's scripts cannot see or change it), notices a submitted form
 * with a password in it and tells main; main asks "Save password?" — never
 * saves silently. The same preload reports a click into an empty sign-in field
 * (for the chooser) and does the filling.
 *
 * @module desktop/electron/browser-vault
 */

import { app, clipboard, dialog, ipcMain, Menu, safeStorage, type MenuItemConstructorOptions, type Session, type WebContents, type WebContentsView } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import type { DesktopContext } from './context';
import type { VaultForPage, VaultItem, VaultOffer, VaultStatus } from '../shared/browser-types';
import {
  canFill, editEntry, emptyVault, entriesFor, isSecureOrigin, loginOrigin, openVault, passwordReport, sealVault, toPasswordCsv, upsertLogin,
  type UpsertResult, type VaultCipher, type VaultData, type VaultEntry,
} from './browser-vault-core';

export const VAULT_CHANNEL = 'aico-vault';
const FILL_CHANNEL = 'aico-vault:fill';

export interface VaultService {
  status(): VaultStatus;
  /** Add logins (the CSV import). */
  addMany(logins: Array<{ origin: string; username: string; password: string; note?: string; created?: number }>): { added: number; updated: number; unchanged: number };
  /** Register the page preload on the browser's session. */
  attach(ses: Session): void;
  /** Throws while this page holds a password AICO filled (for browser_evaluate). */
  guardAgent(wc: WebContents): void;
}

export interface VaultDeps {
  dataDir: string;
  /** The tab a page's web contents belongs to. */
  tabOf(wcId: number): { id: string; view: WebContentsView } | undefined;
  /** The tab in front (its page), or null. */
  front(): { id: string; wc: WebContents } | null;
  /** Is the agent working in this tab right now? The chooser stays shut while it is. */
  agentDriving(wcId: number): boolean;
}

/** The page half: in an isolated world of every frame. Exposes nothing to the page. */
export const VAULT_PRELOAD_JS = String.raw`(() => {
  const { ipcRenderer } = require('electron');
  const CH = ${JSON.stringify(VAULT_CHANNEL)};
  const d = document;
  const isInput = (el) => Boolean(el && el.tagName === 'INPUT');
  const shown = (el) => { try { const r = el.getBoundingClientRect(); if (r.width < 1 || r.height < 1) return false; const s = getComputedStyle(el); return s.visibility !== 'hidden' && s.display !== 'none'; } catch (e) { return false; } };
  const isPw = (el) => isInput(el) && el.type === 'password';
  const isText = (el) => isInput(el) && ['text', 'email', 'tel', ''].includes(el.type) && !el.disabled && !el.readOnly && shown(el);
  const scopeOf = (el) => (el && (el.form || (el.closest && el.closest('form')))) || d;
  const pwFields = (scope) => Array.from(scope.querySelectorAll('input[type=password]')).filter(el => !el.disabled && shown(el));
  const USERISH = /user|login|e-?mail|account|identifier|handle|phone|member|benutzer|usuario|utilisateur/i;
  const userFor = (pw) => {
    const inputs = Array.from(scopeOf(pw).querySelectorAll('input'));
    const ac = inputs.find(el => isText(el) && /\b(username|email)\b/.test(el.autocomplete || ''));
    if (ac) return ac;
    const i = inputs.indexOf(pw);
    const before = inputs.slice(0, i < 0 ? inputs.length : i).filter(el => isText(el) && !/search/i.test((el.name || '') + (el.id || '')));
    const named = before.filter(el => USERISH.test([el.name, el.id, el.autocomplete, el.placeholder, el.getAttribute('aria-label')].join(' ')));
    return named[named.length - 1] || before[before.length - 1] || null;
  };
  let last = { v: '', at: 0 };
  const capture = (scope) => {
    const pws = pwFields(scope).filter(el => el.value);
    if (!pws.length) return;
    let pw = pws[0];
    const fresh = pws.filter(el => /new-password/.test(el.autocomplete || ''));
    if (fresh.length) pw = fresh[0];
    else if (pws.length === 3) pw = pws[1];
    const password = String(pw.value);
    if (!password || password.length > 1000) return;
    const now = Date.now();
    if (last.v === password && now - last.at < 4000) return;
    last = { v: password, at: now };
    const u = userFor(pw);
    ipcRenderer.send(CH, { op: 'submit', username: u ? String(u.value || '').slice(0, 500) : '', password });
  };
  const SUBMITISH = /sign ?in|log ?in|log ?on|continue|next|submit|save|create|register|sign ?up|join|anmelden|connexion|entrar|accedi|inloggen/i;
  addEventListener('submit', (e) => { const f = e.target; if (f && f.tagName === 'FORM') capture(f); }, true);
  addEventListener('keydown', (e) => {
    if (!e.isTrusted || e.key !== 'Enter' || !isInput(e.target)) return;
    const scope = scopeOf(e.target);
    if (pwFields(scope).some(el => el.value)) capture(scope);
  }, true);
  addEventListener('click', (e) => {
    if (!e.isTrusted) return;
    const t = e.target;
    // A click into an empty sign-in field of the top page: main may show the chooser.
    if (isInput(t)) {
      if (window.top !== window || t.value) return;
      const pws = pwFields(scopeOf(t));
      if (isPw(t) || (isText(t) && pws.length && userFor(pws[0]) === t)) {
        const r = t.getBoundingClientRect();
        ipcRenderer.send(CH, { op: 'pick', rect: { x: r.left, y: r.bottom, w: r.width } });
      }
      return;
    }
    const b = t && t.closest ? t.closest('button, input[type=submit], input[type=image], [role=button]') : null;
    if (!b) return;
    const typed = (b.getAttribute('type') || '').toLowerCase();
    const submitty = b.tagName === 'INPUT' || (b.tagName === 'BUTTON' && typed !== 'button' && typed !== 'reset' && (b.form || b.closest('form'))) || SUBMITISH.test(b.textContent || b.value || b.getAttribute('aria-label') || '');
    if (!submitty) return;
    const scope = scopeOf(b);
    if (pwFields(scope).some(el => el.value)) capture(scope);
  }, true);
  ipcRenderer.on(${JSON.stringify(FILL_CHANNEL)}, (_e, m) => {
    let n = 0;
    try {
      if (!m || location.origin !== m.origin) { ipcRenderer.send(CH, { op: 'filled', token: m && m.token, n: 0 }); return; }
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      const put = (el, v) => {
        el.focus();
        setter.call(el, v);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        n++;
      };
      const f = d.activeElement;
      const scope = isInput(f) ? scopeOf(f) : d;
      const pws = pwFields(scope).length ? pwFields(scope) : pwFields(d);
      const pw = (isPw(f) && f) || pws.find(el => !el.value) || pws[0];
      if (pw) {
        const u = userFor(pw);
        if (u && m.username) put(u, m.username);
        put(pw, m.password);
      } else if (isText(f) && m.username) {
        put(f, m.username);
      }
    } catch (e) { /* the page changed under us */ }
    ipcRenderer.send(CH, { op: 'filled', token: m && m.token, n });
  });
})();
`;

/** safeStorage as the vault's cipher — refusing Linux's fixed-key fallback, which would protect nothing. */
const safeCipher: VaultCipher & { reason(): string | undefined } = {
  reason() {
    if (!app.isReady()) return 'The app is still starting.';
    if (!safeStorage.isEncryptionAvailable()) return 'This computer offers AICO no way to encrypt data (no OS keychain), so passwords are not stored.';
    if (process.platform === 'linux') {
      try {
        const backend = (safeStorage as unknown as { getSelectedStorageBackend?: () => string }).getSelectedStorageBackend?.();
        if (backend === 'basic_text' || backend === 'unknown') return 'No system keyring (such as GNOME Keyring or KWallet) is running, so passwords would not really be encrypted and are not stored.';
      } catch { /* older Electron: trust isEncryptionAvailable */ }
    }
    return undefined;
  },
  available() { return this.reason() === undefined; },
  encrypt: (s) => safeStorage.encryptString(s),
  decrypt: (b) => safeStorage.decryptString(b),
};

export function registerVault(ctx: DesktopContext, deps: VaultDeps): VaultService {
  const file = path.join(deps.dataDir, 'vault.bin');
  let data: VaultData | null = null;
  let broken: string | undefined;

  const load = (): VaultData => {
    if (data) return data;
    if (!fs.existsSync(file)) { data = emptyVault(); return data; }
    const reason = safeCipher.reason();
    if (reason) throw new Error(reason);
    try { data = openVault(fs.readFileSync(file), safeCipher); broken = undefined; return data; }
    catch (err) {
      broken = `The saved passwords could not be opened (${(err as Error).message}). The file has been left as it is.`;
      throw new Error(broken);
    }
  };
  const save = (next: VaultData): void => {
    load(); // never write over a vault that did not open
    const sealed = sealVault(next, safeCipher);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(`${file}.tmp`, sealed);
    fs.renameSync(`${file}.tmp`, file);
    data = next;
    ctx.emit('browser:vault:changed', { count: next.entries.length });
  };
  const status = (): VaultStatus => {
    const reason = safeCipher.reason();
    if (reason) return { available: false, reason, count: 0 };
    try { return { available: true, count: load().entries.length }; }
    catch (err) { return { available: false, reason: (err as Error).message, count: 0 }; }
  };
  const need = (): VaultData => {
    const s = status();
    if (!s.available) throw new Error(s.reason);
    return load();
  };
  const entry = (id: string): VaultEntry => {
    const e = need().entries.find(x => x.id === id);
    if (!e) throw new Error('That password is no longer saved.');
    return e;
  };
  const hostOf = (origin: string): string => { try { return new URL(origin).host; } catch { return origin; } };

  // ── Re-confirm before a password is shown or copied (once, then for a minute) ──
  let unlockedUntil = 0;
  const confirmReveal = async (e: VaultEntry, verb: string): Promise<boolean> => {
    if (Date.now() < unlockedUntil) return true;
    const w = ctx.browserWindow();
    const o: Electron.MessageBoxOptions = {
      type: 'warning', buttons: [verb, 'Cancel'], defaultId: 1, cancelId: 1, noLink: true,
      title: 'Saved password', message: `${verb} the saved password for ${hostOf(e.origin)}?`,
      detail: `Account: ${e.username || '(no username)'}\n\nAnyone who can see your screen${verb.startsWith('Copy') ? ' or paste from your clipboard' : ''} will be able to read it. AICO will not ask again for a minute.`,
    };
    const r = w ? await dialog.showMessageBox(w, o) : await dialog.showMessageBox(o);
    if (r.response !== 0) return false;
    unlockedUntil = Date.now() + 60_000;
    return true;
  };

  // ── Filling a page ──
  const filled = new Set<number>();
  const waiting = new Map<string, (n: number) => void>();
  let fillSeq = 0;
  const fill = async (wc: WebContents, e: VaultEntry): Promise<number> => {
    if (wc.isDestroyed()) return 0;
    const top = wc.mainFrame;
    const verdict = canFill(e.origin, top.url);
    if (!verdict.ok) throw new Error(verdict.reason);
    // The top frame, and frames of the very same origin inside it — never another site's frame.
    const frames = top.framesInSubtree.filter(f => canFill(e.origin, top.url, f.url).ok && f.origin === e.origin);
    let n = 0;
    for (const f of frames) {
      const token = `f${++fillSeq}`;
      const done = new Promise<number>((resolve) => {
        waiting.set(token, resolve);
        setTimeout(() => { waiting.delete(token); resolve(0); }, 1500);
      });
      try { f.send(FILL_CHANNEL, { token, origin: e.origin, username: e.username, password: e.password }); } catch { waiting.delete(token); continue; }
      n += await done;
      if (n) break;
    }
    if (n) {
      if (!filled.has(wc.id)) {
        filled.add(wc.id);
        const clear = (d: { isMainFrame: boolean; isSameDocument: boolean }): void => {
          if (!d.isMainFrame || d.isSameDocument) return;
          filled.delete(wc.id);
          wc.off('did-start-navigation', clear);
        };
        wc.on('did-start-navigation', clear);
        wc.once('destroyed', () => filled.delete(wc.id));
      }
    }
    return n;
  };

  // ── Offers to save ──
  const offers = new Map<string, { offer: VaultOffer; password: string; timer: NodeJS.Timeout }>();
  let offerSeq = 0;
  let toldUnavailable = false;
  const dropOffer = (id: string): void => { const o = offers.get(id); if (o) { clearTimeout(o.timer); offers.delete(id); } };

  ipcMain.removeAllListeners(VAULT_CHANNEL);
  ipcMain.on(VAULT_CHANNEL, (e, msg: { op?: string; username?: unknown; password?: unknown; token?: unknown; n?: unknown; rect?: { x?: unknown; y?: unknown; w?: unknown } }) => {
    if (msg?.op === 'filled') {
      const r = typeof msg.token === 'string' ? waiting.get(msg.token) : undefined;
      if (r) { waiting.delete(msg.token as string); r(Number(msg.n) || 0); }
      return;
    }
    const tab = deps.tabOf(e.sender.id);
    const frame = e.senderFrame;
    // Only the page's own top frame, in one of the browser's tabs.
    if (!tab || !frame || frame !== e.sender.mainFrame) return;
    const origin = loginOrigin(frame.url);
    if (!origin || !isSecureOrigin(origin)) return;

    if (msg.op === 'submit' && typeof msg.password === 'string' && msg.password) {
      const username = typeof msg.username === 'string' ? msg.username.trim().slice(0, 500) : '';
      const reason = safeCipher.reason();
      if (reason) {
        if (toldUnavailable) return;
        toldUnavailable = true;
        ctx.emit('browser:vault:offer', { id: '', tabId: tab.id, origin, username, update: false, unavailable: reason } satisfies VaultOffer);
        return;
      }
      let v: VaultData;
      try { v = load(); } catch { return; }
      if (v.never.includes(origin)) return;
      const same = v.entries.find(x => x.origin === origin && x.username === username);
      if (same && same.password === msg.password) return;
      for (const [id, o] of offers) if (o.offer.tabId === tab.id) dropOffer(id);
      const offer: VaultOffer = { id: `o${++offerSeq}`, tabId: tab.id, origin, username, update: Boolean(same) };
      offers.set(offer.id, { offer, password: msg.password, timer: setTimeout(() => { offers.delete(offer.id); ctx.emit('browser:vault:offerGone', offer.id); }, 5 * 60_000) });
      ctx.emit('browser:vault:offer', offer);
      return;
    }

    if (msg.op === 'pick' && msg.rect) {
      if (deps.agentDriving(e.sender.id)) return;
      let list: VaultEntry[];
      try { list = status().available ? entriesFor(load(), frame.url) : []; } catch { return; }
      if (!list.length || !canFill(origin, frame.url).ok) return;
      const wc = e.sender;
      const b = tab.view.getBounds();
      const z = wc.getZoomFactor();
      const x = Math.round(b.x + (Number(msg.rect.x) || 0) * z);
      const y = Math.round(b.y + (Number(msg.rect.y) || 0) * z + 2);
      const template: MenuItemConstructorOptions[] = [
        { label: `Saved passwords for ${hostOf(origin)}`, enabled: false },
        ...list.slice(0, 12).map((x): MenuItemConstructorOptions => ({
          label: x.username || '(no username)', sublabel: x.username ? undefined : 'password only',
          click: () => { void fill(wc, x).catch(() => { /* navigated away */ }); },
        })),
        { type: 'separator' },
        { label: 'Manage passwords…', click: () => ctx.emit('browser:vault:manage') },
      ];
      Menu.buildFromTemplate(template).popup({ window: ctx.browserWindow() ?? undefined, x, y });
    }
  });

  // ── IPC for the interface ──
  ctx.handle('browser:vault:status', () => status());
  ctx.handle('browser:vault:list', (): VaultItem[] => {
    const v = need();
    const report = passwordReport(v.entries);
    const weak = new Map(report.weak.map(w => [w.id, w.reason]));
    const reused = new Map<string, number>();
    for (const g of report.reused) for (const id of g) reused.set(id, g.length);
    return v.entries.map(e => ({
      id: e.id, origin: e.origin, username: e.username, hasNote: Boolean(e.note), created: e.created, updated: e.updated,
      ...(weak.has(e.id) ? { weak: weak.get(e.id) } : {}), ...(reused.has(e.id) ? { reused: reused.get(e.id) } : {}),
    })).sort((a, b) => a.origin.localeCompare(b.origin) || a.username.localeCompare(b.username));
  });
  ctx.handle('browser:vault:never', () => need().never);
  ctx.handle('browser:vault:neverRemove', (origin: string) => { const v = need(); save({ ...v, never: v.never.filter(o => o !== origin) }); return true; });
  ctx.handle('browser:vault:reveal', async (id: string): Promise<{ username: string; password: string; note: string } | null> => {
    const e = entry(String(id));
    if (!(await confirmReveal(e, 'Show'))) return null;
    return { username: e.username, password: e.password, note: e.note ?? '' };
  });
  ctx.handle('browser:vault:copy', async (id: string, what: 'password' | 'username') => {
    const e = entry(String(id));
    if (what === 'username') { await clipboard.writeText(e.username); return true; }
    if (!(await confirmReveal(e, 'Copy'))) return false;
    await clipboard.writeText(e.password);
    // Cleared after 45 s, unless something else has been copied since.
    setTimeout(() => { void Promise.resolve(clipboard.readText()).then((t) => { if (t === e.password) void clipboard.writeText(''); }); }, 45_000);
    return true;
  });
  ctx.handle('browser:vault:add', (l: { origin: string; username?: string; password: string; note?: string }) => {
    const origin = loginOrigin(String(l?.origin ?? '').includes('://') ? String(l.origin) : `https://${String(l?.origin ?? '')}`);
    if (!origin) throw new Error('Enter the site’s address, like https://example.com');
    const r = upsertLogin(need(), { origin, username: String(l.username ?? ''), password: String(l.password ?? ''), note: l.note }, Date.now());
    if (r.result !== 'unchanged') save(r.data);
    return r.result;
  });
  ctx.handle('browser:vault:update', (id: string, patch: { username?: string; password?: string; note?: string }) => {
    save(editEntry(need(), String(id), { username: patch?.username, password: patch?.password || undefined, note: patch?.note }, Date.now()));
    return true;
  });
  ctx.handle('browser:vault:delete', (ids: string | string[]) => {
    const drop = new Set((Array.isArray(ids) ? ids : [ids]).map(String));
    const v = need();
    save({ ...v, entries: v.entries.filter(e => !drop.has(e.id)) });
    return true;
  });
  ctx.handle('browser:vault:export', async (): Promise<string | null> => {
    const v = need();
    if (!v.entries.length) throw new Error('There are no saved passwords to export.');
    const w = ctx.browserWindow();
    const warn: Electron.MessageBoxOptions = {
      type: 'warning', buttons: ['Export…', 'Cancel'], defaultId: 1, cancelId: 1, noLink: true, title: 'Export passwords',
      message: `Export ${v.entries.length} password${v.entries.length === 1 ? '' : 's'} to a plain-text file?`,
      detail: 'The CSV file is NOT encrypted: anyone or any program that can read it gets every password in it. Import it where you need it, then delete it.',
    };
    const ok = w ? await dialog.showMessageBox(w, warn) : await dialog.showMessageBox(warn);
    if (ok.response !== 0) return null;
    const o = { title: 'Export passwords', defaultPath: path.join(app.getPath('documents'), 'AICO Passwords.csv'), filters: [{ name: 'CSV', extensions: ['csv'] }] };
    const r = w ? await dialog.showSaveDialog(w, o) : await dialog.showSaveDialog(o);
    if (r.canceled || !r.filePath) return null;
    fs.writeFileSync(r.filePath, toPasswordCsv(v.entries), { encoding: 'utf8', mode: 0o600 });
    return r.filePath;
  });

  // Save offers.
  ctx.handle('browser:vault:answer', (id: string, answer: 'save' | 'never' | 'dismiss') => {
    const o = offers.get(String(id));
    if (!o) return false;
    dropOffer(String(id));
    if (answer === 'save') {
      const r = upsertLogin(need(), { origin: o.offer.origin, username: o.offer.username, password: o.password }, Date.now());
      if (r.result !== 'unchanged') save(r.data);
    } else if (answer === 'never') {
      const v = need();
      if (!v.never.includes(o.offer.origin)) save({ ...v, never: [...v.never, o.offer.origin] });
    }
    return true;
  });

  // The key in the address bar: the page in front, its logins (usernames only), and filling one.
  ctx.handle('browser:vault:forPage', (): VaultForPage | null => {
    const f = deps.front();
    if (!f || f.wc.isDestroyed()) return null;
    const url = f.wc.getURL();
    const origin = loginOrigin(url);
    if (!origin) return null;
    const s = status();
    const entries = s.available ? entriesFor(load(), url).map(e => ({ id: e.id, username: e.username })) : [];
    return { origin, secure: isSecureOrigin(origin), available: s.available, entries };
  });
  ctx.handle('browser:vault:fill', async (id: string) => {
    const f = deps.front();
    if (!f) throw new Error('There is no page to fill.');
    const n = await fill(f.wc, entry(String(id)));
    if (!n) throw new Error('No sign-in field on this page took the password. Click into the username or password field and try again.');
    return n;
  });

  return {
    status,
    addMany(logins) {
      let v = need();
      const counts: Record<UpsertResult, number> = { added: 0, updated: 0, unchanged: 0 };
      const now = Date.now();
      for (const l of logins) {
        try { const r = upsertLogin(v, l, now); v = r.data; counts[r.result]++; } catch { /* a row the vault cannot hold */ }
      }
      if (counts.added || counts.updated) save(v);
      return counts;
    },
    attach(ses) {
      try {
        fs.mkdirSync(deps.dataDir, { recursive: true });
        const pre = path.join(deps.dataDir, 'vault-preload.js');
        if (!fs.existsSync(pre) || fs.readFileSync(pre, 'utf8') !== VAULT_PRELOAD_JS) fs.writeFileSync(pre, VAULT_PRELOAD_JS);
        ses.registerPreloadScript({ type: 'frame', id: 'aico-vault', filePath: pre });
      } catch (err) {
        console.error('Password preload not installed:', (err as Error).message);
      }
    },
    guardAgent(wc) {
      if (filled.has(wc.id)) throw new Error('Refused: this page holds a password the user filled from their saved passwords. Scripts cannot run on it until it navigates — ask the user to continue, or use browser_snapshot / browser_click.');
    },
  };
}
