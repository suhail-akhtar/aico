/**
 * The vault's stages in the tool pipeline: a guard, and shell placeholders.
 *
 * **Guard (`vault`).** Deny-only, like every guard: AICO's file tools may not
 * touch the vault directory, and shell commands that obviously reach for key
 * material are refused (best effort — see guard.ts).
 *
 * **Placeholders (`vault:placeholders`).** An around-execute stage, so it runs
 * only after every guard has allowed the call. For `Bash`, each
 * `{{secret:name}}` is resolved through the broker — policy, then a person's
 * approval showing the exact command — and replaced by a reference to an
 * environment variable that exists only in that one child process. The value
 * never enters the command text, the call's arguments, the log, the stream or
 * a hook's input; only the variable name does. The stash is dropped when the
 * call ends however it ends.
 *
 * `Terminal` does not take placeholders: its shell outlives the call, so a
 * variable set for one command would be readable by every later one.
 *
 * @module vault/pipeline
 */

import type { ToolPipeline } from '../tools/pipeline.js';
import { detectShell, type ShellKind } from '../tools/shell-choice.js';
import { fileToolDenial, shellDenial, SHELL_TOOL_NAMES } from './guard.js';
import type { ApprovalPrompter } from './human.js';
import { getVault } from './index.js';
import { hasPlaceholders, parsePlaceholders, type PlaceholderRef } from './placeholders.js';
import { dropCallEnv, stashCallEnv } from './sink.js';
import { VaultError } from './types.js';

export interface VaultStageOptions {
  /** The run's directory, for resolving relative paths in file tool arguments. */
  cwd: () => string;
  sessionId?: string;
  /** Asked when no process-wide prompter is set (the terminal UI's permission dialog). */
  fallbackPrompter?: ApprovalPrompter;
}

type QuoteState = 'none' | 'single' | 'double';

/** POSIX quote state at each placeholder, so the variable reference is spliced in validly. */
function posixQuoteStates(command: string, refs: PlaceholderRef[]): QuoteState[] {
  const states: QuoteState[] = [];
  let state: QuoteState = 'none';
  let r = 0;
  for (let i = 0; i < command.length && r < refs.length; i++) {
    if (i === refs[r]!.start) { states.push(state); i = refs[r]!.end - 1; r++; continue; }
    const c = command[i];
    if (state !== 'single' && c === '\\') { i++; continue; }
    if (state === 'none' && c === "'") state = 'single';
    else if (state === 'single' && c === "'") state = 'none';
    else if (state === 'none' && c === '"') state = 'double';
    else if (state === 'double' && c === '"') state = 'none';
  }
  while (states.length < refs.length) states.push(state);
  return states;
}

function simpleQuoteStates(command: string, refs: PlaceholderRef[]): QuoteState[] {
  return refs.map(ref => {
    const before = command.slice(0, ref.start);
    const singles = (before.match(/'/g) ?? []).length;
    const doubles = (before.match(/"/g) ?? []).length;
    return doubles % 2 ? 'double' : singles % 2 ? 'single' : 'none';
  });
}

/** How to write a reference to variable `v` in this shell, in this quote state. */
export function envReference(kind: ShellKind, state: QuoteState, v: string): string {
  switch (kind) {
    case 'powershell':
      if (state === 'single') throw new VaultError('invalid', 'In PowerShell, put a {{secret:…}} reference inside double quotes or none, not single quotes.');
      return state === 'double' ? `$($env:${v})` : `$env:${v}`;
    case 'cmd':
      return `%${v}%`;
    default:
      return state === 'double' ? `\${${v}}` : state === 'single' ? `'"\${${v}}"'` : `"\${${v}}"`;
  }
}

/**
 * Rewrite a command's placeholders to environment references, resolving each
 * distinct reference once. Returns the new command and the environment.
 */
export async function bindShellPlaceholders(
  command: string,
  resolveValue: (ref: PlaceholderRef) => Promise<string>,
  kind: ShellKind,
): Promise<{ command: string; env: Record<string, string> }> {
  const refs = parsePlaceholders(command);
  const states = kind === 'posix' || kind === 'git-bash' ? posixQuoteStates(command, refs) : simpleQuoteStates(command, refs);
  const env: Record<string, string> = {};
  const varFor = new Map<string, string>();
  let out = '';
  let at = 0;
  for (let i = 0; i < refs.length; i++) {
    const ref = refs[i]!;
    const key = `${ref.name}.${ref.field ?? ''}`;
    let v = varFor.get(key);
    if (!v) {
      v = `AICO_SECRET_${varFor.size + 1}`;
      env[v] = await resolveValue(ref);
      varFor.set(key, v);
    }
    out += command.slice(at, ref.start) + envReference(kind, states[i]!, v);
    at = ref.end;
  }
  return { command: out + command.slice(at), env };
}

function argsContainPlaceholder(args: Record<string, unknown>): boolean {
  return Object.values(args).some(v => typeof v === 'string' && hasPlaceholders(v));
}

/** Install the guard and the placeholder stage. Idempotent by stage name. */
export function installVaultStages(pipeline: ToolPipeline, options: VaultStageOptions): void {
  const present = pipeline.describe();
  if (!present.guards.includes('vault')) {
    pipeline.onGuard('vault', (ctx) => {
      const vaultDir = getVault().dir;
      if (SHELL_TOOL_NAMES.has(ctx.name)) {
        const command = typeof ctx.arguments.command === 'string' ? ctx.arguments.command : '';
        const reason = command ? shellDenial(command, vaultDir) : undefined;
        return reason ? { kind: 'deny', reason } : { kind: 'abstain' };
      }
      const reason = fileToolDenial(ctx.name, ctx.arguments, vaultDir, options.cwd());
      return reason ? { kind: 'deny', reason } : { kind: 'abstain' };
    });
  }
  if (present.around.includes('vault:placeholders')) return;
  pipeline.onAroundExecute('vault:placeholders', async (ctx, next) => {
    if (ctx.name === 'Terminal' && argsContainPlaceholder(ctx.arguments)) {
      return {
        result: { error: 'Terminal does not substitute {{secret:…}} references: its shell outlives the command, so the '
          + 'value would stay readable. Use Bash for a command that needs a stored credential.' },
        isError: true,
      };
    }
    if (ctx.name !== 'Bash' || typeof ctx.arguments.command !== 'string' || !hasPlaceholders(ctx.arguments.command)) {
      return next();
    }
    const original = ctx.arguments.command;
    let bound: { command: string; env: Record<string, string> };
    try {
      bound = await bindShellPlaceholders(original, async (ref) => {
        const resolved = await getVault().resolve(ref.raw, {
          tool: 'Bash',
          purpose: `run this shell command: ${original}`,
          ...(options.sessionId ? { sessionId: options.sessionId } : {}),
        }, options.fallbackPrompter);
        try { return resolved.value(ref.field); } finally { resolved.release(); }
      }, detectShell().kind);
    } catch (err) {
      return { result: { error: err instanceof Error ? err.message : String(err) }, isError: true };
    }
    // A new object, never a mutation: the original arguments are what the log,
    // the stream and the pre-execute hook saw, and they must stay the version
    // with names in it.
    ctx.arguments = { ...ctx.arguments, command: bound.command };
    stashCallEnv(ctx.callId, bound.env);
    try {
      return await next();
    } finally {
      dropCallEnv(ctx.callId);
    }
  });
}
