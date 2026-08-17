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
];

// ── Warning patterns — prompt user, not auto-blocked ─────────────────
const WARN_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  // Destructive git operations
  { pattern: /\bgit\s+push\s+.*--force\b/i, reason: 'Force push (can overwrite remote history)' },
  { pattern: /\bgit\s+reset\s+--hard\b/i, reason: 'Hard reset (discards uncommitted changes)' },
  { pattern: /\bgit\s+clean\s+-[a-zA-Z]*f/i, reason: 'Git clean (removes untracked files)' },
  { pattern: /\bgit\s+checkout\s+--\s*\./i, reason: 'Git checkout -- . (discards all changes)' },
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
  // Check blocked patterns first
  for (const { pattern, reason } of BLOCKED_PATTERNS) {
    if (pattern.test(command)) {
      return { level: 'block', reason };
    }
  }

  // Check warning patterns
  for (const { pattern, reason } of WARN_PATTERNS) {
    if (pattern.test(command)) {
      return { level: 'warn', reason };
    }
  }

  return { level: 'safe' };
}

/**
 * Check if a bash command is read-only (safe for concurrent execution).
 * Used by the concurrency classifier.
 */
export function isBashReadOnly(command: string): boolean {
  // Trim and get the first command (before pipes/semicolons)
  const firstCmd = command.split(/[|;&]/).map(s => s.trim())[0];
  const binary = firstCmd.split(/\s+/)[0];

  const READ_ONLY_COMMANDS = new Set([
    'ls', 'dir', 'cat', 'head', 'tail', 'less', 'more',
    'grep', 'rg', 'ag', 'ack', 'find', 'fd', 'locate', 'which', 'where',
    'wc', 'sort', 'uniq', 'diff', 'comm', 'cut', 'tr', 'awk', 'sed',
    'file', 'stat', 'du', 'df', 'date', 'whoami', 'hostname', 'uname',
    'pwd', 'echo', 'printf', 'env', 'printenv', 'type',
    'git', 'node', 'python', 'python3', 'ruby', 'perl',
    'jq', 'yq', 'curl', 'wget', 'ping', 'dig', 'nslookup',
  ]);

  // Check if the base command is read-only
  const baseName = binary.replace(/^.*[\\/]/, ''); // strip path
  if (!READ_ONLY_COMMANDS.has(baseName)) return false;

  // For git: only certain subcommands are read-only
  if (baseName === 'git') {
    const gitSub = firstCmd.match(/\bgit\s+(\w+)/)?.[1];
    const readOnlyGit = new Set([
      'status', 'log', 'diff', 'show', 'branch', 'tag', 'remote',
      'describe', 'blame', 'shortlog', 'rev-parse', 'ls-files',
      'ls-tree', 'cat-file', 'config', 'stash',
    ]);
    return gitSub ? readOnlyGit.has(gitSub) : false;
  }

  return true;
}
