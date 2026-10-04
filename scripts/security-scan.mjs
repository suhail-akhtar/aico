#!/usr/bin/env node
/**
 * AICO's own static security scan: the fast, local half of SAST
 * (ADR 0026). CodeQL (.github/workflows/codeql.yml) is the deep half; it runs
 * in minutes on GitHub. This runs in well under a second, in the pre-commit
 * hook on the files being committed and in CI over the whole tree, so the
 * cheap mistakes are caught while the author still has the file open.
 *
 * What it looks for — patterns that have bitten this kind of program, tuned
 * to this codebase:
 *
 *   generic (shared/security/rules.mjs, also run by the agent on users' code)
 *     exec/execSync with interpolated strings, shell: true, eval/new Function,
 *     innerHTML / dangerouslySetInnerHTML without a sanitiser on the line, TLS
 *     or host-key verification off, Math.random for secrets, credential-named
 *     values in console output, SQL built by interpolation, plus Python/Go.
 *   AICO-specific (below)
 *     Electron webPreferences that drop isolation; shell.openExternal without a
 *     scheme check; fetch of a computed URL in the engine outside the SSRF
 *     guard; filesystem writes on a path taken straight from a request; every
 *     /api route classified in scripts/security/routes.json (a route nobody
 *     classified is a route nobody thought about); every settings key
 *     classified for what a cloned repository's .aico/settings.json may do
 *     with it (scripts/security/settings-keys.json).
 *
 * Findings that already exist are recorded in scripts/security/baseline.json,
 * each with a status (`accepted` — reviewed, safe as written; `open` — a real
 * or suspected problem, kept visible until fixed). CI fails only on findings
 * NOT in the baseline, and every run prints the open ones, so a baseline is a
 * to-do list, never a rug. A single line is waived in place with
 * `// security-allow: <rule> — reason`.
 *
 * Fingerprints are rule + file + the trimmed source line (+ occurrence), not
 * line numbers: an edit above a finding must not make it "new".
 *
 * Usage:
 *   node scripts/security-scan.mjs                 full tree (CI)
 *   node scripts/security-scan.mjs --staged        staged files, staged content (pre-commit)
 *   node scripts/security-scan.mjs --files a b     just these
 *   node scripts/security-scan.mjs --update-baseline   record current findings (keeps notes)
 *   --json  machine-readable · --root DIR  another tree (tests) · --quiet
 *
 * Exit: 0 clean (or only baselined), 1 new findings, 2 usage error.
 */

import { execFileSync } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { GENERIC_RULES, scanCode, findSecrets } from '../shared/security/rules.mjs';
import { extractRoutes } from './lib/api-routes.mjs';

const argv = process.argv.slice(2).map(a => a.replace(/\r$/, ''));
const opts = { staged: false, files: null, update: false, json: false, root: null, quiet: false };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--staged') opts.staged = true;
  else if (a === '--files') { opts.files = []; while (argv[i + 1] && !argv[i + 1].startsWith('--')) opts.files.push(argv[++i]); }
  else if (a === '--update-baseline') opts.update = true;
  else if (a === '--json') opts.json = true;
  else if (a === '--root') opts.root = argv[++i];
  else if (a === '--quiet') opts.quiet = true;
  else if (a === '-h' || a === '--help') { console.log('usage: node scripts/security-scan.mjs [--staged | --files F...] [--update-baseline] [--json] [--root DIR] [--quiet]'); process.exit(0); }
  else { console.error(`security-scan: unknown argument ${a}`); process.exit(2); }
}

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(opts.root ?? path.join(here, '..'));
const BASELINE = path.join(root, 'scripts/security/baseline.json');
const ROUTES = path.join(root, 'scripts/security/routes.json');
const SETTINGS_KEYS = path.join(root, 'scripts/security/settings-keys.json');

// ── scope ────────────────────────────────────────────────────────────────────

/** Shipped code. Tests, probes and fixtures exercise the patterns on purpose. */
const IN_SCOPE = /^(?:src|shared|web\/src|desktop\/(?:electron|engine|renderer\/src|shared)|vscode-extension\/(?:src|webview\/src)|templates)\/.+\.(?:[cm]?[jt]sx?|py|go)$/;
const OUT_OF_SCOPE = /(?:^|\/)(?:node_modules|dist|dist-test|web-dist|build|coverage|\.next|vendor|__tests__|fixtures)\/|\.(?:test|spec)\.[cm]?[jt]sx?$|\.d\.[cm]?ts$|\.min\.js$|^src\/test-exports\.ts$|^src\/evals\/|^shared\/security\/rules\.mjs$/;

// ── AICO-specific rules ──────────────────────────────────────────────────────

const AICO_RULES = [
  {
    id: 'electron-unsafe-prefs', severity: 'high', langs: ['js'], files: /^desktop\//,
    test: (l, c) => /\bnodeIntegration(?:InWorker|InSubFrames)?\s*:\s*true|\bcontextIsolation\s*:\s*false|\bwebSecurity\s*:\s*false|\ballowRunningInsecureContent\s*:\s*true|\bsandbox\s*:\s*false|\bexperimentalFeatures\s*:\s*true|\benableBlinkFeatures\s*:/.test(c.code),
    message: 'Electron webPreferences weaken isolation (renderer → Node escalation)',
    fix: 'keep contextIsolation, sandbox and webSecurity on; expose what the page needs through the preload bridge',
  },
  {
    id: 'open-external-unchecked', severity: 'medium', langs: ['js'], files: /^(?:desktop|vscode-extension)\//,
    test: (l, c) => {
      // The renderer's desktop.shell.openExternal goes through main's
      // shell:openExternal handler (core-ipc.ts), which checks the scheme.
      if (!/(?<![\w.])shell\.openExternal\s*\(|\bvscode\.env\.openExternal\s*\(/.test(l)) return false;
      if (/openExternal\s*\(\s*['"`]https:/.test(l)) return false;
      const window = c.lines.slice(Math.max(0, c.index - 8), c.index + 1).join('\n');
      return !/https\?|\^https|protocol\s*===|isSafe\w*\(|allowedScheme|safeExternal|mailto/i.test(window);
    },
    message: 'shell.openExternal on a URL whose scheme is not checked (file:, smb: and custom handlers run things)',
    fix: 'allow only https?: (and mailto: where intended) before calling openExternal',
  },
  {
    id: 'fetch-unguarded', severity: 'medium', langs: ['js'], files: /^src\//,
    test: (l, c) => /(?<![\w.])fetch\s*\(\s*(?!['"`]|`https?:)/.test(c.code)
      && !/\b(?:guardedFetch|decideTarget|resolveAll|ssrf)\b/.test(c.text),
    message: 'engine fetch of a computed URL outside the SSRF guard',
    fix: 'route URLs someone else chose through the SSRF guard (src/tools/ops/ssrf.ts, guardedFetch); waive with a reason when the URL is the user\'s own configuration',
  },
  {
    id: 'fs-write-request-path', severity: 'high', langs: ['js'], files: /^src\/(?:server|vault)\//,
    test: (l, c) => /\b(?:writeFile|writeFileSync|appendFile|appendFileSync|createWriteStream|rm|rmSync|unlink|unlinkSync|rename|renameSync|mkdir|mkdirSync|cp|cpSync)\s*\(/.test(c.code)
      && /\bbody\.|searchParams\.get\(|query\.get\(|\breq\.url\b/.test(c.code),
    message: 'filesystem write on a path taken from the request',
    fix: 'resolve, then contain: path.relative(root, abs) must not start with .. or be absolute',
  },
];

const RULES = [...GENERIC_RULES, ...AICO_RULES];

// ── files ───────────────────────────────────────────────────────────────────

function git(args, allowFail = false) {
  try { return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 256 * 1024 * 1024 }); }
  catch (err) { if (allowFail) return null; throw err; }
}

function listFiles() {
  if (opts.files) return opts.files.map(f => path.relative(root, path.resolve(f)).replace(/\\/g, '/'));
  if (opts.staged) return (git(['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z'], true) ?? '').split('\0').filter(Boolean);
  const out = git(['ls-files', '-z', '--cached', '--others', '--exclude-standard'], true);
  if (out !== null) return [...new Set(out.split('\0').filter(Boolean))];
  const walk = (dir, rel = '') => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    if (e.name === 'node_modules' || e.name === '.git') return [];
    const r = rel ? `${rel}/${e.name}` : e.name;
    return e.isDirectory() ? walk(path.join(dir, e.name), r) : [r];
  });
  return walk(root);
}

/** The content being judged: the staged blob in --staged mode (what the commit will hold). */
function readFile(rel) {
  if (opts.staged) { const t = git(['show', `:${rel}`], true); if (t !== null) return t; }
  try { return fs.readFileSync(path.join(root, rel), 'utf8'); } catch { return null; }
}

// ── repository-level checks ─────────────────────────────────────────────────

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

/** Every /api route must have a stated gate; a classified route that vanished is stale. */
function checkRoutes(findings) {
  const registry = readJson(ROUTES, null);
  if (!registry) { findings.push({ rule: 'route-registry', severity: 'high', file: 'scripts/security/routes.json', line: 0, source: 'missing', message: 'route registry missing or invalid JSON', fix: 'restore scripts/security/routes.json' }); return; }
  const known = registry.routes ?? {};
  const found = extractRoutes(root);
  const names = new Set(found.map(r => r.route + (r.prefix ? '*' : '')));
  for (const r of found) {
    const key = r.route + (r.prefix ? '*' : '');
    if (!known[key]) {
      findings.push({ rule: 'route-unregistered', severity: 'high', file: r.file, line: r.line, source: `route ${key}`,
        message: `/api/${key} is not classified in scripts/security/routes.json`,
        fix: 'add it with its gate: "token" (read or reversible), "token+human" (says yes for a person), "token+human-on-weaken", "token+grant" (vault), and what it touches' });
    }
  }
  for (const key of Object.keys(known)) {
    if (!names.has(key)) findings.push({ rule: 'route-stale', severity: 'medium', file: 'scripts/security/routes.json', line: 0, source: `route ${key}`, message: `/api/${key} is classified but no longer found in the source`, fix: 'remove it from routes.json (or fix scripts/lib/api-routes.mjs if the dispatch shape changed)' });
  }
}

/**
 * What a cloned repository's `.aico/settings.json` may do. The policy table
 * (PROJECT_POLICY in src/settings-project-policy.ts) classifies every key;
 * this holds it to the short list of keys that must never be `allow`
 * (scripts/security/settings-keys.json), and notices a key the table forgot.
 */
function checkSettingsKeys(findings) {
  const reg = readJson(SETTINGS_KEYS, null);
  const read = rel => { try { return fs.readFileSync(path.join(root, rel), 'utf8'); } catch { return null; } };
  const src = read('src/settings.ts');
  if (!src || !reg) return;
  const start = src.indexOf('export interface AicoSettings {');
  if (start < 0) return;
  const end = src.indexOf('\n}', start);
  const keys = [...src.slice(start, end).matchAll(/^ {2}([A-Za-z_]\w*)\??:/gm)].map(m => m[1]);
  const lineOfKey = key => src.slice(0, src.indexOf(`\n  ${key}`, start) + 1).split('\n').length;
  const policySrc = read('src/settings-project-policy.ts');
  const table = policySrc && /PROJECT_POLICY\s*=\s*\{([\s\S]*?)\}\s*as const/.exec(policySrc)?.[1];
  const policy = table ? Object.fromEntries([...table.matchAll(/^\s*([A-Za-z_]\w*)\s*:\s*'([\w-]+)'/gm)].map(m => [m[1], m[2]])) : null;
  for (const [key, why] of Object.entries(reg.critical ?? {})) {
    if (!keys.includes(key)) {
      findings.push({ rule: 'settings-key-stale', severity: 'medium', file: 'scripts/security/settings-keys.json', line: 0, source: `settings key ${key}`, message: `"${key}" is listed as critical but is no longer an AicoSettings key`, fix: 'remove it from settings-keys.json' });
      continue;
    }
    const p = policy?.[key];
    if (!policy || p === 'allow') {
      findings.push({ rule: 'settings-key-unfiltered', severity: 'high', file: policy ? 'src/settings-project-policy.ts' : 'src/settings.ts', line: policy ? 0 : lineOfKey(key), source: `settings key ${key}`,
        message: `a project's .aico/settings.json can set "${key}" (${why})${policy ? ' — PROJECT_POLICY says allow' : ' and no project-layer policy filters it'}`,
        fix: 'make it user-only, tighten or trust-gated in PROJECT_POLICY (src/settings-project-policy.ts)' });
    }
  }
  if (policy) {
    for (const key of keys) {
      if (!(key in policy)) findings.push({ rule: 'settings-key-unclassified', severity: 'high', file: 'src/settings.ts', line: lineOfKey(key), source: `settings key ${key}`, message: `"${key}" has no entry in PROJECT_POLICY`, fix: 'classify it in src/settings-project-policy.ts' });
    }
  }
}

// ── run ─────────────────────────────────────────────────────────────────────

const files = listFiles().filter(f => IN_SCOPE.test(f) && !OUT_OF_SCOPE.test(f));
const findings = [];
let scanned = 0;
for (const rel of files) {
  const text = readFile(rel);
  if (text === null || text.length > 2 * 1024 * 1024 || text.slice(0, 8000).includes('\0')) continue;
  scanned++;
  for (const f of scanCode(rel, text, RULES)) findings.push({ ...f, file: rel });
  for (const s of findSecrets(text)) {
    findings.push({ rule: 'secret', severity: 'high', file: rel, line: s.line, source: `${s.name} ${s.preview} (${s.length} chars)`, message: `looks like a ${s.name}`, fix: 'rotate it at the provider, then remove it; a test canary carries standards-allow: secret' });
  }
}
// Registry checks are whole-tree facts; a commit touching neither registry nor
// router does not need them, but running them is cheap, so they always run
// except when an explicit file list was given.
if (!opts.files) { checkRoutes(findings); checkSettingsKeys(findings); }

function fingerprint(f) {
  return crypto.createHash('sha1').update(`${f.rule}\0${f.file}\0${f.source.replace(/\s+/g, ' ')}`).digest('hex').slice(0, 16);
}

const baseline = readJson(BASELINE, { version: 1, findings: [] });
const pool = new Map();
for (const b of baseline.findings ?? []) {
  const list = pool.get(b.fingerprint) ?? [];
  list.push(b);
  pool.set(b.fingerprint, list);
}
const fresh = [];
const matched = [];
for (const f of findings) {
  f.fingerprint = fingerprint(f);
  const list = pool.get(f.fingerprint);
  if (list?.length) matched.push({ ...f, baseline: list.shift() });
  else fresh.push(f);
}
const openKnown = matched.filter(m => m.baseline.status === 'open');

if (opts.update) {
  const prior = new Map((baseline.findings ?? []).map(b => [`${b.fingerprint}`, b]));
  const next = findings.map(f => {
    const old = prior.get(f.fingerprint);
    return {
      rule: f.rule, file: f.file, line: f.line, source: f.source, fingerprint: f.fingerprint,
      status: old?.status ?? 'unreviewed', note: old?.note ?? '',
    };
  }).sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  fs.mkdirSync(path.dirname(BASELINE), { recursive: true });
  fs.writeFileSync(BASELINE, JSON.stringify({
    version: 1,
    about: 'Findings of scripts/security-scan.mjs that existed when recorded. status: accepted (reviewed, safe as written) | open (real or suspected issue, still to fix) | unreviewed. CI fails only on findings not listed here. Never add an entry to make CI pass without reviewing it.',
    findings: next,
  }, null, 2) + '\n');
  console.log(`security-scan: baseline written — ${next.length} finding(s) (${next.filter(n => n.status === 'unreviewed').length} unreviewed)`);
  process.exit(0);
}

if (opts.json) {
  console.log(JSON.stringify({ scanned, new: fresh, open: openKnown.map(m => ({ ...m, note: m.baseline.note })), baselined: matched.length }, null, 2));
  process.exit(fresh.length ? 1 : 0);
}

const scope = opts.staged ? 'staged files' : opts.files ? 'given files' : 'full tree';
if (!opts.quiet || fresh.length) {
  if (openKnown.length && !opts.staged && !opts.quiet) {
    console.log(`security-scan: ${openKnown.length} known OPEN finding(s) in the baseline (still to fix):`);
    for (const m of openKnown) console.log(`    ! ${m.rule} ${m.file}:${m.line} — ${m.baseline.note || m.message}`);
  }
}
if (fresh.length === 0) {
  if (!opts.quiet) console.log(`security-scan: OK (${scope}; ${scanned} file(s); ${matched.length} baselined, ${openKnown.length} open)`);
  process.exit(0);
}
console.error(`security-scan: ${fresh.length} new finding(s) (${scope}; ${scanned} file(s))\n`);
for (const f of fresh.sort((a, b) => (a.severity === 'high' ? 0 : 1) - (b.severity === 'high' ? 0 : 1) || a.file.localeCompare(b.file))) {
  console.error(`  ✗ [${f.severity}] ${f.rule} ${f.file}:${f.line}\n      ${f.source}\n      ${f.message} — fix: ${f.fix}`);
}
console.error('\nFix it, or if it is safe as written, say why on the line: // security-allow: <rule> — reason');
console.error('(A reviewed pre-existing finding belongs in scripts/security/baseline.json via --update-baseline, with a status and note.)');
process.exit(1);
