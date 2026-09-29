/**
 * Autofill — the person's own details (name, email, phone, company,
 * addresses), kept on this machine, filled into a form in one go.
 *
 * WHAT IT NEVER DOES. Passwords, card numbers, expiry dates, CVVs and
 * one-time codes are never stored here and never filled: every field is first
 * put through browser-safety.ts's `classifySensitiveField` (the same verdict
 * the agent's typing tools obey), and the in-page filler refuses those fields
 * again on the live element. Search boxes, hidden fields and anything already
 * filled are left alone.
 *
 * HOW A FIELD IS MATCHED. Its `autocomplete` attribute first (the standard
 * tokens, with shipping/billing sections), then the words of its name, id,
 * label, placeholder and aria-label. This module is pure and tested; the
 * in-page halves (collect, apply) are the two scripts at the bottom, and
 * browser-autofill-store.ts stores the profile and runs them.
 *
 * @module desktop/electron/browser-autofill
 */

import { classifySensitiveField, words, type FieldDescriptor } from './browser-safety';

export interface AutofillAddress {
  id: string;
  /** "Home", "Work"… */
  label: string;
  /** Recipient, when not the profile's own name. */
  name?: string;
  company?: string;
  line1: string;
  line2?: string;
  city: string;
  region?: string;
  postalCode: string;
  country: string;
  phone?: string;
}

export interface AutofillProfile {
  fullName: string;
  givenName: string;
  familyName: string;
  email: string;
  phone: string;
  company: string;
  jobTitle: string;
  addresses: AutofillAddress[];
  /** Address id used by default, and the one used for shipping fields. */
  defaultAddress?: string;
  shippingAddress?: string;
  /** Delivery instructions ("leave with the neighbour"). */
  deliveryNotes: string;
  updatedAt: number;
}

export const EMPTY_PROFILE: AutofillProfile = {
  fullName: '', givenName: '', familyName: '', email: '', phone: '', company: '', jobTitle: '',
  addresses: [], deliveryNotes: '', updatedAt: 0,
};

const s = (v: unknown, max = 300): string => (typeof v === 'string' ? v.replace(/[\u0000-\u0008\u000b-\u001f]/g, '').trim().slice(0, max) : '');

/** Anything that looks like a card number or password has no business in a profile: dropped on save. */
function clean(v: unknown, max = 300): string {
  const x = s(v, max);
  return /^(?:\d[ -]?){13,19}$/.test(x) ? '' : x;
}

export function normaliseProfile(raw: unknown): AutofillProfile {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const addresses = (Array.isArray(r.addresses) ? r.addresses : []).slice(0, 20).map((a, i): AutofillAddress | null => {
    if (!a || typeof a !== 'object') return null;
    const x = a as Record<string, unknown>;
    const addr: AutofillAddress = {
      id: s(x.id, 40) || `a${i + 1}`, label: s(x.label, 40) || `Address ${i + 1}`,
      line1: clean(x.line1), city: clean(x.city, 120), postalCode: clean(x.postalCode, 20), country: clean(x.country, 80),
    };
    for (const k of ['name', 'company', 'line2', 'region', 'phone'] as const) { const v = clean(x[k], 200); if (v) addr[k] = v; }
    return addr.line1 || addr.city || addr.postalCode ? addr : null;
  }).filter((a): a is AutofillAddress => a !== null);
  const ids = new Set(addresses.map(a => a.id));
  const pick = (v: unknown): string | undefined => (typeof v === 'string' && ids.has(v) ? v : undefined);
  return {
    fullName: clean(r.fullName, 200), givenName: clean(r.givenName, 100), familyName: clean(r.familyName, 100),
    email: clean(r.email, 200), phone: clean(r.phone, 40), company: clean(r.company, 200), jobTitle: clean(r.jobTitle, 120),
    addresses, defaultAddress: pick(r.defaultAddress) ?? addresses[0]?.id, shippingAddress: pick(r.shippingAddress),
    deliveryNotes: clean(r.deliveryNotes, 500), updatedAt: typeof r.updatedAt === 'number' ? r.updatedAt : 0,
  };
}

export function profileIsEmpty(p: AutofillProfile): boolean {
  return !p.fullName && !p.givenName && !p.familyName && !p.email && !p.phone && !p.company && p.addresses.length === 0;
}

// ── Field matching ──

export type AutofillKey =
  | 'name' | 'given-name' | 'family-name' | 'email' | 'tel' | 'organization' | 'organization-title'
  | 'street-address' | 'address-line1' | 'address-line2' | 'address-level2' | 'address-level1' | 'postal-code' | 'country'
  | 'delivery-notes';

/** A field as the in-page collector reports it. */
export interface AfField extends FieldDescriptor {
  /** The collector's handle on the element (data-aico-af). */
  key: string;
  value?: string;
  options?: Array<{ value: string; label: string }>;
  readOnly?: boolean;
}

const AC_MAP: Record<string, AutofillKey> = {
  name: 'name', 'given-name': 'given-name', 'family-name': 'family-name', email: 'email',
  tel: 'tel', 'tel-national': 'tel', organization: 'organization', 'organization-title': 'organization-title',
  'street-address': 'street-address', 'address-line1': 'address-line1', 'address-line2': 'address-line2',
  'address-level2': 'address-level2', 'address-level1': 'address-level1', 'postal-code': 'postal-code',
  country: 'country', 'country-name': 'country',
};

const NOT_FILLABLE = new Set(['hidden', 'submit', 'button', 'reset', 'image', 'checkbox', 'radio', 'file', 'range', 'color', 'password', 'search', 'date', 'datetime-local', 'month', 'week', 'time', 'number']);

/** Which of the person's details a field wants, or null (unknown, not fillable, or sensitive). */
export function classifyAutofillField(f: AfField): { key: AutofillKey; section: 'shipping' | 'billing' | '' } | null {
  const c = classifyField(f);
  // A number box only ever takes a postcode or a phone number.
  if (c && (f.type ?? '').toLowerCase() === 'number' && c.key !== 'postal-code' && c.key !== 'tel') return null;
  return c;
}

function classifyField(f: AfField): { key: AutofillKey; section: 'shipping' | 'billing' | '' } | null {
  if (classifySensitiveField(f)) return null;
  const type = (f.type ?? 'text').toLowerCase();
  if (NOT_FILLABLE.has(type) && type !== 'number') return null;
  const tokens = (f.autocomplete ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  const section: 'shipping' | 'billing' | '' = tokens.includes('shipping') ? 'shipping' : tokens.includes('billing') ? 'billing' : '';
  const last = tokens[tokens.length - 1];
  if (last && last !== 'on' && last !== 'off') {
    if (AC_MAP[last]) return { key: AC_MAP[last]!, section };
    // A standard token we do not fill (username, bday, url, cc-name, one-time-code…) is a clear "no".
    if (/^(username|bday|bday-.*|sex|url|photo|impp|language|transaction-.*|cc-.*|new-password|current-password|one-time-code|webauthn|nickname|honorific-.*|additional-name|tel-.*|address-line3|address-level[34])$/.test(last)) return null;
  }
  const id = [...words(f.name), ...words(f.id)];
  const text = [...words(f.label), ...words(f.placeholder), ...words(f.ariaLabel)];
  const all = [...id, ...text];
  const joined = ` ${all.join(' ')} `;
  const has = (...w: string[]): boolean => w.some(x => all.includes(x));
  const re = (r: RegExp): boolean => r.test(joined);
  const sect: 'shipping' | 'billing' | '' = section || (has('shipping', 'delivery', 'ship') ? 'shipping' : has('billing', 'bill') ? 'billing' : '');
  const hit = (key: AutofillKey) => ({ key, section: sect });

  // Anything about a card, a login, a search or a code is not ours.
  if (has('card', 'cc', 'coupon', 'promo', 'voucher', 'captcha', 'otp', 'username', 'login', 'search', 'query', 'q')) return null;
  if (type === 'email' || has('email', 'mail') || re(/ e mail /)) return hit('email');
  if (type === 'tel' || has('phone', 'tel', 'telephone', 'mobile', 'cell', 'phonenumber', 'mobilenumber')) return hit('tel');
  if (re(/ (first|given|fore) ?name /) || has('firstname', 'fname', 'forename', 'givenname')) return hit('given-name');
  if (re(/ (last|family|sur) ?name /) || has('lastname', 'lname', 'surname', 'familyname')) return hit('family-name');
  if (re(/ (company|organi[sz]ation|business|employer)( name)? /) || has('company', 'organization', 'organisation', 'org')) return hit('organization');
  if (re(/ job title /) || has('jobtitle', 'position', 'designation')) return hit('organization-title');
  if (re(/ (delivery|shipping) (instructions|notes) /) || has('instructions')) return hit('delivery-notes');
  if (re(/ (address|addr|street) ?(line)? ?2 /) || has('address2', 'addr2', 'line2', 'apt', 'apartment', 'suite', 'unit', 'flat')) return hit('address-line2');
  if (re(/ (address|addr|street) ?(line)? ?1 /) || has('address1', 'addr1', 'line1', 'street', 'streetaddress')) return hit('address-line1');
  if (has('zip', 'zipcode', 'postal', 'postcode', 'pincode') || re(/ post ?code | pin ?code /)) return hit('postal-code');
  if (has('city', 'town', 'locality', 'suburb')) return hit('address-level2');
  // "Country / Region" is a country; "State / Region" a region.
  if (has('country')) return hit('country');
  if (has('state', 'province', 'region', 'county', 'prefecture')) return hit('address-level1');
  if (has('address', 'addr')) return f.tag === 'textarea' || (f.type ?? '').toLowerCase() === 'textarea' ? hit('street-address') : hit('address-line1');
  if ((re(/ full name /) || has('name', 'fullname', 'yourname')) && !has('user', 'company', 'business', 'file', 'nick', 'display', 'account', 'pet', 'domain')) return hit('name');
  return null;
}

function splitName(p: AutofillProfile): { full: string; given: string; family: string } {
  const full = p.fullName || [p.givenName, p.familyName].filter(Boolean).join(' ');
  const parts = full.split(/\s+/).filter(Boolean);
  return { full, given: p.givenName || parts[0] || '', family: p.familyName || (parts.length > 1 ? parts.slice(1).join(' ') : '') };
}

/** The best option of a <select> for a wanted value: by value, then label, then a label that starts with it. */
export function pickOption(options: Array<{ value: string; label: string }>, want: string): string | null {
  const w = want.trim().toLowerCase();
  if (!w) return null;
  const opts = options.filter(o => o.value !== '' || o.label !== '');
  return opts.find(o => o.value.toLowerCase() === w)?.value
    ?? opts.find(o => o.label.trim().toLowerCase() === w)?.value
    ?? (w.length >= 3 ? opts.find(o => o.label.trim().toLowerCase().startsWith(w))?.value : undefined)
    ?? null;
}

export interface AutofillPlan {
  fills: Array<{ key: string; value: string; what: AutofillKey; label: string }>;
  skipped: Array<{ key: string; label: string; reason: string }>;
  address?: string;
}

/**
 * What to put where. `addressId` picks the address (otherwise shipping fields
 * use the shipping address and everything else the default one). Fields that
 * already hold something are left as they are.
 */
export function planAutofill(fields: AfField[], profile: AutofillProfile, opts: { addressId?: string } = {}): AutofillPlan {
  const plan: AutofillPlan = { fills: [], skipped: [] };
  const name = splitName(profile);
  const byId = (id?: string): AutofillAddress | undefined => (id ? profile.addresses.find(a => a.id === id) : undefined);
  const chosen = byId(opts.addressId);
  const addrFor = (section: string): AutofillAddress | undefined =>
    chosen ?? (section === 'shipping' ? byId(profile.shippingAddress) : undefined) ?? byId(profile.defaultAddress) ?? profile.addresses[0];
  for (const f of fields) {
    const label = f.label || f.placeholder || f.name || f.id || f.key;
    const sensitive = classifySensitiveField(f);
    if (sensitive) { plan.skipped.push({ key: f.key, label, reason: `${sensitive.kind} field — never autofilled` }); continue; }
    const c = classifyAutofillField(f);
    if (!c) continue;
    if (f.readOnly) { plan.skipped.push({ key: f.key, label, reason: 'read-only' }); continue; }
    const isSelect = (f.tag ?? '').toLowerCase() === 'select' || (f.type ?? '').startsWith('select');
    if (!isSelect && (f.value ?? '').trim()) { plan.skipped.push({ key: f.key, label, reason: 'already filled' }); continue; }
    const a = addrFor(c.section);
    if (a && !plan.address) plan.address = a.id;
    const v: Record<AutofillKey, string | undefined> = {
      name: (c.section && a?.name) || name.full, 'given-name': name.given, 'family-name': name.family,
      email: profile.email, tel: a?.phone && c.section ? a.phone : profile.phone || a?.phone,
      organization: (c.section && a?.company) || profile.company, 'organization-title': profile.jobTitle,
      'street-address': a ? [a.line1, a.line2].filter(Boolean).join('\n') : undefined,
      'address-line1': a?.line1, 'address-line2': a?.line2, 'address-level2': a?.city, 'address-level1': a?.region,
      'postal-code': a?.postalCode, country: a?.country, 'delivery-notes': profile.deliveryNotes,
    };
    let value = v[c.key];
    if (!value) continue;
    if (isSelect) {
      const opt = pickOption(f.options ?? [], value);
      if (!opt) { plan.skipped.push({ key: f.key, label, reason: `no option "${value}"` }); continue; }
      if ((f.value ?? '') === opt) continue;
      value = opt;
    } else if (c.key === 'street-address' && (f.tag ?? '').toLowerCase() !== 'textarea') {
      value = value.replace(/\n/g, ', ');
    }
    plan.fills.push({ key: f.key, value, what: c.key, label });
  }
  return plan;
}

// ── In the page ──

/**
 * Collects the fillable fields of the form in focus (or, with nothing focused,
 * of the whole page and its same-origin frames), tagging each with
 * `data-aico-af`. Main world, read-only apart from that attribute.
 */
export const COLLECT_FIELDS_JS = String.raw`(() => {
  const out = [];
  let n = 0;
  const visible = (el) => { try { const r = el.getBoundingClientRect(); const s = el.ownerDocument.defaultView.getComputedStyle(el); return r.width > 1 && r.height > 1 && s.visibility !== 'hidden' && s.display !== 'none'; } catch (e) { return false; } };
  const text = (el) => (el ? String(el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 120) : '');
  const labelOf = (el) => {
    const doc = el.ownerDocument;
    if (el.labels && el.labels.length) return text(el.labels[0]);
    const by = el.getAttribute('aria-labelledby');
    if (by) return by.split(/\s+/).map(id => text(doc.getElementById(id))).join(' ').trim();
    const wrap = el.closest('label');
    if (wrap) return text(wrap);
    const prev = el.previousElementSibling;
    if (prev && /^(LABEL|SPAN|DIV|P|B|STRONG)$/.test(prev.tagName) && text(prev).length < 60) return text(prev);
    return '';
  };
  const docs = [document];
  for (const f of document.querySelectorAll('iframe')) { try { if (f.contentDocument) docs.push(f.contentDocument); } catch (e) { /* cross-origin: not ours */ } }
  let scope = null;
  for (const doc of docs) {
    const a = doc.activeElement;
    if (a && a !== doc.body && /^(INPUT|SELECT|TEXTAREA)$/.test(a.tagName)) { scope = a.form || a.closest('form, [role="form"], fieldset') || null; if (scope) break; }
  }
  const roots = scope ? [scope] : docs;
  for (const root of roots) {
    for (const el of root.querySelectorAll('input, select, textarea')) {
      if (n >= 200) break;
      if (el.disabled || !visible(el)) continue;
      const tag = el.tagName.toLowerCase();
      const type = tag === 'input' ? (el.getAttribute('type') || 'text').toLowerCase() : tag;
      if (['hidden', 'submit', 'button', 'reset', 'image', 'file'].includes(type)) continue;
      const key = 'f' + (++n);
      el.setAttribute('data-aico-af', key);
      out.push({
        key, tag, type, autocomplete: el.getAttribute('autocomplete') || '', name: el.getAttribute('name') || '', id: el.id || '',
        label: labelOf(el), placeholder: el.getAttribute('placeholder') || '', ariaLabel: el.getAttribute('aria-label') || '',
        inputmode: el.getAttribute('inputmode') || '', maxLength: el.maxLength > 0 ? el.maxLength : undefined,
        value: type === 'password' ? '' : String(el.value || '').slice(0, 200), readOnly: Boolean(el.readOnly),
        options: tag === 'select' ? [...el.options].slice(0, 400).map(o => ({ value: o.value, label: String(o.textContent || '').trim() })) : undefined,
      });
    }
  }
  return out;
})()`;

/**
 * Puts values into the tagged fields the way a person would appear to
 * (native setter, then input/change events, so React/Vue forms see it), and
 * refuses — again, on the live element — password, card, CVV and code fields.
 * `__FILLS__` is replaced with the JSON plan.
 */
export const APPLY_FILLS_JS = String.raw`((fills) => {
  const docs = [document];
  for (const f of document.querySelectorAll('iframe')) { try { if (f.contentDocument) docs.push(f.contentDocument); } catch (e) { /* cross-origin */ } }
  const find = (key) => { for (const d of docs) { const el = d.querySelector('[data-aico-af="' + key + '"]'); if (el) return el; } return null; };
  const done = [];
  for (const f of fills) {
    const el = find(f.key);
    if (!el) continue;
    const type = (el.getAttribute('type') || '').toLowerCase();
    const ac = (el.getAttribute('autocomplete') || '').toLowerCase();
    if (type === 'password' || /cc-|password|one-time-code/.test(ac)) continue;
    const win = el.ownerDocument.defaultView;
    const proto = el.tagName === 'SELECT' ? win.HTMLSelectElement.prototype : el.tagName === 'TEXTAREA' ? win.HTMLTextAreaElement.prototype : win.HTMLInputElement.prototype;
    const set = Object.getOwnPropertyDescriptor(proto, 'value').set;
    try { el.focus({ preventScroll: true }); } catch (e) { /* not focusable */ }
    set.call(el, f.value);
    el.dispatchEvent(new win.Event('input', { bubbles: true }));
    el.dispatchEvent(new win.Event('change', { bubbles: true }));
    try { el.blur(); } catch (e) { /* fine */ }
    const prev = el.style.boxShadow;
    el.style.boxShadow = '0 0 0 2px rgba(99,102,241,.55)';
    setTimeout(() => { el.style.boxShadow = prev; }, 1600);
    done.push(f.key);
  }
  return done;
})(__FILLS__)`;
