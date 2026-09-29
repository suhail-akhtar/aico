/**
 * AICO Shields — the pure rules behind the browser's privacy protections, so
 * every one of them is unit-tested without Electron:
 *
 *   - HTTPS-first: which http:// navigations are upgraded (never localhost,
 *     private addresses, intranet names or an explicit port — https there
 *     almost never exists, and a failed guess would break local work).
 *   - Third-party cookies: stripped from requests (`Cookie`) and responses
 *     (`Set-Cookie`) whose site differs from the tab's top-level site. Done in
 *     webRequest because Electron 44 has no per-session switch for it, which
 *     also means per-site exceptions (sign-in flows that need an embedded
 *     identity provider) are ours to keep.
 *   - Global Privacy Control / Do Not Track request headers.
 *   - Downloads: which file types can run code, how risky a download is, and
 *     the Mark-of-the-Web (Zone.Identifier) that makes Windows SmartScreen and
 *     Office Protected View treat a downloaded file as from the internet.
 *   - The settings file (`<AICO_HOME>/desktop/browser/shield.json`).
 *
 * Nothing here — or anywhere in the shields — sends anything anywhere: the
 * only network request the protections make is downloading a public host
 * list (browser-privacy.ts), and never with the user's URLs.
 *
 * @module desktop/electron/browser-shield
 */

import { registrableDomain } from './browser-trackers';

// ── Hosts ──

/** Hostname without brackets / trailing dot, lower-case. */
export function cleanHost(host: string): string {
  return host.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
}

export function isIpv4(host: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) && host.split('.').every(n => Number(n) <= 255);
}

export function isIpLiteral(host: string): boolean {
  const h = cleanHost(host);
  return isIpv4(h) || h.includes(':');
}

/**
 * A host that is this machine or the local network: localhost, loopback,
 * RFC 1918 / link-local / CGNAT addresses, unique-local IPv6, single-label
 * intranet names and the reserved local suffixes. None of these are upgraded
 * to https or judged by the deceptive-site heuristics.
 */
export function isPrivateHost(host: string): boolean {
  const h = cleanHost(host);
  if (!h) return true;
  if (h === 'localhost' || /\.(localhost|local|lan|internal|intranet|home|corp|test|example|invalid|home\.arpa)$/.test(h)) return true;
  if (isIpv4(h)) {
    const [a, b] = h.split('.').map(Number) as [number, number];
    return a === 10 || a === 127 || a === 0 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
  }
  if (h.includes(':')) return h === '::1' || h === '::' || /^f[cd][0-9a-f]{2}:/.test(h) || /^fe[89ab][0-9a-f]:/.test(h) || h.startsWith('::ffff:127.') || h.startsWith('::ffff:10.') || h.startsWith('::ffff:192.168.');
  return !h.includes('.');
}

/** The site a URL belongs to (its registrable domain), '' for non-web URLs. */
export function siteOf(url: string): string {
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:' && u.protocol !== 'ws:' && u.protocol !== 'wss:') return '';
    return registrableDomain(cleanHost(u.hostname));
  } catch { return ''; }
}

export function hostOfUrl(url: string): string {
  try { return cleanHost(new URL(url).hostname); } catch { return ''; }
}

/** Is `requestUrl` from another site than the top-level page `topUrl`? Unknown top → not third-party. */
export function isThirdParty(requestUrl: string, topUrl: string): boolean {
  const top = siteOf(topUrl);
  const req = siteOf(requestUrl);
  return Boolean(top && req && top !== req);
}

// ── Settings ──

export interface SiteShield {
  /** false: third-party cookies are allowed while this site is the top-level page (a sign-in needs them). */
  cookies3p?: boolean;
  /** false: never upgrade this site to https. */
  httpsFirst?: boolean;
  /** true: the user says this site is not deceptive — protected browsing stops flagging it. */
  trusted?: boolean;
}

export interface ShieldSettings {
  /** Block third-party cookies everywhere (sites can be excepted). */
  cookies3p: boolean;
  /** Upgrade http:// navigations to https://. */
  httpsFirst: boolean;
  /** Send Sec-GPC: 1 and DNT: 1, and expose navigator.globalPrivacyControl. */
  gpc: boolean;
  protection: {
    /** Judge pages with the local deceptive-site heuristics. */
    heuristics: boolean;
    /** Use the public malware host list (downloaded at most daily). */
    list: boolean;
    /** Open the copilot with an analysis when a page is flagged. */
    autoCheck: boolean;
  };
  /** Let sites ask to show notifications (off: such requests are refused silently). */
  notificationsAsk: boolean;
  /** Keep browsing insights on this device. */
  insights: boolean;
  clearOnExit: { cookies: boolean; cache: boolean; history: boolean; insights: boolean };
  /** Per-site shield exceptions, keyed by site (registrable domain). */
  sites: Record<string, SiteShield>;
  /** Hosts the user chose to open over http after an upgrade failed. */
  httpsExceptions: string[];
}

export const DEFAULT_SHIELD: ShieldSettings = {
  cookies3p: true, httpsFirst: true, gpc: true,
  protection: { heuristics: true, list: true, autoCheck: true },
  notificationsAsk: false, insights: true,
  clearOnExit: { cookies: false, cache: false, history: false, insights: false },
  sites: {}, httpsExceptions: [],
};

const bool = (v: unknown, d: boolean): boolean => (typeof v === 'boolean' ? v : d);

export function normaliseShield(raw: unknown): ShieldSettings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<ShieldSettings>;
  const p = (r.protection && typeof r.protection === 'object' ? r.protection : {}) as Partial<ShieldSettings['protection']>;
  const c = (r.clearOnExit && typeof r.clearOnExit === 'object' ? r.clearOnExit : {}) as Partial<ShieldSettings['clearOnExit']>;
  const d = DEFAULT_SHIELD;
  const sites: Record<string, SiteShield> = {};
  for (const [site, v] of Object.entries(r.sites && typeof r.sites === 'object' ? r.sites : {})) {
    if (!site || !v || typeof v !== 'object') continue;
    const s: SiteShield = {};
    if ((v as SiteShield).cookies3p === false) s.cookies3p = false;
    if ((v as SiteShield).httpsFirst === false) s.httpsFirst = false;
    if ((v as SiteShield).trusted === true) s.trusted = true;
    if (Object.keys(s).length) sites[site.toLowerCase()] = s;
  }
  return {
    cookies3p: bool(r.cookies3p, d.cookies3p), httpsFirst: bool(r.httpsFirst, d.httpsFirst), gpc: bool(r.gpc, d.gpc),
    protection: { heuristics: bool(p.heuristics, true), list: bool(p.list, true), autoCheck: bool(p.autoCheck, true) },
    notificationsAsk: bool(r.notificationsAsk, false), insights: bool(r.insights, true),
    clearOnExit: { cookies: bool(c.cookies, false), cache: bool(c.cache, false), history: bool(c.history, false), insights: bool(c.insights, false) },
    sites,
    httpsExceptions: Array.isArray(r.httpsExceptions) ? [...new Set(r.httpsExceptions.filter((h): h is string => typeof h === 'string' && h.length > 0).map(h => h.toLowerCase()))].slice(0, 2000) : [],
  };
}

/** Set (or clear back to the default) one per-site exception. */
export function setSiteShield(s: ShieldSettings, site: string, patch: SiteShield): ShieldSettings {
  const key = site.toLowerCase();
  const cur: SiteShield = { ...(s.sites[key] ?? {}) };
  for (const k of ['cookies3p', 'httpsFirst'] as const) {
    if (patch[k] === undefined) continue;
    if (patch[k] === false) cur[k] = false; else delete cur[k];
  }
  if (patch.trusted !== undefined) { if (patch.trusted) cur.trusted = true; else delete cur.trusted; }
  const sites = { ...s.sites };
  if (Object.keys(cur).length) sites[key] = cur; else delete sites[key];
  return { ...s, sites };
}

// ── HTTPS-first ──

/**
 * The https:// URL to try instead of this http:// one, or null when it must be
 * left alone: not http, a private or intranet host, an explicit port, an IP
 * literal, HTTPS-first off (globally or for the site), or a host the user chose
 * to open over http.
 */
export function httpsUpgrade(url: string, s: Pick<ShieldSettings, 'httpsFirst' | 'sites' | 'httpsExceptions'>): string | null {
  if (!s.httpsFirst) return null;
  let u: URL;
  try { u = new URL(url); } catch { return null; }
  if (u.protocol !== 'http:') return null;
  const host = cleanHost(u.hostname);
  if (u.port || isPrivateHost(host) || isIpLiteral(host)) return null;
  if (s.httpsExceptions.includes(host)) return null;
  if (s.sites[registrableDomain(host)]?.httpsFirst === false) return null;
  u.protocol = 'https:';
  return u.toString();
}

// ── Request and response headers ──

type Headers = Record<string, string | string[]>;

const findKey = (h: Headers, name: string): string | undefined => Object.keys(h).find(k => k.toLowerCase() === name);

/** Add the "do not sell or share" signals: Sec-GPC: 1 and DNT: 1. */
export function withPrivacySignals(headers: Record<string, string>, on: boolean): Record<string, string> {
  if (!on) return headers;
  const out = { ...headers };
  if (!findKey(out, 'sec-gpc')) out['Sec-GPC'] = '1';
  if (!findKey(out, 'dnt')) out.DNT = '1';
  return out;
}

/**
 * Does the third-party cookie rule apply to this request? Main-frame
 * navigations are always first-party; everything else (sub-frames included)
 * is judged against the tab's top-level page.
 */
export function blocksCookies(requestUrl: string, topUrl: string, resourceType: string, s: Pick<ShieldSettings, 'cookies3p' | 'sites'>): boolean {
  if (!s.cookies3p || resourceType === 'mainFrame') return false;
  const top = siteOf(topUrl);
  if (!top || s.sites[top]?.cookies3p === false) return false;
  return isThirdParty(requestUrl, topUrl);
}

/** Remove the Cookie header; `removed` says whether there was one. */
export function stripCookie(headers: Record<string, string>): { headers: Record<string, string>; removed: boolean } {
  const key = findKey(headers, 'cookie');
  if (!key) return { headers, removed: false };
  const out = { ...headers };
  delete out[key];
  return { headers: out, removed: true };
}

/** Remove Set-Cookie from a response; `removed` counts the cookies dropped. */
export function stripSetCookie(headers: Headers | undefined): { headers: Headers | undefined; removed: number } {
  if (!headers) return { headers, removed: 0 };
  const key = findKey(headers, 'set-cookie');
  if (!key) return { headers, removed: 0 };
  const v = headers[key];
  const out = { ...headers };
  delete out[key];
  return { headers: out, removed: Array.isArray(v) ? v.length : v ? 1 : 0 };
}

// ── Downloads ──

/** Files that run code (or carry macros) when opened. */
const DANGEROUS = /\.(exe|msi|msix|msixbundle|appx|appxbundle|bat|cmd|com|scr|pif|cpl|ps1|psm1|psd1|vbs|vbe|js|jse|wsf|wsh|wsc|hta|reg|lnk|url|inf|msp|mst|gadget|application|jar|jnlp|apk|xapk|aab|dmg|pkg|mpkg|app|command|sh|bash|zsh|run|bin|appimage|deb|rpm|iso|img|vhd|vhdx|xll|xlam|docm|dotm|xlsm|xltm|pptm|potm|ppam|sldm|chm|library-ms|settingcontent-ms|diagcab|scf)$/i;

export function isDangerousFile(filename: string): boolean {
  return DANGEROUS.test(filename.trim().replace(/[. ]+$/, ''));
}

export interface DownloadRisk { dangerous: boolean; level: 'none' | 'caution' | 'high'; reason: string }

/**
 * How careful to be with a download. A file type that runs code is always
 * worth a warning; from a plain-http page (it could have been swapped in
 * transit) or a page AICO flagged as deceptive it is a strong one.
 */
export function downloadRisk(filename: string, ctx: { url: string; pageUrl?: string; flagged?: boolean }): DownloadRisk {
  const dangerous = isDangerousFile(filename);
  if (!dangerous) return { dangerous: false, level: 'none', reason: '' };
  const insecure = /^http:/i.test(ctx.url) || /^http:/i.test(ctx.pageUrl ?? '');
  const privateSource = [ctx.url, ctx.pageUrl ?? ''].every(u => { const h = hostOfUrl(u); return !h || isPrivateHost(h); });
  if (ctx.flagged) return { dangerous, level: 'high', reason: 'It comes from a page AICO flagged as possibly deceptive.' };
  if (insecure && !privateSource) return { dangerous, level: 'high', reason: 'It was sent over an insecure (http) connection, so it could have been altered on the way.' };
  return { dangerous, level: 'caution', reason: 'This type of file can run programs on your computer.' };
}

/**
 * The Mark-of-the-Web written to `<file>:Zone.Identifier` on Windows: zone 3
 * (Internet) plus where it came from, which is what SmartScreen and Office's
 * Protected View read. Credentials and #fragments are never written; data: and
 * blob: sources are recorded as about:internet.
 */
export function zoneIdentifier(url: string, referrer?: string): string {
  const safe = (u: string | undefined): string => {
    if (!u) return '';
    try {
      const x = new URL(u);
      if (x.protocol !== 'http:' && x.protocol !== 'https:' && x.protocol !== 'ftp:') return 'about:internet';
      x.username = ''; x.password = ''; x.hash = '';
      return x.toString();
    } catch { return ''; }
  };
  const lines = ['[ZoneTransfer]', 'ZoneId=3'];
  const ref = safe(referrer);
  if (ref && ref !== 'about:internet') lines.push(`ReferrerUrl=${ref}`);
  lines.push(`HostUrl=${safe(url) || 'about:internet'}`);
  return lines.join('\r\n') + '\r\n';
}
