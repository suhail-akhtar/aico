/**
 * What a page says about itself — the raw facts the copilot's suggestions are
 * chosen from. Collected in the page by `PAGE_SIGNALS_JS` (run by main through
 * `browser:pageSignals`), classified in the renderer by `browser/suggest.ts`.
 *
 * The facts are the ones sites publish for machines anyway — schema.org
 * JSON-LD and microdata, OpenGraph — plus a few cheap counts (form fields by
 * kind, paragraphs, a video element, "place order" buttons). Nothing leaves
 * the machine: the classification is local, and the page itself is only read
 * by the agent when the person asks for something.
 *
 * @module desktop/shared/page-signals
 */

export interface LdItem {
  /** schema.org types, e.g. ["Product"], ["NewsArticle"]. */
  type: string[];
  name?: string;
  /** Product: the offer's price and currency; Event/Job: dates. */
  price?: string;
  currency?: string;
  rating?: number;
  reviews?: number;
  date?: string;
  org?: string;
  yield?: string;
}

export interface PageSignals {
  url: string;
  title: string;
  /** Items from JSON-LD (including @graph), capped. */
  ld: LdItem[];
  /** Microdata itemtypes, last path segment ("Product", "Recipe"). */
  microdata: string[];
  og: { type?: string; siteName?: string; price?: string; currency?: string };
  fields: {
    total: number;
    /** Fields a person fills with their own details (name, email, phone, address, company). */
    personal: number;
    address: number;
    email: number;
    password: number;
    card: number;
    search: number;
    textarea: number;
  };
  /** A focused or visible rich-text editor (compose boxes of mail and chat apps). */
  editor: boolean;
  video: { present: boolean; duration?: number };
  text: { paragraphs: number; words: number; article: boolean };
  /** Words on buttons and headings. */
  cues: { addToCart: boolean; checkout: boolean; placeOrder: boolean; cart: boolean; signIn: boolean; results: boolean };
  prices: number;
}

/**
 * The collector, as source evaluated in the page (main world, read-only).
 * Self-contained; returns a PageSignals object.
 */
export const PAGE_SIGNALS_JS = String.raw`(() => {
  const d = document;
  const low = (s) => String(s == null ? '' : s).toLowerCase();
  const visible = (el) => { try { const r = el.getBoundingClientRect(); if (r.width < 2 || r.height < 2) return false; const s = getComputedStyle(el); return s.visibility !== 'hidden' && s.display !== 'none'; } catch (e) { return false; } };
  const typesOf = (t) => (Array.isArray(t) ? t : t ? [t] : []).map(x => String(x).replace(/^https?:\/\/schema\.org\//i, ''));
  const ld = [];
  const walk = (o, depth) => {
    if (!o || typeof o !== 'object' || depth > 4 || ld.length >= 20) return;
    if (Array.isArray(o)) { for (const x of o) walk(x, depth + 1); return; }
    if (o['@graph']) walk(o['@graph'], depth + 1);
    const type = typesOf(o['@type']);
    if (type.length) {
      const offer = Array.isArray(o.offers) ? o.offers[0] : o.offers;
      const agg = o.aggregateRating || {};
      const org0 = o.hiringOrganization || o.organizer || o.publisher || o.author;
      const org1 = Array.isArray(org0) ? org0[0] : org0;
      const org = typeof org1 === 'string' ? org1 : org1 && org1.name ? org1.name : '';
      ld.push({
        type, name: String(o.name || o.headline || o.title || '').slice(0, 200) || undefined,
        price: offer ? String(offer.price ?? offer.lowPrice ?? '').slice(0, 40) || undefined : undefined,
        currency: offer ? String(offer.priceCurrency || '').slice(0, 8) || undefined : undefined,
        rating: agg.ratingValue !== undefined ? Number(agg.ratingValue) : undefined,
        reviews: agg.reviewCount !== undefined ? Number(agg.reviewCount) : agg.ratingCount !== undefined ? Number(agg.ratingCount) : undefined,
        date: String(o.startDate || o.datePosted || o.datePublished || '').slice(0, 40) || undefined,
        org: org ? String(org).slice(0, 120) : undefined,
        yield: o.recipeYield ? String(Array.isArray(o.recipeYield) ? o.recipeYield[0] : o.recipeYield).slice(0, 40) : undefined,
      });
    }
    if (o.mainEntity) walk(o.mainEntity, depth + 1);
    if (o.itemListElement && depth < 2) walk(o.itemListElement, depth + 1);
  };
  for (const s of d.querySelectorAll('script[type="application/ld+json"]')) {
    try { walk(JSON.parse(s.textContent || ''), 0); } catch (e) { /* a broken block is skipped */ }
  }
  const microdata = [...new Set([...d.querySelectorAll('[itemtype]')].slice(0, 200).flatMap(el => low(el.getAttribute('itemtype')).split(/\s+/).map(t => t.split('/').pop()).filter(Boolean)))].slice(0, 20);
  const meta = (p) => { const m = d.querySelector('meta[property="' + p + '"], meta[name="' + p + '"]'); return m ? m.getAttribute('content') || undefined : undefined; };
  const og = { type: meta('og:type'), siteName: meta('og:site_name'), price: meta('product:price:amount') || meta('og:price:amount'), currency: meta('product:price:currency') || meta('og:price:currency') };

  const fields = { total: 0, personal: 0, address: 0, email: 0, password: 0, card: 0, search: 0, textarea: 0 };
  for (const el of d.querySelectorAll('input, select, textarea')) {
    if (fields.total > 400) break;
    const type = low(el.getAttribute('type') || (el.tagName === 'SELECT' ? 'select' : el.tagName === 'TEXTAREA' ? 'textarea' : 'text'));
    if (['hidden', 'submit', 'button', 'reset', 'image'].includes(type) || el.disabled || !visible(el)) continue;
    fields.total++;
    const ac = low(el.getAttribute('autocomplete'));
    const hay = low([el.name, el.id, el.getAttribute('placeholder'), el.getAttribute('aria-label'), el.labels && el.labels[0] ? el.labels[0].textContent : ''].join(' '));
    if (type === 'password' || /password/.test(ac)) { fields.password++; continue; }
    if (/cc-|card.?num|cvv|cvc/.test(ac + ' ' + hay)) { fields.card++; continue; }
    if (type === 'search' || /(^|\s)(q|query|search)(\s|$)/.test(hay) || el.getAttribute('role') === 'searchbox') { fields.search++; continue; }
    if (type === 'textarea') fields.textarea++;
    if (type === 'email' || /email/.test(ac + ' ' + hay)) fields.email++;
    if (/street|address|postal|zip|postcode|city|town|country|region|province|state/.test(ac + ' ' + hay)) fields.address++;
    if (/name|email|tel|phone|mobile|street|address|postal|zip|city|country|organi[sz]ation|company/.test(ac + ' ' + hay)) fields.personal++;
  }
  const editor = [...d.querySelectorAll('[contenteditable="true"], [contenteditable=""], [role="textbox"]')].slice(0, 20).some(visible);

  const videos = [...d.querySelectorAll('video')].filter(v => visible(v) && v.getBoundingClientRect().width > 200);
  const video = { present: videos.length > 0, duration: videos[0] && isFinite(videos[0].duration) ? Math.round(videos[0].duration) : undefined };

  const main = d.querySelector('article, main, [role="main"]') || d.body;
  const paras = main ? [...main.querySelectorAll('p')].filter(p => (p.textContent || '').trim().length > 80) : [];
  const words = paras.reduce((n, p) => n + (p.textContent || '').trim().split(/\s+/).length, 0);
  const text = { paragraphs: paras.length, words, article: Boolean(d.querySelector('article')) };

  const buttons = [...d.querySelectorAll('button, [role="button"], input[type="submit"], a')].slice(0, 1500).map(b => low(b.textContent || b.value || b.getAttribute('aria-label')).trim()).filter(t => t && t.length < 60);
  const heads = [...d.querySelectorAll('h1, h2, h3')].slice(0, 60).map(h => low(h.textContent).trim());
  const anyB = (re) => buttons.some(t => re.test(t));
  const anyH = (re) => heads.some(t => re.test(t));
  const path = low(location.pathname + ' ' + location.search);
  const cues = {
    addToCart: anyB(/^(add to (cart|bag|basket|trolley)|buy now|add to shopping)/),
    checkout: /checkout|\/payment|\/pay\b/.test(path) || anyH(/^(checkout|payment|shipping (address|method)|review (your )?order|order summary)/),
    placeOrder: anyB(/^(place (your )?order|pay now|complete (purchase|order)|confirm (and pay|order|purchase)|buy now and pay|submit order)/),
    cart: /\/(cart|basket|bag)(\/|$|\?)/.test(path) || anyH(/^(shopping (cart|bag|basket)|your (cart|bag|basket))/),
    signIn: fields.password > 0 && fields.total <= 6,
    results: /[?&](q|query|search|k|keywords?)=/.test(location.search) || /\/search\b/.test(location.pathname),
  };
  const prices = (String(main ? main.innerText || '' : '').slice(0, 200000).match(/(?:[$€£¥₹]\s?\d[\d,.]*|\d[\d,.]*\s?(?:USD|EUR|GBP|INR))/g) || []).length;
  return { url: location.href, title: d.title, ld, microdata, og, fields, editor, video, text, cues, prices };
})()`;
