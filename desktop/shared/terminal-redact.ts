/**
 * Making terminal output safe to hand on: to a chat message, to the agent's
 * `ide_terminal_read`, to a saved script.
 *
 * WHY. A terminal is where people print `.env` files, paste tokens into
 * `curl -H "Authorization: …"`, and see `postgres://user:pass@host` in a stack
 * trace. "Explain this failure" used to mean copying that into the chat by
 * hand. Now one click does it, so the copy has to be cleaner than a hand copy.
 *
 * Three steps, all pure:
 *  - `stripAnsi` — colour, cursor movement, OSC marks (including our own
 *    shell-integration marks) and carriage-return overdraws removed, so what
 *    is left is what a person saw;
 *  - `maskSecrets` — the engine's high-confidence secret shapes (token
 *    prefixes, `password=…`-style keyed values, `scheme://user:pass@`, PEM
 *    private keys). A LOCAL COPY of `src/vault/scan.ts` TOKEN_RULES /
 *    URL_CREDENTIALS / KEYED / `looksLikeSecret` and `src/tools/ops/common.ts`
 *    ENV_KEYED: the desktop shared code must not import the engine
 *    (architecture.md). `desktop/scripts/test-terminal.mjs` runs both on the
 *    same fixtures, so a drift fails a test;
 *  - `clipTail` — bounded, keeping the end (where the error is).
 *
 * What this cannot do: remove values the vault holds that have no recognisable
 * shape. That is the engine's sink redactor, and it runs on everything the
 * agent reads (tool results) and every message a person submits (scan). See
 * ADR 0019.
 *
 * @module desktop/shared/terminal-redact
 */

/** CSI, OSC (BEL or ST terminated), DCS/APC/PM strings, and two-byte escapes. */
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[P^_][^\x1b]*\x1b\\|\x1b[@-Z\\-_]|\x9b[0-?]*[ -/]*[@-~]/g;

/**
 * What a person saw: escapes removed, `\r` overdraws resolved (a progress bar
 * leaves its last state), backspaces applied, other control characters
 * dropped. Line endings become `\n`.
 */
export function stripAnsi(text: string): string {
  if (!text) return '';
  const plain = text.replace(ANSI, '').replace(/\r\n/g, '\n');
  const lines = plain.split('\n').map((line) => {
    // A bare \r returns to column 0: the last segment overwrites earlier ones.
    let out = '';
    for (const seg of line.split('\r')) out = seg.length >= out.length ? seg : seg + out.slice(seg.length);
    // Backspace erases the previous character (readline redraws, typed corrections).
    let res = '';
    for (const ch of out) {
      if (ch === '\b') res = res.slice(0, -1);
      else res += ch;
    }
    return res.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
  });
  return lines.join('\n');
}

// ── the secret shapes (copied from the engine; see the module header) ──

interface Rule { label: string; re: RegExp; group?: number }

const TOKEN_RULES: Rule[] = [
  { label: 'private-key', re: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----[\s\S]+?-----END (?:[A-Z0-9]+ )*PRIVATE KEY-----/g },
  { label: 'anthropic-key', re: /\bsk-ant-(?:api|admin)\d{2}-[A-Za-z0-9_-]{20,}/g },
  { label: 'openai-key', re: /\bsk-(?:proj-|svcacct-|admin-)?(?!ant-)[A-Za-z0-9_-]{32,}/g },
  { label: 'github-token', re: /\bgh[pousr]_[A-Za-z0-9]{36,255}\b/g },
  { label: 'github-token', re: /\bgithub_pat_[A-Za-z0-9_]{22,255}\b/g },
  { label: 'slack-token', re: /\bxox[abposr]-[A-Za-z0-9-]{10,}/g },
  { label: 'slack-webhook', re: /https:\/\/hooks\.slack\.com\/services\/T[A-Z0-9]+\/B[A-Z0-9]+\/[A-Za-z0-9]{16,}/g },
  { label: 'stripe-key', re: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b/g },
  { label: 'google-api-key', re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { label: 'aws-access-key-id', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { label: 'aws-secret-key', re: /\baws_?secret_?access_?key\b["']?\s*[:=]\s*["']?([A-Za-z0-9/+=]{40})\b/gi, group: 1 },
];

const URL_CREDENTIALS = /\b([a-z][a-z0-9+.-]{1,20}):\/\/([^\s:@/"'<>]{1,128}):([^\s@/"'<>]{1,256})@([A-Za-z0-9.-]+|\[[0-9a-fA-F:]+\])(?::(\d{1,5}))?/gi;
const KEYED = /\b(password|passwd|passphrase|pwd|secret|client[_-]?secret|api[_-]?key|apikey|access[_-]?token|auth[_-]?token|bearer[_-]?token|token)\b["']?(\s*[:=]\s*|\s+is\s+)(["'`]?)([^\s"'`,;()[\]{}<>]{6,200})\3/gi;
const ENV_KEYED = /[A-Za-z0-9_.-]*(?:password|passwd|passphrase|secret|token|api[_-]?key|apikey|private[_-]?key)[A-Za-z0-9_.-]*["']?\s*[:=]\s*(["'`]?)([^\s"'`,;()[\]{}<>]{6,200})\1/gi;
/** `Authorization: Bearer x` / `-H "X-Api-Key: x"` — header values in commands people type. */
const AUTH_HEADER = /\b(authorization|proxy-authorization)\s*:\s*(?:bearer|basic|token)\s+([A-Za-z0-9._~+/=-]{8,})/gi;

const PLACEHOLDER_WORDS = new Set([
  'password', 'passwd', 'changeme', 'required', 'optional', 'undefined', 'null', 'none', 'true', 'false',
  'string', 'secret', 'example', 'redacted', 'placeholder', 'expired', 'invalid', 'missing', 'yourpassword',
  'your_password', 'your-password', 'mypassword', 'xxxxxx', 'hidden', 'masked', 'empty', 'unknown', 'default',
]);

/** Same rule as `src/vault/scan.ts looksLikeSecret`. */
export function looksLikeSecret(value: string, separator: string): boolean {
  const v = value.trim();
  if (v.length < 6) return false;
  if (PLACEHOLDER_WORDS.has(v.toLowerCase())) return false;
  if (/^[$%]|^\{\{|^<|^\*+$|^x+$|^\.{3}|^\[secret:|^\[masked /i.test(v)) return false;
  if (/^(?:process\.env|os\.environ|env\.|secrets\.|vars\.|config\.|settings\.)/i.test(v)) return false;
  if (/^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)+$/.test(v)) return false;
  if (/^[A-Za-z_]+$/.test(v) && !/[a-z].*[A-Z]|[A-Z].*[a-z]/.test(v.replace(/_/g, ''))) return false;
  if (/^[A-Za-z_][A-Za-z_]*$/.test(v) && v.includes('_')) return false;
  if (/\bis\b/.test(separator) && /^[a-z]+$/i.test(v)) return false;
  if (/^https?:\/\//i.test(v)) return false;
  return /\d/.test(v) || /[^A-Za-z0-9]/.test(v) || (/[a-z]/.test(v) && /[A-Z]/.test(v));
}

interface Span { start: number; end: number; label: string }

const overlaps = (spans: Span[], start: number, end: number): boolean => spans.some(s => start < s.end && end > s.start);

/** Every secret-shaped span, non-overlapping, in order. */
export function findSecrets(text: string): Span[] {
  // `{{secret:name}}` references are names, not values (scan.ts maskReferences).
  const t = text.replace(/\{\{\s*secret:[^}\n]{0,100}\}\}|\[secret:[^\]\n]{0,100}\]/gi, m => ' '.repeat(m.length));
  const found: Span[] = [];
  const add = (start: number, end: number, label: string): void => { if (!overlaps(found, start, end)) found.push({ start, end, label }); };
  for (const rule of TOKEN_RULES) {
    for (const m of t.matchAll(rule.re)) {
      const value = m[rule.group ?? 0];
      if (!value) continue;
      const start = m.index! + (rule.group ? m[0].indexOf(value) : 0);
      add(start, start + value.length, rule.label);
    }
  }
  for (const m of t.matchAll(URL_CREDENTIALS)) {
    const pass = m[3]!;
    if (pass.length < 4 || /^[$%{<*]|^\[secret:/.test(pass) || PLACEHOLDER_WORDS.has(pass.toLowerCase())) continue;
    const start = m.index! + m[0].indexOf(`:${pass}@`) + 1;
    add(start, start + pass.length, 'url-password');
  }
  for (const m of t.matchAll(AUTH_HEADER)) {
    const value = m[2]!;
    const start = m.index! + m[0].lastIndexOf(value);
    add(start, start + value.length, 'auth-header');
  }
  for (const m of t.matchAll(KEYED)) {
    const value = m[4];
    if (!value || !looksLikeSecret(value, m[2]!)) continue;
    const start = m.index! + m[0].lastIndexOf(value);
    add(start, start + value.length, m[1]!.toLowerCase().replace(/_/g, '-'));
  }
  for (const m of t.matchAll(ENV_KEYED)) {
    const value = m[2]!;
    if (!looksLikeSecret(value, '=')) continue;
    if (/^(?:\/|\.{1,2}\/|~\/|[A-Za-z]:[\\/])[\w./\\~-]*$/.test(value)) continue;
    const start = m.index! + m[0].lastIndexOf(value);
    add(start, start + value.length, 'keyed value');
  }
  return found.sort((a, b) => a.start - b.start);
}

/** Replace every secret-shaped value with `[masked <what>]`. */
export function maskSecrets(text: string): { text: string; masked: number } {
  if (!text) return { text: '', masked: 0 };
  const spans = findSecrets(text);
  if (!spans.length) return { text, masked: 0 };
  let out = '';
  let at = 0;
  for (const s of spans) { out += text.slice(at, s.start) + `[masked ${s.label}]`; at = s.end; }
  return { text: out + text.slice(at), masked: spans.length };
}

/** Keep the last `max` characters, cut at a line start when one is near, and say so. */
export function clipTail(text: string, max: number): string {
  if (text.length <= max) return text;
  let cut = text.length - max;
  const nl = text.indexOf('\n', cut);
  if (nl >= 0 && nl - cut < 200) cut = nl + 1;
  return `… (${cut} earlier characters not shown)\n${text.slice(cut)}`;
}

/** The whole pipeline: what a person saw, secrets masked, bounded. */
export function redactOutput(raw: string, max = 4000): { text: string; masked: number } {
  const plain = stripAnsi(raw).replace(/\n{4,}/g, '\n\n\n').trimEnd();
  const m = maskSecrets(plain);
  return { text: clipTail(m.text, max), masked: m.masked };
}

/** A command line for a chat message or a script: secrets masked, single line kept as typed. */
export function redactCommand(command: string): string {
  return maskSecrets(stripAnsi(command)).text.trim();
}
