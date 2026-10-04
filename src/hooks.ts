import { spawn } from 'child_process';
import type { AicoSettings } from './settings.js';
import { sinkRedact } from './vault/sink.js';

export type HookEvent =
  | 'PreToolUse'
  | 'PostToolUse'
  | 'UserPromptSubmit'
  | 'Stop'
  | 'SessionStart'
  | 'PreCompact'
  | 'PostCompact'
  | 'SubagentStart'
  | 'SubagentStop'
  | 'BackgroundAgentStart'
  | 'BackgroundAgentComplete'
  | 'BackgroundAgentFailed'
  | 'CronJobStart'
  | 'CronJobComplete'
  | 'CronJobFailed'
  | 'SessionEnd'
  | 'Notification';

export interface HookContext {
  event: HookEvent;
  toolName?: string;
  toolArgs?: Record<string, unknown>;
  toolResult?: unknown;
  userPrompt?: string;
  /** Sub-agent context fields */
  agentId?: string;
  agentType?: string;
  agentDescription?: string;
  notificationTitle?: string;
  notificationBody?: string;
  notificationLevel?: string;
  exitCode?: number;
}

/** Hook return value: undefined = pass, 'block' = abort the action */
export type HookResult = undefined | 'block';

/** Frozen hook snapshot — set at startup, never modified during session */
let _frozenHooks: AicoSettings['hooks'] | undefined;

/** Freeze hooks at startup — prevents post-trust modifications */
export function freezeHooks(settings: AicoSettings): void {
  if (settings.hooks) {
    _frozenHooks = JSON.parse(JSON.stringify(settings.hooks));
  }
}

/**
 * Clear the frozen snapshot so hooks come from settings again.
 *
 * `freezeHooks` deliberately ignores a settings object with no `hooks` key, so
 * before this existed there was no way to clear or change a frozen snapshot for
 * the life of the process: a hook set once applied to everything afterwards.
 * That made hooks untestable — one test's blocking hook silently applied to
 * every later run — and meant a settings reload could never take effect.
 */
export function resetHooks(): void {
  _frozenHooks = undefined;
}

/** Get active hooks (frozen if available, otherwise from settings) */
function getHooks(settings: AicoSettings): AicoSettings['hooks'] {
  return _frozenHooks ?? settings.hooks;
}

/** A shell saying it could not find or start the hook's command. */
const NOT_FOUND = /is not recognized as an internal or external command|command not found|No such file or directory|cannot find the path|not found/i;

/** How long one hook may run before it is treated as failed. */
const HOOK_TIMEOUT_MS = 10_000;

/**
 * Run one hook command with the context on stdin.
 *
 * The context (tool arguments, results, the user's prompt) goes on stdin, not
 * in the environment: an environment variable is inherited by everything the
 * hook starts and is readable from other processes, and tool arguments are
 * exactly what should not travel that far. Only scalar names stay in env.
 *
 * Resolves to the exit code, or `'failed'` when the hook could not be run to
 * completion at all (spawn error, timeout, or the shell could not find or run
 * the command — 126/127).
 */
function runOneHook(cmd: string, env: Record<string, string>, input: string): Promise<number | 'failed'> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v: number | 'failed'): void => { if (!settled) { settled = true; clearTimeout(timer); resolve(v); } };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(cmd, { cwd: process.cwd(), env: { ...process.env, ...env }, shell: true, stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true });
    } catch {
      resolve('failed');
      return;
    }
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* best effort: it is being abandoned either way */ }
      done('failed');
    }, HOOK_TIMEOUT_MS);
    child.on('error', () => done('failed'));
    // The shell's own "no such command" (POSIX 127, cmd.exe exit 1 with its
    // message) is a hook that never ran, not a hook that answered.
    let stderr = '';
    child.stderr?.on('data', (d: Buffer) => { if (stderr.length < 4096) stderr += d.toString(); });
    child.on('close', (code) => done(
      code === null || code === 126 || code === 127
        || (code !== 0 && code !== 2 && NOT_FOUND.test(stderr)) ? 'failed' : code,
    ));
    // A hook that never reads stdin closes it early; that is not a failure.
    child.stdin?.on('error', () => { /* harmless: the hook did not want its input */ });
    child.stdin?.end(input);
  });
}

/**
 * Run hooks for a given event.
 *
 * Exit code semantics:
 * - 0: pass (continue)
 * - 2: block (abort the action — only meaningful for PreToolUse)
 * - Other non-zero: ignored (hook failure doesn't abort flow)
 *
 * A PreToolUse hook that could not run to completion — it timed out, could not
 * be spawned, or its command was not found — BLOCKS the call. A PreToolUse hook
 * is a guard the user installed; a guard that silently passes whenever it
 * breaks is no guard (security review 2026-10). Other events still pass.
 */
export async function runHooks(
  event: HookEvent,
  ctx: HookContext,
  settings: AicoSettings,
): Promise<HookResult> {
  const hooks = getHooks(settings);
  const commands = hooks?.[event as keyof typeof hooks] as string[] | undefined;
  if (!commands || commands.length === 0) return undefined;
  // Hook commands are user scripts that log freely; they get what the model
  // would get, never a vault value. See vault/sink.
  ctx = sinkRedact(ctx);

  // Names only. The payload (arguments, result, prompt) is on stdin as JSON.
  const envOverride: Record<string, string> = {
    AICO_EVENT: event,
    ...(ctx.toolName ? { AICO_TOOL_NAME: ctx.toolName } : {}),
    ...(ctx.agentId ? { AICO_AGENT_ID: ctx.agentId } : {}),
    ...(ctx.agentType ? { AICO_AGENT_TYPE: ctx.agentType } : {}),
    ...(ctx.notificationLevel ? { AICO_NOTIFICATION_LEVEL: ctx.notificationLevel } : {}),
    ...(ctx.exitCode !== undefined ? { AICO_EXIT_CODE: String(ctx.exitCode) } : {}),
  };
  const input = JSON.stringify(ctx);

  for (const cmd of commands) {
    const code = await runOneHook(cmd, envOverride, input);
    if (event === 'PreToolUse' && (code === 2 || code === 'failed')) return 'block';
    // Other failures ignored — a non-guard hook should not abort the main flow
  }

  return undefined;
}

