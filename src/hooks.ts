import { exec } from 'child_process';
import { promisify } from 'util';
import type { AicoSettings } from './settings.js';

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

const execAsync = promisify(exec);

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

/**
 * Run hooks for a given event.
 *
 * Exit code semantics:
 * - 0: pass (continue)
 * - 2: block (abort the action — only meaningful for PreToolUse)
 * - Other non-zero: ignored (hook failure doesn't abort flow)
 */
export async function runHooks(
  event: HookEvent,
  ctx: HookContext,
  settings: AicoSettings,
): Promise<HookResult> {
  const hooks = getHooks(settings);
  const commands = hooks?.[event as keyof typeof hooks] as string[] | undefined;
  if (!commands || commands.length === 0) return undefined;

  const envOverride: Record<string, string> = {
    AICO_EVENT: event,
    AICO_HOOK_CONTEXT: JSON.stringify(ctx),
    ...(ctx.toolName ? { AICO_TOOL_NAME: ctx.toolName } : {}),
    ...(ctx.userPrompt ? { AICO_USER_PROMPT: ctx.userPrompt } : {}),
    ...(ctx.toolArgs ? { AICO_TOOL_ARGS: JSON.stringify(ctx.toolArgs) } : {}),
    ...(ctx.toolResult ? { AICO_TOOL_RESULT: JSON.stringify(ctx.toolResult) } : {}),
    ...(ctx.agentId ? { AICO_AGENT_ID: ctx.agentId } : {}),
    ...(ctx.agentType ? { AICO_AGENT_TYPE: ctx.agentType } : {}),
    ...(ctx.agentDescription ? { AICO_AGENT_DESCRIPTION: ctx.agentDescription } : {}),
    ...(ctx.notificationTitle ? { AICO_NOTIFICATION_TITLE: ctx.notificationTitle } : {}),
    ...(ctx.notificationBody ? { AICO_NOTIFICATION_BODY: ctx.notificationBody } : {}),
    ...(ctx.notificationLevel ? { AICO_NOTIFICATION_LEVEL: ctx.notificationLevel } : {}),
    ...(ctx.exitCode !== undefined ? { AICO_EXIT_CODE: String(ctx.exitCode) } : {}),
  };

  for (const cmd of commands) {
    try {
      await execAsync(cmd, {
        cwd: process.cwd(),
        env: { ...process.env, ...envOverride },
        timeout: 10000,
      });
    } catch (err: unknown) {
      // Exit code 2 = block the action (only meaningful for PreToolUse)
      const e = err as { code?: number };
      if (e.code === 2 && event === 'PreToolUse') {
        return 'block';
      }
      // Other failures silently ignored — hooks should not abort the main flow
    }
  }

  return undefined;
}
