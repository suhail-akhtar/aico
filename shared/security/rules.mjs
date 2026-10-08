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
  if (/\.java$/i.test(file)) return 'java';
  if (/\.php\d?$/i.test(file)) return 'php';
  if (/\.cs$/i.test(file)) return 'cs';
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

  // ── Java, PHP and C# (ADR 0033), and rules that apply across languages ──
  // Line-level and tuned for precision, like the rules above; every one is waivable
  // on its line with `security-allow: <id> — reason`.
  {
    id: 'cmd-injection', severity: 'high', langs: ['java'],
    test: (l) => /\bRuntime\.getRuntime\(\)\.exec\s*\(\s*(?:"[^"]*"\s*\+|[A-Za-z_]\w*\s*[,)])/.test(l)
      || /\bnew\s+ProcessBuilder\s*\(.*"(?:sh|bash|cmd|cmd\.exe|powershell)"\s*,\s*"(?:-c|\/c|-Command)"/.test(l),
    message: 'shell command built from a variable (command injection)',
    fix: 'ProcessBuilder with an argument list and no shell; never put untrusted text in a command string',
  },
  {
    id: 'cmd-injection', severity: 'high', langs: ['php'],
    test: (l) => (/\b(?:shell_exec|exec|system|passthru|popen|proc_open|pcntl_exec)\s*\([^;]*\$/.test(l) || /`[^`]*\$\w+[^`]*`/.test(l))
      && !/escapeshell(?:arg|cmd)\s*\(/.test(l),
    message: 'shell command built from a variable (command injection)',
    fix: 'escapeshellarg() on every argument, or proc_open with an argument array; better, use a PHP library instead of a shell',
  },
  {
    id: 'cmd-injection', severity: 'high', langs: ['cs'],
    test: (l, c) => /\bProcess\.Start\s*\(\s*(?:\$@?"|@?"[^"]*"\s*\+)/.test(l)
      || (/\bArguments\s*=\s*(?:\$@?"[^"]*\{|@?"[^"]*"\s*\+\s*[A-Za-z_])/.test(l) && /\b(?:cmd(?:\.exe)?|\/bin\/(?:ba)?sh|powershell|pwsh)\b/i.test(c.text)),
    message: 'process or shell command built from a variable (command injection)',
    fix: 'ProcessStartInfo with ArgumentList (no shell, no string building); never put untrusted text in a command line',
  },
  {
    id: 'eval', severity: 'high', langs: ['php'],
    test: (l, c) => /(?<![\w>$:])eval\s*\(/.test(c.code),
    message: 'eval runs a string as code',
    fix: 'parse the data (json_decode) or dispatch on a fixed table instead of evaluating text',
  },
  {
    id: 'eval', severity: 'high', langs: ['java'],
    test: (l, c) => /\.eval\s*\(/.test(c.code) && /\b(?:ScriptEngine|ScriptEngineManager|GroovyShell|Nashorn)\b/.test(c.text),
    message: 'a script engine evaluates a string as code',
    fix: 'do not evaluate text; parse the data or dispatch on a fixed table',
  },
  {
    id: 'eval', severity: 'high', langs: ['cs'],
    test: (l) => /\bCSharpScript\.(?:EvaluateAsync|RunAsync)\s*\(/.test(l),
    message: 'Roslyn scripting evaluates a string as code',
    fix: 'do not evaluate text; parse the data or dispatch on a fixed table',
  },
  {
    id: 'sql-interpolated', severity: 'high', langs: ['java'],
    test: (l) => /\.(?:executeQuery|executeUpdate|execute|prepareStatement|prepareCall|createQuery|createNativeQuery|queryForObject|queryForList|query|update)\s*\(\s*(?:"[^"]*\b(?:SELECT|INSERT|UPDATE|DELETE|WHERE)\b[^"]*"\s*\+\s*[A-Za-z_(]|String\.format\s*\(\s*"[^"]*\b(?:SELECT|INSERT|UPDATE|DELETE|WHERE)\b)/i.test(l)
      || /\bString\s+\w*(?:sql|query)\w*\s*=\s*"[^"]*\b(?:SELECT|INSERT|UPDATE|DELETE|WHERE)\b[^"]*"\s*\+\s*[A-Za-z_(]/i.test(l),
    message: 'SQL built by string concatenation (SQL injection)',
    fix: 'PreparedStatement with ? placeholders (or named parameters) and set the values separately',
  },
  {
    id: 'sql-interpolated', severity: 'high', langs: ['php'],
    test: (l) => /(?:\b(?:mysqli_query|mysql_query|pg_query)|->(?:query|exec|prepare))\s*\(\s*(?:\$\w+\s*,\s*)?(?:"[^"]*\b(?:SELECT|INSERT|UPDATE|DELETE|WHERE)\b[^"]*\$\w|'[^']*\b(?:SELECT|INSERT|UPDATE|DELETE|WHERE)\b[^']*'\s*\.\s*\$)/i.test(l)
      || /\$\w*(?:sql|query)\w*\s*=\s*(?:"[^"]*\b(?:SELECT|INSERT|UPDATE|DELETE|WHERE)\b[^"]*\$\w|'[^']*\b(?:SELECT|INSERT|UPDATE|DELETE|WHERE)\b[^']*'\s*\.\s*\$)/i.test(l),
    message: 'SQL built by string interpolation (SQL injection)',
    fix: 'PDO prepared statements: prepare("... WHERE id = ?") then execute([$id])',
  },
  {
    id: 'sql-interpolated', severity: 'high', langs: ['cs'],
    test: (l) => /\b(?:new\s+(?:Sql|Npgsql|MySql|Oracle|SQLite)Command|FromSqlRaw|ExecuteSqlRaw|ExecuteSqlCommand|Query|QueryAsync|Execute|ExecuteAsync)\s*(?:<[^>]*>)?\s*\(\s*(?:\$@?"[^"]*\b(?:SELECT|INSERT|UPDATE|DELETE|WHERE)\b[^"]*\{|@?"[^"]*\b(?:SELECT|INSERT|UPDATE|DELETE|WHERE)\b[^"]*"\s*\+\s*[A-Za-z_])/i.test(l)
      || /\b\w*(?:sql|query)\w*\s*=\s*(?:\$@?"[^"]*\b(?:SELECT|INSERT|UPDATE|DELETE|WHERE)\b[^"]*\{|@?"[^"]*\b(?:SELECT|INSERT|UPDATE|DELETE|WHERE)\b[^"]*"\s*\+\s*[A-Za-z_])/i.test(l),
    message: 'SQL built by string interpolation (SQL injection)',
    fix: 'parameters (SqlParameter / Dapper anonymous object / FromSqlInterpolated); never splice values into the text',
  },
  {
    id: 'tls-verify-off', severity: 'high', langs: ['java'],
    test: (l) => /\bALLOW_ALL_HOSTNAME_VERIFIER\b|\bNoopHostnameVerifier\b|\bTrustAllStrategy\b|\bTrustSelfSignedStrategy\b|\bInsecureTrustManagerFactory\b|\bsetHostnameVerifier\s*\(\s*\(?[\w, ]*\)?\s*->\s*true\b/.test(l),
    message: 'TLS certificate or host-name verification turned off',
    fix: 'keep verification on; trust a specific CA or pinned certificate instead of switching the check off',
  },
  {
    id: 'tls-verify-off', severity: 'high', langs: ['php'],
    test: (l) => /\bCURLOPT_SSL_VERIFY(?:PEER|HOST)\s*,\s*(?:false|0)\b|['"]verify['"]\s*=>\s*false\b|['"]verify_peer(?:_name)?['"]\s*=>\s*false\b/i.test(l),
    message: 'TLS certificate verification turned off',
    fix: 'keep verification on; point CURLOPT_CAINFO / the client\'s verify option at a CA bundle instead',
  },
  {
    id: 'tls-verify-off', severity: 'high', langs: ['cs'],
    test: (l) => /\bDangerousAcceptAnyServerCertificateValidator\b|\bServerCertificate(?:Custom)?ValidationCallback\s*\+?=\s*[^;]*(?:=>\s*true\b|delegate\s*\{\s*return\s+true)/.test(l),
    message: 'TLS certificate validation turned off',
    fix: 'keep validation on; trust a specific certificate (pinning) instead of accepting any',
  },
  {
    id: 'hardcoded-credential', severity: 'high', langs: ['js', 'py', 'go', 'java', 'php', 'cs'],
    test: (l, c) => {
      // A test file's credentials are fixtures (secret SHAPES are still found by findSecrets everywhere).
      if (/(?:^|[\\/])(?:__tests__|tests?|spec|e2e|fixtures?|testdata)[\\/]|[._-](?:test|spec)\.[a-z]+$|_test\.(?:go|py)$|(?:Tests?|IT)\.(?:java|cs|php)$/i.test(c.file)) return false;
      // The conventional "this one is deliberate" markers of other scanners are honoured too.
      if (/\b(?:nosec|nolint|noqa|NOSONAR)\b|pragma:\s*allowlist\s*secret|gitleaks:allow|standards-allow:\s*secret/i.test(l)) return false;
      const m = /(['"]?)([\w$.-]*(?:password|passwd|pwd|secret|api_?key|apikey|access_?key|auth_?token|access_?token|private_?key|client_?secret)[\w$.-]*)\1\s*(?:=>|:=|=|:)\s*@?(['"])([^'"\\\r\n]{8,200})\3/i.exec(l);
      return !!m && plausibleSecret(m[2], m[4]);
    },
    message: 'a credential-named value is set to a literal',
    fix: 'read it from an environment variable or the credential vault; never put the value in source',
  },
  {
    id: 'unsafe-deserialise', severity: 'high', langs: ['js'],
    test: (l, c) => /\.unserialize\s*\(/.test(l) && /node-serialize/.test(c.text),
    message: 'node-serialize unserialize runs code embedded in the data',
    fix: 'JSON.parse; never unserialize data from outside the process',
  },
  {
    id: 'unsafe-deserialise', severity: 'high', langs: ['java'],
    test: (l) => /\bnew\s+ObjectInputStream\s*\(|\bnew\s+XMLDecoder\s*\(|\.enableDefaultTyping\s*\(|\bnew\s+Yaml\s*\(\s*\)\s*\.load\s*\(/.test(l),
    message: 'deserialising data that can run code',
    fix: 'JSON with a fixed schema; for Java serialisation set an ObjectInputFilter allow-list; SnakeYAML with SafeConstructor',
  },
  {
    id: 'unsafe-deserialise', severity: 'high', langs: ['php'],
    test: (l, c) => /(?<![\w>:$])unserialize\s*\(/.test(c.code) && !/allowed_classes/.test(l),
    message: 'unserialize() on data can instantiate arbitrary classes',
    fix: 'json_decode; or unserialize($data, [\'allowed_classes\' => false])',
  },
  {
    id: 'unsafe-deserialise', severity: 'high', langs: ['cs'],
    test: (l) => /\bnew\s+(?:BinaryFormatter|NetDataContractSerializer|SoapFormatter|LosFormatter)\b|\bTypeNameHandling\s*=\s*TypeNameHandling\.(?:All|Auto|Objects|Arrays)\b/.test(l),
    message: 'deserialising data that can run code',
    fix: 'System.Text.Json or a fixed-type serializer; never BinaryFormatter, and never TypeNameHandling on untrusted input',
  },
  {
    id: 'unescaped-output', severity: 'medium', langs: ['php'],
    test: (l, c) => /\b(?:echo|print)\b[^;]*\$_(?:GET|POST|REQUEST|COOKIE)\b/.test(c.code) && !/htmlspecialchars|htmlentities|esc_html|esc_attr|intval|\(int\)|absint/.test(l),
    message: 'request data echoed into the page without escaping (XSS)',
    fix: 'htmlspecialchars($value, ENT_QUOTES, \'UTF-8\') on output, or a template engine that escapes',
  },
  {
    id: 'unescaped-output', severity: 'medium', langs: ['cs'],
    test: (l) => /\bHtml\.Raw\s*\(\s*[A-Za-z_@]/.test(l),
    message: 'Html.Raw on a variable outputs it without encoding (XSS)',
    fix: 'let Razor encode it (@value), or encode explicitly before Html.Raw',
  },
  {
    id: 'unescaped-output', severity: 'medium', langs: ['java'],
    test: (l) => /getWriter\(\)\s*\.\s*(?:print|println|write)\s*\([^;]*request\.getParameter\s*\(/.test(l),
    message: 'request data written into the response without encoding (XSS)',
    fix: 'encode on output (OWASP Java Encoder, JSTL c:out) or use a template engine that escapes',
  },
  {
    id: 'php-include-request', severity: 'high', langs: ['php'],
    test: (l, c) => /\b(?:include|require)(?:_once)?\b[^;]*\$_(?:GET|POST|REQUEST|COOKIE)\b/.test(c.code),
    message: 'a file path taken from the request is included (local/remote file inclusion)',
    fix: 'map a fixed set of keys to known files; never include a path built from request data',
  },
  {
    id: 'weak-password-hash', severity: 'high', langs: ['js', 'py', 'go', 'java', 'php', 'cs'],
    test: (l, c) => {
      const re = WEAK_HASH[c.lang];
      if (!re || !re.test(l)) return false;
      const near = c.lines.slice(Math.max(0, c.index - 2), c.index + 3).join('\n');
      return /\b(?:password|passwd|passphrase|pwd)\w*/i.test(near);
    },
    message: 'MD5 or SHA-1 used where a password is hashed',
    fix: 'a password hash built for it: bcrypt, scrypt, argon2 (password_hash in PHP, PasswordHasher in .NET)',
  },
];

/** Hash calls that are fine for checksums and wrong for passwords, per language. */
const WEAK_HASH = {
  js: /\bcreateHash\s*\(\s*['"](?:md5|sha-?1)['"]\s*\)|\bCryptoJS\.(?:MD5|SHA1)\s*\(/i,
  py: /\bhashlib\.(?:md5|sha1)\s*\(|\bhashlib\.new\s*\(\s*['"](?:md5|sha-?1)['"]/i,
  go: /\b(?:md5|sha1)\.(?:New|Sum)\s*\(/,
  java: /\bMessageDigest\.getInstance\s*\(\s*"(?:MD5|SHA-?1)"\s*\)|\bDigestUtils\.(?:md5|sha1)(?:Hex)?\s*\(/i,
  php: /(?<![\w>:$])(?:md5|sha1)\s*\(|\bhash\s*\(\s*['"](?:md5|sha-?1)['"]/i,
  cs: /\b(?:MD5|SHA1)(?:CryptoServiceProvider|Managed|Cng)?\.Create\s*\(\s*\)|\bnew\s+(?:MD5|SHA1)(?:CryptoServiceProvider|Managed|Cng)\s*\(/,
};

/**
 * Is `value`, assigned to a credential-named `name`, plausibly a real secret?
 * Precision over recall: prose, identifiers, placeholders, paths and
 * environment-variable names are not.
 */
function plausibleSecret(name, value) {
  if (/\s/.test(value) || PLACEHOLDER.test(value)) return false;
  if (/(?:env|var|name|label|field|header|path|file|url|uri|hint|prompt|placeholder|text|message|msg|regex|pattern|length|policy|type|id|ref|param|input|selector|title|error|class|hash|sentinel)$/i.test(name.replace(/[^A-Za-z]+$/, ''))) return false;
  if (/\$\{|\{[^}]*\}|<[^>]+>|%[sd]|process\.env|\benv\(|^\.{0,2}[\\/~]|^[A-Za-z]:[\\/]|^https?:/i.test(value)) return false;
  if (/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)+$/.test(value) && !/\d{3}/.test(value)) return false; // dotted.i18n.key or kebab-case-id
  const hasDigit = /\d/.test(value); const hasAlpha = /[A-Za-z]/.test(value); const hasSymbol = /[^A-Za-z0-9_.-]/.test(value);
  if (!((hasDigit && hasAlpha) || hasSymbol)) return false;
  return shannon(value) >= 2.5;
}

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
    if (lang === 'php' && trimmed.startsWith('#') && !trimmed.startsWith('#[')) continue;
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
