/**
 * Security patterns shared by every place AICO looks for them: the repository's
 * own gates (`scripts/check-standards.mjs` secret scan, `scripts/security-scan.mjs`)
 * and the agent's verification of code it writes for users
 * (`src/security/project-scan.ts`, the `security` check in RunChecks).
 *
 * Why plain JavaScript with a `.d.mts` beside it: the standards job in CI runs
 * with node and git only — no `npm install`, no build — so the checker must be
 * able to import this file as it stands, and the engine bundles it through
 * tsup like any other module. One copy of the patterns, so the secret shapes
 * the pre-push hook refuses are exactly the ones the agent refuses in a user's
 * diff; two copies drift, and the drift is found by a leaked key.
 *
 * What it deliberately is not: a parser or a taint engine. These are
 * line-level patterns chosen for precision over recall — a scanner that cries
 * wolf gets bypassed — and CodeQL (`.github/workflows/codeql.yml`) is the deep
 * pass. Every rule names the fix, and every finding can be waived on its own
 * line (or the line above) with `security-allow: <rule-id> — reason`, which is
 * greppable and reviewed like any other change.
 *
 * Imports nothing: `shared/` may not depend on `src/`, `web/` or `desktop/`.
 */

/**
 * Secrets: high-confidence shapes only. Generic "password=" heuristics are
 * deliberately absent; they fire on every config loader and teach people to
 * ignore the scan.
 */
export const SECRET_PATTERNS = [
  { name: 'Anthropic API key', re: /\bsk-ant-(?:api|admin)\d{2}-[A-Za-z0-9_-]{40,}/g },
  { name: 'OpenRouter API key', re: /\bsk-or-v1-[a-f0-9]{48,}/g },
  { name: 'OpenAI project key', re: /\bsk-(?:proj|svcacct|admin)-[A-Za-z0-9_-]{40,}/g },
  { name: 'sk- style API key', re: /\bsk-[A-Za-z0-9]{32,}\b/g, entropy: 3.6 },
  { name: 'AWS access key id', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { name: 'GitHub token', re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b/g },
  { name: 'GitHub fine-grained token', re: /\bgithub_pat_[A-Za-z0-9_]{60,}\b/g },
  { name: 'Google API key', re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { name: 'Slack token', re: /\bxox[abprs]-[A-Za-z0-9-]{20,}\b/g },
  { name: 'Stripe live key', re: /\b(?:sk|rk)_live_[0-9A-Za-z]{24,}\b/g },
  { name: 'npm token', re: /\bnpm_[A-Za-z0-9]{36}\b/g },
  { name: 'Hugging Face token', re: /\bhf_[A-Za-z]{34,}\b/g },
  // The header followed by key material. The header alone is how code that
  // *writes* keys spells the format (src/vault/generate.ts), not a key.
  { name: 'private key block', re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY-----\r?\n(?:[A-Za-z0-9+/=]{40,}\r?\n)+/g, strict: true },
];

/** A real key is random; one that spells a placeholder word is a fixture. */
export const PLACEHOLDER = /(test|fake|dummy|example|sample|canary|redact|placeholder|xxxx|0000|1234|abcd|your|mock)/i;

/** Files that must never be tracked, whatever they contain. */
export const SECRET_FILES = /(?:^|\/)(?:\.env(?:\.(?!example$)[^/]+)?|id_rsa|id_ed25519|[^/]+\.pem|[^/]+\.p12|[^/]+\.pfx|[^/]+\.key)$/i;

/** Shannon entropy in bits per character. */
export function shannon(s) {
  const counts = {};
  for (const ch of s) counts[ch] = (counts[ch] ?? 0) + 1;
  let h = 0;
  for (const n of Object.values(counts)) { const p = n / s.length; h -= p * Math.log2(p); }
  return h;
}

function lineAt(text, index) {
  const start = text.lastIndexOf('\n', index) + 1;
  const end = text.indexOf('\n', index);
  return { line: text.slice(0, index).split('\n').length, text: text.slice(start, end === -1 ? undefined : end) };
}

/**
 * Secret-shaped values in a text. Never returns the value: a finding is
 * printed to CI logs and handed to the model, so only a six-character prefix
 * and the length leave this function.
 *
 * @param {string} text
 * @param {{ allowMarker?: RegExp }} [opts]
 */
export function findSecrets(text, opts = {}) {
  const allow = opts.allowMarker ?? /standards-allow:\s*secret|security-allow:\s*secret/i;
  const out = [];
  for (const { name, re, entropy, strict } of SECRET_PATTERNS) {
    for (const m of text.matchAll(re)) {
      const token = m[0];
      if (!strict && PLACEHOLDER.test(token)) continue;
      if (entropy && shannon(token.slice(3)) < entropy) continue;
      const at = lineAt(text, m.index);
      if (allow.test(at.text)) continue;
      out.push({ name, line: at.line, preview: `${token.slice(0, 6)}…`, length: token.length });
    }
  }
  return out;
}

// ── code rules ──────────────────────────────────────────────────────────────

/** File kinds the code rules understand. */
export function languageOf(file) {
  if (/\.(?:[cm]?[jt]sx?)$/i.test(file)) return 'js';
  if (/\.pyw?$/i.test(file)) return 'py';
  if (/\.go$/i.test(file)) return 'go';
  return null;
}

/**
 * The line with string-literal *text* blanked, keeping template `${…}`
 * expressions. "console.log('token refreshed')" names no variable; this is how
 * the secret-in-log rule tells the two apart without a parser.
 */
export function codeOnly(line) {
  return codeState(line).code;
}

/**
 * As `codeOnly`, and whether the line ends inside a template literal that
 * continues on the next line (a multi-line prompt or HTML string is text, not
 * code — `scanCode` skips its body).
 */
export function codeState(line) {
  let out = '';
  let open = false;
  let i = 0;
  while (i < line.length) {
    const c = line[i];
    if (c === '/' && line[i + 1] === '/') break;
    if (c === "'" || c === '"') {
      const q = c; i++;
      while (i < line.length && line[i] !== q) { if (line[i] === '\\') i++; i++; }
      out += q + q; i++;
      continue;
    }
    if (c === '`') {
      i++;
      out += '`';
      while (i < line.length && line[i] !== '`') {
        if (line[i] === '\\') { i += 2; continue; }
        if (line[i] === '$' && line[i + 1] === '{') {
          let depth = 1; let j = i + 2;
          while (j < line.length && depth > 0) { if (line[j] === '{') depth++; else if (line[j] === '}') depth--; j++; }
          out += '${' + line.slice(i + 2, j - 1) + '}';
          i = j;
          continue;
        }
        i++;
      }
      if (i >= line.length) open = true;
      out += '`'; i++;
      continue;
    }
    out += c; i++;
  }
  return { code: out, open };
}

const SECRETISH = /\b(?:api_?key|apikey|secret|password|passwd|passphrase|private_?key|access_?token|refresh_?token|auth_?token|bearer|token|credentials?)\b/i;

/**
 * Generic rules: what the agent checks in a user's project, and the base the
 * repository scan builds on. Each has an id (the waiver names it), a severity
 * (`high` fails the agent's gate; `medium` is reported), the languages it
 * applies to, a line test, and the fix.
 *
 * `test(line, ctx)` gets the raw line; `ctx.code` is the line with literal
 * text blanked, `ctx.file` the path, `ctx.text` the whole file, `ctx.lines`
 * all lines and `ctx.index` this line's index.
 */
export const GENERIC_RULES = [
  {
    id: 'exec-interpolated', severity: 'high', langs: ['js'],
    test: (l, c) => /\bchild_process\b|\bexecSync\b|from ['"](?:node:)?child_process['"]/.test(c.text)
      && /(?<![\w.])(?:exec|execSync)\s*\(\s*(?:`[^`]*\$\{|['"][^'"]*['"]\s*\+|[^'"`),]*\+|[A-Za-z_$][\w$.]*\s*[,)])/.test(l)
      && !/\bexecFile/.test(l),
    message: 'shell command built from a variable or template (command injection)',
    fix: 'use execFile/spawn with an argument array; never put untrusted text in a shell string',
  },
  {
    id: 'shell-true', severity: 'medium', langs: ['js'],
    test: (l) => /\bshell\s*:\s*true\b/.test(l),
    message: 'process spawned through a shell',
    fix: 'drop shell: true, or quote every argument (Windows paths contain spaces) and never pass untrusted text',
  },
  {
    id: 'eval', severity: 'high', langs: ['js'],
    test: (l, c) => /(?<![\w.$])eval\s*\(|\bnew\s+Function\s*\(/.test(c.code),
    message: 'eval / new Function runs a string as code',
    fix: 'parse the data (JSON.parse) or dispatch on a fixed table instead of evaluating text',
  },
  {
    id: 'inner-html', severity: 'medium', langs: ['js'],
    test: (l, c) => (/\.(?:innerHTML|outerHTML)\s*\+?=(?!=)|\binsertAdjacentHTML\s*\(|\bdocument\.write(?:ln)?\s*\(|\bdangerouslySetInnerHTML\b/.test(c.code))
      && !/\.(?:innerHTML|outerHTML)\s*\+?=\s*(?:''|""|``)\s*;?\s*$/.test(c.code)
      && !/\b(?:sanitize\w*|sanitise\w*|DOMPurify|escapeHtml|escapeHTML|renderToString|iconSvg)\s*\(/.test(l),
    message: 'HTML from a variable inserted into the page (XSS)',
    fix: 'render text with textContent / JSX, or pass the HTML through the sanitiser first (and say which one on the line)',
  },
  {
    id: 'tls-verify-off', severity: 'high', langs: ['js', 'py', 'go'],
    test: (l, c) => /NODE_TLS_REJECT_UNAUTHORIZED['"]?\s*[:=]\s*['"]?0|StrictHostKeyChecking=no/.test(l)
      || /\brejectUnauthorized\s*:\s*false|\bstrictSSL\s*:\s*false|\bhostVerifier\s*:\s*\([^)]*\)\s*=>\s*true|\bverify\s*=\s*False\b|\bInsecureSkipVerify\s*:\s*true|\bCERT_NONE\b/.test(c.code),
    message: 'TLS or host-key verification turned off',
    fix: 'keep verification on; trust a specific CA or pinned host key instead of switching the check off',
  },
  {
    id: 'weak-random-secret', severity: 'medium', langs: ['js', 'py'],
    test: (l) => /\bMath\.random\s*\(|\brandom\.(?:random|randint|choice|choices|getrandbits)\s*\(/.test(l)
      && /token|secret|nonce|password|passwd|salt|session|csrf|otp|api_?key|invite|reset/i.test(l),
    message: 'non-cryptographic randomness used for something secret',
    fix: 'use crypto.randomBytes / crypto.randomUUID (Node) or secrets.token_urlsafe (Python)',
  },
  {
    id: 'secret-in-log', severity: 'medium', langs: ['js', 'py'],
    test: (l, c) => {
      const call = /\b(?:console\.(?:log|info|warn|error|debug|trace)|logger\.\w+|log\.\w+|print)\s*\((.*)/.exec(c.code);
      return !!call && SECRETISH.test(call[1].replace(/\b[\w$]+\.(?:length|name|id|label|kind|type|prefix)\b/g, '').replace(/\bhas\w*\(|\bis\w*\(/g, ''));
    },
    message: 'a credential-named value is written to a log',
    fix: 'log that it exists (a short prefix and the length at most), never the value',
  },
  {
    id: 'sql-interpolated', severity: 'high', langs: ['js', 'py', 'go'],
    test: (l) => /\.(?:query|execute|executemany|raw|prepare|all|get|run|Query|QueryRow|Exec)\s*\(\s*(?:`[^`]*\b(?:SELECT|INSERT|UPDATE|DELETE|WHERE)\b[^`]*\$\{|f["'][^"']*\b(?:SELECT|INSERT|UPDATE|DELETE|WHERE)\b[^"']*\{|["'][^"']*\b(?:SELECT|INSERT|UPDATE|DELETE|WHERE)\b[^"']*["']\s*(?:\+|%)|fmt\.Sprintf\()/i.test(l),
    message: 'SQL built by string interpolation (SQL injection)',
    fix: 'use placeholders (? / $1 / %s parameters) and pass the values separately',
  },
  {
    id: 'py-shell', severity: 'high', langs: ['py'],
    test: (l) => /\bsubprocess\.\w+\(.*\bshell\s*=\s*True/.test(l) || /\bos\.(?:system|popen)\s*\(/.test(l),
    message: 'shell command from Python (command injection when any part is untrusted)',
    fix: 'subprocess.run([...], shell=False) with an argument list',
  },
  {
    id: 'py-eval', severity: 'high', langs: ['py'],
    test: (l, c) => /(?<![\w.])(?:eval|exec)\s*\(/.test(c.code),
    message: 'eval / exec runs a string as code',
    fix: 'ast.literal_eval for data, or a dispatch table',
  },
  {
    id: 'py-unsafe-deserialise', severity: 'high', langs: ['py'],
    test: (l) => /\b(?:pickle|cPickle|marshal|shelve)\.loads?\s*\(/.test(l) || (/\byaml\.load\s*\(/.test(l) && !/SafeLoader|safe_load/.test(l)),
    message: 'deserialising data that can run code',
    fix: 'json, or yaml.safe_load; never unpickle data from outside the process',
  },
  {
    id: 'go-shell', severity: 'medium', langs: ['go'],
    test: (l) => /\bexec\.Command(?:Context)?\s*\((?:ctx,\s*)?"(?:sh|bash|cmd|cmd\.exe|powershell)"\s*,\s*"(?:-c|\/c|\/C|-Command)"/.test(l),
    message: 'command run through a shell',
    fix: 'exec.Command(program, args...) without a shell',
  },
];

/** `security-allow: <id>` on the line, or on a comment line directly above it. */
export function isWaived(lines, index, id) {
  const re = new RegExp(`security-allow:\\s*(?:[\\w-]+\\s*,\\s*)*${id.replace(/[-]/g, '\\-')}\\b`);
  if (re.test(lines[index] ?? '')) return true;
  const prev = lines[index - 1] ?? '';
  return /^\s*(?:\/\/|#|\*|\/\*)/.test(prev) && re.test(prev);
}

/**
 * Run code rules over one file. Returns findings with 1-based line numbers
 * and the trimmed source line (the repository baseline fingerprints on it).
 *
 * @param {string} file  path, used for the language and for rules that look at it
 * @param {string} text  the file's content
 * @param {Array<object>} [rules]  defaults to GENERIC_RULES
 */
export function scanCode(file, text, rules = GENERIC_RULES) {
  const lang = languageOf(file);
  if (!lang) return [];
  const lines = text.split(/\r?\n/);
  const out = [];
  const active = rules.filter(r => r.langs.includes(lang) && (!r.files || r.files.test(file.replace(/\\/g, '/'))));
  if (active.length === 0) return out;
  let inBlock = false;
  let inTemplate = false;
  for (let i = 0; i < lines.length; i++) {
    let raw = lines[i];
    if (raw.length > 2000) continue; // minified or generated
    if (lang === 'js' && inTemplate) {
      // Inside a multi-line template literal: text until its closing backtick.
      let j = 0; let close = -1;
      while (j < raw.length) { if (raw[j] === '\\') { j += 2; continue; } if (raw[j] === '`') { close = j; break; } j++; }
      if (close < 0) continue;
      inTemplate = false;
      raw = ' '.repeat(close + 1) + raw.slice(close + 1);
    }
    const trimmed = raw.trim();
    // Comments describe code; they are not code.
    if (lang !== 'py') {
      if (inBlock) { if (trimmed.includes('*/')) inBlock = false; continue; }
      if (trimmed.startsWith('/*')) { if (!trimmed.includes('*/')) inBlock = true; continue; }
      if (trimmed.startsWith('*') || trimmed.startsWith('//')) continue;
    } else if (trimmed.startsWith('#')) continue;
    const state = lang === 'py' ? { code: raw.replace(/#.*$/, ''), open: false } : codeState(raw);
    if (state.open) inTemplate = true;
    const ctx = { file, text, lines, index: i, lang, code: state.code };
    for (const rule of active) {
      let hit = false;
      try { hit = rule.test(raw, ctx); } catch { hit = false; /* a rule bug must not stop the scan */ }
      if (!hit || isWaived(lines, i, rule.id)) continue;
      out.push({ rule: rule.id, severity: rule.severity, line: i + 1, source: trimmed.slice(0, 200), message: rule.message, fix: rule.fix });
    }
  }
  return out;
}
