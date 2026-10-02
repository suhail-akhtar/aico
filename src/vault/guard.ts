/**
 * Keeping the agent's own tools away from the vault's files and key stores.
 *
 * Two guards, both deny-only, installed in the tool pipeline:
 *
 *  - **File tools** (Read, Write, Edit, Grep, Glob, LS, …) are refused any
 *    path inside the vault directory. This one is complete: AICO's file tools
 *    are AICO's code, and every path they touch passes through here.
 *  - **Shell commands** (Bash, Terminal) are refused when they obviously reach
 *    for the vault directory, an OS keyring, DPAPI, a process's environment or
 *    memory, or the vault CLI's reveal commands. This one is *best effort*: a
 *    shell can build any string at runtime, and no pattern list can see through
 *    `$(printf …)`. It is defence in depth — it turns the easy, obvious attempt
 *    into a refusal the model has to reason past — and it is documented as
 *    exactly that. The real protection is that the model never holds a value
 *    and that the master key never touches the environment.
 *
 * @module vault/guard
 */

import path from 'node:path';

/** Argument keys that carry a filesystem path in AICO's own tools. */
const PATH_KEYS = ['file_path', 'path', 'notebook_path', 'directory', 'dir', 'cwd', 'target', 'root'];

/** Tools whose arguments are shell source. */
export const SHELL_TOOL_NAMES: ReadonlySet<string> = new Set(['Bash', 'Terminal']);

function normalizeForCompare(p: string): string {
  const resolved = path.resolve(p);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/** Whether `candidate` is `dir` or inside it. */
export function isInside(candidate: string, dir: string, base = process.cwd()): boolean {
  const c = normalizeForCompare(path.isAbsolute(candidate) ? candidate : path.join(base, candidate));
  const d = normalizeForCompare(dir);
  return c === d || c.startsWith(d.endsWith(path.sep) ? d : d + path.sep);
}

/** Reason to refuse a file tool call, or undefined to abstain. */
export function fileToolDenial(
  toolName: string,
  args: Record<string, unknown>,
  vaultDir: string,
  cwd: string,
): string | undefined {
  if (SHELL_TOOL_NAMES.has(toolName)) return undefined;
  const candidates: string[] = [];
  for (const key of PATH_KEYS) {
    const v = args[key];
    if (typeof v === 'string' && v) candidates.push(v);
  }
  if (Array.isArray(args.paths)) for (const v of args.paths) if (typeof v === 'string') candidates.push(v);
  // A glob pattern that names the vault directory reads it too.
  if (typeof args.pattern === 'string' && /[\\/]vault[\\/]|[\\/]vault$|vault\.json|key\.json/i.test(args.pattern)
    && /\.aico/i.test(args.pattern)) {
    return 'The credential vault\'s files are not readable by tools. Use CredentialList for what is stored.';
  }
  for (const c of candidates) {
    if (isInside(c, vaultDir, cwd)) {
      return 'The credential vault\'s files are not accessible to tools. Use CredentialList to see what is stored, '
        + 'and {{secret:name}} references (where allowed) to use it.';
    }
  }
  return undefined;
}

/** Obvious shell attempts at key material and secret stores. */
const SHELL_BLOCKS: Array<{ re: RegExp; reason: string }> = [
  { re: /\.aico[\\/]+vault\b/i, reason: 'reading the credential vault directory' },
  { re: /\bvault[\\/]+(?:key|vault)\.json\b/i, reason: 'reading the credential vault files' },
  { re: /\bsecurity\s+(?:find|dump)-(?:generic|internet)-password\b|\bsecurity\s+dump-keychain\b/i, reason: 'reading the macOS keychain' },
  { re: /\bsecret-tool\s+(?:lookup|search)\b/i, reason: 'reading the Secret Service keyring' },
  { re: /\b(?:kwallet-query|keyctl\s+(?:print|read|pipe))\b/i, reason: 'reading a keyring' },
  { re: /ProtectedData\]?\s*::\s*Unprotect|\bCryptUnprotectData\b|\bUnprotect-CmsMessage\b/i, reason: 'decrypting DPAPI-protected data' },
  { re: /\bcmdkey\s+\/list\b|\bvaultcmd\b|PasswordVault\]|\bGet-StoredCredential\b/i, reason: 'reading the Windows credential store' },
  { re: /\/proc\/(?:\d+|self|\*|\$\w+)\/(?:environ|mem|maps)\b/i, reason: 'reading another process\'s environment or memory' },
  { re: /\b(?:gdb|lldb)\s+(?:-p|--pid|attach)\b|\bprocdump\b/i, reason: 'attaching to a running process' },
  { re: /\baico\s+vault\s+(?:show|export|reveal|grant-passphrase)\b/i, reason: 'revealing vault contents from the agent\'s shell' },
  { re: /\bAICO_VAULT_(?:KEY|MASTER)\b/i, reason: 'looking for a vault key in the environment' },
  // The engine's own decision routes, driven with its token: a model approving
  // its own tool calls or credential uses. The routes refuse that anyway
  // (server/decision-gate.ts, vault/http.ts); this turns the attempt into a
  // named refusal. Needs both the route and the token, so a project of the
  // user's with its own /api/permission route is not caught.
  {
    re: /^(?=[\s\S]*\/api\/(?:permission|ui\/attach|inbox\/decide|longjob\/(?:decide|control)|vault\/(?:approve|reveal|grant|export)))(?=[\s\S]*(?:x-aico-(?:token|ui-key|client)|[?&]token=))/i,
    reason: 'answering AICO\'s own approval prompts from the agent\'s shell',
  },
];

/** Reason to refuse a shell command, or undefined. Best effort — see module doc. */
export function shellDenial(command: string, vaultDir?: string): string | undefined {
  for (const { re, reason } of SHELL_BLOCKS) {
    if (re.test(command)) return `BLOCKED: ${reason}. Stored credentials are used through {{secret:name}} references and trusted tools, never read.`;
  }
  if (vaultDir) {
    const lower = command.toLowerCase().replace(/\\\\/g, '\\');
    const variants = [vaultDir, vaultDir.replace(/\\/g, '/')].map(v => v.toLowerCase());
    if (variants.some(v => lower.includes(v))) {
      return 'BLOCKED: reading the credential vault directory. Stored credentials are used through references, never read.';
    }
  }
  return undefined;
}
