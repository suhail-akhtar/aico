/**
 * Bash command safety classifier.
 *
 * Inspects shell commands for dangerous patterns and returns a severity level.
 * Mirrors Claude Code's security classifier approach.
 */

export type SafetyLevel = 'safe' | 'warn' | 'block';

export interface SafetyResult {
  level: SafetyLevel;
  reason?: string;
}

// ── Blocked patterns — always refused ─────────────────────────────────
const BLOCKED_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  // Mass destruction
  { pattern: /\brm\s+(-[a-zA-Z]*f[a-zA-Z]*\s+)?(-[a-zA-Z]*r[a-zA-Z]*\s+)?(\/|~\/|\$HOME)\s*$/i, reason: 'Recursive delete of root or home directory' },
  { pattern: /\brm\s+-[a-zA-Z]*rf?\s+\/\s*$/i, reason: 'Recursive delete of root directory' },
  { pattern: /\bmkfs\b/i, reason: 'Filesystem formatting' },
  { pattern: /\bdd\b.*\bof=\/dev\/[sh]d/i, reason: 'Direct disk write' },
  { pattern: />\s*\/dev\/[sh]d/i, reason: 'Direct disk overwrite' },
  // Credential / secret access
  { pattern: /\bcat\b.*\.(env|pem|key|credentials|netrc|pgpass)\b/i, reason: 'Reading credential files' },
  { pattern: /\bcurl\b.*\b(password|secret|token|api.?key)\b.*@/i, reason: 'Exfiltrating secrets via curl' },
  // Unauthorized persistence
  { pattern: />>?\s*~\/\.(bashrc|zshrc|profile|bash_profile|zprofile)/i, reason: 'Modifying shell profile' },
  { pattern: /\bcrontab\b.*-[re]/i, reason: 'Modifying cron jobs' },
  { pattern: />>?\s*~\/\.ssh\/authorized_keys/i, reason: 'Modifying SSH authorized keys' },
  // Security bypass
  { pattern: /\bchmod\s+[0-7]*777\b/i, reason: 'Setting world-writable permissions' },
  { pattern: /\bchmod\s+[0-7]*4[0-7]{3}\b/i, reason: 'Setting SUID bit' },
  { pattern: /\biptables\s+-F\b/i, reason: 'Flushing firewall rules' },
  { pattern: /\bsetenforce\s+0\b/i, reason: 'Disabling SELinux' },
  // Network exfiltration patterns
  { pattern: /\bcurl\b.*\|\s*\bbash\b/i, reason: 'Piping curl to bash (code execution)' },
  { pattern: /\bwget\b.*\|\s*\bsh\b/i, reason: 'Piping wget to shell (code execution)' },
  // Encoding-based exfiltration (redirection bypasses file detection)
  { pattern: /\bbase64\b\s*<\s*[~$\/]/i, reason: 'Encoding file via redirection (exfiltration)' },
  { pattern: /\bbase64\b\s+[~$\/]\S*\.(pem|key|env|credentials|pgpass|netrc)\b/i, reason: 'Encoding credential file (exfiltration)' },
  // Environment variable exfiltration
  { pattern: /\benv\b.*\|\s*(grep|egrep|rg)\b.*\b(TOKEN|SECRET|KEY|PASSWORD|CREDENTIAL|API.?KEY)\b/i, reason: 'Exfiltrating secrets from environment variables' },
  { pattern: /\bprintenv\b.*\b(TOKEN|SECRET|KEY|PASSWORD)/i, reason: 'Reading secret environment variable' },
  // Proc/sys introspection
  { pattern: /\bcat\b\s+\/proc\//i, reason: 'Reading /proc filesystem' },
  { pattern: /\bcat\b\s+\/sys\//i, reason: 'Reading /sys filesystem' },
  // File immutability manipulation
  { pattern: /\bchattr\b\s+\+i\b/i, reason: 'Making files immutable (prevents cleanup)' },
  // ── Security review 2026-10: gaps the patterns above left open ──
  // Recursive delete of root/home with the flags in any order or spelling.
  { pattern: /\brm\s+(?=(?:-\S+\s+)*(?:-[a-zA-Z]*[rR]|--recursive)\b)(?:-\S+\s+)+(?:\/\*?|~\/?\*?|\$HOME\/?\*?)\s*$/i, reason: 'Recursive delete of root or home directory' },
  // Download-and-execute into any shell, PowerShell's `iex` included.
  { pattern: /\b(?:curl|wget|iwr|irm|invoke-webrequest|invoke-restmethod)\b.*\|\s*(?:sudo\s+)?(?:sh|bash|zsh|dash|ksh|fish|pwsh|powershell|iex|invoke-expression)\b/i, reason: 'Piping a download into a shell (code execution)' },
  // Secret files read by any pager or PowerShell reader, not only `cat`.
  { pattern: /\b(?:head|tail|less|more|type|get-content|gc|select-string|sls|bat|nl|strings|xxd|od)\b.*(?:\.env\b|\bid_(?:rsa|dsa|ecdsa|ed25519)\b|\.pem\b|\bcredentials\b|\.netrc\b|\.pgpass\b)/i, reason: 'Reading credential files' },
  // Shell rc / profile files, by any write (redirect, tee, PowerShell writers).
  { pattern: /(?:>>?|\btee\b(?:\s+-a)?|\b(?:add-content|set-content|out-file|ac|sc)\b)\s*\S*(?:\.(?:bashrc|zshrc|profile|bash_profile|zprofile|zshenv|bash_login|login)\b|\$profile\b|microsoft\.powershell_profile\.ps1)/i, reason: 'Modifying shell profile' },
  // AICO's own configuration (settings, hooks, tools, agents, trust) is
  // changed through the settings API, which asks a person — never a shell.
  { pattern: /(?:>>?|\btee\b|\b(?:cp|mv|copy|move|copy-item|move-item|add-content|set-content|out-file|ac|sc)\b|\bsed\s+-i)[^|;&]*\.aico[\\/]+(?:settings(?:\.local)?\.json|hooks[\\/]|tools[\\/]|agents[\\/]|trust\.json)/i, reason: 'Writing AICO configuration from a shell (use the settings screen)' },
  // Encoded PowerShell hides the real command from every check here.
  { pattern: /\b(?:pwsh|powershell)(?:\.exe)?\b.*\s-(?:e|ec|en|enc|enco|encod|encode|encoded|encodedc|encodedco|encodedcom|encodedcomm|encodedcomma|encodedcomman|encodedcommand)\b/i, reason: 'Encoded PowerShell command (hides what runs)' },
];

// ── Warning patterns — prompt user, not auto-blocked ─────────────────
const WARN_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  // Destructive git operations
  { pattern: /\bgit\s+push\s+.*--force\b/i, reason: 'Force push (can overwrite remote history)' },
  { pattern: /\bgit\s+reset\s+--hard\b/i, reason: 'Hard reset (discards uncommitted changes)' },
  { pattern: /\bgit\s+clean\b(?:\s+\S+)*?\s+(?:-[a-zA-Z]*[fdxX][a-zA-Z]*|--force)\b/i, reason: 'Git clean (removes untracked files)' },
  { pattern: /\bgit\s+checkout\s+(?:--\s*)?\.(?:\s|$)/i, reason: 'Git checkout . (discards all changes)' },
  { pattern: /\bgit\s+restore\b(?:\s+-\S+)*\s+\.(?:\s|$)/i, reason: 'Git restore . (discards all changes)' },
  // Recursive deletes in PowerShell and cmd, by any spelling.
  { pattern: /\b(?:remove-item|ri|rm|del|erase|rd|rmdir)\b[^|;&]*\s-r(?:e(?:c(?:u(?:r(?:s(?:e)?)?)?)?)?)?\b/i, reason: 'Recursive file deletion' },
  { pattern: /\b(?:del|erase)\b[^|;&]*\s\/[sq]\b|\b(?:rd|rmdir)\b[^|;&]*\s\/s\b/i, reason: 'Recursive file deletion' },
  { pattern: /\bgit\s+branch\s+-D\b/i, reason: 'Force-delete branch' },
  // Process / system management
  { pattern: /\bkill\s+-9\b/i, reason: 'Force-killing process' },
  { pattern: /\bkillall\b/i, reason: 'Killing all processes by name' },
  { pattern: /\bpkill\b/i, reason: 'Pattern-based process killing' },
  // Recursive operations on broad paths
  { pattern: /\brm\s+-[a-zA-Z]*r/i, reason: 'Recursive file deletion' },
  { pattern: /\bfind\b.*-delete\b/i, reason: 'Find with delete' },
  // Package/infrastructure changes
  { pattern: /\bnpm\s+publish\b/i, reason: 'Publishing npm package' },
  { pattern: /\bdocker\s+(rm|rmi|prune)\b/i, reason: 'Removing Docker resources' },
  { pattern: /\bdrop\s+(database|table|schema)\b/i, reason: 'Dropping database objects' },
  // Permission changes
  { pattern: /\bchmod\b/i, reason: 'Changing file permissions' },
  { pattern: /\bchown\b/i, reason: 'Changing file ownership' },
  // Environment modification
  { pattern: /\bsudo\b/i, reason: 'Elevated privilege command' },
  // Silent file creation
  { pattern: /\btee\b\s+\S+/i, reason: 'Writing to file via tee' },
  // Identity exfiltration
  { pattern: /\bgit\s+config\s+(--global\s+)?user\.(email|name)\b/i, reason: 'Reading/setting git identity' },
  // Process introspection (can reveal secrets)
  { pattern: /\blsof\b/i, reason: 'Process introspection (may reveal secrets)' },
  { pattern: /\bfuser\b/i, reason: 'Process introspection' },
];

/**
 * Classify a bash command for safety.
 * Returns 'block' for dangerous commands, 'warn' for risky ones, 'safe' otherwise.
 */
export function classifyBashCommand(command: string): SafetyResult {
  // Each pattern is tried against the command as written and as normalised,
  // so `r"m" -rf /`, `\rm`, `'curl' x | sh` and line continuations do not
  // slip past a pattern that matches the plain spelling.
  const forms = [command, normaliseShell(command)];
  // Check blocked patterns first
  for (const { pattern, reason } of BLOCKED_PATTERNS) {
    if (forms.some(f => pattern.test(f))) {
      return { level: 'block', reason };
    }
  }

  // Check warning patterns
  for (const { pattern, reason } of WARN_PATTERNS) {
    if (forms.some(f => pattern.test(f))) {
      return { level: 'warn', reason };
    }
  }

  return { level: 'safe' };
}

/**
 * The command with quoting and escapes that do not change what runs removed:
 * line continuations joined, quote characters deleted (`r"m"` → `rm`), and a
 * backslash or PowerShell backtick before a letter at a word start deleted
 * (`\rm` → `rm`). Path backslashes (`C:\x`) survive: only a backslash at a
 * word start counts as an escape here.
 */
export function normaliseShell(command: string): string {
  return command
    .replace(/[\\`]\r?\n/g, ' ')
    .replace(/["']/g, '')
    .replace(/(^|[\s;&|(])[\\`]+(?=[A-Za-z])/g, '$1')
    .replace(/`(?=[A-Za-z])/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Check if a bash command is read-only — safe for concurrent execution,
 * allowed in plan mode, and allowed after the session read untrusted content.
 *
 * Conservative by construction (security review 2026-10). Only the first
 * segment used to be checked, so `ls; rm -rf x`, `cat a > b`, `echo $(rm x)`
 * and `node -e "…"` all counted as read-only. Now a command is read-only only
 * when it has no redirection, no command substitution, no newline, and EVERY
 * segment of every pipe and chain is on the list. Interpreters (node, python,
 * perl, ruby, shells), `sed` (`-i`), `env` (runs a program), `wget` (writes a
 * file) and the writing git subcommands (config, stash, checkout, restore,
 * clean) are not on it.
 */
export function isBashReadOnly(command: string): boolean {
  const cmd = command.trim();
  if (!cmd) return false;
  // Redirection, command/process substitution, newlines.
  if (/[<>`\r\n]|\$\(/.test(cmd)) return false;
  const segments = cmd.split(/\|\||&&|[|;&]/).map(s => s.trim());
  if (segments.some(s => !s)) return false;
  return segments.every(segmentIsReadOnly);
}

const READ_ONLY_COMMANDS = new Set([
  'ls', 'dir', 'cat', 'head', 'tail', 'less', 'more',
  'grep', 'rg', 'ag', 'ack', 'find', 'fd', 'locate', 'which', 'where',
  'wc', 'sort', 'uniq', 'diff', 'comm', 'cut', 'tr', 'awk',
  'file', 'stat', 'du', 'df', 'date', 'whoami', 'hostname', 'uname',
  'pwd', 'echo', 'printf', 'printenv', 'type',
  'git', 'jq', 'yq', 'curl', 'ping', 'dig', 'nslookup',
]);

function segmentIsReadOnly(segment: string): boolean {
  const words = segment.split(/\s+/);
  const baseName = (words[0] ?? '').replace(/^.*[\\/]/, ''); // strip path
  if (!READ_ONLY_COMMANDS.has(baseName)) return false;
  const rest = words.slice(1);
  switch (baseName) {
    case 'git': return gitIsReadOnly(rest);
    // -delete / -exec run or remove things; -fprint writes a file.
    case 'find': return !rest.some(w => /^-(?:delete|exec|execdir|ok|okdir|fprint\w*|fls)$/.test(w));
    case 'fd': return !rest.some(w => /^(?:-x|-X|--exec|--exec-batch)$/.test(w));
    case 'sort': return !rest.some(w => /^(?:-o|--output)/.test(w));
    // awk can run programs (system, piped print, getline from a command).
    case 'awk': return !/system\s*\(|\bgetline\b|print[^;]*\|/.test(segment);
    // Only fetches that send nothing and write nothing.
    case 'curl': return !rest.some(w => /^(?:-[a-zA-Z]*[oOdFTXK]|--(?:output|remote-name|data|form|upload-file|request|config|json))/.test(w));
    case 'date': return !rest.some(w => /^(?:-s|--set)/.test(w));
    case 'hostname': return rest.every(w => w.startsWith('-'));
    default: return true;
  }
}

function gitIsReadOnly(args: string[]): boolean {
  // Global options before the subcommand (`-C dir`, `--no-pager`). `-c`
  // sets config for this run, which can name a program to execute.
  let i = 0;
  while (i < args.length && args[i]!.startsWith('-')) {
    if (args[i] === '-c' || args[i]!.startsWith('--config')) return false;
    i += args[i] === '-C' ? 2 : 1;
  }
  const sub = args[i];
  const rest = args.slice(i + 1);
  if (!sub) return false;
  switch (sub) {
    case 'status': case 'log': case 'diff': case 'show': case 'describe': case 'blame': case 'shortlog':
    case 'rev-parse': case 'ls-files': case 'ls-tree': case 'cat-file': case 'grep':
      return !rest.some(w => /^--(?:output|ext-diff)/.test(w));
    // Listing forms only: `git branch foo` creates a branch, `git tag v1` a tag.
    case 'branch':
      return rest.every(w => /^(?:-a|-r|-l|-v|-vv|--list|--all|--remotes|--verbose|--show-current|--no-color|--color(?:=\S+)?)$/.test(w));
    case 'tag':
      return rest.length === 0 || rest[0] === '-l' || rest[0] === '--list';
    case 'remote':
      return rest.length === 0 || ['-v', '--verbose', 'show', 'get-url'].includes(rest[0]!);
    default: return false;
  }
}

/**
 * The shell command a tool call will run, for every tool that runs one.
 *
 * The hard blocks above were applied only when the tool was named `Bash`, so
 * the same command through `Terminal`, a `PowerShell` tool, or the desktop's
 * `ide_terminal_run` host tool skipped them (security review 2026-10). Every
 * guard that judges a shell command asks this instead of comparing names.
 */
export function shellCommandOf(name: string, args: Record<string, unknown> | undefined): string | undefined {
  const command = args?.command;
  if (typeof command !== 'string' || !command) return undefined;
  if (SHELL_TOOL_NAMES.has(name)) return command;
  // An MCP tool is `mcp__<server>__<tool>`; the host's terminal runner by its tool name.
  if (/^mcp__.+__ide_terminal_run$/.test(name)) return command;
  return undefined;
}

/** Built-in tools whose `command` argument is run by a shell. */
export const SHELL_TOOL_NAMES: ReadonlySet<string> = new Set(['Bash', 'Terminal', 'PowerShell']);
