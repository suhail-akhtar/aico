/**
 * The file tools may not write AICO's own configuration.
 *
 * WHY: the settings API asks a person before any change that weakens safety
 * (hooks, MCP servers, env, auto-approve, sandbox…). A `Write` or `Edit` of
 * `settings.json` — in the store or a project's `.aico/` — reached exactly
 * the same state with no person at all: a hook added that way runs a command
 * on every tool call from then on. The Sentinel escalates such writes when it
 * is active, but it is off in many runs, so it cannot be the only line
 * (security review 2026-10, "enforce in the loop, not in the prompt").
 *
 * What it does: a guard-stage helper that names the call as a denial unless a
 * person approved this exact call in this dispatch (`HUMAN_APPROVED`, set by
 * the Sentinel's escalation). It only ever denies.
 *
 * What it deliberately does not do: judge the user's projects inside the
 * store (`workspace/…`), memory or skills — those have their own managed
 * tools and are ordinary work. Shell writes to the same files are refused by
 * the shell classifier (`safety.ts`), not here.
 *
 * @module tools/config-write-guard
 */

import path from 'node:path';

/** Built-in tools that write a file named by their arguments. */
const FILE_WRITING_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

/** Files under a `.aico` directory (store or project) that configure AICO itself. */
const CONFIG_UNDER_AICO = /(?:^|\/)\.aico\/(?:settings(?:\.[\w-]+)?\.json$|hooks(?:\/|$)|tools(?:\/|$)|agents(?:\/|$)|trust\.json$|mcp\.json$)/i;
/** The same files relative to the store root, whatever the store is called. */
const CONFIG_IN_STORE = /^(?:settings(?:\.[\w-]+)?\.json$|hooks(?:\/|$)|tools(?:\/|$)|agents(?:\/|$)|trust\.json$|mcp\.json$)/i;

/** True when `file` (absolute or relative to `cwd`) is one of AICO's configuration files. */
export function isAicoConfigFile(file: string, home: string, cwd: string = process.cwd()): boolean {
  const abs = path.resolve(cwd, file);
  const fold = (p: string): string => (process.platform === 'win32' ? p.toLowerCase() : p).replace(/\\/g, '/');
  const f = fold(abs);
  if (CONFIG_UNDER_AICO.test(f)) return true;
  if (/(?:^|\/)\.mcp\.json$/i.test(f)) return true;
  const rel = path.relative(fold(path.resolve(home)), f).replace(/\\/g, '/');
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return false;
  return CONFIG_IN_STORE.test(rel);
}

/** The denial reason for a file-tool call that writes AICO configuration, or undefined. */
export function configWriteDenial(
  name: string, args: Record<string, unknown> | undefined, home: string, cwd?: string,
): string | undefined {
  if (!FILE_WRITING_TOOLS.has(name)) return undefined;
  const target = args?.file_path ?? args?.notebook_path ?? args?.path;
  if (typeof target !== 'string' || !target) return undefined;
  if (!isAicoConfigFile(target, home, cwd)) return undefined;
  return `Refused: ${path.basename(target)} is AICO's own configuration (settings, hooks, tools, agents or trust). `
    + 'The file tools may not change it without a person approving this exact call. Ask the user to make the '
    + 'change in Settings (which shows them what weakens safety), and say exactly what to change.';
}
