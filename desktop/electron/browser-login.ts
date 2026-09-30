/**
 * `browser_login`: the agent signs in with a stored credential it cannot see.
 *
 * The model names a credential (`grafana-admin`) — or nothing, and the one
 * bound to the page's origin is used. Main (browser.ts) finds the page's real
 * sign-in fields with the snippet below, asks the engine over the private
 * port to resolve that name *for this exact origin* with tool
 * `browser_login` (policy and approval are the broker's: vault-host.ts), then
 * types the username and password with trusted input events (CDP
 * `Input.insertText`, the same way a person's keyboard arrives), checks the
 * focus is on the field it means before every keystroke, drops the value, and
 * tells the model only what happened: signed in / fields filled / no matching
 * login form / refused: <reason>.
 *
 * The rules this file decides, in main, from what the page reports:
 *   - only the page's own top document — never a field in a frame (a
 *     cross-site frame would be another origin; a same-origin one is rare
 *     enough to hand to the person);
 *   - the password goes only into a real password field (type=password), the
 *     username only into a plain text/email field that is not a password,
 *     card, CVV or one-time-code field (browser-safety.ts);
 *   - a CAPTCHA or one-time code is the person's (browser_handoff).
 *
 * What it deliberately does not do: fill anything the page did not show, read
 * a value back, or run page script with a value in it — values only ever
 * travel as keystrokes.
 *
 * @module desktop/electron/browser-login
 */

import type { FieldDescriptor } from './browser-safety';
import { classifySensitiveField } from './browser-safety';

export interface LoginField { ref: string; field: FieldDescriptor; label: string }

/** What the page snippet reports about sign-in forms in the top document. */
export interface LoginFormReport {
  /** Sign-in forms found (visible password fields, grouped by form). */
  forms: number;
  password?: LoginField;
  username?: LoginField;
  /** A username field with no password yet (the first step of a two-step sign-in). */
  identifierOnly?: LoginField;
  /** Visible fields that look like one-time codes. */
  otp: boolean;
}

/**
 * The page half, evaluated in the tab's top document (read-only: it only
 * marks the fields with `data-aico-ref` so browser.ts can click them).
 * `index` picks the form when there are several.
 */
export function loginFormJs(index: number): string {
  return String.raw`(() => {
    const d = document;
    const shown = (el) => { try { const r = el.getBoundingClientRect(); if (r.width < 2 || r.height < 2) return false; const s = getComputedStyle(el); return s.visibility !== 'hidden' && s.display !== 'none'; } catch (e) { return false; } };
    const usable = (el) => el && !el.disabled && !el.readOnly && shown(el);
    let seq = 0;
    const ref = (el) => { let r = el.getAttribute('data-aico-ref'); if (!r) { r = 'L' + Date.now().toString(36) + (++seq); el.setAttribute('data-aico-ref', r); } return r; };
    const labelOf = (el) => { try { return String((el.labels && el.labels[0] && el.labels[0].textContent) || el.getAttribute('aria-label') || el.placeholder || el.name || el.id || '').trim().slice(0, 80); } catch (e) { return ''; } };
    const desc = (el) => ({ ref: ref(el), label: labelOf(el), field: { tag: el.tagName.toLowerCase(), type: (el.getAttribute('type') || 'text').toLowerCase(), autocomplete: el.getAttribute('autocomplete') || '', name: el.name || '', id: el.id || '', label: labelOf(el), placeholder: el.placeholder || '', ariaLabel: el.getAttribute('aria-label') || '', inputmode: el.getAttribute('inputmode') || '', maxLength: el.maxLength > 0 ? el.maxLength : undefined } });
    const isTextish = (el) => el.tagName === 'INPUT' && ['text', 'email', 'tel', ''].includes((el.getAttribute('type') || 'text').toLowerCase());
    const USERISH = /user|login|e-?mail|account|identifier|handle|phone|member|benutzer|usuario|utilisateur/i;
    const scopeOf = (el) => el.form || (el.closest && el.closest('form')) || d;
    const userFor = (pw, scope) => {
      const inputs = Array.from(scope.querySelectorAll('input')).filter(usable);
      const ac = inputs.find(el => isTextish(el) && /\b(username|email)\b/.test(el.getAttribute('autocomplete') || ''));
      if (ac) return ac;
      const i = pw ? inputs.indexOf(pw) : inputs.length;
      const before = inputs.slice(0, i < 0 ? inputs.length : i).filter(el => isTextish(el) && !/search|query/i.test((el.name || '') + (el.id || '') + (el.getAttribute('role') || '')));
      const named = before.filter(el => USERISH.test([el.name, el.id, el.getAttribute('autocomplete'), el.placeholder, el.getAttribute('aria-label')].join(' ')));
      return named[named.length - 1] || before[before.length - 1] || null;
    };
    const pws = Array.from(d.querySelectorAll('input[type=password]')).filter(usable);
    const forms = [];
    for (const pw of pws) { const s = scopeOf(pw); if (!forms.some(f => f.scope === s)) forms.push({ scope: s, pw }); }
    const otp = Array.from(d.querySelectorAll('input')).some(el => usable(el) && (/one-time-code/.test(el.getAttribute('autocomplete') || '') || /\b(otp|totp|2fa|mfa|one.?time|verification.?code|auth.?code)\b/i.test([el.name, el.id, el.placeholder, el.getAttribute('aria-label')].join(' '))));
    const out = { forms: forms.length, otp };
    if (forms.length) {
      const f = forms[Math.min(Math.max(0, ${Number.isFinite(index) ? Math.floor(index) : 0}), forms.length - 1)];
      out.password = desc(f.pw);
      const u = userFor(f.pw, f.scope);
      if (u) out.username = desc(u);
    } else {
      const u = userFor(null, d.querySelector('form') || d);
      if (u && USERISH.test([u.name, u.id, u.getAttribute('autocomplete'), u.placeholder, u.getAttribute('aria-label'), u.type].join(' '))) out.identifierOnly = desc(u);
    }
    return out;
  })()`;
}

/** Is the element the snippet (or a locate) reports really a password field? */
export function isRealPasswordField(f: FieldDescriptor): boolean {
  return (f.type ?? '').toLowerCase() === 'password';
}

/** May a username go into this field? Not a password, card, CVV or one-time-code field. */
export function isUsernameField(f: FieldDescriptor): boolean {
  const type = (f.type ?? 'text').toLowerCase();
  if (!['text', 'email', 'tel', ''].includes(type)) return false;
  return classifySensitiveField(f) === null;
}

/** The kinds of credential a web sign-in form can take, and which field is the password. */
export function passwordOf(kind: string | undefined, fields: Record<string, string> | undefined): string | undefined {
  if (!fields) return undefined;
  if (kind === 'login' || kind === 'basic-auth') return fields.password;
  if (kind === 'generic') return fields.value ?? fields.password;
  return undefined;
}
