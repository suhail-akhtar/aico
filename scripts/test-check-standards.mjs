/**
 * Tests for scripts/check-standards.mjs.
 *
 * Each case copies the known-good fixture repository to a temp directory,
 * makes it a git repo, breaks exactly one rule and asserts the checker names
 * that rule — and, for the cases that must pass, that it stays quiet. A
 * checker is only trustworthy if both halves hold: one that never fails is
 * decoration, one that fails on legitimate text gets bypassed with
 * --no-verify and then protects nothing.
 *
 * Secrets are assembled at runtime so this file never contains a string that
 * looks like one. Nothing here touches the real repository or ~/.aico.
 *
 * Run: node scripts/test-check-standards.mjs   (npm run test:standards)
 */

import { execFileSync, spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const checker = path.join(here, 'check-standards.mjs');
const fixture = path.join(here, 'fixtures', 'check-standards', 'good');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'aico-check-standards-'));
process.on('exit', () => { try { fs.rmSync(scratch, { recursive: true, force: true }); } catch { /* best effort */ } });

let passed = 0;
let failed = 0;
const failures = [];
function assert(cond, name, detail = '') {
  if (cond) { passed++; console.log(`  ok    ${name}`); }
  else { failed++; failures.push(name); console.log(`  FAIL  ${name}${detail ? `\n        ${detail.split('\n').join('\n        ')}` : ''}`); }
}

let n = 0;
/** A fresh git repo holding the good fixture, committed once. */
function repo() {
  const dir = path.join(scratch, `r${++n}`);
  fs.cpSync(fixture, dir, { recursive: true });
  const g = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  g('init', '-q', '-b', 'main');
  g('config', 'user.name', 'Fixture Author');
  g('config', 'user.email', 'fixture@example.invalid');
  // A throwaway fixture: the developer's own signing and hooks do not apply.
  g('config', 'commit.gpgsign', 'false');
  g('config', 'core.hooksPath', '.no-hooks');
  g('config', 'core.autocrlf', 'false');
  g('add', '-A');
  g('commit', '-q', '-m', 'base');
  const base = g('rev-parse', 'HEAD').trim();
  return {
    dir, base, g,
    write(rel, text) { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text); },
    edit(rel, fn) { const p = path.join(dir, rel); fs.writeFileSync(p, fn(fs.readFileSync(p, 'utf8'))); },
    commit(message) { g('add', '-A'); g('commit', '-q', '-m', message); },
    run(...args) {
      const r = spawnSync(process.execPath, [checker, '--root', dir, ...args], { encoding: 'utf8' });
      return { code: r.status, out: `${r.stdout}${r.stderr}` };
    },
  };
}

// Seeded, so a run is repeatable: a token that happened to spell "test" would
// otherwise make "the same value unmarked fails" flaky one run in many.
let seed = 0x5eed;
const nextRandom = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);
const randomToken = (len, alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789') =>
  Array.from({ length: len }, () => alphabet[Math.floor(nextRandom() * alphabet.length)]).join('');

// Assembled so no attribution footer appears literally in this file either.
const AI_TRAILER = ['Co-Authored-By:', 'Claude', 'Opus', '<noreply@', 'anthropic.com>'].join(' ').replace('@ ', '@');
const ROBOT_FOOTER = `\u{1F916} Generated with [Claude Code](https://claude.com/claude-code)`;

console.log('\ncheck-standards');

{
  const r = repo();
  const res = r.run('--release');
  assert(res.code === 0, 'the good fixture passes the full + release check', res.out);
  const again = r.run('--release', '1.4.2');
  assert(again.code === 0, '--release with the matching explicit version passes', again.out);
  const wrong = r.run('--release', '1.5.0');
  assert(wrong.code === 1 && /--release asked for 1\.5\.0/.test(wrong.out), '--release with a different version fails', wrong.out);
}

// ── versions ────────────────────────────────────────────────────────────────
{
  const r = repo();
  r.edit('desktop/package.json', s => s.replace('"1.4.2"', '"1.4.1"'));
  const res = r.run();
  assert(res.code === 1 && /versions[\s\S]*desktop\/package\.json/.test(res.out), 'a desktop version that differs from the engine fails', res.out);
}
{
  const r = repo();
  r.edit('package-lock.json', s => s.replace(/"version": "1\.4\.2",\n      "license"/, '"version": "1.4.0",\n      "license"'));
  const res = r.run();
  assert(res.code === 1 && /packages\[""\]\.version is 1\.4\.0/.test(res.out), 'a lockfile whose root package lags fails', res.out);
}

// ── changelog ───────────────────────────────────────────────────────────────
{
  const r = repo();
  r.edit('CHANGELOG.md', s => s.replace('## 1.4.2 — 2026-09-30', '## Unreleased'));
  const res = r.run();
  assert(res.code === 1 && /changelog/.test(res.out), 'no CHANGELOG section for the package version fails', res.out);
}
{
  const r = repo();
  r.edit('CHANGELOG.md', s => s.replace('## 1.4.2 — 2026-09-30', '## 1.4.2'));
  assert(r.run().code === 0, 'an undated section is enough outside release mode');
  const res = r.run('--release');
  assert(res.code === 1 && /has no release date/.test(res.out), 'release mode requires the section to be dated', res.out);
}

// ── release stamps ──────────────────────────────────────────────────────────
{
  const r = repo();
  r.edit('docs/index.html', s => s.replace('<span class="ver">v1.4.2</span>', '<span class="ver">v1.4.1</span>'));
  const res = r.run();
  assert(res.code === 1 && /docs\/index\.html:3 — website version badge says 1\.4\.1/.test(res.out), 'a stale website badge is named with its line', res.out);
}
{
  const r = repo();
  r.edit('README.md', s => s.replace('aico-vscode-0.9.1.vsix', 'aico-vscode-0.9.0.vsix'));
  const res = r.run();
  assert(res.code === 1 && /VS Code extension file name/.test(res.out), 'a README VSIX name that is not the extension version fails', res.out);
}
{
  const r = repo();
  r.edit('README.md', s => s.split('\n').filter(l => !l.startsWith('| Linux')).join('\n'));
  const res = r.run();
  assert(res.code === 1 && /no direct download link for AICO-1\.4\.2-linux-x64\.AppImage/.test(res.out), 'a README that lost its download links fails rather than passing vacuously', res.out);
}
{
  const r = repo();
  r.edit('docs/index.html', s => s.replace('The 1.4 line', 'The 0.7 line'));
  const res = r.run();
  assert(res.code === 1 && /release line example says 0\.7/.test(res.out), 'a stale "The X.Y line" example fails', res.out);
}
{
  const r = repo();
  r.edit('SECURITY.md', s => s.replace('| 1.4.x | yes |', '| 0.3.x | yes |'));
  const res = r.run();
  assert(res.code === 1 && /SECURITY\.md:9 — supported-versions table row says 0\.3/.test(res.out), 'a stale supported-versions line in SECURITY.md fails', res.out);
}
{
  const r = repo();
  r.edit('docs/index.html', s => s.replace('<span class="ver">v1.4.2</span>', '<span class="ver">v1.4.1</span>'));
  const res = r.run('--fast', '--range', `${r.base}..HEAD`);
  assert(res.code === 0, '--fast skips the release stamps (the pre-push hook stays cheap)', res.out);
}

// ── licence ─────────────────────────────────────────────────────────────────
{
  const r = repo();
  r.edit('vscode-extension/package.json', s => s.replace('PolyForm-Noncommercial-1.0.0', 'MIT'));
  const res = r.run();
  assert(res.code === 1 && /vscode-extension\/package\.json — "license" is "MIT"/.test(res.out), 'a package that declares MIT fails', res.out);
}
{
  const r = repo();
  r.write('docs/about.md', 'AICO is open source and free forever.\n');
  const res = r.run();
  assert(res.code === 1 && /docs\/about\.md:1 — calls something "open source"/.test(res.out), 'calling AICO open source fails', res.out);
}
{
  const r = repo();
  r.write('docs/about.md', 'This project is MIT licensed.\n');
  const res = r.run();
  assert(res.code === 1 && /mentions the MIT licence/.test(res.out), 'claiming the MIT licence fails', res.out);
}
{
  const r = repo();
  r.write('docs/about.md', 'Upstream is under the MIT License. <!-- standards-allow: licence (third-party) -->\n');
  assert(r.run().code === 0, 'a line marked standards-allow: licence is exempt');
  r.write('docs/policy.md', [
    'Never call AICO "open source" or "MIT".',
    'AICO is source-available, not open source.',
    '- [ ] No "open source"/"MIT" claims about AICO',
    'Review a diff written by an AI agent with care.',
  ].join('\n') + '\n');
  const policy = r.run();
  assert(policy.code === 0, 'documents that state the rule (negated or quoted mentions) pass', policy.out);
  r.write('docs/policy.md', 'Great news: AICO is now open source under the MIT License.\n');
  const claim = r.run();
  assert(claim.code === 1 && /calls something "open source"/.test(claim.out) && /mentions the MIT licence/.test(claim.out), 'an affirmative claim is still caught', claim.out);
  // The good fixture already carries "12 open-source repos", "before 0.28.0 … MIT" and a bare MIT table cell.
  assert(repo().run().code === 0, 'other people\'s open-source repos, licence history and a competitor\'s MIT cell pass');
}

// ── secrets ─────────────────────────────────────────────────────────────────
{
  const r = repo();
  const token = `gh${'p'}_${randomToken(36)}`;
  r.write('src/config.ts', `/** Fixture module, long enough header comment for the header rule. */\nexport const token = '${token}';\n`);
  const res = r.run();
  assert(res.code === 1 && /secrets[\s\S]*src\/config\.ts:2 — looks like a GitHub token/.test(res.out), 'a GitHub token in source fails with file and line', res.out);
  assert(!res.out.includes(token), 'the finding never prints the secret value', res.out);
}
{
  const r = repo();
  const key = `sk-${randomToken(40)}`;
  r.write('test/fixture.mjs', `const k = '${key}'; // standards-allow: secret — engine redaction canary, not a real key\n`);
  assert(r.run().code === 0, 'a canary marked standards-allow: secret passes');
  r.write('test/fixture.mjs', `const k = '${key}';\n`);
  assert(r.run().code === 1, 'the same value unmarked fails');
  r.write('test/fixture.mjs', `const k = 'sk-test${randomToken(34)}';\n`);
  assert(r.run().code === 0, 'a value that spells a placeholder word is not a key');
}
{
  const r = repo();
  r.write('test/low.mjs', `const k = 'sk-${'a'.repeat(40)}';\n`);
  assert(r.run().code === 0, 'a low-entropy sk- string is not reported');
}
{
  const r = repo();
  r.write('.env', 'DEEPSEEK_API_KEY=\n');
  r.write('.env.example', 'DEEPSEEK_API_KEY=\n');
  const res = r.run();
  assert(res.code === 1 && /\.env — this kind of file must never be committed/.test(res.out) && !/\.env\.example —/.test(res.out), 'a .env file fails; .env.example does not', res.out);
}
{
  const r = repo();
  const header = ['-----BEGIN', 'OPENSSH', 'PRIVATE', 'KEY-----'].join(' ');
  const body = Array.from({ length: 4 }, () => randomToken(70, 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/')).join('\n');
  r.write('keys/deploy.txt', `${header}\n${body}\n-----END OPENSSH PRIVATE KEY-----\n`);
  const res = r.run();
  assert(res.code === 1 && /private key block/.test(res.out), 'a private key block with key material fails', res.out);
}
{
  const r = repo();
  const header = ['-----BEGIN', 'OPENSSH', 'PRIVATE', 'KEY-----'].join(' ');
  r.write('src/keygen.ts', `/** Writes keys in OpenSSH format; the header below is a format constant. */\nexport const HEADER = '${header}';\nexport const pem = (b64: string) => \`\${HEADER}\\n\${b64}\\n\`;\n`);
  assert(r.run().code === 0, 'code that spells the PEM header (a format constant, no key material) passes');
}

// ── attribution ─────────────────────────────────────────────────────────────
{
  const r = repo();
  r.write('src/feature.ts', '/**\n * A feature fixture. Exists so that this commit changes something real.\n */\nexport const f = 1;\n');
  r.commit(`Add the feature\n\n${AI_TRAILER}\n`);
  const res = r.run('--range', `${r.base}..HEAD`);
  assert(res.code === 1 && /attribution[\s\S]*AI co-author trailer/.test(res.out), 'a commit with an AI co-author trailer in the range fails', res.out);
}
{
  const r = repo();
  r.write('src/feature.ts', '/**\n * A feature fixture. Exists so that this commit changes something real.\n */\nexport const f = 1;\n');
  r.commit('Add the feature\n\nCo-authored-by: Jane Doe <jane@example.invalid>\n');
  const res = r.run('--range', `${r.base}..HEAD`);
  assert(res.code === 0, 'a human co-author trailer is fine (GitHub squash merges write them)', res.out);
}
{
  const r = repo();
  r.write('src/feature.ts', '/**\n * A feature fixture. Exists so that this commit changes something real.\n */\nexport const f = 1;\n');
  r.commit('Strip AI co-author trailers from the history notes');
  assert(r.run('--range', `${r.base}..HEAD`).code === 0, 'a subject that talks about attribution is not itself attribution');
}
{
  const r = repo();
  const msg = path.join(r.dir, 'MSG');
  fs.writeFileSync(msg, `Fix the thing\n\n${AI_TRAILER}\n`);
  const res = r.run('--commit-msg', msg);
  assert(res.code === 1 && /commit message — AI co-author trailer/.test(res.out), '--commit-msg rejects an AI trailer (the commit-msg hook)', res.out);
  fs.writeFileSync(msg, `Fix the thing\n\n# ${AI_TRAILER}\n`);
  assert(r.run('--commit-msg', msg).code === 0, 'a commented-out line in the message file is ignored, as git ignores it');
  fs.writeFileSync(msg, `Fix the thing\n\n${ROBOT_FOOTER}\n`);
  assert(r.run('--commit-msg', msg).code === 1, '--commit-msg rejects a "Generated with" footer');
}
{
  const r = repo();
  r.write('docs/notes.md', `# Notes\n\nSome text.\n\n${ROBOT_FOOTER}\n`);
  const res = r.run();
  assert(res.code === 1 && /docs\/notes\.md:5/.test(res.out), 'a "Generated with" footer in a doc fails with its line', res.out);
}

// ── module headers ──────────────────────────────────────────────────────────
{
  const r = repo();
  r.write('src/bare.ts', "import fs from 'fs';\nexport const x = fs;\n");
  r.commit('Add a bare module');
  const res = r.run('--range', `${r.base}..HEAD`);
  assert(res.code === 1 && /module headers[\s\S]*src\/bare\.ts/.test(res.out), 'a new module with no header comment fails', res.out);
}
{
  const r = repo();
  r.write('src/good.ts', '/**\n * Why this module exists: to show the checker a real header comment.\n */\nexport const y = 2;\n');
  r.write('src/thin.ts', '// @ts-nocheck\nexport const z = 3;\n');
  r.edit('src/existing.ts', s => s + 'export const more = 2;\n');
  r.commit('Add modules');
  const res = r.run('--range', `${r.base}..HEAD`);
  assert(/src\/thin\.ts/.test(res.out) && !/src\/good\.ts/.test(res.out) && !/src\/existing\.ts/.test(res.out),
    'a real header passes, a pragma is not a header, and an old header-less file that was only modified is not flagged', res.out);
}

// ── pre-push ────────────────────────────────────────────────────────────────
{
  const r = repo();
  r.write('src/feature.ts', '/**\n * A feature fixture. Exists so that this commit changes something real.\n */\nexport const f = 1;\n');
  r.commit(`Add the feature\n\n${AI_TRAILER}\n`);
  const head = r.g('rev-parse', 'HEAD').trim();
  const stdin = `refs/heads/main ${head} refs/heads/main ${r.base}\n`;
  const res = spawnSync(process.execPath, [checker, '--root', r.dir, '--pre-push'], { input: stdin, encoding: 'utf8' });
  assert(res.status === 1 && /AI co-author trailer/.test(res.stdout + res.stderr), '--pre-push reads the pushed range from stdin and checks it', res.stdout + res.stderr);
  const del = spawnSync(process.execPath, [checker, '--root', r.dir, '--pre-push'], { input: `(delete) ${'0'.repeat(40)} refs/heads/x ${head}\n`, encoding: 'utf8' });
  assert(del.status === 0, 'deleting a remote branch has nothing to check', del.stdout + del.stderr);
}

console.log(`\n  CHECK STANDARDS: ${passed} passed, ${failed} failed`);
if (failed) { for (const f of failures) console.log(`    ✗ ${f}`); process.exit(1); }
