/**
 * What kind of page this is — the copilot's page classifier, shared by the
 * chrome (renderer/src/browser/suggest.ts turns it into chips) and main
 * (electron/browser-tab-summary.ts keeps a one-line summary of every open tab
 * for the copilot). It lives here, not in the renderer, so main classifies a
 * background tab with the very same rules instead of a second, drifting copy.
 *
 * It reads the facts a page publishes about itself (schema.org JSON-LD and
 * microdata, OpenGraph — see page-signals.ts) plus a few cheap counts.
 * Structured data wins over heuristics; the host names a few well-known apps;
 * counts decide the rest. Pure.
 *
 * @module desktop/shared/page-classify
 */

import type { PageSignals } from './page-signals';

export type PageKind =
  | 'product' | 'article' | 'recipe' | 'job' | 'event' | 'video' | 'search' | 'cart' | 'checkout'
  | 'login' | 'form' | 'docs' | 'code' | 'qa' | 'email' | 'chat' | 'page';

export interface PageClass {
  kind: PageKind;
  /** "Product", "Article"… for the omnibox badge. */
  label: string;
  /** How sure: structured data is 0.9+, a host rule 0.85, counts lower. */
  confidence: number;
  /** A detail worth showing ("$129.99", "4.6★"). */
  detail?: string;
}

const LABELS: Record<PageKind, string> = {
  product: 'Product', article: 'Article', recipe: 'Recipe', job: 'Job', event: 'Event', video: 'Video', search: 'Search results',
  cart: 'Cart', checkout: 'Checkout', login: 'Sign-in', form: 'Form', docs: 'Docs', code: 'Code', qa: 'Q&A', email: 'Mail', chat: 'Chat', page: 'Page',
};

const LD_KINDS: Array<[RegExp, PageKind]> = [
  [/^(Product|ProductGroup|IndividualProduct|ProductModel|Car|Book|SoftwareApplication|MobileApplication|VideoGame)$/i, 'product'],
  [/^Recipe$/i, 'recipe'],
  [/^JobPosting$/i, 'job'],
  [/^(Event|MusicEvent|SportsEvent|TheaterEvent|BusinessEvent|EducationEvent|Festival|ScreeningEvent|ComedyEvent|SocialEvent)$/i, 'event'],
  [/^(VideoObject|Movie|TVEpisode|Episode|Clip)$/i, 'video'],
  [/^(NewsArticle|Article|BlogPosting|TechArticle|Report|ScholarlyArticle|AnalysisNewsArticle|OpinionNewsArticle|ReviewNewsArticle|LiveBlogPosting|Review)$/i, 'article'],
  [/^(QAPage|Question)$/i, 'qa'],
  [/^SearchResultsPage$/i, 'search'],
  [/^CheckoutPage$/i, 'checkout'],
];

const HOSTS: Array<[RegExp, PageKind, RegExp?]> = [
  [/^mail\.google\.com$|^outlook\.(live|office|office365)\.com$|^mail\.yahoo\.com$|^mail\.proton\.me$|^app\.fastmail\.com$|^(www\.)?icloud\.com$/i, 'email'],
  [/^web\.whatsapp\.com$|^app\.slack\.com$|^(www\.)?discord\.com$|^teams\.microsoft\.com$|^teams\.live\.com$|^(www\.)?messenger\.com$|^web\.telegram\.org$|^chat\.google\.com$/i, 'chat'],
  [/^(www\.)?youtube\.com$|^m\.youtube\.com$/i, 'video', /^\/(watch|shorts\/|live\/)/],
  [/^(www\.)?vimeo\.com$/i, 'video', /^\/\d+/],
  [/^(www\.)?(github\.com|gitlab\.com|bitbucket\.org|codeberg\.org)$/i, 'code', /^\/[^/]+\/[^/]+/],
  [/^(www\.)?(stackoverflow\.com|superuser\.com|serverfault\.com|askubuntu\.com)$|\.stackexchange\.com$/i, 'qa', /^\/questions\/\d+/],
  [/^developer\.mozilla\.org$|^docs\.|\.readthedocs\.io$|^learn\.microsoft\.com$|^(www\.)?docs\.python\.org$|^devdocs\.io$|^pkg\.go\.dev$|^docs\.rs$/i, 'docs'],
];

function hostPath(url: string): { host: string; path: string } {
  try { const u = new URL(url); return { host: u.hostname.toLowerCase(), path: u.pathname }; } catch { return { host: '', path: '' }; }
}

function money(price?: string, currency?: string): string | undefined {
  if (!price || !/\d/.test(price)) return undefined;
  const sym: Record<string, string> = { USD: '$', EUR: '€', GBP: '£', JPY: '¥', INR: '₹' };
  const c = (currency ?? '').toUpperCase();
  return sym[c] ? `${sym[c]}${price}` : `${price}${c ? ` ${c}` : ''}`;
}

export function classifyPage(s: PageSignals | null | undefined): PageClass {
  const page: PageClass = { kind: 'page', label: LABELS.page, confidence: 0 };
  if (!s || !/^https?:/i.test(s.url)) return page;
  const make = (kind: PageKind, confidence: number, detail?: string): PageClass => ({ kind, label: LABELS[kind], confidence, ...(detail ? { detail } : {}) });
  const { host, path } = hostPath(s.url);

  // Apps whose job is obvious from where they live (a mail app has no schema.org).
  for (const [re, kind, pathRe] of HOSTS) {
    if (re.test(host) && (!pathRe || pathRe.test(path))) return make(kind, 0.85);
  }

  // Checkout and cart outrank the product data some shops still print there.
  if (s.cues.placeOrder && (s.cues.checkout || s.fields.address > 0 || s.fields.card > 0)) return make('checkout', 0.9);
  if (s.ld.some(i => i.type.some(t => /^CheckoutPage$/i.test(t)))) return make('checkout', 0.95);
  if (s.cues.checkout && (s.fields.address > 1 || s.fields.card > 0)) return make('checkout', 0.8);
  if (s.cues.cart && !s.cues.results) return make('cart', 0.8);

  // What the page says it is. The first item that names a kind we know wins, preferring the "main" kinds.
  const kinds = s.ld.flatMap(i => i.type.map(t => ({ t, i })));
  for (const [re, kind] of LD_KINDS) {
    const hit = kinds.find(k => re.test(k.t));
    if (!hit) continue;
    // A news site's article list often carries a VideoObject for an embed; the article is the page.
    if (kind === 'video' && kinds.some(k => /Article|BlogPosting/i.test(k.t))) continue;
    const i = hit.i;
    const detail = kind === 'product'
      ? [money(i.price, i.currency), i.rating ? `${Math.round(i.rating * 10) / 10}★` : ''].filter(Boolean).join(' · ')
      : kind === 'job' || kind === 'article' ? i.org : kind === 'event' ? i.date?.slice(0, 10) : kind === 'recipe' ? i.yield : undefined;
    return make(kind, 0.95, detail || undefined);
  }
  const micro = s.microdata.map(m => m.toLowerCase());
  if (micro.some(m => m === 'product' || m === 'offer' || m === 'aggregateoffer')) return make('product', 0.9);
  if (micro.includes('recipe')) return make('recipe', 0.9);
  if (micro.includes('jobposting')) return make('job', 0.9);
  if (micro.includes('event')) return make('event', 0.85);
  if (micro.some(m => /article|blogposting/.test(m))) return make('article', 0.85);

  const ogType = (s.og.type ?? '').toLowerCase();
  if (/^(product|og:product|product\.item)$/.test(ogType) || s.og.price) return make('product', 0.85, money(s.og.price, s.og.currency));
  if (/^video(\.|$)/.test(ogType)) return make('video', 0.8);

  // Counts.
  if (s.cues.results && s.fields.search > 0) return make('search', 0.75);
  if (s.cues.signIn || (s.fields.password > 0 && s.fields.personal <= 2)) return make('login', 0.8);
  if (s.cues.addToCart && s.prices > 0) return make('product', 0.7);
  if (ogType === 'article' || (s.text.paragraphs >= 5 && s.text.words >= 350)) return make('article', ogType === 'article' ? 0.85 : 0.6);
  if (s.video.present && (s.video.duration ?? 0) > 30) return make('video', 0.6);
  if (s.fields.personal >= 2 || s.fields.total - s.fields.search >= 4) return make('form', 0.6);
  if (s.cues.results) return make('search', 0.55);
  return page;
}
