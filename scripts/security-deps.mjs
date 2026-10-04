#!/usr/bin/env node
/**
 * Dependency and supply-chain checks (ADR 0026): what we ship is only as safe
 * as what it pulls in, and the cheap moment to notice is before the lockfile
 * change is merged, not after an advisory names a release.
 *
 *   lockfiles  every package resolves from https://registry.npmjs.org with a
 *              sha512 integrity hash; no git, http, file or tarball-URL
 *              dependency can slip in through a lockfile edit, and package.json
 *              specs say the same. Offline.
 *   licences   production dependencies of every package we distribute carry a
 *              licence compatible with shipping AICO under PolyForm
 *              Noncommercial (permissive: MIT, ISC, BSD, Apache-2.0, …).
 *              Copyleft (GPL/AGPL/LGPL/SSPL/EUPL), non-commercial and unknown
 *              licences fail unless scripts/security/licence-exceptions.json
 *              records a reviewed reason. Read from the lockfiles' own
 *              `license` fields (node_modules as fallback). Offline.
 *   audit      `npm audit --omit=dev` per package; high and critical advisories
 *              fail unless scripts/security/audit-allowlist.json names them
 *              with a reason and an expiry date (an exception that never
 *              lapses is a decision nobody re-made). Needs the registry.
 *   sbom       CycloneDX SBOMs via npm's own `npm sbom` (npm >= 10; no
 *              dependency added) into --out DIR. From the lockfile alone.
 *
 * Usage: node scripts/security-deps.mjs [lockfiles] [licences] [audit] [sbom --out DIR]
 *        (no subcommand = lockfiles + licences, the offline pair the
 *        standards job runs). Exit 0 clean, 1 findings, 2 usage/tool error.
 *
 * What it does not do: judge whether a dependency is trustworthy. That is
 * the ADR rule for adding one (docs/engineering/security.md) and Dependabot's
 * job for keeping it current (.github/dependabot.yml).
 */

import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const outAt = argv.indexOf('--out');
const outDir = outAt >= 0 ? path.resolve(argv[outAt + 1] ?? '') : path.join(root, 'sbom');
const pkgAt = argv.indexOf('--package');
const only = pkgAt >= 0 ? argv[pkgAt + 1] : null;
const commands = argv.filter((a, i) => !a.startsWith('--') && !(outAt >= 0 && i === outAt + 1) && !(pkgAt >= 0 && i === pkgAt + 1));
const run = new Set(commands.length ? commands : ['lockfiles', 'licences']);
for (const c of run) if (!['lockfiles', 'licences', 'licenses', 'audit', 'sbom'].includes(c)) { console.error(`security-deps: unknown command ${c}`); process.exit(2); }

/** The packages we build and ship, each with its own lockfile. */
const PACKAGES = [
  { dir: '.', name: 'engine (npm/github)', shipped: true },
  { dir: 'web', name: 'web client (bundled into web-dist)', shipped: true },
  { dir: 'desktop', name: 'desktop (installers)', shipped: true },
  { dir: 'vscode-extension', name: 'VS Code extension (vsix)', shipped: true },
  { dir: 'vscode-extension/webview', name: 'VS Code webview (bundled)', shipped: true },
].filter(p => fs.existsSync(path.join(root, p.dir, 'package-lock.json')) && (!only || p.dir === only));

const findings = [];
const notes = [];
const fail = (check, where, message) => findings.push({ check, where, message });

const readJson = rel => JSON.parse(fs.readFileSync(path.join(root, rel), 'utf8'));
const lockOf = p => readJson(path.join(p.dir, 'package-lock.json'));
const nameOf = key => key.replace(/^.*node_modules\//, '');

// ── lockfiles ────────────────────────────────────────────────────────────────

const REGISTRY = 'https://registry.npmjs.org/';
const BAD_SPEC = /^(?:git(?:\+\w+)?:|github:|gitlab:|bitbucket:|https?:|file:|link:)|^[\w.-]+\/[\w.-]+(?:#.*)?$/;

function checkLockfiles() {
  for (const p of PACKAGES) {
    const rel = path.join(p.dir, 'package-lock.json').replace(/\\/g, '/');
    const lock = lockOf(p);
    if ((lock.lockfileVersion ?? 0) < 2) fail('lockfiles', rel, `lockfileVersion ${lock.lockfileVersion} — regenerate with npm >= 7 so integrity and licences are recorded`);
    for (const [key, v] of Object.entries(lock.packages ?? {})) {
      if (!key || v.link) continue; // the root, and workspace links
      if (!key.includes('node_modules/')) continue; // a local workspace folder
      const where = `${rel} ${nameOf(key)}@${v.version ?? '?'}`;
      if (!v.resolved) {
        // Optional platform binaries for another OS are recorded without a URL when skipped.
        if (!v.optional && !v.inBundle) fail('lockfiles', where, 'no resolved URL');
        continue;
      }
      if (!v.resolved.startsWith(REGISTRY)) fail('lockfiles', where, `resolved from ${v.resolved.split('/').slice(0, 3).join('/')} — only ${REGISTRY} is allowed`);
      if (!v.integrity) fail('lockfiles', where, 'no integrity hash');
      else if (!/^sha512-/.test(v.integrity)) fail('lockfiles', where, `integrity is ${v.integrity.split('-')[0]}, not sha512`);
    }
    const pkg = readJson(path.join(p.dir, 'package.json'));
    for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
      for (const [name, spec] of Object.entries(pkg[field] ?? {})) {
        if (BAD_SPEC.test(String(spec))) fail('lockfiles', `${p.dir}/package.json ${field}.${name}`, `"${spec}" is not a registry version range`);
      }
    }
  }
}

// ── licences ─────────────────────────────────────────────────────────────────

/** Permissive licences compatible with distributing AICO. */
const ALLOWED = new Set([
  'MIT', 'MIT-0', 'ISC', 'BSD-2-Clause', 'BSD-3-Clause', '0BSD', 'Apache-2.0', 'BlueOak-1.0.0', 'CC0-1.0',
  'Unlicense', 'Python-2.0', 'Zlib', 'CC-BY-3.0', 'CC-BY-4.0', 'WTFPL', 'BSL-1.0', 'PSF-2.0',
]);
/** Fails outright: copyleft or non-commercial terms. */
const DENIED = /\b(?:A?GPL|LGPL|SSPL|EUPL|OSL|CPAL|CC-BY-NC|CC-BY-SA|Commons-Clause|BUSL|Elastic)/i;

/** An SPDX expression is acceptable when an OR has an allowed side and every AND part is allowed. */
function acceptable(expr) {
  const e = expr.replace(/[()]/g, ' ').trim();
  if (/\s+OR\s+/i.test(e)) return e.split(/\s+OR\s+/i).some(acceptable);
  if (/\s+AND\s+/i.test(e)) return e.split(/\s+AND\s+/i).every(acceptable);
  return ALLOWED.has(e.replace(/\+$/, ''));
}

function licenceOf(p, key, entry) {
  let lic = entry.license;
  if (!lic) {
    try {
      const pj = readJson(path.join(p.dir, key, 'package.json'));
      lic = pj.license ?? (Array.isArray(pj.licenses) ? pj.licenses.map(l => l.type ?? l).join(' OR ') : undefined);
    } catch { /* not installed: unknown */ }
  }
  if (lic && typeof lic === 'object') lic = lic.type;
  return typeof lic === 'string' ? lic : null;
}

function checkLicences() {
  const exceptions = (() => { try { return readJson('scripts/security/licence-exceptions.json').exceptions ?? {}; } catch { return {}; } })();
  let counted = 0;
  for (const p of PACKAGES.filter(x => x.shipped)) {
    const lock = lockOf(p);
    for (const [key, v] of Object.entries(lock.packages ?? {})) {
      if (!key || v.dev || v.devOptional || v.link || !key.includes('node_modules/')) continue;
      counted++;
      const name = nameOf(key);
      const lic = licenceOf(p, key, v);
      const ex = exceptions[name];
      if (ex && (!('licence' in ex) || ex.licence === lic)) continue;
      const where = `${p.dir}/package-lock.json ${name}@${v.version}`;
      if (!lic) fail('licences', where, 'no licence declared — check the package and record it in scripts/security/licence-exceptions.json');
      else if (DENIED.test(lic) && !acceptable(lic)) fail('licences', where, `${lic} — copyleft or non-commercial terms cannot ship inside AICO`);
      else if (!acceptable(lic)) fail('licences', where, `${lic} is not on the permissive allow-list — review it and record the decision in licence-exceptions.json`);
    }
  }
  notes.push(`licences: ${counted} production package(s) checked across ${PACKAGES.length} lockfile(s)`);
}

// ── audit ────────────────────────────────────────────────────────────────────

function npm(args, cwd) {
  // npm is npm.cmd on Windows; shell is needed to run a .cmd, and every
  // argument here is a constant.
  return spawnSync('npm', args, { cwd, encoding: 'utf8', shell: process.platform === 'win32', maxBuffer: 256 * 1024 * 1024, timeout: 180_000 }); // security-allow: shell-true — constant arguments, Windows needs a shell for npm.cmd
}

function checkAudit() {
  const allow = (() => { try { return readJson('scripts/security/audit-allowlist.json').advisories ?? []; } catch { return []; } })();
  const today = new Date().toISOString().slice(0, 10);
  for (const p of PACKAGES) {
    const r = npm(['audit', '--omit=dev', '--json'], path.join(root, p.dir));
    let report;
    try { report = JSON.parse(r.stdout); } catch {
      fail('audit', p.dir, `npm audit produced no report (${(r.stderr || r.error?.message || '').split('\n')[0]}) — it needs the registry`);
      continue;
    }
    if (report.error) { fail('audit', p.dir, `npm audit: ${report.error.summary ?? report.error.code}`); continue; }
    const meta = report.metadata?.vulnerabilities ?? {};
    notes.push(`audit ${p.dir}: critical ${meta.critical ?? 0}, high ${meta.high ?? 0}, moderate ${meta.moderate ?? 0}, low ${meta.low ?? 0}`);
    for (const [name, v] of Object.entries(report.vulnerabilities ?? {})) {
      if (v.severity !== 'high' && v.severity !== 'critical') continue;
      const ids = (v.via ?? []).filter(x => typeof x === 'object').map(x => (x.url ?? '').split('/').pop() || String(x.source));
      const entry = allow.find(a => a.package === name && (!a.id || ids.includes(a.id)));
      if (entry && (!entry.expires || entry.expires >= today)) continue;
      const why = entry ? `allow-list entry expired ${entry.expires}` : (ids.join(', ') || 'via ' + (v.via ?? []).join(', '));
      fail('audit', `${p.dir} ${name}`, `${v.severity}: ${why}${v.fixAvailable ? ' — a fix is available (npm audit fix / an override)' : ''}`);
    }
  }
}

// ── sbom ─────────────────────────────────────────────────────────────────────

function writeSboms() {
  fs.mkdirSync(outDir, { recursive: true });
  for (const p of PACKAGES) {
    const r = npm(['sbom', '--sbom-format', 'cyclonedx', '--omit', 'dev', '--package-lock-only'], path.join(root, p.dir));
    if (r.status !== 0 || !r.stdout.trim().startsWith('{')) { fail('sbom', p.dir, `npm sbom failed: ${(r.stderr || '').split('\n')[0]}`); continue; }
    const file = path.join(outDir, `aico-${p.dir === '.' ? 'engine' : p.dir.replace(/\//g, '-')}.cdx.json`);
    fs.writeFileSync(file, r.stdout);
    const n = JSON.parse(r.stdout).components?.length ?? 0;
    notes.push(`sbom ${p.dir}: ${n} component(s) → ${path.relative(root, file)}`);
  }
}

if (run.has('lockfiles')) checkLockfiles();
if (run.has('licences') || run.has('licenses')) checkLicences();
if (run.has('audit')) checkAudit();
if (run.has('sbom')) writeSboms();

for (const n of notes) console.log(`security-deps: ${n}`);
if (findings.length === 0) { console.log(`security-deps: OK (${[...run].join(', ')})`); process.exit(0); }
console.error(`security-deps: ${findings.length} problem(s)\n`);
for (const f of findings) console.error(`  ✗ [${f.check}] ${f.where} — ${f.message}`);
process.exit(1);
