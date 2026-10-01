/**
 * DependencyAudit — known vulnerabilities and licences in a project's dependencies.
 *
 * Asked "are our dependencies safe to ship?", an agent ran `npm audit` through
 * Bash and got 40K of JSON, or the human-readable form with a box per advisory,
 * and summarised it from whatever fitted in its window. Licences were never
 * looked at at all. This runs each ecosystem's own auditor and reads its
 * machine output into one compact table: severity counts, the worst advisories
 * with the version that fixes them, and the licences that need a person.
 *
 * **The ecosystem's own tool, or nothing.** `npm audit` / `pnpm audit`,
 * `pip-audit`, `cargo audit`, `dotnet list package --vulnerable`,
 * `govulncheck`. Nothing is installed: a missing auditor is reported with the
 * command that installs it, and the rest of the report still runs. There is no
 * vulnerability database of our own to go stale.
 *
 * **Licences from installed metadata, offline.** `node_modules/**\/package.json`
 * and Python `*.dist-info/METADATA` in the project's virtualenv. Anything outside
 * the allowlist is listed for review — copyleft and undeclared licences by
 * default — and **nothing is ever blocked**: whether GPL is acceptable is a
 * legal decision about how the software is distributed, not something a
 * coding agent can know. The allowlist is the user's (`dependencyAudit.allowLicenses`
 * in settings, project or global, or `allow` per call).
 *
 * **Deferred.** Called a few times in a project's life; its schema loads with
 * the `audit` group (`tools/deferred.ts`), never on every request.
 *
 * Severity is what the auditor says. pip-audit, cargo audit and govulncheck
 * publish no severity of their own, and their advisories say "unknown" rather
 * than a number computed here from a CVSS vector they may not carry.
 *
 * @module tools/dependency-audit
 */

import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { projectRoot } from '../run-context.js';

export type Severity = 'critical' | 'high' | 'moderate' | 'low' | 'info' | 'unknown';
const SEVERITIES: Severity[] = ['critical', 'high', 'moderate', 'low', 'info', 'unknown'];

export interface Advisory {
  pkg: string;
  version?: string;
  severity: Severity;
  id: string;
  title: string;
  /** The version (or upgrade) that fixes it, when the auditor knows. */
  fix?: string;
}

export interface EcosystemAudit {
  ecosystem: string;
  tool: string;
  status: 'ok' | 'missing' | 'error' | 'skipped';
  /** Why it did not run, or what to do about it. */
  message?: string;
  advisories: Advisory[];
  /** Vulnerable packages per severity, as the auditor counts them. */
  counts: Partial<Record<Severity, number>>;
}

export interface LicenseFinding {
  pkg: string;
  version: string;
  license: string;
  reason: 'copyleft' | 'unknown' | 'not on allowlist';
  source: 'node_modules' | 'python';
}

// ─── Running an auditor ──────────────────────────────────────────────────

interface Ran { code: number; stdout: string; stderr: string; missing: boolean }

/**
 * Run a fixed command. Arguments are constants from this file, never model
 * text; `shell` is needed on Windows only to resolve `npm.cmd` and friends.
 */
function run(cmd: string, args: string[], cwd: string, timeoutMs: number, signal?: AbortSignal): Promise<Ran> {
  return new Promise(resolve => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const done = (r: Ran) => { if (!settled) { settled = true; clearTimeout(timer); resolve(r); } };
    let child: ReturnType<typeof spawn>;
    // cmd.exe joins arguments with spaces; a path argument must arrive quoted.
    const argv = process.platform === 'win32' ? args.map(a => (/[\s&|<>^()]/.test(a) ? `"${a.replace(/"/g, '""')}"` : a)) : args;
    try {
      child = spawn(cmd, argv, { cwd, shell: process.platform === 'win32', windowsHide: true, signal });
    } catch {
      done({ code: -1, stdout: '', stderr: '', missing: true });
      return;
    }
    const timer = setTimeout(() => { try { child.kill(); } catch { /* already gone */ } done({ code: -1, stdout, stderr: `${stderr}\n(timed out after ${Math.round(timeoutMs / 1000)}s)`, missing: false }); }, timeoutMs);
    child.stdout?.on('data', (d: Buffer) => { if (stdout.length < 30_000_000) stdout += d.toString('utf8'); });
    child.stderr?.on('data', (d: Buffer) => { if (stderr.length < 200_000) stderr += d.toString('utf8'); });
    child.on('error', (e: NodeJS.ErrnoException) => done({ code: -1, stdout, stderr: String(e.message), missing: e.code === 'ENOENT' }));
    child.on('close', code => {
      const missing = code === 127 || code === 9009
        || /is not recognized as an internal or external command|command not found|no such command|No such file or directory/i.test(stderr);
      done({ code: code ?? -1, stdout, stderr, missing: missing && !stdout.trim().startsWith('{') });
    });
  });
}

/** The first JSON value in a tool's stdout — some print a banner before it. */
function firstJson(text: string): unknown {
  const start = text.search(/[{[]/);
  if (start < 0) return undefined;
  try { return JSON.parse(text.slice(start)); } catch { /* fall through */ }
  const end = Math.max(text.lastIndexOf('}'), text.lastIndexOf(']'));
  try { return JSON.parse(text.slice(start, end + 1)); } catch { return undefined; }
}

const sev = (s: unknown): Severity => {
  const v = String(s ?? '').toLowerCase();
  if (v === 'medium') return 'moderate';
  return (SEVERITIES as string[]).includes(v) ? v as Severity : 'unknown';
};

/** `<4.17.21` or `>=1.0.0 <1.2.6` → `>=4.17.21` / `>=1.2.6`: the first version outside the range. */
function patchedFrom(range: unknown): string | undefined {
  const m = /<(=?)\s*([0-9][\w.+-]*)\s*$/.exec(String(range ?? ''));
  return m ? `${m[1] ? '>' : '>='}${m[2]}` : undefined;
}

/** Numeric comparison of dotted versions, enough to pick the newer of two fix versions. */
function newer(a: string, b: string): boolean {
  const pa = a.replace(/^[^0-9]*/, '').split(/[.+-]/).map(Number);
  const pb = b.replace(/^[^0-9]*/, '').split(/[.+-]/).map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0; const y = pb[i] || 0;
    if (x !== y) return x > y;
  }
  return false;
}

const advisoryId = (url: unknown, fallback: unknown): string =>
  /(GHSA-[\w-]+|CVE-\d+-\d+)/.exec(String(url ?? ''))?.[1] ?? String(fallback ?? '?');

// ─── Parsers (exported for the tests) ────────────────────────────────────

/** `npm audit --json` (v7+, auditReportVersion 2) and the v6 / pnpm `advisories` form. */
export function parseNpmAudit(json: unknown): Pick<EcosystemAudit, 'advisories' | 'counts'> & { error?: string } {
  const j = (json ?? {}) as Record<string, any>;
  if (j.error) return { advisories: [], counts: {}, error: String(j.error.summary ?? j.error.code ?? j.error) };
  const counts: Partial<Record<Severity, number>> = {};
  for (const s of SEVERITIES) {
    const n = Number(j.metadata?.vulnerabilities?.[s] ?? 0);
    if (n > 0) counts[s] = n;
  }
  const advisories: Advisory[] = [];
  if (j.vulnerabilities && typeof j.vulnerabilities === 'object') {
    for (const [name, v] of Object.entries<any>(j.vulnerabilities)) {
      const fa = v.fixAvailable;
      for (const via of v.via ?? []) {
        if (typeof via !== 'object' || !via) continue; // a string is "vulnerable through that package"
        const pkg = String(via.name ?? name);
        // The patched version of the vulnerable package, and — when npm's fix is
        // to upgrade something else that pins it — that upgrade too.
        const patched = patchedFrom(via.range);
        const upgrade = fa && typeof fa === 'object'
          ? (fa.name !== pkg || !patched ? `${fa.name}@${fa.version}${fa.isSemVerMajor ? ' (major)' : ''}` : undefined)
          : fa === true && !patched ? 'npm audit fix' : undefined;
        const fix = [patched, upgrade && patched ? `(upgrade ${upgrade})` : upgrade].filter(Boolean).join(' ');
        // npm splits an advisory with an OR range into one entry per branch
        // (`<0.2.4`, `>=1.0.0 <1.2.6`). Keep the newest fix: it is the version
        // that clears every branch.
        const id = advisoryId(via.url, via.source);
        const twin = advisories.find(a => a.pkg === pkg && a.id === id);
        if (twin) {
          if (patched && twin.fix && newer(patched, twin.fix.split(' ')[0]!)) twin.fix = fix;
          continue;
        }
        advisories.push({
          pkg,
          severity: sev(via.severity),
          id,
          title: String(via.title ?? ''),
          fix: fix || 'none yet',
        });
      }
    }
  } else if (j.advisories && typeof j.advisories === 'object') {
    for (const a of Object.values<any>(j.advisories)) {
      advisories.push({
        pkg: String(a.module_name ?? '?'),
        ...(a.findings?.[0]?.version ? { version: String(a.findings[0].version) } : {}),
        severity: sev(a.severity),
        id: String(a.github_advisory_id ?? advisoryId(a.url, a.id)),
        title: String(a.title ?? ''),
        fix: a.patched_versions && a.patched_versions !== '<0.0.0' ? String(a.patched_versions) : 'none yet',
      });
    }
  }
  return { advisories: dedupe(advisories), counts };
}

/** `pip-audit -f json`: `{ dependencies: [{ name, version, vulns: [{ id, fix_versions, aliases }] }] }` (or the old bare list). */
export function parsePipAudit(json: unknown): Pick<EcosystemAudit, 'advisories' | 'counts'> {
  const deps = Array.isArray(json) ? json : ((json ?? {}) as { dependencies?: unknown[] }).dependencies ?? [];
  const advisories: Advisory[] = [];
  let vulnerable = 0;
  for (const d of deps as any[]) {
    if (!d?.vulns?.length) continue;
    vulnerable++;
    for (const v of d.vulns) {
      const ghsa = (v.aliases ?? []).find((a: string) => /^GHSA-/.test(a));
      const cve = (v.aliases ?? []).find((a: string) => /^CVE-/.test(a));
      advisories.push({
        pkg: String(d.name), version: String(d.version), severity: 'unknown',
        id: String(cve ?? ghsa ?? v.id),
        // The first sentence of the description, without its Markdown headings.
        title: String(v.description ?? '').replace(/^#+[ \t]+[^\n]*\n?/gm, '').trim().split(/(?<=\.)\s/)[0]!.slice(0, 120),
        fix: v.fix_versions?.length ? `>=${v.fix_versions[0]}` : 'none yet',
      });
    }
  }
  return { advisories: dedupe(advisories), counts: vulnerable ? { unknown: vulnerable } : {} };
}

/** `cargo audit --json`: `{ vulnerabilities: { list: [{ advisory, versions: { patched }, package }] } }`. */
export function parseCargoAudit(json: unknown): Pick<EcosystemAudit, 'advisories' | 'counts'> {
  const list = ((json ?? {}) as any).vulnerabilities?.list ?? [];
  const advisories: Advisory[] = (list as any[]).map(v => ({
    pkg: String(v.package?.name ?? v.advisory?.package ?? '?'),
    version: String(v.package?.version ?? ''),
    severity: sev(v.advisory?.severity),
    id: String(v.advisory?.id ?? '?'),
    title: String(v.advisory?.title ?? ''),
    fix: v.versions?.patched?.length ? String(v.versions.patched.join(' or ')) : 'none yet',
  }));
  const counts: Partial<Record<Severity, number>> = {};
  for (const a of advisories) counts[a.severity] = (counts[a.severity] ?? 0) + 1;
  return { advisories: dedupe(advisories), counts };
}

/** `dotnet list package --vulnerable --include-transitive --format json`. */
export function parseDotnetVulnerable(json: unknown): Pick<EcosystemAudit, 'advisories' | 'counts'> {
  const advisories: Advisory[] = [];
  for (const project of ((json ?? {}) as any).projects ?? []) {
    for (const fw of project.frameworks ?? []) {
      for (const p of [...(fw.topLevelPackages ?? []), ...(fw.transitivePackages ?? [])]) {
        for (const v of p.vulnerabilities ?? []) {
          advisories.push({
            pkg: String(p.id), version: String(p.resolvedVersion ?? ''), severity: sev(v.severity),
            id: advisoryId(v.advisoryurl, v.advisoryurl), title: '', fix: 'see advisory',
          });
        }
      }
    }
  }
  const unique = dedupe(advisories);
  const counts: Partial<Record<Severity, number>> = {};
  for (const a of unique) counts[a.severity] = (counts[a.severity] ?? 0) + 1;
  return { advisories: unique, counts };
}

/** govulncheck's `-json` output is a stream of pretty-printed objects, one after another. */
export function splitJsonStream(text: string): unknown[] {
  const out: unknown[] = [];
  let depth = 0; let start = -1; let inString = false; let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === '{') { if (depth === 0) start = i; depth++; }
    else if (c === '}' && depth > 0) {
      depth--;
      if (depth === 0 && start >= 0) {
        try { out.push(JSON.parse(text.slice(start, i + 1))); } catch { /* a torn object; skip it */ }
        start = -1;
      }
    }
  }
  return out;
}

/**
 * `govulncheck -json ./...`. A finding whose trace reaches a function is code
 * this module actually calls; the rest are imported but unreached, and are
 * listed after them as lower priority, as govulncheck itself does.
 */
export function parseGovulncheck(text: string): Pick<EcosystemAudit, 'advisories' | 'counts'> {
  const summaries = new Map<string, string>();
  const found = new Map<string, Advisory & { called: boolean }>();
  for (const msg of splitJsonStream(text) as any[]) {
    if (msg.osv?.id) summaries.set(msg.osv.id, String(msg.osv.summary ?? ''));
    const f = msg.finding;
    if (!f?.osv) continue;
    const top = f.trace?.[0] ?? {};
    const called = Boolean(top.function);
    const prev = found.get(f.osv);
    if (prev && (prev.called || !called)) continue;
    found.set(f.osv, {
      pkg: String(top.module ?? '?'), version: String(top.version ?? ''), severity: 'unknown',
      id: String(f.osv), title: '', fix: f.fixed_version ? String(f.fixed_version) : 'none yet', called,
    });
  }
  const advisories = [...found.values()]
    .sort((a, b) => Number(b.called) - Number(a.called))
    .map(({ called, ...a }) => ({ ...a, title: `${called ? '' : '(imported, not called) '}${summaries.get(a.id) ?? ''}`.trim() }));
  const reachable = [...found.values()].filter(a => a.called).length;
  return { advisories, counts: reachable ? { unknown: reachable } : {} };
}

function dedupe(list: Advisory[]): Advisory[] {
  const seen = new Set<string>();
  return list.filter(a => { const k = `${a.pkg}|${a.id}`; if (seen.has(k)) return false; seen.add(k); return true; });
}

// ─── Licences ────────────────────────────────────────────────────────────

/**
 * The default allowlist: permissive licences that impose nothing beyond
 * attribution. Everything else is listed for a person to look at.
 */
export const DEFAULT_ALLOWED_LICENSES = [
  'MIT', 'MIT-0', 'ISC', 'BSD-2-Clause', 'BSD-3-Clause', 'BSD', '0BSD', 'Apache-2.0', 'Unlicense', 'CC0-1.0',
  'Zlib', 'BlueOak-1.0.0', 'Python-2.0', 'PSF-2.0', 'BSL-1.0', 'CC-BY-4.0', 'CC-BY-3.0', 'WTFPL', 'X11', 'NCSA', 'HPND',
];

const COPYLEFT = /\b(A?GPL|LGPL|MPL|EPL|EUPL|CDDL|OSL|CPAL|SSPL|CC-BY-SA|CC-BY-NC|Sleepycat|RPL|QPL|GNU|Mozilla|Eclipse|copyleft|General Public)/i;
const UNKNOWN = /^(|UNKNOWN|UNLICENSED|NONE|NOASSERTION|SEE LICEN[CS]E IN.*|Custom.*|Other.*|Proprietary.*|Commercial.*|Dual License)$/i;

/** Spellings found in the wild, mapped to their SPDX id. */
const ALIASES: Record<string, string> = {
  'mit license': 'MIT', 'the mit license': 'MIT', 'mit/x11': 'MIT', 'expat': 'MIT',
  'apache 2.0': 'Apache-2.0', 'apache-2': 'Apache-2.0', 'apache 2': 'Apache-2.0', 'apache license 2.0': 'Apache-2.0',
  'apache license, version 2.0': 'Apache-2.0', 'apache software license': 'Apache-2.0', 'apache2': 'Apache-2.0',
  'bsd license': 'BSD', 'new bsd license': 'BSD-3-Clause', 'bsd-3': 'BSD-3-Clause', '3-clause bsd license': 'BSD-3-Clause',
  'simplified bsd': 'BSD-2-Clause', 'isc license': 'ISC', 'isc license (iscl)': 'ISC', 'iscl': 'ISC',
  'python software foundation license': 'PSF-2.0', 'psf': 'PSF-2.0', 'psfl': 'PSF-2.0',
  'the unlicense': 'Unlicense', 'the unlicense (unlicense)': 'Unlicense', 'public domain': 'Unlicense',
  'cc0': 'CC0-1.0', 'zlib license': 'Zlib', 'boost software license 1.0 (bsl-1.0)': 'BSL-1.0',
};

function canonical(id: string): string {
  const t = id.trim().replace(/^\(+|\)+$/g, '').trim();
  return ALIASES[t.toLowerCase()] ?? t;
}

/**
 * Whether a licence expression is acceptable under the allowlist.
 *
 * SPDX `OR` passes when any branch does (the user may choose); `AND` needs
 * every part; `WITH <exception>` is judged by its licence. Free text that is
 * not an expression is judged whole, after alias mapping.
 */
export function classifyLicense(expr: string, allow: readonly string[]): LicenseFinding['reason'] | undefined {
  const text = expr.trim();
  if (UNKNOWN.test(text)) return 'unknown';
  const allowed = new Set(allow.map(a => canonical(a).toLowerCase()));
  const branches = text.replace(/^\(|\)$/g, '').split(/\s+OR\s+|\s*\/\s*/i);
  let worst: LicenseFinding['reason'] | undefined = 'unknown';
  for (const branch of branches) {
    const parts = branch.split(/\s+AND\s+/i).map(p => canonical(p.replace(/\s+WITH\s+.*$/i, '')));
    const bad = parts.map(p => (allowed.has(p.toLowerCase()) ? undefined : COPYLEFT.test(p) ? 'copyleft' as const : UNKNOWN.test(p) ? 'unknown' as const : 'not on allowlist' as const))
      .find(Boolean);
    if (!bad) return undefined;
    // Report the most actionable reason among the branches.
    if (bad === 'copyleft' || worst === 'unknown') worst = bad;
  }
  return worst;
}

/** `license` as npm packages actually write it: a string, an object, or a `licenses` array. */
function npmLicense(pkg: Record<string, any>): string {
  const l = pkg.license;
  if (typeof l === 'string') return l;
  if (l && typeof l === 'object' && l.type) return String(l.type);
  if (Array.isArray(pkg.licenses)) return pkg.licenses.map((x: any) => (typeof x === 'string' ? x : x?.type)).filter(Boolean).join(' OR ');
  return 'UNKNOWN';
}

/** Every installed package in `node_modules`, nested and scoped, pnpm's store included. Bounded. */
export function scanNodeLicenses(root: string, limit = 30_000): Array<{ pkg: string; version: string; license: string }> {
  const out = new Map<string, { pkg: string; version: string; license: string }>();
  const seenDirs = new Set<string>();
  const visit = (nm: string) => {
    let real: string;
    try { real = fs.realpathSync(nm); } catch { return; }
    if (seenDirs.has(real) || out.size >= limit) return;
    seenDirs.add(real);
    let entries: string[];
    try { entries = fs.readdirSync(nm); } catch { return; }
    for (const e of entries) {
      if (e === '.bin' || e === '.cache') continue;
      if (e === '.pnpm') {
        for (const store of safeList(path.join(nm, e))) visit(path.join(nm, e, store, 'node_modules'));
        continue;
      }
      const dirs = e.startsWith('@') ? safeList(path.join(nm, e)).map(s => path.join(nm, e, s)) : [path.join(nm, e)];
      for (const dir of dirs) {
        try {
          const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')) as Record<string, any>;
          if (pkg.name && pkg.version) {
            const key = `${pkg.name}@${pkg.version}`;
            if (!out.has(key)) out.set(key, { pkg: String(pkg.name), version: String(pkg.version), license: npmLicense(pkg) });
          }
        } catch { /* not a package directory */ }
        visit(path.join(dir, 'node_modules'));
      }
    }
  };
  visit(path.join(root, 'node_modules'));
  return [...out.values()];
}

function safeList(dir: string): string[] {
  try { return fs.readdirSync(dir); } catch { return []; }
}

/** A project's virtualenv site-packages, if it keeps one in the conventional place. */
export function findSitePackages(root: string): string | undefined {
  for (const venv of ['.venv', 'venv', 'env', '.env']) {
    const base = path.join(root, venv);
    try { if (!fs.statSync(base).isDirectory()) continue; } catch { continue; }
    const win = path.join(base, 'Lib', 'site-packages');
    if (fs.existsSync(win)) return win;
    for (const lib of ['lib', 'lib64']) {
      for (const py of safeList(path.join(base, lib)).filter(d => /^python3/.test(d))) {
        const sp = path.join(base, lib, py, 'site-packages');
        if (fs.existsSync(sp)) return sp;
      }
    }
  }
  return undefined;
}

/** `License :: OSI Approved :: MIT License` → `MIT License`, then the alias table. */
function fromClassifier(c: string): string {
  const last = c.split('::').map(s => s.trim()).pop() ?? '';
  const m = /\(([^)]+)\)$/.exec(last);
  return canonical(ALIASES[last.toLowerCase()] ? last : (m && !/\s/.test(m[1]!) ? m[1]! : last));
}

/** Installed Python distributions' licences, from `*.dist-info/METADATA` headers. */
export function scanPythonLicenses(sitePackages: string): Array<{ pkg: string; version: string; license: string }> {
  const out: Array<{ pkg: string; version: string; license: string }> = [];
  for (const d of safeList(sitePackages).filter(n => n.endsWith('.dist-info'))) {
    let meta: string;
    try { meta = fs.readFileSync(path.join(sitePackages, d, 'METADATA'), 'utf8'); } catch { continue; }
    const head = meta.split(/\r?\n\r?\n/)[0] ?? '';
    const field = (k: string) => new RegExp(`^${k}:\\s*(.+)$`, 'mi').exec(head)?.[1]?.trim();
    const classifiers = [...head.matchAll(/^Classifier:\s*License ::(.+)$/gmi)].map(m => fromClassifier(`License ::${m[1]}`))
      .filter(c => c && !/^OSI Approved$/i.test(c));
    const declared = field('License');
    const license = field('License-Expression')
      ?? (declared && declared.length <= 60 && !/^UNKNOWN$/i.test(declared) ? canonical(declared) : undefined)
      ?? (classifiers.length ? classifiers.join(' OR ') : 'UNKNOWN');
    out.push({ pkg: field('Name') ?? d.replace(/-[^-]+\.dist-info$/, ''), version: field('Version') ?? '', license });
  }
  return out;
}

// ─── The tool ────────────────────────────────────────────────────────────

export interface DependencyAuditInput {
  /** Limit to these: npm, python, cargo, dotnet, go. Default: every one the project uses. */
  ecosystems?: string[];
  /** Licences allowed for this run, replacing the configured allowlist. */
  allow?: string[];
  /** Skip the licence scan. */
  licenses?: boolean;
}

const AUDIT_TIMEOUT_MS = 120_000;

/** Which ecosystems this project uses, from the files that say so. */
export function detectEcosystems(root: string): string[] {
  const has = (...names: string[]) => names.some(n => fs.existsSync(path.join(root, n)));
  const list: string[] = [];
  if (has('package.json')) list.push('npm');
  if (has('pyproject.toml', 'requirements.txt', 'setup.py', 'Pipfile') || findSitePackages(root)) list.push('python');
  if (has('Cargo.toml')) list.push('cargo');
  if (safeList(root).some(f => /\.(sln|slnx|csproj|fsproj|vbproj)$/i.test(f))) list.push('dotnet');
  if (has('go.mod')) list.push('go');
  return list;
}

async function auditOne(eco: string, root: string, signal?: AbortSignal): Promise<EcosystemAudit> {
  const base = (tool: string): EcosystemAudit => ({ ecosystem: eco, tool, status: 'ok', advisories: [], counts: {} });
  const missing = (tool: string, install: string): EcosystemAudit => ({ ...base(tool), status: 'missing', message: `${tool} is not installed; ${install} to audit these dependencies.` });
  const failed = (tool: string, r: Ran): EcosystemAudit => ({ ...base(tool), status: 'error', message: (r.stderr || r.stdout).trim().split('\n').slice(-3).join(' ').slice(0, 300) || `exit ${r.code}` });

  if (eco === 'npm') {
    const pnpm = fs.existsSync(path.join(root, 'pnpm-lock.yaml'));
    if (!pnpm && !fs.existsSync(path.join(root, 'package-lock.json')) && fs.existsSync(path.join(root, 'yarn.lock'))) {
      return { ...base('yarn'), status: 'skipped', message: 'yarn project: run `yarn npm audit` (Berry) or `yarn audit` (classic); its output is not read here.' };
    }
    const tool = pnpm ? 'pnpm audit' : 'npm audit';
    const r = await run(pnpm ? 'pnpm' : 'npm', ['audit', '--json'], root, AUDIT_TIMEOUT_MS, signal);
    if (r.missing) return missing(tool, `install ${pnpm ? 'pnpm' : 'Node.js/npm'}`);
    const json = firstJson(r.stdout);
    if (!json) return failed(tool, r);
    const parsed = parseNpmAudit(json);
    if (parsed.error) return { ...base(tool), status: 'error', message: /ENOLOCK|lockfile/i.test(parsed.error) ? 'no package-lock.json; run `npm install --package-lock-only` first.' : parsed.error.slice(0, 300) };
    return { ...base(tool), ...parsed };
  }

  if (eco === 'python') {
    const args = ['-f', 'json', '--progress-spinner', 'off'];
    const site = findSitePackages(root);
    if (fs.existsSync(path.join(root, 'requirements.txt'))) args.push('-r', 'requirements.txt');
    else if (site) args.push('--path', path.relative(root, site));
    else if (fs.existsSync(path.join(root, 'pyproject.toml'))) args.push('.');
    else return { ...base('pip-audit'), status: 'skipped', message: 'no requirements.txt, virtualenv or pyproject.toml to audit.' };
    const r = await run('pip-audit', args, root, AUDIT_TIMEOUT_MS, signal);
    if (r.missing) return missing('pip-audit', '`pipx install pip-audit` (or `pip install pip-audit`)');
    const json = firstJson(r.stdout);
    return json ? { ...base('pip-audit'), ...parsePipAudit(json) } : failed('pip-audit', r);
  }

  if (eco === 'cargo') {
    const r = await run('cargo', ['audit', '--json'], root, AUDIT_TIMEOUT_MS, signal);
    if (r.missing) return missing('cargo audit', '`cargo install cargo-audit`');
    const json = firstJson(r.stdout);
    return json ? { ...base('cargo audit'), ...parseCargoAudit(json) } : failed('cargo audit', r);
  }

  if (eco === 'dotnet') {
    const r = await run('dotnet', ['list', 'package', '--vulnerable', '--include-transitive', '--format', 'json'], root, AUDIT_TIMEOUT_MS, signal);
    if (r.missing) return missing('dotnet list package', 'install the .NET SDK (7.0.200 or later)');
    const json = firstJson(r.stdout);
    return json ? { ...base('dotnet list package --vulnerable'), ...parseDotnetVulnerable(json) } : failed('dotnet list package --vulnerable', r);
  }

  if (eco === 'go') {
    const r = await run('govulncheck', ['-json', './...'], root, AUDIT_TIMEOUT_MS, signal);
    if (r.missing) {
      // Still say what there is: the module count is free and offline.
      const mods = await run('go', ['list', '-m', 'all'], root, 60_000, signal);
      const count = mods.code === 0 ? mods.stdout.trim().split('\n').filter(Boolean).length - 1 : undefined;
      return missing('govulncheck', `${count !== undefined ? `${count} dependency modules found (go list -m all); ` : ''}\`go install golang.org/x/vuln/cmd/govulncheck@latest\``);
    }
    if (r.code !== 0 && !r.stdout.includes('{')) return failed('govulncheck', r);
    return { ...base('govulncheck'), ...parseGovulncheck(r.stdout) };
  }

  return { ...base(eco), status: 'skipped', message: `unknown ecosystem "${eco}"; known: npm, python, cargo, dotnet, go.` };
}

const MAX_ADVISORIES = 10;
const MAX_LICENSES = 15;
const rank = (s: Severity) => SEVERITIES.indexOf(s);

/** The report the model and the reader see. Pure, for the tests. */
export function formatAudit(audits: EcosystemAudit[], licences: { scanned: Record<string, number>; findings: LicenseFinding[]; allowSource: string } | undefined): string {
  const out: string[] = [];
  const total = audits.reduce((n, a) => n + a.advisories.length, 0);
  out.push(`Dependency audit — ${audits.filter(a => a.status === 'ok').length} of ${audits.length} ecosystem(s) audited, ${total} advisor${total === 1 ? 'y' : 'ies'}. Nothing is blocked; this is a review list.`);
  for (const a of audits) {
    out.push('');
    if (a.status !== 'ok') { out.push(`${a.ecosystem} (${a.tool}): ${a.status} — ${a.message ?? ''}`.trimEnd()); continue; }
    const counts = SEVERITIES.filter(s => a.counts[s]).map(s => `${s} ${a.counts[s]}`).join(', ');
    if (a.advisories.length === 0) { out.push(`${a.ecosystem} (${a.tool}): no known vulnerabilities.`); continue; }
    out.push(`${a.ecosystem} (${a.tool}): ${counts || `${a.advisories.length} advisories`}`);
    const top = [...a.advisories].sort((x, y) => rank(x.severity) - rank(y.severity)).slice(0, MAX_ADVISORIES);
    for (const v of top) {
      out.push(`  ${v.severity.padEnd(8)} ${`${v.pkg}${v.version ? `@${v.version}` : ''}`.padEnd(24)} ${v.id.padEnd(20)} ${v.title.slice(0, 70)}${v.fix ? `  fix: ${v.fix}` : ''}`);
    }
    if (a.advisories.length > top.length) out.push(`  … ${a.advisories.length - top.length} more; run ${a.tool} for all of them.`);
  }
  if (licences) {
    const scanned = Object.entries(licences.scanned).filter(([, n]) => n > 0);
    out.push('');
    if (scanned.length === 0) {
      out.push('Licences: no installed packages found (node_modules, or a .venv/venv in the project). Install dependencies first to scan them.');
    } else {
      const n = scanned.reduce((s, [, c]) => s + c, 0);
      out.push(`Licences: ${n} installed packages (${scanned.map(([k, c]) => `${k} ${c}`).join(', ')}); ${licences.findings.length} for review.`);
      const order = { copyleft: 0, unknown: 1, 'not on allowlist': 2 } as const;
      const list = [...licences.findings].sort((x, y) => order[x.reason] - order[y.reason]).slice(0, MAX_LICENSES);
      for (const f of list) out.push(`  ${f.license.slice(0, 28).padEnd(28)} ${`${f.pkg}@${f.version}`.padEnd(32)} ${f.reason}`);
      if (licences.findings.length > list.length) out.push(`  … ${licences.findings.length - list.length} more.`);
      out.push(`  Allowlist: ${licences.allowSource}.`);
    }
  }
  return out.join('\n');
}

export async function dependencyAudit(input: DependencyAuditInput = {}, deps: { allowLicenses?: string[]; root?: string; signal?: AbortSignal } = {}): Promise<string> {
  const root = deps.root ?? projectRoot();
  const detected = detectEcosystems(root);
  const wanted = input.ecosystems?.length ? input.ecosystems.map(e => e.toLowerCase()) : detected;
  if (wanted.length === 0 && input.licenses === false) {
    return 'No package manifest here (package.json, pyproject.toml/requirements.txt, Cargo.toml, a .NET project or go.mod), so there is nothing to audit.';
  }
  const audits: EcosystemAudit[] = [];
  // One at a time: two package managers resolving at once fight over caches and the network.
  for (const eco of wanted) audits.push(await auditOne(eco, root, deps.signal));

  let licences: Parameters<typeof formatAudit>[1];
  if (input.licenses !== false) {
    const allow = input.allow?.length ? input.allow : deps.allowLicenses?.length ? deps.allowLicenses : DEFAULT_ALLOWED_LICENSES;
    const allowSource = input.allow?.length ? 'as given for this run'
      : deps.allowLicenses?.length ? 'from settings dependencyAudit.allowLicenses'
      : 'default (permissive licences); set dependencyAudit.allowLicenses in settings, or pass allow, to change it';
    const node = scanNodeLicenses(root);
    const site = findSitePackages(root);
    const py = site ? scanPythonLicenses(site) : [];
    const findings: LicenseFinding[] = [];
    for (const [source, list] of [['node_modules', node], ['python', py]] as const) {
      for (const p of list) {
        const reason = classifyLicense(p.license, allow);
        if (reason) findings.push({ ...p, reason, source });
      }
    }
    licences = { scanned: { node_modules: node.length, python: py.length }, findings, allowSource };
  }
  return formatAudit(audits, licences);
}

export const dependencyAuditDefinition = {
  name: 'DependencyAudit',
  description:
    'Audit dependencies for known vulnerabilities with the ecosystem\'s own tool (npm/pnpm audit, pip-audit, cargo audit, '
    + 'dotnet list package --vulnerable, govulncheck) and scan installed packages\' licences. Returns severity counts, '
    + 'top advisories with their fix version, and licences outside the allowlist (copyleft/unknown by default) for review. '
    + 'Never blocks; a missing auditor is reported, not installed. Uses the network for the vulnerability databases.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      ecosystems: { type: 'array', items: { type: 'string', enum: ['npm', 'python', 'cargo', 'dotnet', 'go'] }, description: 'Default: all the project uses.' },
      allow: { type: 'array', items: { type: 'string' }, description: 'SPDX licences acceptable for this run (replaces the configured allowlist).' },
      licenses: { type: 'boolean', description: 'false skips the licence scan.' },
    },
  },
};
