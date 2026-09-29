/**
 * AICO Desktop — unit tests for the browser's privacy and safety rules:
 * tracker ownership, HTTPS-first, third-party cookies and privacy headers,
 * risky downloads and the Mark-of-the-Web, the deceptive-site heuristics
 * (with the false-positive checks that matter as much as the catches), the
 * host list parser, and insights bucketing. Pure modules, bundled with esbuild
 * and run in Node.
 *
 *   node scripts/test-browser-shield.mjs
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url));
const desktop = path.resolve(here, '..');
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'aico-desk-shield-'));

async function load(entry, name) {
  const file = path.join(out, `${name}.mjs`);
  await build({ entryPoints: [entry], bundle: true, format: 'esm', platform: 'node', outfile: file, logLevel: 'error' });
  return import(pathToFileURL(file).href);
}

let pass = 0; let fail = 0;
function ok(cond, label, detail) {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''}`); }
}

const trackers = await load(path.join(desktop, 'electron/browser-trackers.ts'), 'trackers');
const shield = await load(path.join(desktop, 'electron/browser-shield.ts'), 'shield');
const protect = await load(path.join(desktop, 'electron/browser-protect.ts'), 'protect');
const insights = await load(path.join(desktop, 'electron/browser-insights.ts'), 'insights');

// ── One header listener per session ──
{
  const hub = await load(path.join(desktop, 'electron/web-request.ts'), 'webreq');
  const m = hub.urlMatcher(['https://www.youtube-nocookie.com/*', 'https://*.openstreetmap.org/*']);
  ok(m('https://www.youtube-nocookie.com/embed/x') && m('https://tile.openstreetmap.org/1/2/3.png') && m('https://openstreetmap.org/'), 'dispatch: embed patterns match their hosts');
  ok(!m('https://evil.com/?https://tile.openstreetmap.org/') && !m('https://openstreetmap.org.evil.com/') && !m('http://www.youtube-nocookie.com/'), 'dispatch: patterns do not match look-alikes or other schemes');
  // A fake session: every handler runs, in order, on the same headers, through one listener.
  const listeners = { send: [], recv: [] };
  const ses = { webRequest: { onBeforeSendHeaders: (fn) => listeners.send.push(fn), onHeadersReceived: (fn) => listeners.recv.push(fn) } };
  hub.onRequestHeaders(ses, ['https://*.openstreetmap.org/*'], (_d, h) => (h.Referer ? undefined : { ...h, Referer: 'https://aico/' }));
  hub.onRequestHeaders(ses, undefined, (_d, h) => ({ ...h, 'Sec-GPC': '1' }));
  hub.onResponseHeaders(ses, undefined, (_d, h) => { const { 'set-cookie': _s, ...rest } = h; return rest; });
  ok(listeners.send.length === 1 && listeners.recv.length === 1, 'dispatch: one Electron listener per event per session');
  let got; listeners.send[0]({ url: 'https://tile.openstreetmap.org/x', requestHeaders: { Accept: '*/*' } }, (r) => { got = r; });
  ok(got.requestHeaders.Referer === 'https://aico/' && got.requestHeaders['Sec-GPC'] === '1', 'dispatch: both request handlers applied', got);
  listeners.send[0]({ url: 'https://example.com/', requestHeaders: {} }, (r) => { got = r; });
  ok(!got.requestHeaders.Referer && got.requestHeaders['Sec-GPC'] === '1', 'dispatch: a filtered handler skips other URLs', got);
  listeners.recv[0]({ url: 'https://x.com/', responseHeaders: { 'set-cookie': ['a=1'], 'x-y': ['1'] } }, (r) => { got = r; });
  ok(!got.responseHeaders['set-cookie'] && got.responseHeaders['x-y'], 'dispatch: response handler applied', got);
}

// ── Trackers ──
{
  ok(trackers.trackerOwner('www.google-analytics.com').company === 'Google', 'trackers: google-analytics is Google');
  ok(trackers.trackerOwner('connect.facebook.net').category === 'social', 'trackers: the Meta pixel is social');
  ok(trackers.trackerOwner('api.fpjs.io').category === 'fingerprinting', 'trackers: FingerprintJS is fingerprinting');
  ok(trackers.trackerOwner('static.hotjar.com').category === 'session-replay', 'trackers: Hotjar is session replay');
  ok(trackers.trackerOwner('cdn.unknownads.example').company === 'unknownads.example', 'trackers: an unnamed tracker is reported by its domain');
  ok(trackers.shouldBlock('https://api.fpjs.io/x', 'https://shop.example.com/', 'script').block, 'trackers: fingerprinting script blocked third-party');
  ok(!trackers.shouldBlock('https://www.google.com/recaptcha/api.js', 'https://shop.example.com/', 'script').block, 'trackers: reCAPTCHA is never blocked');
  ok(new Set(trackers.TRACKER_DOMAINS).size === trackers.TRACKER_DOMAINS.length || trackers.trackerCount() > 400, 'trackers: the list is substantial', trackers.trackerCount());
}

// ── Hosts ──
{
  for (const h of ['localhost', 'app.localhost', '127.0.0.1', '10.1.2.3', '192.168.1.1', '172.20.0.5', '169.254.1.1', '[::1]', 'fd12:3456::1', 'router', 'nas.local', 'svc.internal', 'dev.test']) {
    ok(shield.isPrivateHost(h), `hosts: ${h} is private`);
  }
  for (const h of ['example.com', '8.8.8.8', '172.32.0.1', '2606:4700::1111', 'bbc.co.uk']) ok(!shield.isPrivateHost(h), `hosts: ${h} is public`);
  ok(shield.siteOf('https://news.bbc.co.uk/x') === 'bbc.co.uk', 'hosts: site of news.bbc.co.uk is bbc.co.uk');
  ok(shield.isThirdParty('https://cdn.example.com/a.js', 'https://www.example.com/') === false, 'hosts: same site is first-party');
  ok(shield.isThirdParty('https://tracker.net/p', 'https://www.example.com/') === true, 'hosts: another site is third-party');
}

// ── HTTPS-first ──
{
  const s = shield.normaliseShield({});
  ok(shield.httpsUpgrade('http://example.com/a?b=1#c', s) === 'https://example.com/a?b=1#c', 'https: http://example.com is upgraded, path and query kept');
  ok(shield.httpsUpgrade('https://example.com/', s) === null, 'https: https is left alone');
  for (const u of ['http://localhost:3000/', 'http://127.0.0.1/', 'http://192.168.1.1/', 'http://router/', 'http://nas.local/', 'http://8.8.8.8/', 'http://example.com:8080/']) {
    ok(shield.httpsUpgrade(u, s) === null, `https: never upgrades ${u}`);
  }
  ok(shield.httpsUpgrade('http://example.com/', { ...s, httpsExceptions: ['example.com'] }) === null, 'https: a remembered http exception is honoured');
  ok(shield.httpsUpgrade('http://www.example.com/', shield.setSiteShield(s, 'example.com', { httpsFirst: false })) === null, 'https: a per-site "off" covers its subdomains');
  ok(shield.httpsUpgrade('http://example.com/', { ...s, httpsFirst: false }) === null, 'https: off globally means off');
}

// ── Cookies and headers ──
{
  const s = shield.normaliseShield({});
  ok(shield.blocksCookies('https://ads.tracker.net/p', 'https://news.example.com/', 'image', s), 'cookies: a third-party image loses its cookies');
  ok(!shield.blocksCookies('https://static.example.com/a.js', 'https://news.example.com/', 'script', s), 'cookies: same-site subresources keep them');
  ok(!shield.blocksCookies('https://accounts.google.com/', 'https://news.example.com/', 'mainFrame', s), 'cookies: a top-level navigation always keeps them');
  ok(shield.blocksCookies('https://www.youtube.com/embed/x', 'https://news.example.com/', 'subFrame', s), 'cookies: a third-party iframe loses them');
  const exc = shield.setSiteShield(s, 'example.com', { cookies3p: false });
  ok(!shield.blocksCookies('https://login.idp.com/x', 'https://app.example.com/', 'subFrame', exc), 'cookies: a site exception (sign-in) allows them');
  ok(!shield.blocksCookies('https://ads.tracker.net/p', 'https://news.example.com/', 'image', { ...s, cookies3p: false }), 'cookies: off globally means off');
  ok(!shield.blocksCookies('https://ads.tracker.net/p', '', 'image', s), 'cookies: unknown page → not judged');
  const r = shield.stripCookie({ Cookie: 'a=1', Accept: '*/*' });
  ok(r.removed && !('Cookie' in r.headers) && r.headers.Accept === '*/*', 'cookies: Cookie header removed, others kept');
  ok(!shield.stripCookie({ Accept: '*/*' }).removed, 'cookies: nothing to remove is reported as such');
  const sc = shield.stripSetCookie({ 'set-cookie': ['a=1', 'b=2'], 'content-type': ['text/html'] });
  ok(sc.removed === 2 && !sc.headers['set-cookie'] && sc.headers['content-type'], 'cookies: Set-Cookie (any case) removed and counted');
  const h = shield.withPrivacySignals({ Accept: '*/*' }, true);
  ok(h['Sec-GPC'] === '1' && h.DNT === '1', 'headers: Sec-GPC and DNT added');
  ok(!('Sec-GPC' in shield.withPrivacySignals({}, false)), 'headers: nothing added when GPC is off');
  ok(Object.keys(shield.withPrivacySignals({ 'sec-gpc': '1' }, true)).filter(k => k.toLowerCase() === 'sec-gpc').length === 1, 'headers: an existing Sec-GPC is not duplicated');
}

// ── Settings ──
{
  const s = shield.normaliseShield({ cookies3p: 'yes', protection: { list: false }, sites: { 'Example.com': { cookies3p: false, junk: 1 }, 'x.com': {} }, httpsExceptions: ['A.com', 'a.com', 3] });
  ok(s.cookies3p === true && s.protection.list === false && s.protection.heuristics === true, 'settings: bad values fall back, good ones kept');
  ok(JSON.stringify(s.sites) === '{"example.com":{"cookies3p":false}}', 'settings: empty site entries dropped, keys lower-cased', s.sites);
  ok(s.httpsExceptions.length === 1 && s.httpsExceptions[0] === 'a.com', 'settings: http exceptions de-duplicated', s.httpsExceptions);
  ok(s.notificationsAsk === false, 'settings: notification prompts are off by default');
  const t = shield.setSiteShield(s, 'evil.example', { trusted: true });
  ok(t.sites['evil.example'].trusted === true && !shield.setSiteShield(t, 'evil.example', { trusted: false }).sites['evil.example'], 'settings: trust set and cleared');
}

// ── Downloads ──
{
  for (const f of ['setup.exe', 'invoice.pdf.exe', 'run.PS1', 'macro.docm', 'disk.iso', 'app.apk', 'script.js', 'x.msi ']) ok(shield.isDangerousFile(f), `downloads: ${f.trim()} is dangerous`);
  for (const f of ['report.pdf', 'photo.jpg', 'data.csv', 'archive.zip', 'notes.docx', 'song.mp3']) ok(!shield.isDangerousFile(f), `downloads: ${f} is not`);
  ok(shield.downloadRisk('setup.exe', { url: 'http://files.example.com/setup.exe' }).level === 'high', 'downloads: an exe over http is high risk');
  ok(shield.downloadRisk('setup.exe', { url: 'https://example.com/setup.exe', flagged: true }).level === 'high', 'downloads: an exe from a flagged page is high risk');
  ok(shield.downloadRisk('setup.exe', { url: 'https://example.com/setup.exe' }).level === 'caution', 'downloads: an exe over https is a caution');
  ok(shield.downloadRisk('setup.exe', { url: 'http://localhost:8080/setup.exe' }).level === 'caution', 'downloads: an exe from localhost is not "insecure transit"');
  ok(shield.downloadRisk('a.pdf', { url: 'http://x.com/a.pdf' }).level === 'none', 'downloads: a pdf is not a risk');
  const z = shield.zoneIdentifier('https://user:pw@dl.example.com/a.exe#frag', 'https://example.com/page?x=1');
  ok(z === '[ZoneTransfer]\r\nZoneId=3\r\nReferrerUrl=https://example.com/page?x=1\r\nHostUrl=https://dl.example.com/a.exe\r\n', 'downloads: Zone.Identifier has zone 3, no credentials or fragment', z);
  ok(/HostUrl=about:internet/.test(shield.zoneIdentifier('blob:https://x.com/123')), 'downloads: blob: source is about:internet');
}

// ── Deceptive-site heuristics: catches ──
{
  const block = (u, label) => { const v = protect.assessUrl(u); ok(v.level === 'block', `protect: blocks ${label ?? u}`, v); };
  const warn = (u, label) => { const v = protect.assessUrl(u); ok(v.level === 'warn', `protect: warns ${label ?? u}`, v); };
  block('https://paypal.com.secure-login.xyz/signin', 'paypal.com.secure-login.xyz (brand in subdomain)');
  block('https://www.paypal.com.account-verify.info/', 'www.paypal.com.account-verify.info');
  block('https://appleid.apple.com-verify.support/', 'appleid.apple.com-verify.support');
  block('https://xn--pypal-4ve.com/', 'xn--pypal-4ve.com (pаypal, Cyrillic а)');
  block('https://xn--80ak6aa92e.com/', 'xn--80ak6aa92e.com (аррӏе, all-Cyrillic apple)');
  block('https://xn--ggle-0nda.com/', 'xn--ggle-0nda.com (gοοgle, Greek ο)');
  block('javascript:alert(1)', 'a javascript: page');
  warn('https://paypa1.com/', 'paypa1.com (1 for l)');
  warn('https://rnicrosoft.com/', 'rnicrosoft.com (rn for m)');
  warn('https://secure-paypal-login.net/', 'secure-paypal-login.net');
  warn('https://appleid-verify.com/', 'appleid-verify.com');
  warn('https://paypal.xyz/', 'paypal.xyz');
  warn('https://netflx.com/', 'netflx.com (one letter off)');
  warn('data:text/html,<h1>hi</h1>', 'a data: HTML page');
  const bad = protect.assessUrl('https://malware.example.net/x', { isBadHost: h => h === 'malware.example.net' });
  ok(bad.level === 'block' && bad.reasons[0].id === 'known-bad', 'protect: a listed host is blocked', bad);
}

// ── Deceptive-site heuristics: false positives that must not happen ──
{
  const clean = (u) => { const v = protect.assessUrl(u); ok(v.level === null, `protect: no flag on ${u}`, v); };
  for (const u of [
    'https://www.paypal.com/signin', 'https://paypal.com/', 'https://www.paypal-community.com/', 'https://accounts.google.com/ServiceLogin',
    'https://mail.google.com/', 'https://www.google.co.uk/', 'https://google.de/', 'https://github.com/login', 'https://gist.github.com/',
    'https://login.microsoftonline.com/', 'https://login.live.com/', 'https://appleid.apple.com/', 'https://www.icloud.com/', 'https://www.amazon.co.uk/ap/signin',
    'https://amazon.de/', 'https://s3.amazonaws.com/bucket/x', 'https://www.facebook.com/', 'https://www.bankofamerica.com/', 'https://www.chase.com/',
    'https://www.applebees.com/', 'https://apple-pie-recipes.com/', 'https://www.bbc.co.uk/news', 'https://en.wikipedia.org/wiki/PayPal',
    'https://xn--mnchen-3ya.de/', 'https://xn--bcher-kva.ch/', 'https://xn--fiqs8s.cn/', 'https://xn--d1acufc.xn--p1ai/', 'https://www.paypay.ne.jp/',
    'https://finance.yahoo.com/', 'https://www.revolt.tv/', 'https://gitlab.com/users/sign_in', 'https://www-paypal-com.translate.goog/',
    'https://google-sheets-tips.com/', 'http://localhost:3000/login', 'http://192.168.1.1/', 'https://example.com/', 'https://news.ycombinator.com/',
    'https://www.microsoft.com/en-gb/', 'https://outlook.office.com/mail/', 'https://mybank.example.co.uk/login',
  ]) clean(u);
}

// ── Page signals ──
{
  const page = (over) => ({ passwordFields: 0, cardFields: 0, forms: [], title: '', text: '', ...over });
  const pw = page({ passwordFields: 1, forms: [{ action: '', method: 'post', hasPassword: true }] });
  const v1 = protect.assessPage('http://shop.example.com/login', pw);
  ok(v1.level === 'warn' && v1.reasons.some(r => r.id === 'http-secret'), 'page: a password over http is a warning', v1);
  ok(protect.assessPage('https://shop.example.com/login', pw).level === null, 'page: a password over https on an ordinary site is fine');
  ok(protect.assessPage('http://localhost:3000/login', pw).level === null, 'page: a password on localhost over http is fine (development)');
  ok(protect.assessPage('http://192.168.1.1/', pw).level === null, 'page: a router login is fine');
  const v2 = protect.assessPage('https://203.0.113.9/login', pw);
  ok(v2.level === 'warn', 'page: a password on a public IP is a warning', v2);
  const v3 = protect.assessPage('https://cheap-hosting.example.org/wp-content/paypal/login.php', page({ passwordFields: 1, title: 'Log in to your PayPal account', forms: [{ action: 'https://collector.example.net/p.php', method: 'post', hasPassword: true }] }));
  ok(v3.level === 'block', 'page: "PayPal" login on an unrelated site, posting elsewhere, is blocked', v3);
  const v4 = protect.assessPage('https://secure-paypal-login.net/', pw);
  ok(v4.level === 'block', 'page: a password on a brand + lure domain is blocked', v4);
  ok(protect.assessPage('https://www.paypal.com/signin', page({ passwordFields: 1, title: 'Log in to your PayPal account' })).level === null, 'page: PayPal’s real login is fine');
  ok(protect.assessPage('https://accounts.google.com/v3/signin', page({ passwordFields: 1, title: 'Sign in - Google Accounts', forms: [{ action: 'https://accounts.google.com/x', method: 'post', hasPassword: true }] })).level === null, 'page: Google’s real login is fine');
  ok(protect.assessPage('https://github.com/login', page({ passwordFields: 1, title: 'Sign in to GitHub · GitHub' })).level === null, 'page: GitHub’s real login is fine');
  ok(protect.assessPage('https://news.example.com/', page({ title: 'PayPal shares fall' })).level === null, 'page: a news article naming a brand, no password, is fine');
  const v5 = protect.assessPage('https://app.example.com/login', page({ passwordFields: 1, forms: [{ action: 'https://auth.other-sso.com/login', method: 'post', hasPassword: true }] }));
  ok(v5.level === null && v5.reasons.some(r => r.id === 'form-cross-site'), 'page: a cross-site password post alone is noted, not flagged', v5);
  const v6 = protect.assessPage('data:text/html,x', page({ passwordFields: 1, title: 'Sign in' }));
  ok(v6.level === 'block', 'page: a data: page asking for a password is blocked', v6);
}

// ── Host list ──
{
  const list = protect.parseHostList('# comment\n127.0.0.1\tbad.example.com\n127.0.0.1\tlocalhost\n\n0.0.0.0 evil.test\n127.0.0.1  malware.net\n');
  ok(list.size === 2 && list.has('bad.example.com') && list.has('malware.net'), 'list: hosts parsed, localhost and reserved names skipped', [...list]);
  ok(protect.onList(list, 'cdn.malware.net') && !protect.onList(list, 'example.com'), 'list: a subdomain of a listed host matches');
  ok(/do NOT click, type/.test(protect.analysisPrompt({ url: 'https://x.test', level: 'block', reasons: [{ label: 'r' }], loaded: false })), 'prompt: the analysis request is read-only');
}

// ── Insights ──
{
  const base = new Date(2026, 8, 29, 10, 0, 0).getTime();
  const d = insights.emptyInsights();
  insights.recordPage(d, base, 'example.com', true);
  insights.recordPage(d, base + 1000, 'example.com', false);
  insights.recordActive(d, base, 'example.com', 5000);
  insights.recordActive(d, base, 'example.com', 10 * 60_000);
  insights.recordTracker(d, base, 'example.com', 'Google');
  insights.recordTracker(d, base, 'example.com', 'Google');
  insights.recordTracker(d, base - 86_400_000, 'news.com', 'Meta');
  insights.recordCount(d, base, 'cookies', 3);
  insights.recordCount(d, base, 'upgrades');
  const day = d.days[insights.dayKey(base)];
  ok(insights.dayKey(base) === '2026-09-29', 'insights: day key is the local date');
  ok(day.sites['example.com'].pages === 2 && day.sites['example.com'].visits === 1, 'insights: pages and visits counted separately');
  ok(day.sites['example.com'].ms === 65_000, 'insights: an active-time sample is capped at a minute', day.sites['example.com'].ms);
  ok(day.companies.Google === 2 && day.trackers === 2 && day.cookies === 3, 'insights: trackers per company and counters');
  const sum = insights.summarizeInsights(d, base, 7);
  ok(sum.days.length === 7 && sum.days[6].day === '2026-09-29' && sum.days[5].trackers === 1, 'insights: 7 days, oldest first, empty days present', sum.days.map(x => x.day));
  ok(sum.totals.trackers === 3 && sum.topCompanies[0].company === 'Google' && sum.topSites[0].site === 'example.com', 'insights: totals and top lists');
  ok(insights.summarizeInsights(d, base, 30).days.length === 30, 'insights: 30-day range');
  const dst = insights.summarizeInsights(insights.emptyInsights(), new Date(2026, 2, 31, 12).getTime(), 30).days.map(x => x.day);
  ok(new Set(dst).size === 30, 'insights: no day repeated or skipped across a clock change');
  insights.recordPage(d, base - 200 * 86_400_000, 'old.com', true);
  insights.pruneInsights(d, base);
  ok(!Object.keys(d.days).some(k => k < '2026-06'), 'insights: days past the keep window are pruned');
  for (let i = 0; i < 400; i++) insights.recordPage(d, base, `s${i}.com`, true);
  insights.pruneInsights(d, base);
  ok(Object.keys(d.days[insights.dayKey(base)].sites).length === insights.MAX_SITES_PER_DAY && d.days[insights.dayKey(base)].sites['example.com'], 'insights: a day is trimmed to its busiest sites');
  const cleared = insights.clearInsights(structuredClone(d), base);
  ok(!cleared.days['2026-09-29'] && cleared.days['2026-09-28'], 'insights: clearing since today keeps yesterday');
  ok(Object.keys(insights.clearInsights(d).days).length === 0, 'insights: clearing everything empties it');
  const n = insights.normaliseInsights({ days: { '2026-09-01': { trackers: 'x', sites: { 'a.com': { ms: 5 } } }, bogus: {} } });
  ok(n.days['2026-09-01'].trackers === 0 && n.days['2026-09-01'].sites['a.com'].ms === 5 && !n.days.bogus, 'insights: a damaged file is repaired, not rejected');
}

fs.rmSync(out, { recursive: true, force: true });
console.log(`\nBROWSER SHIELD UNIT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
