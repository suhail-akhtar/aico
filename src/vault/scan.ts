/**
 * Catching secrets the user types into chat, before the model reads them.
 *
 * People paste credentials into conversations: "the server is 10.0.0.5, root
 * password is …", a `.env` block, a connection string. Once that text is in
 * the model's context it is in the provider's logs, the session log, the
 * export and every future compaction. So submitted user text is scanned, and
 * what is found is moved into the vault (quarantined, for the user to review)
 * and replaced by a reference before anything else sees it.
 *
 * **High confidence over recall.** A false positive rewrites what the user
 * said — a git SHA turned into `[secret:…]` is a confusing, visible bug — so
 * every pattern here is either a format with a distinctive prefix (`ghp_`,
 * `AKIA`, `sk-ant-`, a PEM armour line) or a value with explicit context
 * (`password=…`, `user:pass@host`) that also looks like a secret rather than
 * an identifier, a placeholder or a sentence. What it misses, the user can
 * still vault by hand; what it wrongly takes, they cannot easily see.
 *
 * Deliberately not detected: bare high-entropy strings (hashes, UUIDs, base64
 * images and lockfile integrity values are all high-entropy and all harmless),
 * and JWTs (usually session tokens pasted while debugging, which the user most
 * often wants the agent to read).
 *
 * @module vault/scan
 */

import type { CredentialKind } from './types.js';

export interface DetectedSecret {
  /** Span of the secret value itself (not its label or context). */
  start: number;
  end: number;
  value: string;
  kind: CredentialKind;
  /** What it looked like: `github-token`, `password`, `private-key`, … */
  label: string;
  /** From a URL, when the secret came with one. */
  host?: string;
  username?: string;
  url?: string;
}

interface Rule {
  label: string;
  kind: CredentialKind;
  re: RegExp;
  /** Capture group holding the secret; 0 = the whole match. */
  group?: number;
}

/** Distinctive token formats: the prefix is the confidence. */
const TOKEN_RULES: Rule[] = [
  { label: 'private-key', kind: 'ssh-key', re: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----[\s\S]+?-----END (?:[A-Z0-9]+ )*PRIVATE KEY-----/g },
  { label: 'anthropic-key', kind: 'api-token', re: /\bsk-ant-(?:api|admin)\d{2}-[A-Za-z0-9_-]{20,}/g },
  { label: 'openai-key', kind: 'api-token', re: /\bsk-(?:proj-|svcacct-|admin-)?(?!ant-)[A-Za-z0-9_-]{32,}/g },
  { label: 'github-token', kind: 'api-token', re: /\bgh[pousr]_[A-Za-z0-9]{36,255}\b/g },
  { label: 'github-token', kind: 'api-token', re: /\bgithub_pat_[A-Za-z0-9_]{22,255}\b/g },
  { label: 'slack-token', kind: 'api-token', re: /\bxox[abposr]-[A-Za-z0-9-]{10,}/g },
  { label: 'slack-webhook', kind: 'api-token', re: /https:\/\/hooks\.slack\.com\/services\/T[A-Z0-9]+\/B[A-Z0-9]+\/[A-Za-z0-9]{16,}/g },
  { label: 'stripe-key', kind: 'api-token', re: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b/g },
  { label: 'google-api-key', kind: 'api-token', re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { label: 'aws-access-key-id', kind: 'api-token', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { label: 'aws-secret-key', kind: 'api-token', re: /\baws_?secret_?access_?key\b["']?\s*[:=]\s*["']?([A-Za-z0-9/+=]{40})\b/gi, group: 1 },
];

/** `scheme://user:password@host` — the password only. */
const URL_CREDENTIALS = /\b([a-z][a-z0-9+.-]{1,20}):\/\/([^\s:@/"'<>]{1,128}):([^\s@/"'<>]{1,256})@([A-Za-z0-9.-]+|\[[0-9a-fA-F:]+\])(?::(\d{1,5}))?/gi;

/**
 * `password = X`, `token: X`, `my password is X`. The keyword and the
 * separator are the context; the value must then pass {@link looksLikeSecret}.
 */
const KEYED = /\b(password|passwd|passphrase|pwd|secret|client[_-]?secret|api[_-]?key|apikey|access[_-]?token|auth[_-]?token|bearer[_-]?token|token)\b["']?(\s*[:=]\s*|\s+is\s+)(["'`]?)([^\s"'`,;()[\]{}<>]{6,200})\3/gi;

const KEYWORD_KIND: Record<string, CredentialKind> = { token: 'api-token', 'api-key': 'api-token', apikey: 'api-token' };

const PLACEHOLDER_WORDS = new Set([
  'password', 'passwd', 'changeme', 'required', 'optional', 'undefined', 'null', 'none', 'true', 'false',
  'string', 'secret', 'example', 'redacted', 'placeholder', 'expired', 'invalid', 'missing', 'yourpassword',
  'your_password', 'your-password', 'mypassword', 'xxxxxx', 'hidden', 'masked', 'empty', 'unknown', 'default',
]);

/**
 * Does a keyed value look like an actual secret rather than a word, an
 * identifier, a reference or a placeholder?
 */
export function looksLikeSecret(value: string, separator: string): boolean {
  const v = value.trim();
  if (v.length < 6) return false;
  if (PLACEHOLDER_WORDS.has(v.toLowerCase())) return false;
  // References to something else, not the thing itself.
  if (/^[$%]|^\{\{|^<|^\*+$|^x+$|^\.{3}|^\[secret:/i.test(v)) return false;
  if (/^(?:process\.env|os\.environ|env\.|secrets\.|vars\.|config\.|settings\.)/i.test(v)) return false;
  // Dotted identifiers (req.headers.authorization) and plain identifiers with
  // no digit (DB_PASSWORD, getToken) are code, not secrets.
  if (/^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)+$/.test(v)) return false;
  if (/^[A-Za-z_]+$/.test(v) && !/[a-z].*[A-Z]|[A-Z].*[a-z]/.test(v.replace(/_/g, ''))) return false;
  if (/^[A-Za-z_][A-Za-z_]*$/.test(v) && v.includes('_')) return false;
  // A bare English-looking word after "is" ("the token is expired") is prose.
  if (/\bis\b/.test(separator) && /^[a-z]+$/i.test(v)) return false;
  // Function calls and URLs are not the value itself.
  if (/^https?:\/\//i.test(v)) return false;
  // Must have some character-class variety: a digit, a symbol, or mixed case.
  return /\d/.test(v) || /[^A-Za-z0-9]/.test(v) || (/[a-z]/.test(v) && /[A-Z]/.test(v));
}

function overlaps(spans: DetectedSecret[], start: number, end: number): boolean {
  return spans.some(s => start < s.end && end > s.start);
}

/**
 * References to vault entries — `{{secret:name}}` and `[secret:name]` — are
 * names, not secrets, and `secret:` looks exactly like a `secret: value` pair
 * to the keyed rule. They are blanked (same length, so offsets hold) before
 * any rule runs. Found live: without this, a message saying "run
 * `{{secret:canary-shell}}`" vaulted the *name* as a secret, and the redactor
 * then scrubbed that name out of every credential listing.
 */
function maskReferences(text: string): string {
  return text.replace(/\{\{\s*secret:[^}\n]{0,100}\}\}|\[secret:[^\]\n]{0,100}\]/gi, m => ' '.repeat(m.length));
}

/** Every high-confidence secret in `text`, non-overlapping, in order. */
export function scanForSecrets(original: string): DetectedSecret[] {
  const text = maskReferences(original);
  const found: DetectedSecret[] = [];

  for (const rule of TOKEN_RULES) {
    for (const m of text.matchAll(rule.re)) {
      const group = rule.group ?? 0;
      const value = m[group];
      if (!value) continue;
      const start = m.index! + (group ? m[0].indexOf(value) : 0);
      const end = start + value.length;
      if (overlaps(found, start, end)) continue;
      found.push({ start, end, value, kind: rule.kind, label: rule.label });
    }
  }

  for (const m of text.matchAll(URL_CREDENTIALS)) {
    const [whole, scheme, user, pass, host, port] = m;
    if (!pass || !looksLikeUrlPassword(pass)) continue;
    const start = m.index! + whole.indexOf(`:${pass}@`) + 1;
    const end = start + pass.length;
    if (overlaps(found, start, end)) continue;
    const lowerScheme = scheme!.toLowerCase();
    found.push({
      start, end, value: pass,
      kind: /^(postgres|postgresql|mysql|mariadb|mongodb(\+srv)?|redis|mssql|sqlserver|amqp)$/.test(lowerScheme) ? 'database'
        : lowerScheme === 'ssh' || lowerScheme === 'sftp' ? 'ssh-password' : 'login',
      label: 'url-password',
      host: host!.replace(/^\[|\]$/g, '').toLowerCase(),
      username: decodeSafe(user!),
      url: `${lowerScheme}://${host}${port ? `:${port}` : ''}`,
    });
  }

  for (const m of text.matchAll(KEYED)) {
    const [, keyword, separator, , value] = m;
    if (!value || !looksLikeSecret(value, separator!)) continue;
    const start = m.index! + m[0].lastIndexOf(value);
    const end = start + value.length;
    if (overlaps(found, start, end)) continue;
    const key = keyword!.toLowerCase().replace(/_/g, '-');
    found.push({ start, end, value, kind: KEYWORD_KIND[key] ?? (key.includes('token') || key.includes('key') ? 'api-token' : 'generic'), label: key });
  }

  return found.sort((a, b) => a.start - b.start);
}

function looksLikeUrlPassword(pass: string): boolean {
  if (pass.length < 4) return false;
  if (/^[$%{<*]|^\[secret:/.test(pass)) return false;
  if (PLACEHOLDER_WORDS.has(pass.toLowerCase())) return false;
  return true;
}

function decodeSafe(s: string): string {
  try { return decodeURIComponent(s); } catch { return s; }
}

/** Replace detected spans with `replacement(detected, index)`. */
export function replaceDetected(text: string, detected: DetectedSecret[], replacement: (d: DetectedSecret, i: number) => string): string {
  let out = '';
  let at = 0;
  detected.forEach((d, i) => {
    out += text.slice(at, d.start) + replacement(d, i);
    at = d.end;
  });
  return out + text.slice(at);
}
