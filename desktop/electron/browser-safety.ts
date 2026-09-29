/**
 * What the agent must not do in the built-in browser, decided from plain data
 * so every rule is unit-tested. The page scripts (`browser-page.ts`) only
 * collect raw signals — attributes, frame URLs, visible text — and these
 * functions judge them in the main process, where a page cannot tamper with
 * the verdict.
 *
 *   - classifySensitiveField: passwords, card numbers, CVVs and one-time codes
 *     are the user's — the agent never types into them.
 *   - detectHumanCheck: CAPTCHAs and "verify you are human" walls are handed
 *     to the user, never attempted.
 *   - isExecutableName: executables the agent downloads wait for the user.
 *
 * @module desktop/electron/browser-safety
 */

import type { SensitiveKind } from '../shared/browser-types';

// ── Sensitive fields ──

/** What the page script reports about a field. */
export interface FieldDescriptor {
  tag?: string;
  type?: string;
  autocomplete?: string;
  name?: string;
  id?: string;
  label?: string;
  placeholder?: string;
  ariaLabel?: string;
  inputmode?: string;
  maxLength?: number;
}

/** Split identifiers and labels into lower-case words: "ccNumber" / "cc-number" / "CC Number" → cc, number. */
export function words(s: string | undefined): string[] {
  if (!s) return [];
  return s
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([A-Za-z])(\d)/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

const has = (ws: string[], ...want: string[]): boolean => want.some(w => ws.includes(w));
const seq = (ws: string[], a: string, b: string): boolean => ws.some((w, i) => w === a && ws[i + 1] === b);

export function classifySensitiveField(f: FieldDescriptor): { kind: SensitiveKind; reason: string } | null {
  const type = (f.type ?? '').toLowerCase();
  const ac = (f.autocomplete ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  if (type === 'password') return { kind: 'password', reason: 'a password field (type=password)' };
  if (ac.includes('current-password') || ac.includes('new-password')) return { kind: 'password', reason: `autocomplete=${ac.join(' ')}` };
  if (ac.includes('cc-csc')) return { kind: 'cvv', reason: 'autocomplete=cc-csc' };
  if (ac.some(a => a === 'cc-number' || a.startsWith('cc-exp') || a === 'cc-type')) return { kind: 'card', reason: `autocomplete=${ac.join(' ')}` };
  if (ac.includes('one-time-code')) return { kind: 'otp', reason: 'autocomplete=one-time-code' };
  if (['hidden', 'submit', 'button', 'reset', 'image', 'checkbox', 'radio', 'file', 'range', 'color'].includes(type)) return null;

  const idWords = [...words(f.name), ...words(f.id)];
  const textWords = [...words(f.label), ...words(f.placeholder), ...words(f.ariaLabel)];
  const all = [...idWords, ...textWords];
  const joined = all.join(' ');

  // Card security code first: "card verification code" is a CVV, not an OTP.
  if (has(all, 'cvv', 'cvc', 'cvn', 'csc', 'cvv2', 'cvc2')|| /security code|card verification|card code|verification value/.test(joined)) {
    return { kind: 'cvv', reason: 'named like a card security code' };
  }
  if (/card ?number|credit ?card|debit ?card|cardnumber|ccnumber|cc ?num|\bpan\b|card ?no\b/.test(joined) || (has(all, 'card') && has(all, 'number', 'num', 'no'))) {
    return { kind: 'card', reason: 'named like a card number' };
  }
  if (has(all, 'expiry', 'expiration') && has(all, 'card', 'cc', 'exp', 'mm', 'yy', 'date')) {
    return { kind: 'card', reason: 'named like a card expiry' };
  }
  if (has(all, 'otp', 'totp', 'mfa', '2fa', 'passcode', 'onetime') || seq(all, 'one', 'time')
    || /verification code|verify code|security pin|auth(entication)? code|sms code|login code|access code|two factor|2 step|two step|confirmation code|6 digit code/.test(joined)) {
    return { kind: 'otp', reason: 'named like a one-time code' };
  }
  if (has(all, 'password', 'passwd', 'pwd', 'passphrase') || (has(all, 'pin') && !has(all, 'code', 'zip', 'postal'))) {
    return { kind: 'password', reason: 'named like a password or PIN' };
  }
  return null;
}

export function sensitiveRefusal(kind: SensitiveKind, label: string): string {
  const what = { password: 'a password field', card: 'a payment-card field', cvv: 'a card security code (CVV) field', otp: 'a one-time / verification code field' }[kind];
  return `Refused: "${label || 'this field'}" is ${what}. Credentials, payment details and one-time codes are the user's to enter — call browser_handoff and ask the user to fill it in, then continue after browser_handoff_wait reports done.`;
}

// ── Human checks ──

export interface FrameSignal { src: string; title?: string; width: number; height: number; visible: boolean }

/** What the page script reports for human-check detection. */
export interface HumanCheckSignals {
  url: string;
  title: string;
  frames: FrameSignal[];
  /** Visible elements matching known widget selectors (e.g. ".g-recaptcha", ".cf-turnstile"). */
  widgets: string[];
  /** The first few thousand characters of the visible text. */
  text: string;
}

export interface HumanCheck { detected: boolean; kind?: string; evidence?: string }

const CHALLENGE_URLS: Array<[RegExp, string]> = [
  [/^https?:\/\/(www\.)?google\.[a-z.]+\/sorry\//i, 'Google "unusual traffic" check'],
  [/^https?:\/\/challenges\.cloudflare\.com\//i, 'Cloudflare challenge'],
  [/\/cdn-cgi\/challenge-platform\//i, 'Cloudflare challenge'],
  [/captcha-delivery\.com/i, 'DataDome CAPTCHA'],
  [/geo\.captcha-delivery\.com/i, 'DataDome CAPTCHA'],
  [/\/px-captcha|perimeterx|px-cdn\.net.*captcha/i, 'PerimeterX / HUMAN challenge'],
  [/arkoselabs\.com|funcaptcha\.com/i, 'Arkose / FunCaptcha'],
  [/validate\.perfdrive\.com|shieldsquare/i, 'Radware bot check'],
  [/\/_Incapsula_Resource|incapsula/i, 'Imperva / Incapsula check'],
  [/amazon\.[a-z.]+\/errors\/validatecaptcha/i, 'Amazon CAPTCHA'],
];

const CHALLENGE_TEXT: Array<[RegExp, string]> = [
  [/verify (that )?you are (a )?human/i, '"verify you are human"'],
  [/i['’]?m not a robot/i, '"I\'m not a robot"'],
  [/are you a robot\??/i, '"are you a robot?"'],
  [/confirm (that )?you['’]?re not a robot/i, '"confirm you\'re not a robot"'],
  [/checking (if the site connection is secure|your browser before accessing)/i, 'Cloudflare browser check'],
  [/press (&|and) hold/i, '"press and hold" check'],
  [/our systems have detected unusual traffic/i, 'Google "unusual traffic" check'],
  [/complete the security check to access/i, 'security check'],
  [/please (solve|complete) (this|the) (captcha|puzzle|challenge)/i, 'CAPTCHA puzzle'],
  [/enter the characters you see/i, 'text CAPTCHA'],
  [/type the characters (you see )?in (the|this) image/i, 'text CAPTCHA'],
  [/select all (images|squares) with/i, 'image CAPTCHA'],
  [/human verification/i, 'human verification'],
  [/bot (protection|detection) check/i, 'bot check'],
];

const CHALLENGE_TITLES = /^(just a moment\.*|attention required!?( \| cloudflare)?|access denied|security check|verify you are human|are you a robot\??|robot check|captcha)$/i;

/**
 * Is there a human check on this page?
 *
 * Invisible, score-based checks (reCAPTCHA v3, the corner badge, an invisible
 * hCaptcha) are on a large part of the web and ask nothing of anyone: they are
 * NOT flagged, or the agent could not use half the web. What is flagged is a
 * check a person is being asked to pass: a visible checkbox or puzzle frame, a
 * challenge page, or its wording.
 */
export function detectHumanCheck(s: HumanCheckSignals): HumanCheck {
  for (const [re, kind] of CHALLENGE_URLS) if (re.test(s.url)) return { detected: true, kind, evidence: `page URL ${s.url.slice(0, 120)}` };
  for (const f of s.frames) {
    if (!f.visible || f.width < 30 || f.height < 30) continue;
    const src = f.src;
    if (/\/recaptcha\/(api2|enterprise)\/(anchor|bframe)/i.test(src) && !/[?&]size=invisible/i.test(src)) return { detected: true, kind: 'reCAPTCHA', evidence: 'a visible reCAPTCHA frame' };
    if (/hcaptcha\.com\/captcha\//i.test(src) && !/[?&#]size=invisible/i.test(src)) return { detected: true, kind: 'hCaptcha', evidence: 'a visible hCaptcha frame' };
    if (/challenges\.cloudflare\.com\//i.test(src)) return { detected: true, kind: 'Cloudflare Turnstile', evidence: 'a visible Turnstile frame' };
    if (/arkoselabs\.com|funcaptcha\.com/i.test(src)) return { detected: true, kind: 'Arkose / FunCaptcha', evidence: 'a visible Arkose frame' };
    if (/captcha-delivery\.com/i.test(src)) return { detected: true, kind: 'DataDome CAPTCHA', evidence: 'a visible DataDome frame' };
    if (/geetest\.com/i.test(src)) return { detected: true, kind: 'GeeTest', evidence: 'a visible GeeTest frame' };
    if (/recaptcha/i.test(f.title ?? '') && !/invisible/i.test(src)) return { detected: true, kind: 'reCAPTCHA', evidence: `frame titled "${f.title}"` };
  }
  const widget = s.widgets.find(w => !/grecaptcha-badge/.test(w));
  if (widget) return { detected: true, kind: widgetKind(widget), evidence: `a visible ${widget} element` };
  if (CHALLENGE_TITLES.test(s.title.trim())) return { detected: true, kind: 'challenge page', evidence: `page title "${s.title.trim()}"` };
  const text = s.text.slice(0, 6000);
  for (const [re, kind] of CHALLENGE_TEXT) if (re.test(text)) return { detected: true, kind, evidence: `page text ${kind}` };
  return { detected: false };
}

function widgetKind(sel: string): string {
  if (/recaptcha/i.test(sel)) return 'reCAPTCHA';
  if (/h-captcha|hcaptcha/i.test(sel)) return 'hCaptcha';
  if (/turnstile|cf-/i.test(sel)) return 'Cloudflare Turnstile';
  if (/arkose|funcaptcha/i.test(sel)) return 'Arkose / FunCaptcha';
  return 'CAPTCHA';
}

/** Selectors the page script checks for visibility (the widget, not the invisible badge). */
export const HUMAN_CHECK_SELECTORS = [
  '.g-recaptcha:not(.grecaptcha-badge)', '.h-captcha', '.cf-turnstile', '#challenge-form', '#cf-challenge-running',
  '#challenge-stage', '#turnstile-wrapper', '#px-captcha', '#FunCaptcha', '#arkose', '[data-callback][data-sitekey]:not([data-size="invisible"])',
  'iframe[src*="geo.captcha-delivery.com"]', '#captcha-container', '.geetest_holder',
];

export function humanCheckRefusal(h: HumanCheck): string {
  return `Human check detected (${h.kind ?? 'CAPTCHA'}: ${h.evidence ?? 'on this page'}). AICO never solves, bypasses or works around CAPTCHAs or bot checks. Hand the page to the user: call browser_handoff with a short message (e.g. "Please complete the ${h.kind ?? 'human'} check, then press Done"), poll browser_handoff_wait, and continue only after they are done. Nothing was clicked or typed.`;
}

// ── Downloads ──

const EXECUTABLE = /\.(exe|msi|msix|msixbundle|appx|bat|cmd|com|scr|pif|ps1|psm1|vbs|vbe|js|jse|wsf|wsh|hta|cpl|reg|lnk|sh|bash|zsh|command|run|bin|appimage|deb|rpm|dmg|pkg|mpkg|app|apk|xapk|jar|msp|gadget|inf)$/i;

/** Would opening this file run code? Agent downloads of these wait for the user. */
export function isExecutableName(filename: string): boolean {
  return EXECUTABLE.test(filename.trim());
}

/** A file name that does not collide with an existing one: report.pdf → report (1).pdf. */
export function uniqueName(filename: string, exists: (name: string) => boolean): string {
  const clean = sanitizeFilename(filename) || 'download';
  if (!exists(clean)) return clean;
  const dot = clean.lastIndexOf('.');
  const multi = /\.(tar\.(gz|bz2|xz)|user\.js)$/i.exec(clean);
  const extStart = multi ? multi.index : dot > 0 ? dot : clean.length;
  const base = clean.slice(0, extStart);
  const ext = clean.slice(extStart);
  for (let i = 1; i < 10_000; i++) {
    const cand = `${base} (${i})${ext}`;
    if (!exists(cand)) return cand;
  }
  return `${base} (${Date.now()})${ext}`;
}

export function sanitizeFilename(name: string): string {
  // eslint-disable-next-line no-control-regex
  return name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/^\.+/, '').replace(/[. ]+$/, '').slice(0, 200);
}

// ── What an action changed ──

/** The page as seen right before and right after an agent action. */
export interface PageProbe {
  url: string;
  title: string;
  /** Visible alert / error / status messages. */
  alerts: string[];
  /** Fields the browser (or aria-invalid) marks invalid, with their message. */
  invalid: Array<{ label: string; message: string }>;
  /** Open modal dialogs in the page (not JS dialogs). */
  modals: string[];
}

/** A compact account of what changed, for the agent to reason about. */
export function describeChange(before: PageProbe | null, after: PageProbe | null, extra: { jsDialog?: { type: string; message: string }; download?: string; newTab?: string } = {}): string {
  const lines: string[] = [];
  if (after) {
    const nav = before && before.url !== after.url;
    lines.push(`Now: "${after.title || '(untitled)'}" — ${after.url}${nav ? ` (navigated from ${before!.url})` : ''}`);
  }
  const changes: string[] = [];
  if (extra.jsDialog) changes.push(`a JavaScript ${extra.jsDialog.type} dialog is open: "${extra.jsDialog.message.slice(0, 200)}" — answer it with browser_dialog`);
  if (extra.newTab) changes.push(`a new tab opened: ${extra.newTab}`);
  if (extra.download) changes.push(`a download started: ${extra.download} (see browser_downloads)`);
  if (before && after && before.title !== after.title && before.url === after.url) changes.push(`title changed to "${after.title}"`);
  if (after) {
    const oldAlerts = new Set(before?.alerts ?? []);
    const fresh = after.alerts.filter(a => !oldAlerts.has(a));
    if (fresh.length) changes.push(`message shown: ${fresh.slice(0, 4).map(a => `"${a.slice(0, 160)}"`).join('; ')}`);
    const oldInvalid = new Set((before?.invalid ?? []).map(i => `${i.label}|${i.message}`));
    const inv = after.invalid.filter(i => !oldInvalid.has(`${i.label}|${i.message}`));
    if (inv.length) changes.push(`validation errors: ${inv.slice(0, 6).map(i => `${i.label || 'field'}: ${i.message}`).join('; ')}`);
    const oldModals = new Set(before?.modals ?? []);
    const modals = after.modals.filter(m => !oldModals.has(m));
    if (modals.length) changes.push(`a dialog opened in the page: ${modals.slice(0, 2).map(m => `"${m.slice(0, 120)}"`).join('; ')}`);
    if (before && before.modals.length && !after.modals.length) changes.push('the in-page dialog closed');
  }
  if (changes.length) lines.push(`Changes: ${changes.join(' | ')}`);
  else if (before && after && before.url === after.url) lines.push('No visible change detected (take a snapshot if you expected one).');
  return lines.join('\n');
}
