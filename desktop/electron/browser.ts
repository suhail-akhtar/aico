/**
 * The built-in browser — for you and for the agent.
 *
 * Tabs are `WebContentsView`s laid over the part of the window the interface
 * reserves for them. They live in their own persistent session partition, so
 * the agent's logins are neither the app's nor your everyday browser's, and
 * they persist across restarts (a second visit is already signed in).
 *
 * HOW THE AGENT DRIVES IT. Through the DevTools protocol on each tab
 * (`webContents.debugger`): `Input.dispatchMouseEvent`, `Input.insertText`,
 * `Input.dispatchKeyEvent`. Those are trusted events — a page cannot tell them
 * from a person — which is what makes real sign-in forms and React widgets
 * work where a synthetic `el.click()` does not. Elements are addressed by
 * `ref`s handed out by `snapshot()`, so the model never has to guess a CSS
 * selector.
 *
 * WHAT IT WILL NOT DO. Solve a CAPTCHA, or type a password it was not given.
 * `handoff()` shows you what the agent needs (a sign-in, an MFA code, a
 * CAPTCHA) and waits for you to press Done.
 *
 * @module desktop/electron/browser
 */

import { WebContentsView, session as electronSession, shell, type WebContents, type Session } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import type { DesktopContext } from './context';

export const BROWSER_PARTITION = 'persist:aico-browser';

export interface TabInfo {
  id: string;
  url: string;
  title: string;
  favicon?: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  active: boolean;
  zoom: number;
}

interface Tab {
  id: string;
  view: WebContentsView;
  favicon?: string;
  console: Array<{ level: string; text: string; source?: string; line?: number; at: number }>;
  network: Array<{ method: string; url: string; status: number; type: string; at: number; ms?: number }>;
  attached: boolean;
}

export interface BrowserService {
  tabs(): TabInfo[];
  open(url: string, opts?: { newTab?: boolean }): Promise<TabInfo>;
  /** Open a tab because the person asked (a context-menu link) — not the agent, so no access check. */
  openForUser(url: string): Promise<TabInfo>;
  snapshot(opts?: { full?: boolean }): Promise<string>;
  click(target: Target, opts?: { button?: 'left' | 'right'; double?: boolean }): Promise<string>;
  type(target: Target, text: string, opts?: { clear?: boolean; submit?: boolean }): Promise<string>;
  press(key: string): Promise<string>;
  select(target: Target, value: string): Promise<string>;
  scroll(opts: { direction?: 'up' | 'down' | 'left' | 'right'; amount?: number; target?: Target }): Promise<string>;
  hover(target: Target): Promise<string>;
  waitFor(opts: { text?: string; selector?: string; ms?: number; timeoutMs?: number }): Promise<string>;
  text(target?: Target): Promise<string>;
  evaluate(expression: string): Promise<unknown>;
  screenshot(opts?: { fullPage?: boolean }): Promise<{ path: string; dataUrl: string; width: number; height: number }>;
  consoleLog(clear?: boolean): string;
  networkLog(clear?: boolean): string;
  back(): Promise<string>;
  forward(): Promise<string>;
  reload(): Promise<string>;
  closeTab(id?: string): void;
  selectTab(id: string): void;
  handoff(message: string, timeoutMs?: number): Promise<string>;
}

export type Target = { ref?: string; selector?: string; text?: string };

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

/** The in-page half of `snapshot()`: tags interactive elements with refs and describes the page. */
const SNAPSHOT_JS = String.raw`(() => {
  const MAX = window.__aicoFull ? 600 : 250;
  let n = 0;
  document.querySelectorAll('[data-aico-ref]').forEach(e => e.removeAttribute('data-aico-ref'));
  const vis = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const s = getComputedStyle(el);
    return s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0.05;
  };
  const name = (el) => {
    const a = el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('alt') || el.getAttribute('placeholder');
    if (a) return a.trim();
    if (el.id) { const l = document.querySelector('label[for="' + CSS.escape(el.id) + '"]'); if (l) return l.innerText.trim(); }
    const lab = el.closest('label'); if (lab && lab !== el) return lab.innerText.trim();
    return (el.innerText || el.value || '').trim();
  };
  const role = (el) => {
    const r = el.getAttribute('role'); if (r) return r;
    const t = el.tagName.toLowerCase();
    if (t === 'a') return 'link';
    if (t === 'button' || t === 'summary') return 'button';
    if (t === 'select') return 'combobox';
    if (t === 'textarea') return 'textbox';
    if (t === 'input') {
      const ty = (el.getAttribute('type') || 'text').toLowerCase();
      if (['checkbox', 'radio'].includes(ty)) return ty;
      if (['submit', 'button', 'reset', 'image'].includes(ty)) return 'button';
      return ty === 'password' ? 'password' : 'textbox';
    }
    if (el.isContentEditable) return 'textbox';
    return 'clickable';
  };
  const sel = 'a[href], button, input:not([type=hidden]), select, textarea, summary, [role=button], [role=link], [role=tab], [role=menuitem], [role=checkbox], [role=switch], [role=option], [role=combobox], [contenteditable=true], [onclick], [tabindex]:not([tabindex="-1"])';
  const lines = [];
  for (const el of document.querySelectorAll(sel)) {
    if (n >= MAX) break;
    if (!vis(el)) continue;
    const ref = 'e' + (++n);
    el.setAttribute('data-aico-ref', ref);
    const r = role(el);
    let line = '[' + ref + '] ' + r + ' "' + name(el).replace(/\s+/g, ' ').slice(0, 80) + '"';
    if (r === 'textbox' || r === 'combobox') line += ' value="' + String(el.value ?? el.innerText ?? '').slice(0, 60) + '"';
    if (r === 'password') line += el.value ? ' (filled)' : ' (empty)';
    if (r === 'checkbox' || r === 'radio') line += el.checked ? ' checked' : ' unchecked';
    if (el.disabled) line += ' disabled';
    if (r === 'link') { const h = el.getAttribute('href') || ''; if (h && !h.startsWith('javascript')) line += ' -> ' + h.slice(0, 80); }
    const rect = el.getBoundingClientRect();
    if (rect.bottom < 0 || rect.top > innerHeight) line += ' (offscreen)';
    lines.push(line);
  }
  const heads = [...document.querySelectorAll('h1,h2,h3')].filter(vis).slice(0, 20).map(h => h.tagName.toLowerCase() + ': ' + h.innerText.trim().replace(/\s+/g, ' ').slice(0, 100));
  const main = (document.querySelector('main') || document.body);
  const text = (main ? main.innerText : '').replace(/\n{3,}/g, '\n\n').trim();
  const dialogs = [...document.querySelectorAll('dialog[open], [role=dialog], [role=alertdialog]')].filter(vis).map(d => (d.getAttribute('aria-label') || d.innerText || '').trim().slice(0, 160));
  return {
    title: document.title, url: location.href,
    scroll: { y: Math.round(scrollY), height: document.documentElement.scrollHeight, viewport: innerHeight },
    headings: heads, elements: lines, dialogs,
    text: text.slice(0, window.__aicoFull ? 12000 : 3500), truncated: text.length > (window.__aicoFull ? 12000 : 3500),
  };
})()`;

/** Find an element's centre for a trusted click, scrolling it into view first. */
function locateJs(t: Target): string {
  return `(() => {
    const t = ${JSON.stringify(t)};
    let el = null;
    if (t.ref) el = document.querySelector('[data-aico-ref="' + t.ref + '"]');
    if (!el && t.selector) { try { el = document.querySelector(t.selector); } catch (e) { return { error: 'Bad selector: ' + e.message }; } }
    if (!el && t.text) {
      const want = t.text.toLowerCase();
      const cands = [...document.querySelectorAll('a,button,[role=button],[role=link],[role=tab],[role=menuitem],label,summary,input[type=submit],input[type=button],li,span,div')];
      el = cands.find(c => (c.innerText || c.value || '').trim().toLowerCase() === want) || cands.find(c => (c.innerText || c.value || '').trim().toLowerCase().includes(want) && c.children.length < 4);
    }
    if (!el) return { error: 'No element matches ' + JSON.stringify(t) + '. Take a new snapshot — refs change when the page changes.' };
    el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, tag: el.tagName.toLowerCase(), label: (el.getAttribute('aria-label') || el.innerText || el.value || '').trim().slice(0, 60) };
  })()`;
}

interface KeyDef { key: string; code: string; keyCode: number; text?: string }
const KEYS: Record<string, KeyDef> = {
  enter: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
  tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
  escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
  backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
  delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
  arrowup: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  arrowdown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  arrowleft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  arrowright: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  home: { key: 'Home', code: 'Home', keyCode: 36 },
  end: { key: 'End', code: 'End', keyCode: 35 },
  pageup: { key: 'PageUp', code: 'PageUp', keyCode: 33 },
  pagedown: { key: 'PageDown', code: 'PageDown', keyCode: 34 },
  space: { key: ' ', code: 'Space', keyCode: 32, text: ' ' },
};

function parseKey(spec: string): { def: KeyDef; modifiers: number; commands: string[] } {
  const parts = spec.split('+').map(p => p.trim()).filter(Boolean);
  const last = (parts.pop() ?? spec).toLowerCase();
  let modifiers = 0;
  const commands: string[] = [];
  for (const m of parts.map(p => p.toLowerCase())) {
    if (m === 'alt') modifiers |= 1;
    else if (m === 'ctrl' || m === 'control') modifiers |= 2;
    else if (m === 'meta' || m === 'cmd') modifiers |= 4;
    else if (m === 'shift') modifiers |= 8;
  }
  const chord: Record<string, string> = { a: 'selectAll', c: 'copy', v: 'paste', x: 'cut', z: 'undo', y: 'redo' };
  if ((modifiers & 2 || modifiers & 4) && chord[last]) commands.push(chord[last]!);
  const def = KEYS[last] ?? (/^f([1-9]|1[0-2])$/.test(last)
    ? { key: last.toUpperCase(), code: last.toUpperCase(), keyCode: 111 + Number(last.slice(1)) }
    : { key: last.length === 1 ? last : last, code: last.length === 1 ? `Key${last.toUpperCase()}` : last, keyCode: last.toUpperCase().charCodeAt(0), text: modifiers & 6 ? undefined : last });
  return { def, modifiers, commands };
}

export function registerBrowser(ctx: DesktopContext): void {
  const tabs = new Map<string, Tab>();
  let activeId: string | null = null;
  let seq = 0;
  let bounds: { x: number; y: number; width: number; height: number } | null = null;
  let visible = false;
  let ses: Session | null = null;
  const handoffs = new Map<string, (answer: string) => void>();
  const shotsDir = path.join(ctx.paths.desktopDir, 'browser', 'screenshots');

  const getSession = (): Session => {
    if (ses) return ses;
    ses = electronSession.fromPartition(BROWSER_PARTITION);
    // Nothing is granted by default: no camera, mic, location or notifications for the agent's profile.
    ses.setPermissionRequestHandler((_wc, permission, cb) => cb(permission === 'clipboard-sanitized-write' || permission === 'fullscreen'));
    ses.on('will-download', (_e, item) => {
      const dir = path.join(ctx.paths.desktopDir, 'browser', 'downloads');
      fs.mkdirSync(dir, { recursive: true });
      item.setSavePath(path.join(dir, item.getFilename()));
      item.once('done', (_ev, state) => ctx.emit('browser:download', { file: item.getSavePath(), state }));
    });
    ses.webRequest.onCompleted((d) => {
      const tab = [...tabs.values()].find(t => t.view.webContents.id === d.webContentsId);
      if (!tab) return;
      tab.network.push({ method: d.method, url: d.url, status: d.statusCode, type: d.resourceType, at: Date.now() });
      if (tab.network.length > 400) tab.network.shift();
    });
    return ses;
  };

  const info = (t: Tab): TabInfo => {
    const wc = t.view.webContents;
    return {
      id: t.id, url: wc.getURL(), title: wc.getTitle() || wc.getURL() || 'New tab', favicon: t.favicon,
      loading: wc.isLoading(), canGoBack: wc.navigationHistory.canGoBack(), canGoForward: wc.navigationHistory.canGoForward(),
      active: t.id === activeId, zoom: wc.getZoomFactor(),
    };
  };
  const list = (): TabInfo[] => [...tabs.values()].map(info);
  const announce = (): void => ctx.emit('browser:tabs', list());

  const layout = (): void => {
    const win = ctx.window();
    if (!win) return;
    for (const t of tabs.values()) {
      const show = visible && t.id === activeId && bounds !== null;
      if (show && !t.attached) { win.contentView.addChildView(t.view); t.attached = true; }
      if (show) { t.view.setBounds(bounds!); t.view.setVisible(true); }
      else if (t.attached) { t.view.setVisible(false); }
    }
  };

  const create = (url?: string): Tab => {
    const view = new WebContentsView({
      webPreferences: {
        session: getSession(), sandbox: true, contextIsolation: true, nodeIntegration: false,
        backgroundThrottling: false, spellcheck: true,
      },
    });
    const id = `b${++seq}`;
    const tab: Tab = { id, view, console: [], network: [], attached: false };
    const wc = view.webContents;
    wc.setWindowOpenHandler(({ url: u }) => { void openUrl(u, { newTab: true }); return { action: 'deny' }; });
    wc.on('page-favicon-updated', (_e, icons) => { tab.favicon = icons[0]; announce(); });
    for (const ev of ['did-start-loading', 'did-stop-loading', 'page-title-updated', 'did-navigate', 'did-navigate-in-page'] as const) {
      wc.on(ev as 'did-start-loading', () => announce());
    }
    wc.on('did-fail-load', (_e, code, desc, u, isMain) => {
      if (isMain && code !== -3) ctx.emit('browser:error', { id, url: u, message: `${desc} (${code})` });
    });
    wc.on('console-message', (e) => {
      const d = e as unknown as { level: string | number; message: string; sourceId?: string; lineNumber?: number };
      const level = typeof d.level === 'number' ? ['verbose', 'info', 'warning', 'error'][d.level] ?? 'info' : d.level;
      tab.console.push({ level, text: d.message, source: d.sourceId, line: d.lineNumber, at: Date.now() });
      if (tab.console.length > 400) tab.console.shift();
    });
    wc.on('before-input-event', (_e, input) => {
      if (input.type === 'keyDown' && (input.control || input.meta) && input.key.toLowerCase() === 'l') ctx.emit('browser:focus-address');
    });
    tabs.set(id, tab);
    activeId = id;
    if (url) void wc.loadURL(normalise(url)).catch(() => {});
    layout();
    announce();
    return tab;
  };

  const active = (): Tab => {
    let t = activeId ? tabs.get(activeId) : undefined;
    if (!t) t = create();
    return t;
  };

  function normalise(u: string): string {
    const s = u.trim();
    if (/^(https?|file|about|data):/i.test(s)) return s;
    if (/^localhost(:\d+)?(\/|$)|^127\.0\.0\.1|^\[::1\]/.test(s)) return `http://${s}`;
    if (/^[\w-]+(\.[\w-]+)+(:\d+)?(\/.*)?$/.test(s)) return `https://${s}`;
    return `https://duckduckgo.com/?q=${encodeURIComponent(s)}`;
  }

  async function waitLoad(wc: WebContents, timeoutMs = 15000): Promise<void> {
    if (!wc.isLoading()) { await sleep(150); return; }
    await Promise.race([
      new Promise<void>(r => wc.once('did-stop-loading', () => r())),
      sleep(timeoutMs),
    ]);
    await sleep(250);
  }

  async function cdp<T = unknown>(wc: WebContents, method: string, params?: Record<string, unknown>): Promise<T> {
    if (!wc.debugger.isAttached()) {
      try { wc.debugger.attach('1.3'); } catch (err) { throw new Error(`Cannot control this tab: ${(err as Error).message}`); }
    }
    return wc.debugger.sendCommand(method, params) as Promise<T>;
  }

  async function evaluate<T = unknown>(wc: WebContents, expression: string): Promise<T> {
    const r = await cdp<{ result: { value?: T; description?: string }; exceptionDetails?: { text: string; exception?: { description?: string } } }>(
      wc, 'Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true },
    );
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value as T;
  }

  function checkAccess(): void {
    if (ctx.prefs.get().browserAgentAccess === 'deny') throw new Error('The user has not allowed the agent to use the built-in browser (Settings → Browser).');
    ctx.emit('browser:agent-active', { at: Date.now() });
  }

  async function locate(wc: WebContents, t: Target): Promise<{ x: number; y: number; label: string; tag: string }> {
    if (!t.ref && !t.selector && !t.text) throw new Error('Name an element: ref (from browser_snapshot), selector, or text.');
    const r = await evaluate<{ x: number; y: number; label: string; tag: string; error?: string }>(wc, locateJs(t));
    if (!r || r.error) throw new Error(r?.error ?? 'Element not found.');
    await sleep(60);
    return r;
  }

  async function mouseClick(wc: WebContents, x: number, y: number, button: 'left' | 'right' = 'left', clickCount = 1): Promise<void> {
    await cdp(wc, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    for (let i = 1; i <= clickCount; i++) {
      await cdp(wc, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, clickCount: i });
      await cdp(wc, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, clickCount: i });
    }
  }

  async function pressKey(wc: WebContents, spec: string): Promise<void> {
    const { def, modifiers, commands } = parseKey(spec);
    await cdp(wc, 'Input.dispatchKeyEvent', {
      type: def.text ? 'keyDown' : 'rawKeyDown', key: def.key, code: def.code, windowsVirtualKeyCode: def.keyCode,
      modifiers, text: def.text, unmodifiedText: def.text, commands,
    });
    await cdp(wc, 'Input.dispatchKeyEvent', { type: 'keyUp', key: def.key, code: def.code, windowsVirtualKeyCode: def.keyCode, modifiers });
  }

  async function settle(wc: WebContents): Promise<void> {
    await sleep(350);
    if (wc.isLoading()) await waitLoad(wc, 10000);
  }

  async function openUrl(url: string, opts?: { newTab?: boolean }): Promise<TabInfo> {
    const t = opts?.newTab || !activeId ? create() : active();
    activeId = t.id;
    const target = normalise(url);
    try { await t.view.webContents.loadURL(target); } catch (err) {
      const msg = (err as Error).message;
      if (!/ERR_ABORTED/.test(msg)) throw new Error(`Could not open ${target}: ${msg}`);
    }
    await waitLoad(t.view.webContents);
    layout();
    announce();
    return info(t);
  }

  const service: BrowserService = {
    tabs: list,
    async open(url, opts) { checkAccess(); return openUrl(url, opts); },
    openForUser(url) { return openUrl(url, { newTab: true }); },
    async snapshot(opts) {
      checkAccess();
      const wc = active().view.webContents;
      await waitLoad(wc, 8000);
      if (opts?.full) await evaluate(wc, 'window.__aicoFull = true');
      const s = await evaluate<{ title: string; url: string; scroll: { y: number; height: number; viewport: number }; headings: string[]; elements: string[]; dialogs: string[]; text: string; truncated: boolean }>(wc, SNAPSHOT_JS);
      await evaluate(wc, 'window.__aicoFull = false').catch(() => {});
      return [
        `Page: ${s.title || '(untitled)'}`,
        `URL: ${s.url}`,
        `Scroll: ${s.scroll.y}/${Math.max(0, s.scroll.height - s.scroll.viewport)}px`,
        s.dialogs.length ? `Open dialogs: ${s.dialogs.join(' | ')}` : '',
        s.headings.length ? `Headings:\n${s.headings.join('\n')}` : '',
        `Interactive elements (use the [ref] with browser_click / browser_type):\n${s.elements.join('\n') || '(none visible)'}`,
        `Visible text${s.truncated ? ' (truncated — use browser_text or scroll)' : ''}:\n${s.text}`,
      ].filter(Boolean).join('\n\n');
    },
    async click(target, opts) {
      checkAccess();
      const wc = active().view.webContents;
      const at = await locate(wc, target);
      await mouseClick(wc, at.x, at.y, opts?.button ?? 'left', opts?.double ? 2 : 1);
      await settle(wc);
      return `Clicked ${at.tag} "${at.label}". Now at ${wc.getURL()} — take a snapshot to see the result.`;
    },
    async type(target, text, opts) {
      checkAccess();
      const wc = active().view.webContents;
      const at = await locate(wc, target);
      await mouseClick(wc, at.x, at.y);
      if (opts?.clear !== false) {
        await pressKey(wc, process.platform === 'darwin' ? 'Meta+a' : 'Ctrl+a');
        await pressKey(wc, 'Backspace');
      }
      await cdp(wc, 'Input.insertText', { text });
      if (opts?.submit) { await pressKey(wc, 'Enter'); await settle(wc); }
      return `Typed ${text.length} character(s) into ${at.tag} "${at.label}"${opts?.submit ? ' and pressed Enter' : ''}.`;
    },
    async press(key) {
      checkAccess();
      const wc = active().view.webContents;
      await pressKey(wc, key);
      await settle(wc);
      return `Pressed ${key}.`;
    },
    async select(target, value) {
      checkAccess();
      const wc = active().view.webContents;
      await locate(wc, target);
      const r = await evaluate<string>(wc, `(() => {
        const t = ${JSON.stringify(target)};
        const el = t.ref ? document.querySelector('[data-aico-ref="' + t.ref + '"]') : document.querySelector(t.selector || 'select');
        if (!el || el.tagName !== 'SELECT') return 'That element is not a <select>; click it and choose an option instead.';
        const want = ${JSON.stringify(value)}.toLowerCase();
        const opt = [...el.options].find(o => o.value.toLowerCase() === want || o.text.trim().toLowerCase() === want) || [...el.options].find(o => o.text.toLowerCase().includes(want));
        if (!opt) return 'No option matches. Options: ' + [...el.options].map(o => o.text.trim()).join(', ');
        el.value = opt.value;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return 'Selected "' + opt.text.trim() + '".';
      })()`);
      await settle(wc);
      return r;
    },
    async scroll(opts) {
      checkAccess();
      const wc = active().view.webContents;
      if (opts.target) { const at = await locate(wc, opts.target); return `Scrolled ${at.tag} "${at.label}" into view.`; }
      const amount = opts.amount ?? 600;
      const dx = opts.direction === 'left' ? -amount : opts.direction === 'right' ? amount : 0;
      const dy = opts.direction === 'up' ? -amount : opts.direction === 'down' || !opts.direction ? amount : 0;
      const b = active().view.getBounds();
      await cdp(wc, 'Input.dispatchMouseEvent', { type: 'mouseWheel', x: Math.max(10, b.width / 2), y: Math.max(10, b.height / 2), deltaX: dx, deltaY: dy });
      await sleep(250);
      const y = await evaluate<number>(wc, 'Math.round(scrollY)');
      return `Scrolled ${opts.direction ?? 'down'} ${amount}px (now at ${y}px).`;
    },
    async hover(target) {
      checkAccess();
      const wc = active().view.webContents;
      const at = await locate(wc, target);
      await cdp(wc, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: at.x, y: at.y });
      await sleep(300);
      return `Hovering over ${at.tag} "${at.label}".`;
    },
    async waitFor(opts) {
      checkAccess();
      const wc = active().view.webContents;
      if (opts.ms && !opts.text && !opts.selector) { await sleep(Math.min(opts.ms, 20000)); return `Waited ${opts.ms}ms.`; }
      const deadline = Date.now() + Math.min(opts.timeoutMs ?? 10000, 25000);
      while (Date.now() < deadline) {
        const ok = await evaluate<boolean>(wc, `(() => {
          ${opts.selector ? `if (document.querySelector(${JSON.stringify(opts.selector)})) return true;` : ''}
          ${opts.text ? `if (document.body && document.body.innerText.toLowerCase().includes(${JSON.stringify(opts.text.toLowerCase())})) return true;` : ''}
          return false;
        })()`).catch(() => false);
        if (ok) return `Found ${opts.text ? `"${opts.text}"` : opts.selector}.`;
        await sleep(300);
      }
      throw new Error(`Timed out waiting for ${opts.text ? `"${opts.text}"` : opts.selector}.`);
    },
    async text(target) {
      checkAccess();
      const wc = active().view.webContents;
      const t = await evaluate<string>(wc, target ? `(() => {
        const t = ${JSON.stringify(target)};
        const el = t.ref ? document.querySelector('[data-aico-ref="' + t.ref + '"]') : t.selector ? document.querySelector(t.selector) : null;
        return el ? el.innerText : 'No such element.';
      })()` : 'document.body ? document.body.innerText : ""');
      return (t ?? '').slice(0, 40000);
    },
    async evaluate(expression) {
      checkAccess();
      return evaluate(active().view.webContents, expression);
    },
    async screenshot(opts) {
      checkAccess();
      const t = active();
      const wc = t.view.webContents;
      let dataUrl: string; let width: number; let height: number;
      if (opts?.fullPage) {
        const m = await cdp<{ contentSize: { width: number; height: number } }>(wc, 'Page.getLayoutMetrics');
        const w = Math.min(4000, Math.ceil(m.contentSize.width)); const h = Math.min(12000, Math.ceil(m.contentSize.height));
        const r = await cdp<{ data: string }>(wc, 'Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: 0, y: 0, width: w, height: h, scale: 1 } });
        dataUrl = `data:image/png;base64,${r.data}`; width = w; height = h;
      } else {
        const r = await cdp<{ data: string }>(wc, 'Page.captureScreenshot', { format: 'png' });
        dataUrl = `data:image/png;base64,${r.data}`;
        const b = t.view.getBounds(); width = b.width; height = b.height;
      }
      fs.mkdirSync(shotsDir, { recursive: true });
      const file = path.join(shotsDir, `shot-${new Date().toISOString().replace(/[:.]/g, '-')}.png`);
      fs.writeFileSync(file, Buffer.from(dataUrl.split(',')[1]!, 'base64'));
      return { path: file, dataUrl, width, height };
    },
    consoleLog(clear) {
      const t = active();
      const out = t.console.slice(-120).map(c => `[${c.level}] ${c.text}${c.source ? ` (${path.basename(c.source)}:${c.line ?? 0})` : ''}`).join('\n');
      if (clear) t.console = [];
      return out || '(no console messages)';
    },
    networkLog(clear) {
      const t = active();
      const out = t.network.slice(-150).map(n => `${n.status} ${n.method} ${n.type} ${n.url.slice(0, 180)}`).join('\n');
      if (clear) t.network = [];
      return out || '(no requests recorded)';
    },
    async back() { const wc = active().view.webContents; if (wc.navigationHistory.canGoBack()) { wc.navigationHistory.goBack(); await settle(wc); } return wc.getURL(); },
    async forward() { const wc = active().view.webContents; if (wc.navigationHistory.canGoForward()) { wc.navigationHistory.goForward(); await settle(wc); } return wc.getURL(); },
    async reload() { const wc = active().view.webContents; wc.reload(); await waitLoad(wc); return wc.getURL(); },
    closeTab(id) {
      const t = tabs.get(id ?? activeId ?? '');
      if (!t) return;
      const win = ctx.window();
      if (t.attached && win) win.contentView.removeChildView(t.view);
      t.view.webContents.close();
      tabs.delete(t.id);
      if (activeId === t.id) activeId = [...tabs.keys()].pop() ?? null;
      layout(); announce();
    },
    selectTab(id) { if (tabs.has(id)) { activeId = id; layout(); announce(); } },
    handoff(message, timeoutMs = 10 * 60_000) {
      const id = `h${Date.now()}`;
      ctx.emit('browser:handoff', { id, message });
      ctx.reveal();
      return new Promise<string>((resolve) => {
        const timer = setTimeout(() => { handoffs.delete(id); resolve('The user did not respond in time.'); }, timeoutMs);
        handoffs.set(id, (answer) => { clearTimeout(timer); resolve(answer); });
      });
    },
  };
  ctx.services.browser = service;

  // ── Interface ──
  ctx.handle('browser:tabs', () => list());
  ctx.handle('browser:open', (url: string, newTab?: boolean) => openUrl(url, { newTab }));
  ctx.handle('browser:newTab', (url?: string) => { const t = create(url || ctx.prefs.get().browserHome); return info(t); });
  ctx.handle('browser:close', (id: string) => service.closeTab(id));
  ctx.handle('browser:select', (id: string) => service.selectTab(id));
  ctx.handle('browser:back', () => service.back());
  ctx.handle('browser:forward', () => service.forward());
  ctx.handle('browser:reload', () => { active().view.webContents.reload(); });
  ctx.handle('browser:stop', () => { active().view.webContents.stop(); });
  ctx.handle('browser:zoom', (delta: number) => {
    const wc = active().view.webContents;
    wc.setZoomFactor(delta === 0 ? 1 : Math.max(0.3, Math.min(3, wc.getZoomFactor() + delta)));
    announce();
  });
  ctx.handle('browser:devtools', () => active().view.webContents.toggleDevTools());
  ctx.handle('browser:external', () => { const u = active().view.webContents.getURL(); if (/^https?:/.test(u)) void shell.openExternal(u); });
  ctx.handle('browser:setBounds', (b: { x: number; y: number; width: number; height: number } | null, show: boolean) => {
    bounds = b ? { x: Math.round(b.x), y: Math.round(b.y), width: Math.max(1, Math.round(b.width)), height: Math.max(1, Math.round(b.height)) } : null;
    visible = show && b !== null;
    if (visible && tabs.size === 0) create(ctx.prefs.get().browserHome);
    layout();
  });
  ctx.handle('browser:screenshot', () => service.screenshot());
  ctx.handle('browser:handoffDone', (id: string, answer?: string) => {
    const done = handoffs.get(id);
    handoffs.delete(id);
    done?.(answer || 'The user says it is done.');
  });
  ctx.handle('browser:clearData', async () => {
    await getSession().clearStorageData();
    await getSession().clearCache();
    return true;
  });
  ctx.handle('browser:console', () => service.consoleLog());
  ctx.handle('browser:network', () => service.networkLog());
}
