/**
 * Toolchain probes: is Python / Java / .NET / Go / PHP / Node really here, and
 * new enough?
 *
 * Why this exists: `requires` used to be `{node}` and `toolAvailable` ran
 * `<tool> --version`. That is wrong for the stacks the starters now cover —
 * `go --version` is not Go syntax (it would always report Go missing), `java`
 * prints its version on stderr and with a single dash, and "python" on Windows
 * can be a Store stub that exits non-zero while `py -3` works. A refusal that
 * names the wrong problem is worse than none, so each toolchain has a real
 * probe (command, args, a regex that captures the version) and the version is
 * compared with the range the template declares.
 *
 * What a missing toolchain produces: a plain message that names what to
 * install and, when Docker answers, the container fallback (ADR 0031 §4). It
 * never installs anything — shell confinement (ADR 0027) treats global installs
 * as a person's decision, and so does this.
 *
 * What it deliberately does not do: parse arbitrary semver (only the
 * comparators a template needs: `>=`, `>`, `<=`, `<`, `=`), run anything with
 * text from outside the manifest, or remember an answer for long (results live
 * 15 seconds, so a toolchain the person installs mid-session is found on the
 * next try; {@link clearToolchainCache} forgets at once).
 *
 * @module apps/toolchain
 */

import { spawnSync } from 'child_process';

export type ToolchainId = 'node' | 'python' | 'java' | 'dotnet' | 'go' | 'php';

export const TOOLCHAIN_IDS: readonly ToolchainId[] = ['node', 'python', 'java', 'dotnet', 'go', 'php'];

export interface ProbeSpec {
  command: string;
  args: string[];
  /** Regex source; the first capture group is the version. */
  parse: string;
  /** Where the version is printed. `java -version` writes to stderr. Default both. */
  stream?: 'stdout' | 'stderr' | 'both';
}

export interface ToolRequirement {
  /** A toolchain id or any executable name (`uv`, `composer`, `docker`, `mvn`). */
  id: string;
  /** Comparator range, e.g. `>=3.12 <4`. Absent means any version. */
  version?: string;
  optional?: boolean;
  probe?: ProbeSpec;
}

export interface ToolchainSpec {
  id: ToolchainId;
  version?: string;
  probe?: ProbeSpec;
  tools?: ToolRequirement[];
  installHint?: string;
}

export interface ToolStatus {
  id: string;
  found: boolean;
  version?: string;
  /** The command that answered (`python3`, `py -3`), for display and aliasing. */
  command?: string;
}

/** How the process is run. Injected by tests; the default spawns for real. */
export type ProbeRunner = (command: string, args: string[]) => { status: number | null; stdout: string; stderr: string };

const VERSION_RE = '(\\d+\\.\\d+(?:\\.\\d+)?)';

/**
 * Built-in probes, first answer wins. Commands are fixed constants; the only
 * manifest-supplied probe text goes through {@link validateProbe} first.
 */
export const DEFAULT_PROBES: Record<string, ProbeSpec[]> = {
  node: [{ command: 'node', args: ['--version'], parse: 'v?(\\d+\\.\\d+\\.\\d+)' }],
  python: [
    { command: 'python', args: ['--version'], parse: `Python ${VERSION_RE}` },
    { command: 'python3', args: ['--version'], parse: `Python ${VERSION_RE}` },
    { command: 'py', args: ['-3', '--version'], parse: `Python ${VERSION_RE}` },
  ],
  java: [{ command: 'java', args: ['-version'], parse: 'version "(\\d+(?:\\.\\d+)*)', stream: 'stderr' }],
  dotnet: [{ command: 'dotnet', args: ['--version'], parse: '(\\d+\\.\\d+\\.\\d+)' }],
  go: [{ command: 'go', args: ['version'], parse: `go${VERSION_RE}` }],
  php: [{ command: 'php', args: ['--version'], parse: `PHP ${VERSION_RE}` }],
  composer: [{ command: 'composer', args: ['--version'], parse: `Composer version ${VERSION_RE}` }],
  docker: [{ command: 'docker', args: ['--version'], parse: `Docker version ${VERSION_RE}` }],
  uv: [{ command: 'uv', args: ['--version'], parse: `uv ${VERSION_RE}` }],
  git: [{ command: 'git', args: ['--version'], parse: `git version ${VERSION_RE}` }],
  mvn: [{ command: 'mvn', args: ['-v'], parse: `Apache Maven ${VERSION_RE}` }],
  gradle: [{ command: 'gradle', args: ['--version'], parse: `Gradle ${VERSION_RE}` }],
  npm: [{ command: 'npm', args: ['--version'], parse: `${VERSION_RE}` }],
  npx: [{ command: 'npx', args: ['--version'], parse: `${VERSION_RE}` }],
};

/** What to tell a person who lacks a toolchain. */
export const INSTALL_HINTS: Record<string, string> = {
  node: 'Install Node.js 22 LTS or newer from https://nodejs.org/',
  python: 'Install Python from https://www.python.org/downloads/ (or `winget install Python.Python.3.14`), then reopen the terminal',
  java: 'Install a JDK 25 LTS, for example Temurin from https://adoptium.net/',
  dotnet: 'Install the .NET SDK from https://dotnet.microsoft.com/download',
  go: 'Install Go from https://go.dev/dl/',
  php: 'Install PHP from https://www.php.net/downloads (Windows: https://windows.php.net/)',
  composer: 'Install Composer from https://getcomposer.org/download/',
  docker: 'Install Docker from https://docs.docker.com/get-docker/',
  uv: 'Install uv from https://docs.astral.sh/uv/getting-started/installation/',
};

/**
 * The pinned development image per toolchain (verified tags, industry.md §8),
 * used by the Docker fallback when a template names none.
 */
export const DEFAULT_DOCKER_IMAGES: Record<ToolchainId, string> = {
  node: 'node:24-slim',
  python: 'python:3.14-slim',
  java: 'maven:3.9-eclipse-temurin-25',
  dotnet: 'mcr.microsoft.com/dotnet/sdk:10.0',
  go: 'golang:1.27.1-bookworm',
  php: 'php:8.5-cli',
};

/** Characters allowed in a probe command or argument taken from a manifest. */
const SAFE_WORD = /^[A-Za-z0-9._=:+/-]+$/;

/** Problems with a manifest-supplied probe; an empty list means safe to run. */
export function validateProbe(probe: unknown, where = 'probe'): string[] {
  const problems: string[] = [];
  if (!probe || typeof probe !== 'object') return [`${where} must be an object`];
  const p = probe as Record<string, unknown>;
  if (typeof p.command !== 'string' || !SAFE_WORD.test(p.command)) problems.push(`${where}.command must be a bare executable name`);
  if (!Array.isArray(p.args) || !p.args.every(a => typeof a === 'string' && SAFE_WORD.test(a))) {
    problems.push(`${where}.args must be an array of plain words`);
  }
  if (typeof p.parse !== 'string') problems.push(`${where}.parse must be a regex source`);
  else {
    try { new RegExp(p.parse); } catch { problems.push(`${where}.parse is not a valid regular expression`); }
  }
  if (p.stream !== undefined && !['stdout', 'stderr', 'both'].includes(String(p.stream))) {
    problems.push(`${where}.stream must be stdout, stderr or both`);
  }
  return problems;
}

/** Parse `>=3.12 <4` into comparators. Unknown tokens make the range unconstrained, never a false refusal. */
function parseRange(range: string): Array<{ op: string; v: number[] }> {
  const out: Array<{ op: string; v: number[] }> = [];
  for (const token of range.trim().split(/\s+/)) {
    const m = /^(>=|<=|>|<|=)?\s*v?(\d+(?:\.\d+){0,2})$/.exec(token);
    if (!m) continue;
    out.push({ op: m[1] ?? '=', v: m[2]!.split('.').map(Number) });
  }
  return out;
}

function compare(a: number[], b: number[]): number {
  for (let i = 0; i < 3; i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** Whether `version` satisfies every comparator in `range`. No range, or an unreadable one, passes. */
export function versionSatisfies(range: string | undefined, version: string): boolean {
  if (!range) return true;
  const have = version.split('.').map(n => Number(n) || 0);
  return parseRange(range).every(({ op, v }) => {
    // `=3.12` means the 3.12 line, so only compare as many parts as were given.
    if (op === '=') return v.every((n, i) => (have[i] ?? 0) === n);
    const c = compare(have, v);
    switch (op) {
      case '>=': return c >= 0;
      case '>': return c > 0;
      case '<=': return c <= 0;
      case '<': return c < 0;
      default: return true;
    }
  });
}

/** Pull the version out of a probe's output. */
export function parseVersion(output: string, parse: string): string | undefined {
  try {
    return new RegExp(parse).exec(output)?.[1];
  } catch {
    return undefined;
  }
}

const realRunner: ProbeRunner = (command, args) => {
  const r = spawnSync(command, args, {
    encoding: 'utf8',
    // Windows resolves `composer`, `mvn`, `npm` through .cmd/.bat shims, which need a shell. Every word here
    // passed SAFE_WORD, so nothing in them is interpreted.
    shell: process.platform === 'win32',
    timeout: 15_000,
    windowsHide: true,
  });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
};

/** Probe results are reused briefly: a person who installs Python and retries is found within seconds, while one dialog's several checks cost one probe. */
const CACHE_MS = 15_000;
const cache = new Map<string, { status: ToolStatus; at: number }>();

/** Forget probe results: a person who installed Python mid-session should be found next time. */
export function clearToolchainCache(): void {
  cache.clear();
}

/** The probes to try for a requirement: its own, or the built-ins for that id. */
function probesFor(req: { id: string; probe?: ProbeSpec }): ProbeSpec[] {
  if (req.probe) return [req.probe];
  return DEFAULT_PROBES[req.id] ?? [{ command: req.id, args: ['--version'], parse: VERSION_RE }];
}

/** The arguments `<tool>` answers with — for callers that only need "is it there". */
export function probeArgsFor(name: string): string[] {
  return probesFor({ id: name })[0]!.args;
}

/** Probe one tool. Cached for the process lifetime unless a runner is injected. */
export function probeTool(req: { id: string; probe?: ProbeSpec }, run?: ProbeRunner): ToolStatus {
  const key = `${req.id}|${req.probe ? JSON.stringify(req.probe) : ''}`;
  const hit = cache.get(key);
  if (!run && hit && Date.now() - hit.at < CACHE_MS) return hit.status;
  const runner = run ?? realRunner;
  let status: ToolStatus = { id: req.id, found: false };
  for (const probe of probesFor(req)) {
    if (validateProbe(probe).length) continue;
    let result;
    try { result = runner(probe.command, probe.args); } catch { continue; }
    if (result.status !== 0) continue;
    const text = probe.stream === 'stdout' ? result.stdout
      : probe.stream === 'stderr' ? result.stderr
        : `${result.stdout}\n${result.stderr}`;
    const version = parseVersion(text, probe.parse);
    status = {
      id: req.id, found: true,
      ...(version ? { version } : {}),
      command: [probe.command, ...probe.args.filter(a => !/^(--?version|-v|-V|version)$/.test(a))].join(' '),
    };
    break;
  }
  if (!run) cache.set(key, { status, at: Date.now() });
  return status;
}

export interface RequirementProblem {
  id: string;
  kind: 'missing' | 'too-old';
  found?: string;
  wanted?: string;
  message: string;
}

export interface RequirementReport {
  ok: boolean;
  problems: RequirementProblem[];
  statuses: ToolStatus[];
  /** Docker answers, so a container can stand in for a missing toolchain. */
  dockerAvailable: boolean;
  /** One paragraph for the person or the model; empty when ok. */
  message: string;
}

/** Display a range as a person would say it: `>=3.12` → `3.12+`. */
function sayRange(range: string | undefined): string {
  if (!range) return '';
  const m = /^>=\s*(\d+(?:\.\d+)*)$/.exec(range.trim());
  return m ? `${m[1]}+` : range;
}

/**
 * Check a template's toolchain and tools against this machine.
 *
 * Optional tools are probed but never reported as problems. When Docker is
 * available and something non-Docker is missing, the message offers the
 * container fallback; it does not take it.
 */
export function checkRequirements(
  spec: { toolchain?: ToolchainSpec; requiresNode?: string } | undefined,
  run?: ProbeRunner,
): RequirementReport {
  const reqs: Array<ToolRequirement & { hint?: string }> = [];
  if (spec?.toolchain) {
    const t = spec.toolchain;
    reqs.push({ id: t.id, ...(t.version ? { version: t.version } : {}), ...(t.probe ? { probe: t.probe } : {}), ...(t.installHint ? { hint: t.installHint } : {}) });
    for (const tool of t.tools ?? []) reqs.push(tool);
  } else if (spec?.requiresNode) {
    reqs.push({ id: 'node', version: spec.requiresNode });
  }
  const statuses: ToolStatus[] = [];
  const problems: RequirementProblem[] = [];
  for (const req of reqs) {
    const status = probeTool(req, run);
    statuses.push(status);
    if (req.optional) continue;
    const hint = req.hint ?? INSTALL_HINTS[req.id] ?? `Install ${req.id}`;
    if (!status.found) {
      problems.push({
        id: req.id, kind: 'missing', ...(req.version ? { wanted: req.version } : {}),
        message: `${req.id}${req.version ? ` ${sayRange(req.version)}` : ''} was not found on this machine. ${hint}.`,
      });
    } else if (req.version && status.version && !versionSatisfies(req.version, status.version)) {
      problems.push({
        id: req.id, kind: 'too-old', found: status.version, wanted: req.version,
        message: `${req.id} ${status.version} is installed but ${sayRange(req.version)} is required. ${hint}.`,
      });
    }
  }
  const dockerAvailable = problems.some(p => p.id === 'docker') ? false : probeTool({ id: 'docker' }, run).found;
  let message = '';
  if (problems.length) {
    message = problems.map(p => p.message).join(' ');
    if (dockerAvailable && !problems.some(p => p.id === 'docker')) {
      message += ' Docker is available, so the app can run in a container instead: ask to start it with docker: true.';
    }
  }
  return { ok: problems.length === 0, problems, statuses, dockerAvailable, message };
}

/**
 * When Python answered only as `python3` (Debian) or `py -3` (Windows), a
 * declared `python -m …` would fail. Rewrite the leading word, nothing else.
 */
export function aliasCommand(command: string, statuses: ToolStatus[]): string {
  const python = statuses.find(s => s.id === 'python' && s.found);
  if (python?.command && python.command !== 'python' && /^python(\s|$)/.test(command)) {
    return command.replace(/^python/, python.command);
  }
  return command;
}

/** The development image for a toolchain: the template's, else the pinned default. */
export function dockerImageFor(spec: { toolchain?: ToolchainSpec; docker?: { image?: string } } | undefined): string | undefined {
  if (spec?.docker?.image) return spec.docker.image;
  return spec?.toolchain ? DEFAULT_DOCKER_IMAGES[spec.toolchain.id] : undefined;
}
