/**
 * Which shell the command tools actually get, and saying so.
 *
 * On Windows this used to be `cmd.exe`, unconditionally and silently. The tool
 * is called `Bash`, its description says "shell command", and the prompt said
 * only `Platform: win32` — so a model wrote `ls -la vendor/` and got
 * *'ls' is not recognized as an internal or external command*, then wrote
 * `dir ... | head -50` and got the same for `head`. That is not the model
 * guessing badly. Every example of shell usage it has ever read is POSIX, and
 * nothing told it otherwise.
 *
 * Two fixes, and both are needed:
 *
 * 1. **Prefer a shell that has those commands.** Git for Windows ships a real
 *    bash, and is installed on essentially every Windows machine with a git
 *    checkout on it. Claude Code solves the same problem the same way.
 * 2. **Say which one was chosen.** A fallback that silently lands on PowerShell
 *    reproduces the original bug in a new dialect, so `describe` goes into the
 *    system prompt and the model knows what it is holding.
 *
 * POSIX platforms have exactly one answer and always did; nothing changes there.
 *
 * @module tools/shell-choice
 */

import { existsSync } from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';

export type ShellKind = 'posix' | 'git-bash' | 'powershell' | 'cmd';

export interface ShellChoice {
  kind: ShellKind;
  /** Absolute path to the executable, or a bare name resolved on PATH. */
  command: string;
  /** Arguments that run one command string and exit. */
  oneShot: (command: string) => string[];
  /** Arguments that start a shell reading from stdin, for the persistent one. */
  interactive: string[];
  /**
   * Whether arguments must be passed to Windows verbatim.
   *
   * True only for `cmd.exe`, whose quoting rules Node's normal escaping breaks.
   * Applying it to bash mangles any command containing a quote.
   */
  verbatim: boolean;
  /** One line for the system prompt. */
  describe: string;

  // ── what the persistent shell in `terminal.ts` also needs ──────────
  //
  // These live here because they are all answers to "which shell is this".
  // `terminal.ts` used to ask "is this Windows", which was the same question
  // only for as long as Windows meant cmd.

  /** Line ending this shell expects on stdin. */
  eol: string;
  /** Sent once at startup to stop the shell narrating. Empty when it does not. */
  setup: string;
  /**
   * A line printing `<marker> <exit code> <cwd>` after a command.
   *
   * How one round trip reports both results: what the command returned, and
   * where it left the shell. Getting this wrong does not raise an error — the
   * poll simply never matches, and every command reports a timeout instead.
   */
  report: (marker: string) => string;
}

/** Shared by every POSIX-shaped shell, including Git Bash on Windows. */
const POSIX_BEHAVIOUR = {
  oneShot: (command: string) => ['-c', command],
  interactive: [] as string[],
  verbatim: false,
  eol: '\n',
  setup: '',
  report: (marker: string) => `printf '%s %s %s\\n' '${marker}' "$?" "$PWD"`,
};

/**
 * PowerShell's equivalents.
 *
 * `$LASTEXITCODE` is set by native executables and left untouched by cmdlets,
 * so it is seeded before being read. Without that the first cmdlet of a session
 * reports an empty exit code, the pattern never matches, and the command looks
 * like it timed out.
 */
const POWERSHELL_BEHAVIOUR = {
  oneShot: (command: string) => ['-NoProfile', '-NonInteractive', '-Command', command],
  interactive: ['-NoProfile', '-Command', '-'],
  verbatim: false,
  eol: '\r\n',
  setup: "function prompt { '' }",
  report: (marker: string) =>
    'if ($null -eq $LASTEXITCODE) { $LASTEXITCODE = 0 }; '
    + `Write-Output "${marker} $LASTEXITCODE $($PWD.Path)"`,
};

/**
 * cmd's equivalents.
 *
 * `@echo off` stops it repeating each command back, and `prompt $_` reduces the
 * prompt to a bare newline — without which every result is prefixed with
 * `C:\some\path>`, which is not output but reads exactly like it.
 */
const CMD_BEHAVIOUR = {
  oneShot: (command: string) => ['/d', '/s', '/c', command],
  interactive: ['/q', '/k'],
  verbatim: true,
  eol: '\r\n',
  setup: '@echo off\r\nprompt $_',
  report: (marker: string) => `echo ${marker} %ERRORLEVEL% %CD%`,
};

const POSIX: ShellChoice = {
  kind: 'posix',
  command: '/bin/sh',
  describe: 'Shell: /bin/sh (POSIX).',
  ...POSIX_BEHAVIOUR,
};

const GIT_BASH_NOTE =
  'Shell: Git Bash on Windows (POSIX). ls, grep, head, sed, find and pipes all '
  + 'work. Prefer forward slashes in paths; a Windows path in quotes also works.';

const POWERSHELL_NOTE =
  'Shell: PowerShell on Windows. POSIX tools are NOT available — no ls, grep, '
  + 'head or sed. Use Get-ChildItem, Select-String, Select-Object -First N.';

const CMD_NOTE =
  'Shell: cmd.exe on Windows. POSIX tools are NOT available — no ls, grep, head '
  + 'or sed. Use dir, findstr, type. Chain with && rather than ;.';

/**
 * Where Git for Windows puts bash, in the order worth trying.
 *
 * `git --exec-path` first, because it is authoritative for whichever install is
 * actually on PATH — including a portable or scoop install in none of the usual
 * places. The fixed paths cover a machine where git is installed but not on it.
 */
function gitBashCandidates(): string[] {
  const out: string[] = [];

  try {
    // `C:\Program Files\Git\mingw64\libexec\git-core` → `C:\Program Files\Git`.
    const execPath = execFileSync('git', ['--exec-path'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000,
    }).trim();
    if (execPath) out.push(path.join(path.resolve(execPath, '..', '..', '..'), 'bin', 'bash.exe'));
  } catch { /* git not on PATH; the fixed paths below may still find it */ }

  const programFiles = process.env['ProgramFiles'] ?? 'C:\\Program Files';
  const programFilesX86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)';
  const localAppData = process.env['LOCALAPPDATA'];

  out.push(path.join(programFiles, 'Git', 'bin', 'bash.exe'));
  out.push(path.join(programFilesX86, 'Git', 'bin', 'bash.exe'));
  if (localAppData) out.push(path.join(localAppData, 'Programs', 'Git', 'bin', 'bash.exe'));

  return out;
}

/**
 * Resolved once per process.
 *
 * Detection stats several paths and may shell out to `git`, which is far too
 * much to repeat in a session that makes hundreds of `Bash` calls.
 */
let cached: ShellChoice | undefined;

export function detectShell(): ShellChoice {
  cached ??= choose();
  return cached;
}

/** Test seam: detection reads the real filesystem, so tests need a way back. */
export function resetShellChoiceForTest(): void {
  cached = undefined;
}

function choose(): ShellChoice {
  if (process.platform !== 'win32') return POSIX;

  /*
    An explicit override wins over everything. Somebody on MSYS2, Cygwin or a
    busybox needs a way to say so that does not involve us guessing at more
    paths — and a way to force cmd back if this change surprises them.
  */
  const override = process.env['AICO_SHELL']?.trim();
  if (override && existsSync(override)) return fromPath(override);

  for (const candidate of gitBashCandidates()) {
    if (existsSync(candidate)) {
      return { kind: 'git-bash', command: candidate, describe: GIT_BASH_NOTE, ...POSIX_BEHAVIOUR };
    }
  }

  const pwsh = onPath('pwsh.exe') ?? onPath('powershell.exe');
  if (pwsh) {
    return { kind: 'powershell', command: pwsh, describe: POWERSHELL_NOTE, ...POWERSHELL_BEHAVIOUR };
  }

  return { kind: 'cmd', command: 'cmd.exe', describe: CMD_NOTE, ...CMD_BEHAVIOUR };
}

/** Interpret an `AICO_SHELL` path by its filename. */
function fromPath(executable: string): ShellChoice {
  const name = path.basename(executable).toLowerCase();
  const from = ' (from AICO_SHELL)';

  if (name.includes('powershell') || name.includes('pwsh')) {
    return {
      kind: 'powershell', command: executable,
      describe: POWERSHELL_NOTE + from, ...POWERSHELL_BEHAVIOUR,
    };
  }
  if (name.includes('cmd')) {
    return { kind: 'cmd', command: executable, describe: CMD_NOTE + from, ...CMD_BEHAVIOUR };
  }
  // Anything else is assumed POSIX — bash, sh, zsh, dash, busybox.
  return {
    kind: 'git-bash', command: executable,
    describe: `Shell: ${path.basename(executable)} on Windows (POSIX)${from}.`,
    ...POSIX_BEHAVIOUR,
  };
}

/** Resolve a name on PATH without running it. `where` is cmd's `which`. */
function onPath(name: string): string | undefined {
  try {
    return execFileSync('where', [name], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000,
    }).split(/\r?\n/).map(l => l.trim()).filter(Boolean)[0];
  } catch {
    return undefined;
  }
}
