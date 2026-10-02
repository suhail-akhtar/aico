/**
 * What a person should know about a skill before installing it.
 *
 * WHY. "Use skills only from trusted sources and audit every bundled file" is
 * the vendor's own advice, and nobody audits a folder they cannot see. The
 * review screen (design §7.2) needs the things worth a second look, each with
 * its file and line: scripts and what interprets them, network calls,
 * shell-outs and `eval`, reads of credential paths, long base64 blobs, binary
 * executables, oversized files, hidden Unicode, and text written to steer an
 * AI ("ignore your instructions…") — the last via shared/injection-guard, the
 * same scorer the browser and WebFetch use, so a skill is judged by the rules
 * a web page is.
 *
 * WHAT IT IS NOT. A verdict. It is information for the reviewer (design §5.1
 * import, item 3): a skill that runs `subprocess` may be exactly what was
 * wanted, and a careful attacker can phrase anything so no pattern matches.
 * Nothing here blocks an install — the person decides, and the archive limits
 * in skills/archive are what refuse outright.
 *
 * Nothing is executed. Files are read as bytes and matched as text.
 *
 * @module skills/scan
 */

import fs from 'fs';
import path from 'path';
import { scanInstructions, stripInvisibleUnicode } from '../../shared/injection-guard.js';
import { listTree } from './provenance.js';

export type FindingKind =
  | 'script' | 'binary' | 'network' | 'exec' | 'credentials' | 'base64'
  | 'injection' | 'hidden-unicode' | 'oversized' | 'large-body';

export interface ScanFinding {
  kind: FindingKind;
  severity: 'high' | 'warn' | 'info';
  file: string;
  /** 1-based, when the finding is about one line. */
  line?: number;
  /** What was found, in words, with the matched text where there is one. */
  message: string;
}

export interface ScanReport {
  findings: ScanFinding[];
  totals: { high: number; warn: number; info: number };
  /** Files a person could run (by extension, shebang, or recorded exec bit). */
  scripts: Array<{ file: string; interpreter: string }>;
  /** SKILL.md body, in estimated tokens (chars ÷ 4). */
  bodyTokens: number;
}

const SCRIPT_EXT: Record<string, string> = {
  '.py': 'python', '.sh': 'sh', '.bash': 'bash', '.zsh': 'zsh', '.ps1': 'PowerShell', '.psm1': 'PowerShell',
  '.js': 'node', '.mjs': 'node', '.cjs': 'node', '.ts': 'node (TypeScript)', '.rb': 'ruby', '.pl': 'perl',
  '.php': 'php', '.bat': 'cmd', '.cmd': 'cmd', '.vbs': 'Windows Script Host', '.lua': 'lua', '.go': 'go run',
  '.r': 'Rscript', '.jl': 'julia', '.swift': 'swift', '.kts': 'kotlin',
};
const BINARY_EXT = /\.(exe|dll|so|dylib|bin|msi|com|scr|jar|class|node|wasm)$/i;
/** Files larger than this are flagged: nothing a skill reads needs to be. */
const OVERSIZED = 1024 * 1024;
const BODY_TOKENS_WARN = 5000;
const MAX_PER_FILE = 20;
const MAX_TOTAL = 300;
const TEXT_LIMIT = 2 * 1024 * 1024;

interface Rule { kind: FindingKind; severity: ScanFinding['severity']; re: RegExp; what: string }

const RULES: Rule[] = [
  { kind: 'network', severity: 'warn', what: 'makes a network call',
    re: /\b(curl|wget|Invoke-WebRequest|Invoke-RestMethod|iwr|irm|Net\.WebClient|HttpClient|urllib\.request|urlopen|requests\.(get|post|put|delete|patch|request)|httpx\.|aiohttp|http\.client|socket\.(socket|create_connection)|axios|node-fetch|XMLHttpRequest|ftp(lib)?\b|scp\s|rsync\s|nc\s+-|netcat)\b|\bfetch\s*\(|https?:\/\/[^\s'")<>]+/i },
  { kind: 'exec', severity: 'warn', what: 'runs another program or evaluates code',
    re: /\b(subprocess\.|os\.system|os\.popen|os\.exec\w*|pty\.spawn|child_process|execSync|spawnSync|execFile|Start-Process|Invoke-Expression|iex\b|eval\s*\(|exec\s*\(|Function\s*\(|ShellExecute|Runtime\.getRuntime|ProcessBuilder|popen\s*\()|\b(bash|sh|zsh|cmd(\.exe)?|powershell(\.exe)?|pwsh)\s+(-c|\/c|-Command|-EncodedCommand)\b|\|\s*(ba|z)?sh\b/i },
  { kind: 'credentials', severity: 'high', what: 'touches a credential location',
    re: /(~|\$HOME|%USERPROFILE%|\$env:USERPROFILE)?[\\/]?\.(ssh|aws|gnupg|kube|docker)[\\/]|\bid_(rsa|ed25519|ecdsa|dsa)\b|\.netrc\b|\.npmrc\b|\.pypirc\b|\.git-credentials\b|credentials\.json\b|\bkeychain\b|Login Data\b|\bwallet\.dat\b|\/etc\/(passwd|shadow)\b|(^|[\s'"/\\])\.env(\.\w+)?\b|\.pem\b|\.p12\b|\.pfx\b|\bAICO_HOME\b|\.aico[\\/]/i },
  { kind: 'base64', severity: 'warn', what: 'decodes base64 at run time',
    re: /\bb64decode\b|\bbase64\s+(-d|--decode)\b|FromBase64String|\batob\s*\(|Buffer\.from\([^)]*['"]base64['"]/i },
];
const LONG_BASE64 = /[A-Za-z0-9+/]{200,}={0,2}/;

function looksBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

function snippet(s: string): string {
  const t = s.trim().replace(/\s+/g, ' ');
  return t.length > 140 ? `${t.slice(0, 137)}…` : t;
}

/**
 * Scan a skill folder. `executable` is the list of files an archive marked
 * executable (a folder on disk is checked for the bit directly on POSIX).
 */
export function scanSkillDir(dir: string, opts: { executable?: string[] } = {}): ScanReport {
  const findings: ScanFinding[] = [];
  const scripts: ScanReport['scripts'] = [];
  const add = (f: ScanFinding): void => { if (findings.length < MAX_TOTAL) findings.push(f); };
  const execBits = new Set(opts.executable ?? []);
  let bodyTokens = 0;

  for (const rel of listTree(dir)) {
    const abs = path.join(dir, rel);
    let stat: fs.Stats;
    try { stat = fs.statSync(abs); } catch { continue; }

    if (stat.size > OVERSIZED) {
      add({ kind: 'oversized', severity: 'warn', file: rel, message: `is ${(stat.size / 1048576).toFixed(1)} MB — far larger than anything a skill reads; check what it is.` });
    }
    const head = Buffer.alloc(Math.min(stat.size, 8000));
    try { const fd = fs.openSync(abs, 'r'); fs.readSync(fd, head, 0, head.length, 0); fs.closeSync(fd); } catch { continue; }

    const isMz = head.length > 2 && head[0] === 0x4d && head[1] === 0x5a;
    const isElf = head.length > 4 && head[0] === 0x7f && head[1] === 0x45 && head[2] === 0x4c && head[3] === 0x46;
    const isMachO = head.length > 4 && [0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe].includes(head.readUInt32BE(0));
    if (BINARY_EXT.test(rel) || isMz || isElf || isMachO) {
      add({ kind: 'binary', severity: 'high', file: rel, message: 'is a compiled program or library — it cannot be read before it runs.' });
      continue;
    }
    if (looksBinary(head)) continue;

    const ext = path.extname(rel).toLowerCase();
    const shebang = head.toString('utf8', 0, Math.min(head.length, 200)).match(/^#!\s*(\S+)(?:\s+(\S+))?/);
    const posixExec = process.platform !== 'win32' && (stat.mode & 0o111) !== 0;
    const interpreter = SCRIPT_EXT[ext]
      ?? (shebang ? (/env$/.test(shebang[1]!) ? shebang[2] ?? 'env' : path.basename(shebang[1]!)) : undefined)
      ?? (execBits.has(rel) || posixExec ? 'executable' : undefined);
    if (interpreter) {
      scripts.push({ file: rel, interpreter });
      add({ kind: 'script', severity: 'info', file: rel, message: `is a script (${interpreter}). It is never run on install; the agent runs it only through its normal, approved tools.` });
    }

    if (stat.size > TEXT_LIMIT) continue;
    const text = fs.readFileSync(abs, 'utf8');

    const hidden = stripInvisibleUnicode(text);
    if (hidden.removed > 0) {
      add({ kind: 'hidden-unicode', severity: 'high', file: rel,
        message: `contains ${hidden.removed} invisible character(s)${hidden.decoded.length ? ` spelling "${snippet(hidden.decoded.join(' '))}"` : ''} — text a person cannot see but a model reads.` });
    }

    // Prose is where an instruction aimed at the model would hide; code is not
    // scanned for it (string literals in a test fixture would be noise).
    if (/\.(md|markdown|txt|rst|html?)$/i.test(rel) || /^skill\.md$/i.test(path.basename(rel))) {
      if (/^skill\.md$/i.test(rel)) {
        const body = text.replace(/^---[\s\S]*?\n---\n?/, '');
        bodyTokens = Math.ceil(body.length / 4);
        if (bodyTokens > BODY_TOKENS_WARN) {
          add({ kind: 'large-body', severity: 'warn', file: rel, message: `body is ~${bodyTokens.toLocaleString('en-US')} tokens; the spec recommends under 5,000 — it is paid every time the skill is opened.` });
        }
      }
      for (const f of scanInstructions(hidden.text)) {
        const line = lineOf(hidden.text, f.text.slice(0, 40));
        add({ kind: 'injection', severity: 'high', file: rel, ...(line ? { line } : {}),
          message: `reads like an instruction aimed at the AI rather than a procedure (${f.rules.join(', ')}): "${snippet(f.text)}"` });
      }
    }

    let perFile = 0;
    const lines = text.split('\n');
    for (let i = 0; i < lines.length && perFile < MAX_PER_FILE; i++) {
      const l = lines[i]!;
      for (const rule of RULES) {
        const m = rule.re.exec(l);
        if (!m) continue;
        add({ kind: rule.kind, severity: rule.severity, file: rel, line: i + 1, message: `${rule.what}: ${snippet(l)}` });
        perFile++;
      }
      if (LONG_BASE64.test(l)) {
        add({ kind: 'base64', severity: 'warn', file: rel, line: i + 1, message: 'carries a long base64 blob — encoded content a reader cannot check by eye.' });
        perFile++;
      }
    }
  }

  const totals = { high: 0, warn: 0, info: 0 };
  for (const f of findings) totals[f.severity]++;
  return { findings, totals, scripts, bodyTokens };
}

function lineOf(text: string, needle: string): number | undefined {
  const i = text.indexOf(needle);
  return i < 0 ? undefined : text.slice(0, i).split('\n').length;
}
