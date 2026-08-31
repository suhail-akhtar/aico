import { randomUUID } from 'crypto';
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

export interface SpawnBackgroundAgentOptions {
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
        task: args.prompt,
        token: opts.token,
        model,
        showPlan: false,
        autoApprove: opts.autoApprove,
        verbose: opts.verbose,
        conversationHistory: [],
        settings: opts.settings,
        silent: true,
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
