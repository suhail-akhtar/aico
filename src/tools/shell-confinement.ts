/**
 * Shell confinement, the pure half: what a shell command line would change
 * outside the project, read from the command text alone (ADR 0027).
 *
 * WHY IT EXISTS. AICO's file tools are confined — Write/Edit/Read resolve the
 * real path and refuse anything outside the project, the AICO workspace and
 * the skills folder (`tools/path`). The shell tools were not. In the Phase 0
 * benchmark an auto-approve turn downloaded a 76 MB Go toolchain into its
 * session folder and began writing shims into `C:\Users\<user>\bin` — a
 * folder on the person's PATH, outside the workspace — and nothing in the
 * pipeline noticed, because every shell guard judged *danger patterns*
 * (`rm -rf /`, `curl | sh`), not *where the command writes*.
 *
 * WHAT IT FINDS, per command line:
 *  - `write-outside`: a path the command writes, moves, deletes, links,
 *    chmods, extracts or clones into that is outside the allowed roots
 *    (redirections, cp/mv/rm/mkdir/touch/tee/ln/chmod/install, sed -i, tar -C,
 *    unzip -d, git clone, npm --prefix, pip --target, the PowerShell and cmd
 *    file cmdlets/builtins, `git config --global`…);
 *  - `download`: a fetch of an executable or archive (curl/wget/iwr/irm/
 *    Start-BitsTransfer/certutil/bitsadmin/WebClient), by extension or by a
 *    toolchain-installer URL;
 *  - `global-install`: a package install that lands outside the project
 *    (npm -g, pip outside a venv or --user, pipx, cargo/go install, winget,
 *    choco, scoop, brew, apt…). A project-local install is not one;
 *  - `run-downloaded`: running a program this run downloaded or unpacked, or
 *    a binary that lives in temp/scratch rather than the project, or putting
 *    one on PATH;
 *  - `persistence`: setx, the registry, scheduled tasks, services, systemd,
 *    launchd, crontab — state that outlives the session.
 *
 * HOW IT READS A LINE. A small tokenizer (quotes, redirections, `&&`/`||`/
 * `;`/`|`/newlines), heredoc and here-string bodies removed (they are data),
 * `$( … )` analysed as its own command, `bash -c` / `pwsh -Command` /
 * `cmd /c` recursed into. Paths expand `~`, `$HOME`, `$env:USERPROFILE`,
 * `%USERPROFILE%`, `$PWD`, temp variables and variables assigned earlier in
 * the same line, and resolve against the shell's cwd as `cd`/`pushd`/
 * `Set-Location` move it (`cd .. && cd .. && echo x > y` lands two levels up).
 * Pure apart from an optional `realpath` the caller passes; the platform is a
 * parameter, so Windows and POSIX forms are tested on either.
 *
 * WHAT IT DELIBERATELY DOES NOT DO: decide. It reports findings; the guard
 * (`tools/shell-confinement-guard`) routes them to a person. And it is a
 * reader of command lines, not a jail: a write made *inside* a program
 * (`node -e "fs.writeFileSync('/x')"`, a Makefile, a script) or through a
 * variable it cannot resolve is not seen. Unresolvable targets are skipped,
 * never guessed — guessing "outside" would flag ordinary work, guessing
 * "inside" would be a claim the reader cannot back.
 *
 * @module tools/shell-confinement
 */

import path from 'node:path';

// ── types ────────────────────────────────────────────────────────────

export type ConfinementKind = 'write-outside' | 'download' | 'global-install' | 'run-downloaded' | 'persistence';

export interface ConfinementFinding {
  kind: ConfinementKind;
  /** The resolved path, the URL, or the command, that the finding is about. */
  target: string;
  /** One short human phrase, e.g. `writes outside the project: C:\Users\me\bin\go.cmd`. */
  what: string;
}

/** What a run has downloaded and unpacked so far, so a later call that runs it is seen. */
export interface DownloadTracker {
  /** Resolved paths of executables and archives downloaded in this run. */
  files: Set<string>;
  /** Where a downloaded archive was unpacked, and the archive's leading name (`go`, `node`). */
  extracted: Array<{ dir: string; stem: string }>;
}

export function newDownloadTracker(): DownloadTracker {
  return { files: new Set(), extracted: [] };
}

export interface ConfinementContext {
  /** The shell's working directory when the command starts. */
  cwd: string;
  /** Where writes are allowed: project, AICO workspace, temp, the person's `shell.allowedWriteRoots`. */
  roots: string[];
  /** The project. A binary run from inside it is the project's own. */
  projectRoot?: string;
  /** Temp and scratch: a binary run from here, outside the project, is a download. */
  scratchRoots?: string[];
  /** The person's home directory, for `~` and `$HOME`. */
  home: string;
  /** Environment for variable expansion (case-insensitive lookup). */
  env?: Record<string, string | undefined>;
  /** Path rules to apply. Default: this process's platform. */
  platform?: 'win32' | 'posix';
  /** The person's `shell.allowDownloads`: downloads and global installs are not findings. */
  allowDownloads?: boolean;
  /** Carried across calls in one run; updated as downloads and extractions are seen. */
  tracker?: DownloadTracker;
  /** Where a path really is (symlinks resolved). Lexical only when omitted. */
  realpath?: (p: string) => string;
  /** The OS temp directory, for Git Bash's `/tmp` on Windows and `$TEMP`. */
  tmpdir?: string;
}

// ── tokenizer ────────────────────────────────────────────────────────

interface Word { text: string; quoted: boolean }
interface Redirect { target: Word; output: boolean }
interface Segment {
  words: Word[];
  redirects: Redirect[];
  /** The operator before this segment (`|` means stdin is the previous segment's output). */
  after: string;
}

const SEPARATORS = new Set(['&&', '||', ';', '|', '&', '\n', '(', ')']);

/** Heredoc and PowerShell here-string bodies are data, not commands. */
function stripBodies(src: string): string {
  let s = src.replace(/@'\r?\n[\s\S]*?\r?\n'@/g, "''").replace(/@"\r?\n[\s\S]*?\r?\n"@/g, "''");
  const lines = s.split(/\r?\n/);
  const out: string[] = [];
  let waiting: string[] = [];
  for (const line of lines) {
    if (waiting.length) {
      if (line.replace(/^\t+/, '').trim() === waiting[0]) waiting.shift();
      continue;
    }
    const re = /<<-?\s*(['"]?)([A-Za-z_][\w-]*)\1/g;
    let m: RegExpExecArray | null;
    let kept = line;
    while ((m = re.exec(line))) waiting.push(m[2]);
    if (waiting.length) kept = line.replace(/<<-?\s*(['"]?)([A-Za-z_][\w-]*)\1/g, ' ');
    out.push(kept);
  }
  s = out.join('\n');
  return s;
}

/** `$( … )` bodies, replaced by a placeholder and returned for their own analysis. */
function extractSubstitutions(src: string): { text: string; inner: string[] } {
  const inner: string[] = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    if (src[i] === '$' && src[i + 1] === '(' && src[i + 2] !== '(') {
      let depth = 1;
      let j = i + 2;
      let quote = '';
      for (; j < src.length && depth > 0; j++) {
        const c = src[j];
        if (quote) { if (c === quote) quote = ''; continue; }
        if (c === '"' || c === "'") quote = c;
        else if (c === '(') depth++;
        else if (c === ')') depth--;
      }
      const body = src.slice(i + 2, j - 1);
      if (/^\s*pwd\s*$/i.test(body)) text += '$PWD';
      else { inner.push(body); text += '$__SUBST__'; }
      i = j;
      continue;
    }
    text += src[i];
    i++;
  }
  return { text, inner };
}

function tokenize(src: string): Array<Word | { op: string }> {
  const out: Array<Word | { op: string }> = [];
  let buf = '';
  let quoted = false;
  let has = false;
  const flush = (): void => {
    if (has) out.push({ text: buf, quoted });
    buf = ''; quoted = false; has = false;
  };
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === "'" || c === '"') {
      const end = src.indexOf(c, i + 1);
      const stop = end < 0 ? src.length : end;
      buf += src.slice(i + 1, stop);
      quoted = true; has = true;
      i = stop;
      continue;
    }
    if (c === ' ' || c === '\t' || c === '\r') { flush(); continue; }
    if (c === '\n') { flush(); out.push({ op: '\n' }); continue; }
    if (c === '#' && !has) {
      // A comment runs to the end of the line (bash, PowerShell).
      const nl = src.indexOf('\n', i);
      i = nl < 0 ? src.length : nl - 1;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (c === '>' || (c === '<')) {
      // An fd number or `&`/`*` glued in front (`2>`, `&>`, `*>`) is part of the operator.
      if (has && /^(?:\d+|&|\*)$/.test(buf) && !quoted) { buf = ''; has = false; } else flush();
      let j = i + 1;
      if (c === '>' && (src[j] === '>' || src[j] === '|')) j++;
      if (c === '<') {
        while (src[j] === '<') j++;
        if (src[j] === '(') { out.push({ op: 'in' }); i = j - 1; continue; }
        out.push({ op: 'in' });
        i = j - 1;
        continue;
      }
      // `>&1`, `>&2`, `>&-`: a descriptor, not a file.
      if (src[j] === '&') {
        let k = j + 1;
        while (k < src.length && /[\d-]/.test(src[k])) k++;
        i = k - 1;
        continue;
      }
      out.push({ op: 'out' });
      i = j - 1;
      continue;
    }
    if (two === '&&' || two === '||') { flush(); out.push({ op: two }); i++; continue; }
    if (c === '&' && src[i + 1] === '>') { flush(); continue; }
    if (c === ';' || c === '|' || c === '&' || c === '(' || c === ')') { flush(); out.push({ op: c }); continue; }
    buf += c; has = true;
  }
  flush();
  return out;
}

function segmentsOf(src: string): Segment[] {
  const toks = tokenize(src);
  const segs: Segment[] = [];
  let cur: Segment = { words: [], redirects: [], after: '' };
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if ('op' in t) {
      if (t.op === 'out' || t.op === 'in') {
        const next = toks[i + 1];
        if (next && !('op' in next)) { cur.redirects.push({ target: next, output: t.op === 'out' }); i++; }
        continue;
      }
      if (SEPARATORS.has(t.op)) {
        if (cur.words.length || cur.redirects.length) segs.push(cur);
        cur = { words: [], redirects: [], after: t.op };
        continue;
      }
    } else cur.words.push(t);
  }
  if (cur.words.length || cur.redirects.length) segs.push(cur);
  return segs;
}

// ── paths ────────────────────────────────────────────────────────────

const SINK = '\0sink';
const SINK_RE = /^(?:\/dev\/(?:null|stdout|stderr|tty|fd\/\d+)|nul:?|con:?|\$null|-)$/i;

interface State {
  ctx: ConfinementContext;
  win: boolean;
  p: path.PlatformPath;
  cwd: string | undefined;
  stack: Array<string | undefined>;
  vars: Map<string, string>;
  venv: boolean;
  /** The URL whose body the previous segment piped into this one. */
  piped?: { url: string; exec: boolean } | undefined;
  out: ConfinementFinding[];
  depth: number;
}

function lookup(st: State, name: string): string | undefined {
  const lower = name.toLowerCase();
  for (const [k, v] of st.vars) if (k.toLowerCase() === lower) return v;
  const env = st.ctx.env ?? {};
  const fromEnv = env[name] ?? Object.entries(env).find(([k]) => k.toLowerCase() === lower)?.[1];
  const tmp = st.ctx.tmpdir;
  switch (lower) {
    case 'home': case 'userprofile': return st.ctx.home;
    case 'pwd': case 'cd': return st.cwd;
    case 'null': return SINK;
    case 'temp': case 'tmp': case 'tmpdir': return fromEnv ?? tmp;
    case 'profile': return fromEnv ?? st.p.join(st.ctx.home, 'Documents', 'PowerShell', 'Microsoft.PowerShell_profile.ps1');
    case '__subst__': return undefined;
    default: return fromEnv;
  }
}

/** A word with `~` and variables expanded; undefined when something could not be resolved. */
function expand(st: State, word: string): string | undefined {
  let s = word;
  if (s === '~' || /^~[\\/]/.test(s)) s = st.ctx.home + s.slice(1);
  let failed = false;
  s = s.replace(/\$\{(?:env:)?([A-Za-z_]\w*)\}|\$env:([A-Za-z_]\w*)|\$([A-Za-z_]\w*)|%([A-Za-z_][\w()]*)%/gi, (_m, a, b, c, d) => {
    const v = lookup(st, a ?? b ?? c ?? d);
    if (v === undefined) { failed = true; return ''; }
    return v;
  });
  if (failed) return undefined;
  // Anything left that a shell would expand ($1, $?, $@, ${…}) is not ours to guess.
  if (/\$[\w{@?#*!$]/.test(s)) return undefined;
  return s;
}

/** Resolve a path word against the shell's cwd. SINK for /dev/null-likes; undefined when unknowable. */
function resolve(st: State, word: string): string | undefined {
  if (SINK_RE.test(word)) return SINK;
  const e = expand(st, word);
  if (e === undefined) return undefined;
  if (e === SINK || SINK_RE.test(e)) return SINK;
  let s = e;
  if (st.win) {
    // Git Bash spellings: /c/Users/x → C:\Users\x; /tmp → the OS temp directory.
    const msys = /^\/([a-zA-Z])(?:\/(.*))?$/.exec(s);
    if (msys) s = `${msys[1].toUpperCase()}:\\${(msys[2] ?? '').replace(/\//g, '\\')}`;
    else if (/^\/tmp(?:\/|$)/.test(s) && st.ctx.tmpdir) s = st.p.join(st.ctx.tmpdir, s.slice(4));
  }
  if (!st.p.isAbsolute(s)) {
    if (st.cwd === undefined) return undefined;
    return st.p.resolve(st.cwd, s);
  }
  return st.p.resolve(s);
}

function within(st: State, root: string, target: string): boolean {
  const norm = (x: string): string => (st.win ? st.p.resolve(x).toLowerCase() : st.p.resolve(x));
  const rel = st.p.relative(norm(root), norm(target));
  return rel === '' || (!rel.startsWith('..') && !st.p.isAbsolute(rel));
}

function allowed(st: State, target: string): boolean {
  if (target === SINK) return true;
  if (!st.ctx.roots.some(r => within(st, r, target))) return false;
  const real = st.ctx.realpath;
  if (!real) return true;
  // Inside as written; inside where it really is, too (a link in the project that leads out is outside).
  try {
    const t = real(target);
    return st.ctx.roots.some(r => within(st, real(r), t));
  } catch { return true; /* best effort: the lexical answer stands */ }
}

function add(st: State, f: ConfinementFinding): void {
  if (!st.out.some(o => o.kind === f.kind && o.target === f.target)) st.out.push(f);
}

/** Check a path the command writes; report it when it is outside. */
function writes(st: State, word: string | undefined): void {
  if (word === undefined || word === '') return;
  // PowerShell lists: `Remove-Item a,b`.
  const parts = st.win && word.includes(',') && !/^[a-z]+:\/\//i.test(word) ? word.split(',') : [word];
  for (const part of parts) {
    const w = part.trim();
    if (!w) continue;
    if (/^(?:HK(?:LM|CU|CR|U|CC)|Registry)::?/i.test(w)) {
      add(st, { kind: 'persistence', target: w, what: `changes the Windows registry (${w})` });
      continue;
    }
    if (/^[a-z][\w+.-]*:\/\//i.test(w) || /^(?:Env|Function|Alias|Variable|Cert|WSMan):/i.test(w)) continue;
    const r = resolve(st, w);
    if (r === undefined || r === SINK) continue;
    if (!allowed(st, r)) add(st, { kind: 'write-outside', target: r, what: `writes outside the project: ${r}` });
  }
}

// ── argument helpers ─────────────────────────────────────────────────

const isUrl = (s: string): boolean => /^(?:https?|ftp):\/\//i.test(s);

function isOption(st: State, w: string, cmdStyle = false): boolean {
  if (w.length > 1 && w.startsWith('-')) return true;
  // cmd builtins take `/s /q /y`; a POSIX absolute path also starts with `/`.
  return cmdStyle && st.win && /^\/[A-Za-z?][A-Za-z:]{0,3}$/.test(w);
}

/** Non-option arguments, skipping the values of options in `valued`. */
function positional(st: State, args: string[], valued: RegExp | undefined = undefined, cmdStyle = false): string[] {
  const out: string[] = [];
  let ended = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (ended) { out.push(a); continue; }
    if (a === '--') { ended = true; continue; }
    if (isOption(st, a, cmdStyle)) {
      if (valued && valued.test(a) && !a.includes('=')) i++;
      continue;
    }
    out.push(a);
  }
  return out;
}

/** The value of an option (`-o x`, `-ox`, `--output=x`, `-OutFile:x`), by any of `names` (lowercase, prefix for PowerShell). */
function optionValue(args: string[], names: string[], psPrefix = false): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const lower = a.toLowerCase();
    // Short POSIX flags are case-sensitive (curl -o vs -O); PowerShell parameters are not.
    const cmp = psPrefix ? lower : a;
    for (const n of names) {
      if (cmp === n) return args[i + 1];
      if (n.startsWith('--') && cmp.startsWith(`${n}=`)) return a.slice(n.length + 1);
      if (psPrefix && n.startsWith('-') && !n.startsWith('--')) {
        const [flag, inline] = lower.split(/:(.*)/s);
        if (flag.length >= 3 && n.startsWith(flag)) return inline !== undefined && inline !== '' ? a.slice(flag.length + 1) : args[i + 1];
      }
    }
  }
  return undefined;
}

const has = (args: string[], ...flags: string[]): boolean => args.some(a => flags.includes(a));

// ── PowerShell cmdlets ───────────────────────────────────────────────

/** PowerShell parameters that take a value; anything else starting with `-` is a switch. */
const PS_VALUED = /^-(?:path|literalpath|lp|pspath|filepath|destination|destinationpath|value|encoding|itemtype|type|name|target|include|exclude|filter|credential|inputobject|width|delimiter|newname|stream|compressionlevel|outfile|uri|source|method|body|headers|useragent|erroraction|ea|warningaction|wa|outvariable|ov|errorvariable|ev)(?::.*)?$/i;

function psParams(args: string[]): { named: Map<string, string>; pos: string[] } {
  const named = new Map<string, string>();
  const pos: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.length > 1 && a.startsWith('-') && !/^-\d/.test(a)) {
      const [flag, inline] = a.split(/:(.*)/s);
      const key = flag.slice(1).toLowerCase();
      if (inline !== undefined && inline !== '') { named.set(key, inline); continue; }
      if (PS_VALUED.test(flag)) { named.set(key, args[i + 1] ?? ''); i++; } else named.set(key, 'true');
      continue;
    }
    pos.push(a);
  }
  return { named, pos };
}

/** A named parameter by any accepted spelling or unambiguous prefix. */
function psGet(named: Map<string, string>, ...names: string[]): string | undefined {
  for (const [k, v] of named) {
    if (names.some(n => n === k || (k.length >= 3 && n.startsWith(k)))) return v;
  }
  return undefined;
}

// ── downloads ────────────────────────────────────────────────────────

const EXEC_EXT = /\.(?:zip|tar|tgz|tbz2?|txz|tzst|gz|xz|bz2|zst|7z|rar|msi|msix|msixbundle|appx|appxbundle|exe|dmg|pkg|deb|rpm|apk|sh|bash|ps1|psm1|bat|cmd|appimage|run|bin|jar|whl|vsix|com|scr)$/i;
const INSTALLER_URL = /(?:go\.dev|golang\.org|dl\.google\.com\/go)\/dl\b|nodejs\.org\/dist|python\.org\/ftp|(?:sh|win)\.rustup\.rs|static\.rust-lang\.org|get\.docker\.com|deno\.land\/(?:x\/)?install|bun\.sh\/install|ziglang\.org\/download|\/releases\/download\/|\/install(?:er)?(?:\.sh|\.ps1)?(?:[?#]|$)|get-pip\.py|astral\.sh\/uv|community\.chocolatey\.org\/install|get\.scoop\.sh|raw\.githubusercontent\.com\/Homebrew\/install|nvm-sh\/nvm|get\.sdkman\.io|pyenv\.run|dot\.net\/v1\/dotnet-install/i;

function urlPath(url: string): string {
  try { return new URL(url).pathname; } catch { return url; }
}

function downloaded(st: State, url: string, outWord: string | undefined, outPath: string | undefined): void {
  const target = outPath ?? (outWord !== undefined ? resolve(st, outWord) : undefined);
  const exec = EXEC_EXT.test(urlPath(url)) || INSTALLER_URL.test(url) || Boolean(target && target !== SINK && EXEC_EXT.test(target));
  if (exec && !st.ctx.allowDownloads) add(st, { kind: 'download', target: url, what: `downloads a program or archive: ${url}` });
  if (target && target !== SINK) {
    if (!allowed(st, target)) add(st, { kind: 'write-outside', target, what: `writes outside the project: ${target}` });
    if (exec) st.ctx.tracker?.files.add(target);
  }
}

function urlBase(st: State, url: string): string | undefined {
  const base = urlPath(url).split('/').filter(Boolean).pop();
  return base ? (st.cwd === undefined ? undefined : st.p.join(st.cwd, decodeURIComponent(base))) : undefined;
}

/** curl, wget, iwr/irm, Start-BitsTransfer, certutil, bitsadmin, aria2c. True when the segment was one. */
function downloadCommand(st: State, name: string, args: string[], seg: Segment, next: Segment | undefined): boolean {
  const urls = args.filter(isUrl);
  const redirect = seg.redirects.find(r => r.output)?.target.text;
  const pipedOn = next?.after === '|';
  const result = (url: string, outWord: string | undefined, outPath?: string): void => {
    if (outWord === undefined && outPath === undefined && redirect === undefined) {
      if (pipedOn) {
        const exec = EXEC_EXT.test(urlPath(url)) || INSTALLER_URL.test(url);
        st.piped = { url, exec };
        if (exec && !st.ctx.allowDownloads) add(st, { kind: 'download', target: url, what: `downloads a program or archive: ${url}` });
      }
      return;
    }
    downloaded(st, url, outWord ?? redirect, outPath);
  };
  const psStyle = args.some(a => /^-(?:outf|uri|outfile)/i.test(a));
  if ((name === 'curl' && !psStyle) || name === 'curl.exe') {
    const out = optionValue(args, ['-o', '--output']);
    let outWord = out;
    let remote = has(args, '-O', '--remote-name', '--remote-name-all') || args.some(a => a === '-O');
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (/^-[a-zA-Z]+$/.test(a) && a.length > 2) {
        const flags = a.slice(1);
        const o = flags.indexOf('o');
        if (o >= 0) outWord = o === flags.length - 1 ? args[i + 1] : flags.slice(o + 1);
        if (flags.includes('O')) remote = true;
      } else if (/^-o./.test(a)) outWord = a.slice(2);
    }
    const dir = optionValue(args, ['--output-dir']);
    for (const url of urls.length ? urls : [optionValue(args, ['--url']) ?? ''].filter(Boolean)) {
      if (outWord !== undefined) result(url, outWord);
      else if (remote) {
        const base = urlPath(url).split('/').filter(Boolean).pop() ?? 'index.html';
        const d = dir ? resolve(st, dir) : st.cwd;
        result(url, undefined, d && d !== SINK ? st.p.join(d, decodeURIComponent(base)) : undefined);
      } else result(url, undefined);
    }
    return true;
  }
  if (name === 'wget' || name === 'wget.exe' || name === 'wget2') {
    // -O is the document, -o the log (both files); -P the directory.
    const outDoc = optionValue(args, ['-O', '--output-document']) ?? args.find(a => /^-O./.test(a))?.slice(2);
    const log = optionValue(args, ['-o', '--output-file', '-a', '--append-output']);
    if (log !== undefined) writes(st, log);
    const prefix = optionValue(args, ['-P', '--directory-prefix']);
    for (const url of urls) {
      if (outDoc !== undefined) result(url, outDoc === '-' ? undefined : outDoc);
      else {
        const base = urlPath(url).split('/').filter(Boolean).pop() ?? 'index.html';
        const d = prefix ? resolve(st, prefix) : st.cwd;
        // wget writes a file even unasked.
        if (d && d !== SINK) downloaded(st, url, undefined, st.p.join(d, decodeURIComponent(base)));
      }
    }
    return true;
  }
  if (/^(?:invoke-webrequest|iwr|invoke-restmethod|irm|curl|wget)$/.test(name)) {
    const { named, pos } = psParams(args);
    const url = psGet(named, 'uri') ?? pos.find(isUrl);
    if (url) result(url, psGet(named, 'outfile'));
    return true;
  }
  if (name === 'start-bitstransfer') {
    const { named, pos } = psParams(args);
    const url = psGet(named, 'source') ?? pos[0];
    const dest = psGet(named, 'destination') ?? pos[1];
    if (url) result(url, dest, dest === undefined ? urlBase(st, url) : undefined);
    return true;
  }
  if (name === 'certutil' || name === 'certutil.exe') {
    if (!args.some(a => /^[-/]urlcache$/i.test(a))) return false;
    const pos = args.filter(a => !/^[-/]/.test(a));
    const i = pos.findIndex(isUrl);
    if (i >= 0) result(pos[i], pos[i + 1], pos[i + 1] === undefined ? urlBase(st, pos[i]) : undefined);
    return true;
  }
  if (name === 'bitsadmin' || name === 'bitsadmin.exe') {
    const i = args.findIndex(isUrl);
    if (i >= 0) result(args[i], args[i + 1]);
    return true;
  }
  if (name === 'aria2c') {
    const dir = optionValue(args, ['-d', '--dir']);
    const out = optionValue(args, ['-o', '--out']);
    for (const url of urls) {
      const base = out ?? urlPath(url).split('/').filter(Boolean).pop() ?? 'index.html';
      const d = dir ? resolve(st, dir) : st.cwd;
      if (d && d !== SINK) downloaded(st, url, undefined, st.p.resolve(d, base));
    }
    return true;
  }
  return false;
}

// ── extraction ───────────────────────────────────────────────────────

function stemOf(archive: string): string {
  const base = archive.split(/[\\/]/).pop() ?? '';
  return (/^[A-Za-z]+/.exec(base)?.[0] ?? '').toLowerCase();
}

/** Record an unpack of a downloaded archive, so running what came out of it is seen. */
function unpacked(st: State, archive: string | undefined, dest: string | undefined): void {
  if (dest === undefined || dest === SINK) return;
  const tracker = st.ctx.tracker;
  if (!tracker) return;
  const archivePath = archive ? resolve(st, archive) : undefined;
  const fromDownload = (archivePath && tracker.files.has(archivePath)) || (archive === undefined && st.piped?.exec);
  if (!fromDownload) return;
  const stem = archive ? stemOf(archive) : stemOf(urlPath(st.piped?.url ?? ''));
  if (!tracker.extracted.some(e => e.dir === dest && e.stem === stem)) tracker.extracted.push({ dir: dest, stem });
}

// ── installers ───────────────────────────────────────────────────────

const NPM_INSTALL = new Set(['install', 'i', 'in', 'ins', 'inst', 'insta', 'instal', 'isnt', 'isntal', 'isntall', 'add', 'update', 'up', 'upgrade', 'udpate', 'link', 'ln', 'uninstall', 'un', 'remove', 'rm', 'r', 'unlink']);
const GLOBAL_FLAG = (args: string[]): boolean => args.some(a => /^(?:-g|--global|--location=global|-global)$/i.test(a))
  || args.some((a, i) => a === '--location' && args[i + 1] === 'global');

function globalInstall(st: State, name: string, args: string[], cmdWord: string): string | undefined {
  const pos = positional(st, args, /^(?:--prefix|--registry|--cache|--location|--target|--root|--index-url|--extra-index-url|--tool-path|--install-dir|--filter|-C|--dir|-w|--workspace)$/);
  const sub = (pos[0] ?? '').toLowerCase();
  switch (name) {
    case 'npm': case 'pnpm': case 'cnpm': case 'bun': {
      if (sub === 'config' && /^set$/i.test(pos[1] ?? '') && !args.some(a => /^--location=project$/.test(a))) {
        writes(st, st.p.join(st.ctx.home, '.npmrc'));
        return undefined;
      }
      if (NPM_INSTALL.has(sub) && GLOBAL_FLAG(args)) return `${name} ${sub} -g`;
      if ((sub === 'link' || sub === 'ln') && pos.length === 1 && name === 'npm') return 'npm link (global symlink)';
      const prefix = optionValue(args, ['--prefix', '--dir', '-C', '--global-dir']);
      if (prefix !== undefined && NPM_INSTALL.has(sub)) writes(st, prefix);
      // A "local" install is local to wherever the shell is: `cd ~ && npm i x` fills ~/node_modules.
      else if ((NPM_INSTALL.has(sub) || sub === 'ci') && st.cwd !== undefined) writes(st, st.p.join(st.cwd, 'node_modules'));
      return undefined;
    }
    case 'yarn':
      if (sub === 'global') return 'yarn global';
      return undefined;
    case 'corepack':
      return sub === 'enable' || sub === 'install' ? `corepack ${sub}` : undefined;
    case 'cargo': {
      if (sub !== 'install') return undefined;
      const root = optionValue(args, ['--root']);
      if (root !== undefined) { writes(st, root); return undefined; }
      return 'cargo install';
    }
    case 'go': return sub === 'install' ? 'go install' : undefined;
    case 'gem': {
      if (sub !== 'install' && sub !== 'update') return undefined;
      const dir = optionValue(args, ['--install-dir', '-i']);
      if (dir !== undefined) { writes(st, dir); return undefined; }
      return `gem ${sub}`;
    }
    case 'dotnet': {
      if (sub !== 'tool' || !/^(?:install|update)$/.test(pos[1] ?? '')) return undefined;
      const toolPath = optionValue(args, ['--tool-path']);
      if (toolPath !== undefined) { writes(st, toolPath); return undefined; }
      return GLOBAL_FLAG(args) ? 'dotnet tool install -g' : undefined;
    }
    case 'rustup':
      return /^(?:install|toolchain|default|update|target|component|self)$/.test(sub) && !/^(?:list|show)$/.test(pos[1] ?? '') ? `rustup ${sub}` : undefined;
    case 'deno':
      return sub === 'install' && GLOBAL_FLAG(args) ? 'deno install -g' : undefined;
    case 'pipx':
      return /^(?:install|inject|upgrade|upgrade-all|reinstall|reinstall-all|ensurepath|install-all)$/.test(sub) ? `pipx ${sub}` : undefined;
    case 'brew':
      return /^(?:install|reinstall|upgrade|tap|link|cask)$/.test(sub) ? `brew ${sub}` : undefined;
    case 'apt': case 'apt-get': case 'aptitude':
      return /^(?:install|reinstall|upgrade|dist-upgrade|full-upgrade|remove|purge|autoremove)$/.test(sub) ? `${name} ${sub}` : undefined;
    case 'dnf': case 'yum': case 'zypper': case 'microdnf': case 'tdnf':
      return /^(?:install|in|reinstall|update|upgrade|up|remove|erase|rm)$/.test(sub) ? `${name} ${sub}` : undefined;
    case 'pacman': case 'yay': case 'paru':
      return args.some(a => /^-[SUR]/.test(a)) ? `${name} ${args.find(a => /^-[SUR]/.test(a))}` : undefined;
    case 'apk': return sub === 'add' || sub === 'del' ? `apk ${sub}` : undefined;
    case 'snap': case 'flatpak': return sub === 'install' || sub === 'remove' ? `${name} ${sub}` : undefined;
    case 'port': return sub === 'install' ? 'port install' : undefined;
    case 'nix-env': return args.some(a => /^(?:-i|--install|-iA)$/.test(a)) ? 'nix-env -i' : undefined;
    case 'nix': return sub === 'profile' && /^(?:install|add)$/.test(pos[1] ?? '') ? 'nix profile install' : undefined;
    case 'winget': return /^(?:install|add|upgrade|update|import|uninstall|remove)$/.test(sub) ? `winget ${sub}` : undefined;
    case 'choco': case 'chocolatey': case 'cinst': case 'cup':
      return name === 'cinst' || name === 'cup' || /^(?:install|upgrade|uninstall)$/.test(sub) ? `${name} ${sub}`.trim() : undefined;
    case 'scoop': return /^(?:install|update|uninstall|bucket|reset)$/.test(sub) ? `scoop ${sub}` : undefined;
    case 'msiexec': return args.some(a => /^[/-](?:i|package|a|x|uninstall|fa|update)$/i.test(a)) ? 'msiexec' : undefined;
    case 'install-module': case 'install-script': case 'install-package': case 'install-packageprovider': case 'update-module':
    case 'add-appxpackage': case 'add-windowscapability': case 'enable-windowsoptionalfeature': case 'install-psresource':
      return cmdWord;
    case 'conda': case 'mamba': case 'micromamba': {
      if (!/^(?:install|update|upgrade|create|remove)$/.test(sub)) return undefined;
      const prefix = optionValue(args, ['-p', '--prefix']);
      if (prefix !== undefined) { writes(st, prefix); return undefined; }
      return `${name} ${sub}`;
    }
    case 'nvm': case 'fnm': case 'volta': case 'pyenv': case 'asdf': case 'sdk': case 'rbenv': case 'goenv': case 'jenv':
      return /^(?:install|use|global|default|plugin)$/.test(sub) ? `${name} ${sub}` : undefined;
    case 'mise': case 'rtx':
      return sub === 'install' || (sub === 'use' && GLOBAL_FLAG(args)) ? `${name} ${sub}` : undefined;
    case 'uv': {
      if (sub === 'tool' && /^(?:install|upgrade)$/.test(pos[1] ?? '')) return 'uv tool install';
      if (sub === 'python' && pos[1] === 'install') return 'uv python install';
      if (sub === 'pip' && pos[1] === 'install' && has(args, '--system')) return 'uv pip install --system';
      return undefined;
    }
    default: return undefined;
  }
}

/** pip install outside a virtual environment, or with --user, lands in the person's Python. */
function pipInstall(st: State, cmdWord: string, args: string[]): string | undefined {
  const pos = positional(st, args, /^(?:-[tirce]|--target|--prefix|--root|--requirement|--constraint|--index-url|--extra-index-url|--editable|-e|--src)$/);
  const sub = (pos[0] ?? '').toLowerCase();
  if (sub !== 'install') return undefined;
  if (has(args, '--user')) return 'pip install --user';
  const target = optionValue(args, ['--target', '-t', '--prefix', '--root']);
  if (target !== undefined) { writes(st, target); return undefined; }
  if (st.venv || st.ctx.env?.VIRTUAL_ENV || st.ctx.env?.CONDA_PREFIX) return undefined;
  // `.venv/bin/pip`, `venv\Scripts\python.exe -m pip`: the project's own environment.
  if (/[\\/]/.test(cmdWord)) {
    const r = resolve(st, cmdWord);
    if (r && r !== SINK && allowed(st, r)) return undefined;
  }
  if (has(args, '--dry-run')) return undefined;
  return 'pip install outside a virtual environment';
}

// ── persistence ──────────────────────────────────────────────────────

function persistence(st: State, name: string, args: string[]): string | undefined {
  const sub = (positional(st, args, undefined, true)[0] ?? '').toLowerCase();
  const lowerArgs = args.map(a => a.toLowerCase());
  switch (name) {
    case 'setx': return 'sets a permanent environment variable (setx)';
    case 'reg': return /^(?:add|delete|import|copy|restore|load|unload)$/.test(sub) ? `changes the Windows registry (reg ${sub})` : undefined;
    case 'regedit': return lowerArgs.some(a => /^[/-]s$/.test(a)) ? 'imports into the Windows registry (regedit /s)' : undefined;
    case 'schtasks': return lowerArgs.some(a => /^[/-](?:create|change|delete|run)$/.test(a)) ? 'changes a scheduled task (schtasks)' : undefined;
    case 'register-scheduledtask': case 'set-scheduledtask': case 'unregister-scheduledtask': case 'new-scheduledtask':
      return 'changes a scheduled task';
    case 'sc': case 'sc.exe':
      return /^(?:create|config|delete|failure|description|sdset)$/.test(sub) ? `changes a Windows service (sc ${sub})` : undefined;
    case 'new-service': case 'set-service': case 'remove-service': return 'changes a Windows service';
    case 'systemctl':
      return /^(?:enable|disable|mask|unmask|link|preset|set-default|edit)$/.test(positional(st, args)[0] ?? '') ? 'changes a systemd unit' : undefined;
    case 'launchctl': return /^(?:load|bootstrap|enable|submit|unload|bootout|disable)$/.test(sub) ? 'changes a launchd job' : undefined;
    case 'crontab': return lowerArgs.length && !lowerArgs.includes('-l') ? 'replaces the crontab' : undefined;
    case 'update-alternatives': return lowerArgs.some(a => /^--(?:install|set|remove|config)$/.test(a)) ? 'changes system alternatives' : undefined;
    case 'chsh': return 'changes the login shell';
    case 'defaults': return sub === 'write' || sub === 'delete' ? 'changes macOS defaults' : undefined;
    case 'set-executionpolicy': return 'changes the PowerShell execution policy';
    case 'set-itemproperty': case 'new-itemproperty': case 'remove-itemproperty': case 'remove-item': case 'new-item': {
      const target = args.find(a => /^(?:HK(?:LM|CU|CR|U|CC)|Registry)::?/i.test(a));
      return target ? `changes the Windows registry (${target})` : undefined;
    }
    default: return undefined;
  }
}

// ── running what was downloaded ──────────────────────────────────────

const BINARYISH = (p: string): boolean => !/\.(?:sh|bash|zsh|ps1|psm1|py|js|mjs|cjs|ts|rb|pl|bat|cmd)$/i.test(p);
const PROJECT_TREES = /^(?:node_modules|\.venv|venv|env|\.git|target|build|dist|out|bin|obj)$/i;

/** Whether running `target` runs something this run downloaded, unpacked, or that lives in scratch. */
function runsDownloaded(st: State, target: string, direct: boolean): boolean {
  const t = st.ctx.tracker;
  const norm = (x: string): string => (st.win ? x.toLowerCase() : x);
  if (t && [...t.files].some(f => norm(f) === norm(target))) return true;
  if (t) {
    for (const e of t.extracted) {
      if (!within(st, e.dir, target)) continue;
      const first = st.p.relative(e.dir, target).split(/[\\/]/)[0] ?? '';
      if (PROJECT_TREES.test(first) && !first.toLowerCase().startsWith(e.stem || '\0')) continue;
      if (!e.stem || first.toLowerCase().startsWith(e.stem)) return true;
    }
  }
  if (!direct) return false;
  const inProject = st.ctx.projectRoot ? within(st, st.ctx.projectRoot, target) : false;
  return !inProject && BINARYISH(target) && (st.ctx.scratchRoots ?? []).some(r => within(st, r, target));
}

function checkRun(st: State, word: string | undefined, direct: boolean): void {
  if (!word || !/[\\/]/.test(word)) return;
  const r = resolve(st, word);
  if (!r || r === SINK) return;
  if (runsDownloaded(st, r, direct)) add(st, { kind: 'run-downloaded', target: r, what: `runs a downloaded program: ${r}` });
}

/** `PATH=…`, `export PATH=…`, `$env:PATH = …`: a downloaded program put first in line. */
function checkPathEdit(st: State, value: string): void {
  // `;` everywhere; `:` too, except a drive letter's (C:\x, C:/x).
  const parts = value.split(/;|(?<!(?:^|[;:])[A-Za-z]):/);
  for (const part of parts) {
    const w = part.trim();
    if (!w || /^(?:\$\{?(?:env:)?path\}?|%path%)$/i.test(w)) continue;
    const r = resolve(st, w);
    if (!r || r === SINK) continue;
    const inProject = st.ctx.projectRoot ? within(st, st.ctx.projectRoot, r) : false;
    if (runsDownloaded(st, st.p.join(r, '__probe__'), false)
      || (!inProject && (st.ctx.scratchRoots ?? []).some(s => within(st, s, r)))) {
      add(st, { kind: 'run-downloaded', target: r, what: `puts a downloaded program on PATH: ${r}` });
    }
  }
}

// ── the walk ─────────────────────────────────────────────────────────

const PREFIXES = new Set(['sudo', 'doas', 'command', 'builtin', 'exec', 'nohup', 'time', 'nice', 'ionice', 'stdbuf', 'call', 'noglob']);
const SHELL_WRAPPERS = /^(?:bash|sh|zsh|dash|ksh|fish|pwsh|powershell|cmd)$/;

function baseName(word: string): string {
  return (word.split(/[\\/]/).pop() ?? word).toLowerCase().replace(/\.(?:exe|cmd|bat|com)$/, '');
}

function cd(st: State, target: string | undefined): void {
  if (target === undefined) { st.cwd = st.win ? st.cwd : st.ctx.home; return; }
  if (target === '-') { st.cwd = undefined; return; }
  const r = resolve(st, target);
  st.cwd = r === SINK ? st.cwd : r;
}

function walkSegment(st: State, seg: Segment, next: Segment | undefined): void {
  const raw = seg.words.map(w => w.text);
  // Output redirections write wherever they point, whatever the command.
  for (const r of seg.redirects) if (r.output) writes(st, r.target.text);
  if (st.piped && seg.after !== '|') st.piped = undefined;

  let i = 0;
  // Leading assignments: `A=b cmd`, or a line that only assigns.
  while (i < raw.length && /^[A-Za-z_]\w*=/.test(raw[i])) {
    const eq = raw[i].indexOf('=');
    const name = raw[i].slice(0, eq);
    const value = raw[i].slice(eq + 1);
    if (name.toUpperCase() === 'PATH') checkPathEdit(st, value);
    const v = expand(st, value);
    if (v !== undefined) st.vars.set(name, v);
    i++;
  }
  // PowerShell assignments: `$x = …`, `$env:PATH += …`.
  if (/^\$[\w:]+$/.test(raw[i] ?? '') && /^[+]?=$/.test(raw[i + 1] ?? '')) {
    const name = raw[i].slice(1).replace(/^env:/i, '');
    const value = raw.slice(i + 2).join(' ');
    if (name.toUpperCase() === 'PATH') checkPathEdit(st, value);
    else {
      const v = expand(st, value);
      if (v !== undefined && raw[i + 1] === '=') st.vars.set(name, v);
    }
    return;
  }
  while (i < raw.length) {
    const b = baseName(raw[i]);
    if (PREFIXES.has(b)) {
      i++;
      while (i < raw.length && raw[i].startsWith('-')) i += /^-[ugCcn]$/.test(raw[i]) ? 2 : 1;
      continue;
    }
    if (b === 'env') {
      i++;
      while (i < raw.length && (raw[i].startsWith('-') || /^[A-Za-z_]\w*=/.test(raw[i]))) i++;
      continue;
    }
    break;
  }
  const words = raw.slice(i);
  if (!words.length) return;
  const cmdWord = words[0];
  const args = words.slice(1);
  const name = baseName(cmdWord);
  // Lowercase but keep `.exe` for the two names that differ (sc.exe vs PowerShell's sc alias).
  const exact = (cmdWord.split(/[\\/]/).pop() ?? cmdWord).toLowerCase();

  // Running a program by path: was it downloaded, unpacked, or does it live in scratch?
  checkRun(st, cmdWord, true);

  switch (name) {
    // ── working directory ──
    case 'cd': case 'chdir': case 'set-location': case 'sl': case 'pushd': case 'push-location': {
      const ps = psParams(args);
      const target = psGet(ps.named, 'path', 'literalpath') ?? positional(st, args, undefined, true)[0];
      if (name === 'pushd' || name === 'push-location') st.stack.push(st.cwd);
      cd(st, target);
      return;
    }
    case 'popd': case 'pop-location':
      st.cwd = st.stack.length ? st.stack.pop() : undefined;
      return;
    case 'export': case 'set': case 'declare': case 'typeset': {
      for (const a of args) {
        const m = /^([A-Za-z_]\w*)=(.*)$/s.exec(a);
        if (!m) continue;
        if (m[1].toUpperCase() === 'PATH') checkPathEdit(st, m[2]);
        const v = expand(st, m[2]);
        if (v !== undefined) st.vars.set(m[1], v);
      }
      return;
    }
    case 'source': case '.': {
      if (/activate(?:\.\w+)?$/i.test(args[0] ?? '')) st.venv = true;
      checkRun(st, args[0], false);
      return;
    }
  }
  if (/[\\/]activate(?:\.ps1|\.bat)?$/i.test(cmdWord)) { st.venv = true; return; }
  if ((name === 'conda' || name === 'mamba' || name === 'micromamba') && args[0] === 'activate') { st.venv = true; return; }

  // ── shells inside the shell: read the command they are given ──
  if (SHELL_WRAPPERS.test(name)) {
    const ci = args.findIndex(a => (name === 'cmd' ? /^\/[ckr]$/i : /^(?:-[a-zA-Z]*c|-co\w*)$/i).test(a));
    if (ci >= 0) {
      const body = name === 'cmd' ? args.slice(ci + 1).join(' ') : args[ci + 1];
      if (body) walk(st, body);
      return;
    }
    const fi = args.findIndex(a => /^-(?:f|file)$/i.test(a));
    const script = fi >= 0 ? args[fi + 1] : args.find(a => !a.startsWith('-') && !(name === 'cmd' && a.startsWith('/')));
    checkRun(st, script, false);
    return;
  }
  if (/^(?:python\d*(?:\.\d+)?|py|node|deno|bun|perl|ruby)$/.test(name)) {
    // bun and deno are package managers as well as runtimes.
    const pm = name === 'bun' || name === 'deno' ? globalInstall(st, name, args, cmdWord) : undefined;
    if (pm) {
      if (!st.ctx.allowDownloads) add(st, { kind: 'global-install', target: pm, what: `installs software outside the project (${pm})` });
      return;
    }
    const mi = args.indexOf('-m');
    if (mi >= 0 && /^pip\d*$/.test(args[mi + 1] ?? '')) {
      const what = pipInstall(st, cmdWord, args.slice(mi + 2));
      if (what && !st.ctx.allowDownloads) add(st, { kind: 'global-install', target: what, what: `installs software outside the project (${what})` });
      return;
    }
    if (mi >= 0 && args[mi + 1] === 'venv') {
      const dir = args.slice(mi + 2).find(a => !a.startsWith('-'));
      if (dir) writes(st, dir);
      return;
    }
    if (name === 'perl' && args.some(a => /^-\w*i/.test(a))) { inPlaceEdit(st, args); return; }
    checkRun(st, args.find(a => !a.startsWith('-')), false);
    return;
  }

  // ── downloads ──
  if (downloadCommand(st, name, args, seg, next)) return;

  // ── installers ──
  if (/^pip\d*(?:\.\d+)?$/.test(name)) {
    const what = pipInstall(st, cmdWord, args);
    if (what && !st.ctx.allowDownloads) add(st, { kind: 'global-install', target: what, what: `installs software outside the project (${what})` });
    return;
  }
  const installer = globalInstall(st, name, args, cmdWord);
  if (installer) {
    if (!st.ctx.allowDownloads) add(st, { kind: 'global-install', target: installer, what: `installs software outside the project (${installer})` });
    return;
  }
  if (name === 'msiexec' || name === 'start-process' || name === 'saps' || name === 'invoke-item' || name === 'ii' || name === 'start' || name === 'open') {
    const ps = psParams(args);
    checkRun(st, psGet(ps.named, 'filepath', 'path') ?? ps.pos.find(a => a !== '""' && a !== ''), true);
  }

  // ── persistence ──
  const lasting = persistence(st, exact === 'sc.exe' ? 'sc.exe' : name, args);
  if (lasting) { add(st, { kind: 'persistence', target: `${cmdWord} ${args.join(' ')}`.trim(), what: lasting }); return; }

  // ── file writers ──
  fileWriter(st, name, args, seg);
}

function inPlaceEdit(st: State, args: string[]): void {
  // sed -i / perl -pi: the files after the script. With -e/-f the script is an option value.
  const pos: string[] = [];
  let scriptGiven = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (/^(?:-e|-f|--expression|--file)$/.test(a)) { scriptGiven = true; i++; continue; }
    if (/^-\w*e$/.test(a) && a.length > 2) { scriptGiven = true; i++; continue; }
    if (a.startsWith('-')) continue;
    pos.push(a);
  }
  for (const f of scriptGiven ? pos : pos.slice(1)) writes(st, f);
}

function fileWriter(st: State, name: string, args: string[], seg: Segment): void {
  // Options that take a value, per command family (`cp -r` is a flag, `touch -r` is not).
  const CP_VALUED = /^(?:-t|--target-directory|-S|--suffix|-m|--mode|-o|--owner|-g|--group)$/;
  const VALUED: Record<string, RegExp> = {
    touch: /^(?:-d|--date|-t|-r|--reference)$/,
    mkdir: /^(?:-m|--mode)$/,
    truncate: /^(?:-s|--size|-r|--reference)$/,
    shred: /^(?:-n|--iterations|-s|--size)$/,
  };
  const POSIX_VALUED = VALUED[name] ?? CP_VALUED;
  switch (name) {
    case 'cp': case 'install': case 'scp': case 'rsync': case 'xcopy': case 'robocopy': case 'copy': case 'cpi': case 'copy-item': {
      if (name === 'copy-item' || name === 'cpi' || (st.win && (name === 'copy' || name === 'cp') && args.some(a => /^-dest/i.test(a)))) {
        const ps = psParams(args);
        writes(st, psGet(ps.named, 'destination') ?? ps.pos[1] ?? st.cwd);
        return;
      }
      if (name === 'install' && has(args, '-d', '--directory')) { for (const p of positional(st, args, POSIX_VALUED)) writes(st, p); return; }
      const target = optionValue(args, ['-t', '--target-directory']);
      if (target !== undefined) { writes(st, target); return; }
      const cmdStyle = name === 'copy' || name === 'xcopy' || name === 'robocopy';
      const pos = positional(st, args, POSIX_VALUED, cmdStyle);
      if (name === 'robocopy') { writes(st, pos[1]); return; }
      const dest = pos.length >= 2 ? pos[pos.length - 1] : (cmdStyle ? '.' : undefined);
      if (dest === undefined) return;
      // A remote rsync/scp destination (host:path) is not a local write.
      if ((name === 'rsync' || name === 'scp') && /^[^\\/]+:/.test(dest) && !/^[A-Za-z]:[\\/]/.test(dest)) return;
      writes(st, dest);
      return;
    }
    case 'mv': case 'move': case 'mi': case 'move-item': case 'ren': case 'rename': case 'rni': case 'rename-item': {
      if (/-item$/.test(name) || name === 'mi' || name === 'rni' || args.some(a => /^-(?:dest|path|literalpath|newname)/i.test(a))) {
        const ps = psParams(args);
        writes(st, psGet(ps.named, 'path', 'literalpath') ?? ps.pos[0]);
        const dest = psGet(ps.named, 'destination') ?? (name.startsWith('ren') || name === 'rni' ? undefined : ps.pos[1]);
        if (dest !== undefined) writes(st, dest);
        return;
      }
      const target = optionValue(args, ['-t', '--target-directory']);
      if (target !== undefined) writes(st, target);
      for (const p of positional(st, args, POSIX_VALUED, name === 'move' || name === 'ren' || name === 'rename')) writes(st, p);
      return;
    }
    case 'rm': case 'del': case 'erase': case 'rd': case 'rmdir': case 'unlink': case 'shred': case 'truncate': case 'touch':
    case 'mkdir': case 'md': case 'tee': case 'ri': case 'remove-item': case 'ni': case 'new-item': case 'set-content': case 'sc':
    case 'add-content': case 'ac': case 'out-file': case 'clear-content': case 'clc': case 'tee-object': case 'export-csv':
    case 'export-clixml': case 'new-symlink': case 'mkfifo': case 'mknod': {
      const psLike = /-/.test(name) || ['ri', 'ni', 'sc', 'ac', 'clc'].includes(name)
        || args.some(a => /^-(?:path|literalpath|filepath|itemtype|value|recurse|force|name)\b/i.test(a));
      if (psLike) {
        const ps = psParams(args);
        let p = psGet(ps.named, 'path', 'literalpath', 'filepath') ?? ps.pos[0];
        const childName = psGet(ps.named, 'name');
        if (childName !== undefined) p = p === undefined ? childName : `${p}${st.win ? '\\' : '/'}${childName}`;
        writes(st, p);
        if (/^(?:remove-item|ri|rm|del|erase|rd|rmdir)$/.test(name)) for (const extra of ps.pos.slice(1)) writes(st, extra);
        return;
      }
      for (const p of positional(st, args, POSIX_VALUED, ['del', 'erase', 'rd', 'rmdir', 'md', 'mkdir'].includes(name))) writes(st, p);
      return;
    }
    case 'chmod': case 'chown': case 'chgrp': case 'chattr': case 'setfacl': case 'icacls': case 'attrib': case 'takeown': {
      if (name === 'icacls' || name === 'attrib' || name === 'takeown') {
        for (const p of positional(st, args, /^\/f$/i, true).filter(a => !/^[+-][rahsi]$/i.test(a) && !/:\(/.test(a))) writes(st, p);
        const f = args.findIndex(a => /^\/f$/i.test(a));
        if (f >= 0) writes(st, args[f + 1]);
        return;
      }
      const ref = args.some(a => a.startsWith('--reference'));
      for (const p of positional(st, args, /^(?:-m|-x)$/).slice(ref ? 0 : 1)) writes(st, p);
      return;
    }
    case 'ln': case 'mklink': {
      if (name === 'mklink') { writes(st, positional(st, args, undefined, true)[0]); return; }
      const target = optionValue(args, ['-t', '--target-directory']);
      if (target !== undefined) { writes(st, target); return; }
      const pos = positional(st, args, /^(?:-S|--suffix)$/);
      if (pos.length >= 2) writes(st, pos[pos.length - 1]);
      else if (pos.length === 1 && st.cwd !== undefined) writes(st, st.p.join(st.cwd, st.p.basename(pos[0])));
      return;
    }
    case 'dd': {
      const of = args.find(a => a.startsWith('of='));
      if (of) writes(st, of.slice(3));
      return;
    }
    case 'sed': case 'gsed': {
      if (args.some(a => /^-[a-zA-Z]*i/.test(a) || a.startsWith('--in-place'))) inPlaceEdit(st, args);
      return;
    }
    case 'find': {
      if (!args.some(a => /^-(?:delete|exec|execdir|fprint\w*)$/.test(a))) return;
      for (const a of args) { if (a.startsWith('-') || a === '!' || a === '(') break; writes(st, a); }
      return;
    }
    case 'tar': case 'bsdtar': {
      let file: string | undefined;
      let dir: string | undefined;
      let extract = false;
      let create = false;
      for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (a.startsWith('--')) {
          if (a === '--extract' || a === '--get') extract = true;
          else if (a === '--create' || a === '--append' || a === '--update') create = true;
          else if (a === '--file') file = args[++i];
          else if (a === '--directory') dir = args[++i];
          else if (a.startsWith('--file=')) file = a.slice(7);
          else if (a.startsWith('--directory=')) dir = a.slice(12);
          continue;
        }
        // Option bundles (`-xzf`, old-style `xzf` first): f and C take the next arguments in order.
        if (!/^-[A-Za-z]+$/.test(a) && !(i === 0 && /^[A-Za-z]+$/.test(a))) continue;
        const flags = a.replace(/^-/, '');
        if (flags.includes('x')) extract = true;
        if (/[cruA]/.test(flags)) create = true;
        for (const ch of flags) {
          if (ch === 'f') file = args[++i];
          else if (ch === 'C') dir = args[++i];
        }
      }
      if (extract) {
        const dest = dir !== undefined ? resolve(st, dir) : st.cwd;
        if (dir !== undefined) writes(st, dir);
        unpacked(st, file === '-' ? undefined : file, dest);
      } else if (create && file && file !== '-') writes(st, file);
      return;
    }
    case 'unzip': {
      const dir = optionValue(args, ['-d']);
      const archive = positional(st, args, /^(?:-d|-x|-P)$/)[0];
      if (dir !== undefined) writes(st, dir);
      unpacked(st, archive, dir !== undefined ? resolve(st, dir) : st.cwd);
      return;
    }
    case '7z': case '7za': case '7zr': {
      const sub = (args[0] ?? '').toLowerCase();
      if (sub !== 'x' && sub !== 'e') {
        if (sub === 'a' && args[1]) writes(st, args[1]);
        return;
      }
      const o = args.find(a => /^-o/i.test(a));
      const archive = args.slice(1).find(a => !a.startsWith('-'));
      if (o) writes(st, o.slice(2));
      unpacked(st, archive, o ? resolve(st, o.slice(2)) : st.cwd);
      return;
    }
    case 'expand-archive': case 'compress-archive': {
      const ps = psParams(args);
      const dest = psGet(ps.named, 'destinationpath') ?? ps.pos[1];
      if (dest !== undefined) writes(st, dest);
      if (name === 'expand-archive') unpacked(st, psGet(ps.named, 'path', 'literalpath') ?? ps.pos[0], dest !== undefined ? resolve(st, dest) : st.cwd);
      return;
    }
    case 'gunzip': case 'bunzip2': case 'unxz': case 'unzstd': {
      for (const p of positional(st, args)) writes(st, p);
      return;
    }
    case 'git': {
      let j = 0;
      let base: string | undefined;
      while (j < args.length && args[j].startsWith('-')) {
        if (args[j] === '-C') { base = args[j + 1]; j += 2; continue; }
        j += args[j] === '-c' || args[j] === '--git-dir' || args[j] === '--work-tree' ? 2 : 1;
      }
      const sub = args[j];
      const rest = args.slice(j + 1);
      const saved = st.cwd;
      if (base !== undefined) cd(st, base);
      try {
        if (sub === 'clone') {
          const pos = positional(st, rest, /^(?:-b|--branch|-o|--origin|--depth|-c|--config|--reference|--separate-git-dir|-u|--upload-pack|--template|-j|--jobs|--filter)$/);
          const dest = pos[1] ?? (pos[0] ? (pos[0].replace(/[\\/]+$/, '').split(/[\\/:]/).pop() ?? '').replace(/\.git$/, '') : undefined);
          if (dest) writes(st, dest);
          return;
        }
        if (sub === 'init') { writes(st, positional(st, rest, /^(?:-b|--initial-branch|--template|--separate-git-dir)$/)[0] ?? '.'); return; }
        if (sub === 'worktree' && rest[0] === 'add') { writes(st, positional(st, rest.slice(1), /^(?:-b|-B|--reason)$/)[0]); return; }
        if (sub === 'config' && rest.some(a => a === '--global' || a === '--system')) {
          if (!rest.some(a => /^(?:--get|--get-all|--list|-l|--get-regexp)$/.test(a))) writes(st, st.p.join(st.ctx.home, '.gitconfig'));
          return;
        }
        if (base !== undefined && sub && !/^(?:status|log|diff|show|describe|blame|shortlog|rev-parse|ls-files|ls-tree|cat-file|grep|remote|branch|tag|config|help|version)$/.test(sub)) {
          writes(st, '.');
        }
      } finally { st.cwd = saved; }
      return;
    }
    default:
      // Every other command writes only through its redirections (handled above).
      void seg;
  }
}

/** Raw-text forms that the word walk cannot see: .NET calls inside PowerShell. */
function rawForms(st: State, src: string): void {
  for (const m of src.matchAll(/DownloadFile(?:Async|TaskAsync)?\(\s*['"]([^'"]+)['"]\s*,\s*['"]([^'"]+)['"]/gi)) {
    downloaded(st, m[1], m[2], undefined);
  }
  for (const m of src.matchAll(/\[(?:System\.)?IO\.File\]::(?:WriteAll\w+|AppendAll\w+|Create|Copy|Move|Delete|Open)\(\s*['"]([^'"]+)['"](?:\s*,\s*['"]([^'"]+)['"])?/gi)) {
    if (/::(?:Copy|Move)\(/i.test(m[0]) && m[2]) writes(st, m[2]);
    else writes(st, m[1]);
  }
  for (const m of src.matchAll(/\[(?:System\.)?Environment\]::SetEnvironmentVariable\(([^)]*)\)/gi)) {
    if (/['"]?(?:User|Machine)['"]?\s*$|EnvironmentVariableTarget\]::(?:User|Machine)/i.test(m[1])) {
      add(st, { kind: 'persistence', target: m[0], what: 'sets a permanent environment variable' });
    }
  }
}

function walk(st: State, src: string): void {
  if (st.depth > 4) return;
  st.depth++;
  try {
    const joined = src.replace(/\\\r?\n/g, ' ').replace(/`\r?\n/g, ' ').replace(/\^\r?\n/g, ' ');
    const bodies = stripBodies(joined);
    const { text, inner } = extractSubstitutions(bodies);
    for (const sub of inner) walk(st, sub);
    rawForms(st, text);
    const segs = segmentsOf(text);
    for (let i = 0; i < segs.length; i++) walkSegment(st, segs[i], segs[i + 1]);
  } finally { st.depth--; }
}

/**
 * Everything `command` would change outside the allowed roots, as findings.
 * Empty when the command stays inside (or when nothing it writes could be
 * resolved). Updates `ctx.tracker` with what it downloads and unpacks.
 */
export function assessShellCommand(command: string, ctx: ConfinementContext): ConfinementFinding[] {
  const win = (ctx.platform ?? (process.platform === 'win32' ? 'win32' : 'posix')) === 'win32';
  const st: State = {
    ctx, win, p: win ? path.win32 : path.posix,
    cwd: ctx.cwd, stack: [], vars: new Map(), venv: false, out: [], depth: 0,
  };
  try { walk(st, command); } catch { /* a reader bug must not break the tool; the findings so far stand */ }
  return st.out;
}

/** One line for a person or the model: the first few findings, most serious first. */
export function describeFindings(findings: ConfinementFinding[], max = 3): string {
  const order: ConfinementKind[] = ['persistence', 'run-downloaded', 'download', 'global-install', 'write-outside'];
  const sorted = [...findings].sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));
  const shown = sorted.slice(0, max).map(f => f.what);
  const more = sorted.length > max ? ` (+${sorted.length - max} more)` : '';
  return shown.join('; ') + more;
}
