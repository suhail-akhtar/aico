/**
 * What kind of page this is, and what AICO could do for you on it.
 *
 * `classifyPage` reads the facts a page publishes about itself (schema.org
 * JSON-LD and microdata, OpenGraph — see shared/page-signals.ts) plus a few
 * cheap counts, and names the page: a product, an article, a recipe, a job,
 * an event, a video, search results, a cart or checkout, a sign-in page, a
 * form, docs or code, a mail or chat app. `suggestionsFor` turns that into
 * the copilot's chips — "Compare prices" on a product, "Fact-check" on an
 * article, "Draft a reply" in a mail app.
 *
 * Structured data wins over heuristics (a site that says it is a Product is
 * one); the host names a few well-known apps; counts decide the rest. Pure,
 * so it is unit-tested with real-looking JSON-LD.
 *
 * The chips keep the agent's safety rules: nothing is bought, sent or
 * submitted without asking, and a checkout gets "Review this order before I
 * pay" — never "pay".
 *
 * @module desktop/renderer/browser/suggest
 */

import type { PageSignals } from '@desk/page-signals';
import { SAFETY_RULES, type QuickAction } from './context';

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

// ── Chips ──

const chip = (id: string, label: string, icon: string, prompt: string): QuickAction => ({ id: `sg-${id}`, label, icon, needsPage: true, prompt });

const READ = 'Read the page first with browser_read (reader mode; fall back to browser_text).';

const CHIPS: Record<PageKind, QuickAction[]> = {
  product: [
    chip('compare-prices', 'Compare prices', 'tag', `Find this exact product at other reputable shops and compare prices. ${READ} Note the product name, model/variant and price here, then search for it and open 3–5 other listings in new tabs with browser_open. Give a table of shop, price, shipping, stock and link, and say which is the best deal. Do not add anything to a cart or buy anything.`),
    chip('reviews', 'Summarize reviews', 'thumbs-up', `Summarize what buyers say about this product. ${READ} Scroll to or open the reviews (browser_find "reviews", browser_scroll). Give the overall rating, the top 3 praises and top 3 complaints with how often they come up, and who it suits or does not.`),
    chip('deal', 'Is this a good deal?', 'sparkles', `Is this a good deal? ${READ} Look at the price, any discount or "was" price, the specs and the reviews, and compare with 2–3 similar products or the same product elsewhere (open them in new tabs). Answer yes / wait / no with the reasons in a few bullets. Do not buy anything.`),
    chip('specs', 'Key specs', 'list', `List the key specifications of this product as a short table, then 3 bullets on what matters most for a buyer. ${READ}`),
  ],
  article: [
    chip('summarize', 'Summarize', 'file-text', `Summarize this article. ${READ} A one-line gist, a short summary under headings, then 3–6 key takeaways. End with a "Source:" line.`),
    chip('keypoints', 'Key points', 'list', `The key points of this article as 5–8 tight bullets, most important first, quoting numbers and names exactly. ${READ}`),
    chip('factcheck', 'Fact-check', 'shield-check', `Fact-check the main claims of this article. ${READ} Pick the 3–5 most important factual claims, check each against at least one other reliable source (open them in new tabs), and give a table of claim, verdict (supported / disputed / unverified) and source. Be fair and precise.`),
    chip('explain', 'Explain simply', 'sparkles', `Explain this article in plain language for a newcomer, defining any jargon in one line each. ${READ} Under 250 words.`),
  ],
  recipe: [
    chip('ingredients', 'Ingredients list', 'list', `Give the ingredients of this recipe as a shopping list grouped by aisle (produce, dairy, pantry…), with quantities. ${READ}`),
    chip('scale', 'Scale to 2 servings', 'calculator', `Scale this recipe to 2 servings. ${READ} Give the adjusted ingredient list with sensible units, and note any step whose timing or pan size changes.`),
    chip('steps', 'Steps only', 'check', `Give just the method of this recipe as short numbered steps with times and temperatures, no story. ${READ}`),
    chip('swap', 'Substitutions', 'refresh', `Suggest substitutions for the harder-to-find or allergen ingredients in this recipe (dairy-free, gluten-free, vegetarian where it makes sense). ${READ}`),
  ],
  job: [
    chip('match', 'Match to my skills', 'user', `How well do I match this job? ${READ} List the must-have and nice-to-have requirements, then ask me for my CV or background if you do not know it, and rate the fit with the gaps to address.`),
    chip('cover', 'Draft a cover letter', 'edit', `Draft a tailored cover letter for this job. ${READ} Ask me for my background first if you do not know it. Keep it under 300 words, specific to the role's requirements. Do not submit or apply for anything.`),
    chip('interview', 'Likely interview questions', 'help', `List 8 likely interview questions for this role with a one-line tip for each, based on the posting. ${READ}`),
  ],
  event: [
    chip('details', 'Event details', 'calendar', `Give this event's essentials: what, when (with time zone), where, price and how to get tickets, as a short list. ${READ} Do not buy or book anything.`),
    chip('calendar', 'Add-to-calendar text', 'calendar', `Write a calendar entry for this event — title, start and end, location, and a two-line description — ready to paste. ${READ}`),
  ],
  video: [
    chip('moments', 'Key moments', 'play', `List the key moments of this video with timestamps. ${READ} Use the description, chapters and transcript if the page shows them; if there is no transcript, say what you could and could not see.`),
    chip('summary', 'Summarize video', 'file-text', `Summarize this video from its title, description, chapters and any transcript on the page. ${READ} Say clearly if you could not see the transcript.`),
  ],
  search: [
    chip('best', 'Best results', 'search', `Which of these search results are the most useful and trustworthy for this query? ${READ} Rank the top 5 with one line each on why, and flag ads or low-quality sites.`),
    chip('answer', 'Answer from the top results', 'sparkles', `Answer the search query from the top results: open the 3 best in new tabs, read them, and give a sourced answer.`),
  ],
  cart: [
    chip('review-cart', 'Review my cart', 'box', `Review the items in this cart. ${READ} Give a table of item, quantity, price and line total, the subtotal, and point out duplicates, anything unusual, and cheaper options if obvious. Do not change the cart or check out.`),
    chip('coupons', 'Find a better deal', 'tag', `Check whether these items are cheaper elsewhere or whether a well-known discount applies. ${READ} Report what you find; do not change the cart or buy anything.`),
  ],
  checkout: [
    chip('review-order', 'Review this order before I pay', 'shield-check', `Review this order before I pay. ${READ} List the items, quantities, prices, shipping method and cost, taxes, the total, the delivery address, and any add-ons, subscriptions or pre-ticked boxes I might not want. Point out anything that looks wrong. Do NOT click Pay, Place order or anything that completes the purchase — I will do that myself. ${SAFETY_RULES}`),
    chip('fill-shipping', 'Fill shipping with my profile', 'key', `Fill the shipping / contact fields on this page from my saved autofill profile: call browser_autofill (it never touches card, CVV or password fields). Then show me what was filled. Do NOT place the order or enter any payment details. ${SAFETY_RULES}`),
  ],
  login: [
    chip('signin-help', 'Help me sign in', 'key', `I want to sign in here. Tell me what the page asks for. Do not type my password or any code — hand the page to me with browser_handoff for those. ${SAFETY_RULES}`),
  ],
  form: [
    chip('fill-profile', 'Fill this form with my profile', 'key', `Fill this form with my profile: call browser_autofill first (it fills name, email, phone, company and address fields from my saved autofill profile and never touches passwords, card numbers, CVVs or one-time codes). Then call browser_forms to see what is left, fill what you can from our conversation with browser_fill, and ask me for the rest. Do NOT submit — show me what was filled and wait. ${SAFETY_RULES}`),
    chip('explain-form', 'What does this form need?', 'help', `What does this form ask for? Call browser_forms and list the required and optional fields in plain words, with anything unusual I should know before filling it.`),
  ],
  docs: [
    chip('explain-doc', 'Explain this page', 'book', `Explain this documentation page: what it covers, the key API or steps, and a minimal example. ${READ}`),
    chip('example', 'Show an example', 'code', `Give a short, runnable example of what this documentation page describes, with comments. ${READ}`),
  ],
  code: [
    chip('repo', 'What is this repo?', 'github', `What is this repository or file for? ${READ} Give its purpose, main parts, how to run or use it, and how active it looks.`),
    chip('explain-code', 'Explain the code', 'code', `Explain the code shown on this page, section by section, and point out anything surprising. ${READ}`),
  ],
  qa: [
    chip('best-answer', 'Best answer', 'check-circle', `What is the best answer to this question? ${READ} Weigh the accepted and top-voted answers, note if they are outdated, and give the answer with a minimal example.`),
  ],
  email: [
    chip('reply', 'Draft a reply', 'mail', `Draft a reply to the open email or conversation. Read it with browser_read (or browser_text). Ask me for the gist if it is not obvious, keep my tone, and put the draft in the chat — do NOT type it into the page or send anything unless I say so.`),
    chip('summarize-mail', 'Summarize this thread', 'file-text', `Summarize the open email thread: who wants what, decisions, dates and action items for me. Read it with browser_read or browser_text.`),
    chip('todo', 'Action items', 'check', `List the action items and deadlines for me in the open email or inbox view. Read it with browser_text.`),
  ],
  chat: [
    chip('reply-chat', 'Draft a reply', 'chat', `Draft a reply to the open conversation. Read it with browser_text. Keep my tone and put the draft in the chat — do NOT type it into the page or send anything unless I say so.`),
    chip('catch-up', 'Catch me up', 'history', `Catch me up on the open conversation: the main points, questions for me and decisions, briefly. Read it with browser_text.`),
  ],
  page: [],
};

/** The chips for a page kind (at most `max`), best first. Empty for a plain page — the copilot's own actions stand. */
export function suggestionsFor(c: PageClass, max = 4): QuickAction[] {
  return (CHIPS[c.kind] ?? []).slice(0, max);
}

/** Is the form chip worth adding to another kind (a checkout already has its own)? */
export function wantsAutofill(s: PageSignals | null | undefined, c: PageClass): boolean {
  return Boolean(s && s.fields.personal >= 2 && c.kind !== 'form' && c.kind !== 'checkout' && c.kind !== 'login');
}

/** Everything the copilot shows for a page: the kind and its chips, plus "Fill with my profile" wherever a personal form is. */
export function pageSuggestions(s: PageSignals | null | undefined, max = 4): { page: PageClass; chips: QuickAction[] } {
  const page = classifyPage(s);
  const autofill = wantsAutofill(s, page);
  const chips = suggestionsFor(page, autofill ? max - 1 : max);
  if (autofill) chips.push(CHIPS.form[0]!);
  return { page, chips };
}

/** Every suggestion chip there is (so a sent chip can be shown by its label in the conversation). */
export const ALL_SUGGESTIONS: QuickAction[] = Object.values(CHIPS).flat();

/** The copilot's own action each chip stands in for, so the list never offers the same thing twice. */
const COVERS: Record<string, string> = {
  'sg-summarize': 'summarize', 'sg-summary': 'summarize', 'sg-summarize-mail': 'summarize', 'sg-keypoints': 'keypoints',
  'sg-explain': 'explain', 'sg-explain-doc': 'explain', 'sg-explain-code': 'explain', 'sg-fill-profile': 'form', 'sg-fill-shipping': 'form',
  'sg-compare-prices': 'prices', 'sg-deal': 'prices', 'sg-review-cart': 'prices',
};

/** The page's chips first, then the copilot's own actions they do not already cover. */
export function mergeActions(chips: QuickAction[], base: QuickAction[], max = 12): QuickAction[] {
  const covered = new Set(chips.map(c => COVERS[c.id]).filter(Boolean));
  return [...chips, ...base.filter(b => !covered.has(b.id))].slice(0, max);
}
