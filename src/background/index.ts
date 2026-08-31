import { randomUUID } from 'crypto';
import { NO_ONE_TO_ASK } from '../tools/askuser.js';
import { runHooks } from '../hooks.js';
import { pushNotification } from './notifications.js';
import type { AicoSettings } from '../settings.js';
import type { SubAgentType } from '../tools/index.js';

export interface BackgroundAgentRecord {
  agentId: string;
  description: string;
  model: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  statusMessage: string;
  startedAt: number;
  completedAt?: number;
  result?: string;
  error?: string;
  toolCallCount: number;
  lastActivityAt: number;
  currentTool?: string;
  /** Whether the completion notification has been pushed */
  notified: boolean;
  /**
   * Cumulative token usage, the same four counters a sub-agent keeps.
   *
   * Added because a background agent that reported no spend could not be given
   * a spend ceiling — the supervisor compared a limit against a cost of zero
   * and never fired. That mattered most for the case with the least oversight:
   * work submitted over MCP by another process, which is bounded by a
   * `maxCostUsd` that was silently unenforceable until these existed.
   */
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  cacheWriteTokens: number;
}

const _bgRegistry = new Map<string, BackgroundAgentRecord>();
const _bgAbortControllers = new Map<string, AbortController>();
const _subscribers: Array<(records: BackgroundAgentRecord[]) => void> = [];

function isTerminal(status: BackgroundAgentRecord['status']): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

function _emit(): void {
  const records = Array.from(_bgRegistry.values());
  for (const fn of _subscribers) fn(records);
}

export function subscribeToBackgroundAgents(
  fn: (records: BackgroundAgentRecord[]) => void,
): () => void {
  _subscribers.push(fn);
  fn(Array.from(_bgRegistry.values()));
  return () => {
    const idx = _subscribers.indexOf(fn);
    if (idx !== -1) _subscribers.splice(idx, 1);
  };
}

export function getBackgroundAgents(): BackgroundAgentRecord[] {
  return Array.from(_bgRegistry.values());
}

/** Cancel a queued/running background agent. Returns true if the agent existed. */
export function cancelBackgroundAgent(agentId: string): boolean {
  const rec = _bgRegistry.get(agentId);
  if (!rec) return false;
  if (rec.status === 'queued' || rec.status === 'running') {
    _bgAbortControllers.get(agentId)?.abort();
    _bgAbortControllers.delete(agentId);
    rec.status = 'cancelled';
    rec.statusMessage = 'Cancelled by user';
    rec.completedAt = Date.now();
    rec.currentTool = undefined;
    _emit();
  }
  return true;
}

/**
 * What a background agent may do without anyone to ask.
 *
 * - `inherit` — follow the user's own `autoApprove`. Right for work the user
 *   started themselves: a cron job they wrote, a `Task` they delegated.
 * - `readonly` — refuse every tool that needs permission. The posture for work
 *   arriving from outside, where "the user ticked auto-approve for their own
 *   interactive session" is not consent for an unattended process to run shell
 *   commands.
 * - `full` — approve everything, regardless of `autoApprove`. Explicit opt-in.
 */
export type BackgroundPermissions = 'inherit' | 'readonly' | 'full';

/** Tools that do something irreversible and therefore need a decision. */
const GATED_TOOLS = new Set([
  'Bash', 'Write', 'Edit', 'MultiEdit', 'McpAddServer', 'McpRemoveServer',
  'McpReloadServers', 'WorkspaceSetPath', 'WorkspaceWrite', 'AgentCreate',
]);

/**
 * Decide a permission with no human present.
 *
 * This exists because the fallback did not. With no `onPermissionRequest`,
 * `runAgent` calls `checkPermission`, which writes the prompt to
 * `process.stdout` and then blocks reading `stdin`. For a background agent
 * there is nobody at either end:
 *
 *   - under `aico serve`, the prompt lands in a terminal nobody is watching and
 *     the job waits until its idle timeout kills it;
 *   - under `aico mcp-serve`, stdout **is** the JSON-RPC stream, so the prompt
 *     corrupts it and the read then eats the client's own messages as an answer.
 *
 * A reproduction confirmed both: a submitted job asked to write one file never
 * returned at all. So the decision is made from policy here, and it is always a
 * decision — never a question.
 *
 * The denial text matters as much as the denial. A model told "denied: this job
 * may not write files" can say so in its result; a model that never gets a
 * reply produces nothing at all.
 */
export function decideHeadlessPermission(
  toolName: string,
  permissions: BackgroundPermissions,
  autoApprove: boolean,
): { allowed: boolean; reason?: string } {
  if (!GATED_TOOLS.has(toolName)) return { allowed: true };
  if (permissions === 'full') return { allowed: true };
  if (permissions === 'readonly') {
    return {
      allowed: false,
      reason: `Denied: ${toolName} is not available to this job. It was started from `
        + 'outside this machine\'s session and runs read-only. Report what you found '
        + 'and what you would have changed, rather than trying another way to change it.',
    };
  }
  if (autoApprove) return { allowed: true };
  return {
    allowed: false,
    reason: `Denied: ${toolName} needs approval and there is nobody to ask — this job is `
      + 'running in the background. Report what you would have done. To let background '
      + 'work make changes, set "autoApprove": true in settings.',
  };
}

export interface SpawnBackgroundAgentOptions {
  /** See {@link BackgroundPermissions}. Defaults to `inherit`. */
  permissions?: BackgroundPermissions;
  token: string;
  model: string;
  autoApprove: boolean;
  verbose: boolean;
  settings?: AicoSettings;
  agentType?: SubAgentType;
  cwd?: string;
}

/**
 * Spawn a background agent — fire and forget.
 * Returns the agentId immediately; the agent runs asynchronously.
 */
export function spawnBackgroundAgent(
  args: { description: string; prompt: string; model?: string },
  opts: SpawnBackgroundAgentOptions,
): string {
  const agentId = randomUUID();
  const model = args.model ?? opts.model;
  const abortController = new AbortController();

  const rec: BackgroundAgentRecord = {
    agentId,
    description: args.description,
    model,
    status: 'queued',
    statusMessage: 'Queued',
    startedAt: Date.now(),
    toolCallCount: 0,
    lastActivityAt: Date.now(),
    notified: false,
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: 0,
    cacheWriteTokens: 0,
  };

  _bgRegistry.set(agentId, rec);
  _bgAbortControllers.set(agentId, abortController);
  _emit();

  // Fire-and-forget — use dynamic import to avoid circular dep
  void (async () => {
    try {
      rec.status = 'running';
      rec.statusMessage = 'Running';
      rec.lastActivityAt = Date.now();
      _emit();

      // BackgroundAgentStart hook
      if (opts.settings) {
        await runHooks(
          'BackgroundAgentStart',
          {
            event: 'BackgroundAgentStart',
            agentId,
            agentDescription: args.description,
          },
          opts.settings,
        );
      }

      const { runAgent } = await import('../agent.js');

      let lastActivity = Date.now();
      const idleTimeoutMs = opts.settings?.agentTimeout && opts.settings.agentTimeout > 0
        ? opts.settings.agentTimeout
        : 120_000;
      const absoluteMaxMs = Math.max(idleTimeoutMs * 3, 600_000);

      const agentPromise = runAgent({
        /*
          Run where the job said to run.

          `opts.cwd` was declared on this options type and never forwarded, so
          every background agent — and therefore every cron job — ran in the
          *server's* working directory. A nightly job pointed at a repository
          wrote its files somewhere else entirely and looked, from that
          repository, as though it had done nothing at all. A live probe caught
          it: the file the job was asked to create appeared in aico's own
          checkout instead of the job's directory.

          Passing it here rather than wrapping the call in `runInContext` is the
          fix that works: `runAgent` establishes its own context from this very
          field, defaulting to `process.cwd()`, so an outer context is simply
          overwritten. That was the first attempt, and the probe caught that too.
        */
        cwd: opts.cwd,
        task: args.prompt,
        token: opts.token,
        model,
        showPlan: false,
        /*
          `runAgent`'s permission guard short-circuits on `autoApprove` *before*
          it consults the callback, so a readonly job under a user with
          auto-approval on would have sailed straight past its own restriction.
          The flag is therefore derived from the posture rather than passed
          through: readonly forces the callback to run, full skips it, and
          inherit behaves exactly as it always did.
        */
        autoApprove: (opts.permissions ?? 'inherit') === 'readonly' ? false
          : (opts.permissions === 'full' ? true : opts.autoApprove),
        verbose: opts.verbose,
        conversationHistory: [],
        settings: opts.settings,
        silent: true,
        // No human is attached to this run. Declared rather than inferred: a
        // global askUser callback may well be registered by the web server
        // while this particular run is a 3am cron firing, and routing its
        // question to a browser tab nobody has open is a hang wearing a
        // different hat.
        headless: true,
        onAskUser: async (question: string) => {
          const r = _bgRegistry.get(agentId);
          if (r && !isTerminal(r.status)) {
            r.statusMessage = 'Asked a question with nobody to answer';
            _emit();
          }
          return `${NO_ONE_TO_ASK}

(You asked: ${question})`;
        },
        agentType: opts.agentType,
        abortSignal: abortController.signal,
        onToolCall: (name) => {
          const r = _bgRegistry.get(agentId);
          if (r && !isTerminal(r.status)) {
            lastActivity = Date.now();
            r.currentTool = name;
            r.toolCallCount++;
            r.statusMessage = `${name}…`;
            r.lastActivityAt = lastActivity;
            _emit();
          }
        },
        onToolDone: () => {
          const r = _bgRegistry.get(agentId);
          if (r && !isTerminal(r.status)) {
            lastActivity = Date.now();
            r.currentTool = undefined;
            r.statusMessage = 'Working…';
            r.lastActivityAt = lastActivity;
            _emit();
          }
        },
        onChunk: (text) => {
          const r = _bgRegistry.get(agentId);
          if (r && !isTerminal(r.status)) {
            lastActivity = Date.now();
            r.statusMessage = text.trim() ? 'Responding…' : 'Thinking…';
            r.lastActivityAt = lastActivity;
            _emit();
          }
        },
        // Accumulated across API calls, matching the sub-agent registry: the
        // provider reports totals for the call that just finished, and an agent
        // makes many. Emitting keeps the ledger mirror's cost current, which is
        // what a spend ceiling is compared against.
        // Always supplied, even when `autoApprove` would short-circuit it —
        // supplying it is what keeps `runAgent` from ever reaching the
        // interactive fallback. See decideHeadlessPermission.
        onPermissionRequest: async (toolName) => {
          const verdict = decideHeadlessPermission(
            toolName, opts.permissions ?? 'inherit', opts.autoApprove,
          );
          if (!verdict.allowed) {
            const r = _bgRegistry.get(agentId);
            if (r && !isTerminal(r.status)) {
              r.statusMessage = `Denied ${toolName}`;
              _emit();
            }
          }
          return verdict.allowed;
        },
        onTokens: (input, output, cached, cacheWrite) => {
          const r = _bgRegistry.get(agentId);
          if (r && !isTerminal(r.status)) {
            r.inputTokens += input;
            r.outputTokens += output;
            r.cachedTokens += cached;
            r.cacheWriteTokens += cacheWrite;
            _emit();
          }
        },
      });

      const heartbeatPromise = new Promise<never>((_, reject) => {
        const timer = setInterval(() => {
          const r = _bgRegistry.get(agentId);
          if (!r || r.status === 'cancelled' || r.status === 'completed' || r.status === 'failed') {
            clearInterval(timer);
            return;
          }

          const idleMs = Date.now() - lastActivity;
          const totalMs = Date.now() - r.startedAt;
          if (idleMs > idleTimeoutMs) {
            abortController.abort();
            clearInterval(timer);
            reject(new Error(
              `Background agent idle for ${Math.round(idleMs / 1000)}s with no progress. ` +
              `${r.toolCallCount} tool call(s), runtime ${Math.round(totalMs / 1000)}s.`,
            ));
          } else if (totalMs > absoluteMaxMs) {
            abortController.abort();
            clearInterval(timer);
            reject(new Error(
              `Background agent exceeded maximum runtime (${Math.round(absoluteMaxMs / 1000)}s). ` +
              `${r.toolCallCount} tool call(s), last progress ${Math.round(idleMs / 1000)}s ago.`,
            ));
          }
        }, 5_000);

        agentPromise.then(() => clearInterval(timer), () => clearInterval(timer));
      });

      const result = await Promise.race([agentPromise, heartbeatPromise]);

      // Check if cancelled mid-run
      const currentRec = _bgRegistry.get(agentId);
      if (currentRec?.status === 'cancelled') return;

      if (currentRec) {
        currentRec.status = 'completed';
        currentRec.statusMessage = 'Completed';
        currentRec.result = result;
        currentRec.completedAt = Date.now();
        currentRec.currentTool = undefined;
        _emit();

        // Push notification
        pushNotification({
          title: `Agent done: ${args.description.slice(0, 50)}`,
          body: result?.slice(0, 200) ?? 'Task completed.',
          level: 'success',
          sourceId: agentId,
        });
        currentRec.notified = true;
        _emit();
      }
      _bgAbortControllers.delete(agentId);
      // Auto-clear completed background agents after 60s
      setTimeout(() => { _bgRegistry.delete(agentId); _emit(); }, 60_000);

      // BackgroundAgentComplete hook
      if (opts.settings) {
        await runHooks(
          'BackgroundAgentComplete',
          { event: 'BackgroundAgentComplete', agentId, agentDescription: args.description },
          opts.settings,
        );
      }
    } catch (err) {
      _bgAbortControllers.delete(agentId);
      const r = _bgRegistry.get(agentId);
      if (r && r.status !== 'cancelled') {
        r.status = 'failed';
        r.error = err instanceof Error ? err.message : String(err);
        r.statusMessage = `Failed: ${r.error.slice(0, 80)}`;
        r.completedAt = Date.now();
        r.currentTool = undefined;

        pushNotification({
          title: `Agent failed: ${args.description.slice(0, 50)}`,
          body: r.error,
          level: 'error',
          sourceId: agentId,
        });
        r.notified = true;
        _emit();
        // Auto-clear failed background agents after 60s
        setTimeout(() => { _bgRegistry.delete(agentId); _emit(); }, 60_000);
      }

      if (opts.settings) {
        await runHooks(
          'BackgroundAgentFailed',
          { event: 'BackgroundAgentFailed', agentId, agentDescription: args.description },
          opts.settings,
        ).catch(() => {});
      }
    }
  })();

  return agentId;
}

// ── Runtime opts store (set at startup) ──────────────────────────────
let _bgOpts: SpawnBackgroundAgentOptions | null = null;

export function setBackgroundAgentOpts(opts: SpawnBackgroundAgentOptions): void {
  _bgOpts = opts;
}

export function getBackgroundAgentOpts(): SpawnBackgroundAgentOptions | null {
  return _bgOpts;
}

export const backgroundTaskToolDefinition = {
  name: 'BackgroundTask',
  description:
    'Spawn a background agent that runs asynchronously without blocking the current conversation. ' +
    'Returns immediately with an agentId. Use this for long-running tasks (analysis, bulk edits, ' +
    'research) that should not interrupt the current interaction.',
  inputSchema: {
    type: 'object',
    properties: {
      description: {
        type: 'string',
        description: 'Short human-readable description of what the agent will do (shown in UI)',
      },
      prompt: {
        type: 'string',
        description: 'Full task prompt for the background agent',
      },
      model: {
        type: 'string',
        description: 'Model override (optional — defaults to current session model)',
      },
    },
    required: ['description', 'prompt'],
  },
};
