import * as readline from 'readline';
import chalk from 'chalk';

const TOOLS_REQUIRING_PERMISSION = new Set([
  'Bash',
  'Write',
  'Edit',
  'McpAddServer',
  'McpRemoveServer',
  'McpReloadServers',
  'WorkspaceSetPath',
  'WorkspaceWrite',
  'AgentCreate',
]);

const DANGEROUS_TOOLS = new Set([
  'Bash',
  'McpAddServer',
  'McpReloadServers',
  'WorkspaceSetPath',
  'AgentCreate',
]);

/**
 * Session-level trust store.
 * 'all'   — user said "trust all" — never ask again
 * 'none'  — user said "deny all" — never ask again
 * Set<string> — approved individual tool categories this session
 */
type TrustLevel = 'all' | 'none' | Set<string>;
let sessionTrust: TrustLevel = new Set();

/** Ask a yes/no question via readline (no clack — avoids terminal state corruption) */
async function askYesNo(question: string): Promise<boolean> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: false, // don't touch raw mode
    });
    rl.question(chalk.yellow(`\n⚠  ${question} [y/N/all/deny-all] `) , (answer) => {
      rl.close();
      const a = answer.trim().toLowerCase();
      if (a === 'all') {
        sessionTrust = 'all';
        resolve(true);
      } else if (a === 'deny-all' || a === 'deny') {
        sessionTrust = 'none';
        resolve(false);
      } else {
        resolve(a === 'y' || a === 'yes');
      }
    });
  });
}

/** Reset session trust (call when starting a new REPL session) */
export function resetPermissions(): void {
  sessionTrust = new Set();
}

export function getPermissionState(): {
  mode: 'all' | 'none' | 'custom';
  approvedTools: string[];
  toolsRequiringPermission: string[];
  dangerousTools: string[];
} {
  return {
    mode: sessionTrust === 'all' ? 'all' : sessionTrust === 'none' ? 'none' : 'custom',
    approvedTools: sessionTrust instanceof Set ? [...sessionTrust].sort() : [],
    toolsRequiringPermission: [...TOOLS_REQUIRING_PERMISSION].sort(),
    dangerousTools: [...DANGEROUS_TOOLS].sort(),
  };
}

export function trustAllPermissions(): void {
  sessionTrust = 'all';
}

export function denyAllPermissions(): void {
  sessionTrust = 'none';
}

export function approveToolPermission(toolName: string): void {
  if (!(sessionTrust instanceof Set)) sessionTrust = new Set();
  sessionTrust.add(toolName);
}

export function revokeToolPermission(toolName: string): void {
  if (!(sessionTrust instanceof Set)) sessionTrust = new Set();
  sessionTrust.delete(toolName);
}

export function toolRequiresPermission(toolName: string): boolean {
  return TOOLS_REQUIRING_PERMISSION.has(toolName);
}

export async function checkPermission(
  toolName: string,
  args: Record<string, unknown>,
  autoApprove: boolean,
): Promise<boolean> {
  // -y flag or session trust-all
  if (autoApprove) return true;
  if (sessionTrust === 'all') return true;
  if (sessionTrust === 'none') return false;

  // Read-only tools never need permission
  if (!TOOLS_REQUIRING_PERMISSION.has(toolName)) return true;

  // Already approved this tool type this session
  if (sessionTrust instanceof Set && sessionTrust.has(toolName)) return true;

  // Build a human-readable description
  let description = '';
  switch (toolName) {
    case 'Bash':
      description = `run shell commands`;
      break;
    case 'Write':
      description = `create/write files`;
      break;
    case 'Edit':
      description = `edit existing files`;
      break;
    case 'McpAddServer':
      description = `add and start MCP servers`;
      break;
    case 'McpRemoveServer':
      description = `remove MCP servers`;
      break;
    case 'McpReloadServers':
      description = `reload MCP servers`;
      break;
    case 'WorkspaceSetPath':
      description = `change the project AICO workspace path`;
      break;
    case 'WorkspaceWrite':
      description = `write files inside the AICO workspace`;
      break;
    case 'AgentCreate':
      description = `create or update reusable AICO agent specs`;
      break;
    default:
      description = `execute ${toolName}`;
  }

  // Specific detail for this call
  let detail = '';
  if (args.command) detail = chalk.gray(` → ${String(args.command).slice(0, 80)}`);
  else if (args.file_path) detail = chalk.gray(` → ${args.file_path}`);
  else if (args.path) detail = chalk.gray(` → ${args.path}`);
  else if (args.name) detail = chalk.gray(` → ${args.name}`);

  process.stdout.write(
    chalk.yellow(`\n  🔐 Permission needed: ${chalk.bold(toolName)}`) + detail + '\n',
  );

  const allowed = await askYesNo(
    `Allow ${chalk.bold(description)} for this session? (type "all" to trust everything, "deny-all" to block all):`,
  );

  // If allowed, remember this tool type for the session (no more prompts for same tool)
  if (allowed && sessionTrust instanceof Set) {
    sessionTrust.add(toolName);
    process.stdout.write(
      chalk.green(`  ✓ ${toolName} approved for entire session\n`),
    );
  }

  return allowed;
}
