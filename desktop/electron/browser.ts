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
 * selector. Page understanding (reader Markdown, forms, extraction, insights)
 * is browser-page.ts, run in the page; its verdicts are made here.
 *
 * WHAT IT WILL NOT DO (browser-safety.ts decides, in main):
 *   - act on a page with a CAPTCHA / "verify you are human" check — every
 *     action there is refused with a hand-over hint;
 *   - type into password, card-number, CVV or one-time-code fields — the
 *     agent never sees or types a secret; `login()` (browser_login) asks the
 *     vault for a stored credential by NAME for the page's exact origin and
 *     AICO types it itself (browser-login.ts);
 *   - press a control that buys, pays, books, sends or deletes without the
 *     person allowing it in an AICO prompt (browser-commit-gate.ts);
 *   - upload a file, or download a program, without the user confirming;
 *   - answer an HTTP sign-in prompt, or accept a bad certificate — except a
 *     self-signed one on a private address whose exact origin a stored
 *     credential allows it for (`allowSelfSigned`), pinned on first sight.
 * `handoff()` shows you what the agent needs and waits for you to press Done.
 * Stop / Take over (`browser:agentStop`) makes every agent tool refuse until
 * `browser:agentResume`.
 *
 * Everything the interface shows comes from one pushed `browser:state`
 * (see shared/browser-types.ts for the whole IPC contract).
 *
 * @module desktop/electron/browser
 */

import { app, dialog, ipcMain, shell, WebContentsView, session as electronSession, type BrowserWindow, type WebContents, type Session } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import type { DesktopContext } from './context';
import type {
  AgentEvent, BrowserState, ConfirmRequest, DialogRequest, DownloadItem, ExtractKind, FindRequest,
  FindResult, FormModel, HistoryEntry, HistoryListOptions, PageInsights, PageRead, PageStill, PermissionSetting, SecurityState, SiteInfo, TabState,
  ConcealedReport, InjectionGuardInfo,
} from '../shared/browser-types';
import { aicoPage } from './browser-page';
import { guardPageText, withNotice } from '../../shared/injection-guard';
import { originOf, shouldBlock } from './browser-trackers';
import {
  classifySensitiveField, describeChange, detectHumanCheck, HUMAN_CHECK_SELECTORS, humanCheckRefusal, sensitiveRefusal,
  type FieldDescriptor, type HumanCheck, type HumanCheckSignals, type PageProbe,
} from './browser-safety';
import {
  asArray, clearHistory, DEFAULT_SETTINGS, flattenBookmarks, JsonFile, normaliseSettings, recordVisit, removeHistory,
  searchHistory, touchVisit, type BrowserSettings,
} from './browser-store';
import {
  buildInsights, findContacts, findPrices, finishForms, formatSnapshot, matchField, tableToMarkdown,
  type InsightSignals, type SnapshotRaw,
} from './browser-extract';
import { createDownloads } from './browser-downloads';
import { createPrivacy } from './browser-privacy';
import { createLearning } from './browser-learn';
import { createMemory } from './browser-memory';
import { createTabAwareness } from './browser-tab-summary';
import { registerBookmarks } from './browser-bookmarks';
import { browserShortcutSpec } from './browser-keys';
import { DIALOG_CHANNEL, installDialogPreload } from './browser-preload';
import { AICO_WORLD, openBrowserSession, registerTabSession, type TabSession } from './browser-session';
import { registerAutofill, type AutofillService } from './browser-autofill-store';
import { registerVault } from './browser-vault';
import { registerImport } from './browser-import';
import { classifyCommit, commitQuestion, type CommitSignals, type CommitVerdict } from './browser-commit-gate';
import { isRealPasswordField, isUsernameField, loginFormJs, passwordOf, type LoginFormReport } from './browser-login';
import { isPrivateOrigin, loginOrigin } from './browser-vault-core';
import { PAGE_SIGNALS_JS, type PageSignals } from '../shared/page-signals';

/** The profile's older home (Electron's partition); it now lives in <AICO_HOME>/desktop/browser/profile — see browser-session.ts. */
export const BROWSER_PARTITION = 'persist:aico-browser';

/** The earlier tab shape (`browser:tabs`), kept for the interface that still reads it. */
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
  /** The last viewport capture, served as the still while the view is hidden. */
  lastStill?: { dataUrl: string; width: number; height: number };
  favicon?: string;
  console: Array<{ level: string; text: string; source?: string; line?: number; at: number }>;
  network: Array<{ method: string; url: string; status: number; type: string; at: number; ms?: number }>;
  attached: boolean;
  trackers: Set<string>;
  trackersBlocked: number;
  popupsBlocked: number;
  agentUntil: number;
  humanCheck: boolean;
  error?: { code: number; description: string; url: string };
  certError?: { url: string; error: string; issuer: string };
  httpStatus?: number;
  lastGestureAt: number;
  inflight: Set<number>;
  lastNetAt: number;
  pageEnabled: boolean;
  dialog?: DialogRequest;
  /** Redo the last navigation the page's beforeunload blocked. */
  lastNav?: () => void;
  allowUnload: boolean;
  // Tabs like a real browser (browser-session.ts).
  pinned?: boolean;
  openerId?: string;
  deferred?: import('./browser-session-core').SavedTab;
  throttled?: boolean;
  /** Prompt-injection guard: what the page script dropped on the last read/snapshot, and the page's totals (Shields). */
  guardPending?: { url: string; report: ConcealedReport };
  guard?: InjectionGuardInfo;
}

export type Target = { ref?: string; selector?: string; text?: string };

export interface FillSpec { ref?: string; label?: string; name?: string; value: string | boolean }

export interface BrowserService {
  tabs(): TabInfo[];
  state(): BrowserState;
  open(url: string, opts?: { newTab?: boolean }): Promise<TabInfo>;
  /** Open a tab because the person asked (a context-menu link) — not the agent, so no access check. `opener` is the page's web contents id. */
  openForUser(url: string, opts?: { background?: boolean; opener?: number }): Promise<TabInfo>;
  /** Fill the form from the user's saved autofill profile (never passwords, cards, CVVs or codes; never submits). */
  autofill(opts?: { addressId?: string }): Promise<string>;
  /** The tab in front, for the interface's own page actions (save page, view source); null when there is none. */
  activeWebContents(): WebContents | null;
  snapshot(opts?: { full?: boolean }): Promise<string>;
  click(target: Target, opts?: { button?: 'left' | 'right'; double?: boolean }): Promise<string>;
  type(target: Target, text: string, opts?: { clear?: boolean; submit?: boolean }): Promise<string>;
  press(key: string): Promise<string>;
  select(target: Target, value: string): Promise<string>;
  scroll(opts: { direction?: 'up' | 'down' | 'left' | 'right'; amount?: number; target?: Target }): Promise<string>;
  scrollTo(target: Target): Promise<string>;
  hover(target: Target): Promise<string>;
  waitFor(opts: { text?: string; gone?: string; selector?: string; url?: string; urlChange?: boolean; networkIdle?: boolean; ms?: number; timeoutMs?: number }): Promise<string>;
  text(target?: Target): Promise<string>;
  evaluate(expression: string): Promise<unknown>;
  screenshot(opts?: { fullPage?: boolean; forModel?: boolean }): Promise<{ path: string; dataUrl: string; width: number; height: number; model?: { data: string; mimeType: string } }>;
  consoleLog(clear?: boolean): string;
  networkLog(clear?: boolean): string;
  back(): Promise<string>;
  forward(): Promise<string>;
  reload(): Promise<string>;
  closeTab(id?: string): void;
  selectTab(id: string): void;
  newTab(url?: string): Promise<TabInfo>;
  handoff(message: string, timeoutMs?: number): Promise<string>;
  /**
   * Sign in to the page in front with a stored credential, by name (or the one
   * bound to this origin). The value goes vault → main → page as keystrokes;
   * the result never contains it.
   */
  login(opts: { name?: string; form?: number; submit?: boolean; sessionId?: string }): Promise<string>;
  // Page understanding and forms (agent-facing: access-checked, visible to the user).
  read(opts: { mode?: 'reader' | 'full'; maxChars?: number }): Promise<PageRead>;
  forms(): Promise<FormModel[]>;
  fill(fields: FillSpec[]): Promise<string>;
  extract(kind: ExtractKind, opts?: { maxItems?: number }): Promise<string>;
  insights(): Promise<PageInsights>;
  find(text: string, limit?: number): Promise<string>;
  dialogs(): DialogRequest[];
  answerDialog(opts: { id?: string; accept: boolean; text?: string }): Promise<string>;
  downloads(): DownloadItem[];
  upload(target: Target, files: string[]): Promise<string>;
  uploadWait(id: string, seconds?: number): Promise<string>;
  agentStopped(): boolean;
  /**
   * Prompt-injection guard for an agent tool result from the page in front
   * (shared/injection-guard.ts): wraps instruction-like passages, leads with
   * the notice, and records the counts for Shields. Unchanged when the setting is off.
   */
  guardText(text: string): string;
  /** The browser moved to another window (browser-window.ts): its tabs leave the old one now; the new one's page area places them. */
  rehost(): void;
}

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

/**
 * A capture that cannot hang or flood. Capturing a hidden view could wait
 * forever — and once came back so large that handing it to the window crashed
 * the window — so every capture has a deadline and a size cap.
 */
async function boundedCapture<T extends { data: string }>(p: Promise<T>, what: string): Promise<T> {
  const r = await Promise.race([p, sleep(10_000).then(() => { throw new Error(`${what} timed out — is the page on screen?`); })]);
  if (r.data.length > 30_000_000) throw new Error(`${what} was too large to use (${Math.round(r.data.length / 1e6)} MB).`);
  return r;
}

/**
 * The still that stands in for a page while something covers it: captured
 * from the compositor (fast, for a view on screen), within half a second, at
 * device pixels so it is drawn sharp, as a JPEG so it stays small. Never
 * throws — no still is better than a page that will not hide.
 */
async function captureStill(t: { id: string; view: WebContentsView; lastStill?: { dataUrl: string; width: number; height: number } }): Promise<PageStill | undefined> {
  try {
    if (t.view.webContents.isDestroyed()) return undefined;
    const img = await Promise.race([t.view.webContents.capturePage(), sleep(500).then(() => null)]);
    if (!img || img.isEmpty()) return undefined;
    const { width, height } = img.getSize();
    if (width * height > 40_000_000) return undefined;
    const jpeg = img.toJPEG(88);
    if (jpeg.length > 15_000_000) return undefined;
    t.lastStill = { dataUrl: `data:image/jpeg;base64,${jpeg.toString('base64')}`, width, height };
    return { tabId: t.id, ...t.lastStill };
  } catch { return undefined; }
}

const PAGE_SRC = aicoPage.toString();
/** The expression that runs one page-script operation. */
export const pageJs = (op: string, args?: unknown): string => `(${PAGE_SRC})(${JSON.stringify(op)}, ${JSON.stringify(args ?? {})})`;

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
    : { key: last, code: last.length === 1 ? `Key${last.toUpperCase()}` : last, keyCode: last.toUpperCase().charCodeAt(0), text: modifiers & 6 ? undefined : last });
  return { def, modifiers, commands };
}

/** Does this key put text into the focused field (a character, or paste)? */
function keyWritesText(spec: string): boolean {
  const { def, modifiers, commands } = parseKey(spec);
  return commands.includes('paste') || (Boolean(def.text) && def.key !== 'Enter' && !(modifiers & 6));
}

/** A permission as the user reads it: media is split into camera / microphone. */
function permissionName(permission: string, mediaTypes?: string[]): string {
  if (permission !== 'media') return permission;
  const v = mediaTypes?.includes('video'); const a = mediaTypes?.includes('audio');
  return v && a ? 'camera-microphone' : v ? 'camera' : a ? 'microphone' : 'media';
}

const PERMISSIONS_SHOWN = ['notifications', 'geolocation', 'camera', 'microphone', 'clipboard-read', 'popups', 'downloads', 'midi', 'display-capture', 'openExternal'];

export function registerBrowser(ctx: DesktopContext): void {
  const tabs = new Map<string, Tab>();
  const byWc = new Map<number, Tab>();
  let activeId: string | null = null;
  let seq = 0;
  let bounds: { x: number; y: number; width: number; height: number } | null = null;
  let visible = false;
  /** The window the tab views are attached to — the browser's window (ctx.browserWindow) once laid out there. */
  let placedIn: BrowserWindow | null = null;
  let ses: Session | null = null;
  let agentStopped = false;
  /** Session restore, tab order, full screen (browser-session.ts) and autofill — set at the end of this function. */
  let tabSession: TabSession | null = null;
  let autofillService: AutofillService | null = null;
  const handoffs = new Map<string, (answer: string) => void>();
  const shotsDir = path.join(ctx.paths.desktopDir, 'browser', 'screenshots');
  const dataDir = path.join(ctx.paths.desktopDir, 'browser');

  // ── Records ──
  const history = new JsonFile<HistoryEntry[]>(path.join(dataDir, 'history.json'), [], raw => asArray<HistoryEntry>(raw));
  const settings = new JsonFile<BrowserSettings>(path.join(dataDir, 'settings.json'), DEFAULT_SETTINGS, normaliseSettings);
  const bookmarks = registerBookmarks(ctx, { dataDir, settings });
  // Saved passwords (browser-vault.ts): walled off from the agent, the copilot and everything else.
  const vault = registerVault(ctx, {
    dataDir,
    tabOf: (wcId) => byWc.get(wcId),
    front: () => { const t = activeId ? tabs.get(activeId) : undefined; return t && !t.view.webContents.isDestroyed() ? { id: t.id, wc: t.view.webContents } : null; },
    agentDriving: (wcId) => agentDriving(byWc.get(wcId)),
  });
  const certs = new Map<string, { issuer: string; subject: string; validTo: number }>();
  /** Self-signed certificates accepted this run, by origin (trust on first use; a different one is refused). */
  const selfSignedPins = new Map<string, string>();
  const selfSignedAllowed = async (origin: string, fingerprint: string): Promise<boolean> => {
    const pinned = selfSignedPins.get(origin);
    if (pinned) return pinned === fingerprint;
    const logins = await vault.loginsFor(origin);
    if (!logins.some(l => l.allowSelfSigned)) return false;
    selfSignedPins.set(origin, fingerprint);
    return true;
  };
  app.on('before-quit', () => { history.flush(); bookmarks.flush(); settings.flush(); downloads.flush(); });

  // ── Questions for the user (permissions, JS dialogs, HTTP auth, confirmations) ──
  const pendingPerms = new Map<string, { cb: (ok: boolean) => void; origin: string; name: string; timer: NodeJS.Timeout }>();
  const pendingAuth = new Map<string, { cb: (u?: string, p?: string) => void; timer: NodeJS.Timeout }>();
  const pendingConfirm = new Map<string, { resolve: (ok: boolean) => void; timer: NodeJS.Timeout }>();
  /** Open JS dialogs. `reply` answers one raised by the page's dialog preload; without it, the DevTools protocol answers. */
  const dialogs = new Map<string, { tab: Tab; req: DialogRequest; reply?: (accept: boolean, text?: string) => void }>();
  const dialogBursts = new Map<string, number[]>();
  const dialogWaiters = new Map<string, Set<(d: DialogRequest) => void>>();
  const uploads = new Map<string, { state: 'pending' | 'allowed' | 'denied' | 'done' | 'failed'; result?: string; tabId: string; ref: string; files: string[] }>();
  let askSeq = 0;
  const askId = (p: string): string => `${p}${Date.now().toString(36)}${++askSeq}`;

  const confirm = (req: Omit<ConfirmRequest, 'id'>, timeoutMs = 10 * 60_000): { id: string; done: Promise<boolean>; cancel: () => void } => {
    const id = askId('c');
    const done = new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => { pendingConfirm.delete(id); ctx.emit('browser:confirmGone', id); resolve(false); }, timeoutMs);
      pendingConfirm.set(id, { resolve, timer });
    });
    ctx.emit('browser:confirm', { id, ...req } satisfies ConfirmRequest);
    ctx.revealBrowser();
    /** Withdraw the question (nobody answered in time): it is a no, and it leaves the screen. */
    const cancel = (): void => {
      const c = pendingConfirm.get(id);
      if (!c) return;
      pendingConfirm.delete(id);
      clearTimeout(c.timer);
      ctx.emit('browser:confirmGone', id);
      c.resolve(false);
    };
    return { id, done, cancel };
  };

  // ── The purchase / send gate (browser-commit-gate.ts): enforced here, not asked for in a prompt ──
  /** What the control the agent is about to activate says about itself (read-only, in the page). */
  const commitSignals = async (t: Tab, ref: string | null): Promise<CommitSignals | null> => {
    const wc = t.view.webContents;
    const probe = await evaluate<Omit<CommitSignals, 'checkout'> | null>(wc, `(() => {
      const ref = ${JSON.stringify(ref)};
      const el = ref ? document.querySelector('[data-aico-ref="' + ref + '"]') : document.activeElement;
      if (!el) return null;
      const text = (x) => String(x == null ? '' : x).replace(/\\s+/g, ' ').trim().slice(0, 160);
      const labelOf = (x) => text(x.getAttribute && (x.getAttribute('aria-label') || '')) || text(x.value && x.tagName === 'INPUT' ? x.value : '') || text(x.innerText || x.textContent) || text(x.getAttribute && x.getAttribute('title'));
      const btn = (el.closest && el.closest('button, [role=button], input[type=submit], input[type=image], input[type=button], a')) || el;
      const form = btn.form || (btn.closest && btn.closest('form')) || null;
      const type = String(btn.getAttribute && btn.getAttribute('type') || '').toLowerCase();
      const enter = !ref;
      const submits = Boolean(form) && (enter
        ? (el.tagName === 'INPUT' && !['button', 'checkbox', 'radio', 'file'].includes(String(el.type).toLowerCase()))
        : (btn.tagName === 'INPUT' ? ['submit', 'image'].includes(type) : btn.tagName === 'BUTTON' ? (type === '' || type === 'submit') : false));
      const formButtons = enter && form ? Array.from(form.querySelectorAll('button:not([type]), button[type=submit], input[type=submit]')).slice(0, 4).map(labelOf).filter(Boolean) : [];
      const cardFields = Array.from(document.querySelectorAll('input')).filter(i => /cc-(number|csc|exp)/.test(i.getAttribute('autocomplete') || '')).length;
      return {
        label: enter ? '' : labelOf(btn), tag: String(btn.tagName || '').toLowerCase(), type, submits,
        formAction: form ? String(btn.formAction || form.action || '') : '', formButtons, url: location.href, title: document.title, cardFields,
      };
    })()`, 4000).catch(() => null);
    if (!probe) return null;
    const sig = await evaluate<PageSignals>(wc, PAGE_SIGNALS_JS, 4000).catch(() => null);
    return { ...probe, checkout: Boolean(sig?.cues.checkout || sig?.cues.placeOrder && /order|pay|purchase/i.test(probe.label)) };
  };
  /**
   * A commit needs the person's explicit Allow in an AICO prompt that says
   * what will happen. No answer within ~20 s (the tool call must return) is a
   * no: nothing is clicked, and the agent is told to ask.
   */
  const requireCommitApproval = async (t: Tab, v: CommitVerdict): Promise<void> => {
    const origin = originOf(t.view.webContents.getURL()) || t.view.webContents.getURL();
    const q = commitQuestion(v, origin);
    agentEvent(t, 'confirm', 'blocked', q.title);
    const c = confirm({ kind: 'commit', origin, title: q.title, detail: q.detail, okLabel: q.okLabel, cancelLabel: 'Don’t allow', danger: true });
    const answer = await Promise.race([c.done, sleep(22_000).then(() => null)]);
    if (answer === null) {
      c.cancel();
      throw new Error(`Refused: nothing was pressed. “${v.label || 'That action'}” would ${v.kind === 'purchase' ? 'buy or pay for something' : v.kind === 'send' ? 'send or publish something' : v.kind === 'delete' ? 'delete something' : v.kind === 'booking' ? 'make a booking' : 'start a payment'}, which needs the user's approval in AICO, and they did not answer within 20 seconds. Tell the user what you are about to do and ask them to approve; then try again.`);
    }
    if (!answer) throw new Error(`Refused: the user did not allow “${v.label || 'that action'}”. Nothing was pressed. Do not retry; ask the user how to proceed.`);
  };

  // ── What the agent is doing (for the interface and for results) ──
  let capture: { tab: Tab; download?: string; newTab?: string; auth?: string } | null = null;
  /** When the agent last navigated (browser_open): a download that follows is the agent's. */
  let agentOpen: { at: number; download?: string } = { at: 0 };
  const agentDriving = (t: Tab | undefined): boolean => Boolean(t && (Date.now() < t.agentUntil + 3000 || capture?.tab === t));
  const agentEvent = (t: Tab, action: string, status: AgentEvent['status'], label?: string, detail?: string): void => {
    if (status === 'start') t.agentUntil = Date.now() + 2000;
    else t.agentUntil = Math.max(t.agentUntil, Date.now() + 2000);
    ctx.emit('browser:agent', { tabId: t.id, action, status, ...(label ? { label } : {}), ...(detail ? { detail: detail.slice(0, 300) } : {}) } satisfies AgentEvent);
    pushState();
    setTimeout(pushState, 2100);
  };

  // Shields, protected browsing, insights (browser-privacy.ts).
  const privacy = createPrivacy(ctx, {
    tabOf: (id) => { const t = id !== undefined ? byWc.get(id) : undefined; return t && !t.view.webContents.isDestroyed() ? { id: t.id, url: t.view.webContents.getURL() } : null; },
    frontTab: () => { const t = visible && activeId ? tabs.get(activeId) : undefined; return t && !t.view.webContents.isDestroyed() ? { id: t.id, url: t.view.webContents.getURL() } : null; },
    activeTabId: () => activeId,
    lastInput: (id) => tabs.get(id)?.lastGestureAt ?? 0,
    counts: (id) => { const t = tabs.get(id); return { trackersBlocked: t?.trackersBlocked ?? 0, popupsBlocked: t?.popupsBlocked ?? 0 }; },
    trackers: () => settings.get().blocking,
    pushState: () => pushState(),
    clearHistory: () => { history.set([]); history.flush(); learn.clear(); memory.clear(); },
  });

  // "Remember what I read": off by default; fed by the learning tick below (browser-memory.ts).
  const memory = createMemory(ctx, {
    flagged: (id) => privacy.flagged(id),
    byAgent: (id) => agentDriving(tabs.get(id)) || (id === activeId && Date.now() - agentOpen.at < 15_000),
  });
  // One line per open tab for the copilot's header (browser-tab-summary.ts).
  const tabAware = createTabAwareness({
    tabs: () => state().tabs.map(t => ({ id: t.id, url: t.url, title: t.title })),
    activeId: () => activeId,
    flagged: (id) => privacy.flagged(id),
    run: <T>(wc: WebContents, code: string, ms: number) => Promise.race([
      wc.executeJavaScriptInIsolatedWorld(AICO_WORLD, [{ code }]) as Promise<T>,
      sleep(ms).then(() => null),
    ]).catch(() => null),
  });
  ctx.services.browserTabs = tabAware;

  // Browsing intelligence: what AICO learns from your browsing, on this device (browser-learn.ts).
  const learn = createLearning(ctx, {
    reading: (id, url, wc, ms, scroll) => memory.reading(id, url, wc, ms, scroll),
    state: () => state(),
    frontTab: () => { const t = visible && activeId ? tabs.get(activeId) : undefined; return t && !t.view.webContents.isDestroyed() ? { id: t.id, url: t.view.webContents.getURL() } : null; },
    lastInput: (id) => tabs.get(id)?.lastGestureAt ?? 0,
    byAgent: (id) => agentDriving(tabs.get(id)) || (id === activeId && Date.now() - agentOpen.at < 15_000),
    flagged: (id) => privacy.flagged(id),
    closeTab: (id) => service.closeTab(id),
    bookmarkFolder: (title, items) => bookmarks.addTabs({ title, items }),
    bookmarkedUrls: () => flattenBookmarks(bookmarks.tree()).map(b => b.url),
    confirm: (req) => confirm(req),
    history: () => history.get(),
  });

  const downloads = createDownloads(ctx, {
    byAgent: (wc) => agentDriving(wc ? byWc.get(wc.id) : undefined) || (wc !== undefined && Date.now() - agentOpen.at < 15_000),
    confirm: (req) => confirm(req).done,
    started: (item, wc) => {
      const t = wc ? byWc.get(wc.id) : undefined;
      if (capture && (!t || capture.tab === t)) capture.download = item.filename;
      if (wc && Date.now() - agentOpen.at < 15_000) agentOpen.download = item.filename;
      privacy.noteDownload();
    },
    flagged: (wc) => privacy.flagged(wc ? byWc.get(wc.id)?.id : undefined),
    blocked: (wc) => Boolean(wc && !wc.isDestroyed() && settings.get().permissions[originOf(wc.getURL())]?.downloads === 'deny'),
  });

  // ── Session ──
  const getSession = (): Session => {
    if (ses) return ses;
    // The profile in <AICO_HOME>, migrated once from the old partition; UA, spell-check, kept cookies.
    ses = openBrowserSession(ctx);
    // Nothing is granted by default; a page asks, the user answers (and may have it remembered).
    ses.setPermissionRequestHandler((wc, permission, cb, details) => {
      if (permission === 'clipboard-sanitized-write' || permission === 'fullscreen') { cb(true); return; }
      const t = byWc.get(wc.id);
      const origin = originOf((details as { requestingUrl?: string }).requestingUrl || wc.getURL());
      if (!t || !origin) { cb(false); return; }
      const name = permissionName(permission, (details as { mediaTypes?: string[] }).mediaTypes);
      const remembered = settings.get().permissions[origin]?.[name];
      if (remembered) { cb(remembered === 'allow'); return; }
      // Notification prompts are refused quietly unless the user lets sites ask (Privacy & security).
      if (name === 'notifications' && privacy.quietNotifications(t.id)) { cb(false); return; }
      const id = askId('p');
      const timer = setTimeout(() => { pendingPerms.delete(id); cb(false); }, 120_000);
      pendingPerms.set(id, { cb, origin, name, timer });
      ctx.emit('browser:permission', { id, tabId: t.id, origin, permission: name });
    });
    ses.setPermissionCheckHandler((_wc, permission, requestingOrigin, details) => {
      if (permission === 'clipboard-sanitized-write' || permission === 'fullscreen') return true;
      const origin = originOf(requestingOrigin);
      const perms = settings.get().permissions[origin];
      if (!perms) return false;
      const name = permissionName(permission, details.mediaType ? [details.mediaType] : undefined);
      return perms[name] === 'allow' || (permission === 'media' && perms['camera-microphone'] === 'allow');
    });
    // Observe (never change) certificate verification, for the site-info panel.
    ses.setCertificateVerifyProc((req, cb) => {
      try {
        certs.set(req.hostname, { issuer: req.certificate.issuerName, subject: req.certificate.subjectName, validTo: req.certificate.validExpiry * 1000 });
      } catch { /* observation only */ }
      cb(-3);
    });
    downloads.attach(ses);
    installDialogPreload(ses, dataDir);
    vault.attach(ses);
    privacy.attach(ses);
    ses.webRequest.onBeforeRequest((d, cb) => {
      const t = d.webContentsId !== undefined ? byWc.get(d.webContentsId) : undefined;
      if (t && d.resourceType === 'mainFrame') {
        // HTTPS-first and protected browsing decide before the page is fetched.
        const verdict = privacy.onMainFrame(t.id, d.url);
        if (verdict) { cb(verdict); return; }
      }
      if (t && d.resourceType !== 'mainFrame') {
        const s = settings.get().blocking;
        const pageUrl = t.view.webContents.getURL();
        if (s.enabled && !s.allowOrigins.includes(originOf(pageUrl))) {
          const dec = shouldBlock(d.url, pageUrl, d.resourceType);
          if (dec.block) {
            t.trackersBlocked++;
            if (t.trackers.size < 500 && dec.tracker) t.trackers.add(dec.tracker);
            if (dec.tracker) privacy.noteTracker(t.id, dec.tracker, pageUrl);
            pushState();
            cb({ cancel: true });
            return;
          }
        }
      }
      if (t) { t.inflight.add(d.id); t.lastNetAt = Date.now(); }
      cb({});
    });
    const settled = (d: { id: number; webContentsId?: number }): void => {
      const t = d.webContentsId !== undefined ? byWc.get(d.webContentsId) : undefined;
      if (t) { t.inflight.delete(d.id); t.lastNetAt = Date.now(); }
    };
    ses.webRequest.onErrorOccurred(settled);
    ses.webRequest.onCompleted((d) => {
      settled(d);
      const tab = d.webContentsId !== undefined ? byWc.get(d.webContentsId) : undefined;
      if (!tab) return;
      tab.network.push({ method: d.method, url: d.url, status: d.statusCode, type: d.resourceType, at: Date.now() });
      if (tab.network.length > 400) tab.network.shift();
    });
    return ses;
  };

  // ── State ──
  const securityOf = (t: Tab): SecurityState => {
    const u = t.view.webContents.getURL();
    if (t.certError || (t.error && t.error.code <= -200 && t.error.code > -300)) return 'error';
    if (/^https:/i.test(u)) return 'secure';
    if (/^http:/i.test(u)) return 'insecure';
    return 'internal';
  };
  const tabState = (t: Tab): TabState => {
    const wc = t.view.webContents;
    return {
      id: t.id, url: t.deferred?.url ?? (t.error?.url && /^chrome-error:/.test(wc.getURL()) ? t.error.url : wc.getURL()),
      title: t.deferred?.title || wc.getTitle() || wc.getURL() || 'New tab', ...(t.favicon ?? t.deferred?.favicon ? { favicon: t.favicon ?? t.deferred?.favicon } : {}),
      ...(t.pinned ? { pinned: true } : {}),
      loading: wc.isLoading(), canGoBack: wc.navigationHistory.canGoBack(), canGoForward: wc.navigationHistory.canGoForward(),
      audible: wc.isCurrentlyAudible(), muted: wc.isAudioMuted(), zoom: wc.getZoomFactor(), security: securityOf(t),
      trackersBlocked: t.trackersBlocked, agentActive: Date.now() < t.agentUntil, humanCheck: t.humanCheck,
      ...(t.error ? { error: t.error } : {}), ...(t.popupsBlocked ? { popupsBlocked: t.popupsBlocked } : {}),
      ...privacy.tabExtras(t.id),
      ...(t.guard && t.guard.url === wc.getURL() ? { injectionGuard: t.guard } : {}),
    };
  };
  const state = (): BrowserState => ({
    activeId, tabs: [...tabs.values()].filter(t => !t.view.webContents.isDestroyed()).map(tabState),
    blocking: { enabled: settings.get().blocking.enabled }, agentStopped,
  });
  const info = (t: Tab): TabInfo => {
    const wc = t.view.webContents;
    return {
      id: t.id, url: wc.getURL(), title: wc.getTitle() || wc.getURL() || 'New tab', favicon: t.favicon,
      loading: wc.isLoading(), canGoBack: wc.navigationHistory.canGoBack(), canGoForward: wc.navigationHistory.canGoForward(),
      active: t.id === activeId, zoom: wc.getZoomFactor(),
    };
  };
  const list = (): TabInfo[] => [...tabs.values()].filter(t => !t.view.webContents.isDestroyed()).map(info);
  let stateTimer: NodeJS.Timeout | null = null;
  function pushState(): void {
    if (stateTimer) return;
    stateTimer = setTimeout(() => {
      stateTimer = null;
      ctx.emit('browser:state', state());
      ctx.emit('browser:tabs', list());
    }, 60);
  }
  const announce = pushState;

  /** Take every tab out of the window it was in (the browser is moving, or that window is closing). */
  const detachAll = (): void => {
    const from = placedIn;
    placedIn = null;
    for (const t of tabs.values()) {
      if (!t.attached) continue;
      t.attached = false;
      try { if (from && !from.isDestroyed()) from.contentView.removeChildView(t.view); } catch { /* the window is going */ }
    }
  };

  const layout = (): void => {
    const win = ctx.browserWindow();
    // The browser moved window: nothing stays behind in the old one.
    if (placedIn && placedIn !== win) detachAll();
    if (!win || win.isDestroyed()) return;
    for (const t of tabs.values()) {
      // A page in HTML full screen (a video) fills the window, whatever the interface is doing.
      const full = tabSession?.boundsFor(t) ?? null;
      const show = t.id === activeId && (full !== null || (visible && bounds !== null));
      if (show && !t.attached) { win.contentView.addChildView(t.view); t.attached = true; placedIn = win; }
      if (show) { t.view.setBounds(full ?? bounds!); t.view.setVisible(true); }
      else if (t.attached) { t.view.setVisible(false); }
      // Background tabs are throttled as in any browser; the one in front (which the agent drives, even unseen) is not.
      const throttle = t.id !== activeId;
      if (t.throttled !== throttle && !t.view.webContents.isDestroyed()) { t.view.webContents.setBackgroundThrottling(throttle); t.throttled = throttle; }
    }
    ctx.services.browserOverlay?.raise();
  };

  // ── DevTools protocol ──
  function ensureDebugger(t: Tab): void {
    const dbg = t.view.webContents.debugger;
    if (!dbg.isAttached()) {
      try { dbg.attach('1.3'); } catch (err) { throw new Error(`Cannot control this tab: ${(err as Error).message}`); }
      t.pageEnabled = false;
    }
    if (!t.pageEnabled) {
      t.pageEnabled = true;
      void dbg.sendCommand('Page.enable').catch(() => { t.pageEnabled = false; });
    }
  }

  async function cdp<T = unknown>(wc: WebContents, method: string, params?: Record<string, unknown>): Promise<T> {
    const t = byWc.get(wc.id);
    if (t) ensureDebugger(t);
    else if (!wc.debugger.isAttached()) {
      try { wc.debugger.attach('1.3'); } catch (err) { throw new Error(`Cannot control this tab: ${(err as Error).message}`); }
    }
    return wc.debugger.sendCommand(method, params) as Promise<T>;
  }

  const dialogOpenMessage = (d: DialogRequest): string => `A JavaScript ${d.type} dialog is open on this page ("${d.message.slice(0, 200)}"). The page is paused until it is answered: call browser_dialog with accept true/false${d.type === 'prompt' ? ' (and text)' : ''}.`;

  async function evaluate<T = unknown>(wc: WebContents, expression: string, timeoutMs = 15_000): Promise<T> {
    const t = byWc.get(wc.id);
    if (t?.dialog) throw new Error(dialogOpenMessage(t.dialog));
    const r = await Promise.race([
      cdp<{ result: { value?: T; description?: string }; exceptionDetails?: { text: string; exception?: { description?: string } } }>(
        wc, 'Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true },
      ),
      sleep(timeoutMs).then(() => { throw new Error(t?.dialog ? dialogOpenMessage(t.dialog) : 'The page did not answer in time (it may be busy or navigating). Try again.'); }),
    ]);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value as T;
  }
  const page = <T>(t: Tab, op: string, args?: unknown, timeoutMs?: number): Promise<T> => evaluate<T>(t.view.webContents, pageJs(op, args), timeoutMs);

  // ── Tabs ──
  const create = (url?: string, adopt?: WebContents): Tab => {
    const view = adopt
      ? new WebContentsView({ webContents: adopt })
      : new WebContentsView({
        webPreferences: {
          session: getSession(), sandbox: true, contextIsolation: true, nodeIntegration: false,
          backgroundThrottling: false, spellcheck: true,
          // The dialog preload (browser-preload.ts) must reach iframes too; with sandbox on this grants nothing else.
          nodeIntegrationInSubFrames: true,
        },
      });
    const id = `b${++seq}`;
    const tab: Tab = {
      id, view, console: [], network: [], attached: false, trackers: new Set(), trackersBlocked: 0, popupsBlocked: 0,
      agentUntil: 0, humanCheck: false, lastGestureAt: 0, inflight: new Set(), lastNetAt: 0, pageEnabled: false, allowUnload: false,
    };
    const wc = view.webContents;
    byWc.set(wc.id, tab);
    privacy.attachTab(id, wc);
    learn.attachTab(id, wc);
    tabAware.attachTab(id, wc);

    wc.setWindowOpenHandler((d) => {
      const gesture = Date.now() - tab.lastGestureAt < 5000;
      // Site permissions: "Pop-ups: Allow" lets a site open windows without a click.
      if (!gesture && settings.get().permissions[originOf(wc.getURL())]?.popups !== 'allow') {
        tab.popupsBlocked++;
        pushState();
        return { action: 'deny' };
      }
      if (capture?.tab === tab) capture.newTab = d.url;
      // Opened as a tab of this browser, keeping window.opener (sign-in pop-ups need it).
      return {
        action: 'allow',
        createWindow: (options) => {
          const adoptWc = (options as { webContents?: WebContents }).webContents;
          const t = create(adoptWc ? undefined : d.url, adoptWc);
          tabSession?.placeNew(t, tab.id);
          layout();
          return t.view.webContents;
        },
      };
    });
    wc.on('page-favicon-updated', (_e, icons) => {
      tab.favicon = icons[0];
      history.set(touchVisit(history.get(), wc.getURL(), { favicon: icons[0] }));
      pushState();
    });
    for (const ev of ['did-start-loading', 'did-stop-loading', 'media-started-playing', 'media-paused'] as const) {
      wc.on(ev as 'did-start-loading', () => pushState());
    }
    wc.on('audio-state-changed', () => pushState());
    wc.on('page-title-updated', (_e, title) => {
      history.set(touchVisit(history.get(), wc.getURL(), { title }));
      pushState();
    });
    wc.on('did-start-navigation', (d) => {
      if (!d.isMainFrame || d.isSameDocument) return;
      tab.error = undefined; tab.certError = undefined; tab.humanCheck = false; tab.favicon = undefined;
      tab.trackersBlocked = 0; tab.trackers.clear(); tab.popupsBlocked = 0;
      pushState();
    });
    wc.on('did-navigate', (_e, url, code) => {
      tab.httpStatus = code;
      history.set(recordVisit(history.get(), { url, title: wc.getTitle(), favicon: tab.favicon }, Date.now()));
      const z = settings.get().zoom[originOf(url)] ?? 1;
      if (Math.abs(wc.getZoomFactor() - z) > 0.001) wc.setZoomFactor(z);
      pushState();
    });
    wc.on('did-navigate-in-page', (_e, url, isMainFrame) => {
      if (!isMainFrame) return;
      history.set(recordVisit(history.get(), { url, title: wc.getTitle(), favicon: tab.favicon }, Date.now()));
      pushState();
      scheduleHumanCheck(tab);
    });
    wc.on('did-stop-loading', () => scheduleHumanCheck(tab));
    wc.on('did-fail-load', (_e, code, desc, u, isMain) => {
      if (!isMain || code === -3) return;
      tab.error = { code, description: desc, url: u };
      ctx.emit('browser:error', { id, url: u, message: `${desc} (${code})` });
      pushState();
    });
    wc.on('certificate-error', (e, url, error, certificate, cb, isMainFrame) => {
      // Never accepted by a click-through or by the agent. The one exception is
      // written down by a person or the agent's own CredentialGenerate: a
      // credential bound to exactly this origin with `allowSelfSigned`, on a
      // private-network address (a self-hosted server), and then only for the
      // first certificate seen this run (a changed one is refused).
      e.preventDefault();
      const refuse = (): void => { cb(false); if (isMainFrame) { tab.certError = { url, error, issuer: certificate.issuerName }; pushState(); } };
      const origin = loginOrigin(url);
      if (!origin || !/^https:/i.test(origin) || !isPrivateOrigin(origin) || !/ERR_CERT_(AUTHORITY_INVALID|COMMON_NAME_INVALID)/.test(error)) { refuse(); return; }
      void selfSignedAllowed(origin, certificate.fingerprint).then((ok) => { if (ok) cb(true); else refuse(); }).catch(refuse);
    });
    wc.on('login', (e, _details, authInfo, cb) => {
      e.preventDefault();
      const reqId = askId('a');
      const timer = setTimeout(() => { pendingAuth.delete(reqId); cb(); }, 5 * 60_000);
      pendingAuth.set(reqId, { cb, timer });
      if (capture?.tab === tab) capture.auth = authInfo.host;
      ctx.emit('browser:auth', { id: reqId, tabId: tab.id, host: authInfo.host, ...(authInfo.realm ? { realm: authInfo.realm } : {}) });
      ctx.revealBrowser();
    });
    wc.on('will-prevent-unload', (e) => {
      if (tab.allowUnload) { tab.allowUnload = false; e.preventDefault(); return; }
      const d: DialogRequest = { id: askId('j'), tabId: tab.id, type: 'beforeunload', message: 'This page asks whether you want to leave — changes you made may not be saved.', byAgent: agentDriving(tab) };
      raiseDialog(tab, d, { blocking: false });
    });
    wc.on('render-process-gone', (_e, details) => {
      tab.error = { code: -1, description: `The page stopped (${details.reason})`, url: wc.getURL() };
      pushState();
    });
    wc.on('console-message', (e) => {
      const d = e as unknown as { level: string | number; message: string; sourceId?: string; lineNumber?: number };
      const level = typeof d.level === 'number' ? ['verbose', 'info', 'warning', 'error'][d.level] ?? 'info' : d.level;
      // Electron's own development-build warnings (the dialog preload runs in the page) are not the page's.
      if (/^%?c?Electron (Security|Deprecation) Warning/.test(d.message)) return;
      tab.console.push({ level, text: d.message, source: d.sourceId, line: d.lineNumber, at: Date.now() });
      if (tab.console.length > 400) tab.console.shift();
    });
    wc.on('input-event', (_e, input) => {
      if (['mouseDown', 'mouseUp', 'keyDown', 'rawKeyDown', 'char', 'touchStart', 'gestureTap', 'pointerDown'].includes(input.type)) tab.lastGestureAt = Date.now();
    });
    wc.on('before-input-event', (e, input) => {
      if (input.type === 'keyDown') tab.lastGestureAt = Date.now();
      if (input.type === 'keyDown' && (input.control || input.meta) && input.key.toLowerCase() === 'l') ctx.emit('browser:focus-address');
      // Browser shortcuts belong to the browser, even while the page has focus.
      const spec = browserShortcutSpec(input);
      if (spec) { e.preventDefault(); ctx.emit('browser:shortcut', { key: spec }); }
    });
    wc.on('found-in-page', (_e, r) => {
      const res: FindResult = { matches: r.matches, active: r.activeMatchOrdinal };
      ctx.emit('browser:found', res);
      if (pendingFind && r.requestId === pendingFind.requestId && r.finalUpdate) { pendingFind.resolve(res); pendingFind = null; }
    });
    wc.on('destroyed', () => { byWc.delete(wc.id); });
    wc.on('enter-html-full-screen', () => tabSession?.htmlFullscreen(tab, true));
    wc.on('leave-html-full-screen', () => tabSession?.htmlFullscreen(tab, false));

    // The DevTools protocol from the start, so JavaScript dialogs reach the interface.
    try { ensureDebugger(tab); } catch { /* retried on first use */ }
    wc.debugger.on('detach', () => { tab.pageEnabled = false; });
    wc.debugger.on('message', (_e, method, params: Record<string, unknown>) => {
      if (method === 'Page.javascriptDialogOpening') {
        const type = String(params.type) as DialogRequest['type'];
        if (type === 'beforeunload') return; // handled by will-prevent-unload
        // Normally the dialog preload raised it already (and no native box is shown). A frame the preload
        // did not reach falls back to Electron's native box, which the user answers; this only records it
        // so the agent's tools do not wait on a paused page.
        if (tab.dialog) return;
        const d: DialogRequest = {
          id: askId('j'), tabId: tab.id, type, message: String(params.message ?? ''),
          ...(type === 'prompt' ? { defaultPrompt: String(params.defaultPrompt ?? '') } : {}), byAgent: agentDriving(tab),
        };
        raiseDialog(tab, d, { emit: false });
      } else if (method === 'Page.javascriptDialogClosed') {
        const cur = tab.dialog ? dialogs.get(tab.dialog.id) : undefined;
        if (tab.dialog && !cur?.reply) { dialogs.delete(tab.dialog.id); tab.dialog = undefined; pushState(); }
      }
    });

    tabs.set(id, tab);
    activeId = id;
    if (url && !adopt) void wc.loadURL(normalise(url)).catch(() => {});
    layout();
    pushState();
    return tab;
  };

  function raiseDialog(tab: Tab, d: DialogRequest, opts: { emit?: boolean; blocking?: boolean; reply?: (accept: boolean, text?: string) => void } = {}): void {
    if (opts.blocking !== false) tab.dialog = d;
    dialogs.set(d.id, { tab, req: d, ...(opts.reply ? { reply: opts.reply } : {}) });
    if (opts.emit !== false) ctx.emit('browser:dialog', d);
    for (const w of dialogWaiters.get(tab.id) ?? []) w(d);
    if (!d.byAgent) ctx.revealBrowser();
  }

  const waitDialog = (t: Tab): { promise: Promise<DialogRequest>; cancel: () => void } => {
    let fn: (d: DialogRequest) => void = () => {};
    const promise = new Promise<DialogRequest>((resolve) => { fn = resolve; });
    const set = dialogWaiters.get(t.id) ?? new Set();
    set.add(fn);
    dialogWaiters.set(t.id, set);
    return { promise, cancel: () => { set.delete(fn); } };
  };

  const humanTimers = new Map<string, NodeJS.Timeout>();
  function scheduleHumanCheck(t: Tab): void {
    clearTimeout(humanTimers.get(t.id));
    humanTimers.set(t.id, setTimeout(() => { humanTimers.delete(t.id); void humanCheck(t).catch(() => {}); }, 600));
  }
  async function humanCheck(t: Tab): Promise<HumanCheck> {
    if (t.view.webContents.isDestroyed() || t.dialog) return { detected: t.humanCheck };
    const sig = await page<HumanCheckSignals>(t, 'humanCheck', { humanSelectors: HUMAN_CHECK_SELECTORS }, 5000).catch(() => null);
    if (!sig) return { detected: false };
    const h = detectHumanCheck(sig);
    if (t.humanCheck !== h.detected) { t.humanCheck = h.detected; pushState(); }
    return h;
  }

  const active = (): Tab => {
    let t = activeId ? tabs.get(activeId) : undefined;
    // First use this run: the last session's tabs come back before anything new is made.
    if ((!t || t.view.webContents.isDestroyed()) && tabSession?.restore()) t = activeId ? tabs.get(activeId) : undefined;
    if (!t || t.view.webContents.isDestroyed()) t = create();
    return t;
  };

  function normalise(u: string): string {
    const s = u.trim();
    if (/^(https?|file|about|data):/i.test(s) || /^view-source:https?:/i.test(s)) return s;
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

  function checkAccess(): void {
    if (ctx.prefs.get().browserAgentAccess === 'deny') throw new Error('The user has not allowed the agent to use the built-in browser (Settings → Browser).');
    if (agentStopped) {
      const t = activeId ? tabs.get(activeId) : undefined;
      if (t) ctx.emit('browser:agent', { tabId: t.id, action: 'refused', status: 'blocked', detail: 'The user has taken control' } satisfies AgentEvent);
      throw new Error('The user has taken control of the browser (Stop / Take over). Do not use the browser tools now — tell the user what you were about to do and ask before continuing; they will resume you when ready.');
    }
    ctx.emit('browser:agent-active', { at: Date.now() });
  }

  interface Located {
    x: number; y: number; rect: { x: number; y: number; w: number; h: number }; label: string; tag: string; role: string; ref: string;
    field: FieldDescriptor; isField: boolean; isSelect: boolean; isFile: boolean; checked?: boolean; inFrame: boolean; disabled: boolean; coveredBy?: string;
  }
  async function locate(t: Tab, target: Target, highlight?: string): Promise<Located> {
    if (!target.ref && !target.selector && !target.text) throw new Error('Name an element: ref (from browser_snapshot), selector, or text.');
    const r = await page<Located & { error?: string }>(t, 'locate', { target, highlight });
    if (!r || r.error) throw new Error(r?.error ?? 'Element not found.');
    await sleep(60);
    return r;
  }

  async function mouseClick(t: Tab, x: number, y: number, button: 'left' | 'right' = 'left', clickCount = 1): Promise<void> {
    const wc = t.view.webContents;
    t.lastGestureAt = Date.now();
    await cdp(wc, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    for (let i = 1; i <= clickCount; i++) {
      await cdp(wc, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, clickCount: i });
      await cdp(wc, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, clickCount: i });
    }
  }

  async function pressKey(t: Tab, spec: string): Promise<void> {
    const wc = t.view.webContents;
    t.lastGestureAt = Date.now();
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

  const probe = (t: Tab): Promise<PageProbe | null> => (t.dialog ? Promise.resolve(null) : page<PageProbe>(t, 'probe', {}, 4000).catch(() => null));

  /**
   * One agent action: access check, the human-check gate, the user-visible
   * "agent is doing X" event, a JS-dialog watch (a dialog pauses the page, so
   * the action returns as soon as one opens), and a compact account of what
   * changed.
   */
  async function act(action: string, opts: { gate?: boolean; diff?: boolean; label?: string }, fn: (t: Tab) => Promise<string>): Promise<string> {
    checkAccess();
    const t = active();
    agentEvent(t, action, 'start', opts.label);
    capture = { tab: t };
    const watch = waitDialog(t);
    try {
      if (t.dialog && action !== 'dialog') throw new Error(dialogOpenMessage(t.dialog));
      // A page protected browsing flagged is look-only for the agent (browser-privacy.ts).
      const flagged = opts.gate ? privacy.agentRefusal(t.id) : null;
      if (flagged) throw new Error(flagged);
      if (opts.gate) {
        const h = await humanCheck(t);
        if (h.detected) {
          agentEvent(t, action, 'blocked', opts.label, `Human check: ${h.kind}`);
          throw new Error(humanCheckRefusal(h));
        }
      }
      const before = opts.diff ? await probe(t) : null;
      const run = fn(t);
      run.catch(() => { /* reported below, or superseded by a dialog */ });
      const won = await Promise.race([run.then(r => ({ r })), watch.promise.then(d => ({ d }))]);
      let text = 'r' in won ? won.r : `The ${action} made the page open a JavaScript ${won.d.type} dialog: "${won.d.message.slice(0, 300)}". The page is paused until it is answered — call browser_dialog (accept true/false${won.d.type === 'prompt' ? ', text' : ''}).`;
      if (opts.diff && !('d' in won)) {
        const after = await probe(t);
        const extra = {
          ...(t.dialog ? { jsDialog: { type: t.dialog.type, message: t.dialog.message } } : {}),
          ...(capture?.download ? { download: capture.download } : {}),
          ...(capture?.newTab ? { newTab: capture.newTab } : {}),
        };
        const change = describeChange(before, after ?? (t.dialog ? null : { url: t.view.webContents.getURL(), title: t.view.webContents.getTitle(), alerts: [], invalid: [], modals: [] }), extra);
        if (change) text += `\n${change}`;
        if (capture?.auth) text += `\nThe site asked for an HTTP sign-in (${capture.auth}); the user has been asked to answer it — wait, then take a snapshot.`;
      }
      agentEvent(t, action, 'done', opts.label);
      return text;
    } catch (err) {
      const msg = (err as Error).message;
      if (!/^Human check detected/.test(msg)) agentEvent(t, action, /^Refused/.test(msg) ? 'blocked' : 'error', opts.label, msg);
      throw err;
    } finally {
      watch.cancel();
      capture = null;
    }
  }

  async function openUrl(url: string, opts?: { newTab?: boolean }): Promise<TabInfo> {
    // Restored tabs are the user's pages: something opened now gets a tab of its own.
    const restored = !activeId && Boolean(tabSession?.restore());
    const t = opts?.newTab || restored || !activeId ? create() : active();
    activeId = t.id;
    const target = normalise(url);
    t.lastNav = () => { void t.view.webContents.loadURL(target).catch(() => {}); };
    // Capped: a view that is not on screen can stall its load promise, and an
    // open that never returns hangs the agent's tool call and the caller with
    // it. The page keeps loading; the state events still report it.
    try { await Promise.race([t.view.webContents.loadURL(target), sleep(30_000)]); } catch (err) {
      const msg = (err as Error).message;
      // Blocked as deceptive, or https failed (ERR_BLOCKED_BY_CLIENT): say why, not a network error.
      const blocked = /ERR_BLOCKED_BY_CLIENT/.test(msg) ? privacy.blockedNote(t.id) : null;
      if (blocked) throw new Error(blocked);
      if (!/ERR_ABORTED/.test(msg)) {
        // The failure is on the tab's state (error / certificate) too, for the interface.
        throw new Error(`Could not open ${target}: ${msg}`);
      }
    }
    await waitLoad(t.view.webContents);
    layout();
    pushState();
    return info(t);
  }

  // ── Page understanding ──
  async function readPage(t: Tab, opts: { mode?: 'reader' | 'full'; maxChars?: number }): Promise<PageRead> {
    await waitLoad(t.view.webContents, 8000);
    const r = await page<PageRead>(t, 'read', { mode: opts.mode === 'full' ? 'full' : 'reader', maxChars: opts.maxChars, guard: privacy.injectionGuard() }, 20_000);
    if (r.concealed) t.guardPending = { url: t.view.webContents.getURL(), report: r.concealed };
    return r;
  }
  async function formsOf(t: Tab): Promise<FormModel[]> {
    await waitLoad(t.view.webContents, 8000);
    return finishForms(await page(t, 'forms', {}, 15_000));
  }
  async function insightsOf(t: Tab): Promise<PageInsights> {
    await waitLoad(t.view.webContents, 8000);
    const sig = await page<InsightSignals>(t, 'insights', { humanSelectors: HUMAN_CHECK_SELECTORS }, 15_000);
    const ins = buildInsights(sig, { security: securityOf(t), trackersBlocked: t.trackersBlocked, httpStatus: t.httpStatus });
    if (t.humanCheck !== ins.humanCheck) { t.humanCheck = ins.humanCheck; pushState(); }
    if (t.guard && t.guard.url === t.view.webContents.getURL()) ins.injectionGuard = { hidden: t.guard.hidden, flagged: t.guard.flagged };
    return ins;
  }

  async function snapshotText(t: Tab, full: boolean): Promise<string> {
    const wc = t.view.webContents;
    await waitLoad(wc, 8000);
    if (t.dialog) return `${dialogOpenMessage(t.dialog)}\n\nPage: ${wc.getTitle()}\nURL: ${wc.getURL()}`;
    const s = await page<SnapshotRaw & { concealed?: ConcealedReport }>(t, 'snapshot', { full, guard: privacy.injectionGuard() });
    if (s.concealed) t.guardPending = { url: wc.getURL(), report: s.concealed };
    const h = await humanCheck(t);
    return formatSnapshot(s, {
      ...(h.detected ? { humanCheck: `Human check on this page (${h.kind}). You must not attempt it: call browser_handoff so the user completes it.` } : {}),
    });
  }

  // ── Signing in from the vault (browser-login.ts) ──
  /** On a sign-in page: which stored credential matches this exact origin — names only. */
  async function loginSuggestion(t: Tab): Promise<string | undefined> {
    const url = t.view.webContents.getURL();
    const origin = loginOrigin(url);
    if (!origin) return undefined;
    const form = await evaluate<LoginFormReport>(t.view.webContents, loginFormJs(0), 4000).catch(() => null);
    if (!form || (!form.forms && !form.identifierOnly)) return undefined;
    const list = await vault.loginsFor(origin).catch(() => []);
    if (list.length === 1) return `A stored credential "${list[0]!.name}" matches this origin — call browser_login to sign in (it fills the password itself; you never see or type it).`;
    if (list.length > 1) return `Stored credentials for this origin: ${list.map(l => `"${l.name}"${l.username ? ` (${l.username})` : ''}`).join(', ')} — call browser_login with the name to use.`;
    return `This is a sign-in page and no stored credential is bound to ${origin}. Ask the user to sign in (browser_handoff), or CredentialRequest with url "${origin}" so it can be saved for next time.`;
  }

  /** Focus a field by clicking it, and check the focus really is there before a keystroke goes in. */
  async function focusField(t: Tab, ref: string): Promise<boolean> {
    const at = await locate(t, { ref });
    if (at.inFrame || at.disabled) return false;
    await mouseClick(t, at.x, at.y);
    await sleep(60);
    return evaluate<boolean>(t.view.webContents, `(() => { const a = document.activeElement; return Boolean(a && a.getAttribute('data-aico-ref') === ${JSON.stringify(ref)}); })()`, 3000).catch(() => false);
  }

  /** Type into the focused field with trusted input, replacing what is there. */
  async function typeInto(t: Tab, text: string): Promise<void> {
    await pressKey(t, process.platform === 'darwin' ? 'Meta+a' : 'Ctrl+a');
    await pressKey(t, 'Backspace');
    await cdp(t.view.webContents, 'Input.insertText', { text });
  }

  async function loginImpl(t: Tab, opts: { name?: string; form?: number; submit?: boolean; sessionId?: string }): Promise<string> {
    const wc = t.view.webContents;
    await waitLoad(wc, 8000);
    const origin = loginOrigin(wc.getURL());
    if (!origin) return 'no matching login form: this page has no web address a credential can be bound to.';
    let form = await evaluate<LoginFormReport>(wc, loginFormJs(opts.form ?? 0), 5000).catch(() => null);
    if (!form || (!form.password && !form.identifierOnly)) return `no matching login form on ${wc.getURL()} (no visible username or password field in the page itself). Take a snapshot; if the sign-in is in a pop-up or another page, open that first.`;
    const host = ctx.services.vaultHost;
    if (!host) return 'refused: the credential vault is not available in this window.';
    // The tool call must return within the MCP deadline; a person answering an
    // approval may take longer. Then the agent is told to wait and call again.
    const pending = host.requestFill({
      origin, tool: 'browser_login', ...(opts.name ? { name: opts.name } : {}), ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
      purpose: `sign in to ${origin} in the AICO browser (the agent asked; it never sees the value)`,
    });
    const reply = await Promise.race([pending, sleep(23_000).then(() => null)]);
    if (!reply) {
      // A late answer is dropped as soon as it arrives.
      void pending.then((late) => { late.fields = {}; });
      return 'refused: the user has not approved this sign-in yet (AICO is asking them). Tell them, then call browser_login again once they have answered.';
    }
    if (!reply.ok) {
      const names = reply.candidates?.length ? ` Credentials bound to this origin: ${reply.candidates.join(', ')}.` : '';
      return `refused: ${reply.reason ?? 'the vault refused'}.${names}`;
    }
    let password = passwordOf(reply.kind, reply.fields) ?? '';
    const username = reply.username ?? '';
    reply.fields = {};
    if (!password) return `refused: "${reply.name}" is a ${reply.kind ?? 'credential'} without a password a sign-in form can take.`;
    try {
      // Two-step sign-in: the identifier first, then the password page.
      if (!form.password && form.identifierOnly) {
        if (!username) return `no matching login form: the page asks for a username first, and "${reply.name}" has none.`;
        if (!isUsernameField(form.identifierOnly.field) || !(await focusField(t, form.identifierOnly.ref))) return 'refused: the username field could not be focused safely (it may be in a frame, or not a plain text field).';
        await typeInto(t, username);
        await pressKey(t, 'Enter');
        await settle(wc);
        const deadline = Date.now() + 8000;
        while (Date.now() < deadline) {
          form = await evaluate<LoginFormReport>(wc, loginFormJs(0), 3000).catch(() => null);
          if (form?.password) break;
          await sleep(400);
        }
        if (!form?.password) return 'fields filled: the username was entered, but no password field appeared (the site may want a code or a different step — take a snapshot).';
        if (loginOrigin(wc.getURL()) !== origin) return `refused: the sign-in moved to ${loginOrigin(wc.getURL())}, which "${reply.name}" is not bound to. Nothing more was typed.`;
      }
      const pw = form.password!;
      if (!isRealPasswordField(pw.field)) return 'refused: the field that looks like the password is not a real password field.';
      if (form.username && username) {
        if (!isUsernameField(form.username.field)) return 'refused: the field next to the password is not a plain username field.';
        if (!(await focusField(t, form.username.ref))) return 'refused: the username field could not be focused safely.';
        await typeInto(t, username);
      }
      if (!(await focusField(t, pw.ref))) return 'refused: the password field could not be focused safely (it may be covered, or in a frame).';
      // The one place a value goes into a page for the agent: a trusted keystroke stream into this field.
      if (loginOrigin(wc.getURL()) !== origin) return 'refused: the page navigated away before the password was typed. Nothing was typed.';
      await typeInto(t, password);
      vault.markFilled(wc);
      vault.noteKnown(origin, username, password);
    } finally {
      password = '';
    }
    if (opts.submit === false) return `fields filled with "${reply.name}"${username ? ` (user ${username})` : ''}; not submitted.`;
    await pressKey(t, 'Enter');
    await settle(wc);
    await sleep(400);
    const after = await evaluate<LoginFormReport>(wc, loginFormJs(0), 4000).catch(() => null);
    const h = await humanCheck(t);
    if (h.detected) return `fields filled and submitted with "${reply.name}", and the site now shows a human check (${h.kind}) — call browser_handoff for the user.`;
    if (after?.otp) return `fields filled and submitted with "${reply.name}"; the site now asks for a one-time code — that is the user's (call browser_handoff).`;
    if (after?.password) return `fields filled and submitted with "${reply.name}", but the page still shows a sign-in form — take a snapshot and look for an error message (wrong password, locked account).`;
    return `signed in with "${reply.name}"${username ? ` as ${username}` : ''} — now at ${wc.getURL()}.`;
  }

  let pendingFind: { requestId: number; resolve: (r: FindResult) => void } | null = null;
  let lastFindText = '';

  const service: BrowserService = {
    tabs: list,
    state,
    agentStopped: () => agentStopped,
    async open(url, opts) {
      checkAccess();
      const t0 = activeId ? tabs.get(activeId) : undefined;
      if (t0?.dialog && !opts?.newTab) throw new Error(dialogOpenMessage(t0.dialog));
      agentOpen = { at: Date.now() };
      if (t0) agentEvent(t0, 'open', 'start', url);
      let r: TabInfo;
      try {
        r = await openUrl(url, opts);
      } catch (err) {
        // A URL that is a file, not a page: Chromium cancels the navigation and downloads it instead.
        await sleep(400);
        if (agentOpen.download) {
          const d = downloads.list().find(x => x.filename === agentOpen.download);
          return { ...(t0 ? info(t0) : {}), download: { file: agentOpen.download, path: d?.path, state: d?.state, note: 'This URL is a file: it was downloaded instead of opened. See browser_downloads.' } } as unknown as TabInfo;
        }
        throw err;
      }
      const t = tabs.get(r.id)!;
      agentEvent(t, 'open', 'done', r.url);
      const h = await humanCheck(t);
      const err = t.certError ? `\nCertificate error (${t.certError.error}) — the page is blocked and will not be accepted. Tell the user.` : t.error ? `\nThe page failed to load: ${t.error.description} (${t.error.code}).` : '';
      const login = h.detected || err ? undefined : await loginSuggestion(t).catch(() => undefined);
      return {
        ...r,
        ...(h.detected ? { humanCheck: `Human check on this page (${h.kind}) — call browser_handoff; do not attempt it.` } : {}),
        ...(err ? { error: err.trim() } : {}),
        ...(login ? { signIn: login } : {}),
      } as TabInfo;
    },
    openForUser(url, opts) {
      const prev = activeId;
      const opener = opts?.opener !== undefined ? byWc.get(opts.opener) : undefined;
      const p = openUrl(url, { newTab: true });
      // openUrl made the tab (and put it in front) before its first await.
      const t = activeId ? tabs.get(activeId) : undefined;
      if (t && t.id !== prev) {
        tabSession?.placeNew(t, opener?.id ?? prev ?? undefined);
        if (opts?.background && prev && tabs.has(prev)) { activeId = prev; layout(); pushState(); }
      }
      return p;
    },
    activeWebContents() {
      const t = activeId ? tabs.get(activeId) : undefined;
      return t && !t.view.webContents.isDestroyed() ? t.view.webContents : null;
    },
    autofill(opts) {
      return act('fill', { gate: true, diff: true, label: 'Filling from your profile' }, async (t) => {
        if (!autofillService) throw new Error('Autofill is not available.');
        return autofillService.describe(await autofillService.fill(t.view.webContents, opts));
      });
    },
    async snapshot(opts) {
      checkAccess();
      const t = active();
      agentEvent(t, 'snapshot', 'start');
      try { return await snapshotText(t, Boolean(opts?.full)); } finally { agentEvent(t, 'snapshot', 'done'); }
    },
    click(target, opts) {
      return act('click', { gate: true, diff: true }, async (t) => {
        const wc = t.view.webContents;
        const pre = await locate(t, target);
        const at = await locate(t, target, `AICO: clicking "${pre.label || pre.tag}"`);
        if (at.disabled) return `The ${at.tag} "${at.label}" is disabled — it cannot be clicked yet (a required field may be missing).`;
        if (at.isFile) return 'That is a file-upload control. Use browser_upload with this ref and the file paths — the user will be asked to confirm.';
        // Buying, paying, booking, sending, deleting: the person allows it here, or nothing is clicked.
        const sig = await commitSignals(t, at.ref);
        const commit = sig ? classifyCommit(sig) : null;
        if (commit) await requireCommitApproval(t, commit);
        await mouseClick(t, at.x, at.y, opts?.button ?? 'left', opts?.double ? 2 : 1);
        await settle(wc);
        return `Clicked ${at.tag} "${at.label}".${at.coveredBy ? ` Note: it looked covered by ${at.coveredBy} — the click may have hit that instead.` : ''}`;
      });
    },
    type(target, text, opts) {
      return act('type', { gate: true, diff: true }, async (t) => {
        const wc = t.view.webContents;
        const at = await locate(t, target);
        const s = classifySensitiveField(at.field);
        if (s) throw new Error(sensitiveRefusal(s.kind, at.label));
        await page(t, 'highlight', { target: { ref: at.ref }, label: `AICO: typing into "${at.label || at.tag}"` }).catch(() => {});
        await mouseClick(t, at.x, at.y);
        if (opts?.clear !== false) {
          await pressKey(t, process.platform === 'darwin' ? 'Meta+a' : 'Ctrl+a');
          await pressKey(t, 'Backspace');
        }
        await cdp(wc, 'Input.insertText', { text });
        if (opts?.submit) {
          // Enter submits the form this field is in: the same gate as a click on its button.
          const sig = await commitSignals(t, null);
          const commit = sig ? classifyCommit(sig) : null;
          if (commit) await requireCommitApproval(t, commit);
          await pressKey(t, 'Enter');
          await settle(wc);
        }
        return `Typed ${text.length} character(s) into ${at.tag} "${at.label}"${opts?.submit ? ' and pressed Enter' : ''}.`;
      });
    },
    press(key) {
      return act('press', { gate: true, diff: true, label: key }, async (t) => {
        if (keyWritesText(key)) {
          const f = await page<{ none?: boolean; field?: FieldDescriptor; label?: string }>(t, 'focused', {});
          const s = f.field ? classifySensitiveField(f.field) : null;
          if (s) throw new Error(sensitiveRefusal(s.kind, f.label ?? ''));
        }
        // Enter (or Space on a focused button) may submit a purchase or send a message.
        if (/^(enter|return|space| )$/i.test(key.trim())) {
          const focusedRef = await evaluate<string | null>(t.view.webContents, `(() => { const a = document.activeElement; if (!a || !a.matches || !a.matches('button, [role=button], input[type=submit], input[type=image], a')) return null; let r = a.getAttribute('data-aico-ref'); if (!r) { r = 'k' + Date.now().toString(36); a.setAttribute('data-aico-ref', r); } return r; })()`, 3000).catch(() => null);
          if (/^(enter|return)$/i.test(key.trim()) || focusedRef) {
            const sig = await commitSignals(t, focusedRef);
            const commit = sig ? classifyCommit(sig) : null;
            if (commit) await requireCommitApproval(t, commit);
          }
        }
        await pressKey(t, key);
        await settle(t.view.webContents);
        return `Pressed ${key}.`;
      });
    },
    select(target, value) {
      return act('select', { gate: true, diff: true }, async (t) => {
        const at = await locate(t, target, `AICO: choosing "${value}"`);
        if (!at.isSelect) return 'That element is not a <select>; click it and choose an option instead.';
        const r = await page<{ ok?: string; error?: string }>(t, 'setValue', { target: { ref: at.ref }, value });
        if (r.error) throw new Error(r.error);
        await settle(t.view.webContents);
        return `${r.ok} in "${at.label}".`;
      });
    },
    scroll(opts) {
      return act('scroll', {}, async (t) => {
        const wc = t.view.webContents;
        if (opts.target) { const at = await locate(t, opts.target); return `Scrolled ${at.tag} "${at.label}" into view.`; }
        const amount = opts.amount ?? 600;
        const dx = opts.direction === 'left' ? -amount : opts.direction === 'right' ? amount : 0;
        const dy = opts.direction === 'up' ? -amount : opts.direction === 'down' || !opts.direction ? amount : 0;
        const b = t.view.getBounds();
        await cdp(wc, 'Input.dispatchMouseEvent', { type: 'mouseWheel', x: Math.max(10, b.width / 2), y: Math.max(10, b.height / 2), deltaX: dx, deltaY: dy });
        await sleep(250);
        const y = await evaluate<number>(wc, 'Math.round(scrollY)');
        return `Scrolled ${opts.direction ?? 'down'} ${amount}px (now at ${y}px).`;
      });
    },
    scrollTo(target) {
      return act('scroll', {}, async (t) => {
        let tgt = target;
        if (!target.ref && !target.selector && target.text) {
          const f = await page<{ count: number; matches: Array<{ ref: string }> }>(t, 'find', { text: target.text, limit: 1 });
          if (!f.matches.length) throw new Error(`"${target.text}" is not on the page.`);
          tgt = { ref: f.matches[0]!.ref };
        }
        const at = await locate(t, tgt, 'AICO: here');
        return `Scrolled ${at.tag} "${at.label}" into view.`;
      });
    },
    hover(target) {
      return act('hover', { gate: true }, async (t) => {
        const at = await locate(t, target, `AICO: pointing at "${target.text ?? ''}"`);
        await cdp(t.view.webContents, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: at.x, y: at.y });
        await sleep(300);
        return `Hovering over ${at.tag} "${at.label}".`;
      });
    },
    waitFor(opts) {
      return act('wait', {}, async (t) => {
        const wc = t.view.webContents;
        const cond = opts.text || opts.gone || opts.selector || opts.url || opts.urlChange || opts.networkIdle;
        if (opts.ms && !cond) { await sleep(Math.min(opts.ms, 20000)); return `Waited ${opts.ms}ms.`; }
        const deadline = Date.now() + Math.min(opts.timeoutMs ?? 10000, 25000);
        const startUrl = wc.getURL();
        const what = opts.text ? `"${opts.text}"` : opts.gone ? `"${opts.gone}" to disappear` : opts.selector ? opts.selector : opts.url ? `URL containing "${opts.url}"` : opts.urlChange ? 'the URL to change' : 'the network to go idle';
        while (Date.now() < deadline) {
          if (t.dialog) return dialogOpenMessage(t.dialog);
          const url = wc.getURL();
          let ok = true;
          if (opts.url && !url.includes(opts.url)) ok = false;
          if (opts.urlChange && url === startUrl) ok = false;
          if (opts.networkIdle && !(Date.now() - t.lastNetAt >= 500 && t.inflight.size <= (Date.now() - t.lastNetAt > 2000 ? 2 : 0))) ok = false;
          if (ok && (opts.text || opts.gone || opts.selector)) {
            ok = await evaluate<boolean>(wc, `(() => {
              const body = document.body ? document.body.innerText.toLowerCase() : '';
              ${opts.selector ? `if (!document.querySelector(${JSON.stringify(opts.selector)})) return false;` : ''}
              ${opts.text ? `if (!body.includes(${JSON.stringify(opts.text.toLowerCase())})) return false;` : ''}
              ${opts.gone ? `if (body.includes(${JSON.stringify(opts.gone.toLowerCase())})) return false;` : ''}
              return true;
            })()`, 5000).catch(() => false);
          }
          if (ok) return `Found ${what}. Now at ${wc.getURL()}.`;
          await sleep(300);
        }
        throw new Error(`Timed out waiting for ${what}. Now at ${wc.getURL()}.`);
      });
    },
    async text(target) {
      checkAccess();
      const t = active();
      const s = await evaluate<string>(t.view.webContents, target ? `(() => {
        const t = ${JSON.stringify(target)};
        const el = t.ref ? document.querySelector('[data-aico-ref="' + t.ref + '"]') : t.selector ? document.querySelector(t.selector) : null;
        return el ? el.innerText : 'No such element.';
      })()` : 'document.body ? document.body.innerText : ""');
      return (s ?? '').slice(0, 40000);
    },
    async evaluate(expression) {
      let out: unknown;
      await act('evaluate', { gate: true }, async (t) => { vault.guardAgent(t.view.webContents); out = await evaluate(t.view.webContents, expression); return ''; });
      return out;
    },
    async screenshot(opts) {
      if (opts?.forModel) checkAccess();
      const t = active();
      const wc = t.view.webContents;
      if (t.dialog) throw new Error(dialogOpenMessage(t.dialog));
      let dataUrl: string; let width: number; let height: number;
      let model: { data: string; mimeType: string } | undefined;
      if (opts?.fullPage) {
        const m = await cdp<{ contentSize: { width: number; height: number } }>(wc, 'Page.getLayoutMetrics');
        const w = Math.min(4000, Math.ceil(m.contentSize.width)); const h = Math.min(12000, Math.ceil(m.contentSize.height));
        const r = await boundedCapture(cdp<{ data: string }>(wc, 'Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: 0, y: 0, width: w, height: h, scale: 1 } }), 'The full-page screenshot');
        dataUrl = `data:image/png;base64,${r.data}`; width = w; height = h;
        if (opts.forModel) {
          const mh = Math.min(h, 6000);
          const scale = Math.min(1, 1280 / Math.max(1, w));
          const j = await boundedCapture(cdp<{ data: string }>(wc, 'Page.captureScreenshot', { format: 'jpeg', quality: 70, captureBeyondViewport: true, clip: { x: 0, y: 0, width: w, height: mh, scale } }), 'The full-page screenshot');
          model = { data: j.data, mimeType: 'image/jpeg' };
        }
      } else {
        // A still for a hidden view (under a menu) is the one browser:setBounds
        // captured as it hid it. Capturing a hidden view hangs, so it never is.
        if (!opts?.forModel && !visible) {
          if (t.lastStill) return { path: '', ...t.lastStill };
          throw new Error('The page is not on screen, so there is nothing to capture.');
        }
        const r = await boundedCapture(cdp<{ data: string }>(wc, 'Page.captureScreenshot', { format: 'png' }), 'The screenshot');
        dataUrl = `data:image/png;base64,${r.data}`;
        const b = t.view.getBounds(); width = b.width; height = b.height;
        if (opts?.forModel) {
          const j = await boundedCapture(cdp<{ data: string }>(wc, 'Page.captureScreenshot', { format: 'jpeg', quality: 70 }), 'The screenshot');
          model = { data: j.data, mimeType: 'image/jpeg' };
        }
      }
      // The image's own size, from its PNG header: the view's bounds differ from
      // what the page captured whenever the view is hidden or being resized, and
      // the interface drew the still stretched.
      const png = Buffer.from(dataUrl.split(',')[1]!, 'base64');
      if (png.length > 24 && png.toString('ascii', 12, 16) === 'IHDR') { width = png.readUInt32BE(16); height = png.readUInt32BE(20); }
      if (!opts?.fullPage) t.lastStill = { dataUrl, width, height };
      // Only the agent's screenshots are kept as files; the interface's stills
      // under menus and the floating copilot are taken often and need none.
      let file = '';
      if (opts?.forModel) {
        fs.mkdirSync(shotsDir, { recursive: true });
        file = path.join(shotsDir, `shot-${new Date().toISOString().replace(/[:.]/g, '-')}.png`);
        fs.writeFileSync(file, png);
        agentEvent(t, 'screenshot', 'done');
      }
      return { path: file, dataUrl, width, height, ...(model ? { model } : {}) };
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
    async back() {
      const t = active(); const wc = t.view.webContents;
      t.lastNav = () => { if (wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack(); };
      if (wc.navigationHistory.canGoBack()) { wc.navigationHistory.goBack(); await settle(wc); }
      return wc.getURL();
    },
    async forward() {
      const t = active(); const wc = t.view.webContents;
      t.lastNav = () => { if (wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward(); };
      if (wc.navigationHistory.canGoForward()) { wc.navigationHistory.goForward(); await settle(wc); }
      return wc.getURL();
    },
    async reload() {
      const t = active(); const wc = t.view.webContents;
      t.lastNav = () => wc.reload();
      wc.reload(); await waitLoad(wc); return wc.getURL();
    },
    closeTab(id) {
      const t = tabs.get(id ?? activeId ?? '');
      if (!t) return;
      // Remembered for Ctrl+Shift+T; the tab to its right comes forward.
      const next = tabSession?.closing(t);
      if (t.attached && placedIn && !placedIn.isDestroyed()) placedIn.contentView.removeChildView(t.view);
      for (const [k, d] of dialogs) if (d.tab === t) { d.reply?.(false); dialogs.delete(k); }
      if (!t.view.webContents.isDestroyed()) t.view.webContents.close();
      tabs.delete(t.id);
      if (activeId === t.id) activeId = next !== undefined && (next === null || tabs.has(next)) ? next : [...tabs.keys()].pop() ?? null;
      const front = activeId ? tabs.get(activeId) : undefined;
      if (front?.deferred) tabSession?.wake(front);
      layout(); pushState();
    },
    selectTab(id) {
      const t = tabs.get(id);
      if (!t) return;
      activeId = id;
      if (t.deferred) tabSession?.wake(t);
      layout(); pushState();
    },
    async newTab(url) {
      return openUrl(url || ctx.prefs.get().browserHome || 'about:blank', { newTab: true });
    },
    handoff(message, timeoutMs = 10 * 60_000) {
      const id = `h${Date.now()}`;
      ctx.emit('browser:handoff', { id, message });
      const t = activeId ? tabs.get(activeId) : undefined;
      if (t) ctx.emit('browser:agent', { tabId: t.id, action: 'handoff', status: 'blocked', label: message.slice(0, 120) } satisfies AgentEvent);
      ctx.revealBrowser();
      return new Promise<string>((resolve) => {
        const timer = setTimeout(() => { handoffs.delete(id); resolve('The user did not respond in time.'); }, timeoutMs);
        handoffs.set(id, (answer) => { clearTimeout(timer); resolve(answer); });
      });
    },

    login(opts) {
      return act('login', { gate: true, diff: false, label: `Signing in${opts.name ? ` with ${opts.name}` : ''} from the vault` }, (t) => loginImpl(t, opts));
    },
    async read(opts) {
      checkAccess();
      const t = active();
      agentEvent(t, 'read', 'start', opts.mode === 'full' ? 'Reading the whole page' : 'Reading the page');
      try { return await readPage(t, opts); } finally { agentEvent(t, 'read', 'done'); }
    },
    async forms() {
      checkAccess();
      const t = active();
      agentEvent(t, 'forms', 'start', 'Reading the forms');
      try { return await formsOf(t); } finally { agentEvent(t, 'forms', 'done'); }
    },
    fill(fields) {
      return act('fill', { gate: true, diff: true, label: `Filling ${fields.length} field(s)` }, async (t) => {
        const wc = t.view.webContents;
        const model = await formsOf(t);
        const lines: string[] = [];
        let filled = 0;
        for (const spec of fields) {
          const want = spec.ref ?? spec.label ?? spec.name ?? '?';
          const f = matchField(model, spec);
          if (!f) { lines.push(`- "${want}": not found (see browser_forms for the fields)`); continue; }
          const name = f.label || f.name || f.ref;
          if (f.sensitive) { lines.push(`- "${name}": REFUSED — ${f.sensitive} field; the user must enter it (browser_handoff)`); continue; }
          if (f.disabled) { lines.push(`- "${name}": disabled, skipped`); continue; }
          const value = spec.value;
          try {
            if (f.type === 'radio-group') {
              const want2 = String(value).toLowerCase();
              const opt = (f.options ?? []).find(o => o.value.toLowerCase() === want2 || o.label.toLowerCase() === want2)
                ?? (f.options ?? []).find(o => o.label.toLowerCase().includes(want2));
              const ref = (opt as { ref?: string } | undefined)?.ref;
              if (!opt || !ref) { lines.push(`- "${name}": no option "${value}" (options: ${(f.options ?? []).map(o => o.label || o.value).join(', ')})`); continue; }
              const at = await locate(t, { ref }, `AICO: choosing "${opt.label}"`);
              if (!at.checked) await mouseClick(t, at.x, at.y);
              lines.push(`- "${name}": chose "${opt.label || opt.value}"`);
            } else if (f.type === 'checkbox') {
              const on = typeof value === 'boolean' ? value : /^(true|yes|on|1|checked)$/i.test(String(value));
              const at = await locate(t, { ref: f.ref }, `AICO: ${on ? 'ticking' : 'unticking'} "${name}"`);
              if (Boolean(at.checked) !== on) await mouseClick(t, at.x, at.y);
              lines.push(`- "${name}": ${on ? 'checked' : 'unchecked'}`);
            } else if (f.type === 'select' || f.type === 'select-multiple' || ['date', 'time', 'datetime-local', 'month', 'week', 'color', 'range'].includes(f.type)) {
              await page(t, 'highlight', { target: { ref: f.ref }, label: `AICO: setting "${name}"` }).catch(() => {});
              const r = await page<{ ok?: string; error?: string }>(t, 'setValue', { target: { ref: f.ref }, value: String(value) });
              if (r.error) { lines.push(`- "${name}": ${r.error}`); continue; }
              lines.push(`- "${name}": ${r.ok}`);
            } else if (f.type === 'file') {
              lines.push(`- "${name}": file field — use browser_upload`); continue;
            } else {
              const at = await locate(t, { ref: f.ref }, `AICO: typing into "${name}"`);
              // Re-check on the live element: the model may be stale.
              const s = classifySensitiveField(at.field);
              if (s) { lines.push(`- "${name}": REFUSED — ${s.kind} field; the user must enter it (browser_handoff)`); continue; }
              await mouseClick(t, at.x, at.y);
              await pressKey(t, process.platform === 'darwin' ? 'Meta+a' : 'Ctrl+a');
              await pressKey(t, 'Backspace');
              await cdp(wc, 'Input.insertText', { text: String(value) });
              lines.push(`- "${name}": typed "${String(value).slice(0, 60)}"`);
            }
            filled++;
          } catch (err) {
            lines.push(`- "${name}": failed — ${(err as Error).message.slice(0, 200)}`);
          }
          await sleep(80);
        }
        // Blur the last field so on-blur validation runs.
        await pressKey(t, 'Tab').catch(() => {});
        await sleep(200);
        return `Filled ${filled} of ${fields.length} field(s). Nothing was submitted.\n${lines.join('\n')}`;
      });
    },
    async extract(kind, opts) {
      checkAccess();
      const t = active();
      agentEvent(t, 'extract', 'start', `Extracting ${kind}`);
      try {
        await waitLoad(t.view.webContents, 8000);
        const max = Math.max(1, Math.min(opts?.maxItems ?? 200, 1000));
        const raw = await page<Record<string, unknown>>(t, 'extract', { kind }, 20_000);
        if (raw.error) throw new Error(String(raw.error));
        const url = t.view.webContents.getURL();
        if (kind === 'links') {
          const host = (() => { try { return new URL(url).hostname; } catch { return ''; } })();
          const links = (raw.links as Array<{ text: string; href: string; rel?: string; ref: string }>).slice(0, max)
            .map(l => { let internal = false; try { internal = new URL(l.href).hostname === host; } catch { /* keep */ } return { ...l, internal }; });
          return JSON.stringify({ url, count: (raw.links as unknown[]).length, links }, null, 1);
        }
        if (kind === 'tables') {
          const tables = raw.tables as Array<{ caption: string; rows: string[][] }>;
          if (!tables.length) return 'No data tables on this page.';
          return tables.slice(0, 20).map((tb, i) => `Table ${i + 1}${tb.caption ? ` — ${tb.caption}` : ''} (${tb.rows.length} rows)\n${tableToMarkdown({ rows: tb.rows })}`).join('\n\n');
        }
        if (kind === 'prices') {
          const prices = findPrices(raw.blocks as Array<{ text: string; context?: string }>, raw.structured as Array<{ amount: string; currency: string; context?: string; source: string }>);
          return JSON.stringify({ url, count: prices.length, prices: prices.slice(0, max) }, null, 1);
        }
        if (kind === 'contacts') {
          return JSON.stringify({ url, ...findContacts(String(raw.text ?? ''), raw.links as Array<{ href: string; text: string }>) }, null, 1);
        }
        return JSON.stringify(raw, null, 1).slice(0, 60_000);
      } finally { agentEvent(t, 'extract', 'done'); }
    },
    async insights() {
      checkAccess();
      const t = active();
      agentEvent(t, 'insights', 'start', 'Looking at the page');
      try { return await insightsOf(t); } finally { agentEvent(t, 'insights', 'done'); }
    },
    async find(text, limit) {
      checkAccess();
      const t = active();
      agentEvent(t, 'find', 'start', `Finding "${text}"`);
      try {
        const r = await page<{ count: number; matches: Array<{ ref: string; tag: string; context: string }> }>(t, 'find', { text, limit: limit ?? 20, guard: privacy.injectionGuard() });
        if (!r.count) return `"${text}" is not on the page (${t.view.webContents.getURL()}).`;
        return [`${r.count} match(es) for "${text}"${r.count > r.matches.length ? ` (first ${r.matches.length})` : ''}:`, ...r.matches.map(m => `[${m.ref}] ${m.tag}: …${m.context}…`)].join('\n');
      } finally { agentEvent(t, 'find', 'done'); }
    },
    dialogs() {
      return [...dialogs.values()].map(d => d.req);
    },
    async answerDialog(opts) {
      checkAccess();
      const t = active();
      const entry = opts.id ? dialogs.get(opts.id) : [...dialogs.values()].find(d => d.tab === t) ?? [...dialogs.values()][0];
      if (!entry) return 'No JavaScript dialog is open.';
      agentEvent(entry.tab, 'dialog', 'start', `${opts.accept ? 'Accepting' : 'Dismissing'} "${entry.req.message.slice(0, 60)}"`);
      await answerDialogImpl(entry.req.id, opts.accept, opts.text);
      await settle(entry.tab.view.webContents);
      agentEvent(entry.tab, 'dialog', 'done');
      return `${opts.accept ? 'Accepted' : 'Dismissed'} the ${entry.req.type} dialog. Now at ${entry.tab.view.webContents.getURL()} — take a snapshot to continue.`;
    },
    downloads: () => downloads.list(),
    upload(target, files) {
      return act('upload', { gate: true, diff: false, label: `Uploading ${files.length} file(s)` }, async (t) => {
        if (!files.length) throw new Error('Give at least one file path.');
        const abs = files.map(f => path.resolve(f));
        for (const f of abs) {
          let st: fs.Stats;
          try { st = fs.statSync(f); } catch { throw new Error(`No such file: ${f}`); }
          if (!st.isFile()) throw new Error(`Not a file: ${f}`);
        }
        const at = await locate(t, target, 'AICO: upload here');
        let ref = at.ref;
        if (!at.isFile) {
          // A styled button often stands in for a hidden <input type=file>: find the real one.
          const found = await evaluate<string | null>(t.view.webContents, `(() => {
            const el = document.querySelector('[data-aico-ref="${at.ref}"]');
            if (!el) return null;
            const pick = (x) => { if (!x) return null; if (!x.getAttribute('data-aico-ref')) x.setAttribute('data-aico-ref', 'f' + Math.random().toString(36).slice(2, 8)); return x.getAttribute('data-aico-ref'); };
            const inner = el.querySelector && el.querySelector('input[type=file]'); if (inner) return pick(inner);
            if (el.tagName === 'LABEL' && el.control && el.control.type === 'file') return pick(el.control);
            const lab = el.closest && el.closest('label'); if (lab && lab.control && lab.control.type === 'file') return pick(lab.control);
            const form = el.closest && el.closest('form'); const inForm = form ? form.querySelectorAll('input[type=file]') : [];
            if (inForm.length === 1) return pick(inForm[0]);
            const all = document.querySelectorAll('input[type=file]'); if (all.length === 1) return pick(all[0]);
            return null;
          })()`);
          if (!found) throw new Error('That is not a file-upload field, and no single file input belongs to it. Take a snapshot: file inputs show with role "file".');
          ref = found;
        }
        const origin = originOf(t.view.webContents.getURL()) || t.view.webContents.getURL();
        const names = abs.map(f => path.basename(f));
        const c = confirm({
          kind: 'upload', origin, files: abs,
          title: `Let the agent upload ${names.length === 1 ? names[0] : `${names.length} files`} to ${origin}?`,
          detail: `The agent wants to attach ${names.join(', ')} to a form on ${origin}. The file${names.length > 1 ? 's' : ''} will be sent to that site when the form is submitted.`,
        });
        const u = { state: 'pending' as 'pending' | 'allowed' | 'denied' | 'done' | 'failed', result: undefined as string | undefined, tabId: t.id, ref, files: abs };
        uploads.set(c.id, u);
        void c.done.then(async (ok) => {
          if (!ok) { u.state = 'denied'; u.result = 'The user declined the upload. Do not retry; ask the user how to proceed.'; return; }
          u.state = 'allowed';
          try {
            const tab = tabs.get(u.tabId);
            if (!tab) throw new Error('The tab was closed.');
            const obj = await cdp<{ result: { objectId?: string } }>(tab.view.webContents, 'Runtime.evaluate', { expression: pageJs('element', { target: { ref: u.ref } }), returnByValue: false });
            if (!obj.result.objectId) throw new Error('The file field is gone (the page changed).');
            await cdp(tab.view.webContents, 'DOM.setFileInputFiles', { files: u.files, objectId: obj.result.objectId });
            u.state = 'done';
            u.result = `The user approved. Attached ${names.join(', ')} to the file field. Nothing was submitted — submit the form when ready.`;
          } catch (err) {
            u.state = 'failed';
            u.result = `The user approved, but attaching failed: ${(err as Error).message}`;
          }
        });
        return waitUpload(c.id, 20);
      });
    },
    uploadWait(id, seconds) {
      checkAccess();
      return waitUpload(id, Math.min(25, seconds ?? 20));
    },
    rehost() {
      // Hidden until the new window's page area reports where the page goes (browser:setBounds).
      bounds = null;
      visible = false;
      layout();
      pushState();
    },
    guardText(text) {
      if (!privacy.injectionGuard()) return text;
      const t = activeId ? tabs.get(activeId) : undefined;
      const url = t && !t.view.webContents.isDestroyed() ? t.view.webContents.getURL() : '';
      const pending = t?.guardPending && t.guardPending.url === url ? t.guardPending.report : undefined;
      if (t) t.guardPending = undefined;
      const g = guardPageText(text, { hidden: pending?.count, tricks: pending?.tricks, hiddenSamples: pending?.samples });
      if (t && url && (g.hidden || g.flagged || g.hiddenFlagged)) {
        // One page's totals: the most any single read saw, and every distinct snippet (up to 8).
        const prev = t.guard && t.guard.url === url ? t.guard : { url, hidden: 0, flagged: 0, snippets: [] };
        const snippets = [...prev.snippets];
        for (const sn of g.snippets) if (snippets.length < 8 && !snippets.some(x => x.text === sn.text)) snippets.push({ text: sn.text, hidden: sn.hidden });
        t.guard = { url, hidden: Math.max(prev.hidden, g.hidden), flagged: Math.max(prev.flagged, g.flagged), snippets };
        pushState();
      }
      return withNotice(g);
    },
  };
  ctx.services.browser = service;

  async function waitUpload(id: string, seconds: number): Promise<string> {
    const deadline = Date.now() + seconds * 1000;
    while (Date.now() < deadline) {
      const u = uploads.get(id);
      if (!u) throw new Error('Unknown upload id.');
      if (u.state === 'done' || u.state === 'denied' || u.state === 'failed') { uploads.delete(id); return u.result ?? u.state; }
      await sleep(400);
    }
    return `Waiting for the user to approve the upload in AICO. Call browser_upload_wait with uploadId "${id}" to keep waiting.`;
  }

  async function answerDialogImpl(id: string, accept: boolean, text?: string): Promise<void> {
    const entry = dialogs.get(id);
    if (!entry) return;
    dialogs.delete(id);
    const t = entry.tab;
    if (entry.req.type === 'beforeunload') {
      if (accept && t.lastNav) { t.allowUnload = true; t.lastNav(); setTimeout(() => { t.allowUnload = false; }, 3000); }
      pushState();
      return;
    }
    if (t.dialog?.id === id) t.dialog = undefined;
    if (entry.reply) { entry.reply(accept, text); pushState(); return; }
    await cdp(t.view.webContents, 'Page.handleJavaScriptDialog', { accept, ...(text !== undefined ? { promptText: text } : {}) }).catch(() => { /* already closed */ });
    pushState();
  }

  // alert / confirm / prompt from a page, through the dialog preload: the page waits (sendSync) until answered.
  ipcMain.removeAllListeners(DIALOG_CHANNEL);
  ipcMain.on(DIALOG_CHANNEL, (e, req: { type?: string; message?: string; defaultPrompt?: string }) => {
    const t = byWc.get(e.sender.id);
    const type = (['alert', 'confirm', 'prompt'] as const).find(x => x === req?.type);
    if (!t || !type) { e.returnValue = { accept: false }; return; }
    // A page that loops on dialogs is answered "cancel" instead of trapping the user.
    const now = Date.now();
    const burst = (dialogBursts.get(t.id) ?? []).filter(x => now - x < 10_000);
    burst.push(now);
    dialogBursts.set(t.id, burst);
    if (burst.length > 15 || t.dialog) { e.returnValue = { accept: false }; return; }
    const d: DialogRequest = {
      id: askId('j'), tabId: t.id, type, message: String(req.message ?? '').slice(0, 5000),
      ...(type === 'prompt' ? { defaultPrompt: String(req.defaultPrompt ?? '') } : {}), byAgent: agentDriving(t),
    };
    let done = false;
    raiseDialog(t, d, {
      reply: (accept, text) => {
        if (done) return;
        done = true;
        e.returnValue = { accept, ...(text !== undefined ? { text } : type === 'prompt' && accept ? { text: d.defaultPrompt ?? '' } : {}) };
      },
    });
    pushState();
  });

  // ── Interface: the earlier channels ──
  ctx.handle('browser:tabs', () => list());
  ctx.handle('browser:open', (url: string, newTab?: boolean) => openUrl(url, { newTab }));
  ctx.handle('browser:newTab', (url?: string) => { tabSession?.restore(); const t = create(url || ctx.prefs.get().browserHome); return info(t); });
  ctx.handle('browser:close', (id: string) => service.closeTab(id));
  ctx.handle('browser:select', (id: string) => service.selectTab(id));
  ctx.handle('browser:back', () => service.back());
  ctx.handle('browser:forward', () => service.forward());
  ctx.handle('browser:reload', () => { const t = active(); t.lastNav = () => t.view.webContents.reload(); t.view.webContents.reload(); });
  ctx.handle('browser:stop', () => { active().view.webContents.stop(); });
  ctx.handle('browser:zoom', (delta: number) => {
    const wc = active().view.webContents;
    const next = delta === 0 ? 1 : Math.max(0.3, Math.min(3, Math.round((wc.getZoomFactor() + delta) * 100) / 100));
    wc.setZoomFactor(next);
    const origin = originOf(wc.getURL());
    if (origin) {
      const s = settings.get();
      const zoom = { ...s.zoom };
      if (next === 1) delete zoom[origin]; else zoom[origin] = next;
      settings.set({ ...s, zoom });
    }
    pushState();
    return next;
  });
  ctx.handle('browser:devtools', () => active().view.webContents.toggleDevTools());
  ctx.handle('browser:external', () => { const u = active().view.webContents.getURL(); if (/^https?:/.test(u)) void shell.openExternal(u); });
  // The interface lays the page over its placeholder, in CSS pixels; a zoomed interface needs them scaled to the window's.
  // Covering the page (a menu, a dialog) hides it: while it is still on screen it is captured, so the reply
  // carries a still for the interface to draw in its place. Capturing a *hidden* view can hang, so it never is.
  // Only the window the browser is in lays it out: the other one's pane is a placeholder, and its
  // last word (hiding the page as it unmounts) must not hide the page in the window that has it.
  let boundsGen = 0;
  ipcMain.removeHandler('browser:setBounds');
  ipcMain.handle('browser:setBounds', async (e, b: { x: number; y: number; width: number; height: number } | null, show: boolean): Promise<{ still?: PageStill; elsewhere?: boolean }> => {
    const win = ctx.browserWindow();
    // Said back, so a pane that missed the move (a window still loading when it happened) shows where the browser went.
    if (!win || win.isDestroyed() || e.sender !== win.webContents) return { elsewhere: true };
    const gen = ++boundsGen;
    const z = win.webContents.getZoomFactor();
    const next = b ? { x: Math.round(b.x * z), y: Math.round(b.y * z), width: Math.max(1, Math.round(b.width * z)), height: Math.max(1, Math.round(b.height * z)) } : null;
    const willShow = show && next !== null;
    const t = activeId ? tabs.get(activeId) : undefined;
    let still: PageStill | undefined;
    if (visible && !willShow && next !== null && t?.attached) {
      still = await captureStill(t);
      // A newer call has already laid the page out; this one only hands back its still.
      if (gen !== boundsGen) return still ? { still } : {};
    }
    bounds = next;
    visible = willShow;
    // First time on screen this run: "Continue where you left off", or the home page.
    if (visible && tabs.size === 0 && !tabSession?.restore()) create(ctx.prefs.get().browserHome);
    layout();
    return still ? { still } : {};
  });
  ctx.handle('browser:still', (): PageStill | null => {
    const t = activeId ? tabs.get(activeId) : undefined;
    return t?.lastStill ? { tabId: t.id, ...t.lastStill } : null;
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

  // ── Interface: the full browser (shared/browser-types.ts) ──
  ctx.handle('browser:state', () => state());

  ctx.handle('browser:history:list', (opts?: HistoryListOptions) => searchHistory(history.get(), opts?.query, opts?.limit ?? 200));
  ctx.handle('browser:history:remove', (url: string) => { history.set(removeHistory(history.get(), String(url))); learn.forgetUrl(String(url)); memory.forgetUrl(String(url)); return true; });
  ctx.handle('browser:history:clear', (sinceMs?: number) => { history.set(clearHistory(history.get(), sinceMs)); history.flush(); privacy.clearInsights(sinceMs); learn.clear(sinceMs); memory.clear(sinceMs); return true; });

  ctx.handle('browser:downloads:list', () => downloads.list());
  ctx.handle('browser:downloads:open', (id: string) => downloads.open(id));
  ctx.handle('browser:downloads:show', (id: string) => downloads.show(id));
  ctx.handle('browser:downloads:cancel', (id: string) => downloads.cancel(id));
  ctx.handle('browser:downloads:retry', (id: string) => downloads.retry(id));
  ctx.handle('browser:downloads:clear', () => downloads.clear());

  ctx.handle('browser:find', (req: FindRequest) => new Promise<FindResult>((resolve) => {
    const wc = active().view.webContents;
    const text = String(req?.text ?? '');
    if (!text) { wc.stopFindInPage('clearSelection'); lastFindText = ''; resolve({ matches: 0, active: 0 }); return; }
    // Electron's findNext means "start a new session"; the contract's means "go to the next match".
    const followUp = Boolean(req.findNext) && text === lastFindText;
    lastFindText = text;
    if (pendingFind) pendingFind.resolve({ matches: 0, active: 0 });
    const requestId = wc.findInPage(text, { forward: req.forward !== false, findNext: !followUp });
    pendingFind = { requestId, resolve };
    setTimeout(() => { if (pendingFind?.requestId === requestId) { pendingFind = null; resolve({ matches: 0, active: 0 }); } }, 2000);
  }));
  ctx.handle('browser:findStop', () => { lastFindText = ''; active().view.webContents.stopFindInPage('clearSelection'); });

  ctx.handle('browser:print', () => new Promise<boolean>((resolve) => {
    active().view.webContents.print({ printBackground: true }, (ok) => resolve(ok));
  }));
  ctx.handle('browser:savePdf', async () => {
    const wc = active().view.webContents;
    const w = ctx.browserWindow();
    const name = `${(wc.getTitle() || 'page').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 100).trim() || 'page'}.pdf`;
    const opts = { defaultPath: path.join(app.getPath('downloads'), name), filters: [{ name: 'PDF', extensions: ['pdf'] }] };
    const r = w ? await dialog.showSaveDialog(w, opts) : await dialog.showSaveDialog(opts);
    if (r.canceled || !r.filePath) return null;
    const pdf = await wc.printToPDF({ printBackground: true, pageSize: 'A4' });
    fs.writeFileSync(r.filePath, pdf);
    return r.filePath;
  });

  ctx.handle('browser:siteInfo', (): SiteInfo => {
    const t = active();
    const url = t.view.webContents.getURL();
    const origin = originOf(url);
    let host = '';
    try { host = new URL(url).hostname; } catch { /* not a web page */ }
    const remembered = settings.get().permissions[origin] ?? {};
    const permissions: Record<string, PermissionSetting> = {};
    for (const p of PERMISSIONS_SHOWN) permissions[p] = remembered[p] ?? 'ask';
    for (const [p, v] of Object.entries(remembered)) permissions[p] = v;
    const s = settings.get().blocking;
    const cert = /^https:/.test(url) ? certs.get(host) : undefined;
    return {
      url, origin, security: securityOf(t), ...(cert ? { certificate: cert } : {}), permissions,
      trackersBlocked: t.trackersBlocked, trackers: [...t.trackers].sort(),
      blockingAllowedHere: s.enabled && !s.allowOrigins.includes(origin),
    };
  });
  ctx.handle('browser:blocking:set', (o: { enabled?: boolean; allowOrigin?: string; disallowOrigin?: string }) => {
    const s = settings.get();
    let allow = [...s.blocking.allowOrigins];
    const norm = (x: string): string => originOf(x) || x;
    if (o?.allowOrigin) allow = [...new Set([...allow, norm(o.allowOrigin)])];
    if (o?.disallowOrigin) allow = allow.filter(a => a !== norm(o.disallowOrigin!));
    settings.set({ ...s, blocking: { enabled: typeof o?.enabled === 'boolean' ? o.enabled : s.blocking.enabled, allowOrigins: allow } });
    pushState();
    return { enabled: settings.get().blocking.enabled };
  });
  ctx.handle('browser:permissions:set', (o: { origin: string; permission: string; value: PermissionSetting }) => {
    const s = settings.get();
    const perms = { ...s.permissions };
    const cur = { ...(perms[o.origin] ?? {}) };
    if (o.value === 'ask') delete cur[o.permission]; else cur[o.permission] = o.value;
    if (Object.keys(cur).length) perms[o.origin] = cur; else delete perms[o.origin];
    settings.set({ ...s, permissions: perms });
    return true;
  });
  // Every site's remembered permissions, for Privacy & security; reset one site (or all).
  ctx.handle('browser:permissions:list', () => Object.entries(settings.get().permissions).map(([origin, permissions]) => ({ origin, permissions })).sort((a, b) => a.origin.localeCompare(b.origin)));
  ctx.handle('browser:permissions:reset', (origin?: string) => {
    const s = settings.get();
    const perms = origin ? Object.fromEntries(Object.entries(s.permissions).filter(([o]) => o !== origin)) : {};
    settings.set({ ...s, permissions: perms });
    return true;
  });
  ctx.handle('browser:mute', (tabId: string, muted: boolean) => {
    const t = tabs.get(tabId) ?? active();
    t.view.webContents.setAudioMuted(Boolean(muted));
    pushState();
  });

  ctx.handle('browser:read', (req?: { mode?: 'reader' | 'full'; maxChars?: number }) => readPage(active(), req ?? {}));
  /** The text the user has selected in the page (for the copilot), '' when none. */
  ctx.handle('browser:selection', async () => {
    const t = activeId ? tabs.get(activeId) : undefined;
    if (!t || t.dialog || t.view.webContents.isDestroyed()) return '';
    // Only the copilot asks for this, as it sends a message about the page: a use of the copilot on this site.
    learn.noteCopilot(t.view.webContents.getURL());
    return evaluate<string>(t.view.webContents, `(() => { const s = String(getSelection() || ''); if (s) return s; const a = document.activeElement; return a && typeof a.value === 'string' && typeof a.selectionStart === 'number' && a.type !== 'password' ? a.value.slice(a.selectionStart, a.selectionEnd) : ''; })()`, 1500).then(s => (s ?? '').slice(0, 20_000)).catch(() => '');
  });
  ctx.handle('browser:insights', () => insightsOf(active()));
  // The copilot's "Open tabs" header block and its chip (browser-tab-summary.ts).
  ctx.handle('browser:tabs:summary', () => tabAware.view());
  ctx.handle('browser:forms', () => formsOf(active()));

  ctx.handle('browser:agentStop', () => {
    agentStopped = true;
    const t = activeId ? tabs.get(activeId) : undefined;
    if (t) { t.agentUntil = 0; ctx.emit('browser:agent', { tabId: t.id, action: 'stop', status: 'blocked', detail: 'The user took control' } satisfies AgentEvent); }
    pushState();
  });
  ctx.handle('browser:agentResume', () => { agentStopped = false; pushState(); });

  ctx.handle('browser:permissionAnswer', (id: string, allow: boolean, remember: boolean) => {
    const p = pendingPerms.get(id);
    if (!p) return false;
    pendingPerms.delete(id);
    clearTimeout(p.timer);
    p.cb(Boolean(allow));
    if (remember) {
      const s = settings.get();
      settings.set({ ...s, permissions: { ...s.permissions, [p.origin]: { ...(s.permissions[p.origin] ?? {}), [p.name]: allow ? 'allow' : 'deny' } } });
    }
    return true;
  });
  ctx.handle('browser:dialogAnswer', async (id: string, accept: boolean, text?: string) => { await answerDialogImpl(id, Boolean(accept), text); return true; });
  ctx.handle('browser:authAnswer', (id: string, creds: { username: string; password: string } | null) => {
    const a = pendingAuth.get(id);
    if (!a) return false;
    pendingAuth.delete(id);
    clearTimeout(a.timer);
    if (creds && typeof creds.username === 'string') a.cb(creds.username, String(creds.password ?? '')); else a.cb();
    return true;
  });
  ctx.handle('browser:confirmAnswer', (id: string, allow: boolean) => {
    const c = pendingConfirm.get(id);
    if (!c) return false;
    pendingConfirm.delete(id);
    clearTimeout(c.timer);
    c.resolve(Boolean(allow));
    return true;
  });
  ctx.handle('browser:certAnswer', (tabId: string, proceed?: boolean) => {
    if (proceed) throw new Error('A page with a certificate error cannot be opened here.');
    const t = tabs.get(tabId) ?? active();
    const wc = t.view.webContents;
    t.certError = undefined; t.error = undefined;
    if (wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack(); else void wc.loadURL('about:blank');
    pushState();
    return true;
  });

  // ── Tabs like a real browser: session restore, order, pin, reopen, full screen (browser-session.ts) ──
  tabSession = registerTabSession(ctx, {
    tabs, active: () => activeId, setActive: (id) => { activeId = id; },
    create: (url) => create(url), close: (id) => service.closeTab(id), layout, pushState,
    home: () => ctx.prefs.get().browserHome,
  });
  autofillService = registerAutofill(ctx, () => {
    const t = activeId ? tabs.get(activeId) : undefined;
    return t && !t.view.webContents.isDestroyed() && !t.dialog ? t.view.webContents : null;
  });
  // The import centre (browser-import.ts): other browsers' bookmarks, history and addresses; passwords from a CSV.
  ctx.services.browserImport = registerImport(ctx, {
    history: { get: () => history.get(), set: (list) => history.set(list), flush: () => history.flush() },
    bookmarks,
    addresses: () => autofillService,
    vault,
  });
}
