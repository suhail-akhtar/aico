/**
 * The main-process half of page understanding: the page script reports raw
 * facts (browser-page.ts); these pure functions turn them into what the agent
 * and the copilot read — prices, contacts, tables as Markdown, the snapshot
 * text, the form model with sensitive fields marked, and the page insights.
 *
 * @module desktop/electron/browser-extract
 */

import type { FormField, FormModel, PageInsights, SecurityState, SensitiveKind } from '../shared/browser-types';
import { classifySensitiveField, detectHumanCheck, type FieldDescriptor, type HumanCheckSignals } from './browser-safety';

// ── Prices ──

export interface Price { amount: number; currency: string; text: string; context?: string; source: string }

const SYMBOLS: Record<string, string> = {
  $: 'USD', '€': 'EUR', '£': 'GBP', '¥': 'JPY', '₹': 'INR', '₨': 'PKR', '₩': 'KRW', '₪': 'ILS', '₫': 'VND', '₱': 'PHP',
  '₦': 'NGN', '₴': 'UAH', '₺': 'TRY', '฿': 'THB', '₽': 'RUB',
};
const CODES = 'USD|EUR|GBP|JPY|INR|PKR|AED|SAR|CAD|AUD|CHF|CNY|RMB|SEK|NOK|DKK|PLN|TRY|BRL|MXN|ZAR|SGD|HKD|NZD|KRW|QAR|KWD|EGP|NGN|KES|BDT|LKR|IDR|MYR|THB|PHP|VND|RUB|UAH|ILS|CZK|HUF|RON';
const WORDS: Record<string, string> = { rs: 'PKR', 'rs.': 'PKR', rp: 'IDR', rm: 'MYR', kr: 'SEK', 'zł': 'PLN', 'us$': 'USD', 'c$': 'CAD', 'a$': 'AUD', 'ca$': 'CAD', 'au$': 'AUD', 'hk$': 'HKD', 's$': 'SGD', 'nz$': 'NZD', 'r$': 'BRL' };

const NUM = String.raw`\d{1,3}(?:[,.\s  ]\d{3})*(?:[.,]\d{1,2})?|\d+(?:[.,]\d{1,2})?`;
const PREFIX = new RegExp(String.raw`(US\$|CA\$|AU\$|HK\$|NZ\$|C\$|A\$|S\$|R\$|[$€£¥₹₨₩₪₫₱₦₴₺฿₽]|\b(?:${CODES})\b|\bRs\.?|\bRp|\bRM)\s?(${NUM})`, 'gi');
const SUFFIX = new RegExp(String.raw`(${NUM})\s?([€£¥₹₽₺₴]|\b(?:${CODES})\b|\bkr\b|zł)`, 'gi');

/** Parse "1,299.99" / "1.299,99" / "1 299" into a number. */
export function parseAmount(s: string): number {
  let t = s.replace(/[\s  ]/g, '');
  const hasComma = t.includes(','); const hasDot = t.includes('.');
  if (hasComma && hasDot) {
    // Whichever comes last is the decimal mark: "1,299.99" / "1.299,99".
    t = t.lastIndexOf(',') > t.lastIndexOf('.') ? t.replace(/\./g, '').replace(',', '.') : t.replace(/,/g, '');
  } else if (hasComma) {
    // "12,50" is a decimal comma; "1,299" and "1,299,000" are thousands.
    t = /^\d+,\d{1,2}$/.test(t) ? t.replace(',', '.') : t.replace(/,/g, '');
  } else if (hasDot) {
    // "1.299" and "1.299.000" are thousands (prices do not have three decimals); "12.5" is a decimal.
    if (/^\d{1,3}(\.\d{3})+$/.test(t)) t = t.replace(/\./g, '');
  }
  const n = Number(t);
  return Number.isFinite(n) ? n : NaN;
}

const currencyOf = (sym: string): string => {
  const k = sym.trim();
  return SYMBOLS[k] ?? WORDS[k.toLowerCase()] ?? k.toUpperCase();
};

/** Currency amounts in short text blocks, with their context (the product or heading near them). */
export function findPrices(blocks: Array<{ text: string; context?: string }>, structured: Array<{ amount: string; currency: string; context?: string; source: string }> = []): Price[] {
  const out: Price[] = [];
  const seen = new Set<string>();
  const push = (p: Price): void => {
    const key = `${p.currency}|${p.amount}|${p.context ?? ''}`;
    if (seen.has(key) || !Number.isFinite(p.amount)) return;
    seen.add(key);
    out.push(p);
  };
  for (const s of structured) {
    const amount = parseAmount(String(s.amount).replace(/[^\d.,\s]/g, ''));
    push({ amount, currency: (s.currency || '').toUpperCase(), text: `${s.currency} ${s.amount}`.trim(), context: s.context || undefined, source: s.source });
  }
  for (const b of blocks) {
    for (const re of [PREFIX, SUFFIX]) {
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(b.text))) {
        const [sym, num] = re === PREFIX ? [m[1]!, m[2]!] : [m[2]!, m[1]!];
        push({ amount: parseAmount(num), currency: currencyOf(sym), text: m[0].trim(), context: b.context || (b.text.length <= 120 ? b.text : undefined), source: 'text' });
      }
    }
    if (out.length >= 300) break;
  }
  return out;
}

// ── Contacts ──

export function findContacts(text: string, links: Array<{ href: string; text: string }>): { emails: string[]; phones: string[]; links: Array<{ kind: string; value: string; text: string }> } {
  const emails = new Set<string>();
  const phones = new Set<string>();
  const out: Array<{ kind: string; value: string; text: string }> = [];
  for (const l of links) {
    const m = /^(mailto|tel|sms|whatsapp):(.*)$/i.exec(l.href);
    if (!m) continue;
    const kind = m[1]!.toLowerCase();
    let value = decodeURIComponent(m[2]!.split('?')[0] ?? '').trim();
    if (kind === 'mailto') { value = value.toLowerCase(); if (value) emails.add(value); }
    if (kind === 'tel' || kind === 'sms') { if (value) phones.add(value.replace(/[^\d+]/g, '')); }
    out.push({ kind, value, text: l.text });
  }
  for (const m of text.matchAll(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,24}\b/g)) {
    const e = m[0].toLowerCase();
    if (!/\.(png|jpe?g|gif|webp|svg)$/.test(e)) emails.add(e);
    if (emails.size > 200) break;
  }
  // Phone numbers: international (+CC …) or grouped national forms; at least 9 digits, and not a date or a long id.
  for (const m of text.matchAll(/(?:\+\d{1,3}[\s.-]?)?(?:\(\d{1,4}\)[\s.-]?)?\d{2,4}(?:[\s.-]\d{2,4}){1,4}/g)) {
    const raw = m[0].trim();
    const digits = raw.replace(/\D/g, '');
    if (digits.length < 9 || digits.length > 15) continue;
    if (/^\d{4}[-./]\d{2}[-./]\d{2}$/.test(raw) || /^\d{2}[-./]\d{2}[-./]\d{4}$/.test(raw)) continue;
    if (!raw.startsWith('+') && !/[\s.-]/.test(raw) && !raw.includes('(')) continue;
    phones.add(raw.startsWith('+') ? `+${digits}` : raw);
    if (phones.size > 100) break;
  }
  return { emails: [...emails], phones: [...phones], links: out };
}

// ── Tables ──

export function tableToMarkdown(t: { caption?: string; rows: string[][] }): string {
  if (!t.rows.length) return '';
  const width = Math.max(...t.rows.map(r => r.length));
  const esc = (s: string): string => s.replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();
  const line = (r: string[]): string => `| ${Array.from({ length: width }, (_, i) => esc(r[i] ?? '')).join(' | ')} |`;
  return [t.caption ? `**${t.caption}**\n` : '', line(t.rows[0]!), `|${' --- |'.repeat(width)}`, ...t.rows.slice(1).map(line)].filter(Boolean).join('\n');
}

// ── Snapshot text ──

export interface SnapshotElement {
  ref: string; role: string; name: string; value?: string; checked?: boolean; disabled?: boolean;
  href?: string; offscreen?: boolean; frame?: boolean; field?: FieldDescriptor;
}
export interface SnapshotRaw {
  title: string; url: string; scroll: { y: number; height: number; viewport: number };
  headings: string[]; elements: SnapshotElement[]; total: number; crossOriginFrames: Array<{ src: string; title: string }>;
  dialogs: string[]; text: string; truncated: boolean;
}

export function formatSnapshot(s: SnapshotRaw, extras: { humanCheck?: string; jsDialog?: string } = {}): string {
  const lines = s.elements.map((e) => {
    const sens = e.field ? classifySensitiveField(e.field) : null;
    const role = sens ? `${e.role} [${sens.kind} — user only]` : e.role;
    let line = `[${e.ref}] ${role} "${e.name.replace(/"/g, '\'')}"`;
    if (e.value !== undefined && !sens) line += ` value="${e.value}"`;
    if (e.value !== undefined && sens) line += e.value ? ' (filled)' : ' (empty)';
    if (e.checked !== undefined) line += e.checked ? ' checked' : ' unchecked';
    if (e.disabled) line += ' disabled';
    if (e.href) line += ` -> ${e.href}`;
    if (e.frame) line += ' (in frame)';
    if (e.offscreen) line += ' (offscreen)';
    return line;
  });
  const more = s.total > s.elements.length ? `\n…${s.total - s.elements.length} more — use browser_snapshot full:true, browser_find, or scroll.` : '';
  return [
    extras.humanCheck ? `⚠ ${extras.humanCheck}` : '',
    extras.jsDialog ? `⚠ ${extras.jsDialog}` : '',
    `Page: ${s.title || '(untitled)'}`,
    `URL: ${s.url}`,
    `Scroll: ${s.scroll.y}/${Math.max(0, s.scroll.height - s.scroll.viewport)}px`,
    s.dialogs.length ? `Open dialogs: ${s.dialogs.join(' | ')}` : '',
    s.headings.length ? `Headings:\n${s.headings.join('\n')}` : '',
    `Interactive elements (use the [ref] with browser_click / browser_type / browser_fill):\n${lines.join('\n') || '(none visible)'}${more}`,
    s.crossOriginFrames.length ? `Cross-origin frames (not readable from here): ${s.crossOriginFrames.map(f => f.title || f.src.slice(0, 100)).join(' | ')}` : '',
    `Visible text${s.truncated ? ' (truncated — use browser_read or scroll)' : ''}:\n${s.text}`,
  ].filter(Boolean).join('\n\n');
}

// ── Forms ──

type RawField = FormField & { raw?: FieldDescriptor };
type RawForm = Omit<FormModel, 'fields'> & { fields: RawField[] };

/** Mark sensitive fields and never pass their values on. */
export function finishForms(raw: RawForm[]): FormModel[] {
  return raw.map(f => ({
    ...f,
    fields: f.fields.map(({ raw: d, ...field }) => {
      const s = d ? classifySensitiveField(d) : null;
      if (!s) return field;
      return { ...field, sensitive: s.kind as SensitiveKind, value: field.value ? '(filled)' : '' };
    }),
  }));
}

/** Find a field by what the agent called it: its ref, name, or label (exact, then partial). */
export function matchField(forms: FormModel[], want: { ref?: string; label?: string; name?: string }): FormField | null {
  const fields = forms.flatMap(f => f.fields);
  if (want.ref) {
    const byRef = fields.find(f => f.ref === want.ref || f.options?.some(o => (o as { ref?: string }).ref === want.ref));
    if (byRef) return byRef;
  }
  const norm = (s: string | undefined): string => (s ?? '').toLowerCase().replace(/[*:]/g, '').replace(/\s+/g, ' ').trim();
  if (want.name) {
    const n = norm(want.name);
    const byName = fields.find(f => norm(f.name) === n);
    if (byName) return byName;
  }
  const l = norm(want.label ?? want.name);
  if (!l) return null;
  return fields.find(f => norm(f.label) === l)
    ?? fields.find(f => norm(f.placeholder) === l)
    ?? fields.find(f => norm(f.label).startsWith(l) || l.startsWith(norm(f.label)) && norm(f.label).length > 2)
    ?? fields.find(f => norm(f.label).includes(l) || norm(f.name).includes(l.replace(/ /g, '')))
    ?? null;
}

// ── Insights ──

export interface InsightSignals {
  url: string; title: string; contentType: string; words: number; textStart: string;
  counts: { forms: number; passwords: number; inputs: number; search: number; links: number; images: number; videos: number; tables: number; articles: number };
  h1: string[]; ogType: string; jsonLdTypes: string[]; isAccessibleForFree: boolean | null;
  cartButton: string; cookieBanner: boolean; paywallElement: boolean;
  buttons: Array<{ label: string; area: number; top: number; cls: string; tag: string }>;
  human: HumanCheckSignals;
}

const CTA = /^(sign up|get started|start (free|now|trial)|try (it )?(free|now)|buy( now)?|add to (cart|bag|basket)|checkout|subscribe|download|book( now)?|order( now)?|contact( us)?|request (a )?demo|join|register|continue|next|submit|apply( now)?|install|shop now|learn more|search)\b/i;

export function buildInsights(s: InsightSignals, extra: { security: SecurityState; trackersBlocked: number; httpStatus?: number }): PageInsights {
  const text = s.textStart.toLowerCase();
  const human = detectHumanCheck(s.human);
  const loginWall = s.counts.passwords > 0 && s.words < 600
    || /\b(sign|log) ?in to (continue|view|see|read|access)|you must be (logged|signed) in|please (log|sign) ?in to|create an account to (continue|view)/.test(text);
  const paywall = s.isAccessibleForFree === false || s.paywallElement
    || /subscribe (now )?to (continue|keep) reading|to continue reading,? (subscribe|sign in|log in)|you('ve| have) reached your (free )?(article |monthly )?limit|already a subscriber\?|this (article|content) is (for|available to) (subscribers|members) only/.test(text);
  const types = s.jsonLdTypes.join(' ').toLowerCase();
  const og = s.ogType.toLowerCase();
  let kind = 'page';
  if (extra.httpStatus && extra.httpStatus >= 400) kind = 'error';
  else if (/pdf/.test(s.contentType)) kind = 'pdf';
  else if (human.detected) kind = 'challenge';
  else if (/product|offer/.test(types) || og === 'product' || s.cartButton) kind = 'product';
  else if (/checkout|payment|billing/.test(s.title.toLowerCase()) || /\b(checkout|payment details|billing address|place (your )?order)\b/.test(text.slice(0, 1500))) kind = 'checkout';
  else if (s.counts.passwords > 0 && s.counts.inputs <= 4) kind = 'login';
  else if (/newsarticle|article|blogposting|report/.test(types) || og === 'article' || (s.counts.articles === 1 && s.words > 400)) kind = 'article';
  else if (/searchresultspage/.test(types) || /[?&](q|query|search|s|k)=/.test(s.url)) kind = 'search-results';
  else if (/videoobject/.test(types) || og.startsWith('video') || s.counts.videos > 0 && s.words < 800) kind = 'video';
  else if (/docs?\.|developer\.|\/docs?\//.test(s.url) || /techarticle|apireference/.test(types)) kind = 'docs';
  else if (s.counts.inputs >= 4 && s.counts.forms > 0) kind = 'form';
  else if (s.counts.articles > 3 || s.counts.links > 150) kind = 'listing';
  else if (/^https?:\/\/[^/]+\/?$/.test(s.url)) kind = 'home';
  if (/^(404|not found|page not found|error)/i.test(s.title) && s.words < 400) kind = 'error';

  const cands = s.buttons.filter(b => CTA.test(b.label) || /primary|cta|btn-main|button--primary/i.test(b.cls));
  const main = (cands.length ? cands : []).sort((a, b) => (b.area - a.area) || (a.top - b.top))[0];

  const hints: string[] = [];
  if (human.detected) hints.push(`Human check on the page (${human.kind}) — hand it to the user with browser_handoff; do not attempt it.`);
  if (loginWall) hints.push('Sign-in required — ask the user to sign in (browser_handoff); never type a password.');
  if (paywall) hints.push('Paywall detected — the full text may not be available.');
  if (s.cookieBanner) hints.push('Cookie banner is showing — prefer "Reject" / "Necessary only" if you must dismiss it.');
  if (kind === 'article') hints.push(`Article, about ${s.words} words${s.h1[0] ? `: "${s.h1[0]}"` : ''} — browser_read gives it as Markdown.`);
  if (kind === 'product') hints.push(`Product page${s.cartButton ? ` (button: "${s.cartButton}")` : ''} — browser_extract kind:"prices" lists prices.`);
  if (kind === 'checkout') hints.push('Checkout / payment page — payment details are the user\'s; confirm with the user before placing any order.');
  if (kind === 'search-results') hints.push('Search results — browser_extract kind:"links" lists them.');
  if (s.counts.forms > 0) hints.push(`${s.counts.forms} form(s), ${s.counts.inputs} visible field(s)${s.counts.passwords ? `, ${s.counts.passwords} password field(s)` : ''} — browser_forms describes them.`);
  if (s.counts.tables > 0) hints.push(`${s.counts.tables} table(s) — browser_extract kind:"tables".`);
  if (extra.security === 'insecure') hints.push('Not a secure connection (http) — do not enter personal data.');
  if (extra.security === 'error') hints.push('Certificate error — the page is not trusted.');
  if (extra.trackersBlocked > 0) hints.push(`${extra.trackersBlocked} tracker request(s) blocked.`);

  return {
    url: s.url, title: s.title, kind, summaryHints: hints, ...(main ? { mainAction: main.label } : {}),
    forms: s.counts.forms, loginWall, paywall, cookieBanner: s.cookieBanner, humanCheck: human.detected,
    security: extra.security, trackersBlocked: extra.trackersBlocked,
  };
}
