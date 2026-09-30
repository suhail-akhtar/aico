#!/usr/bin/env node
/**
 * The engineering standards that a machine can check, checked by a machine.
 *
 * `docs/engineering/` and `AGENTS.md` write the rules down; this file is where
 * the cheap, reliable ones stop being requests. The same lesson the agent loop
 * learned applies to the people and agents who work on it: a rule that lives
 * only in prose holds until someone is confident, and they are most confident
 * exactly when they are about to break it. Every check here exists because the
 * mistake it catches has already happened in this repository:
 *
 *   attribution   AI co-author trailers were added to every commit by tool
 *                 default for weeks, and removing them took a history rewrite
 *                 and a force-push of every branch and tag.
 *   versions      a release bumps package.json, two lockfiles, the desktop app,
 *                 README download links and a stamp on every website page; one
 *                 missed file is a broken download link on the release page.
 *   changelog     every released version has a CHANGELOG section.
 *   licence       the licence changed from MIT to PolyForm Noncommercial in
 *                 0.28.0; an old "MIT" or "open source" claim is now false.
 *   secrets       a key in a public commit is compromised the moment it lands.
 *   headers       modules explain WHY in a header comment; new ones must too.
 *
 * Modes:
 *   (default)        every check over every tracked file. CI runs this.
 *   --fast           only what changed in the push range (the pre-push hook).
 *   --release [X]    also require the release stamps to name version X
 *                    (default: package.json) and a dated CHANGELOG heading.
 *   --commit-msg F   check one commit message file, nothing else (commit-msg
 *                    hook).
 *   --pre-push       read git's pre-push stdin to find the range (implies
 *                    --fast).
 *   --range A..B     the commits/files to inspect for range-based checks.
 *   --root DIR       the repository to check (the tests point it at fixtures).
 *
 * Exit status: 0 clean, 1 violations, 2 usage error.
 *
 * Escape hatches are explicit and greppable, never silent: a line carrying
 * `standards-allow: secret` or `standards-allow: licence` is exempt from that
 * one check. Use them for test canaries and quoted history, and say why on the
 * same line.
 */

import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { STAMP_FILES, rulesFor, wanted, requiredDownloads } from './lib/release-stamps.mjs';

// ── arguments ────────────────────────────────────────────────────────────────

// A hook checked out with CRLF hands us `--pre-push\r`; take the argument it meant.
const argv = process.argv.slice(2).map(a => a.replace(/\r$/, ''));
const opts = { fast: false, release: false, releaseVersion: null, commitMsg: null, prePush: false, range: null, root: null, quiet: false };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--fast') opts.fast = true;
  else if (a === '--release') {
    opts.release = true;
    if (argv[i + 1] && /^\d+\.\d+\.\d+/.test(argv[i + 1])) opts.releaseVersion = argv[++i];
  } else if (a === '--commit-msg') opts.commitMsg = argv[++i];
  else if (a === '--pre-push') { opts.prePush = true; opts.fast = true; }
  else if (a === '--range') opts.range = argv[++i];
  else if (a === '--root') opts.root = argv[++i];
  else if (a === '--quiet') opts.quiet = true;
  else if (a === '-h' || a === '--help') { printHelp(); process.exit(0); }
  else { console.error(`check-standards: unknown argument ${a}`); printHelp(); process.exit(2); }
}

function printHelp() {
  console.log('usage: node scripts/check-standards.mjs [--fast] [--release [X.Y.Z]] [--range A..B] [--root DIR]\n'
    + '       node scripts/check-standards.mjs --commit-msg <file>\n'
    + '       node scripts/check-standards.mjs --pre-push   (reads git pre-push stdin)');
}

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(opts.root ?? path.join(here, '..'));

// ── patterns ─────────────────────────────────────────────────────────────────

/**
 * AI attribution. The trailer is the thing tools add by default; the phrases
 * are the footers they add to PR bodies and docs. Human co-authors are fine —
 * GitHub's own squash merge writes those — so a trailer is only refused when
 * it names an AI tool, vendor or bot address.
 */
const AI_NAMES = String.raw`claude|anthropic|openai|chat\s?gpt|gpt-?\d|copilot|gemini|bard|codex|cursor|devin|aider|windsurf|codeium|tabnine|codewhisperer|amazon\s?q\b|deepseek|kimi|moonshot|mistral|grok|llama|qwen|\bai\b|\bllm\b|assistant`;
const ATTRIBUTION = [
  { re: new RegExp(String.raw`^[ \t>*-]*co-authored-by:.*(?:${AI_NAMES}|noreply@anthropic\.com|@openai\.com)`, 'im'), what: 'AI co-author trailer' },
  { re: /generated\s+(?:with|by)\s+\[?claude(?:\s+code)?\]?/i, what: '"Generated with Claude" footer' },
  { re: /\u{1F916}\s*generated\s+(?:with|by)/iu, what: 'robot "Generated with" footer' },
  // Named products only: "a diff written by an AI agent" is how review.md
  // talks about reviewing, not a credit line.
  { re: /\b(?:generated|written|authored)\s+(?:with|by)\s+(?:chat\s?gpt|github\s+copilot|claude|gemini)\b/i, what: 'AI authorship phrase' },
];

/**
 * Secrets: high-confidence shapes only. A checker that cries wolf gets
 * bypassed, so generic "password=" heuristics are deliberately absent.
 */
const SECRET_PATTERNS = [
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
const PLACEHOLDER = /(test|fake|dummy|example|sample|canary|redact|placeholder|xxxx|0000|1234|abcd|your|mock)/i;
/** Files that must never be tracked, whatever they contain. */
const SECRET_FILES = /(?:^|\/)(?:\.env(?:\.(?!example$)[^/]+)?|id_rsa|id_ed25519|[^/]+\.pem|[^/]+\.p12|[^/]+\.pfx|[^/]+\.key)$/i;

/** The licence every package of ours declares. */
const LICENCE_SPDX = 'PolyForm-Noncommercial-1.0.0';

/** Files the attribution and licence scans must not read: they quote the patterns. */
const SELF = [
  'scripts/check-standards.mjs',
  'scripts/test-check-standards.mjs',
  'scripts/fixtures/check-standards/',
];

// ── git and files ────────────────────────────────────────────────────────────

function git(args, { allowFail = false } = {}) {
  try {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
  } catch (err) {
    if (allowFail) return null;
    throw err;
  }
}

const isGit = git(['rev-parse', '--is-inside-work-tree'], { allowFail: true })?.trim() === 'true';

function walk(dir, rel = '') {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const r = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...walk(path.join(dir, entry.name), r));
    else out.push(r);
  }
  return out;
}

/**
 * Every file the repository tracks plus new files not yet added (so a local
 * run sees what the next commit will), minus ignored ones. Outside git: every
 * file on disk.
 */
function trackedFiles() {
  if (!isGit) return walk(root);
  const files = git(['ls-files', '-z', '--cached', '--others', '--exclude-standard']).split('\0').filter(Boolean);
  return [...new Set(files)];
}

/** The commit range to inspect, or null when there is nothing to compare with. */
function resolveRange() {
  if (opts.range) return opts.range;
  if (!isGit) return null;
  const upstream = git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], { allowFail: true })?.trim();
  if (upstream) return `${upstream}..HEAD`;
  if (git(['rev-parse', '--verify', '--quiet', 'origin/main'], { allowFail: true })) return 'origin/main..HEAD';
  return null;
}

/**
 * git's pre-push stdin: `<local ref> <local sha> <remote ref> <remote sha>`
 * per ref. A new branch has an all-zero remote sha; its range starts where it
 * left origin/main. Deletions and tags have no new commits to inspect.
 */
function rangesFromPrePush() {
  let input = '';
  try { input = fs.readFileSync(0, 'utf8'); } catch { /* no stdin */ }
  const zero = /^0+$/;
  const ranges = [];
  for (const line of input.split(/\r?\n/)) {
    const [localRef, localSha, , remoteSha] = line.trim().split(/\s+/);
    if (!localSha || zero.test(localSha) || localRef?.startsWith('refs/tags/')) continue;
    if (!remoteSha || zero.test(remoteSha)) {
      const base = git(['merge-base', 'origin/main', localSha], { allowFail: true })?.trim();
      ranges.push(base ? `${base}..${localSha}` : `${localSha} --not --remotes`);
    } else {
      ranges.push(`${remoteSha}..${localSha}`);
    }
  }
  return ranges;
}

function commitsIn(range) {
  const out = git(['log', '--format=%H%x00%B%x1e', ...range.split(' ')], { allowFail: true });
  if (!out) return [];
  return out.split('\x1e').map(s => s.trim()).filter(Boolean).map(s => {
    const [sha, body = ''] = s.split('\0');
    return { sha: sha.trim(), body };
  });
}

function filesIn(range, filter = 'ACMR') {
  if (!range.includes('..')) return [];
  const out = git(['diff', '--name-only', `--diff-filter=${filter}`, '-z', range], { allowFail: true });
  return out ? out.split('\0').filter(Boolean) : [];
}

function read(rel) {
  try { return fs.readFileSync(path.join(root, rel), 'utf8'); } catch { return null; }
}

function isText(rel, content) {
  if (/\.(png|jpe?g|gif|webp|ico|icns|woff2?|ttf|otf|eot|pdf|zip|gz|tgz|vsix|exe|dll|so|dylib|node|wasm|mp4|webm|mp3|wav|sqlite|db|bin)$/i.test(rel)) return false;
  return content !== null && !content.slice(0, 8000).includes('\0');
}

const isSelf = rel => SELF.some(s => (s.endsWith('/') ? rel.startsWith(s) : rel === s));

// ── findings ─────────────────────────────────────────────────────────────────

const findings = [];
const ran = [];
function fail(check, where, message) { findings.push({ check, where, message }); }

function lineOf(content, index) { return content.slice(0, index).split('\n').length; }

// ── checks ───────────────────────────────────────────────────────────────────

function checkMessage(where, body) {
  // Only trailers and footers count. A subject line that *describes* removing
  // attribution ("strip AI co-author trailers") must not trip the check.
  for (const { re, what } of ATTRIBUTION) {
    const m = re.exec(body);
    if (m) fail('attribution', where, `${what}: "${m[0].trim().slice(0, 80)}" — project policy: no AI attribution in commits, PRs, docs or release notes`);
  }
}

function checkCommitAttribution(ranges) {
  ran.push('attribution (commits)');
  for (const range of ranges) {
    for (const c of commitsIn(range)) checkMessage(`commit ${c.sha.slice(0, 10)}`, c.body);
  }
}

function checkDocAttribution(files) {
  ran.push('attribution (docs)');
  for (const rel of files) {
    if (isSelf(rel) || !/\.(md|mdx|html|txt|yml|yaml)$/i.test(rel)) continue;
    const content = read(rel);
    if (!content) continue;
    for (const { re, what } of ATTRIBUTION) {
      const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
      for (const m of content.matchAll(g)) {
        fail('attribution', `${rel}:${lineOf(content, m.index)}`, `${what}: "${m[0].trim().slice(0, 80)}"`);
      }
    }
  }
}

function readJson(rel) {
  const text = read(rel);
  if (text === null) return null;
  try { return JSON.parse(text); } catch (err) { fail('versions', rel, `not valid JSON: ${err.message}`); return null; }
}

/** root and desktop package.json + lockfiles must name one version. */
function checkVersions() {
  ran.push('versions');
  const pkg = readJson('package.json');
  if (!pkg?.version) { fail('versions', 'package.json', 'no version field'); return null; }
  const v = pkg.version;
  const expect = (rel, got, field) => {
    if (got !== v) fail('versions', rel, `${field} is ${got ?? '(missing)'}, package.json is ${v}`);
  };
  const lock = readJson('package-lock.json');
  if (lock) { expect('package-lock.json', lock.version, 'version'); expect('package-lock.json', lock.packages?.['']?.version, 'packages[""].version'); }
  const desk = readJson('desktop/package.json');
  if (desk) expect('desktop/package.json', desk.version, 'version (desktop ships at the engine version)');
  const deskLock = readJson('desktop/package-lock.json');
  if (deskLock) { expect('desktop/package-lock.json', deskLock.version, 'version'); expect('desktop/package-lock.json', deskLock.packages?.['']?.version, 'packages[""].version'); }
  const ext = readJson('vscode-extension/package.json');
  const extLock = readJson('vscode-extension/package-lock.json');
  if (ext && extLock) {
    if (extLock.version !== ext.version || extLock.packages?.['']?.version !== ext.version) {
      fail('versions', 'vscode-extension/package-lock.json', `does not match vscode-extension/package.json ${ext.version}`);
    }
  }
  return { version: v, vsix: ext?.version ?? null };
}

function checkChangelog(version, { requireDated }) {
  ran.push('changelog');
  const text = read('CHANGELOG.md');
  if (text === null) { fail('changelog', 'CHANGELOG.md', 'missing'); return; }
  const esc = version.replace(/\./g, '\\.');
  const heading = new RegExp(`^## ${esc}(?:[ \\t]+—[ \\t]+(\\d{4}-\\d{2}-\\d{2}))?[ \\t]*(?=\\r?$)`, 'm');
  const m = heading.exec(text);
  if (!m) { fail('changelog', 'CHANGELOG.md', `no "## ${version} — YYYY-MM-DD" section for the package version`); return; }
  if (requireDated && !m[1]) fail('changelog', 'CHANGELOG.md', `"## ${version}" has no release date ("## ${version} — YYYY-MM-DD")`);
  const after = text.slice(m.index + m[0].length);
  const body = after.split(/^## /m)[0].trim();
  if (body.length < 20) fail('changelog', 'CHANGELOG.md', `the ${version} section is empty`);
}

/**
 * The release stamps: README download links, the website's version badge and
 * install commands. Each pattern must name the package version wherever it
 * appears, and README must carry the download links at all — a check that
 * passes because its pattern stopped matching is worse than none.
 */
function checkReleaseStamps(version, vsix) {
  ran.push('release stamps');
  for (const rel of STAMP_FILES(trackedFiles())) {
    const content = read(rel);
    if (!content) continue;
    for (const rule of rulesFor(rel)) {
      const want = wanted(rule, { version, vsix });
      if (!want) continue;
      for (const m of content.matchAll(rule.re)) {
        if (m[1] !== want) fail('release stamps', `${rel}:${lineOf(content, m.index)}`, `${rule.what} says ${m[1]}, expected ${want}`);
      }
    }
  }
  const readme = read('README.md') ?? '';
  for (const link of requiredDownloads(version)) {
    if (!readme.includes(link)) fail('release stamps', 'README.md', `no direct download link for ${link.split('/').pop()}`);
  }
}

/**
 * The rule has to be written down somewhere, and the documents that state it
 * ("never call AICO open source") must not trip it. A mention is a disclaimer,
 * not a claim, when the same clause negates it or it is quoted as a term.
 * An affirmative "AICO is open source" is still caught.
 */
function isDisclaimer(line, index) {
  const before = line.slice(0, index);
  const clause = before.split(/[.;:!?|]\s|—/).pop();
  if (/\b(?:not|never|no|cannot|can't|isn't|nor|without)\b/i.test(clause)) return true;
  // Quoted as a term: `"open source"`, `*"open source"*`.
  return /["“'`]$/.test(before);
}

/** package.json licence fields, and no stale MIT / open-source claims. */
function checkLicence(files) {
  ran.push('licence');
  for (const rel of ['package.json', 'desktop/package.json', 'vscode-extension/package.json']) {
    const pkg = readJson(rel);
    if (pkg && pkg.license !== LICENCE_SPDX) fail('licence', rel, `"license" is ${JSON.stringify(pkg.license)}, expected "${LICENCE_SPDX}"`);
  }
  for (const rel of files) {
    if (isSelf(rel) || rel === 'CHANGELOG.md' || /(^|\/)LICENSE$/.test(rel) || rel.startsWith('templates/') || rel.startsWith('benchmarks/')) continue;
    if (/(^|\/)package-lock\.json$/.test(rel)) continue;
    const isOurPkg = /(^|\/)package\.json$/.test(rel);
    if (!isOurPkg && !/\.(md|html)$/i.test(rel)) continue;
    const content = read(rel);
    if (!content) continue;
    const lines = content.split('\n');
    lines.forEach((line, i) => {
      if (/standards-allow:\s*licen[cs]e/i.test(line)) return;
      const at = `${rel}:${i + 1}`;
      if (isOurPkg) {
        if (/"license"\s*:\s*"MIT"/.test(line)) fail('licence', at, 'declares MIT; AICO is PolyForm Noncommercial from 0.28.0');
        return;
      }
      // History is allowed to say what it was.
      if (/before 0\.28|pre-0\.28|until 0\.27|up to 0\.27|<= ?0\.27/i.test(line)) return;
      const mit = /\b(?:MIT[- ]licen[cs]ed|MIT licen[cs]e|under the MIT|licen[cs]e:\s*MIT)\b/i.exec(line);
      if (mit && !isDisclaimer(line, mit.index)) {
        fail('licence', at, 'mentions the MIT licence; AICO is PolyForm Noncommercial from 0.28.0 (history may say "before 0.28.0", or mark the line standards-allow: licence)');
      }
      // "open-source repos/projects/models" describes other people's work.
      const os = /\bopen[- ]source\b(?!\s+(?:repos?|repositories|projects?|librar(?:y|ies)|models?|dependencies|packages?|tools?|software\s+by|licen[cs]es?))/i.exec(line);
      if (os && !isDisclaimer(line, os.index)) fail('licence', at, 'calls something "open source"; AICO is source-available (PolyForm Noncommercial) — never call it open source');
    });
  }
}

function shannon(s) {
  const counts = {};
  for (const ch of s) counts[ch] = (counts[ch] ?? 0) + 1;
  let h = 0;
  for (const n of Object.values(counts)) { const p = n / s.length; h -= p * Math.log2(p); }
  return h;
}

function checkSecrets(files) {
  ran.push('secrets');
  for (const rel of files) {
    if (SECRET_FILES.test(rel)) fail('secrets', rel, 'this kind of file must never be committed (keys and .env stay local; see SECURITY.md)');
    if (isSelf(rel) || /(^|\/)package-lock\.json$/.test(rel)) continue;
    const content = read(rel);
    if (!isText(rel, content) || content.length > 4 * 1024 * 1024) continue;
    for (const { name, re, entropy, strict } of SECRET_PATTERNS) {
      for (const m of content.matchAll(re)) {
        const token = m[0];
        // A long key body can spell "abcd" by chance; a key block is judged by shape alone.
        if (!strict && PLACEHOLDER.test(token)) continue;
        if (entropy && shannon(token.slice(3)) < entropy) continue;
        const lineStart = content.lastIndexOf('\n', m.index) + 1;
        const lineEnd = content.indexOf('\n', m.index);
        const line = content.slice(lineStart, lineEnd === -1 ? undefined : lineEnd);
        if (/standards-allow:\s*secret/i.test(line)) continue;
        // Never echo the value: a finding is printed to CI logs.
        fail('secrets', `${rel}:${lineOf(content, m.index)}`, `looks like a ${name} (${token.slice(0, 6)}…, ${token.length} chars). Rotate it at the provider first, then remove it; a test canary must say "standards-allow: secret" on its line`);
      }
    }
  }
}

const HEADER_SCOPE = /^(?:src\/.+\.tsx?|shared\/.+\.tsx?|desktop\/electron\/.+\.ts|desktop\/shared\/.+\.ts|desktop\/engine\/.+\.ts|scripts\/[^/]+\.mjs|desktop\/scripts\/[^/]+\.mjs|web\/src\/[^/]+\.ts)$/;

/** A new module opens with a comment that says what it is for and why. */
function checkHeaders(addedFiles) {
  ran.push('module headers');
  for (const rel of addedFiles) {
    if (!HEADER_SCOPE.test(rel) || rel.endsWith('.d.ts')) continue;
    const content = read(rel);
    if (content === null) continue;
    const body = content.replace(/^\uFEFF/, '').replace(/^#!.*\n/, '').trimStart();
    let comment = '';
    if (body.startsWith('/*')) comment = body.slice(0, body.indexOf('*/') + 2);
    else if (body.startsWith('//')) comment = body.match(/^(?:\/\/.*\n?)+/)?.[0] ?? '';
    const words = comment.replace(/[/*]/g, ' ').split(/\s+/).filter(w => /[a-z]/i.test(w));
    if (words.length < 8) {
      fail('module headers', rel, 'new module has no header comment — open with a /** … */ block saying what it is for and WHY it is shaped this way (see docs/engineering/coding-standards.md)');
    }
  }
}

// ── run ──────────────────────────────────────────────────────────────────────

if (opts.commitMsg) {
  const body = fs.readFileSync(opts.commitMsg, 'utf8')
    // git strips comment lines itself; so do we, so the hook sees what lands.
    .split('\n').filter(l => !l.startsWith('#')).join('\n');
  checkMessage('commit message', body);
  report();
}

const ranges = opts.prePush ? rangesFromPrePush() : [resolveRange()].filter(Boolean);
const changed = [...new Set(ranges.flatMap(r => filesIn(r)))];
const added = [...new Set(ranges.flatMap(r => filesIn(r, 'A')))];
if (!opts.fast && isGit) {
  // A local full run also judges files that are new but not committed yet.
  const pending = (git(['ls-files', '-z', '--others', '--exclude-standard']) + '\0'
    + (git(['diff', '--cached', '--name-only', '--diff-filter=A', '-z'], { allowFail: true }) ?? '')).split('\0').filter(Boolean);
  for (const f of pending) if (!added.includes(f)) added.push(f);
}
// In --fast mode the scans read only what the push changes; otherwise all of it.
const scanFiles = opts.fast ? changed.filter(f => fs.existsSync(path.join(root, f))) : trackedFiles();

checkCommitAttribution(ranges);
checkDocAttribution(scanFiles);
const v = checkVersions();
if (v) {
  checkChangelog(v.version, { requireDated: opts.release });
  if (opts.release && opts.releaseVersion && opts.releaseVersion !== v.version) {
    fail('versions', 'package.json', `is ${v.version}, but --release asked for ${opts.releaseVersion}`);
  }
  if (!opts.fast || opts.release) checkReleaseStamps(v.version, v.vsix);
}
checkLicence(scanFiles);
checkSecrets(scanFiles);
checkHeaders(added);
report();

function report() {
  const scope = opts.commitMsg ? 'commit message'
    : `${opts.fast ? 'fast' : 'full'}${opts.release ? ' + release' : ''}; ${ranges?.length ? ranges.join(', ') : 'no commit range'}; ${scanFiles?.length ?? 0} file(s) scanned`;
  if (findings.length === 0) {
    if (!opts.quiet) console.log(`check-standards: OK (${scope}${ran.length ? `; ${ran.join(', ')}` : ''})`);
    process.exit(0);
  }
  console.error(`check-standards: ${findings.length} problem(s) (${scope})\n`);
  const byCheck = new Map();
  for (const f of findings) {
    if (!byCheck.has(f.check)) byCheck.set(f.check, []);
    byCheck.get(f.check).push(f);
  }
  for (const [check, list] of byCheck) {
    console.error(`  ${check}`);
    for (const f of list) console.error(`    ✗ ${f.where} — ${f.message}`);
  }
  console.error('\nRules: AGENTS.md and docs/engineering/. Do not bypass the hook with --no-verify; fix the cause.');
  process.exit(1);
}
