/**
 * Protected browsing — is this page trying to deceive you? Decided here, on
 * this device, from the URL and a few facts the page reports (password and
 * card fields, where its forms post, its title). No URL is ever sent anywhere
 * to be checked.
 *
 * Signals, each with a weight; the sum decides:
 *
 *   ≥ 70  block  — a full "Deceptive site ahead" page before (or instead of)
 *                  the site, and the agent refuses to act on it;
 *   ≥ 35  warn   — a warning bar over the page, and the agent still refuses
 *                  to click or type there.
 *
 *   brand in the subdomain      paypal.com.secure-login.xyz              80
 *   look-alike letters (IDN)    pаypal.com with a Cyrillic "а"           85
 *   mixed alphabets in a label  Latin + Cyrillic/Greek in one name       45
 *   ASCII look-alike            paypa1.com, rnicrosoft.com               45
 *   one typo from a brand       paypl.com, amazom.com                    40
 *   brand + "login/verify/…"    secure-paypal-login.net                  50
 *   brand on an odd TLD         paypal.xyz                               45
 *   public IP address as host                                           20
 *   known-bad host (URLhaus)                                            100
 *   javascript: / data: page    as a top-level page                      100 / 40
 *   + page: asks for a password or card on http / an IP / a look-alike  +35…
 *   + page: title claims a brand the domain does not belong to           +55
 *   + page: password form posts to another site / over http              +30 / +20
 *
 * Deliberately NOT judged: localhost, private addresses and intranet names
 * (developers and routers), and a brand's own domains — including every
 * country domain of the brand's exact name (amazon.de, google.co.uk).
 *
 * LIMITS, honestly: heuristics catch the common kits (look-alike domains,
 * brand-stuffed subdomains, a bank login on a random domain), not a
 * well-built clone on an innocuous domain with a neutral title; the list is
 * malware distribution hosts, not phishing. A flag is a reason to look
 * twice, and the absence of one is not a guarantee.
 *
 * @module desktop/electron/browser-protect
 */

import { domainToUnicode } from 'node:url';
import { registrableDomain } from './browser-trackers';
import { cleanHost, isIpLiteral, isPrivateHost } from './browser-shield';

export type ThreatLevel = 'block' | 'warn';
export interface ThreatReason { id: string; label: string; weight: number }
export interface ThreatVerdict { level: ThreatLevel | null; score: number; reasons: ThreatReason[]; brand?: string }

export const BLOCK_AT = 70;
export const WARN_AT = 35;

// ── Brands ──

interface Brand {
  name: string;
  /** Name tokens looked for inside other domains. */
  tokens: string[];
  /** A dictionary word too (apple, chase): only suspicious beside "login/verify/…". */
  generic?: boolean;
  /** Registrable domains the brand really uses. Its exact name on com/net/org or a country TLD counts too. */
  domains: string[];
  /** How the brand is named in a page title (lower-case). */
  titles: string[];
}

const BRANDS: Brand[] = [
  { name: 'PayPal', tokens: ['paypal'], domains: ['paypal.com', 'paypal.me', 'paypalobjects.com', 'paypal-community.com', 'paypal.cn', 'venmo.com', 'braintreegateway.com'], titles: ['paypal'] },
  { name: 'Apple', tokens: ['apple', 'icloud', 'itunes', 'appleid'], generic: true, domains: ['apple.com', 'icloud.com', 'me.com', 'mzstatic.com', 'itunes.com', 'apple.news', 'cdn-apple.com', 'icloud-content.com', 'applepay.com'], titles: ['apple id', 'apple account', 'icloud', 'itunes'] },
  { name: 'Microsoft', tokens: ['microsoft', 'office365', 'microsoft365', 'onedrive', 'sharepoint', 'hotmail'], domains: ['microsoft.com', 'microsoftonline.com', 'live.com', 'outlook.com', 'office.com', 'office365.com', 'office.net', 'hotmail.com', 'onedrive.com', 'sharepoint.com', 'msn.com', 'bing.com', 'azure.com', 'windows.net', 'windows.com', 'microsoftstore.com', 'xbox.com', 'skype.com', 'msauth.net', 'msftauth.net', 'microsoft365.com', 'msftconnecttest.com', 'windowsupdate.com', 'azureedge.net', 'visualstudio.com', 'linkedin.com', 'github.com'], titles: ['microsoft', 'office 365', 'microsoft 365', 'onedrive', 'sharepoint', 'hotmail'] },
  { name: 'Google', tokens: ['google', 'gmail', 'youtube'], domains: ['google.com', 'gmail.com', 'youtube.com', 'googleusercontent.com', 'gstatic.com', 'googleapis.com', 'withgoogle.com', 'googlemail.com', 'google.dev', 'googleblog.com', 'youtu.be', 'ggpht.com', 'gvt1.com', 'gvt2.com', 'blogger.com', 'android.com', 'chrome.com', 'googlesource.com', 'googlevideo.com', 'ytimg.com', 'googleplex.com', 'googletagmanager.com', 'google-analytics.com', 'doubleclick.net', 'googlesyndication.com', 'recaptcha.net', 'goo.gl', 'g.co', 'web.dev', 'chromium.org', 'firebase.google.com'], titles: ['google account', 'google accounts', 'gmail', 'sign in - google', 'youtube'] },
  { name: 'Amazon', tokens: ['amazon'], generic: true, domains: ['amazon.com', 'amazonaws.com', 'amazon.dev', 'media-amazon.com', 'ssl-images-amazon.com', 'a2z.com', 'amazontrust.com', 'primevideo.com', 'audible.com', 'awsstatic.com', 'amazon.jobs', 'aboutamazon.com', 'amzn.to', 'amazonpay.com', 'amazon-adsystem.com'], titles: ['amazon sign-in', 'amazon sign in', 'amazon account', 'amazon.com'] },
  { name: 'Meta', tokens: ['facebook', 'instagram', 'whatsapp'], domains: ['facebook.com', 'fb.com', 'fbcdn.net', 'instagram.com', 'cdninstagram.com', 'whatsapp.com', 'whatsapp.net', 'messenger.com', 'meta.com', 'facebook.net', 'fb.me', 'oculus.com', 'threads.net', 'wa.me'], titles: ['facebook', 'instagram', 'whatsapp'] },
  { name: 'Netflix', tokens: ['netflix'], domains: ['netflix.com', 'nflxext.com', 'nflximg.net', 'nflxvideo.net', 'netflix.net', 'nflxso.net'], titles: ['netflix'] },
  { name: 'LinkedIn', tokens: ['linkedin'], domains: ['linkedin.com', 'licdn.com', 'lnkd.in'], titles: ['linkedin'] },
  { name: 'X (Twitter)', tokens: ['twitter'], domains: ['twitter.com', 'x.com', 'twimg.com', 't.co'], titles: ['twitter'] },
  { name: 'GitHub', tokens: ['github'], domains: ['github.com', 'githubusercontent.com', 'githubassets.com', 'github.dev', 'githubapp.com', 'githubstatus.com', 'github.blog'], titles: ['github'] },
  { name: 'Dropbox', tokens: ['dropbox'], domains: ['dropbox.com', 'dropboxusercontent.com', 'db.tt', 'dropboxstatic.com', 'dropboxapi.com'], titles: ['dropbox'] },
  { name: 'DocuSign', tokens: ['docusign'], domains: ['docusign.com', 'docusign.net'], titles: ['docusign'] },
  { name: 'Adobe', tokens: ['adobe'], domains: ['adobe.com', 'adobelogin.com', 'adobe.io', 'typekit.net', 'adobesign.com', 'acrobat.com', 'adobecc.com', 'adobeccstatic.com'], titles: ['adobe id', 'adobe account', 'adobe document cloud'] },
  { name: 'Coinbase', tokens: ['coinbase'], domains: ['coinbase.com', 'cbhq.net'], titles: ['coinbase'] },
  { name: 'Binance', tokens: ['binance'], domains: ['binance.com', 'binance.us', 'bnbstatic.com', 'binance.info'], titles: ['binance'] },
  { name: 'MetaMask', tokens: ['metamask'], domains: ['metamask.io'], titles: ['metamask'] },
  { name: 'Chase', tokens: ['chase'], generic: true, domains: ['chase.com', 'jpmorgan.com', 'jpmorganchase.com', 'chasecdn.com'], titles: ['chase online', 'chase bank', 'chase.com'] },
  { name: 'Bank of America', tokens: ['bankofamerica'], domains: ['bankofamerica.com', 'bofa.com', 'ml.com'], titles: ['bank of america'] },
  { name: 'Wells Fargo', tokens: ['wellsfargo'], domains: ['wellsfargo.com', 'wf.com'], titles: ['wells fargo'] },
  { name: 'HSBC', tokens: ['hsbc'], domains: ['hsbc.com', 'hsbc.co.uk', 'hsbcnet.com'], titles: ['hsbc'] },
  { name: 'Barclays', tokens: ['barclays', 'barclaycard'], domains: ['barclays.co.uk', 'barclays.com', 'barclaycard.co.uk', 'barclays.net'], titles: ['barclays', 'barclaycard'] },
  { name: 'Santander', tokens: ['santander'], domains: ['santander.co.uk', 'santander.com', 'santanderbank.com'], titles: ['santander'] },
  { name: 'Lloyds', tokens: ['lloydsbank'], domains: ['lloydsbank.com', 'lloydsbank.co.uk', 'lloydsbankinggroup.com'], titles: ['lloyds bank'] },
  { name: 'NatWest', tokens: ['natwest'], domains: ['natwest.com', 'natwestgroup.com'], titles: ['natwest'] },
  { name: 'American Express', tokens: ['americanexpress', 'amex'], domains: ['americanexpress.com', 'aexp.com', 'aexp-static.com'], titles: ['american express'] },
  { name: 'Spotify', tokens: ['spotify'], domains: ['spotify.com', 'scdn.co', 'spotifycdn.com', 'spotify.link'], titles: ['spotify'] },
  { name: 'eBay', tokens: ['ebay'], domains: ['ebay.com', 'ebayimg.com', 'ebaystatic.com', 'ebayinc.com'], titles: ['ebay'] },
  { name: 'DHL', tokens: ['dhl'], domains: ['dhl.com', 'dhl.de', 'dhlparcel.co.uk', 'dhlparcel.nl'], titles: ['dhl express', 'dhl parcel'] },
  { name: 'FedEx', tokens: ['fedex'], domains: ['fedex.com'], titles: ['fedex'] },
  { name: 'USPS', tokens: ['usps'], domains: ['usps.com', 'usps.gov'], titles: ['usps'] },
  { name: 'Royal Mail', tokens: ['royalmail'], domains: ['royalmail.com', 'royalmail.co.uk', 'royalmailgroup.com'], titles: ['royal mail'] },
  { name: 'Steam', tokens: ['steamcommunity', 'steampowered'], domains: ['steamcommunity.com', 'steampowered.com', 'steamstatic.com', 'steamgames.com'], titles: ['steam community', 'steam login', 'sign in to steam'] },
  { name: 'Roblox', tokens: ['roblox'], domains: ['roblox.com', 'rbxcdn.com'], titles: ['roblox'] },
  { name: 'Discord', tokens: ['discord'], domains: ['discord.com', 'discord.gg', 'discordapp.com', 'discordapp.net', 'discord.media'], titles: ['discord'] },
  { name: 'Yahoo', tokens: ['yahoo'], domains: ['yahoo.com', 'yimg.com', 'yahoo.net', 'aol.com', 'yahoodns.net'], titles: ['yahoo'] },
  { name: 'Okta', tokens: ['okta'], domains: ['okta.com', 'oktacdn.com', 'okta-emea.com', 'oktapreview.com'], titles: ['okta'] },
  { name: 'WeTransfer', tokens: ['wetransfer'], domains: ['wetransfer.com', 'we.tl'], titles: ['wetransfer'] },
  { name: 'Revolut', tokens: ['revolut'], domains: ['revolut.com', 'revolut.me'], titles: ['revolut'] },
  { name: 'Venmo', tokens: ['venmo'], domains: ['venmo.com', 'paypal.com'], titles: ['venmo'] },
  { name: 'Cash App', tokens: ['cashapp'], domains: ['cash.app', 'cashapp.com', 'squareup.com'], titles: ['cash app'] },
  { name: 'Shopify', tokens: ['shopify'], domains: ['shopify.com', 'myshopify.com', 'shopifycdn.com', 'shopify.dev', 'shop.app'], titles: [] },
  { name: 'Walmart', tokens: ['walmart'], domains: ['walmart.com', 'walmartimages.com'], titles: ['walmart'] },
  { name: 'AliExpress', tokens: ['aliexpress', 'alibaba'], domains: ['aliexpress.com', 'alibaba.com', 'alicdn.com', 'aliexpress.us', 'alipay.com'], titles: ['aliexpress', 'alibaba'] },
  { name: 'Epic Games', tokens: ['epicgames'], domains: ['epicgames.com', 'unrealengine.com', 'epicgames.dev'], titles: ['epic games'] },
  { name: 'HMRC', tokens: ['hmrc'], domains: ['hmrc.gov.uk', 'gov.uk'], titles: ['hmrc'] },
];

/** Distinct real brands that happen to sit one letter from another (paypay ≠ paypal). */
const KNOWN_DISTINCT = new Set(['paypay', 'goggle', 'amazin', 'gitlab', 'finance', 'discard', 'revolt', 'cloud', 'tunes', 'applied', 'twitch', 'binge']);

/** Hosting that legitimately re-encodes other sites' names in its subdomains (www-paypal-com.translate.goog). */
const PROXY_SITES = new Set(['translate.goog', 'ampproject.org', 'archive.org', 'archive.ph', 'webcache.googleusercontent.com']);

/** Words that turn a brand-bearing domain into a credible phishing lure. */
const LURE = new Set([
  'login', 'log', 'logon', 'signin', 'sign', 'secure', 'security', 'verify', 'verification', 'verified', 'account', 'accounts', 'update',
  'support', 'help', 'helpdesk', 'service', 'services', 'id', 'auth', 'wallet', 'billing', 'confirm', 'unlock', 'recovery', 'recover',
  'alert', 'online', 'customer', 'center', 'centre', 'official', 'safe', 'protect', 'restore', 'refund', 'claim', 'reward', 'gift', 'bonus',
  'payment', 'invoice', 'suspended', 'limited', 'locked', 'webscr', 'ssl', 'portal', 'mail', 'team', 'resolution', 'dispute', 'session', 'validate', 'reset', 'password',
]);

/** TLDs registered far out of proportion for abuse (Interisle / Spamhaus reports). A weak signal alone. */
const RISKY_TLDS = new Set([
  'zip', 'mov', 'xyz', 'top', 'tk', 'ml', 'ga', 'cf', 'gq', 'icu', 'buzz', 'cyou', 'rest', 'sbs', 'cfd', 'click', 'link', 'work', 'support',
  'country', 'kim', 'loan', 'men', 'date', 'bid', 'win', 'review', 'stream', 'download', 'racing', 'party', 'trade', 'science', 'accountant',
  'cricket', 'faith', 'lol', 'monster', 'quest', 'bond', 'beauty', 'hair', 'skin', 'makeup', 'autos', 'boats', 'homes', 'yachts', 'mom',
  'bar', 'fit', 'live', 'online', 'site', 'website', 'space', 'fun', 'pw', 'cc', 'ws', 'su', 'best', 'ink', 'wiki', 'digital', 'ltd', 'vip',
]);

// ── Look-alike letters ──

/** Letters that look like Latin ones (Cyrillic, Greek, and Latin with marks), mapped to what they imitate. */
const CONFUSABLE: Record<string, string> = {
  а: 'a', е: 'e', о: 'o', р: 'p', с: 'c', у: 'y', х: 'x', і: 'i', ј: 'j', ԁ: 'd', ӏ: 'l', ѕ: 's', һ: 'h', ԛ: 'q', ԝ: 'w', ь: 'b', в: 'b', к: 'k', м: 'm', н: 'h', т: 't', ɡ: 'g', ɑ: 'a',
  ο: 'o', α: 'a', ν: 'v', ρ: 'p', τ: 't', ι: 'i', κ: 'k', ε: 'e', υ: 'u', χ: 'x', β: 'b', γ: 'y', η: 'n', μ: 'u', ω: 'w',
  ı: 'i', ł: 'l', ø: 'o', đ: 'd', ħ: 'h', ŀ: 'l', ƅ: 'b', ɩ: 'i', ʀ: 'r', ꞵ: 'b',
};

/** Latin letters with diacritics are folded by NFKD; the rest by the table. */
export function skeleton(label: string): string {
  const folded = label.normalize('NFKD').replace(/[̀-ͯ]/g, '');
  let out = '';
  for (const ch of folded) out += CONFUSABLE[ch] ?? ch;
  return out.toLowerCase();
}

/** ASCII tricks: rn→m, vv→w, 0→o, 1/i→l, 5→s, 3→e. Applied to both sides before comparing. */
export function asciiSkeleton(label: string): string {
  return label.toLowerCase().replace(/rn/g, 'm').replace(/vv/g, 'w').replace(/0/g, 'o').replace(/[1i]/g, 'l').replace(/5/g, 's').replace(/3/g, 'e').replace(/-/g, '');
}

const SCRIPT = { latin: /[a-zÀ-ɏḀ-ỿ]/i, cyrillic: /[Ѐ-ԯ]/, greek: /[Ͱ-Ͽ]/ };

/** Latin mixed with Cyrillic or Greek (or Cyrillic with Greek) in one label. */
export function mixedScript(label: string): boolean {
  const n = Number(SCRIPT.latin.test(label)) + Number(SCRIPT.cyrillic.test(label)) + Number(SCRIPT.greek.test(label));
  return n > 1;
}

/** Optimal-string-alignment distance, capped (we only care about 0, 1, 2+). */
export function editDistance(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 1) return 2;
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0]![j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i]![j] = Math.min(d[i]![j]!, d[i - 2]![j - 2]! + 1);
    }
  }
  return d[a.length]![b.length]!;
}

// ── Domains ──

/** A host's labels, the site (registrable domain) and its first label, all in Unicode. */
function parts(host: string): { host: string; unicode: string; site: string; siteLabel: string; tld: string; sub: string[] } {
  const h = cleanHost(host);
  const unicode = h.includes('xn--') ? (domainToUnicode(h) || h) : h;
  const site = registrableDomain(h);
  const siteUni = site.includes('xn--') ? (domainToUnicode(site) || site) : site;
  const siteLabel = siteUni.split('.')[0] ?? '';
  const tld = site.split('.').slice(1).join('.');
  const sub = h === site ? [] : h.slice(0, h.length - site.length - 1).split('.');
  return { host: h, unicode, site, siteLabel, tld, sub };
}

/** Is `site` one the brand really uses? Its exact name on com/net/org or any country code is accepted. */
function isOfficial(brand: Brand, site: string): boolean {
  if (brand.domains.includes(site)) return true;
  const [label, ...rest] = site.split('.');
  const tld = rest.join('.');
  if (!brand.tokens.includes(label ?? '') && !brand.domains.some(d => d.split('.')[0] === label)) return false;
  return /^(com|net|org)$/.test(tld) || /^[a-z]{2}$/.test(tld) || /^(co|com|org|net|ne|or|gov|ac)\.[a-z]{2}$/.test(tld);
}

/** Does this host belong to any brand at all? Then no brand heuristic applies to it. */
function officialFor(site: string): Brand | undefined {
  return BRANDS.find(b => isOfficial(b, site));
}

const tokensOf = (label: string): string[] => label.toLowerCase().split(/[^a-z0-9]+|(?<=[a-z])(?=\d)|(?<=\d)(?=[a-z])/).filter(Boolean);

/** A token that is the brand, or the brand glued to a lure word (appleid, paypallogin, securepaypal). */
function brandInToken(token: string, brandToken: string): 'exact' | 'glued' | null {
  if (token === brandToken) return 'exact';
  if (brandToken.length < 4 || !token.includes(brandToken)) return null;
  const rest = token.replace(brandToken, '');
  return LURE.has(rest) || [...LURE].some(w => w.length >= 4 && (rest.startsWith(w) || rest.endsWith(w))) ? 'glued' : null;
}

interface UrlOptions {
  /** A malware / phishing host list lookup. */
  isBadHost?: (host: string) => boolean;
}

const add = (r: ThreatReason[], id: string, label: string, weight: number): void => { r.push({ id, label, weight }); };

function verdict(reasons: ThreatReason[], brand?: string): ThreatVerdict {
  const score = Math.min(100, reasons.reduce((n, r) => n + r.weight, 0));
  return { level: score >= BLOCK_AT ? 'block' : score >= WARN_AT ? 'warn' : null, score, reasons: reasons.sort((a, b) => b.weight - a.weight), ...(brand ? { brand } : {}) };
}

/** Signals from the address alone — checked before the page is fetched. */
export function assessUrl(url: string, opts: UrlOptions = {}): ThreatVerdict {
  const reasons: ThreatReason[] = [];
  if (/^javascript:/i.test(url)) { add(reasons, 'javascript-url', 'A javascript: address was opened as a page', 100); return verdict(reasons); }
  if (/^data:/i.test(url)) {
    if (/^data:(text\/html|application\/xhtml|image\/svg)/i.test(url)) add(reasons, 'data-url', 'The page was opened from inline data (a data: address), so its address says nothing about who made it', 40);
    return verdict(reasons);
  }
  let u: URL;
  try { u = new URL(url); } catch { return verdict(reasons); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return verdict(reasons);
  const host = cleanHost(u.hostname);
  if (isPrivateHost(host)) return verdict(reasons);

  if (opts.isBadHost?.(host)) add(reasons, 'known-bad', 'This host is on a public list of sites distributing malware (URLhaus)', 100);
  if (u.username || u.password) add(reasons, 'userinfo', 'The address hides its real destination behind a user name (user@host)', 30);
  if (isIpLiteral(host)) { add(reasons, 'ip-host', 'The site is a bare IP address, not a named domain', 20); return verdict(reasons); }

  const p = parts(host);
  if (officialFor(p.site)) return verdict(reasons);
  let brand: string | undefined;

  // Look-alike letters in the site's own name (an IDN that imitates a brand).
  const idn = p.siteLabel !== p.site.split('.')[0] || /[^\x00-\x7f]/.test(p.siteLabel);
  if (idn && mixedScript(p.siteLabel)) add(reasons, 'mixed-script', `The name mixes alphabets (“${p.siteLabel}”) — a common way to imitate another site`, 45);
  const skel = skeleton(p.siteLabel);
  const ascii = asciiSkeleton(skel);
  for (const b of BRANDS) {
    const names = new Set([...b.tokens, ...b.domains.map(d => d.split('.')[0]!)].filter(n => n.length >= 4));
    for (const n of names) {
      if (idn && skel === n) { add(reasons, 'homograph', `“${p.unicode}” uses look-alike letters to imitate ${b.name}`, 85); brand = b.name; break; }
      if (!idn && p.siteLabel !== n && ascii === asciiSkeleton(n)) { add(reasons, 'lookalike', `“${p.site}” imitates ${b.name} by swapping similar-looking characters`, 45); brand = b.name; break; }
      if (!idn && n.length >= 6 && b.tokens.includes(n) && !KNOWN_DISTINCT.has(p.siteLabel) && p.siteLabel !== n && editDistance(p.siteLabel, n) === 1) {
        add(reasons, 'typo', `“${p.site}” is one letter away from ${b.name}’s domain`, 40); brand = b.name; break;
      }
    }
    if (brand) break;
  }

  // A brand's real domain inside the subdomains: paypal.com.secure-login.xyz, www-paypal-com.evil.net.
  if (!brand && p.sub.length && !PROXY_SITES.has(p.site)) {
    // The brand's domain followed by "." or "-" anywhere in the host (the site itself is not the brand's).
    const dotted = `.${p.host}`;
    const subText = p.sub.join('.');
    for (const b of BRANDS) {
      const d = b.domains.find(x => x.length >= 6 && (dotted.includes(`.${x}.`) || dotted.includes(`.${x}-`) || subText.includes(x.replace(/\./g, '-'))));
      if (d) { add(reasons, 'brand-subdomain', `The address starts like ${d} but the site is really ${p.site}`, 80); brand = b.name; break; }
      const subTokens = p.sub.flatMap(tokensOf);
      if (!b.generic && b.tokens.some(t => subTokens.some(s => brandInToken(s, t)))) {
        const lure = subTokens.some(s => LURE.has(s)) || tokensOf(p.siteLabel).some(s => LURE.has(s));
        add(reasons, 'brand-subdomain-name', `The address uses the ${b.name} name on an unrelated site (${p.site})`, lure ? 45 : 25); brand = b.name; break;
      }
    }
  }

  // A brand's name inside the site's own name: secure-paypal-login.net, appleid-verify.com, paypal.xyz.
  if (!brand) {
    const toks = tokensOf(p.siteLabel);
    const lure = toks.some(t => LURE.has(t));
    for (const b of BRANDS) {
      const hit = toks.map(t => b.tokens.map(bt => brandInToken(t, bt)).find(Boolean)).find(Boolean);
      if (!hit) continue;
      brand = b.name;
      if (toks.length === 1 && hit === 'exact') {
        add(reasons, 'brand-other-tld', `${b.name}’s name on a domain ${b.name} does not use (.${p.tld})`, b.generic ? 15 : 45);
      } else if (hit === 'glued' || lure) {
        add(reasons, 'brand-lure', `Combines the ${b.name} name with “${toks.find(t => LURE.has(t)) ?? 'account'}”-style words on a site ${b.name} does not use`, 50);
      } else {
        add(reasons, 'brand-in-name', `Uses the ${b.name} name on a site ${b.name} does not use`, b.generic ? 0 : 30);
      }
      break;
    }
  }

  const tld = host.split('.').pop() ?? '';
  if (RISKY_TLDS.has(tld)) add(reasons, 'risky-tld', `.${tld} domains are disproportionately used for abuse`, brand ? 15 : 5);
  if ((host.match(/\./g)?.length ?? 0) >= 5 && brand) add(reasons, 'deep-host', 'An unusually long chain of subdomains', 10);
  return verdict(reasons.filter(r => r.weight > 0), brand);
}

// ── Page signals ──

export interface PageSignals {
  /** password inputs (not hidden) */
  passwordFields: number;
  /** card number / CVV inputs */
  cardFields: number;
  forms: Array<{ action: string; method: string; hasPassword: boolean }>;
  title: string;
  /** The first few thousand characters of visible text. */
  text: string;
}

/** A page title that names a brand as a word ("Sign in to PayPal", "Microsoft account"). */
export function brandInTitle(title: string): Brand | undefined {
  const t = ` ${title.toLowerCase().replace(/[^a-z0-9.]+/g, ' ')} `;
  return BRANDS.find(b => b.titles.some(name => t.includes(` ${name} `)));
}

const BRAND_SIGNALS = new Set(['homograph', 'lookalike', 'typo', 'brand-subdomain', 'brand-subdomain-name', 'brand-lure', 'brand-other-tld', 'mixed-script']);

/** URL signals plus what the page asks for and where it sends it. */
export function assessPage(url: string, sig: PageSignals, opts: UrlOptions = {}): ThreatVerdict {
  const base = assessUrl(url, opts);
  const reasons = [...base.reasons];
  let brand = base.brand;
  let u: URL | null = null;
  try { u = new URL(url); } catch { /* data: etc. */ }
  const host = u ? cleanHost(u.hostname) : '';
  const web = u && (u.protocol === 'http:' || u.protocol === 'https:');
  if (web && isPrivateHost(host)) return verdict([]);
  const secret = sig.passwordFields > 0 || sig.cardFields > 0 || sig.forms.some(f => f.hasPassword);
  const what = sig.cardFields > 0 && sig.passwordFields === 0 ? 'card details' : 'a password';
  if (!secret) return verdict(reasons, brand);

  const site = web ? registrableDomain(host) : '';
  if (web && u!.protocol === 'http:') add(reasons, 'http-secret', `Asks for ${what} over an insecure (http) connection`, 35);
  if (web && isIpLiteral(host)) add(reasons, 'ip-secret', `Asks for ${what} on a bare IP address`, 35);
  if (!web) add(reasons, 'data-secret', `Asks for ${what} on a page with no real address`, 45);
  const imitation = base.reasons.filter(r => BRAND_SIGNALS.has(r.id)).reduce((n, r) => n + r.weight, 0);
  if (base.brand && imitation >= 40) add(reasons, 'brand-secret', `Asks for ${what} on a site imitating ${base.brand}`, 35);
  const tld = host.split('.').pop() ?? '';
  if (web && RISKY_TLDS.has(tld) && !base.brand) add(reasons, 'risky-tld-secret', `Asks for ${what} on a .${tld} domain`, 20);

  const claimed = brandInTitle(sig.title);
  if (claimed && (!web || !isOfficial(claimed, site))) {
    add(reasons, 'title-brand', `The page calls itself ${claimed.name} (“${sig.title.slice(0, 60)}”) but ${web ? `the site is ${site}` : 'it has no real address'}`, 55);
    brand = brand ?? claimed.name;
    if (web && u && new RegExp(claimed.tokens.join('|'), 'i').test(u.pathname + u.search)) add(reasons, 'brand-path', `${claimed.name}’s name appears in the page’s path`, 15);
  }

  for (const f of sig.forms) {
    if (!f.hasPassword || !f.action) continue;
    let a: URL;
    try { a = new URL(f.action, url); } catch { continue; }
    if (a.protocol === 'javascript:' || a.protocol === 'about:') continue;
    if (a.protocol === 'http:' && !isPrivateHost(a.hostname) && (!u || u.protocol === 'https:')) { add(reasons, 'form-http', 'Its sign-in form sends the password over an insecure connection', 20); break; }
    if ((a.protocol === 'http:' || a.protocol === 'https:') && site && registrableDomain(cleanHost(a.hostname)) !== site) {
      add(reasons, 'form-cross-site', `Its sign-in form sends the password to another site (${registrableDomain(cleanHost(a.hostname))})`, 30);
      break;
    }
  }
  return verdict(reasons, brand);
}

/** Parse a hosts-format list (URLhaus hostfile): "127.0.0.1\thost" lines, comments skipped. */
export function parseHostList(text: string, cap = 200_000): Set<string> {
  const out = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const l = line.trim();
    if (!l || l.startsWith('#')) continue;
    const host = (l.split(/\s+/)[1] ?? l.split(/\s+/)[0] ?? '').toLowerCase();
    if (!host || host === 'localhost' || !host.includes('.') || isPrivateHost(host)) continue;
    out.add(host);
    if (out.size >= cap) break;
  }
  return out;
}

/** Is this host (or a parent domain of it) on the list? */
export function onList(list: Set<string>, host: string): boolean {
  const h = cleanHost(host);
  if (list.has(h)) return true;
  const labels = h.split('.');
  for (let i = 1; i < labels.length - 1; i++) if (list.has(labels.slice(i).join('.'))) return true;
  return false;
}

/** What the copilot is asked when a page is flagged — read-only by instruction, and by the browser's refusal. */
export function analysisPrompt(t: { url: string; level: ThreatLevel; reasons: Array<{ label: string }>; loaded: boolean }): string {
  return [
    `AICO Protected Browsing flagged this page as ${t.level === 'block' ? 'likely deceptive' : 'possibly suspicious'}: ${t.url}`,
    t.loaded ? '' : 'The page was blocked before it loaded — judge it from its address and the signals below; do not open it.',
    'Signals found on this device:',
    ...t.reasons.slice(0, 6).map(r => `- ${r.label}`),
    '',
    'Explain in plain words why this looks suspicious (or why it may be a false alarm), who it may be imitating, and what I should do next — for example the real site to use instead.',
    'Only look: you may use browser_read, browser_insights or browser_snapshot on it; do NOT click, type, fill, submit or download anything there (the browser refuses those actions on flagged pages), and never ask me to enter a password, card or code on it.',
  ].filter(Boolean).join('\n');
}
