#!/usr/bin/env node
/**
 * Cut a release: the checklist in docs/engineering/releasing.md, as a program.
 *
 * Every release until 0.28.0 was cut by hand from a memory note, and the note
 * grew one line per mistake: the VSIX shipped a stale panel (0.20.0), CI had
 * been red for ten releases because nobody watched it before tagging (0.21.0),
 * a per-patch branch was created where the per-minor one should have moved
 * (0.18.1), README download links carried last release's version (0.26.0),
 * and two website pages were twenty releases stale when this script was
 * written. A checklist a person runs is a request; this is the loop.
 *
 *   npm run release -- 0.29.0                 dry run (the default): plan + diff
 *   npm run release -- 0.29.0 --dry-run       the same, explicitly
 *   npm run release -- 0.29.0 --execute       do it
 *
 * Options:
 *   --vsix A.B.C     also bump the VS Code extension to A.B.C (it is versioned
 *                    separately; without this the current VSIX is rebuilt and
 *                    re-attached, as 0.19.4 and 0.27.0 did)
 *   --summary "…"    commit subject after "Release X: " (default: the first
 *                    sentence of the CHANGELOG section)
 *   --date Y-M-D     date for the CHANGELOG heading (default: today, local)
 *   --allow-dirty    run with uncommitted changes (they are NOT committed)
 *   --allow-branch   run from a branch other than main
 *   --skip-tests     skip the local suites (loud; CI still runs)
 *   --no-wait        do not wait for the Desktop workflow and asset checks
 *
 * What it will never do: force-push, rewrite history, move an existing tag,
 * create a per-patch release branch, skip hooks, publish to npm (the owner
 * does that by hand), or read any credential — `gh` uses its own login.
 *
 * Re-running after a failure is safe: if package.json already carries the
 * target version the bump is skipped and the script resumes at push/CI/tag,
 * and each later step checks whether it already happened.
 */

import { execFileSync, spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { STAMP_FILES, applyStamps, requiredDownloads } from './lib/release-stamps.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO = 'suhail-akhtar/aico';
const SITE = 'https://suhail-akhtar.github.io/aico/';

// ── arguments ────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const opt = { version: null, execute: false, vsix: null, summary: null, date: null, allowDirty: false, allowBranch: false, skipTests: false, wait: true };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--execute') opt.execute = true;
  else if (a === '--dry-run') opt.execute = false;
  else if (a === '--vsix') opt.vsix = argv[++i];
  else if (a === '--summary') opt.summary = argv[++i];
  else if (a === '--date') opt.date = argv[++i];
  else if (a === '--allow-dirty') opt.allowDirty = true;
  else if (a === '--allow-branch') opt.allowBranch = true;
  else if (a === '--skip-tests') opt.skipTests = true;
  else if (a === '--no-wait') opt.wait = false;
  else if (/^\d+\.\d+\.\d+$/.test(a) && !opt.version) opt.version = a;
  else usage(`unknown argument: ${a}`);
}
if (argv.includes('--execute') && argv.includes('--dry-run')) usage('choose --dry-run or --execute, not both');
if (!opt.version) usage('give the version to release, e.g. 0.29.0');
if (opt.vsix && !/^\d+\.\d+\.\d+$/.test(opt.vsix)) usage('--vsix takes a version, e.g. 0.6.24');
if (opt.date && !/^\d{4}-\d{2}-\d{2}$/.test(opt.date)) usage('--date takes YYYY-MM-DD');

function usage(msg) {
  console.error(`release: ${msg}\nusage: npm run release -- <X.Y.Z> [--dry-run|--execute] [--vsix A.B.C] [--summary "…"] [--date YYYY-MM-DD] [--allow-dirty] [--allow-branch] [--skip-tests] [--no-wait]`);
  process.exit(2);
}

const MODE = opt.execute ? 'EXECUTE' : 'DRY RUN';
const V = opt.version;
const MINOR = V.split('.').slice(0, 2).join('.');
const TAG = `v${V}`;
const BRANCH = `release/v${MINOR}`;
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const DATE = opt.date ?? today();

// ── helpers ──────────────────────────────────────────────────────────────────

const problems = [];
const log = (s = '') => console.log(s);
const step = (n, s) => console.log(`\n── ${n}. ${s}`);
const die = (msg) => { console.error(`\nrelease: STOPPED — ${msg}`); process.exit(1); };

/** Capture output; never throws unless asked. */
function cap(cmd, args, { allowFail = true, cwd = root } = {}) {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', shell: false, maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0 && !allowFail) die(`${cmd} ${args.join(' ')} failed:\n${r.stderr || r.stdout}`);
  return { ok: r.status === 0, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim() };
}
const git = (...a) => cap('git', a);

/**
 * Run a command with its output shown. npm is a batch file on Windows and needs
 * a shell; nothing passed through the shell carries user text (commit messages
 * go through a file), so there is nothing to quote.
 */
function run(cmd, args, { cwd = root } = {}) {
  log(`   $ ${cmd} ${args.join(' ')}`);
  if (!opt.execute) return true;
  const useShell = process.platform === 'win32' && (cmd === 'npm' || cmd === 'npx');
  const r = spawnSync(cmd, args, { cwd, stdio: 'inherit', shell: useShell });
  if (r.status !== 0) die(`\`${cmd} ${args.join(' ')}\` exited ${r.status ?? r.signal}`);
  return true;
}

function read(rel) { return fs.readFileSync(path.join(root, rel), 'utf8'); }
function exists(rel) { return fs.existsSync(path.join(root, rel)); }
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function cmpSemver(a, b) {
  const pa = a.split('.').map(Number); const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
  return 0;
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ── the edits, computed in memory ────────────────────────────────────────────

/**
 * Bump `"version"` in a package.json, and in a lockfile both the top-level and
 * `packages[""]` entries — by targeted text replacement, so formatting and
 * line endings stay exactly as npm wrote them. Parsed afterwards to prove the
 * edit landed where it should and nowhere else.
 */
function bumpJson(rel, from, to, isLock) {
  let text = read(rel);
  const top = new RegExp(`^(\\s{2}"version":\\s*")${esc(from)}(")`, 'm');
  if (!top.test(text)) return { error: `${rel}: top-level "version": "${from}" not found` };
  text = text.replace(top, `$1${to}$2`);
  if (isLock) {
    const inner = new RegExp(`("packages":\\s*\\{\\s*"":\\s*\\{[^}]*?"version":\\s*")${esc(from)}(")`);
    if (!inner.test(text)) return { error: `${rel}: packages[""].version "${from}" not found` };
    text = text.replace(inner, `$1${to}$2`);
  }
  const parsed = JSON.parse(text);
  if (parsed.version !== to || (isLock && parsed.packages?.['']?.version !== to)) return { error: `${rel}: bump did not verify` };
  return { text };
}

function changelogEdit() {
  const text = read('CHANGELOG.md');
  // `[ \t]*(?=\r?$)`, not `\s*$`: with the m flag `\s*` runs on through the
  // blank lines after the heading, and the replacement deletes them.
  const EOL = String.raw`[ \t]*(?=\r?$)`;
  const dated = new RegExp(`^## ${esc(V)} — \\d{4}-\\d{2}-\\d{2}${EOL}`, 'm');
  const undated = new RegExp(`^## ${esc(V)}${EOL}`, 'm');
  const unreleased = new RegExp(`^## Unreleased${EOL}`, 'm');
  let out = text;
  if (dated.test(text)) { /* already there */ }
  else if (undated.test(text)) out = text.replace(undated, `## ${V} — ${DATE}`);
  else if (unreleased.test(text)) out = text.replace(unreleased, `## ${V} — ${DATE}`);
  else return { error: `CHANGELOG.md has neither "## ${V}" nor "## Unreleased" — write the entry first (docs/engineering/devops.md#changelog)` };
  const m = new RegExp(`^## ${esc(V)} — \\d{4}-\\d{2}-\\d{2}${EOL}`, 'm').exec(out);
  const section = out.slice(m.index + m[0].length).split(/^## /m)[0].trim();
  if (section.length < 40) return { error: `the CHANGELOG ${V} section is (nearly) empty` };
  return { text: out, section };
}

/** A line-level diff; every edit here is a substitution, so lines pair up. */
function showDiff(rel, before, after) {
  const a = before.split('\n'); const b = after.split('\n');
  if (a.length !== b.length) { log(`   ${rel}: (${a.length} → ${b.length} lines)`); return; }
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) {
      log(`   ${rel}:${i + 1}`);
      log(`     - ${a[i].trimEnd().slice(0, 180)}`);
      log(`     + ${b[i].trimEnd().slice(0, 180)}`);
    }
  }
}

// ── main ─────────────────────────────────────────────────────────────────────

log(`AICO release ${V} — ${MODE}${opt.execute ? '' : ' (no files, commits, pushes or releases; pass --execute to do it)'}`);

step(1, 'Preflight');
const pkg = JSON.parse(read('package.json'));
const CURRENT = pkg.version;
const ext = JSON.parse(read('vscode-extension/package.json'));
const VSIX = opt.vsix ?? ext.version;
const resuming = CURRENT === V;
if (!resuming && cmpSemver(V, CURRENT) <= 0) die(`${V} is not newer than package.json's ${CURRENT}`);
log(`   package.json ${CURRENT} → ${V}${resuming ? ' (already bumped: resuming after the bump commit)' : ''}; VS Code extension ${ext.version}${opt.vsix ? ` → ${VSIX}` : ' (unchanged, re-attached)'}`);
log(`   tag ${TAG}; branch ${BRANCH}; CHANGELOG date ${DATE}`);

const branch = git('rev-parse', '--abbrev-ref', 'HEAD').out;
if (branch !== 'main') {
  if (!opt.allowBranch) problems.push(`on branch "${branch}", not main — releases are cut from main (pass --allow-branch only for a release/vX.Y hotfix)`);
  else {
    log(`   ! on "${branch}", not main (--allow-branch)`);
    const ci = read('.github/workflows/ci.yml');
    if (!ci.includes(branch) && !ci.includes('release/**')) problems.push(`.github/workflows/ci.yml does not run on "${branch}", so step 7 could never see a green run — add it to the push triggers first (docs/engineering/devops.md#hotfixes)`);
  }
}
const dirty = git('status', '--porcelain').out;
if (dirty) (opt.allowDirty ? log(`   ! working tree is dirty (--allow-dirty); only the files the release edits are staged — but any other change already in those files goes with them`) : problems.push('working tree is dirty — commit or stash first (or --allow-dirty to preview)'));
// A tag is never moved. When resuming, an existing tag is a step already done.
if (!resuming && git('rev-parse', '-q', '--verify', `refs/tags/${TAG}`).ok) problems.push(`tag ${TAG} already exists locally — a tag is never moved; pick the next version`);

if (opt.execute) {
  git('fetch', '--quiet', 'origin', '--tags');
  const behind = git('rev-list', '--count', `HEAD..origin/${branch}`).out;
  if (behind && behind !== '0') problems.push(`${branch} is ${behind} commit(s) behind origin/${branch} — pull first`);
  if (!resuming && git('ls-remote', '--tags', 'origin', TAG).out) problems.push(`tag ${TAG} already exists on origin`);
  if (!cap('gh', ['auth', 'status']).ok) problems.push('`gh` is not logged in (run `gh auth login` yourself; this script never handles credentials)');
}
const branchExists = git('rev-parse', '-q', '--verify', `refs/remotes/origin/${BRANCH}`).ok || git('rev-parse', '-q', '--verify', `refs/heads/${BRANCH}`).ok;
log(`   ${BRANCH} ${branchExists ? 'exists — this is a patch; it will be fast-forwarded (never forced)' : 'does not exist — a new minor; it will be created at the release commit'}`);

// Compute every edit before touching anything.
const edits = new Map();
const cl = changelogEdit();
if (cl.error) problems.push(cl.error); else if (cl.text !== read('CHANGELOG.md')) edits.set('CHANGELOG.md', cl.text);
if (!resuming) {
  for (const [rel, isLock] of [['package.json', false], ['package-lock.json', true], ['desktop/package.json', false], ['desktop/package-lock.json', true]]) {
    const r = bumpJson(rel, CURRENT, V, isLock);
    if (r.error) problems.push(r.error); else edits.set(rel, r.text);
  }
}
if (opt.vsix && opt.vsix !== ext.version) {
  for (const [rel, isLock] of [['vscode-extension/package.json', false], ['vscode-extension/package-lock.json', true]]) {
    if (!exists(rel)) continue;
    const r = bumpJson(rel, ext.version, VSIX, isLock);
    if (r.error) problems.push(r.error); else edits.set(rel, r.text);
  }
}
const tracked = git('ls-files').out.split('\n');
for (const rel of STAMP_FILES(tracked)) {
  const before = read(rel);
  const after = applyStamps(before, { version: V, vsix: VSIX }, rel);
  if (after !== before) edits.set(rel, after);
}
const readmeAfter = edits.get('README.md') ?? read('README.md');
for (const link of requiredDownloads(V)) if (!readmeAfter.includes(link)) problems.push(`README.md has no download link for ${link} after the bump — the Download table changed shape; update scripts/lib/release-stamps.mjs`);

if (problems.length) {
  console.error('\n   Preflight problems:');
  for (const p of problems) console.error(`   ✗ ${p}`);
  if (opt.execute) die('fix the problems above and re-run');
  log('\n   (dry run continues so you can see the rest of the plan)');
}

step(2, `Version bump (${edits.size} file(s))`);
for (const [rel, text] of edits) showDiff(rel, read(rel), text);
if (!edits.size) log('   nothing to change');
if (opt.execute) for (const [rel, text] of edits) fs.writeFileSync(path.join(root, rel), text);

step(3, 'Standards check (release mode)');
run('node', ['scripts/check-standards.mjs', '--release', V]);

step(4, 'Local verification');
if (opt.skipTests) log('   ! --skip-tests: local suites skipped. CI still runs them, and step 7 waits for it.');
else {
  run('npm', ['run', 'typecheck']);
  run('npm', ['test']);
  run('npm', ['run', 'test:web:unit']);
  run('npm', ['--prefix', 'desktop', 'run', 'typecheck']);
  run('npm', ['--prefix', 'desktop', 'test']);
  run('npm', ['run', 'test:standards']);
}

step(5, `Build the VS Code extension (aico-vscode-${VSIX}.vsix)`);
const vsixPath = path.join('vscode-extension', `aico-vscode-${VSIX}.vsix`);
run('npm', ['--prefix', 'vscode-extension', 'run', 'package']);
if (opt.execute && !exists(vsixPath)) die(`${vsixPath} was not produced`);

step(6, 'Commit and push main');
const summary = opt.summary ?? (cl.section ?? '').split(/\n\s*\n/)[0].replace(/\s+/g, ' ').split(/(?<=[.:;])\s/)[0].replace(/[.:;]$/, '').trim();
const subject = `Release ${V}: ${summary || 'see CHANGELOG'}`;
log(`   commit subject: ${subject}`);
const files = [...edits.keys()];
if (files.length) {
  run('git', ['add', '--', ...files]);
  const msgFile = path.join(os.tmpdir(), `aico-release-${V}.txt`);
  if (opt.execute) fs.writeFileSync(msgFile, `${subject}\n`);
  // Hooks run: commit-msg refuses attribution, pre-push runs the fast check.
  run('git', ['commit', '-F', msgFile]);
}
// Pushes the branch the release is cut from: main, or a release/vX.Y hotfix
// branch (--allow-branch). Never with --force.
run('git', ['push', 'origin', `HEAD:refs/heads/${branch}`]);
const sha = opt.execute ? git('rev-parse', 'HEAD').out : '<release commit>';

step(7, 'Wait for CI on the release commit (never tag on red)');
log(`   gh run list --workflow ci.yml --commit ${sha} …; gh run watch <id> --exit-status`);
if (opt.execute) await waitForRun('ci.yml', { commit: sha });

step(8, `Tag ${TAG} and move ${BRANCH}`);
if (opt.execute && git('rev-parse', '-q', '--verify', `refs/tags/${TAG}`).ok) log(`   ${TAG} already exists locally (resume) — not re-created`);
else run('git', ['tag', '-a', TAG, '-m', `Release ${V}`]);
if (branchExists) {
  if (opt.execute) {
    git('fetch', '--quiet', 'origin', BRANCH);
    const ff = git('merge-base', '--is-ancestor', `origin/${BRANCH}`, 'HEAD').ok;
    if (!ff) die(`origin/${BRANCH} is not an ancestor of HEAD — it would need a force-push. Ask the owner; this script never forces.`);
  }
  run('git', ['push', 'origin', `HEAD:refs/heads/${BRANCH}`]);
  // Bring the local branch along (fast-forward only); not when it is the one checked out.
  if (branch !== BRANCH) run('git', ['fetch', 'origin', `${BRANCH}:${BRANCH}`]);
} else {
  run('git', ['branch', BRANCH, 'HEAD']);
  run('git', ['push', 'origin', BRANCH]);
}
run('git', ['push', 'origin', TAG]);

step(9, 'GitHub release (notes = the CHANGELOG section; the VSIX attached)');
const notesFile = path.join(os.tmpdir(), `aico-release-notes-${V}.md`);
if (opt.execute) fs.writeFileSync(notesFile, `${cl.section}\n`);
else log(`   notes: ${(cl.section ?? '').split('\n').length} line(s) from CHANGELOG.md "## ${V} — ${DATE}"`);
if (opt.execute && cap('gh', ['release', 'view', TAG, '--repo', REPO]).ok) {
  log(`   release ${TAG} already exists (resume) — re-uploading the VSIX only`);
  run('gh', ['release', 'upload', TAG, vsixPath, '--repo', REPO, '--clobber']);
} else {
  run('gh', ['release', 'create', TAG, vsixPath, '--repo', REPO, '--title', V, '--notes-file', notesFile, '--verify-tag']);
}

step(10, 'Desktop installers (desktop.yml runs on the tag and attaches them)');
const expected = [`AICO-Setup-${V}-win-x64.exe`, `AICO-${V}-linux-x64.AppImage`, `AICO-${V}-linux-x64.deb`, 'latest.yml', 'latest-linux.yml', `aico-vscode-${VSIX}.vsix`];
log(`   expect assets: ${expected.join(', ')}`);
if (opt.execute && opt.wait) {
  await waitForRun('desktop.yml', { branch: TAG });
  const assets = cap('gh', ['release', 'view', TAG, '--repo', REPO, '--json', 'assets', '--jq', '.assets[].name']).out.split('\n');
  const missing = expected.filter(a => !assets.includes(a));
  if (missing.length) die(`release ${TAG} is missing: ${missing.join(', ')}`);
  log('   all assets attached');
}

step(11, 'Every README download link answers (curl -sIL)');
const links = [...new Set([...(readmeAfter.matchAll(/https:\/\/github\.com\/[^)\s]+\/releases\/download\/[^)\s]+/g))].map(m => m[0]))];
for (const url of links) {
  if (!opt.execute || !opt.wait) { log(`   curl -sIL -o /dev/null -w "%{http_code}" ${url}`); continue; }
  const r = cap('curl', ['-sIL', '-o', os.platform() === 'win32' ? 'NUL' : '/dev/null', '-w', '%{http_code}', url]);
  log(`   ${r.out} ${url}`);
  if (r.out !== '200') die(`${url} answered ${r.out || r.err}`);
}

step(12, 'Website shows the new version (GitHub Pages serves docs/ from main)');
log(`   curl -s ${SITE} | grep 'v${V}'`);
if (opt.execute && opt.wait) {
  let seen = false;
  for (let i = 0; i < 20 && !seen; i++) {
    seen = cap('curl', ['-s', SITE]).out.includes(`<span class="ver">v${V}</span>`);
    if (!seen) await sleep(30_000);
  }
  log(seen ? '   website is live at the new version' : '   ! website not updated after 10 min — check the Pages deployment by hand (not fatal)');
}

log(`\n${opt.execute ? 'Released' : 'Planned'} ${V}.${opt.execute ? '' : ' Nothing was changed.'}`);
log('Still by hand: npm publish (owner only, if ever); announce; record anything surprising in docs/engineering/releasing.md.');
if (!opt.execute && problems.length) process.exit(1);

// ── CI waiting ───────────────────────────────────────────────────────────────

/** Find the workflow run for this commit/tag, then watch it to the end. Red stops the release. */
async function waitForRun(workflow, { commit, branch }) {
  const filter = commit ? ['--commit', commit] : ['--branch', branch];
  let id = null;
  for (let i = 0; i < 40 && !id; i++) {
    const r = cap('gh', ['run', 'list', '--repo', REPO, '--workflow', workflow, ...filter, '--limit', '1', '--json', 'databaseId', '--jq', '.[0].databaseId']);
    id = r.ok && r.out ? r.out : null;
    if (!id) await sleep(15_000);
  }
  if (!id) die(`no ${workflow} run appeared for ${commit ?? branch} after 10 minutes`);
  log(`   watching ${workflow} run ${id}`);
  const r = spawnSync('gh', ['run', 'watch', id, '--repo', REPO, '--exit-status', '--interval', '30'], { stdio: 'inherit' });
  if (r.status !== 0) die(`${workflow} run ${id} is not green. Do not tag or announce. Fix forward on main, then re-run this command — it resumes.`);
}
