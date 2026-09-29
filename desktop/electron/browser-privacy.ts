/**
 * AICO Shields and Protected Browsing, wired into the browser's session and
 * tabs: the privacy headers and third-party-cookie rule (through the shared
 * header dispatcher, web-request.ts), HTTPS-first with its fallback page,
 * deceptive-site detection before and after a page loads, notification
 * prompts refused unless allowed, browsing insights, the public malware host
 * list, and clear-on-exit. The rules themselves are pure and tested:
 * browser-shield.ts, browser-protect.ts, browser-insights.ts.
 *
 * browser.ts calls in at a few points (a main-frame request, a new tab, its
 * tab state, the agent's action gate) and otherwise this module keeps its own
 * per-tab state and its own settings file (shield.json), so the two can change
 * independently.
 *
 * PRIVACY. Everything is decided and stored on this device. The only request
 * this module makes is fetching the URLhaus host list (at most daily, no
 * cookies, nothing about the user in it); the user's URLs never leave.
 *
 * AGENT SAFETY. A flagged page is look-only for the agent: `agentRefusal`
 * makes every click / type / fill / press / select / upload / evaluate on it
 * refuse, whether the user continued past the warning or not. When the user
 * allows it (`autoCheck`), the interface asks the copilot to explain the
 * warning — a read-only request, enforced here rather than trusted to the
 * prompt.
 *
 * @module desktop/electron/browser-privacy
 */

import { app, powerMonitor, type Session, type WebContents } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import type { DesktopContext } from './context';
import type {
  HttpsFallback, InsightsSummary, ShieldSet, ShieldSettingsView, ShieldSite, ShieldTracker, TabState, ThreatEvent, ThreatInfo,
} from '../shared/browser-types';
import { JsonFile } from './browser-store';
import { originOf, trackerOwner } from './browser-trackers';
import {
  blocksCookies, hostOfUrl, httpsUpgrade, isPrivateHost, normaliseShield, setSiteShield, siteOf, stripCookie, stripSetCookie,
  withPrivacySignals, type ShieldSettings,
} from './browser-shield';
import { analysisPrompt, assessPage, assessUrl, onList, parseHostList, type PageSignals, type ThreatVerdict } from './browser-protect';
import {
  clearInsights, emptyInsights, normaliseInsights, pruneInsights, recordActive, recordCount, recordPage, recordTracker, summarizeInsights,
  type InsightsData,
} from './browser-insights';
import { onRequestHeaders, onResponseHeaders } from './web-request';

export interface PrivacyHooks {
  /** The tab a request / event belongs to: its id and top-level URL. */
  tabOf(webContentsId: number | undefined): { id: string; url: string } | null;
  /** The tab on screen right now (null when the browser is hidden or covered). */
  frontTab(): { id: string; url: string } | null;
  activeTabId(): string | null;
  /** When the person last clicked or typed in a tab (0 when never). */
  lastInput(tabId: string): number;
  /** What browser.ts counts itself, for the shields panel. */
  counts(tabId: string): { trackersBlocked: number; popupsBlocked: number };
  /** Tracker blocking (browser.ts owns it): on globally, the origins allowed, and whether it applies to a URL. */
  trackers(): { enabled: boolean; allowOrigins: string[] };
  pushState(): void;
  clearHistory(): void;
}

export interface Privacy {
  attach(ses: Session): void;
  attachTab(tabId: string, wc: WebContents): void;
  /** A main-frame request: upgrade it, block it, or let it through (null). */
  onMainFrame(tabId: string, url: string): { redirectURL: string } | { cancel: true } | null;
  /** browser.ts blocked a tracker on this tab. */
  noteTracker(tabId: string, trackerHost: string, pageUrl: string): void;
  tabExtras(tabId: string): Pick<TabState, 'cookiesBlocked' | 'httpsUpgraded' | 'httpsFallback' | 'threat'>;
  /** Why the agent must not act on this tab, or null. */
  agentRefusal(tabId: string): string | null;
  /** Why a navigation of this tab was stopped (deceptive, or https unavailable), for the agent's open result. */
  blockedNote(tabId: string): string | null;
  /** Refuse a notification prompt without asking (the default). */
  quietNotifications(tabId: string): boolean;
  flagged(tabId: string | undefined): boolean;
  noteDownload(): void;
  clearInsights(sinceMs?: number): void;
  flush(): void;
}

const LIST_URL = 'https://urlhaus.abuse.ch/downloads/hostfile/';
const LIST_SOURCE = 'URLhaus (abuse.ch) malware host list';
const LIST_MAX_AGE = 24 * 3600_000;
/** An isolated world for the page check: the page's own scripts cannot tamper with what it reads. */
const SCAN_WORLD = 1071;

/** What the page check reads — no values, only the shape of the forms and a little text. */
const PAGE_SCAN = `(() => {
  const inputs = Array.from(document.querySelectorAll('input'));
  const pw = inputs.filter(i => i.type === 'password');
  const card = inputs.filter(i => /cc-number|cc-csc/.test(i.autocomplete || '') || /card.?num|cardnumber|\\bcvv\\b|\\bcvc\\b|security.?code/i.test([i.name, i.id, i.placeholder, i.getAttribute('aria-label')].join(' ')));
  const forms = Array.from(document.forms).slice(0, 30).map(f => ({ action: f.getAttribute('action') ? f.action : '', method: f.method || 'get', hasPassword: !!f.querySelector('input[type=password]') }));
  return { passwordFields: pw.length, cardFields: card.length, forms, title: String(document.title || '').slice(0, 300), text: String((document.body && document.body.innerText) || '').slice(0, 3000) };
})()`;

const GPC_PRELOAD_ID = 'aico-gpc';
const GPC_PRELOAD_JS = `(() => {
  const { contextBridge } = require('electron');
  try {
    contextBridge.executeInMainWorld({ func: () => {
      const def = (name, value) => { try { Object.defineProperty(Navigator.prototype, name, { get: () => value, configurable: true, enumerable: true }); } catch (e) { /* frozen */ } };
      def('globalPrivacyControl', true);
      def('doNotTrack', '1');
    } });
  } catch (e) { /* the headers still say it */ }
})();
`;

interface TabShield {
  id: string;
  wc: WebContents;
  cookies: number;
  notifications: number;
  hosts: Map<string, number>;
  upgrade?: { host: string; httpUrl: string; httpsUrl: string; at: number; timer?: NodeJS.Timeout };
  upgraded: boolean;
  fallback?: HttpsFallback;
  threat?: ThreatInfo;
  /** The host the user chose to continue to past a warning (this tab only). */
  proceedHost?: string;
  lastSite: string;
  scans: NodeJS.Timeout[];
  /** When each host was last upgraded in this tab: a page that keeps sending itself back to http is not looped forever. */
  upgrades: Map<string, number[]>;
}

export function createPrivacy(ctx: DesktopContext, hooks: PrivacyHooks): Privacy {
  const dataDir = path.join(ctx.paths.desktopDir, 'browser');
  const settings = new JsonFile<ShieldSettings>(path.join(dataDir, 'shield.json'), normaliseShield({}), normaliseShield);
  const insights = new JsonFile<InsightsData>(path.join(dataDir, 'insights.json'), emptyInsights(), raw => pruneInsights(normaliseInsights(raw), Date.now()), 5000);
  const tabs = new Map<string, TabShield>();
  let session: Session | null = null;
  const s = (): ShieldSettings => settings.get();

  // ── The public host list ──
  const listFile = path.join(dataDir, 'threat-hosts.txt');
  const listMeta = new JsonFile<{ updatedAt: number; hosts: number; error?: string }>(path.join(dataDir, 'threat-list.json'), { updatedAt: 0, hosts: 0 });
  let badHosts = new Set<string>();
  let fetching = false;
  const loadList = (): void => {
    if (!s().protection.list) { badHosts = new Set(); return; }
    fs.promises.readFile(listFile, 'utf8').then((t) => { badHosts = parseHostList(t); }).catch(() => { /* not fetched yet */ });
  };
  const refreshList = async (force = false): Promise<void> => {
    if (!s().protection.list || fetching) return;
    if (!force && Date.now() - listMeta.get().updatedAt < LIST_MAX_AGE) return;
    fetching = true;
    try {
      // Node's fetch, not the browser session: no cookies, no referrer, nothing but the list.
      const res = await fetch(LIST_URL, { signal: AbortSignal.timeout(30_000), redirect: 'follow' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      if (text.length > 20_000_000 || !/URLhaus/i.test(text.slice(0, 2000))) throw new Error('unexpected list format');
      const hosts = parseHostList(text);
      await fs.promises.mkdir(dataDir, { recursive: true });
      await fs.promises.writeFile(listFile, [...hosts].join('\n'));
      badHosts = hosts;
      listMeta.set({ updatedAt: Date.now(), hosts: hosts.size });
    } catch (err) {
      listMeta.set({ ...listMeta.get(), error: (err as Error).message, updatedAt: listMeta.get().updatedAt });
    } finally { fetching = false; listMeta.flush(); }
  };
  loadList();
  setTimeout(() => { void refreshList(); }, 20_000).unref?.();
  setInterval(() => { void refreshList(); }, 3600_000).unref?.();
  const isBadHost = (h: string): boolean => s().protection.list && badHosts.size > 0 && onList(badHosts, h);

  // ── Per tab ──
  const tabOf = (id: string | undefined): TabShield | undefined => (id ? tabs.get(id) : undefined);
  let pushTimer: NodeJS.Timeout | null = null;
  const push = (): void => {
    if (pushTimer) return;
    pushTimer = setTimeout(() => { pushTimer = null; hooks.pushState(); }, 250);
  };
  const trusted = (url: string): boolean => Boolean(s().sites[siteOf(url)]?.trusted);

  const setFallback = (t: TabShield, reason: string): void => {
    if (!t.upgrade) return;
    clearTimeout(t.upgrade.timer);
    t.fallback = { httpUrl: t.upgrade.httpUrl, httpsUrl: t.upgrade.httpsUrl, reason };
    hooks.pushState();
  };

  const setThreat = (t: TabShield, v: ThreatVerdict, url: string, stage: ThreatInfo['stage']): void => {
    if (!v.level) return;
    const host = hostOfUrl(url) || url.slice(0, 40);
    const proceeded = t.proceedHost !== undefined && t.proceedHost === host;
    const threat: ThreatInfo = { level: v.level, url, host, score: v.score, reasons: v.reasons, stage, ...(v.brand ? { brand: v.brand } : {}), ...(proceeded ? { proceeded } : {}) };
    const fresh = !t.threat || t.threat.url !== url || (t.threat.level === 'warn' && threat.level === 'block');
    if (t.threat && !fresh && t.threat.score >= threat.score) return;
    t.threat = threat;
    if (threat.level === 'block' && !proceeded && stage === 'page' && !t.wc.isDestroyed()) {
      // Hidden behind the warning page: stop it loading more, and silence it.
      t.wc.stop();
      t.wc.setAudioMuted(true);
    }
    if (fresh && !proceeded) {
      if (s().insights) { recordCount(insights.get(), Date.now(), 'warned'); insights.set(insights.get()); }
      const ev: ThreatEvent = {
        tabId: t.id, threat, autoCheck: s().protection.autoCheck,
        prompt: analysisPrompt({ url, level: threat.level, reasons: threat.reasons, loaded: stage === 'page' }),
      };
      ctx.emit('browser:threat', ev);
    }
    hooks.pushState();
  };

  const scan = async (t: TabShield): Promise<void> => {
    if (t.wc.isDestroyed() || !s().protection.heuristics) return;
    const url = t.wc.getURL();
    if (!/^(https?|data):/i.test(url) || trusted(url)) return;
    if (/^https?:/i.test(url) && isPrivateHost(hostOfUrl(url))) return;
    const sig = await Promise.race([
      t.wc.executeJavaScriptInIsolatedWorld(SCAN_WORLD, [{ code: PAGE_SCAN }]) as Promise<PageSignals>,
      new Promise<null>(r => setTimeout(() => r(null), 3000)),
    ]).catch(() => null);
    if (!sig || t.wc.isDestroyed() || t.wc.getURL() !== url) return;
    const v = assessPage(url, sig, { isBadHost });
    if (v.level) setThreat(t, v, url, 'page');
  };
  const scheduleScan = (t: TabShield): void => {
    for (const x of t.scans) clearTimeout(x);
    // Once settled, and again a little later: sign-in forms are often drawn after load.
    t.scans = [setTimeout(() => void scan(t), 400), setTimeout(() => void scan(t), 2500)];
  };

  const attachTab = (id: string, wc: WebContents): void => {
    const t: TabShield = { id, wc, cookies: 0, notifications: 0, hosts: new Map(), upgraded: false, lastSite: '', scans: [], upgrades: new Map() };
    tabs.set(id, t);
    // A navigation that starts may never replace the page (a download, a 204, one that is cancelled), so
    // the page's own state (its warning, its counts, "continued anyway") is reset when a new page commits.
    wc.on('did-start-navigation', (d) => {
      if (!d.isMainFrame || d.isSameDocument) return;
      clearTimeout(t.upgrade?.timer);
      t.upgrade = undefined; t.upgraded = false;
      // Inline documents never reach webRequest: judge them here.
      if (/^(data|javascript):/i.test(d.url) && s().protection.heuristics) {
        const v = assessUrl(d.url);
        if (v.level) setThreat(t, v, d.url.slice(0, 300), 'url');
      }
    });
    wc.on('did-navigate', (_e, url) => {
      const host = hostOfUrl(url);
      t.cookies = 0; t.notifications = 0; t.hosts.clear();
      if (t.fallback && url !== t.fallback.httpUrl && url !== t.fallback.httpsUrl) t.fallback = undefined;
      const samePage = t.threat && (t.threat.url === url || (/^data:/i.test(url) && url.startsWith(t.threat.url)));
      if (t.threat && !samePage) { t.threat = undefined; if (!wc.isDestroyed()) wc.setAudioMuted(false); }
      if (t.proceedHost && t.proceedHost !== host) t.proceedHost = undefined;
      if (t.upgrade && /^https:/i.test(url) && host === t.upgrade.host) {
        clearTimeout(t.upgrade.timer);
        t.upgraded = true;
        if (s().insights) recordCount(insights.get(), Date.now(), 'upgrades');
      }
      const site = siteOf(url);
      if (site && s().insights) { recordPage(insights.get(), Date.now(), site, site !== t.lastSite); insights.set(insights.get()); }
      if (site) t.lastSite = site;
      push();
    });
    wc.on('did-navigate-in-page', (_e, url, isMainFrame) => {
      if (!isMainFrame) return;
      const site = siteOf(url);
      if (site && s().insights) { recordPage(insights.get(), Date.now(), site, false); insights.set(insights.get()); }
      scheduleScan(t);
    });
    wc.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
      if (!isMainFrame || code === -3) return;
      if (t.threat?.level === 'block' && !t.threat.proceeded) return;
      if (t.upgrade && !t.upgraded && /^https:/i.test(url) && hostOfUrl(url) === t.upgrade.host) {
        setFallback(t, code <= -200 && code > -300 ? `The site’s secure certificate is not valid (${desc}).` : `The secure version of the site did not answer (${desc}).`);
      }
    });
    wc.on('did-stop-loading', () => scheduleScan(t));
    wc.on('destroyed', () => { for (const x of t.scans) clearTimeout(x); clearTimeout(t.upgrade?.timer); tabs.delete(id); });
  };

  const onMainFrame = (tabId: string, url: string): { redirectURL: string } | { cancel: true } | null => {
    const t = tabOf(tabId);
    if (!t) return null;
    const host = hostOfUrl(url);
    const conf = s();
    if (/^http:/i.test(url)) {
      // The https version sent us straight back to http: it does not really support https.
      if (t.upgrade && t.upgrade.host === host && !t.upgraded && Date.now() - t.upgrade.at < 20_000) {
        setFallback(t, 'The secure version of the site redirected back to the insecure one.');
        return { cancel: true };
      }
      const up = httpsUpgrade(url, conf);
      if (up) {
        clearTimeout(t.upgrade?.timer);
        const now = Date.now();
        const recent = (t.upgrades.get(host) ?? []).filter(x => now - x < 15_000);
        t.upgrades.set(host, [...recent, now]);
        const upgrade: NonNullable<TabShield['upgrade']> = { host, httpUrl: url, httpsUrl: up, at: now };
        t.upgrade = upgrade;
        if (recent.length >= 2) {
          setFallback(t, 'The secure version of the site keeps sending the browser back to the insecure one.');
          return { cancel: true };
        }
        // A server that silently drops https connections would hang the tab: give up after 10 s.
        upgrade.timer = setTimeout(() => {
          if (t.upgrade === upgrade && !t.upgraded && !t.wc.isDestroyed()) { t.wc.stop(); setFallback(t, 'The secure version of the site took too long to answer.'); }
        }, 10_000);
        t.upgrade = upgrade;
        return { redirectURL: up };
      }
    }
    if (!conf.protection.heuristics && !conf.protection.list) return null;
    if (trusted(url)) return null;
    const v = assessUrl(url, { isBadHost });
    if (!v.level || (!conf.protection.heuristics && !v.reasons.some(r => r.id === 'known-bad'))) return null;
    setThreat(t, v, url, 'url');
    return v.level === 'block' && t.proceedHost !== host ? { cancel: true } : null;
  };

  // ── Headers: Global Privacy Control, Do Not Track, third-party cookies ──
  const noteCookie = (tabId: string): void => {
    const t = tabOf(tabId);
    if (!t) return;
    t.cookies++;
    if (s().insights) { recordCount(insights.get(), Date.now(), 'cookies'); insights.set(insights.get()); }
    push();
  };

  const syncGpcPreload = (): void => {
    if (!session) return;
    try {
      const has = session.getPreloadScripts().some(p => p.id === GPC_PRELOAD_ID);
      if (s().gpc && !has) {
        const file = path.join(dataDir, 'privacy-preload.js');
        fs.mkdirSync(dataDir, { recursive: true });
        if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== GPC_PRELOAD_JS) fs.writeFileSync(file, GPC_PRELOAD_JS);
        session.registerPreloadScript({ type: 'frame', id: GPC_PRELOAD_ID, filePath: file });
      } else if (!s().gpc && has) {
        session.unregisterPreloadScript(GPC_PRELOAD_ID);
      }
    } catch (err) { console.error('Privacy preload not installed:', err); }
  };

  const attach = (ses: Session): void => {
    session = ses;
    syncGpcPreload();
    onRequestHeaders(ses, undefined, (d, headers) => {
      const conf = s();
      let out = withPrivacySignals(headers, conf.gpc);
      const tab = hooks.tabOf(d.webContentsId);
      if (tab && blocksCookies(d.url, tab.url, d.resourceType, conf)) {
        const r = stripCookie(out);
        if (r.removed) { out = r.headers; noteCookie(tab.id); }
      }
      return out === headers ? undefined : out;
    });
    onResponseHeaders(ses, undefined, (d, headers) => {
      const tab = hooks.tabOf(d.webContentsId);
      if (!tab || !blocksCookies(d.url, tab.url, d.resourceType, s())) return undefined;
      const r = stripSetCookie(headers);
      if (!r.removed) return undefined;
      noteCookie(tab.id);
      return r.headers as Record<string, string[]>;
    });
  };

  // ── Insights: time on a site, counted only while it is in front and in use ──
  const TICK = 5000;
  setInterval(() => {
    if (!s().insights) return;
    const win = ctx.browserWindow();
    if (!win || win.isDestroyed() || !win.isVisible() || win.isMinimized() || !win.isFocused()) return;
    const front = hooks.frontTab();
    // In use: input anywhere on the computer, or in the page, within the last 90 seconds.
    let idle = 0;
    try { idle = powerMonitor.getSystemIdleTime(); } catch { /* no idle signal: count it */ }
    if (idle > 90 && !(front && Date.now() - hooks.lastInput(front.id) < 90_000)) return;
    const site = front ? siteOf(front.url) : '';
    if (!site) return;
    recordActive(insights.get(), Date.now(), site, TICK);
    insights.set(insights.get());
  }, TICK).unref?.();
  setInterval(() => { insights.set(pruneInsights(insights.get(), Date.now())); }, 6 * 3600_000).unref?.();

  // ── Clear on exit ──
  let cleared = false;
  let clearing = false;
  app.on('before-quit', (e) => {
    const c = s().clearOnExit;
    if (cleared || !(c.cookies || c.cache || c.history || c.insights)) { insights.flush(); settings.flush(); return; }
    e.preventDefault();
    if (clearing) return;
    clearing = true;
    const work = (async () => {
      if (c.history) hooks.clearHistory();
      if (c.insights) insights.set(emptyInsights());
      if (session && c.cookies) await session.clearStorageData();
      if (session && c.cache) await session.clearCache();
    })();
    void Promise.race([work, new Promise(r => setTimeout(r, 4000))]).catch(() => {}).finally(() => {
      insights.flush(); settings.flush();
      cleared = true;
      app.quit();
    });
  });

  // ── The interface ──
  const view = (): ShieldSettingsView => {
    const conf = s();
    const tr = hooks.trackers();
    const ex = new Map<string, ShieldSettingsView['exceptions'][number]>();
    const row = (site: string): ShieldSettingsView['exceptions'][number] => { const r = ex.get(site) ?? { site }; ex.set(site, r); return r; };
    for (const [site, v] of Object.entries(conf.sites)) {
      const r = row(site);
      if (v.cookies3p === false) r.cookies3p = true;
      if (v.httpsFirst === false) r.httpsFirst = true;
      if (v.trusted) r.trusted = true;
    }
    for (const h of conf.httpsExceptions) row(h).http = true;
    for (const o of tr.allowOrigins) row(o).trackers = true;
    const meta = listMeta.get();
    return {
      trackers: tr.enabled, cookies3p: conf.cookies3p, httpsFirst: conf.httpsFirst, gpc: conf.gpc,
      protection: { ...conf.protection }, notificationsAsk: conf.notificationsAsk, insights: conf.insights, clearOnExit: { ...conf.clearOnExit },
      exceptions: [...ex.values()].sort((a, b) => a.site.localeCompare(b.site)),
      list: { hosts: conf.protection.list ? badHosts.size : 0, updatedAt: meta.updatedAt, source: LIST_SOURCE, ...(meta.error ? { error: meta.error } : {}) },
    };
  };

  ctx.handle('browser:shield:settings', () => view());
  ctx.handle('browser:shield:set', (o: ShieldSet) => {
    let next = s();
    if (o?.site) {
      const site = siteOf(o.site) || String(o.site).toLowerCase();
      if (o.reset) {
        next = { ...next, sites: Object.fromEntries(Object.entries(next.sites).filter(([k]) => k !== site)), httpsExceptions: next.httpsExceptions.filter(h => h !== o.site && siteOf(`https://${h}/`) !== site) };
      } else {
        next = setSiteShield(next, site, { cookies3p: o.cookies3p, httpsFirst: o.httpsFirst, trusted: o.trusted });
        if (o.httpsFirst === true) next = { ...next, httpsExceptions: next.httpsExceptions.filter(h => siteOf(`https://${h}/`) !== site) };
      }
    }
    if (o?.global) {
      const g = o.global;
      next = normaliseShield({
        ...next, ...g,
        protection: { ...next.protection, ...(g.protection ?? {}) },
        clearOnExit: { ...next.clearOnExit, ...(g.clearOnExit ?? {}) },
      });
    }
    const listWas = s().protection.list;
    settings.set(next);
    settings.flush();
    syncGpcPreload();
    if (next.protection.list && !listWas) { loadList(); void refreshList(true); }
    if (!next.protection.list) badHosts = new Set();
    if (o?.trusted === true) for (const t of tabs.values()) if (t.threat && siteOf(t.threat.url) === siteOf(o.site ?? '')) { t.threat = undefined; t.wc.setAudioMuted(false); }
    hooks.pushState();
    return view();
  });

  ctx.handle('browser:shield:site', (): ShieldSite | null => {
    const id = hooks.activeTabId();
    const t = tabOf(id ?? undefined);
    if (!t || t.wc.isDestroyed()) return null;
    const url = t.threat?.stage === 'url' && !t.threat.proceeded ? t.threat.url : t.wc.getURL();
    const conf = s();
    const site = siteOf(url);
    const tr = hooks.trackers();
    const origin = originOf(url);
    const trackers: ShieldTracker[] = [...t.hosts.entries()].map(([host, count]) => ({ host, count, ...trackerOwner(host) })).sort((a, b) => b.count - a.count);
    const byCo = new Map<string, { company: string; count: number; category: ShieldTracker['category'] }>();
    for (const x of trackers) { const c = byCo.get(x.company) ?? { company: x.company, count: 0, category: x.category }; c.count += x.count; byCo.set(x.company, c); }
    const c = hooks.counts(t.id);
    return {
      url, origin, site,
      trackersOn: tr.enabled && !tr.allowOrigins.includes(origin),
      cookiesOn: conf.cookies3p && conf.sites[site]?.cookies3p !== false,
      httpsOn: conf.httpsFirst && conf.sites[site]?.httpsFirst !== false && !conf.httpsExceptions.includes(hostOfUrl(url)),
      trackersBlocked: c.trackersBlocked, trackers,
      companies: [...byCo.values()].sort((a, b) => b.count - a.count),
      fingerprinting: trackers.filter(x => x.category === 'fingerprinting').reduce((n, x) => n + x.count, 0),
      cookiesBlocked: t.cookies, httpsUpgraded: t.upgraded, popupsBlocked: c.popupsBlocked, notificationsBlocked: t.notifications,
      gpc: conf.gpc, ...(t.threat ? { threat: t.threat } : {}), trusted: Boolean(conf.sites[site]?.trusted),
    };
  });

  const leave = (t: TabShield): void => {
    t.threat = undefined; t.fallback = undefined;
    const wc = t.wc;
    if (wc.isDestroyed()) return;
    wc.setAudioMuted(false);
    if (wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack(); else void wc.loadURL('about:blank').catch(() => {});
    hooks.pushState();
  };

  ctx.handle('browser:shield:proceed', (tabId: string) => {
    const t = tabOf(tabId);
    if (!t?.threat) return false;
    const threat = t.threat;
    t.proceedHost = threat.host;
    t.threat = { ...threat, proceeded: true };
    t.wc.setAudioMuted(false);
    if (threat.stage === 'url' && /^https?:/i.test(threat.url)) void t.wc.loadURL(threat.url).catch(() => {});
    else if (threat.stage === 'page') t.wc.reload();
    hooks.pushState();
    return true;
  });
  ctx.handle('browser:shield:safety', (tabId: string) => {
    const t = tabOf(tabId);
    if (!t) return false;
    leave(t);
    return true;
  });
  ctx.handle('browser:shield:trust', (tabId: string) => {
    const t = tabOf(tabId);
    if (!t?.threat) return false;
    const { url, stage } = t.threat;
    settings.set(setSiteShield(s(), siteOf(url) || hostOfUrl(url), { trusted: true }));
    t.threat = undefined;
    t.wc.setAudioMuted(false);
    if (stage === 'url' && /^https?:/i.test(url)) void t.wc.loadURL(url).catch(() => {});
    hooks.pushState();
    return true;
  });
  ctx.handle('browser:shield:http', (tabId: string) => {
    const t = tabOf(tabId);
    if (!t?.fallback) return false;
    const { httpUrl } = t.fallback;
    const host = hostOfUrl(httpUrl);
    const conf = s();
    if (host && !conf.httpsExceptions.includes(host)) settings.set({ ...conf, httpsExceptions: [...conf.httpsExceptions, host] });
    t.fallback = undefined;
    void t.wc.loadURL(httpUrl).catch(() => {});
    hooks.pushState();
    return true;
  });

  ctx.handle('browser:insights:summary', (days?: number): InsightsSummary => ({
    ...summarizeInsights(insights.get(), Date.now(), days === 30 ? 30 : 7),
    enabled: s().insights,
  }));
  ctx.handle('browser:insights:clear', () => { insights.set(emptyInsights()); insights.flush(); return true; });

  return {
    attach,
    attachTab,
    onMainFrame,
    noteTracker(tabId, trackerHost, pageUrl) {
      const t = tabOf(tabId);
      if (t && t.hosts.size < 500) t.hosts.set(trackerHost, (t.hosts.get(trackerHost) ?? 0) + 1);
      if (s().insights) { recordTracker(insights.get(), Date.now(), siteOf(pageUrl), trackerOwner(trackerHost).company); insights.set(insights.get()); }
    },
    tabExtras(tabId) {
      const t = tabOf(tabId);
      if (!t) return {};
      return {
        ...(t.cookies ? { cookiesBlocked: t.cookies } : {}), ...(t.upgraded ? { httpsUpgraded: true } : {}),
        ...(t.fallback ? { httpsFallback: t.fallback } : {}), ...(t.threat ? { threat: t.threat } : {}),
      };
    },
    agentRefusal(tabId) {
      const th = tabOf(tabId)?.threat;
      if (!th) return null;
      const why = th.reasons[0]?.label ?? 'it looks deceptive';
      return `Refused: AICO Protected Browsing flagged this page (${th.host}) as ${th.level === 'block' ? 'likely deceptive' : 'possibly deceptive'} — ${why}. `
        + 'The agent never clicks, types, fills, submits or uploads on a flagged page, even after the user continued past the warning. '
        + 'Explain the warning to the user in plain words and let them decide; reading the page (browser_read, browser_snapshot, browser_insights) is allowed.';
    },
    blockedNote(tabId) {
      const t = tabOf(tabId);
      if (t?.threat) return `Not opened — ${(this.agentRefusal(tabId) ?? '').replace(/^Refused: /, '')}`;
      if (t?.fallback) return `Not opened: ${hostOfUrl(t.fallback.httpUrl)} does not support a secure (https) connection — ${t.fallback.reason} The user has been shown a page to continue over http or go back; tell them, and do not try to open it over http yourself.`;
      return null;
    },
    quietNotifications(tabId) {
      if (s().notificationsAsk) return false;
      const t = tabOf(tabId);
      if (t) { t.notifications++; push(); }
      return true;
    },
    flagged: (tabId) => Boolean(tabOf(tabId)?.threat),
    noteDownload() { if (s().insights) { recordCount(insights.get(), Date.now(), 'downloads'); insights.set(insights.get()); } },
    clearInsights(sinceMs) { insights.set(clearInsights(insights.get(), sinceMs)); insights.flush(); },
    flush() { insights.flush(); settings.flush(); listMeta.flush(); },
  };
}
