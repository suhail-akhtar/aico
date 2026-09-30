/**
 * The built-in browser's passwords — now logins in AICO's one credential vault.
 *
 * STORAGE. Since 0.29 there is one vault: the engine's credential broker
 * (src/vault, docs/security/credential-broker.md). A login saved in the
 * browser is an engine `login` credential whose policy carries the browser's
 * rules — exactly its origin, the browser tools only, asked once a session
 * when the agent uses it (browser-vault-unify.ts). The 0.28.0 store
 * (`<AICO_HOME>/desktop/browser/vault.bin`, safeStorage-sealed) is moved in
 * once, verified, and kept beside itself as `vault.bin.migrated-<date>`; it is
 * never read again and never backed up.
 *
 * WHAT CROSSES WHICH LINE.
 *   - The interface gets origins, names and usernames. It never gets a value:
 *     Reveal and Copy go through the Credential Manager's native confirmation
 *     in main (credential-manager.ts).
 *   - A web page gets one login, sent to the frame by main, only when the
 *     person picks it (the key in the address bar, or the chooser that opens
 *     when they click an empty sign-in field) — or when the agent asks for a
 *     stored credential by name with `browser_login` (browser.ts) — and only
 *     if `canFill` agrees here AND the engine's policy agrees there: the exact
 *     origin, https (or http where the credential's own policy allows it for
 *     a private address), never another site's frame.
 *   - The model gets nothing: it may *ask* for a fill by name; the value goes
 *     engine → main → page over the private port and trusted input.
 *
 * DETECTING A SIGN-IN. A small preload, in its own isolated world in every
 * frame (the page's scripts cannot see or change it), notices a submitted form
 * with a password in it and tells main; main asks "Save password?" — never
 * saves silently. The same preload reports a click into an empty sign-in field
 * (for the chooser) and does the person's fills.
 *
 * @module desktop/electron/browser-vault
 */

import { app, ipcMain, Menu, safeStorage, type MenuItemConstructorOptions, type Session, type WebContents, type WebContentsView } from 'electron';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { DesktopContext } from './context';
import type { VaultForPage, VaultOffer, VaultStatus } from '../shared/browser-types';
import { canFill, isSecureOrigin, loginOrigin, openVault, type VaultCipher } from './browser-vault-core';
import { BROWSER_TAG, credentialNameFor, loginCreateBody, planMigration, verifyMigration, webOrigin, type ExistingCredential, type LegacyEntry } from './browser-vault-unify';

export const VAULT_CHANNEL = 'aico-vault';
const FILL_CHANNEL = 'aico-vault:fill';

/** A login the vault holds for an origin, as the browser needs it: never a value. */
export interface OriginLogin { id: string; name: string; username: string; allowSelfSigned: boolean }

export interface MigrationReport { found: number; created: number; already: number; unusable: number; failed: Array<{ entry: string; reason: string }>; backup?: string; verified: boolean }

export interface VaultService {
  status(): Promise<VaultStatus>;
  /** Add logins (the CSV import). */
  addMany(logins: Array<{ origin: string; username: string; password: string; note?: string; created?: number }>): Promise<{ added: number; updated: number; unchanged: number }>;
  /** Register the page preload on the browser's session. */
  attach(ses: Session): void;
  /** Throws while this page holds a password AICO filled (for browser_evaluate). */
  guardAgent(wc: WebContents): void;
  /** A password was typed into this page by AICO (browser_login): scripts stay off it until it navigates. */
  markFilled(wc: WebContents): void;
  /** Logins bound to exactly this origin (names and usernames). */
  loginsFor(origin: string): Promise<OriginLogin[]>;
  /** Move the 0.28.0 store in (idempotent). */
  migrate(): Promise<MigrationReport | null>;
  /** Remember a value AICO put into a page, so the save offer after that sign-in is not repeated. */
  noteKnown(origin: string, username: string, password: string): void;
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
    m.password = '';
    ipcRenderer.send(CH, { op: 'filled', token: m && m.token, n });
  });
})();
`;

/** safeStorage, only to read the 0.28.0 file once — refusing Linux's fixed-key fallback. */
const legacyCipher: VaultCipher = {
  available() {
    if (!app.isReady() || !safeStorage.isEncryptionAvailable()) return false;
    if (process.platform === 'linux') {
      try {
        const backend = (safeStorage as unknown as { getSelectedStorageBackend?: () => string }).getSelectedStorageBackend?.();
        if (backend === 'basic_text' || backend === 'unknown') return false;
      } catch { /* older Electron */ }
    }
    return true;
  },
  encrypt: (s) => safeStorage.encryptString(s),
  decrypt: (b) => safeStorage.decryptString(b),
};

interface Summary { id: string; name: string; kind: string; username?: string; url?: string; tags: string[]; policy: { allowSelfSigned?: boolean } }

export function registerVault(ctx: DesktopContext, deps: VaultDeps): VaultService {
  const legacyFile = path.join(deps.dataDir, 'vault.bin');
  const neverFile = path.join(deps.dataDir, 'passwords-never.json');
  const host = (): NonNullable<DesktopContext['services']['vaultHost']> => {
    if (!ctx.services.vaultHost) throw new Error('The credential vault is not available.');
    return ctx.services.vaultHost;
  };
  const hostOf = (origin: string): string => { try { return new URL(origin).host; } catch { return origin; } };

  // ── The "never offer to save here" list (origins; not secret) ──
  const readNever = (): string[] => {
    try { const v = JSON.parse(fs.readFileSync(neverFile, 'utf8')) as unknown; return Array.isArray(v) ? v.filter((o): o is string => typeof o === 'string' && loginOrigin(o) === o) : []; } catch { return []; }
  };
  const writeNever = (list: string[]): void => {
    fs.mkdirSync(deps.dataDir, { recursive: true });
    fs.writeFileSync(neverFile, JSON.stringify([...new Set(list)], null, 1));
  };

  // ── Values AICO itself has put in or saved this run, so a sign-in with the
  //    same value is not offered for saving again. Salted hashes in memory only.
  const salt = crypto.randomBytes(16);
  const known = new Map<string, string>();
  const digest = (v: string): string => crypto.createHmac('sha256', salt).update(v).digest('base64');
  const noteKnown = (origin: string, username: string, password: string): void => { known.set(`${origin}\u0000${username}`, digest(password)); };

  // ── Engine calls (metadata only, except create/rotate which carry a value IN) ──
  const status = async (): Promise<VaultStatus> => {
    if (host().locked()) return { available: false, reason: 'The credential vault is locked. Unlock it in Settings → Credentials & passwords.', count: 0 };
    try {
      const r = await ctx.engine.call<{ exists?: boolean; unlocked?: boolean; count?: number; error?: string }>('vault/status');
      if (r.status >= 400) return { available: false, reason: r.json.error ?? 'The credential vault is not available.', count: 0 };
      return { available: true, count: r.json.count ?? 0 };
    } catch (err) {
      return { available: false, reason: (err as Error).message, count: 0 };
    }
  };
  const loginsFor = async (origin: string): Promise<OriginLogin[]> => {
    const r = await ctx.engine.call<{ credentials?: Summary[] }>(`vault/match?origin=${encodeURIComponent(origin)}`);
    if (r.status >= 400) return [];
    // Exactly this origin: a login bound by host alone is not offered for a page.
    return (r.json.credentials ?? [])
      .filter(c => c.kind === 'login' || c.kind === 'basic-auth' || c.kind === 'generic')
      .map(c => ({ id: c.id, name: c.name, username: c.username ?? '', allowSelfSigned: c.policy?.allowSelfSigned === true }));
  };
  const takenNames = async (): Promise<Set<string>> => {
    const r = await ctx.engine.call<{ credentials?: Array<{ name: string }> }>('vault/list');
    return new Set((r.json.credentials ?? []).map(c => c.name));
  };
  /** Save or update one login the person chose to keep. */
  const saveLogin = async (l: { origin: string; username: string; password: string }, opts: { personConfirmedUpdate?: boolean } = {}): Promise<'added' | 'updated' | 'unchanged'> => {
    const origin = webOrigin(l.origin);
    if (!origin) throw new Error('A saved password needs a web address (https://…).');
    if (!l.password) throw new Error('There is no password to save.');
    const same = (await loginsFor(origin)).find(x => x.username === l.username.trim());
    if (same) {
      if (known.get(`${origin}\u0000${same.username}`) === digest(l.password)) return 'unchanged';
      if (!opts.personConfirmedUpdate) return 'unchanged';
      // The person pressed "Update" on the offer main made for this exact
      // sign-in (a submit the page's isolated preload captured from their own
      // typing): that click is the human act the rotate grant stands for.
      const r = await ctx.engine.call<{ error?: string }>('vault/rotate', { id: same.id, secret: { password: l.password }, grant: host().mintGrant('rotate', same.id) });
      if (r.status >= 400) throw new Error(r.json.error ?? 'The password could not be updated.');
      noteKnown(origin, same.username, l.password);
      return 'updated';
    }
    const name = credentialNameFor(origin, l.username.trim(), await takenNames());
    const r = await ctx.engine.call<{ error?: string }>('vault/create', loginCreateBody({ origin, username: l.username.trim(), password: l.password }, name));
    if (r.status >= 400) throw new Error(r.json.error ?? 'The password could not be saved.');
    noteKnown(origin, l.username.trim(), l.password);
    return 'added';
  };

  // ── Filling a page (the person's own fill) ──
  const filled = new Set<number>();
  const waiting = new Map<string, (n: number) => void>();
  let fillSeq = 0;
  const markFilled = (wc: WebContents): void => {
    if (filled.has(wc.id)) return;
    filled.add(wc.id);
    const clear = (d: { isMainFrame: boolean; isSameDocument: boolean }): void => {
      if (!d.isMainFrame || d.isSameDocument) return;
      filled.delete(wc.id);
      wc.off('did-start-navigation', clear);
    };
    wc.on('did-start-navigation', clear);
    wc.once('destroyed', () => filled.delete(wc.id));
  };
  /**
   * `policyAllowsHttp`: the engine resolved this login for this exact http
   * origin, which its policy allows only for an explicit http:// origin on a
   * private address (or an owner's allowInsecureHttp) — canFill still checks
   * the address is private here, in main.
   */
  const fillFrames = async (wc: WebContents, login: { origin: string; username: string; password: string }, opts: { policyAllowsHttp?: boolean } = {}): Promise<number> => {
    if (wc.isDestroyed()) return 0;
    const top = wc.mainFrame;
    const verdict = canFill(login.origin, top.url, top.url, opts);
    if (!verdict.ok) throw new Error(verdict.reason);
    // The top frame, and frames of the very same origin inside it — never another site's frame.
    const frames = top.framesInSubtree.filter(f => canFill(login.origin, top.url, f.url, opts).ok && f.origin === login.origin);
    let n = 0;
    for (const f of frames) {
      const token = `f${++fillSeq}`;
      const done = new Promise<number>((resolve) => {
        waiting.set(token, resolve);
        setTimeout(() => { waiting.delete(token); resolve(0); }, 1500);
      });
      try { f.send(FILL_CHANNEL, { token, origin: login.origin, username: login.username, password: login.password }); } catch { waiting.delete(token); continue; }
      n += await done;
      if (n) break;
    }
    if (n) markFilled(wc);
    return n;
  };
  /** The person picked a login (key icon, chooser): the engine resolves it for this origin, main fills it. */
  const personFill = async (wc: WebContents, name: string): Promise<number> => {
    const origin = loginOrigin(wc.getURL());
    if (!origin) throw new Error('This page has no web address a password can belong to.');
    host().expectPersonFill(origin, name);
    const reply = await host().requestFill({ origin, name, tool: 'Browser', purpose: `fill ${name} into ${hostOf(origin)} (you chose it)` });
    if (!reply.ok || !reply.fields) throw new Error(reply.reason ?? 'The vault refused.');
    const login = { origin, username: reply.username ?? '', password: reply.fields.password ?? reply.fields.value ?? '' };
    reply.fields = {};
    try {
      const n = await fillFrames(wc, login, { policyAllowsHttp: true });
      if (n) noteKnown(origin, login.username, login.password);
      return n;
    } finally { login.password = ''; }
  };

  // ── Offers to save ──
  const offers = new Map<string, { offer: VaultOffer; password: string; timer: NodeJS.Timeout }>();
  let offerSeq = 0;
  const dropOffer = (id: string): void => { const o = offers.get(id); if (o) { o.password = ''; clearTimeout(o.timer); offers.delete(id); } };

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
      const password = msg.password;
      const username = typeof msg.username === 'string' ? msg.username.trim().slice(0, 500) : '';
      void (async () => {
        if (readNever().includes(origin)) return;
        const st = await status();
        if (!st.available) return;
        const same = (await loginsFor(origin).catch(() => [])).find(x => x.username === username);
        if (same && known.get(`${origin}\u0000${username}`) === digest(password)) return;
        for (const [id, o] of offers) if (o.offer.tabId === tab.id) dropOffer(id);
        const offer: VaultOffer = { id: `o${++offerSeq}`, tabId: tab.id, origin, username, update: Boolean(same) };
        offers.set(offer.id, { offer, password, timer: setTimeout(() => { dropOffer(offer.id); ctx.emit('browser:vault:offerGone', offer.id); }, 5 * 60_000) });
        ctx.emit('browser:vault:offer', offer);
      })().catch(() => { /* the vault was unavailable: no offer */ });
      return;
    }

    if (msg.op === 'pick' && msg.rect) {
      if (deps.agentDriving(e.sender.id)) return;
      const wc = e.sender;
      const rect = msg.rect;
      void loginsFor(origin).then((list) => {
        if (!list.length || !canFill(origin, frame.url).ok || wc.isDestroyed()) return;
        const b = tab.view.getBounds();
        const z = wc.getZoomFactor();
        const x = Math.round(b.x + (Number(rect.x) || 0) * z);
        const y = Math.round(b.y + (Number(rect.y) || 0) * z + 2);
        const template: MenuItemConstructorOptions[] = [
          { label: `Saved passwords for ${hostOf(origin)}`, enabled: false },
          ...list.slice(0, 12).map((x): MenuItemConstructorOptions => ({
            label: x.username || '(no username)', sublabel: x.username ? undefined : 'password only',
            click: () => { void personFill(wc, x.name).catch(() => { /* navigated away, or refused */ }); },
          })),
          { type: 'separator' },
          { label: 'Manage passwords…', click: () => ctx.emit('browser:vault:manage') },
        ];
        Menu.buildFromTemplate(template).popup({ window: ctx.browserWindow() ?? undefined, x, y });
      }).catch(() => { /* no vault: no chooser */ });
    }
  });

  // ── IPC for the interface (never a value) ──
  ctx.handle('browser:vault:status', () => status());
  ctx.handle('browser:vault:never', () => readNever());
  ctx.handle('browser:vault:neverRemove', (origin: string) => { writeNever(readNever().filter(o => o !== origin)); ctx.emit('browser:vault:changed', {}); return true; });
  ctx.handle('browser:vault:answer', async (id: string, answer: 'save' | 'never' | 'dismiss') => {
    const o = offers.get(String(id));
    if (!o) return false;
    const { offer, password } = o;
    dropOffer(String(id));
    if (answer === 'save') {
      await saveLogin({ origin: offer.origin, username: offer.username, password }, { personConfirmedUpdate: offer.update });
      ctx.emit('browser:vault:changed', {});
    } else if (answer === 'never') {
      if (!readNever().includes(offer.origin)) writeNever([...readNever(), offer.origin]);
    }
    return true;
  });
  // The key in the address bar: the page in front, its logins (usernames only), and filling one.
  ctx.handle('browser:vault:forPage', async (): Promise<VaultForPage | null> => {
    const f = deps.front();
    if (!f || f.wc.isDestroyed()) return null;
    const url = f.wc.getURL();
    const origin = loginOrigin(url);
    if (!origin) return null;
    const s = await status();
    const entries = s.available ? (await loginsFor(origin).catch(() => [])).map(e => ({ id: e.name, username: e.username })) : [];
    return { origin, secure: isSecureOrigin(origin) || entries.length > 0, available: s.available, entries };
  });
  ctx.handle('browser:vault:fill', async (name: string) => {
    const f = deps.front();
    if (!f) throw new Error('There is no page to fill.');
    const n = await personFill(f.wc, String(name));
    if (!n) throw new Error('No sign-in field on this page took the password. Click into the username or password field and try again.');
    return n;
  });
  // Changes in the vault (any client, the agent) reach the key icon and the Passwords view.
  ctx.engine.on('message', (m: { type?: string }) => { if (m?.type === 'vault/changed') ctx.emit('browser:vault:changed', {}); });

  // ── Moving the 0.28.0 store in, once ──
  let migrating: Promise<MigrationReport | null> | null = null;
  const migrate = (): Promise<MigrationReport | null> => {
    migrating ??= (async (): Promise<MigrationReport | null> => {
      if (!fs.existsSync(legacyFile)) return null;
      if (!legacyCipher.available()) return null;
      let data;
      try { data = openVault(fs.readFileSync(legacyFile), legacyCipher); }
      catch { return null; /* left exactly as it is, as 0.28.0 did */ }
      const entries = data.entries as LegacyEntry[];
      if (data.never.length) writeNever([...readNever(), ...data.never]);
      const existing = async (): Promise<ExistingCredential[]> => {
        const r = await ctx.engine.call<{ credentials?: ExistingCredential[] }>('vault/list');
        if (r.status >= 400) throw new Error('vault unavailable');
        return r.json.credentials ?? [];
      };
      const plan = planMigration(entries, await existing());
      const report: MigrationReport = { found: entries.length, created: 0, already: plan.already.length, unusable: plan.unusable.length, failed: [], verified: false };
      for (const c of plan.create) {
        const r = await ctx.engine.call<{ error?: string }>('vault/create', c.body);
        c.body.secret = {};
        if (r.status >= 400) report.failed.push({ entry: c.entryId, reason: r.json.error ?? `HTTP ${r.status}` });
        else if (c.body.kind === 'login') report.created++;
      }
      const missing = verifyMigration(entries, await existing());
      report.verified = missing.length === 0;
      for (const e of entries) e.password = '';
      // The old file is kept as it was, beside itself, and never read again.
      if (report.verified) {
        const backup = `${legacyFile}.migrated-${new Date().toISOString().slice(0, 10)}`;
        fs.renameSync(legacyFile, fs.existsSync(backup) ? `${backup}-${Date.now()}` : backup);
        report.backup = path.basename(backup);
      }
      fs.writeFileSync(path.join(deps.dataDir, 'vault-migration.json'), JSON.stringify({ at: new Date().toISOString(), ...report }, null, 1));
      ctx.emit('browser:vault:changed', {});
      ctx.emit('vault:migrated', report);
      return report;
    })().catch(() => null).finally(() => { migrating = null; });
    return migrating;
  };
  // After the engine has its key (vault/ready), or on any engine start when no key is injected.
  ctx.engine.on('message', (m: { type?: string }) => { if (m?.type === 'vault/ready') void migrate(); });
  ctx.engine.on('engine-ready', () => { setTimeout(() => { if (!ctx.services.vaultHost?.keyAvailable()) void migrate(); }, 1500); });

  return {
    status,
    async addMany(logins) {
      const counts = { added: 0, updated: 0, unchanged: 0 };
      const taken = await takenNames();
      const byOrigin = new Map<string, OriginLogin[]>();
      for (const l of logins) {
        const origin = webOrigin(l.origin);
        if (!origin || !l.password) continue;
        try {
          if (!byOrigin.has(origin)) byOrigin.set(origin, await loginsFor(origin));
          if (byOrigin.get(origin)!.some(x => x.username === (l.username ?? '').trim())) { counts.unchanged++; continue; }
          const name = credentialNameFor(origin, (l.username ?? '').trim(), taken);
          taken.add(name);
          const body = loginCreateBody({ origin, username: (l.username ?? '').trim(), password: l.password }, name);
          const r = await ctx.engine.call<{ error?: string }>('vault/create', body);
          body.secret = {};
          if (r.status < 400) { counts.added++; byOrigin.get(origin)!.push({ id: '', name, username: (l.username ?? '').trim(), allowSelfSigned: false }); }
        } catch { /* a row the vault cannot hold */ }
      }
      if (counts.added) ctx.emit('browser:vault:changed', {});
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
      if (filled.has(wc.id)) throw new Error('Refused: this page holds a password filled from the vault. Scripts cannot run on it until it navigates — use browser_snapshot / browser_click, or ask the user to continue.');
    },
    markFilled,
    loginsFor,
    migrate,
    noteKnown,
  };
}

export { BROWSER_TAG };
