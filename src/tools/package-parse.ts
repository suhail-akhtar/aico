/**
 * Which packages does this shell command ask a package manager to install?
 *
 * The first half of the supply-chain check (ADR 0033): a pure reader of a
 * command line. It exists because the check has to run BEFORE the install
 * script does, and the only thing known at that point is the text the model
 * wrote. The model invents plausible package names; an attacker who registers
 * one gets code execution on `npm install`. The other half
 * (`package-registry.ts`) asks the registry whether the name is real.
 *
 * What it reads: quotes, `&&` / `||` / `;` / `|` / `&` / newlines, wrapper
 * shells (`bash -c`, `cmd /c`, `powershell -Command`), `sudo` / `env` / `call`,
 * env-var prefixes, `npm.cmd` / `C:\...\npm.exe`, `python -m pip`, `py -3 -m
 * pip` — for npm, pnpm, yarn, bun (add / install / dlx / create / x), npx,
 * pip, uv, poetry, pipx, cargo, go, dotnet / nuget, composer and gem / bundle.
 *
 * What it deliberately does not do:
 *  - **Lockfile installs** (`npm ci`, `pip install -r`, `bundle install`) name
 *    nothing: the model did not choose those packages this turn.
 *  - **Maven / Gradle**: dependencies are a file edit, not a command.
 *  - **Resolve variables, scripts or `eval`**: a name hidden behind `$PKG` is
 *    not seen, and the ADR says so.
 *  - **Guess when unsure.** A flag it does not know is treated as boolean; a
 *    token that cannot be a package name for that ecosystem is ignored rather
 *    than looked up (a false "not on npm" is worse than a missed check). The
 *    flags that take a separate value are listed per manager for that reason.
 *
 * Local paths are ignored; git / tarball / URL sources are returned as
 * `direct` — no registry vouches for them, so the guard treats them as
 * needing a person.
 *
 * @module tools/package-parse
 */

export type Ecosystem = 'npm' | 'pypi' | 'crates' | 'go' | 'nuget' | 'packagist' | 'rubygems';

/** A package an install command names. */
export interface PackageRef {
  ecosystem: Ecosystem;
  /** The name to look up (PyPI names normalised, npm alias targets resolved). */
  name: string;
  /** The version or range as written, informational. */
  spec?: string;
  /** `npm`, `pip`, `cargo`… as typed (basename, no extension). */
  manager: string;
  /** A registry named on the command line (`--registry`, `--index-url`…), for the private-registry rule. */
  registry?: string;
  /** `npx foo`: the name may be a binary already in `node_modules/.bin`, which the guard checks. */
  viaExec?: boolean;
}

/** A source no registry vouches for: a git repository or a URL. */
export interface DirectRef {
  ecosystem: Ecosystem;
  manager: string;
  /** What was written, clipped. */
  source: string;
  reason: 'git' | 'url';
}

export interface ParsedInstalls {
  packages: PackageRef[];
  direct: DirectRef[];
}

// ── Tokenising ───────────────────────────────────────────────────────

/** Split a command line into simple commands at `&&`, `||`, `;`, `|`, `&` and newlines — outside quotes. */
export function splitCommands(input: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: '"' | "'" | '' = '';
  const push = (): void => { if (cur.trim()) out.push(cur.trim()); cur = ''; };
  for (let i = 0; i < input.length; i++) {
    const c = input[i]!;
    if (quote) {
      cur += c;
      if (c === '\\' && quote === '"' && (input[i + 1] === '"' || input[i + 1] === '\\')) { cur += input[++i]!; continue; }
      if (c === quote) quote = '';
      continue;
    }
    if (c === '"' || c === "'") { quote = c; cur += c; continue; }
    if (c === '\\' && (input[i + 1] === '"' || input[i + 1] === "'" || input[i + 1] === ' ')) { cur += c + input[++i]!; continue; }
    if (c === '\n' || c === '\r' || c === ';') { push(); continue; }
    if (c === '|') { push(); if (input[i + 1] === '|') i++; continue; }
    if (c === '&') {
      // `2>&1`, `>&2` and `&>file` are redirections, not separators.
      const prev = input[i - 1]; const next = input[i + 1];
      if (prev === '>' || prev === '<' || next === '>') { cur += c; continue; }
      push(); if (next === '&') i++; continue;
    }
    cur += c;
  }
  push();
  return out;
}

/** Split one simple command into words, removing quotes; redirections are dropped. */
export function tokenize(segment: string): string[] {
  const tokens: string[] = [];
  let cur = '';
  let started = false;
  let quote: '"' | "'" | '' = '';
  const push = (): void => { if (started) tokens.push(cur); cur = ''; started = false; };
  for (let i = 0; i < segment.length; i++) {
    const c = segment[i]!;
    if (quote) {
      if (c === '\\' && quote === '"' && (segment[i + 1] === '"' || segment[i + 1] === '\\')) { cur += segment[++i]!; continue; }
      if (c === quote) { quote = ''; continue; }
      cur += c; continue;
    }
    if (c === '"' || c === "'") { quote = c; started = true; continue; }
    if (c === '\\' && (segment[i + 1] === '"' || segment[i + 1] === "'" || segment[i + 1] === ' ')) { cur += segment[++i]!; started = true; continue; }
    if (/\s/.test(c)) { push(); continue; }
    cur += c; started = true;
  }
  push();
  // Redirections: `> file`, `>>file`, `2>&1`, `< in`.
  const words: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (/^\d*[<>]/.test(t) && !/^\d+$/.test(t)) {
      if (/^\d*(?:>>?|<)$/.test(t)) i++; // the target is the next word
      continue;
    }
    words.push(t);
  }
  return words;
}

const base = (t: string): string => t.replace(/^.*[\\/]/, '').replace(/\.(?:exe|cmd|bat|ps1)$/i, '').toLowerCase();
const isFlag = (t: string): boolean => t.startsWith('-') && t.length > 1;
const trunc = (s: string, n = 120): string => (s.length > n ? `${s.slice(0, n)}…` : s);

const POSIX_SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'fish']);
const SKIP_WORDS = new Set(['sudo', 'doas', 'env', 'time', 'nohup', 'command', 'exec', 'call', 'nice']);

/** Strip env-var prefixes and wrapper words; returns the remaining words and any nested command strings. */
function unwrap(words: string[]): { words: string[]; nested: string[] } {
  let w = [...words];
  const nested: string[] = [];
  for (let guard = 0; guard < 8 && w.length; guard++) {
    // VAR=value prefixes (and PowerShell's `$env:X='1'` is a separate statement split on `;`).
    while (w.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(w[0]!)) w.shift();
    if (!w.length) break;
    const head = base(w[0]!);
    if (SKIP_WORDS.has(head)) {
      w.shift();
      // `sudo -u user`, `env -i`, `nice -n 5`: flags, and the values of the few that take one.
      while (w.length && (isFlag(w[0]!) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(w[0]!))) {
        const f = w.shift()!;
        if ((head === 'sudo' || head === 'doas') && /^-(?:u|g|h|p|C|D|R|T|U)$/.test(f) && w.length) w.shift();
        if (head === 'nice' && f === '-n' && w.length) w.shift();
      }
      continue;
    }
    if (POSIX_SHELLS.has(head)) {
      const i = w.findIndex((t, idx) => idx > 0 && /^-[a-z]*c$/.test(t));
      if (i > 0 && w[i + 1] !== undefined) { nested.push(w[i + 1]!); return { words: [], nested }; }
      break;
    }
    if (head === 'cmd') {
      const i = w.findIndex((t, idx) => idx > 0 && /^\/[ck]$/i.test(t));
      if (i > 0) { nested.push(w.slice(i + 1).join(' ')); return { words: [], nested }; }
      break;
    }
    if (head === 'powershell' || head === 'pwsh') {
      const i = w.findIndex((t, idx) => idx > 0 && /^-c(?:o(?:m(?:m(?:a(?:n(?:d)?)?)?)?)?)?$/i.test(t));
      if (i > 0) { nested.push(w.slice(i + 1).join(' ')); return { words: [], nested }; }
      break;
    }
    if (head === 'wsl') {
      w.shift();
      while (w.length && isFlag(w[0]!)) { const f = w.shift()!; if (/^-(?:d|u|e|-distribution|-user|-exec)$/.test(f) && f !== '-e' && w.length) w.shift(); }
      if (w[0] === '--') w.shift();
      continue;
    }
    break;
  }
  return { words: w, nested };
}

// ── Per-manager helpers ──────────────────────────────────────────────

/** Walk args after the subcommand: collect positionals, skip flags (and values of the listed ones). */
function scan(args: string[], valueFlags: ReadonlySet<string>): { positional: string[]; flags: Map<string, string[]> } {
  const positional: string[] = [];
  const flags = new Map<string, string[]>();
  const add = (k: string, v: string): void => { flags.set(k, [...(flags.get(k) ?? []), v]); };
  for (let i = 0; i < args.length; i++) {
    const t = args[i]!;
    if (t === '--') { positional.push(...args.slice(i + 1)); break; }
    if (isFlag(t)) {
      const eq = t.indexOf('=');
      if (t.startsWith('--') && eq > 0) { add(t.slice(0, eq), t.slice(eq + 1)); continue; }
      const key = t.startsWith('--') ? t : t.toLowerCase() === t ? t : t.toLowerCase();
      if (valueFlags.has(t) || valueFlags.has(key)) { const v = args[i + 1]; if (v !== undefined) { add(t.startsWith('--') ? t : key, v); i++; } continue; }
      add(t, '');
      continue;
    }
    positional.push(t);
  }
  return { positional, flags };
}

const flagValue = (flags: Map<string, string[]>, ...names: string[]): string | undefined => {
  for (const n of names) { const v = flags.get(n); if (v?.length) return v[v.length - 1]; }
  return undefined;
};

const LOCAL_PATH = /^(?:\.{1,2}(?:[\\/]|$)|[\\/]|~|[A-Za-z]:[\\/])/;
const URL_LIKE = /^(?:https?|git|ssh|git\+\w+|hg\+\w+|svn\+\w+|bzr\+\w+|ftp):\/\//i;

function directKind(spec: string): 'git' | 'url' {
  return /^(?:git[+:]|ssh:|github:|gitlab:|bitbucket:|gist:|hg\+|svn\+|bzr\+)/i.test(spec) || /\.git(?:[#@]|$)/.test(spec) ? 'git' : 'url';
}

// npm ------------------------------------------------------------------

const NPM_VALUE_FLAGS = new Set([
  '--registry', '--prefix', '--tag', '--workspace', '-w', '--cwd', '-C', '--filter', '-F', '--cache', '--userconfig', '--globalconfig',
  '--omit', '--include', '--loglevel', '--otp', '--scope', '--save-prefix', '--install-strategy', '--lockfile-version', '--before',
  '--access', '--location', '--audit-level', '--depth', '--fetch-retries', '--dir', '--store-dir', '--reporter', '--network-concurrency',
  '--cpu', '--os', '--libc', '--package-import-method', '--modules-dir', '--virtual-store-dir', '--lockfile-dir', '--cache-dir',
  '--registries', '--package-json', '--tsconfig', '--silent-level', '--only', '--proxy', '--https-proxy', '--maxsockets', '--shell',
  '--modules-folder', '--cache-folder', '--network-timeout', '--mutex', '--backend', '--concurrent-scripts', '--config',
]);

const NPM_NAME = /^(?:@[a-z0-9~][\w.~-]*\/)?[a-z0-9~][\w.~-]*$/i;

function npmFromSpec(raw: string, manager: string, registry: string | undefined, viaExec: boolean, out: ParsedInstalls): void {
  const t = raw.trim();
  if (!t) return;
  if (LOCAL_PATH.test(t) || /^(?:file|link|workspace|portal|patch):/i.test(t)) return;
  if (URL_LIKE.test(t) || /^(?:github|gitlab|bitbucket|gist):/i.test(t)) { out.direct.push({ ecosystem: 'npm', manager, source: trunc(t), reason: directKind(t) }); return; }
  if (/\.(?:tgz|tar\.gz|tar)$/i.test(t)) return; // a local tarball
  if (/^[\w.-]+\/[\w.-]+(?:#.*)?$/.test(t) && !t.startsWith('@')) { out.direct.push({ ecosystem: 'npm', manager, source: trunc(`github:${t}`), reason: 'git' }); return; }
  const m = /^(@[^/@]+\/[^@/]+|[^@/]+)(?:@(.+))?$/.exec(t);
  if (!m) return;
  let name = m[1]!;
  let spec = m[2];
  if (spec?.startsWith('npm:')) {
    // `alias@npm:real@^1` installs `real`; yarn berry's `name@npm:^1` is `name`.
    const rest = spec.slice(4);
    const alias = /^(@[^/@]+\/[^@/]+|[^@/]+)(?:@(.*))?$/.exec(rest);
    if (alias && !/^(?:[\d^~*<>=]|latest\b)/.test(rest)) { name = alias[1]!; spec = alias[2]; } else spec = rest;
  } else if (spec && /^(?:https?|git\+|github:|file:|link:|workspace:|portal:|patch:)/.test(spec)) {
    if (/^(?:file|link|workspace|portal|patch):/.test(spec)) return;
    out.direct.push({ ecosystem: 'npm', manager, source: trunc(t), reason: directKind(spec) }); return;
  }
  if (!NPM_NAME.test(name) || name.length > 214) return;
  out.packages.push({ ecosystem: 'npm', name, ...(spec ? { spec } : {}), manager, ...(registry ? { registry } : {}), ...(viaExec ? { viaExec: true } : {}) });
}

/** `npm create vite@latest` runs the package `create-vite`; `@scope/foo` runs `@scope/create-foo`. */
function npmInitializer(raw: string): string | undefined {
  const m = /^(@[^/@]+\/[^@/]+|@[^/@]+|[^@/]+)(?:@(.+))?$/.exec(raw);
  if (!m) return undefined;
  const n = m[1]!; const v = m[2] ? `@${m[2]}` : '';
  if (n.startsWith('@')) {
    const [scope, rest] = n.split('/');
    return rest ? `${scope}/create-${rest}${v}` : `${scope}/create${v}`;
  }
  return `create-${n}${v}`;
}

function parseNpmLike(manager: string, args: string[], out: ParsedInstalls): void {
  // Global flags may precede the subcommand (`npm --prefix x install foo`).
  const lead = scan(args, NPM_VALUE_FLAGS);
  const sub = lead.positional[0]?.toLowerCase();
  if (!sub) return;
  const subIndex = args.findIndex(a => a === lead.positional[0]);
  const rest = args.slice(subIndex + 1);
  const { positional, flags } = scan(rest, NPM_VALUE_FLAGS);
  const registry = flagValue(flags, '--registry') ?? flagValue(lead.flags, '--registry');
  const installAliases = manager === 'npm'
    ? ['install', 'i', 'add', 'in', 'ins', 'inst', 'insta', 'instal', 'isnt', 'isnta', 'isntal', 'isntall']
    : manager === 'bun' ? ['add', 'a', 'install', 'i'] : ['add', 'install', 'i'];
  if (installAliases.includes(sub)) {
    if (manager === 'yarn' && sub === 'install') return;
    for (const p of positional) npmFromSpec(p, manager, registry, false, out);
    return;
  }
  if (sub === 'global' && manager === 'yarn' && positional[0] === 'add') { for (const p of positional.slice(1)) npmFromSpec(p, manager, registry, false, out); return; }
  if (sub === 'dlx' || (manager === 'bun' && sub === 'x')) {
    const pkgs = [...(flags.get('--package') ?? []), ...(flags.get('-p') ?? [])];
    if (pkgs.length) { for (const p of pkgs) npmFromSpec(p, manager, registry, false, out); return; }
    if (positional[0]) npmFromSpec(positional[0], manager, registry, manager === 'bun', out);
    return;
  }
  if (sub === 'exec' || sub === 'x') {
    if (manager === 'npm') { runViaNpx(rest, manager, out); }
    return;
  }
  if ((sub === 'create' || sub === 'init') && positional[0]) {
    const init = npmInitializer(positional[0]);
    if (init) npmFromSpec(init, manager, registry, false, out);
  }
}

/** `npx [flags] pkg[@v] args…` — the first word is the package unless `--package` names them. */
function runViaNpx(args: string[], manager: string, out: ParsedInstalls): void {
  const valueFlags = new Set([...NPM_VALUE_FLAGS, '--package', '-p', '--call', '-c', '--shell']);
  // Everything after the first positional belongs to the program.
  const head: string[] = [];
  let i = 0;
  for (; i < args.length; i++) {
    const t = args[i]!;
    if (t === '--') { i++; break; }
    if (isFlag(t)) {
      head.push(t);
      if (!t.includes('=') && valueFlags.has(t) && args[i + 1] !== undefined) head.push(args[++i]!);
      continue;
    }
    break;
  }
  const { flags } = scan(head, valueFlags);
  if (flags.has('--no') || flags.has('--no-install') || flags.has('--offline')) return; // local binaries only: nothing is fetched
  const registry = flagValue(flags, '--registry');
  const pkgs = [...(flags.get('--package') ?? []), ...(flags.get('-p') ?? [])];
  if (pkgs.length) { for (const p of pkgs) npmFromSpec(p, manager, registry, false, out); return; }
  if (flags.has('-c') || flags.has('--call')) return; // a command string, not a package
  if (args[i] !== undefined) npmFromSpec(args[i]!, manager, registry, true, out);
}

// pip family -----------------------------------------------------------

const PIP_VALUE_FLAGS = new Set([
  '-r', '--requirement', '-c', '--constraint', '-e', '--editable', '-t', '--target', '--prefix', '--root', '--src', '-i', '--index-url',
  '--extra-index-url', '-f', '--find-links', '--python', '--platform', '--abi', '--implementation', '--python-version', '--only-binary',
  '--no-binary', '--cache-dir', '--proxy', '--cert', '--client-cert', '--retries', '--timeout', '--trusted-host', '--progress-bar',
  '--upgrade-strategy', '--report', '-C', '--config-settings', '--global-option', '--install-option', '--use-feature', '--exists-action',
  '--log', '--root-user-action', '--index', '--default-index', '--index-strategy', '--keyring-provider', '--resolution', '--prerelease',
  '-p', '--project', '--directory', '--group', '--optional', '--extra', '--with', '--with-requirements', '-b', '--build-constraint',
  '--override', '--refresh-package', '--reinstall-package', '--upgrade-package', '-P', '--link-mode', '--compile-bytecode-timeout',
  '--config-file', '--fork-strategy', '--exclude-newer', '--no-build-package', '--no-binary-package', '--python-platform',
]);

/** PEP 503 normalisation, which is also how PyPI answers lookups. */
export const normalisePypi = (n: string): string => n.toLowerCase().replace(/[-_.]+/g, '-');

function pipFromSpec(raw: string, manager: string, registry: string | undefined, out: ParsedInstalls): void {
  let t = raw.trim();
  if (!t) return;
  if (URL_LIKE.test(t) || /^(?:git|hg|svn|bzr)\+/i.test(t)) { out.direct.push({ ecosystem: 'pypi', manager, source: trunc(t), reason: directKind(t) }); return; }
  // PEP 508 direct reference: `pkg @ https://…` (checked before the file-extension rule below).
  const dref = /^[A-Za-z0-9][A-Za-z0-9._-]*\s*(?:\[[^\]]*\])?\s*@\s*(\S+)/.exec(t);
  if (dref) { out.direct.push({ ecosystem: 'pypi', manager, source: trunc(t), reason: directKind(dref[1]!) }); return; }
  if (t.startsWith('.') || LOCAL_PATH.test(t) || /\.(?:whl|zip|tar\.gz|tgz|tar\.bz2|egg)$/i.test(t)) return;
  t = t.split(/\s*;\s*/)[0]!.trim(); // environment marker
  const m = /^([A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?)\s*(?:\[[^\]]*\])?\s*(.*)$/.exec(t);
  if (!m) return;
  const rest = m[2]!.trim();
  if (rest.startsWith('@')) { out.direct.push({ ecosystem: 'pypi', manager, source: trunc(t), reason: directKind(rest.slice(1).trim()) }); return; }
  if (rest && !/^(?:===|==|>=|<=|~=|!=|>|<|\^|~|\*|@|\()/.test(rest) && !/^\d/.test(rest)) return;
  out.packages.push({ ecosystem: 'pypi', name: normalisePypi(m[1]!), ...(rest ? { spec: rest } : {}), manager, ...(registry ? { registry } : {}) });
}

function pipPositionals(rest: string[], manager: string, out: ParsedInstalls, extraValueFlags: string[] = []): void {
  const { positional, flags } = scan(rest, new Set([...PIP_VALUE_FLAGS, ...extraValueFlags]));
  const registry = flagValue(flags, '--index-url', '-i', '--index', '--default-index');
  const extra = flags.get('--extra-index-url');
  // `-e git+https://…` is an editable install of a URL; a path is local.
  for (const e of [...(flags.get('-e') ?? []), ...(flags.get('--editable') ?? [])]) {
    if (URL_LIKE.test(e) || /^(?:git|hg|svn|bzr)\+/i.test(e)) out.direct.push({ ecosystem: 'pypi', manager, source: trunc(e), reason: directKind(e) });
  }
  // A find-links folder or page is where the package comes from: not PyPI, so not looked up there.
  const effectiveRegistry = registry ?? extra?.[0] ?? flagValue(flags, '--find-links', '-f');
  for (let i = 0; i < positional.length; i++) {
    const p = positional[i]!;
    // A comparator left unquoted splits into words: `requests >= 2` → skip the operator and the version.
    if (/^[<>=!~]/.test(p)) { if (/^[<>=!~]+$/.test(p)) i++; continue; }
    pipFromSpec(p, manager, effectiveRegistry, out);
  }
}

function parsePip(manager: string, args: string[], out: ParsedInstalls): void {
  const first = scan(args, PIP_VALUE_FLAGS).positional[0];
  if (first?.toLowerCase() !== 'install') return;
  pipPositionals(args.slice(args.indexOf(first) + 1), manager, out);
}

function parseUv(args: string[], out: ParsedInstalls): void {
  const sub = args.findIndex(a => !isFlag(a));
  if (sub < 0) return;
  const word = args[sub]!.toLowerCase();
  const rest = args.slice(sub + 1);
  if (word === 'pip') {
    const j = rest.findIndex(a => !isFlag(a));
    if (j >= 0 && rest[j]!.toLowerCase() === 'install') pipPositionals(rest.slice(j + 1), 'uv', out);
    return;
  }
  if (word === 'add') { pipPositionals(rest, 'uv', out); return; }
  if (word === 'tool') {
    const j = rest.findIndex(a => !isFlag(a));
    if (j < 0) return;
    const w2 = rest[j]!.toLowerCase();
    if (w2 === 'install') pipPositionals(rest.slice(j + 1), 'uv', out, ['--from']);
    else if (w2 === 'run') parseUvx(rest.slice(j + 1), out);
  }
}

/** `uvx [--from spec] pkg args…` */
function parseUvx(args: string[], out: ParsedInstalls): void {
  const valueFlags = new Set([...PIP_VALUE_FLAGS, '--from', '--with', '--with-editable']);
  const head: string[] = [];
  let i = 0;
  for (; i < args.length; i++) {
    const t = args[i]!;
    if (t === '--') { i++; break; }
    if (isFlag(t)) { head.push(t); if (!t.includes('=') && valueFlags.has(t) && args[i + 1] !== undefined) head.push(args[++i]!); continue; }
    break;
  }
  const { flags } = scan(head, valueFlags);
  const registry = flagValue(flags, '--index-url', '-i', '--index', '--default-index');
  const from = flagValue(flags, '--from');
  const target = from ?? args[i];
  if (target) {
    // `pkg@1.2` is uv's own version syntax.
    pipFromSpec(target.replace(/^([A-Za-z0-9._-]+)@(\d)/, '$1==$2'), 'uvx', registry, out);
  }
}

function parsePoetry(args: string[], out: ParsedInstalls): void {
  const sub = args.findIndex(a => !isFlag(a));
  if (sub < 0 || args[sub]!.toLowerCase() !== 'add') return;
  const { positional, flags } = scan(args.slice(sub + 1), new Set(['--group', '-G', '--source', '--extras', '-E', '--python', '--platform', '-C', '--directory', '--project', '-P']));
  const source = flagValue(flags, '--source');
  for (const p of positional) pipFromSpec(p.replace(/^([A-Za-z0-9._-]+)@([\d^~*<>=])/, '$1==$2'), 'poetry', source, out);
}

function parsePipx(args: string[], out: ParsedInstalls): void {
  const sub = args.findIndex(a => !isFlag(a));
  if (sub < 0) return;
  const word = args[sub]!.toLowerCase();
  if (word !== 'install' && word !== 'run') return;
  const valueFlags = new Set([...PIP_VALUE_FLAGS, '--spec', '--suffix', '--pip-args', '--preinstall']);
  const { positional, flags } = scan(args.slice(sub + 1), valueFlags);
  const registry = flagValue(flags, '--index-url', '-i');
  const spec = flagValue(flags, '--spec');
  if (spec) { pipFromSpec(spec, 'pipx', registry, out); return; }
  if (word === 'run') { if (positional[0]) pipFromSpec(positional[0], 'pipx', registry, out); return; }
  for (const p of positional) pipFromSpec(p, 'pipx', registry, out);
}

// cargo ----------------------------------------------------------------

const CARGO_VALUE_FLAGS = new Set([
  '--features', '-F', '--package', '-p', '--rename', '--registry', '--git', '--branch', '--tag', '--rev', '--path', '--version', '--vers',
  '--root', '--target', '--bin', '--example', '--manifest-path', '--profile', '-j', '--jobs', '--index', '--target-dir', '--config', '-Z', '--color',
]);

function parseCargo(args: string[], out: ParsedInstalls): void {
  const sub = args.find(a => !isFlag(a) && !a.startsWith('+'));
  if (!sub || !['add', 'install', 'binstall'].includes(sub.toLowerCase())) return;
  const idx = args.indexOf(sub);
  const { positional, flags } = scan(args.slice(idx + 1), CARGO_VALUE_FLAGS);
  const registry = flagValue(flags, '--registry', '--index');
  const git = flagValue(flags, '--git');
  if (git) { out.direct.push({ ecosystem: 'crates', manager: 'cargo', source: trunc(git), reason: 'git' }); return; }
  if (flags.has('--path')) return;
  const version = flagValue(flags, '--version', '--vers');
  for (const p of positional) {
    const m = /^([A-Za-z_][\w-]*)(?:@(.+))?$/.exec(p);
    if (!m) continue; // a path or URL
    const spec = m[2] ?? version;
    out.packages.push({ ecosystem: 'crates', name: m[1]!, ...(spec ? { spec } : {}), manager: 'cargo', ...(registry ? { registry } : {}) });
  }
}

// go -------------------------------------------------------------------

const GO_VALUE_FLAGS = new Set(['-tags', '-ldflags', '-gcflags', '-asmflags', '-o', '-C', '-mod', '-modfile', '-p', '-buildmode', '-compiler', '-installsuffix', '-overlay', '-pkgdir', '-toolexec', '-pgo', '-covermode', '-coverpkg']);

function parseGo(args: string[], out: ParsedInstalls): void {
  const sub = args.find(a => !isFlag(a));
  if (sub !== 'get' && sub !== 'install') return;
  const { positional } = scan(args.slice(args.indexOf(sub) + 1), GO_VALUE_FLAGS);
  for (const p of positional) {
    if (LOCAL_PATH.test(p) || p === '.' || p === '...') continue;
    const m = /^([^@]+)(?:@(.+))?$/.exec(p);
    if (!m) continue;
    const mod = m[1]!.replace(/\/\.\.\.$/, '');
    if (m[2] === 'none') continue; // removal
    if (!/^[A-Za-z0-9.-]+\.[A-Za-z]{2,}(?:\/|$)/.test(mod)) continue; // the standard library, or not a module path
    out.packages.push({ ecosystem: 'go', name: mod, ...(m[2] ? { spec: m[2] } : {}), manager: 'go' });
  }
}

// dotnet / nuget -------------------------------------------------------

const NUGET_VALUE_FLAGS = new Set(['-v', '--version', '-f', '--framework', '-s', '--source', '--package-directory', '--add-source', '--tool-path', '--tool-manifest', '--configfile', '--verbosity',
  '-version', '-source', '-outputdirectory', '-configfile', '-framework', '-dependencyversion', '-verbosity', '--arch', '--prerelease-x']);

function parseDotnet(args: string[], out: ParsedInstalls): void {
  const w = args.filter(a => !isFlag(a)).map(a => a.toLowerCase());
  const { positional, flags } = scan(args, NUGET_VALUE_FLAGS);
  const registry = flagValue(flags, '--source', '-s', '--add-source');
  if (w[0] === 'add') {
    const pi = positional.findIndex(p => p.toLowerCase() === 'package');
    if (pi < 0 || !positional[pi + 1]) return;
    const spec = flagValue(flags, '--version', '-v');
    out.packages.push({ ecosystem: 'nuget', name: positional[pi + 1]!, ...(spec ? { spec } : {}), manager: 'dotnet', ...(registry ? { registry } : {}) });
    return;
  }
  if (w[0] === 'tool' && w[1] === 'install') {
    const name = positional[2];
    if (!name || LOCAL_PATH.test(name)) return;
    const spec = flagValue(flags, '--version');
    out.packages.push({ ecosystem: 'nuget', name, ...(spec ? { spec } : {}), manager: 'dotnet', ...(registry ? { registry } : {}) });
  }
}

function parseNuget(args: string[], out: ParsedInstalls): void {
  const lower = args.map(a => (a.startsWith('-') ? a.toLowerCase() : a));
  const { positional, flags } = scan(lower, NUGET_VALUE_FLAGS);
  if (positional[0]?.toLowerCase() !== 'install' || !positional[1]) return;
  if (/\.(?:config|nupkg)$/i.test(positional[1]) || LOCAL_PATH.test(positional[1])) return;
  const registry = flagValue(flags, '-source', '--source');
  const spec = flagValue(flags, '-version');
  out.packages.push({ ecosystem: 'nuget', name: positional[1], ...(spec ? { spec } : {}), manager: 'nuget', ...(registry ? { registry } : {}) });
}

// composer -------------------------------------------------------------

const PACKAGIST_NAME = /^([a-z0-9](?:[_.-]?[a-z0-9]+)*)\/([a-z0-9](?:(?:[_.]|-{1,2})?[a-z0-9]+)*)$/i;

function parseComposer(args: string[], out: ParsedInstalls): void {
  const { positional } = scan(args, new Set(['-d', '--working-dir', '--prefer-install', '--stability', '-s', '--repository', '--type']));
  let i = 0;
  if (positional[i]?.toLowerCase() === 'global') i++;
  const sub = positional[i]?.toLowerCase();
  if (sub !== 'require' && sub !== 'create-project' && sub !== 'req') return;
  const names = sub === 'create-project' ? positional.slice(i + 1, i + 2) : positional.slice(i + 1);
  for (const raw of names) {
    const [n, ...ver] = raw.split(/[:=]/);
    const m = PACKAGIST_NAME.exec(n!);
    if (!m) continue; // a version constraint, `php`, `ext-json`…
    out.packages.push({ ecosystem: 'packagist', name: n!.toLowerCase(), ...(ver.length ? { spec: ver.join(':') } : {}), manager: 'composer' });
  }
}

// ruby -----------------------------------------------------------------

const GEM_VALUE_FLAGS = new Set(['-v', '--version', '-i', '--install-dir', '-n', '--bindir', '-P', '--trust-policy', '--source', '--platform', '--config-file', '-g', '--file',
  '--http-proxy', '--group', '--require', '-r', '--git', '--branch', '--ref', '--path', '--github', '-s']);

function parseGem(manager: string, args: string[], out: ParsedInstalls): void {
  const { positional, flags } = scan(args, GEM_VALUE_FLAGS);
  const sub = positional[0]?.toLowerCase();
  if (manager === 'gem' && sub !== 'install' && sub !== 'i') return;
  if (manager === 'bundle' && sub !== 'add') return;
  const registry = flagValue(flags, '--source');
  const git = flagValue(flags, '--git') ?? flagValue(flags, '--github');
  if (git) { out.direct.push({ ecosystem: 'rubygems', manager, source: trunc(git), reason: 'git' }); return; }
  if (flags.has('--path') || flags.has('-g') || flags.has('--file')) return;
  const spec = flagValue(flags, '--version', '-v');
  for (const raw of positional.slice(1)) {
    const [n, ver] = raw.split(/:/);
    if (!/^[A-Za-z0-9][\w.-]*$/.test(n!) || /\.gem$/.test(n!)) continue;
    out.packages.push({ ecosystem: 'rubygems', name: n!, ...((ver ?? spec) ? { spec: ver ?? spec } : {}), manager, ...(registry ? { registry } : {}) });
  }
}

// ── The reader ───────────────────────────────────────────────────────

function parseSimple(words: string[], out: ParsedInstalls, depth: number): void {
  const un = unwrap(words);
  for (const n of un.nested) if (depth < 3) parseInto(n, out, depth + 1);
  const w = un.words;
  if (!w.length) return;
  const head = base(w[0]!);
  const args = w.slice(1);
  if (/^(?:python\d*(?:\.\d+)*|py)$/.test(head)) {
    const m = args.indexOf('-m');
    if (m >= 0 && args[m + 1]) {
      const mod = args[m + 1]!.toLowerCase();
      const rest = args.slice(m + 2);
      if (mod === 'pip') parsePip('pip', rest, out);
      else if (mod === 'pipx') parsePipx(rest, out);
      else if (mod === 'uv') parseUv(rest, out);
      else if (mod === 'poetry') parsePoetry(rest, out);
    }
    return;
  }
  switch (head) {
    case 'npm': case 'pnpm': case 'yarn': case 'bun': parseNpmLike(head, args, out); break;
    case 'npx': case 'bunx': runViaNpx(args, head, out); break;
    case 'pip': case 'pip3': parsePip(head, args, out); break;
    case 'uv': parseUv(args, out); break;
    case 'uvx': parseUvx(args, out); break;
    case 'poetry': parsePoetry(args, out); break;
    case 'pipx': parsePipx(args, out); break;
    case 'cargo': parseCargo(args, out); break;
    case 'go': parseGo(args, out); break;
    case 'dotnet': parseDotnet(args, out); break;
    case 'nuget': parseNuget(args, out); break;
    case 'composer': parseComposer(args, out); break;
    case 'gem': parseGem('gem', args, out); break;
    case 'bundle': case 'bundler': parseGem('bundle', args, out); break;
    default: break;
  }
}

function parseInto(command: string, out: ParsedInstalls, depth: number): void {
  for (const seg of splitCommands(command)) parseSimple(tokenize(seg), out, depth);
}

/** Cheap pre-filter so ordinary commands (git, ls, node) cost nothing. */
const MAYBE_INSTALL = /\b(?:npm|pnpm|yarn|bun|bunx|npx|pip3?|pipx|uvx?|poetry|python[\d.]*|py|cargo|go|dotnet|nuget|composer|gem|bundler?)(?:\.cmd|\.exe|\.bat)?\b/i;

/** Every package an install command names, and every source no registry vouches for. */
export function parseInstalls(command: string): ParsedInstalls {
  const out: ParsedInstalls = { packages: [], direct: [] };
  if (!command || !MAYBE_INSTALL.test(command)) return out;
  parseInto(command, out, 0);
  // The same package named twice on one line is looked up once.
  const seen = new Set<string>();
  out.packages = out.packages.filter(p => { const k = `${p.ecosystem}:${p.name}`; if (seen.has(k)) return false; seen.add(k); return true; });
  return out;
}
