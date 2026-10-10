import path from 'path';
import fs from 'fs';
import chalk from 'chalk';
import { buildSystemPrompt, buildVolatileContext } from './prompts.js';
import { PromptDocument, renderPrompt, renderTail, DEFAULT_DIALECT } from './prompt/index.js';
import { spillResult } from './tools/spill.js';
import { toolDefinitions, executeTool, setBashDefaultTimeout, getToolsForAgent, getToolsForSpec, truncateResult, agentTypeGetsAllTools, type SubAgentType } from './tools/index.js';
import {
  LOAD_TOOLS, executeLoadTools, groupsForRequest, groupsLoadedBy, isDeferred, loadToolsDefinition, loadedGroupsFromLog, type ToolGroup,
} from './tools/deferred.js';
import { installCustomToolGuards, taints, ttyAsk, type CustomToolStageOptions } from './custom-tools/policy.js';
import { groupIdOf, loadCustomTools, usableTools } from './custom-tools/store.js';
import { runCustomTool } from './custom-tools/runner.js';
import { DEFAULT_MAX_CHARS, providerSchema } from './custom-tools/format.js';
import { minLevel, type AutonomyLevel } from './autonomy/levels.js';
import { parkAction, type ActionOrigin } from './autonomy/inbox.js';
import { taskToolDefinition, runTask, agentResumeSpec } from './tools/task.js';
import { rememberSessionInbox } from './agents/report-back.js';
import { mcpRegistry } from './mcp.js';
import { checkPermission } from './permissions.js';
import { classifyBashCommand, isBashReadOnly, shellCommandOf } from './safety.js';
import { createShellConfinement, SHELL_CONFINEMENT_SHOWN, type ShellConfinement } from './tools/shell-confinement-guard.js';
import { createSupplyChain } from './tools/supply-chain-guard.js';
import { installChangeSafetyGuards } from './tools/change-safety-guard.js';
import { changeSafetyGate, resetChangeSafety } from './security/change-safety.js';
import { runFindingSink } from './security/finding.js';
import { canAskUser, setAskUserCallback } from './tools/askuser.js';
import { asksPermissionToContinue, CONTINUE_NUDGE, wantsCheckIns } from './continue-gate.js';
import { getOpenTodoCount, pendingTodoLines, readTodos, todoChecklist } from './tools/todo.js';
import {
  showToolCall,
  showToolResult,
  showAssistantMessage,
  showError,
  startSpinner,
  stopSpinner,
} from './ui.js';
import { runHooks } from './hooks.js';
import { estimateTokens } from './tokens.js';
import type { SdkAttachment } from './attachments.js';
import type { AicoMessage, ImagePart, ImageRef } from './providers/types.js';
import type { MessageSource, UserAttachment } from './session/events.js';
import { modelAccepts, explainRefusal } from './model-capabilities.js';
import {
  createToolImageSink, drainToolImages, toolImagesMessage, withToolCall, type ToolImageBytes,
} from './tools/tool-images.js';
import type { AicoSettings } from './settings.js';
import { selectProvider } from './providers/index.js';
import { detectProviderType } from './providers/index.js';
import { ensureContextWindow, getContextWindow } from './context-window.js';
import { resolveInstance } from './providers/instances.js';
import type { ToolDef, ToolCall, FinishReason, ReasoningTrace } from './providers/types.js';
import type { Inbox, Session, TurnEndReason, Usage } from './session/index.js';
import { canonicalHeader } from './session/index.js';
import { sessionLogHandle } from './session/log-handle.js';
import { sectionHashes } from './prompt/render.js';
import { projectRoot } from './run-context.js';
import type { PromptSection } from './prompt/types.js';
import { LegacyTranscript, SessionTranscript, type Transcript } from './session/transcript.js';
import { ContextManager, HANDOFF_INSTRUCTION } from './session/context-manager.js';
import { ToolPipeline, type AdditionalContext, type ToolCallContext } from './tools/pipeline.js';
import { RepeatToolGuard } from './tools/repeat-guard.js';
import { resolveMaxParallel, scheduleToolCalls, type ExecutionMode } from './tools/scheduler.js';
import type { Context, ToolRegistryCapability } from './registry/index.js';
import { LocalSandbox, installSandboxGuard, resolveSandboxPolicy } from './sandbox/index.js';
import type { ToolDefinition } from './tools/index.js';

/** Recorded as the result of a call cancelled before it was dispatched. */
const TOOL_ABORTED_BEFORE_DISPATCH =
  'Error: tool call aborted before dispatch (the step was cancelled).';

/**
 * Largest sub-agent report returned into the parent's context, in characters.
 *
 * About ten thousand tokens: room for a thorough report with its evidence,
 * while a child that dumps everything it read cannot crowd out the parent's
 * own work. Anything past it is kept on disk and named in the excerpt.
 */
const SUBAGENT_RESULT_MAX_CHARS = 40_000;

/**
 * Whether a tool may overlap with others in the same step.
 *
 * Unknown names — MCP tools, dynamically registered ones — are treated as
 * exclusive. Guessing "parallel" for a tool whose side effects are unknown
 * risks two of them clobbering the same file; guessing "exclusive" only costs
 * throughput.
 */
function getExecutionMode(name: string): ExecutionMode {
  const def = toolDefinitions.find(d => d.name === name);
  if (def !== undefined) return def.isConcurrencySafe ? 'parallel' : 'exclusive';
  // The Task tool is not in `toolDefinitions` (it is added per-run), and its own
  // description promises the model that parallel Task calls run concurrently.
  if (name === taskToolDefinition.name) return 'parallel';
  // Read-only workers touching nothing shared — that is the property that makes
  // a fan-out safe, and it holds just as well when two fan-outs overlap.
  if (name === investigateDefinition.name) return 'parallel';
  return 'exclusive';
}
import { getWorkspaceInfo, setWorkspaceRuntime } from './workspace.js';
import { currentRunContext, markTainted, runInContext, type HostBridge, type HandOffBridge } from './run-context.js';
import { isHostTool } from '../shared/host-tools.js';
import { HANDOFF_TOOL } from '../shared/chat-handoff.js';
import type { FileWriter } from './tools/file-writer.js';
import { isEffortChoice } from '../shared/reasoning.js';
import { buildRuntimeBlocks } from './capabilities.js';
import { renderRunningWork } from './work/projection.js';
import { noteWindowFromError, noteWindowFromUsage } from './context-window.js';
import { listAgentSpecs } from './agents/registry.js';
import { skillRegistry } from './skills/index.js';
import { cronScheduler } from './cron/scheduler.js';
import { getBackgroundAgents } from './background/index.js';
import { getAgentRegistry } from './tools/task.js';
import { investigate, investigateDefinition, type InvestigateInput } from './tools/investigate.js';
import { checkVerificationGate, resetVerification } from './verification.js';
import { setBrief } from './requirements.js';
import { checkProjectGate, resetChecks, testCheckFailedThisTurn, touchedFiles, writtenFiles } from './checks.js';
import { appCommitGate } from './apps/app-git.js';
import { gateChecks } from './tools/run-checks.js';
import { loadProfile, renderProfile } from './project/profile.js';
import { installProfileObserver } from './project/observe.js';
import { skillCatalogue, skillsToSuggest } from './tools/skill.js';
import { loadKnowledge } from './knowledge/store.js';
import { beginCheckpoint, commitCheckpoint, recordedBefore } from './checkpoint/index.js';
import { checkpointDir } from './tools/checkpoint.js';
import { matchKnowledge, renderKnowledge } from './knowledge/match.js';
import { preferencesForTask } from './learning/preferences.js';
import { activeMemories } from './memory/store.js';
import { splitMemories, recalledMemoryBlock } from './recall/inject.js';
import { embedderFromSettings } from './recall/embed.js';
import { currentCwd } from './run-context.js';
import { resetObservations } from './tools/observation.js';
import { flushQueuedEditNotes, hasQueuedEditNotes, resetEditNotes } from './codegraph/edit-note.js';
import { sinkRedact, sinkRedactText } from './vault/sink.js';
import { guardAgentRun } from './vault/agent-hooks.js';
import { installVaultStages } from './vault/pipeline.js';
import { callbackPrompter, ttyPrompter } from './vault/human.js';
import { installOpsStages } from './tools/ops/index.js';
import {
  agentExtraLayers, entryMatches, layerFor, narrowScope, scopeAllows, scopeDenial, type ToolAllow, type ToolScope,
} from './agents/effective.js';
import { applyAutonomyCeiling, ceilingLevel, requestedLevel } from './agents/ceiling.js';
import { installWritePathsGuard } from './agents/paths-guard.js';
import { installCleanroomWall } from './cleanroom/wall.js';
import { parseLevel } from './autonomy/levels.js';
import { PolicyError, createPolicyGuard, dayBudgetCap, dayBudgetRefusal, policyAllowsTool, runRefusal, withPolicyCeiling } from './policy/enforce.js';
import { engineVersion } from './policy/managed.js';
import { toolRequiresPermission } from './permissions.js';
import { isMcpToolName, isReadOnlyMcpTool, parseMcpToolName } from './mcp/policy.js';
import { activeJob, isLongEstimate, pendingJob, propose, proposalResult, subAgentMaxMs } from './longjob/index.js';
import { deliveryRunDenial, isDeliveryWorktree } from './delivery/paths.js';
import { longJobDefinition, longJobTool } from './tools/long-job.js';
import { proposePlan, type PlanInput } from './tools/plan.js';
import {
  defaultSentinelModel, HUMAN_APPROVED, installSentinel, mergeRequests, recentCallsOf, sentinelActive, sentinelParker, untrustedSourcesOf, userRequestsOf,
} from './sentinel/index.js';
import { configWriteDenial } from './tools/config-write-guard.js';
import { aicoHome } from './home.js';
import { recordRoleSpend, resolveRole } from './models/roles.js';
import { costFor } from './tokens.js';
import { describedImageNote, describeImagesWith, visionDescriber, type ImageDescriber } from './models/vision.js';

/**
 * A built-in that only reads: never asked about under an autonomy ceiling
 * (agents/ceiling). An explicit list, not "absent from the permission list" —
 * that list predates MultiEdit, Terminal, Git and others, and reading it as
 * "read-only" would wave writers through at L1.
 */
export function isReadOnlyBuiltin(name: string): boolean {
  if (name === 'ProposePlan' || toolRequiresPermission(name)) return false;
  return PLAN_MODE_TOOLS.has(name) || CEILING_READ_TOOLS.has(name);
}
/** The read-only built-ins by name: what a `delegate: readonly` child is limited to. */
function readOnlyBuiltinNames(): Set<string> {
  return new Set(toolDefinitions.map(d => d.name).filter(isReadOnlyBuiltin));
}
const CEILING_READ_TOOLS = new Set([
  'TodoRead', 'TodoWrite', 'Skill', 'LoadTools', 'WidgetSpec', 'WorkspaceInfo', 'WorkspaceRead', 'WorkspaceList',
  'ReadAttachment', 'ListMcpResources', 'ReadMcpResource', 'CapabilityReport', 'AgentList', 'AgentRead',
  'CredentialList', 'DependencyAudit',
]);

// Increase max listeners to avoid warnings during long tool chains
process.setMaxListeners(50);

// ── Retry helpers ────────────────────────────────────────────────────

export function isRetryableError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  const lower = msg.toLowerCase();
  // Cancellation / wall-clock timeout are terminal — never retry. These surface
  // as abort errors from the merged abort controller below.
  if (lower.includes('cancelled') || lower.includes('aborted')) return false;
  // "Provider returned error" = OpenRouter forwarding an upstream model error.
  // Always retry — this is transient model availability, not a malformed request.
  if (lower.includes('provider returned error')) return true;
  if (/\b429\b/.test(msg)) return true;
  // Other 4xx are bad-request errors caused by our payload — never retryable.
  if (/\b4[0-8][0-9]\b/.test(msg) || /\b490\b/.test(msg)) return false;
  const retryable = [
    'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE', 'EAI_AGAIN', 'ECONNABORTED',
    'socket hang up', 'network',
    // A stream the gateway dropped mid-response. Node reports it as
    // "Premature close" (undici: "terminated", "other side closed"); a GLM
    // build ended a two-hour turn on one, with the step half-written and
    // nothing wrong with the request.
    'premature close', 'terminated', 'other side closed', 'fetch failed',
    // The OpenAI SDK's APIConnectionError, which every OpenAI-compatible
    // provider throws when the socket fails: its message is exactly
    // "Connection error." and carries no status. A GLM turn ended on one
    // after two and a half hours of work.
    'connection error',
    // Our own idle guard (`providers/idle-timeout.ts`) tearing down a stream
    // that went silent. It was added to stop a forty-minute hang, and it did —
    // by ending the turn. A silent socket is the same class of failure as a
    // dropped one, and one retry usually gets a live connection; ending hours
    // of work over it was the wrong trade.
    'connection stalled',
    // Match provider/socket timeouts specifically, NOT the wall-clock
    // "Agent timed out after Nms" (which is handled as a non-retryable abort).
    '502', '503', '529',
    'rate limit', 'rate-limit', 'rate_limit',
    'too many requests',
  ];
  return retryable.some(k => lower.includes(k.toLowerCase()));
}

/**
 * Determine whether an error represents an explicit cancellation (user abort
 * or wall-clock timeout). These should propagate immediately without retries.
 */
function isAbortError(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return msg.includes('cancelled') || msg.includes('aborted');
}

function isRateLimitError(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  // "provider returned error" is an upstream error, not a rate limit — use short backoff not long
  if (msg.includes('provider returned error')) return false;
  if (/\b429\b/.test(msg)) return true;
  if (/\b4[0-8][0-9]\b/.test(msg) || /\b490\b/.test(msg)) return false;
  return msg.includes('rate limit') || msg.includes('too many requests');
}

/** Try to extract a Retry-After hint (seconds) from an error message. Returns 0 if none. */
function parseRetryAfter(err: unknown): number {
  const msg = err instanceof Error ? err.message : String(err);
  // Look for "retry after N", "retry-after: N", "in N seconds", "after Nms"
  const m =
    /retry[\s-]?after[:\s]+(\d+)/i.exec(msg) ||
    /try again in (\d+)\s*s/i.exec(msg) ||
    /reset.*?(\d+)\s*s/i.exec(msg);
  if (m) return Math.min(60, parseInt(m[1], 10));
  return 0;
}

async function withRetry<T>(
  fn: () => Promise<T>,
  maxRetries = 5,
  silent = false,
  signal?: AbortSignal,
): Promise<T> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    // An already-aborted signal means stop before even starting this attempt.
    if (signal?.aborted) throw new Error('Agent cancelled');
    try {
      return await fn();
    } catch (err) {
      // Aborts and non-retryable errors propagate immediately — no backoff.
      if (attempt === maxRetries || isAbortError(err) || !isRetryableError(err)) throw err;

      let delay: number;
      if (isRateLimitError(err)) {
        // Rate limit: longer backoff with jitter (8s, 16s, 32s, 60s, 60s)
        const hint = parseRetryAfter(err);
        const base = hint > 0 ? hint * 1000 : Math.min(60_000, 8_000 * Math.pow(2, attempt - 1));
        const jitter = Math.floor(Math.random() * 2_000); // 0–2s jitter to avoid thundering herd
        delay = base + jitter;
        if (!silent) {
          showError(
            `Rate limited (attempt ${attempt}/${maxRetries}). Retrying in ${Math.round(delay / 1000)}s… ` +
            `Tip: free OpenRouter models throttle aggressively — add a small balance or switch to a paid model.`,
          );
        }
      } else {
        delay = Math.pow(3, attempt - 1) * 1000; // 1s, 3s, 9s, 27s, 81s
        if (!silent) {
          showError(`Transient error (attempt ${attempt}/${maxRetries}), retrying in ${delay / 1000}s...`);
        }
      }
      // Abort-aware sleep: if the user cancels or the wall-clock timeout fires
      // during the backoff, resolve immediately so the abort is observed
      // instead of forcing a full delay before the loop notices.
      await abortableSleep(delay, signal);
    }
  }
  throw new Error('unreachable');
}

/**
 * Sleep that resolves early if `signal` aborts. Avoids the previous behavior
 * where an abort during a retry backoff still waited the full delay.
 */
function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) return new Promise(r => setTimeout(r, ms));
  if (signal.aborted) return Promise.resolve();
  return new Promise(resolve => {
    // Both paths run the same teardown, so the listener is removed whether the
    // sleep was aborted or simply elapsed. The previous version only cleaned up
    // on abort, and this is called once per retry backoff against a signal that
    // lives for the whole run — so a run with a few retried steps accumulated
    // listeners until Node warned about a leak at eleven.
    let timer: ReturnType<typeof setTimeout>;
    const finish = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolve();
    };
    timer = setTimeout(finish, ms);
    signal.addEventListener('abort', finish, { once: true });
  });
}

export interface TokenTracker {
  /**
   * `input` is the TOTAL prompt size; `cached` (cache reads) and `cacheWrite`
   * are subsets of it, normalized by the provider — see providers/usage.ts.
   *
   * `measured` says whether these numbers came from the API or were counted
   * here. Defaults to true; pass false for the heuristic fallback used when a
   * provider reports no usage at all.
   */
  add(
    input: number, output: number, cached?: number, cacheWrite?: number, measured?: boolean,
    cacheWrite1h?: number,
  ): void;
  getUsage(): {
    inputTokens: number;
    outputTokens: number;
    cachedTokens: number;
    cacheWriteTokens: number;
    sessions: number;
  };
  estimateCost(model: string, settings?: AicoSettings): number;
  /** Whether the *price* is unknown, so a placeholder rate was applied. */
  isEstimated(model: string, settings?: AicoSettings, providerType?: string): boolean;
  /** Whether the *token counts* were guessed because no usage was reported. */
  hasEstimatedUsage(): boolean;
  format(model?: string, settings?: AicoSettings, providerType?: string): string;
  /**
   * For a delegated agent's tracker: the conversation's own, which session
   * ceilings are measured against (tokens.ts createChildTracker, ADR 0021).
   */
  session?: TokenTracker;
}

export interface AgentOptions {
  task: string;
  /**
   * Instructions the user attached to this run's project.
   *
   * Rendered last in the system prompt so they win over the general behaviour
   * rules when the two disagree — which is the point of choosing them.
   */
  projectInstructions?: string;
  /**
   * The session's standing objective, if one is active.
   *
   * Read from the log per turn by the caller, so pausing or clearing it takes
   * effect on the next message rather than the next restart.
   */
  goal?: string;
  /**
   * The project directory this run works in.
   *
   * Every file tool resolves relative paths against it and refuses writes
   * outside it. Defaults to `process.cwd()`. Set it to drive a session in a
   * directory other than the one the process was launched in — which is what
   * the server does, and why it cannot simply chdir: several sessions in
   * several projects share one process.
   */
  cwd?: string;
  /** GitHub token — now optional; kept for backward compat with sub-agent callers */
  token?: string;
  model: string;
  filePath?: string;
  showPlan: boolean;
  autoApprove: boolean;
  /**
   * When the Sentinel is unsure (escalate): `ask` a person (default), or
   * `proceed` — full autonomy, chosen by the person for this turn or in their
   * own `sentinel.onEscalate`. A Sentinel refusal still stops the call.
   */
  sentinelEscalation?: 'ask' | 'proceed';
  verbose: boolean;
  conversationHistory: Array<{ role: string; content: string }>;
  /** Optional: session ID for hooks/logging */
  sessionId?: string;
  /** Optional: token tracker to record usage */
  tokenTracker?: TokenTracker;
  /** Optional: loaded settings for hooks */
  settings?: AicoSettings;
  /** Suppress all stdout writes (used by Ink UI) */
  silent?: boolean;
  /** Called when a tool is about to execute */
  onToolCall?: (name: string, args: Record<string, unknown>, callId: string) => void;
  /** Called after a tool finishes executing */
  onToolDone?: (name: string, result: unknown, callId: string) => void;
  /** Called with each streamed text chunk (full accumulated text so far) */
  onChunk?: (text: string) => void;
  /**
   * Called as the model's reasoning streams in, with the full text accumulated
   * **for the current step** (same contract as {@link onChunk}, reset at each
   * step boundary so a UI can attach the trace to the reply it produced).
   *
   * Not every step reasons. Adaptive thinking is the model's own decision, and
   * a provider with thinking disabled never calls this at all — so a caller
   * must treat silence as normal rather than as a stall.
   *
   * This is display only. The replayable form of the trace is handled
   * separately (see {@link ReasoningTrace}) because for some providers it is
   * signed and cannot be reconstructed from the readable text.
   */
  /**
   * The model's reasoning for the current step.
   *
   * Called with the text accumulated *so far within this step*, not a delta —
   * a collapsible block replaces its contents rather than reassembling them.
   * `step` identifies which burst it belongs to: a turn that calls tools
   * reasons again after each result, and those are separate thoughts that must
   * not be concatenated into one wall of text.
   */
  onReasoning?: (text: string, step: number) => void;
  /**
   * Called whenever the provider reports token usage for the current API call.
   * Lets callers (e.g. sub-agent registry) track per-agent token consumption
   * independently of the session-wide tokenTracker.
   */
  onTokens?: (
    input: number,
    output: number,
    cached: number,
    cacheWrite: number,
  ) => void;
  /** Ink UI permission callback — bypasses readline-based permission check */
  onPermissionRequest?: (toolName: string, detail: string, fileDiff?: { path: string; added?: string[]; removed?: string[]; preview?: string }) => Promise<boolean>;
  /**
   * Ask a person even when nothing else asks — the every-use and first-use
   * approvals of custom tools (a destructive tool at L3, `auto`). Unlike
   * `onPermissionRequest`, it is consulted whatever `autoApprove` says, and
   * sub-agents inherit it (through the run context). Undefined with no
   * terminal means nobody can be asked, and such calls are refused.
   */
  onApprovalRequired?: (toolName: string, detail: string) => Promise<boolean>;
  /**
   * Apply this run's file writes somewhere other than the filesystem.
   *
   * The VS Code panel supplies one so an edit enters the editor's undo stack
   * and its Source Control view instead of arriving as an external change.
   * Omitted everywhere else, which is what keeps the terminal and the browser
   * workspace behaving exactly as they did. See `tools/file-writer`.
   */
  applyEdit?: FileWriter;
  /**
   * The editor driving this run, when one is.
   *
   * Carries both the way to ask and the list of what may be asked. Supplied by
   * the server when the client submitting the turn declared it can service host
   * tools; absent everywhere else, which is what keeps a terminal run from
   * being shown a tool that only an editor can answer.
   */
  host?: HostBridge;
  /**
   * Set only for the desktop browser copilot's turns: where `HandOffToChat`
   * sends work. Also what marks the run as the copilot (see resolveToolSet).
   */
  handOff?: HandOffBridge;
  /** Ink UI AskUser callback — agent pauses to ask human a question */
  onAskUser?: (question: string) => Promise<string>;
  /**
   * There is no human attached to this run.
   *
   * Set by every unattended caller — background agents, cron firings, work
   * submitted over MCP. It cannot be inferred: a global `askUser` callback may
   * well be registered by the web server while the run in question is a 3am
   * cron job, and routing its question to a browser tab nobody has open is a
   * hang wearing a different hat.
   */
  headless?: boolean;
  /**
   * The run's autonomy level (design §4.2, `autonomy/levels`). Only L4 changes
   * anything here: a custom-tool call that needs a person is parked in the
   * approve-later inbox instead of asked or refused. Never above the
   * delegating run's level (read from the run context); undefined inherits it.
   */
  autonomy?: AutonomyLevel;
  /** Where a parked call says it came from, for the inbox list. */
  parkFrom?: { origin: ActionOrigin; label?: string };
  /** Certification runs only (`evals/run`): mocks and records tool calls. See `RunContext.evalHarness`. */
  evalHarness?: import('./run-context.js').EvalHarness;
  /** Called when a sub-agent starts (Task tool) */
  onSubagentStart?: (rec: import('./tools/task.js').SubAgentRecord) => void;
  /** Called when a sub-agent finishes (Task tool) */
  onSubagentStop?: (rec: import('./tools/task.js').SubAgentRecord) => void;
  /** Sub-agent recursion depth; max 4 (managed internally) */
  depth?: number;
  /** Optional file/image attachments included with the user message */
  attachments?: SdkAttachment[];
  /**
   * Images the reader attached to this turn, by reference.
   *
   * References rather than bytes, so what goes in the session log is small and
   * durable. What they resolve to is decided per request by
   * {@link projectImages}, which is where the model is known.
   */
  images?: ImageRef[];
  /** What the person attached, recorded on their message so clients can show it. */
  shownAttachments?: UserAttachment[];
  /**
   * Fetch the bytes behind image references.
   *
   * Injected rather than imported, because the store that holds them belongs
   * to whoever took the upload — the web server here — and the agent core has
   * no business knowing about it. Answers positionally: one slot per reference,
   * `undefined` for anything it cannot find.
   */
  resolveImages?: (refs: ImageRef[]) => Promise<Array<ImagePart | undefined>>;
  /**
   * Keep an image the run produced — a verifier screenshot on disk, or the
   * bytes a tool returned (Read on a PNG, WebFetch of an image URL, an MCP
   * screenshot) — so it can be shown to the model on the next step. Returns
   * the reference `resolveImages` will answer for, or nothing when the store
   * declines.
   *
   * Absent on the CLI and for sub-agents, where there is no attachment store:
   * tool images are then held in memory for the run and gone afterwards (see
   * `tools/tool-images`), and verifier screenshots stay on disk.
   */
  storeImage?: (source: string | ToolImageBytes) => Promise<ImageRef | undefined>;
  /** Sub-agent type — restricts available tools */
  agentType?: SubAgentType;
  /**
   * Dynamic tool whitelist from agent_spec or agent_name resolution. When set,
   * overrides agentType-based tool selection — lets custom agents have exactly
   * the tools their spec defines ('all', 'readonly', or explicit names).
   */
  agentSpecTools?: string[] | 'all' | 'readonly';
  /**
   * What the delegating run may use. This run's own list (`agentSpecTools` or
   * `agentType`) is intersected with it, so a child never holds more than its
   * parent. Absent at the top of a tree. See `agents/effective`.
   */
  toolScope?: ToolScope;
  /**
   * False when this run's agent may not delegate: `Task` and `Investigate` are
   * then neither offered nor dispatched, here or in anything below it.
   */
  canDelegate?: boolean;
  /**
   * The bounds of the named agent this run is (a persona or `Task agent_name`):
   * deny list, MCP servers, delegation rule, autonomy ceiling, budget and write
   * paths, all enforced here (agents/effective, agents/ceiling,
   * agents/paths-guard). Its allow-list still arrives as `agentSpecTools`.
   */
  agentBounds?: import('./agents/types.js').AgentBounds;
  /**
   * On-demand tool groups already loaded by whoever delegated this run.
   *
   * A sub-agent has a fresh log, so without this a parent that had loaded the
   * remote tools would hand a server task to a child that has to spend a step
   * loading them again. See `tools/deferred.ts`.
   */
  toolGroups?: readonly string[];
  /**
   * A persona this whole run is held under, with its skills' procedures inlined.
   *
   * The system prompt rather than a prefix on the user message, which is where
   * the one-shot delegation path puts it. For a single handoff that is close
   * enough; for a conversation it is not — a persona restated inside each
   * message competes with the message, and re-sending it every turn defeats
   * the prompt cache it should be sitting in front of.
   */
  agentPersona?: { name: string; instructions: string };
  /**
   * Sections for the volatile tail that only the caller can know — the state
   * of the app a bound session is building, for one. Paid on every step, so
   * each should be a line or two.
   */
  volatileSections?: PromptSection[];
  /**
   * The same sections, re-read before every step.
   *
   * A turn is many requests. The app an agent is building starts, installs
   * and fails *during* the turn, and a line computed once at the top said
   * "installing" through twenty steps of a running app — the agent reported
   * the state as inconsistent and spent steps reconciling it. Sections
   * returned here replace those with the same id for that step only.
   */
  refreshVolatile?: () => Promise<PromptSection[]>;
  /**
   * Something the run did to its own context that the person should know
   * about — older output cleared, earlier steps condensed. Shown, not sent.
   */
  onNotice?: (text: string) => void;
  /** The app this session is bound to, if any. Becomes the run's project root. */
  app?: { slug: string; dir: string; kind: string; url?: string };
  /** Plan mode — only read-only tools allowed */
  planMode?: boolean;
  /** Effort level for system prompt (low/medium/high/max) */
  effort?: string;
  /** Abort signal used by cancellable background/sub-agent runs */
  abortSignal?: AbortSignal;
  /**
   * Durable session log. When supplied, the loop derives every request from it
   * and records turn/step boundaries, assistant messages, and tool call/result
   * pairs as events — so tool fidelity survives across turns, the prompt prefix
   * is append-only (cache-friendly), and the run is resumable and forkable.
   *
   * When omitted, the loop keeps its legacy behaviour: `conversationHistory` is
   * flattened into an XML preamble and discarded after the run. Every shipped
   * entry point still works on that path while it migrates.
   */
  session?: Session;
  /**
   * Durable queue of input that arrives while this run is working.
   *
   * The loop drains the `next-step` queue at every step boundary, so a message
   * steered in mid-run reaches the model before it takes another action — and
   * pending input also prevents the loop from finishing, so steering can extend
   * a turn the model was about to end.
   *
   * The `next-turn` queue is the caller's: drain it with `claimTurn()` after
   * this call returns and submit each as its own run.
   */
  inbox?: Inbox;
  /**
   * Who the task is from, when it is not the person: a turn started only to
   * read a background agent's report (agents/report-back) is recorded as a
   * `plugin` message, never as something the user typed. Default human.
   */
  taskSource?: MessageSource;
  /**
   * Persist every streamed delta as an `assistant/chunk` event. Off by default:
   * it roughly triples log size and only exact stream replay consumes it.
   */
  recordChunks?: boolean;
  /**
   * Use this provider instead of resolving one from the model name and
   * settings.
   *
   * This is the loop's test seam. Without it the only way to exercise the
   * agent loop is against a live API, which makes the turn/step machinery,
   * cancellation, and log shape effectively untestable — and those are exactly
   * the parts where a regression is silent and expensive.
   */
  provider?: import('./providers/types.js').ProviderAPI;
  /**
   * Capability context supplying this run's services.
   *
   * When present, the loop resolves its model provider from `llm` and its tool
   * set from `tools` rather than importing them — so a composition can give one
   * agent a different tool set or route it to a different backend without any
   * change here. Omitted, the historical singletons are used unchanged.
   */
  context?: Context;
}

/**
 * Classify why a turn ended when the loop threw.
 *
 * Cancellation and wall-clock timeout are `aborted`, not `error` — conflating
 * them makes a user pressing Ctrl+C look like a failure in the transcript.
 * Everything else keeps its provider status code when one is recoverable from
 * the message, so a transcript can distinguish a 429 from a 500 after the fact.
 */
function classifyTurnEnd(err: unknown, aborted: boolean): TurnEndReason {
  const message = err instanceof Error ? err.message : String(err);
  if (aborted || /\b(cancelled|aborted)\b/i.test(message)) {
    return { kind: 'aborted', cause: message };
  }
  const status = /API error (\d{3})/.exec(message)?.[1];
  return { kind: 'error', message, code: status ?? 'UNKNOWN' };
}

// ── Tool handler options ─────────────────────────────────────────────

interface ToolHandlerOpts {
  autoApprove: boolean;
  verbose: boolean;
  settings?: AicoSettings;
  onToolCall?: (name: string, args: Record<string, unknown>, callId: string) => void;
  onToolDone?: (name: string, result: unknown, callId: string) => void;
  onPermissionRequest?: (toolName: string, detail: string, fileDiff?: { path: string; added?: string[]; removed?: string[]; preview?: string }) => Promise<boolean>;
  /**
   * Apply this run's file writes somewhere other than the filesystem.
   *
   * The VS Code panel supplies one so an edit enters the editor's undo stack
   * and its Source Control view instead of arriving as an external change.
   * Omitted everywhere else, which is what keeps the terminal and the browser
   * workspace behaving exactly as they did. See `tools/file-writer`.
   */
  applyEdit?: FileWriter;
  onAskUser?: (question: string) => Promise<string>;
  silent?: boolean;
  agentType?: SubAgentType;
  planMode?: boolean;
  /** Composed tool set. Authoritative when present. */
  toolRegistry?: ToolRegistryCapability;
  /** Identity used for per-agent guard state (repeat detection, metrics). */
  agentId: string;
  /**
   * Custom tools this run may call (custom-tools/). Their approval is decided
   * by their own guards — effect class, autonomy level, taint — so the
   * generic permission stage leaves them alone.
   */
  customTools?: CustomToolStageOptions;
  /** Pipeline to register policy on. A fresh one is built when omitted. */
  pipeline?: ToolPipeline;
  /** Forwarded into each call's context so stages can observe cancellation. */
  signal?: AbortSignal;
  /** What this run may use, enforced by the `agent-scope` guard. See `agents/effective`. */
  scope?: ToolScope;
  /**
   * Shell confinement (ADR 0027): the permission card names what a shell
   * command would change outside the project, and marks the call as shown so
   * the `shell-confinement` guard does not ask the same person twice.
   */
  shellConfinement?: ShellConfinement;
}

/** What a tool handler returns: the result plus anything to inject after it. */
export interface ToolInvocation {
  result: unknown;
  /** Model-visible context appended after this step's tool results. */
  additionalContexts?: AdditionalContext[];
}

type ToolHandler = (args: Record<string, unknown>, callId: string) => Promise<ToolInvocation>;
type AgentToolProfile = 'default' | 'browser-qa' | 'repair';

/**
 * What a widget repair is allowed to reach for.
 *
 * Correcting a fenced block needs no tools at all — the broken source and the
 * error are both in the request, and the answer is a rewritten block. WidgetSpec
 * is here because looking up the format is the one lookup that helps.
 *
 * The restriction exists because asking politely did not work. A repair request
 * ends with "send back a corrected block and nothing else", and a model handed
 * a misleading parser error and every tool in the box will instead try to
 * reproduce it: temp directories, npm installs, a version hunt. That is good
 * debugging instinct spent on a task that did not want it, and it ran for
 * twenty tool calls on a diagram whose fix was one pair of quotation marks.
 *
 * A rule in the prompt competes with the model's judgement. An empty toolbox
 * does not.
 */
const REPAIR_TOOLS = new Set(['WidgetSpec']);

const BROWSER_QA_BUILTINS = new Set([
  'TodoRead',
  'TodoWrite',
  'AskUserQuestion',
  'WorkspaceInfo',
  'WorkspaceWrite',
  'WorkspaceRead',
  'WorkspaceList',
  'CapabilityReport',
]);

function looksLikeBrowserQaTask(task: string): boolean {
  const text = task.toLowerCase();
  const hasUrl = /\bhttps?:\/\//i.test(task);
  const wantsBrowser =
    /\b(browser|browse|playwright|click|login|sign in|fill|form|qa|test|website|site|web app)\b/.test(text);
  return hasUrl && wantsBrowser;
}

/**
 * A widget repair, recognised by the marker the interface put there.
 *
 * The marker is ours — written by the Fix action, stripped before the message
 * is shown, and already carried in the task text. Detecting it here means the
 * restriction needs no new option threaded through five layers, and it cannot
 * be spoofed into existence by a reader typing the same words.
 */
const FIX_MARKER = /\[\[aico:fix:[a-z0-9]+:[a-z]+\]\]/i;

export function selectToolProfile(task: string): AgentToolProfile {
  if (FIX_MARKER.test(task)) return 'repair';
  if (
    looksLikeBrowserQaTask(task) &&
    mcpRegistry.getToolsForAgent().some((t) => t.name.startsWith('mcp__playwright__'))
  ) {
    return 'browser-qa';
  }
  return 'default';
}

/** Tools available to a run, plus how to invoke them. */
interface ResolvedToolSet {
  defs: ToolDefinition[];
  dispatch: (
    name: string,
    args: Record<string, unknown>,
    /** Threaded through so a spilled result can name the call that made it. */
    callId?: string,
    /** The run's abort signal, so a long tool stops when the user does. */
    signal?: AbortSignal,
  ) => Promise<unknown>;
}

/**
 * Decide which tools this run has and how to execute them.
 *
 * A supplied {@link ToolRegistryCapability} is authoritative — that is the seam:
 * whoever composed the context decides the tool set, and this function does not
 * learn which implementation answered. Without one, the historical selection
 * (spec whitelist → agent type → all built-ins, dispatched through
 * `executeTool`) applies unchanged.
 *
 * Profile and plan-mode filters are applied to whichever source produced the
 * list, so a custom registry is narrowed by plan mode exactly like the built-in
 * set is — a registry must not be a way to smuggle a writing tool into a
 * read-only run.
 */
/*
  Exported for the test harness, which is the only caller outside this module.

  The alternative was to assert on tool availability by running a whole turn
  against a mock provider, which tests the loop rather than the rule — and the
  rule ("off means the model cannot see it") is the thing that keeps being got
  wrong.
*/
export function resolveToolSet(opts: {
  toolRegistry?: ToolRegistryCapability;
  agentType?: SubAgentType;
  agentSpecTools?: string[] | 'all' | 'readonly';
  /** No human attached — removes the tools that would wait for one. */
  headless?: boolean;
  toolProfile?: AgentToolProfile;
  planMode?: boolean;
  settings?: AicoSettings;
  /** 0 for the conversation itself; 1 or more inside a delegation. */
  depth?: number;
  /** What this run may use, parent bound included. Undefined is unrestricted. */
  scope?: ToolScope;
}): ResolvedToolSet {
  let defs: ToolDefinition[];
  let dispatch: ResolvedToolSet['dispatch'];

  if (opts.toolRegistry) {
    const registry = opts.toolRegistry;
    defs = registry.list();
    dispatch = (name, args) => registry.execute(name, args);
  } else {
    defs = opts.agentSpecTools
      ? getToolsForSpec(opts.agentSpecTools)
      : opts.agentType ? getToolsForAgent(opts.agentType) : toolDefinitions;
    dispatch = (name, args, callId, signal) => executeTool(name, args, callId, signal);
  }

  /*
    Browser QA narrows the tool set for sub-agents only.

    At depth 0 it used to as well, and that was the single largest cache
    breaker in the log: one message with a URL and the word "test" dropped
    most built-ins and every MCP tool but Playwright, which invalidates the
    tools breakpoint — and everything cached behind it — on both sides of that
    turn. The hint about working quickly in the browser still rides in the
    tail; the toolbox stays the same one the conversation has had all along.
    A sub-agent spawned for QA is a short, separate conversation, where the
    narrowing costs nothing and keeps it on task.
  */
  if (opts.toolProfile === 'browser-qa' && (opts.depth ?? 0) > 0) {
    defs = defs.filter(d => BROWSER_QA_BUILTINS.has(d.name));
  }
  if (opts.toolProfile === 'repair') {
    defs = defs.filter(d => REPAIR_TOOLS.has(d.name));
  }
  if (opts.planMode) {
    defs = defs.filter(d => PLAN_MODE_TOOLS.has(d.name));
  }

  // Supervision belongs to whoever did the delegating, and that is the top of
  // the tree. A sub-agent with this tool could stop its own siblings — work it
  // did not commission, cannot see the brief for, and is in no position to
  // judge. Several agent types run with the full tool set, so this has to be
  // taken away explicitly rather than left out of a whitelist.
  if ((opts.depth ?? 0) > 0) {
    defs = defs.filter(d => d.name !== 'Supervise');
  }

  /*
    A question nobody can answer is a hang, so the tool is removed rather than
    left present with a disclaimer.

    "Off means the model cannot see the tool, not that it is told not to use it"
    is the rule this repo already applies to Mini Apps, and it applies here for
    the same reason: a tool in the list gets called eventually. `askUser` now
    also refuses rather than blocking, but that is the second line — by then the
    run has already spent a turn asking into the void.
  */
  if (opts.headless || !canAskUser()) {
    defs = defs.filter(d => d.name !== 'AskUserQuestion');
  }
  // Same reasoning: a credential request with nobody to type it is a wait on nothing.
  if (opts.headless) {
    defs = defs.filter(d => d.name !== 'CredentialRequest');
  }

  // Apps are a plugin, and "off" has to mean the model cannot see the tool —
  // not that it is told not to use it. A tool present in the list is a tool
  // that gets called eventually, and calling it while the host is not
  // listening builds an app nobody can open.
  if (!opts.settings?.miniApps?.enabled) {
    defs = defs.filter(d => d.name !== 'AppManage');
  }

  /*
    The editor's tools, offered only while an editor is attached.

    Same rule as Mini Apps and `AskUserQuestion` above, and it earns its place
    for the same reason: a tool in the list is a tool that gets called, and one
    that can only answer "no editor is attached" costs a turn to discover. The
    capability is read from the run context rather than from settings because it
    is a fact about *this* run — the same session opened in a browser tab
    tomorrow has no editor, and would otherwise be offered `VSCodeDiagnostics`
    on the strength of yesterday's.
  */
  const host = currentRunContext()?.host;
  const hostTools = new Set<string>(host?.tools ?? []);
  defs = defs.filter(d => !isHostTool(d.name) || hostTools.has(d.name));

  /*
    The browser copilot, and only the conversation itself (not its sub-agents).

    `HandOffToChat` exists only where there is a chat to hand to and someone
    watching the copilot — the run context carries the bridge on the copilot's
    own turns and nowhere else. The build-and-run tools go the other way: the
    copilot is told to hand that work off, and taking the shell, the editors,
    git, the ops tools and Task away is what makes "hand it off" the path of
    least resistance rather than a request the model can talk itself out of.
    Stable for every copilot turn, so the tool list (and the cache behind it)
    does not move between them.
  */
  const copilot = Boolean(currentRunContext()?.handOff) && (opts.depth ?? 0) === 0;
  defs = copilot
    ? defs.filter(d => !COPILOT_WITHHELD.has(d.name))
    : defs.filter(d => d.name !== HANDOFF_TOOL);

  // Last, so it overrides every selection above it. One list, applied in one
  // place, is what makes a capability removable without editing the code that
  // offers it — and applying it here rather than at each call site means a
  // tool switched off for the session is also switched off for every
  // sub-agent, which is the only reading of "off" that is not a loophole.
  const disabled = opts.settings?.disabledTools;
  if (disabled?.length) {
    const off = new Set(disabled);
    defs = defs.filter(d => !off.has(d.name));
  }
  // The organisation's deniedTools (ADR 0035), patterns included: a tool it has
  // forbidden is not offered at all. The `managed-policy` guard is the second line.
  defs = defs.filter(d => policyAllowsTool(d.name));

  /*
    The agent's effective set: its own list intersected with every delegator's.
    Applied to whichever source produced the list — a composed registry is no
    way round it, and neither is a child asking for `tools: 'all'`, which
    selected the full built-in set above and is narrowed back to the parent's
    here. The `agent-scope` guard refuses the same tools at dispatch.
  */
  if (opts.scope) {
    const scope = opts.scope;
    defs = defs.filter(d => scopeAllows(scope, d.name));
  }

  return { defs, dispatch };
}

/**
 * Which MCP tools a run is offered: its scope, plan mode and `disabledTools`
 * apply to them exactly as to built-ins.
 *
 * Plan mode keeps only tools known to read (a server the person marked
 * read-only, or the desktop host's read tools) — an MCP server's own
 * annotations are untrusted, so "may write" is the default. See `mcp/policy`.
 */
export function mcpToolAllowed(name: string, opts: {
  scope?: ToolScope | undefined;
  planMode?: boolean | undefined;
  settings?: AicoSettings | undefined;
}): boolean {
  if (opts.planMode && !isReadOnlyMcpTool(name)) return false;
  if (opts.settings?.disabledTools?.some(entry => entryMatches(entry, name))) return false;
  if (!policyAllowsTool(name)) return false;
  return scopeAllows(opts.scope, name);
}

/** Whether a loaded MCP server is offered on demand: not the host's own, not `alwaysLoad`. */
export function isDeferredMcpServer(server: string): boolean {
  return !mcpRegistry.isHost(server) && mcpRegistry.configOf(server)?.alwaysLoad !== true;
}

/**
 * The `mcp:<server>` on-demand groups for a run's MCP tools (see
 * `tools/deferred`). The line names the configured server and its tool count
 * only — never the server's own description of itself, which is untrusted
 * text and would otherwise ride in every request.
 */
export function mcpToolGroups(tools: ReadonlyArray<{ name: string }>): ToolGroup[] {
  const groups = new Map<string, string[]>();
  for (const t of tools) {
    const parts = parseMcpToolName(t.name);
    if (!parts || !isDeferredMcpServer(parts.server)) continue;
    const list = groups.get(parts.server) ?? [];
    list.push(t.name);
    groups.set(parts.server, list);
  }
  return [...groups.entries()].map(([server, names]) => ({
    id: `mcp:${server}`,
    summary: `tools of the MCP server "${server}" (${names.length})`,
    tools: names,
    unlisted: true,
  }));
}

/**
 * A run's scope: its delegator's, narrowed by its own list and, for a named
 * agent, its bounds. Exported because the agent summary (agents/summary) is
 * computed with this same function — the summary, what the run is offered and
 * what dispatch accepts cannot disagree.
 */
export function agentRunScope(opts: Pick<AgentOptions, 'toolScope' | 'agentSpecTools' | 'agentType' | 'canDelegate' | 'agentBounds'> & { cwd: string }): ToolScope {
  const bounds = opts.agentBounds;
  return narrowScope(opts.toolScope, {
    layer: ownScopeLayer(opts.agentSpecTools, opts.agentSpecTools ? undefined : opts.agentType),
    ...(bounds ? { extra: agentExtraLayers(bounds) } : {}),
    canDelegate: opts.canDelegate !== false && bounds?.delegate !== 'none' ? opts.canDelegate : false,
    ...(bounds && bounds.delegate !== 'none' ? { delegateTo: bounds.delegate } : {}),
    ...(bounds?.writePaths?.length
      ? { writeBound: { label: `the ${bounds.name} agent`, root: opts.cwd, globs: bounds.writePaths } }
      : {}),
  });
}

/**
 * The layer this run's own tool list adds to its scope.
 *
 * An explicit spec list wins (it is what `getToolsForSpec` selected); otherwise
 * a restricted agent type's set. A restricted type is offered MCP tools only
 * from read-only servers — a reviewer is read-only whichever protocol the tool
 * speaks. Types with every tool add nothing.
 */
function ownScopeLayer(agentSpecTools: ToolAllow | undefined, agentType: SubAgentType | undefined) {
  const readonly = getToolsForSpec('readonly').map(d => d.name);
  if (agentSpecTools) {
    return layerFor(Array.isArray(agentSpecTools) ? 'its tool list' : `tools: '${String(agentSpecTools)}'`, agentSpecTools, readonly);
  }
  if (agentType && !agentTypeGetsAllTools(agentType)) {
    return { label: `the ${agentType} agent's tools`, tools: new Set(getToolsForAgent(agentType).map(d => d.name)), mcp: 'readonly' as const };
  }
  return undefined;
}

/**
 * What the browser copilot is not given: the tools for building and operating
 * things, which belong in a full chat (see `HandOffToChat`). Writing a file is
 * kept — saving a table from a page is browsing work.
 */
export const COPILOT_WITHHELD = new Set([
  'Bash', 'Terminal', 'Edit', 'MultiEdit', 'NotebookEdit', 'Git', 'AppManage',
  'RunChecks', 'VerifyApp', 'DependencyAudit', 'EnterWorktree', 'ExitWorktree', 'Task',
  'CodeRewrite', 'Refactor',
  'SshExec', 'SshCopy', 'SshTunnel', 'WinRmExec', 'SnmpQuery', 'HttpRequest',
]);

/** Tools a plan-mode run may use. Read-only by construction. */
const PLAN_MODE_TOOLS = new Set([
  'Read', 'Glob', 'Grep', 'LS', 'WebFetch', 'WebSearch', 'Pwd', 'TodoRead',
  // Read-only lookups of public data, the same kind of thing as WebSearch.
  'Places', 'Weather', 'CurrencyRates', 'SportsScores',
  // Read-only, and orientation is most of what a planning turn does. Leaving
  // it out would make planning the one mode that still has to Glob its way
  // around a project it could have asked about once.
  'CodebaseMap',
  // The dependency graph only reads (ADR 0028); "what does this change affect" is a planning question.
  'CodeGraph',
  // Structural search only reads, and finding every site is what planning a
  // wide change starts with. Its writing siblings are not here.
  'CodeSearch',
  // The board's tasks are the plan itself (ADR 0038): a planning turn writes only the board, never the project.
  'Delivery',
  /*
    Read-only, and a planning turn is exactly when it is worth asking. "What is
    already broken here?" is the first question of most plans, and answering it
    from the language server beats guessing from a grep. It is filtered out
    again when no editor is attached, so this only widens plan mode where the
    tool exists at all.
  */
  'VSCodeDiagnostics',
  // Reading the window is orientation; correcting it at the user's word is
  // the kind of thing a planning turn is asked to do.
  'ContextWindow',
  // How a planning turn ends. Without it the only way to deliver a plan was
  // prose, which can be read and cannot be answered.
  'ProposePlan',
  // Reads the Recall index of past sessions and memories (ADR 0018); writes nothing.
  'Recall',
]);

/**
 * Build a map of { toolName → async handler } for all tools available in this
 * agent context. Handlers include permission checks, safety checks, and hooks.
 */
function buildToolHandlers(opts: ToolHandlerOpts & { toolProfile?: AgentToolProfile; agentSpecTools?: string[] | 'all' | 'readonly'; depth?: number }): {
  handlers: Map<string, ToolHandler>;
  /**
   * A handler that runs `body` through this run's pipeline. Exposed so tools
   * that are not in the built-in list — MCP tools, which can arrive mid-turn —
   * get exactly the policy the built-ins get, rather than a second, shorter
   * path beside it.
   */
  wrap: (name: string, body: (call: ToolCallContext) => Promise<unknown>) => ToolHandler;
} {
  // Tool set and dispatch come from the registry when one is composed, and from
  // the historical built-in selection otherwise.
  const { defs, dispatch } = resolveToolSet(opts);

  // ── Policy pipeline ────────────────────────────────────────────────
  // The same concerns the old inline closure handled, now as ordered named
  // stages. Registration order below reproduces the original order exactly:
  //   PreToolUse hook → agent-scope → plan-mode → bash safety → permission → body → PostToolUse
  // Everything after this point can be extended (timeouts, retries, metrics,
  // loop guards) without touching the agent loop. MCP tools run through the
  // same stages (see `wrap`): before that they skipped every one of them.
  const pipeline = opts.pipeline ?? new ToolPipeline();

  pipeline.onPreExecute('hooks:pre-tool-use', async (ctx, next) => {
    if (!opts.settings) return next();
    // Fails CLOSED: a PreToolUse hook is a guard the user installed, and a
    // guard that waves the call through whenever it breaks is no guard. A hook
    // that throws, times out or cannot be started blocks the call (runHooks).
    let hookResult: string | undefined;
    try {
      hookResult = await runHooks(
        'PreToolUse',
        { event: 'PreToolUse', toolName: ctx.name, toolArgs: ctx.arguments },
        opts.settings,
      );
    } catch (hookErr) {
      const reason = hookErr instanceof Error ? hookErr.message : String(hookErr);
      if (!opts.silent) showError(`PreToolUse hook for ${ctx.name} failed: ${reason} (call blocked)`);
      hookResult = 'block';
    }
    if (hookResult === 'block') {
      return { kind: 'deny', reason: 'Blocked by PreToolUse hook: the hook refused this call, or it failed or timed out (a failing guard hook blocks rather than passes). Fix or remove the hook in settings to proceed.' };
    }
    return next();
  });

  // The organisation's managed policy (ADR 0035): first, so a person is never
  // asked to approve a call their organisation has forbidden. Deny-only.
  pipeline.onGuard('managed-policy', createPolicyGuard());

  /*
    The effective set, at dispatch. The schemas offered are filtered by the
    same scope, so this is the second line: it is what makes "not allowed"
    true for a tool whose name the model learned anyway — from an earlier turn
    of the session, or by guessing. Scoped to this run's agent id because a
    composed pipeline can be shared, and one agent's bound is not another's.
  */
  if (opts.scope) {
    const scope = opts.scope;
    pipeline.onGuard('agent-scope', (ctx) => {
      if (ctx.agentId !== opts.agentId) return { kind: 'abstain' };
      const denial = scopeDenial(scope, ctx.name);
      return denial ? { kind: 'deny', reason: denial } : { kind: 'abstain' };
    });
  }

  if (opts.planMode) {
    pipeline.onGuard('plan-mode', (ctx) => {
      const planCommand = shellCommandOf(ctx.name, ctx.arguments);
      if (planCommand !== undefined && !isBashReadOnly(planCommand)) {
        return {
          kind: 'deny',
          reason: 'Plan mode: only read-only commands allowed. This command may modify files.',
        };
      }
      // Not offered in plan mode either (mcpToolAllowed); this is for a name
      // the model already knew.
      if (isMcpToolName(ctx.name) && !isReadOnlyMcpTool(ctx.name)) {
        return {
          kind: 'deny',
          reason: `Plan mode: ${ctx.name} may change things (its server is not marked read-only), so it is not available while planning.`,
        };
      }
      return { kind: 'abstain' };
    });
  }

  // Custom tools: their arguments, then their effect-class approval. Before
  // the generic permission stage, which skips them (see below).
  if (opts.customTools && opts.customTools.tools.size > 0) installCustomToolGuards(pipeline, opts.customTools);

  pipeline.onGuard('bash-safety', (ctx) => {
    // Every tool that runs a shell command, not only `Bash`: Terminal and the
    // desktop's ide_terminal_run used to skip these hard blocks entirely.
    const command = shellCommandOf(ctx.name, ctx.arguments);
    if (command === undefined) return { kind: 'abstain' };
    const safety = classifyBashCommand(command);
    if (safety.level === 'block') {
      return {
        kind: 'deny',
        reason: `BLOCKED: ${safety.reason}. This command is too dangerous to execute.`,
      };
    }
    if (safety.level === 'warn' && !opts.autoApprove && !opts.silent) {
      process.stdout.write(`\n  ⚠  Safety warning: ${safety.reason}\n`);
    }
    return { kind: 'abstain' };
  });

  // Permission is a guard rather than a pre-execute stage precisely because a
  // guard can only deny: no later-registered stage can turn a refusal into an
  // approval.
  pipeline.onGuard('permission', async (ctx) => {
    // autoApprove (or session-wide trust 'all') short-circuits and skips the
    // callback entirely so no dialog is shown.
    if (opts.autoApprove) return { kind: 'abstain' };
    // Decided by `custom-tool:approval`, which asked (or refused) already.
    if (opts.customTools?.tools.has(ctx.name) && ctx.agentId === opts.agentId) return { kind: 'abstain' };

    const args = ctx.arguments;
    const mcp = isMcpToolName(ctx.name) ? parseMcpToolName(ctx.name) : undefined;
    let allowed: boolean;
    if (opts.onPermissionRequest) {
      // An MCP call's arguments have no fixed shape, so the person is shown
      // which server, which tool, and the arguments themselves.
      const plain = mcp
        ? `${mcp.server} → ${mcp.tool} ${JSON.stringify(args)}`
        : String(args.command ?? args.file_path ?? args.path ?? args.pattern ?? args.url ?? args.name ?? '');
      // A shell command that reaches outside the project says so first (ADR 0027).
      const outside = ctx.agentId === opts.agentId ? opts.shellConfinement?.note(ctx.name, args) : undefined;
      const detail = outside ? `${outside} · ${plain}` : plain;
      // For Edit/Write, build a diff preview so the UI can show what changes
      // before the user approves.
      let fileDiff: { path: string; added?: string[]; removed?: string[]; preview?: string } | undefined;
      if ((ctx.name === 'Edit' || ctx.name === 'Write' || ctx.name === 'MultiEdit') && args.file_path) {
        const fpath = String(args.file_path);
        try {
          const existing = fs.existsSync(fpath) ? fs.readFileSync(fpath, 'utf8') : '';
          const existingLines = existing.split('\n');
          if (ctx.name === 'Write' && args.content) {
            const newLines = String(args.content).split('\n');
            fileDiff = {
              path: fpath,
              added: newLines.slice(0, 10),
              removed: existingLines.length > 0 ? existingLines.slice(0, 5) : undefined,
              preview: existing ? '(overwriting ' + existingLines.length + ' lines)' : '(new file)',
            };
          } else if (ctx.name === 'Edit' && args.new_string) {
            fileDiff = {
              path: fpath,
              added: String(args.new_string).split('\n').slice(0, 8),
              removed: args.old_string ? String(args.old_string).split('\n').slice(0, 5) : undefined,
              preview: args.old_string ? 'replacing: ' + String(args.old_string).slice(0, 60) : undefined,
            };
          }
        } catch { /* diff is best-effort */ }
      }
      allowed = await opts.onPermissionRequest(ctx.name, detail.slice(0, mcp || outside ? 300 : 100), fileDiff);
      // A person answered: the one approval fact the change packet can state (ADR 0034).
      currentRunContext()?.sessionLog?.record('tool/decision', { callId: ctx.callId, name: ctx.name, decision: allowed ? 'approved' : 'denied', by: 'person' });
      ctx.state.set('decision-recorded', true);
      if (allowed && outside) ctx.state.set(SHELL_CONFINEMENT_SHOWN, true);
    } else if (mcp && isReadOnlyMcpTool(ctx.name)) {
      // The terminal asks only before tools that change things, and the person
      // said this server only reads.
      allowed = true;
    } else {
      allowed = await checkPermission(ctx.name, args, opts.autoApprove);
    }

    return allowed ? { kind: 'abstain' } : { kind: 'deny', reason: 'User denied this tool call.' };
  });

  pipeline.onPostExecute('hooks:post-tool-use', async (ctx, next) => {
    const decision = await next();
    if (opts.settings) {
      // Isolated: a throwing hook must not overwrite the tool result the model
      // is about to see — degrade to a warning.
      try {
        await runHooks(
          'PostToolUse',
          { event: 'PostToolUse', toolName: ctx.name, toolArgs: ctx.arguments, toolResult: decision.outcome.result },
          opts.settings,
        );
      } catch (hookErr) {
        const reason = hookErr instanceof Error ? hookErr.message : String(hookErr);
        if (!opts.silent) showError(`PostToolUse hook for ${ctx.name} failed: ${reason} (result preserved)`);
      }
    }
    return decision;
  });

  // ── Handlers ───────────────────────────────────────────────────────
  const handlers = new Map<string, ToolHandler>();

  const wrap = (name: string, body: (call: ToolCallContext) => Promise<unknown>): ToolHandler =>
    async (args: Record<string, unknown>, callId: string) => {
      if (!opts.silent) showToolCall(name, args, opts.verbose);
      opts.onToolCall?.(name, args, callId);

      const ctx: ToolCallContext = {
        callId,
        name,
        arguments: args,
        agentId: opts.agentId,
        state: new Map<string, unknown>(),
        ...(opts.signal ? { signal: opts.signal } : {}),
      };

      // A certification run (evals/run) answers some calls itself — after the
      // guards, so every bound still applies — and records them all.
      const harness = currentRunContext()?.evalHarness;
      let mocked: { result: unknown; denied: boolean } | undefined;
      const outcome = await pipeline.execute(ctx, harness
        ? async (call) => {
          mocked = harness.mock(call.name, call.arguments);
          return mocked ? mocked.result : body(call);
        }
        : body);
      const result = outcome.outcome.result;
      harness?.observe({ name, args, denied: outcome.denied || Boolean(mocked?.denied), mocked: Boolean(mocked) });
      // A guard refused the call (a person's refusal was recorded where they gave it).
      if (outcome.denied && !ctx.state.get('decision-recorded')) {
        currentRunContext()?.sessionLog?.record('tool/decision', { callId, name, decision: 'denied', by: 'policy', ...(outcome.deniedBy ? { stage: outcome.deniedBy } : {}), ...(outcome.denialReason ? { reason: outcome.denialReason.slice(0, 300) } : {}) });
      }

      if (!opts.silent) showToolResult(name, result, opts.verbose);
      opts.onToolDone?.(name, result, callId);

      return {
        result,
        ...(outcome.additionalContexts.length > 0
          ? { additionalContexts: outcome.additionalContexts }
          : {}),
      };
    };

  for (const def of defs) {
    handlers.set(def.name, wrap(def.name, (call) => dispatch(call.name, call.arguments, call.callId, call.signal)));
  }

  return { handlers, wrap };
}

/**
 * Build the provider-facing ToolDef list (name, description, inputSchema).
 *
 * Shares {@link resolveToolSet} with the handler map so the schemas the model
 * sees and the handlers that can actually run cannot drift apart — a mismatch
 * there is a model calling a tool that does not exist.
 */
export function buildToolDefs(opts: {
  toolRegistry?: ToolRegistryCapability;
  agentType?: SubAgentType;
  planMode?: boolean;
  toolProfile?: AgentToolProfile;
  agentSpecTools?: string[] | 'all' | 'readonly';
  settings?: AicoSettings;
  depth?: number;
  headless?: boolean;
  /** What this run may use; see `resolveToolSet`. */
  scope?: ToolScope;
  /**
   * On-demand groups loaded so far. Absent means nothing is deferred — every
   * tool is offered, which is also what `deferTools: false` asks for.
   */
  loadedGroups?: ReadonlySet<string>;
  /** Custom tool packs this run offers (`tools:<pack>`); named in `LoadTools`, schemas appended by the caller. */
  customGroups?: readonly ToolGroup[];
}): ToolDef[] {
  const defs = resolveToolSet(opts).defs;
  /*
    Deferral applies only where the whole built-in set was handed over. An
    agent type's own list, a spec's explicit array and a composed registry
    were each chosen by name, and withholding part of a hand-picked set would
    second-guess whoever picked it.
  */
  const wholesale = isWholesale(opts);
  const loaded = opts.loadedGroups;
  const shown = loaded && wholesale ? defs.filter(d => !isDeferred(d.name, loaded)) : defs;
  const out: ToolDef[] = shown.map(d => ({ name: d.name, description: d.description, inputSchema: d.inputSchema }));
  if (loaded && wholesale) {
    const custom = opts.customGroups ?? [];
    const loader = loadToolsDefinition(new Set([...defs.map(d => d.name), ...custom.flatMap(g => g.tools)]), loaded, custom);
    if (loader) out.push(loader);
  }
  return out;
}

/** Whether a run was handed the whole built-in set, which is where deferral applies (see `buildToolDefs`). */
function isWholesale(opts: { toolRegistry?: ToolRegistryCapability; agentSpecTools?: string[] | 'all' | 'readonly'; agentType?: SubAgentType }): boolean {
  return !opts.toolRegistry
    && (opts.agentSpecTools === 'all' || (!opts.agentSpecTools && agentTypeGetsAllTools(opts.agentType)));
}

/**
 * Convert SdkAttachments to inline text appended to the user message.
 *
 * Images are *not* handled here. This function's contract is text, and an
 * image turned into text is an image the model cannot see — which is exactly
 * what used to happen: an attached screenshot became the words "[Image
 * attached: shot.png]" and nothing else, on every model, including the ones
 * that could have read it. {@link imagesFrom} takes them instead, and the
 * placeholder it writes is only what remains for a model that cannot.
 */
function attachmentsToText(attachments: SdkAttachment[]): string {
  const parts: string[] = [];
  for (const att of attachments) {
    if (att.type === 'file') {
      try {
        const content = fs.readFileSync(att.path, 'utf8');
        const name = att.displayName ?? path.basename(att.path);
        parts.push(`\n\n<attachment name="${name}">\n${content.slice(0, 200_000)}\n</attachment>`);
      } catch { /* skip unreadable files */ }
    } else if (att.type === 'directory') {
      try {
        const entries = fs.readdirSync(att.path, { withFileTypes: true });
        const listing = entries.map(e => `  ${e.isDirectory() ? '📁' : '📄'} ${e.name}`).join('\n');
        const name = att.displayName ?? path.basename(att.path);
        parts.push(`\n\n<directory path="${name}">\n${listing}\n</directory>`);
      } catch { /* skip */ }
    }
  }
  return parts.join('');
}

/**
 * Turn the references in a conversation into bytes this model can be sent.
 *
 * Run immediately before each request, which is the only place that knows
 * enough to decide. The reference is durable and says an image was attached;
 * whether it becomes a picture or a sentence depends on the model, and the
 * model can change between one turn and the next.
 *
 * A model that cannot read images gets a line of text in place of each one.
 * Dropping them silently would leave the reader watching the agent answer a
 * question about a screenshot it was never shown, with nothing to explain the
 * confusion. The text names the model and the way out.
 *
 * The returned messages are for this request only. Nothing here is recorded,
 * so switching to a vision model makes every picture in the session visible
 * rather than only the ones attached afterwards.
 *
 * With a `describer` (the `vision` model role, models/vision), a text-only
 * model gets a description of each image instead of the one-line note; it is
 * cached per image, so it is paid for once, not on every step.
 */
export async function projectImages(
  messages: AicoMessage[],
  model: string,
  settings: AicoSettings | undefined,
  resolve: ((refs: ImageRef[]) => Promise<Array<ImagePart | undefined>>) | undefined,
  cache: Map<string, ImagePart>,
  describer?: ImageDescriber,
): Promise<AicoMessage[]> {
  if (!messages.some(m => m.role === 'user' && m.imageRefs?.length)) return messages;

  if (!modelAccepts(model, 'image', settings)) {
    const reason = explainRefusal(model, 'image', settings)
      ?? 'this model does not read images';
    const described = describer
      ? await describeImagesWith(describer, messages.flatMap(m => (m.role === 'user' ? m.imageRefs ?? [] : [])), resolve, cache)
      : new Map<string, string>();
    return messages.map((message) => {
      if (message.role !== 'user' || !message.imageRefs?.length) return message;
      const notes = message.imageRefs
        .map(ref => (described.has(ref.id)
          ? describedImageNote(ref, describer!.model, model, described.get(ref.id)!)
          : `[${ref.name ?? 'image'} was attached but not sent: ${reason}]`))
        .join('\n');
      return { ...message, content: `${message.content}\n\n${notes}` };
    });
  }

  if (!resolve) return messages;

  // Resolved once per run rather than once per step. A turn is many requests
  // and the bytes do not change between them; re-reading them from the store
  // on every step would make a screenshot cost more the longer the agent
  // worked on it.
  const wanted = messages
    .flatMap(m => (m.role === 'user' ? m.imageRefs ?? [] : []))
    .filter(ref => !cache.has(ref.id));
  // References the store answered for and said "not here" — as opposed to a
  // store that failed, which says nothing about whether the image exists.
  const unresolved = new Set<string>();
  if (wanted.length > 0) {
    try {
      // Answered positionally, so a resolver that cannot find one image says
      // so in that slot rather than returning a shorter list and silently
      // shifting every picture onto the wrong message.
      const parts = await resolve(wanted);
      wanted.forEach((ref, index) => {
        const part = parts[index];
        if (part) cache.set(ref.id, part);
        else unresolved.add(ref.id);
      });
    } catch {
      // An unreadable attachment is not worth losing the turn over. The
      // message keeps its text and the model is simply not shown the picture.
    }
  }

  return budgetImages(messages.map((message) => {
    if (message.role !== 'user' || !message.imageRefs?.length) return message;
    const images = message.imageRefs
      .map(ref => cache.get(ref.id))
      .filter((part): part is ImagePart => part !== undefined);
    /*
      A reference nothing could resolve says so.

      Most often an image a tool produced in an earlier run that had no store
      to keep it — the CLI, a sub-agent — so the bytes lived in memory and are
      gone. The line beside it still reads "[Image from Read …]", and without
      this a model would take the label for the picture and describe an image
      it was not shown.
    */
    const lost = message.imageRefs.filter(ref => unresolved.has(ref.id));
    const content = lost.length > 0
      ? `${message.content}\n\n${lost.map(ref => `[${ref.name ?? 'image'} is no longer available to show]`).join('\n')}`
      : message.content;
    if (images.length === 0) return content === message.content ? message : { ...message, content };
    return { ...message, content, images };
  }));
}

/**
 * Base64 bytes of images one request may carry.
 *
 * Images used to last a single turn, so their cost was paid once. Now that
 * they persist, every picture in a session is re-sent on every step of every
 * turn — and an agent that works for twenty steps pays for the reader's ten
 * screenshots twenty times over.
 *
 * The lever is bytes rather than a count, because a count treats a phone photo
 * and a cropped error dialog as the same thing. Roughly three to eight
 * full-size screenshots, which is more than any one question needs and few
 * enough that a long session does not quietly become expensive.
 */
const MAX_REQUEST_IMAGE_BYTES = 12 * 1024 * 1024;

/**
 * Drop the oldest images until the request fits, and say that they were dropped.
 *
 * Oldest first, because the picture being discussed is almost always the most
 * recent one — and the older ones have usually been described in the replies
 * that followed them, so the conversation still carries what they showed.
 *
 * The most recent image is never dropped, even alone over budget. A request
 * that silently contains no picture at all is worse than an expensive one: the
 * reader asked about something they can see and would get an answer about
 * nothing, with no indication why.
 *
 * Each dropped image leaves a line naming it, for the same reason the
 * capability refusal does. An image that vanishes without a word makes the
 * model's confusion inexplicable to the person reading along.
 */
export function budgetImages(
  messages: AicoMessage[],
  maxBytes: number = MAX_REQUEST_IMAGE_BYTES,
): AicoMessage[] {
  const total = messages.reduce(
    (sum, m) => sum + (m.role === 'user' ? (m.images ?? []).reduce((n, i) => n + i.data.length, 0) : 0),
    0,
  );
  if (total <= maxBytes) return messages;

  // Walked backwards, so "keep" means "most recent", and the first image is
  // admitted before the budget is consulted at all.
  let kept = 0;
  const keep = new Set<AicoMessage>();
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!;
    if (message.role !== 'user' || !message.images?.length) continue;
    const size = message.images.reduce((n, image) => n + image.data.length, 0);
    if (kept === 0 || kept + size <= maxBytes) {
      kept += size;
      keep.add(message);
    }
  }

  return messages.map((message) => {
    if (message.role !== 'user' || !message.images?.length || keep.has(message)) return message;
    const notes = message.images
      .map(image => `[earlier image${image.name ? ` ${image.name}` : ''} omitted to stay `
        + 'within this request’s image budget; it was described in the replies that followed]')
      .join('\n');
    const { images: _dropped, ...rest } = message;
    return { ...rest, content: `${message.content}\n\n${notes}` };
  });
}

// ── Main agent function ──────────────────────────────────────────────

/**
 * Run one turn.
 *
 * A thin wrapper that establishes the run context and then does the work. The
 * `cwd` in that context is what every file tool resolves against, so this is
 * the seam that lets one process drive sessions in several different projects
 * at once — the browser client's whole reason for existing. It defaults to
 * `process.cwd()`, which is what the CLI has always meant by "here".
 */
export async function runAgent(rawOpts: AgentOptions): Promise<string> {
  // The organisation's run gate (ADR 0035): an unreadable policy file, or an
  // engine older than the policy requires, means no run at all — said in the
  // policy's own words rather than as a mystery failure further in.
  const policyRefusal = runRefusal(engineVersion());
  if (policyRefusal) throw new PolicyError(policyRefusal, 'run-gate');
  // The user's message is scanned for secrets, and every callback that leaves
  // this run is wrapped by the vault redactor. See vault/agent-hooks.
  const guarded = await guardAgentRun(rawOpts);
  // A named agent's autonomy ceiling, and the delegating run's level, turn
  // the engine's switches (plan mode, autoApprove, the asker) before anything
  // runs — agents/ceiling. Unbounded runs come back unchanged.
  const parentRun = currentRunContext();
  const ceiling = withPolicyCeiling(guarded.agentBounds?.autonomy);
  const opts = applyAutonomyCeiling(guarded, {
    ceiling,
    ...(parentRun?.autonomy ? { parent: parentRun.autonomy } : {}),
    ...((guarded.onApprovalRequired ?? parentRun?.approve) ? { approve: guarded.onApprovalRequired ?? parentRun!.approve! } : {}),
    isRead: isReadOnlyBuiltin,
    tty: Boolean(process.stdin.isTTY),
  });
  // The autonomy level: this run's own, never above the delegating run's
  // (a child cannot raise it), else inherited. See autonomy/levels.
  const own = opts.autonomy && parentRun?.autonomy ? minLevel(opts.autonomy, parentRun.autonomy)
    : opts.autonomy ?? parentRun?.autonomy;
  // The agent's ceiling lowers it, and is what children inherit. A ceiling of
  // L3 or L4 on a run with no stated level adds nothing: it must never turn a
  // chat into an unattended (parking) run.
  let level = !ceiling ? own
    : own ? minLevel(own, parseLevel(ceiling))
      : ceilingLevel({ requested: requestedLevel(guarded), ceiling }) === 'L3' ? undefined
        : ceilingLevel({ requested: requestedLevel(guarded), ceiling });
  /*
    The L4 gate (design §6.4, Phase 4): a named agent runs unattended only with
    a certificate for exactly what it is now — its file, skills, tools, MCP
    pins and this model. Otherwise it runs at L3, which with nobody there
    refuses what L4 would have parked, and the result says why. The
    orchestrator itself is not an agent definition and is not gated here.
  */
  let gateNotice: string | undefined;
  if (level === 'L4' && guarded.agentBounds?.name) {
    const { isCertified } = await import('./evals/certificate.js');
    const cert = await isCertified(guarded.agentBounds.name, { cwd: opts.cwd ?? process.cwd(), model: opts.model });
    if (!cert.ok) {
      level = 'L3';
      gateNotice = `[Ran at L3, not L4: unattended runs need a certified agent, and ${guarded.agentBounds.name} is ${cert.reason}. `
        + `Calls that needed a person were refused, not parked. Certify it with \`aico agent certify ${guarded.agentBounds.name}\`.]`;
    }
  }
  const harness = opts.evalHarness ?? parentRun?.evalHarness;
  const result = await runInContext(
    {
      cwd: opts.cwd ?? process.cwd(),
      model: opts.model,
      // The app this session is building, so the gates judge it and not the
      // workspace around it. See projectRoot().
      ...(opts.app ? { app: opts.app } : {}),
      ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
      ...(opts.settings ? { settings: opts.settings } : {}),
      // Who applies this run's writes. Undefined means the filesystem, which is
      // every run except one driven from an editor that can do better.
      ...(opts.applyEdit ? { applyEdit: opts.applyEdit } : {}),
      // Which editor, if any, this run can ask to do things it cannot.
      ...(opts.host ? { host: opts.host } : {}),
      // Who answers this run's questions: its own channel, else the delegating run's (concurrent runs must not share one).
      ...((opts.onAskUser ?? parentRun?.askUser) ? { askUser: (opts.onAskUser ?? parentRun!.askUser)! } : {}),
      // The browser copilot's way to hand work to a full chat; absent elsewhere.
      ...(opts.handOff ? { handOff: opts.handOff } : {}),
      /*
        How hard to think, for the providers that can be asked.

        `effort` already existed and only ever reached the *prompt* — wording
        telling the model to be thorough or brief. It never reached the request,
        so a reasoning model was asked in prose to think less while still being
        sent `reasoning_effort: high`. On the run context it now reaches both.
      */
      ...(isEffortChoice(opts.effort) ? { effort: opts.effort } : {}),
      // A person to ask for custom-tool approvals: this run's own channel, else
      // the delegating run's (this call runs inside the parent's context).
      ...((opts.onApprovalRequired ?? currentRunContext()?.approve)
        ? { approve: opts.onApprovalRequired ?? currentRunContext()!.approve! } : {}),
      // The level worked out above (ceiling, parent, certification).
      ...(level ? { autonomy: level } : {}),
      ...((opts.parkFrom ?? parentRun?.parkFrom) ? { parkFrom: opts.parkFrom ?? parentRun!.parkFrom! } : {}),
      ...(harness ? { evalHarness: harness } : {}),
      // Starts tainted when the delegating run already is; see RunContext.taint.
      taint: { tainted: Boolean(parentRun?.taint?.tainted), ...(parentRun?.taint ? { parent: parentRun.taint } : {}) },
      // This run's own log, for the two record events the change packet reads (ADR 0034).
      ...(opts.session ? { sessionLog: sessionLogHandle(opts.session) } : {}),
      // What the person asked for — the Sentinel's only authority. A delegated
      // run inherits its root's rather than trusting the brief it was given.
      userRequests: parentRun?.userRequests ?? userRequestsOf(opts.session?.events, opts.conversationHistory, opts.task),
      /*
        Where images a tool produces go. Created per run so a sub-agent's Read
        of a diagram lands in the sub-agent's own requests, and gated on this
        run's model — the one that will be asked to look.
      */
      toolImages: createToolImageSink({
        model: opts.model,
        ...(opts.settings ? { settings: opts.settings } : {}),
        ...(opts.storeImage ? { store: (image: ToolImageBytes) => opts.storeImage!(image) } : {}),
      }),
    },
    () => runAgentInContext(opts),
  );
  // The final text goes to a background registry, a parent's Task result, a
  // cron log or a terminal — all sinks.
  return sinkRedactText(gateNotice ? `${gateNotice}\n\n${result}` : result);
}

async function runAgentInContext(opts: AgentOptions): Promise<string> {
  const {
    task,
    model,
    filePath,
    showPlan,
    autoApprove,
    verbose,
    conversationHistory,
    tokenTracker,
    settings,
    silent = false,
    onToolCall,
    onToolDone,
    onChunk,
    onReasoning,
    onTokens,
    onPermissionRequest,
    onAskUser,
  } = opts;

  // Wire AskUser callback so the tool handler can reach Ink UI
  if (onAskUser) setAskUserCallback(onAskUser);
  // The process-wide fallback is the top-level run's alone. A sub-agent's
  // session is on its run context, which ends with it; written here too, it
  // outlived the sub-agent and the parent's next WorkspaceWrite landed in
  // `sessions/sub-…`.
  if ((opts.depth ?? 0) === 0) setWorkspaceRuntime({ settings, sessionId: opts.sessionId });
  // Where a background agent's report lands when no server installed a
  // delivery (agents/report-back): this conversation's inbox.
  if ((opts.depth ?? 0) === 0 && opts.sessionId && opts.inbox) rememberSessionInbox(opts.sessionId, opts.inbox);

  // Wire bash default timeout from settings
  if (settings?.bashTimeout !== undefined) {
    setBashDefaultTimeout(settings.bashTimeout);
  }

  const depth = opts.depth ?? 0;
  const toolProfile = selectToolProfile(task);

  /*
    What this run may use: whatever its delegator could, narrowed by its own
    list. One value, handed to the schemas, the dispatch guard and every child
    this run spawns — see `agents/effective`.
  */
  // A named agent adds its deny list, its MCP-server bound, its delegation
  // rule and its write paths (agents/resolve `boundsOf`), all inherited by
  // every child it spawns.
  const bounds = opts.agentBounds;
  const scope = agentRunScope({ ...opts, cwd: currentCwd() });

  /*
    MCP servers offered on demand (`mcp:<server>` groups, `tools/deferred`):
    wherever on-demand groups apply at all — deferral on, the whole built-in
    set handed over — and never for a browser-QA run, whose point is the
    Playwright tools. Decided here because the system prompt needs it: a
    deferred server's instructions arrive with its `LoadTools` result instead
    of on every request.
  */
  const mcpDeferral = settings?.deferTools !== false && toolProfile !== 'browser-qa' && isWholesale({
    ...(opts.context?.get('tools') ? { toolRegistry: opts.context.get('tools')! } : {}),
    ...(opts.agentSpecTools ? { agentSpecTools: opts.agentSpecTools } : {}),
    ...(opts.agentType ? { agentType: opts.agentType } : {}),
  });

  // This run's project's skills (`.aico/skills`, `.agents/skills`) — read from
  // disk per project, so they survive a restart and belong to the run's
  // directory rather than the server's. Before the catalogue is rendered.
  await skillRegistry.ensureProject().catch(() => undefined);

  // ── System prompt ──────────────────────────────────────────────────
  // Built as a document, not a string: it is rendered below in whatever shape
  // the resolved provider's vendor documents as best (XML for Anthropic,
  // Markdown for the rest). The content is authored once regardless.
  const promptDoc = await buildSystemPrompt(
    model, opts.effort, opts.projectInstructions, opts.goal,
    // Held to 1% of the model's window, at most 2,000 tokens (design §4.5).
    skillCatalogue({ contextWindow: getContextWindow(model, settings) }), opts.planMode,
  );

  // Added after the base prompt so it reads as a narrowing of the role rather
  // than a replacement for it: the agent still gets the tool contracts, the
  // verification rules and the skill catalogue, and then is told which
  // specialist it is while doing all that.
  if (opts.agentPersona) {
    promptDoc.add({
      id: 'agent_persona',
      body: [
        `You are the "${opts.agentPersona.name}" agent for this entire conversation — the person `
        + 'chose you specifically, not the general orchestrator.',
        '',
        // Said explicitly because everything above this is written for a
        // general-purpose agent told to be useful, and without an ordering rule
        // the model resolves that conflict by being useful — which is exactly
        // how a specialist ends up answering anything put to it.
        'Where the instructions above describe a general-purpose assistant that takes on any task, '
        + 'the specification below narrows it, and the specification wins. Being broadly helpful is '
        + 'not the goal here; being this specialist is.',
        '',
        opts.agentPersona.instructions,
      ].join('\n'),
    });
  }
  const memorySplit = splitMemories(activeMemories(currentCwd(), opts.sessionId));
  const runtime = buildRuntimeBlocks({
    model,
    cwd: process.cwd(),
    sessionId: opts.sessionId,
    settings,
    tools: (opts.agentType ? getToolsForAgent(opts.agentType) : toolDefinitions).map((t) => ({
      name: t.name,
      description: t.description,
    })),
    // A deferred server's instructions ride in its LoadTools result instead.
    mcpServers: mcpRegistry.getServerInfos().map(s =>
      mcpDeferral && isDeferredMcpServer(s.name) ? { ...s, instructions: undefined } : s),
    workspace: getWorkspaceInfo({ settings, sessionId: opts.sessionId }),
    agents: await listAgentSpecs(),
    skills: skillRegistry.list(),
    cronJobs: cronScheduler.getJobs(),
    backgroundAgents: getBackgroundAgents(),
    subAgents: getAgentRegistry(),
    // Everything remembered that applies to this directory and this
    // conversation. Read at build time rather than cached: a memory saved
    // during a turn should be in effect on the next one, not next launch.
    // Above 30 memories (ADR 0018) only pinned and global ones stay here; the
    // rest are recalled per turn into the tail (`recalled_memory` below).
    memories: memorySplit.prefix.map(m => ({
      id: m.id, scope: m.scope, text: m.text,
    })),
  });
  /*
    The stable half of the runtime facts goes into the cached prefix.

    These used to ride in the tail with the git status, on the theory that the
    roster changes. It does not, within a session — and the tail is paid on
    every step of every turn, which for a forty-step build meant forty copies
    of the same twelve hundred tokens. A memory saved mid-session or a cron job
    added does move the prefix once; that one miss is cheaper than the certain
    cost of resending it every step.
  */
  promptDoc.add({ id: 'runtime', order: 34, body: runtime.runtime });
  promptDoc.add({ id: 'operating_processes', order: 36, body: runtime.operatingProcesses });
  /*
    A sub-agent's reader is its parent, not a person looking at a chat. The
    rendered-block catalogue (~1.4K tokens) and the prose-style note shape a
    reply someone reads in a UI; a delegated report is read by a model as a
    tool result. Every child paid for them uncached on its first request, and
    Investigate paid once per angle.
  */
  if (depth > 0) {
    promptDoc.remove('rendered_blocks');
    promptDoc.remove('output_style');
  }
  if (runtime.remembered) promptDoc.add({ id: 'remembered', order: 848, body: runtime.remembered });
  /*
    What this project is and how it is run, from `.aico/profile.json`.

    In the cached prefix, never fetched by tool: the commands are needed on
    every turn that changes source, and a tool step costs twenty to fifty times
    what the cached read does. Rendered without ports so a dev server on a new
    port does not move the prefix. Snapshotted per turn — a command the observer
    records mid-turn appears on the next one.
  */
  const profileText = renderProfile(loadProfile(projectRoot()));
  if (profileText) promptDoc.add({ id: 'project_profile', order: 845, body: profileText });

  // ── Volatile context ───────────────────────────────────────────────
  // Everything here changes between turns or steps: the working tree moves
  // whenever the agent writes a file, MCP health can change, the QA note
  // depends on the task, and an app's process starts and stops mid-build. None
  // of it can sit in `systemPrompt` — system renders before messages, so a byte
  // of churn there invalidates the cached transcript behind it, which for a
  // coding agent is most turns. It is delivered at the tail of the request
  // instead, where it invalidates nothing. See ProviderChatOptions.volatileContext.
  //
  // Kept small on purpose: the tail is paid in full on every step.
  const volatileDoc = new PromptDocument()
    .add({ id: 'working_tree', body: await buildVolatileContext() });
  if (runtime.mcpHealth) volatileDoc.add({ id: 'mcp_health', body: runtime.mcpHealth });
  // What the caller knows moves mid-turn and the loop cannot see — the state
  // of the app a bound session is building, for one.
  for (const section of opts.volatileSections ?? []) volatileDoc.add(section);

  // What is still running, and what settled without anyone being told.
  //
  // Empty — and therefore absent — whenever nothing is in flight, which is most
  // turns. Placed late so it sits near the request rather than behind the
  // roster: a background agent that failed while the user was away is context
  // for what they are about to ask, not an inventory item.
  const runningWork = renderRunningWork({
    ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
  });
  if (runningWork) volatileDoc.add({ id: 'running_work', body: runningWork, order: 900 });

  // A skill whose trigger matches this request is named as a match rather than
  // left sitting in a list of twenty descriptions. "Prefer a skill when one
  // fits" is easy to write in a prompt and easy to skim past; pointing at the
  // specific skill that fits, in the volatile tail where the request itself
  // lives, is the version that acts. It stays a recommendation — the model can
  // still decide the skill is wrong for this case, which is why the wording
  // says consider rather than must.
  //
  // Sent once: on the first step of this turn only (stripped from the tail
  // below once a request carrying it has completed), and never again in this
  // session for a skill already suggested or opened (`skillsToSuggest`). The
  // tail is re-sent every step, and a model asked the same question every step
  // answers it every step — a real bug-fix turn declined app-design in twelve
  // of eighteen replies. Declining is silent: no "say so" asking for a reply.
  const matched = skillsToSuggest(task);
  if (matched.length > 0) {
    volatileDoc.add({
      id: 'matching_skills',
      body: [
        'These installed skills declare that they are for requests like this one:',
        ...matched.map(s => `- ${s.frontmatter.name}: ${s.frontmatter.description}`),
        'If one fits, open it with Skill before working the procedure out yourself; if none does, ignore this note.',
      ].join('\n'),
    });
  }

  // Knowledge whose trigger matches this task, attached the same way and for
  // the same reason: it varies per turn. In the system prompt it would change
  // the prefix of every message behind it and re-bill the whole transcript —
  // so the feature built to spend fewer tokens would spend more. Bounded in
  // `renderKnowledge`, because it is paid in full here rather than read from
  // cache.
  //
  // Honours `disabledTools`: switching the tool off switches the feature off,
  // rather than leaving entries silently attaching with no way to inspect them.
  if (!settings?.disabledTools?.includes('Knowledge')) {
    const known = renderKnowledge(matchKnowledge(await loadKnowledge(currentCwd()), task, currentCwd()));
    if (known) volatileDoc.add({ id: 'knowledge', body: known });
  }

  // Memories beyond the prefix (a store over 30 entries, ADR 0018): the ones
  // relevant to this request, about 600 tokens at most, in the tail for the
  // same reason as knowledge. Empty — and absent — for a small store.
  if (memorySplit.ranked.length) {
    const embedder = embedderFromSettings(settings, model);
    const recalled = await recalledMemoryBlock(memorySplit.ranked, task, {
      cwd: currentCwd(), ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
      ...(embedder ? { embedder } : {}), signal: AbortSignal.timeout(4_000),
    });
    if (recalled) volatileDoc.add({ id: 'recalled_memory', body: recalled });
  }

  // How this user works — rules they accepted (learning/preferences.ts, ADR
  // 0016). In the tail for the same reason as knowledge: which rules apply
  // depends on the project and the task, and the set changes when one is
  // accepted. Capped at 400 tokens, most relevant first.
  if (settings?.learning?.preferences !== false) {
    const prefs = preferencesForTask(currentCwd(), task);
    if (prefs) volatileDoc.add({ id: 'user_preferences', body: prefs });
  }

  // About the person (profile/inject.ts, ADR 0018): confirmed or confident
  // facts relevant to this task, ≤ 250 tokens, framed as context and never as
  // instructions. The top-level run only: never a sub-agent, never work
  // another program submitted over MCP, never a certification run.
  if (depth === 0 && !opts.agentType && !opts.evalHarness && opts.parkFrom?.origin !== 'remote') {
    const { readProfileSettings } = await import('./profile/service.js');
    if (readProfileSettings().enabled) {
      const { profileForTurn } = await import('./profile/inject.js');
      const about = profileForTurn(task, { skipPreferenceMirrors: settings?.learning?.preferences !== false });
      if (about) volatileDoc.add({ id: 'about_user', body: about });
    }
  }

  if (toolProfile === 'browser-qa') {
    volatileDoc.add({
      id: 'browser_qa_mode',
      body: `- Use Playwright MCP browser tools directly; do not delegate this browser session to a sub-agent.
- Move quickly: navigate, inspect accessibility snapshots, perform user flows, and report concrete defects.
- Prefer targeted browser actions over broad planning or codebase exploration.`,
    });
  }

  // ── Cancellation ───────────────────────────────────────────────────
  // Created here rather than beside the loop because tool-pipeline stages need
  // the signal in their call context; the timeout and caller-abort wiring is
  // still done below, once settings have been read.
  const loopController = new AbortController();
  const loopSignal = loopController.signal;

  // ── Build tool handler map ─────────────────────────────────────────
  // Guards keep per-agent state and the tool registry is process-wide, so the
  // identity below is what stops one agent's behaviour tripping another's
  // guard. Sub-agents get a distinct id via their own session/depth.
  const agentId = `${opts.sessionId ?? 'root'}#${depth}`;
  /** Tools already warned about partial confinement, so it is said once. */
  const partialWarned = new Set<string>();
  // A composed context may supply the policy pipeline too, so a deployment can
  // register stages (timeouts, metrics, approval) once and have every agent
  // inherit them.
  const pipeline = opts.context?.get('toolPolicy')?.pipeline ?? new ToolPipeline();
  const toolRegistry = opts.context?.get('tools');

  // Learn the project's commands from the ones that worked. Records only —
  // never denies — and writes at `observed` rank, below anything a person or a
  // template said. Idempotent by stage name, so a composed pipeline shared
  // across sessions carries one observer, not one per turn.
  installProfileObserver(pipeline, () => projectRoot());
  // A clean-room workspace (marked folder) narrows what any run in it can do; abstains everywhere else (ADR 0041).
  installCleanroomWall(pipeline, () => currentCwd(), () => projectRoot());

  /*
    Custom tools (custom-tools/): the enabled ones visible from this run's
    directory, narrowed exactly as built-ins are — plan mode and the browser
    copilot are offered only read tools, `disabledTools` and the agent's scope
    apply, and the narrowed profiles (repair, a browser-QA child) and composed
    registries get none. Not offered means no handler either. Their schemas are
    deferred per pack (`tools:<pack>`), like any on-demand group.
  */
  const runCwd = currentCwd();
  const copilotRun = Boolean(currentRunContext()?.handOff) && depth === 0;
  const customAll = toolProfile === 'repair' || (toolProfile === 'browser-qa' && depth > 0) || toolRegistry
    ? [] : await loadCustomTools(runCwd);
  const customTools = usableTools(customAll.filter(t => t.def
    && ((!opts.planMode && !copilotRun) || t.def.effect === 'read')
    && !settings?.disabledTools?.some(entry => entryMatches(entry, t.name))
    && scopeAllows(scope, t.name)));
  const customGroups: ToolGroup[] = [];
  for (const t of customTools.values()) {
    const existing = customGroups.find(g => g.id === groupIdOf(t));
    if (existing) (existing.tools as string[]).push(t.name);
    else customGroups.push({ id: groupIdOf(t), summary: 'custom tools', tools: [t.name] });
  }
  /*
    Every on-demand group beyond the built-in ones: custom tool packs, then
    MCP servers (`mcp:<server>`). One array, updated in place when the MCP set
    moves (`syncMcpTools`), so every deferral call below sees the same groups.
  */
  const extraGroups: ToolGroup[] = [...customGroups];
  const setMcpGroups = (tools: ReadonlyArray<{ name: string }>): void => {
    extraGroups.splice(customGroups.length, extraGroups.length, ...(mcpDeferral ? mcpToolGroups(tools) : []));
  };
  setMcpGroups(mcpRegistry.getToolsForAgent().filter(t => mcpToolAllowed(t.name, { scope, planMode: opts.planMode, settings })));
  // The taint rule (design §4.2): web or MCP content seen in this session,
  // read from the log and kept current as calls are dispatched.
  // A run delegated by a tainted run starts tainted (RunContext.taint).
  const taintCell = currentRunContext()?.taint;
  let tainted = Boolean(taintCell?.tainted)
    || (opts.session?.events ?? []).some(e => e.type === 'tool/call' && taints(String((e.data as { name?: string }).name ?? '')));
  if (tainted) markTainted(taintCell);
  // Who a custom tool's approval asks: this run's permission card, else the
  // always-ask channel (inherited by sub-agents), else the terminal. Nobody,
  // for a headless run — its calls that need a person are refused.
  const askPerson = opts.headless ? undefined
    : onPermissionRequest ? (title: string, detail: string) => onPermissionRequest(title, detail)
      : currentRunContext()?.approve ?? (process.stdin.isTTY ? ttyAsk : undefined);
  // L4 (unattended): such a call is parked for a person instead — the exact
  // call, its preview and hashes go to the inbox and the run carries on. The
  // context's level is already min(requested, agent ceiling, parent), so an
  // agent whose ceiling is below L4 never parks (design §4.2).
  const runLevel = currentRunContext()?.autonomy;
  const parkFrom = currentRunContext()?.parkFrom ?? { origin: (opts.headless ? 'background' : 'chat') as ActionOrigin };
  const park: CustomToolStageOptions['park'] = runLevel === 'L4' && !opts.planMode
    ? async (call) => {
      const parked = parkAction({
        ...call, cwd: runCwd, agentId, origin: parkFrom.origin,
        ...(parkFrom.label ? { label: parkFrom.label } : {}),
        ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
        // A named agent's call is replayed only while its certificate still holds.
        ...(bounds?.name ? { agentName: bounds.name, agentModel: model } : {}),
      });
      return 'error' in parked ? parked : { id: parked.id };
    }
    : undefined;

  // Shell confinement (ADR 0027): writes outside the project, downloads,
  // global installs and running what was downloaded need a person at every
  // level. The note goes on the permission card; the guard is installed
  // before the Sentinel, below.
  const shellConfinement = createShellConfinement({
    agentId, cwd: () => runCwd, settings, ask: askPerson,
    unattended: runLevel === 'L4' || Boolean(opts.headless),
    approvedKey: HUMAN_APPROVED,
    sessionId: opts.sessionId,
  });

  const handlerOpts: ToolHandlerOpts & { toolProfile: AgentToolProfile; agentSpecTools?: string[] | 'all' | 'readonly'; depth?: number } = {
    shellConfinement,
    autoApprove, verbose, settings, onToolCall, onToolDone,
    onPermissionRequest, onAskUser, silent,
    agentType: opts.agentType, planMode: opts.planMode, toolProfile,
    agentId, pipeline, signal: loopSignal, depth,
    ...(toolRegistry ? { toolRegistry } : {}),
    ...(opts.agentSpecTools ? { agentSpecTools: opts.agentSpecTools } : {}),
    // Only when it restricts something, so an unrestricted run's pipeline is
    // exactly what it was.
    ...(scope.layers.length > 0 || !scope.delegate ? { scope } : {}),
    ...(customTools.size > 0 ? {
      customTools: {
        agentId, sessionKey: opts.sessionId ?? agentId, tools: customTools, autoApprove,
        ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
        ...(opts.planMode ? { planMode: true } : {}),
        ...(askPerson ? { ask: askPerson } : {}),
        ...(park ? { park } : {}),
        tainted: () => tainted,
        cwd: () => runCwd,
      },
    } : {}),
  };
  const { handlers, wrap: wrapInPipeline } = buildToolHandlers(handlerOpts);

  /*
    Long jobs (longjob/), for the conversation itself — never a sub-agent.

    ProposePlan is the sizing step: an estimate above the threshold records a
    proposal instead of a plan, the loop ends the turn on it (below), and this
    guard refuses everything that is not read-only until a *person* answers it
    through the decision gate. Deny-only, like every stage. A chat message is
    not an answer: it is exactly what a model talking itself into starting
    would produce. Below the threshold nothing here changes anything.
  */
  const jobSession = depth === 0 ? opts.sessionId : undefined;
  const longJob = jobSession ? activeJob(jobSession) : undefined;
  if (jobSession) {
    handlers.set('ProposePlan', wrapInPipeline('ProposePlan', async (call) => {
      const args = call.arguments as Record<string, unknown>;
      if (isLongEstimate(args.estimate_hours, settings)) {
        return proposalResult(propose(args, { sessionId: jobSession, cwd: runCwd }), settings);
      }
      const out = await proposePlan(args as unknown as PlanInput);
      const waiting = pendingJob(jobSession);
      return waiting
        ? `${out} The long-job proposal ${waiting.id} is still waiting for the person; a smaller plan does not replace it.`
        : out;
    }));
    if (longJob) handlers.set('LongJob', wrapInPipeline('LongJob', (call) => longJobTool(call.arguments, { sessionId: jobSession })));
    pipeline.onGuard('long-job', (ctx) => {
      if (ctx.agentId !== agentId) return { kind: 'abstain' };
      if (isReadOnlyBuiltin(ctx.name) || ctx.name === 'ProposePlan' || ctx.name === LOAD_TOOLS || ctx.name === 'AskUserQuestion') return { kind: 'abstain' };
      // Bash is refused whole, read-only or not: the classifier is a plan-mode
      // convenience (it passes `node -e …`), and this gate is a promise.
      if (isMcpToolName(ctx.name) && isReadOnlyMcpTool(ctx.name)) return { kind: 'abstain' };
      const waiting = pendingJob(jobSession);
      if (!waiting) return { kind: 'abstain' };
      return {
        kind: 'deny',
        reason: `The long-job proposal ${waiting.id} ("${waiting.title}") is waiting for the person to approve or decline it in the AICO window. `
          + 'Until they do, nothing that changes files or runs commands happens in this session; a chat message does not approve it. Stop and wait.',
      };
    });
  }

  /*
    On-demand tool groups (see `tools/deferred.ts`): what this session has
    loaded, read from its own log and from whoever delegated this run, and
    grown as calls are dispatched. Undefined switches deferral off — every
    schema is offered, as before.

    Handlers above are built for every tool regardless; only the schemas the
    model is shown depend on this set.
  */
  const loadedGroups: Set<string> | undefined = settings?.deferTools === false
    ? undefined
    : new Set([
      ...loadedGroupsFromLog(opts.session?.events, extraGroups), ...(opts.toolGroups ?? []),
      // This turn's request, before it is in the log (the loop records it later).
      ...groupsForRequest(task),
      // An agent's own MCP servers are loaded eagerly (design §5.4).
      ...(bounds?.mcpServers ?? []).map(server => `mcp:${server}`),
    ]);
  if (loadedGroups) {
    handlers.set(LOAD_TOOLS, async (args: Record<string, unknown>, callId: string) => {
      if (!silent) showToolCall(LOAD_TOOLS, args, verbose);
      onToolCall?.(LOAD_TOOLS, args, callId);
      // A deferred MCP server's own instructions arrive with its tools.
      const wanted = Array.isArray((args as { groups?: unknown }).groups) ? ((args as { groups: unknown[] }).groups).map(String) : [];
      const manuals = mcpRegistry.getServerInfos()
        .filter(s => s.instructions && wanted.includes(`mcp:${s.name}`) && extraGroups.some(g => g.id === `mcp:${s.name}`))
        .map(s => `\n<mcp_server_instructions server="${s.name}">\n${s.instructions}\n</mcp_server_instructions>`);
      const result = executeLoadTools(args as { groups?: unknown }, extraGroups) + manuals.join('');
      onToolDone?.(LOAD_TOOLS, result, callId);
      return { result };
    });
  }

  // The credential vault's guard (its files and key stores are off limits to
  // tools) and its shell-placeholder binding. A person approves shell uses:
  // the process-wide prompter when a server or desktop set one, otherwise
  // this run's own permission dialog — never an unattended run's policy.
  const fallbackPrompter = !opts.headless && onPermissionRequest
    ? callbackPrompter((title, detail) => onPermissionRequest(title, detail))
    : !opts.headless && process.stdin.isTTY ? ttyPrompter() : undefined;
  installVaultStages(pipeline, {
    cwd: () => currentCwd(),
    ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
    ...(fallbackPrompter ? { fallbackPrompter } : {}),
  });
  // The ops tools (SSH, HTTP APIs, WinRM, SNMP) ask the same person the same
  // way when a use needs approval and no process-wide prompter is set.
  installOpsStages(pipeline, {
    ...(fallbackPrompter ? { fallbackPrompter } : {}),
  });
  // Custom tools: dispatched through the same pipeline as every built-in, so
  // hooks, scope, plan mode, their own argument and approval guards, the vault
  // stages and redaction all apply; the result is capped at the tool's own
  // `output.maxChars` with the overflow kept.
  for (const t of customTools.values()) {
    handlers.set(t.name, wrapInPipeline(t.name, async (call) => spillResult(
      await runCustomTool(t.def, call.arguments, {
        cwd: runCwd,
        ...(call.signal ? { signal: call.signal } : {}),
        ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
        ...(fallbackPrompter ? { prompter: fallbackPrompter } : {}),
      }),
      t.def.output?.maxChars ?? DEFAULT_MAX_CHARS, t.name, call.callId)));
  }

  // Loop-breaker. Advisory only: it never vetoes a call, it injects an
  // escalating reminder when the model repeats one verbatim. Registered after
  // the hook stage so a hook's own view of the result is unaffected. Disabled
  // for sub-agents, which are short-lived and return to an orchestrator that
  // can judge repetition itself.
  const repeatGuard = settings?.repeatGuard?.enabled === false || depth > 0
    ? undefined
    : new RepeatToolGuard(settings?.repeatGuard ?? {});
  repeatGuard?.install(pipeline);

  // An agent's `paths.write`, and every delegator's: AICO's file tools only
  // (Bash is not bound — agents/paths-guard says so, and so does the summary).
  if (scope.writeBounds?.length) {
    installWritePathsGuard(pipeline, { agentId, bounds: scope.writeBounds, cwd: () => runCwd });
  }

  // File-effect confinement. Registered as a monotonic guard so no later stage
  // can turn a sandbox refusal into an approval, and inherited by sub-agents
  // through `settings` — a confined parent must not delegate an escape.
  // Default is danger-full-access, preserving existing behaviour for anyone who
  // has not opted in.
  const sandboxMode = settings?.sandbox?.mode ?? 'danger-full-access';
  if (sandboxMode !== 'danger-full-access') {
    const sandbox = opts.context?.get('sandbox') ?? new LocalSandbox();
    const policy = resolveSandboxPolicy(
      sandboxMode,
      process.cwd(),
      settings?.sandbox?.additionalWritableRoots,
    );
    installSandboxGuard(pipeline, {
      sandbox,
      policy,
      ...(settings?.sandbox?.warnOnPartial === false ? {} : {
        onPartialEnforcement: (toolName, reason) => {
          // Surfaced once per run, not once per call: repeating it on every
          // Bash invocation would train the user to ignore it.
          if (partialWarned.has(toolName) || silent) return;
          partialWarned.add(toolName);
          showError(`Sandbox: ${toolName} is only partially confined — ${reason}`);
        },
      }),
    });
  }

  /*
    The Sentinel (sentinel/, ADR 0015): an independent model reviews this
    run's high-risk calls and can only refuse them or hand them to a person.
    Registered last among the guards, so a call a deterministic stage refuses
    never costs a review. `stepIntent` is the agent's text in the step that
    made the call, set in the loop below.

    Off in two runs on purpose: a certification run (`evalHarness`) measures
    the agent itself, and a reviewer would hide the very failures the safety
    pack looks for; and a run whose provider is the injected test seam
    (`opts.provider`) has no reviewer to pair with unless its settings name
    one (`sentinel`), so the offline suites stay offline.
  */
  let stepIntent = '';
  const runRequests = currentRunContext()?.userRequests ?? [task];
  const sentinelPossible = !currentRunContext()?.evalHarness && !(opts.provider && !settings?.sentinel);
  // Deterministic, so before the reviewer: a call it refuses costs no review,
  // and a person's yes here (HUMAN_APPROVED) is not asked again there.
  shellConfinement.install(pipeline);
  // Supply chain and change safety (ADR 0033): deterministic like the line above, so before the reviewer.
  // A package the registry has never heard of, a secret about to be committed, a test deleted unattended.
  createSupplyChain({
    agentId, cwd: () => runCwd, settings, ask: askPerson, unattended: runLevel === 'L4' || Boolean(opts.headless),
    approvedKey: HUMAN_APPROVED, sessionId: opts.sessionId, record: runFindingSink(),
  }).install(pipeline);
  installChangeSafetyGuards(pipeline, {
    agentId, cwd: () => runCwd, enabled: () => settings?.completionGate?.changeSafety !== false,
    unattended: runLevel === 'L4' || Boolean(opts.headless), record: runFindingSink(), sessionId: opts.sessionId,
  });
  installSentinel(pipeline, {
    agentId,
    active: () => sentinelPossible && sentinelActive({
      settings: settings?.sentinel, level: runLevel, autoApprove, planMode: opts.planMode, headless: opts.headless, agentName: bounds?.name,
    }),
    // The `sentinel` role (ADR 0017): models.roles.sentinel, then
    // sentinel.model, then a different model from the agent's where one is
    // reachable. Nothing usable at all keeps the old default.
    model: (() => {
      const role = resolveRole('sentinel', { settings, mainModel: model });
      return role.ok ? role.model : defaultSentinelModel(model, settings?.sentinel);
    })(),
    ...(settings ? { settings } : {}),
    cwd: () => runCwd,
    tainted: () => tainted,
    // Read live: a steer the person sends while the run is busy is their
    // request too (a replay they asked for mid-run was refused without it).
    requests: () => mergeRequests(runRequests, userRequestsOf(opts.session?.events, undefined, undefined)),
    intent: () => stepIntent,
    recent: () => recentCallsOf(opts.session?.events),
    untrusted: () => untrustedSourcesOf(opts.session?.events, tainted),
    customEffect: (name) => customTools.get(name)?.def.effect,
    ...(askPerson ? { ask: askPerson } : {}),
    ...(park ? { park: sentinelParker(customTools, park, runCwd, opts.sessionId) } : {}),
    unattended: runLevel === 'L4' || Boolean(opts.headless),
    onEscalate: opts.sentinelEscalation ?? settings?.sentinel?.onEscalate ?? 'ask',
    ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
    ...(bounds?.name ? { agentName: bounds.name } : {}),
    ...(runLevel ? { level: runLevel } : {}),
  });
  /*
    The file tools may not write AICO's own settings, hooks, tools, agents or
    trust files unless a person approved this exact call (the Sentinel's
    escalation sets HUMAN_APPROVED). Registered after the Sentinel so its
    approval is visible here; scoped to this run like the Sentinel.
  */
  pipeline.onGuard('aico-config-write', (ctx) => {
    if (ctx.agentId !== agentId) return { kind: 'abstain' };
    if (ctx.state.get(HUMAN_APPROVED) === true) return { kind: 'abstain' };
    const denial = configWriteDenial(ctx.name, ctx.arguments, aicoHome(), runCwd);
    return denial ? { kind: 'deny', reason: denial } : { kind: 'abstain' };
  });

  /*
    A delivery task's run (ADR 0038) works in its own worktree on its own branch.
    Pushing, pulling, merging, switching branches or managing worktrees is refused
    for any run whose directory is inside one: the merge queue and a person land
    the work. A guard, not a prompt line: it holds however the model is asked.
  */
  if (isDeliveryWorktree(runCwd)) {
    pipeline.onGuard('delivery-run', (ctx) => {
      const denial = deliveryRunDenial(ctx.name, ctx.arguments as Record<string, unknown>, shellCommandOf(ctx.name, ctx.arguments), runCwd);
      return denial ? { kind: 'deny', reason: denial } : { kind: 'abstain' };
    });
  }

  // Add Task tool (sub-agent dispatch) if within depth limit. Browser QA
  // removes it for sub-agents only — see resolveToolSet on why depth 0 keeps
  // its tool set whole. An agent that may not delegate gets neither Task nor
  // Investigate — enforced here, not asked for in its prompt — and a child
  // inherits that.
  const mayDelegate = depth < 4 && (toolProfile !== 'browser-qa' || depth === 0) && scope.delegate;
  if (mayDelegate) {
    handlers.set(taskToolDefinition.name, async (args: Record<string, unknown>, callId: string) => {
      const {
        description, prompt, model: taskModel, subagent_type, agent_name, agent_spec, timeout,
        isolation, detach, acceptance_criteria, files, constraints, resume,
      } = args as {
        description: string; prompt: string; model?: string;
        subagent_type?: SubAgentType; agent_name?: string;
        agent_spec?: { instructions?: string; tools?: string[] | 'all' | 'readonly'; model?: string; role?: string };
        timeout?: number;
        isolation?: 'worktree';
        detach?: boolean;
        acceptance_criteria?: unknown; files?: unknown; constraints?: unknown;
        resume?: string;
      };
      onToolCall?.(taskToolDefinition.name, args, callId);
      // An agent's `delegate` rule: a list names the only agents it may hand
      // work to; `readonly` lets it delegate, but every child is read-only
      // (no Bash either — a command line can write). Enforced here, at the
      // one place a child is made — a resumed child included, by the name it
      // originally ran as.
      const rule = scope.delegateTo;
      const resuming = typeof resume === 'string' && resume.trim() ? resume.trim() : undefined;
      const childName = resuming ? agentResumeSpec(resuming)?.agentName : agent_name;
      if (Array.isArray(rule) && (!childName || !rule.includes(childName))) {
        const error = `This agent may delegate only to: ${rule.join(', ')} (its delegate rule). `
          + 'Call Task with agent_name set to one of those, or do the work yourself.';
        onToolDone?.(taskToolDefinition.name, { error }, callId);
        return { result: { error } };
      }
      const childScope = rule === 'readonly'
        ? narrowScope(scope, { layer: { label: 'its delegate rule (read-only children)', tools: readOnlyBuiltinNames(), mcp: 'readonly' } })
        : scope;
      try {
        // `isolation` and `detach` are in the tool's schema and implemented in
        // `runTask`, and were dropped right here — the model was offered both
        // and neither ever reached the child. The loop's signal goes along too:
        // without it, cancelling the parent waited for every child to finish.
        const raw = await runTask(
          {
            description, prompt, model: taskModel, subagent_type, agent_name, agent_spec, timeout,
            ...(isolation === 'worktree' ? { isolation } : {}),
            ...(detach === true ? { detach } : {}),
            ...(resuming ? { resume: resuming } : {}),
            // The model-facing call is held to the delegation contract; the
            // engine's own callers of runTask compose their briefs themselves.
            acceptance_criteria, files, constraints, contract: true,
          },
          {
            token: opts.token ?? '',
            model,
            autoApprove,
            verbose,
            depth,
            settings,
            abortSignal: loopSignal,
            ...(loadedGroups?.size ? { toolGroups: [...loadedGroups] } : {}),
            // Constraints the child must inherit — see the note in runTask.
            ...(opts.context ? { context: opts.context } : {}),
            ...(tokenTracker ? { tokenTracker } : {}),
            ...(opts.planMode ? { planMode: true } : {}),
            // The child's tools are intersected with these: it can never be
            // given more than this run has.
            toolScope: childScope,
            // Inside an approved long job a child may work longer (longjob/).
            ...(longJob ? { subagentMaxMs: subAgentMaxMs(settings) } : {}),
            onSubagentStart: opts.onSubagentStart,
            onSubagentStop: opts.onSubagentStop,
          },
        );
        // Bounded like every other tool's output. A child's final report came
        // back whole, so one verbose sub-agent could put more into the parent's
        // context than the parent's own work — the opposite of why the work
        // was delegated. The full report stays on disk, named in the excerpt.
        const result = spillResult(raw, SUBAGENT_RESULT_MAX_CHARS, 'Task', callId) as string;
        onToolDone?.(taskToolDefinition.name, { result }, callId);
        return { result: { result } };
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        onToolDone?.(taskToolDefinition.name, { error }, callId);
        return { result: { error } };
      }
    });

    // Fan-out shares Task's dispatch machinery and its depth limit, because it
    // is the same act: it spawns sub-agents. What it adds is that they are
    // read-only by construction, bounded in number, and refused when two ask
    // the same question — none of which a prompt can guarantee.
    if (!settings?.disabledTools?.includes('Investigate')) {
      handlers.set(investigateDefinition.name, async (args: Record<string, unknown>, callId: string) => {
        onToolCall?.(investigateDefinition.name, args, callId);
        try {
          const raw = await investigate(args as InvestigateInput, {
            token: opts.token ?? '',
            model,
            autoApprove,
            verbose,
            depth,
            settings,
            // Reaches every investigator, so a cancel stops the whole fan-out.
            abortSignal: loopSignal,
            ...(opts.context ? { context: opts.context } : {}),
            ...(tokenTracker ? { tokenTracker } : {}),
            ...(opts.planMode ? { planMode: true } : {}),
            toolScope: scope,
            onSubagentStart: opts.onSubagentStart,
            onSubagentStop: opts.onSubagentStop,
          });
          // Up to eight concatenated reports; bounded for the same reason as Task.
          const result = spillResult(raw, SUBAGENT_RESULT_MAX_CHARS * 2, 'Investigate', callId) as string;
          onToolDone?.(investigateDefinition.name, { result }, callId);
          return { result: { result } };
        } catch (err) {
          const error = err instanceof Error ? err.message : String(err);
          onToolDone?.(investigateDefinition.name, { error }, callId);
          return { result: { error } };
        }
      });
    }
  }

  /*
    `BackgroundTask` is a detached `Task` (ADR 0021).

    It used to go to `background/spawnBackgroundAgent` from the generic tool
    dispatch, which knows nothing about the run calling it: the child ran in
    the server's directory with the full tool set, outside plan mode, at depth
    0 (so the four-level cap never applied), on a token tracker of its own
    (so `maxCostPerSession` never saw its spend), in a ledger row with no
    session (so any other chat could see and stop it) — and its result reached
    nobody but the tray. Routed through `runTask` it inherits every bound a
    Task child does, and its report comes back into this conversation.
    Replaced whatever the dispatch built, so the tool name keeps working; an
    agent that may not delegate is refused here, not just not shown it.
  */
  if (handlers.has('BackgroundTask')) {
    handlers.set('BackgroundTask', wrapInPipeline('BackgroundTask', async (call) => {
      if (!mayDelegate) {
        return { error: 'BackgroundTask starts an agent, and this run may not delegate (depth limit, or canDelegate is off here or above). Do the work yourself.' };
      }
      const rule = scope.delegateTo;
      if (Array.isArray(rule)) {
        return { error: `This agent may delegate only to: ${rule.join(', ')} (its delegate rule). Use Task with agent_name and detach:true instead.` };
      }
      const a = call.arguments as { description?: unknown; prompt?: unknown; model?: unknown };
      const raw = await runTask(
        {
          description: String(a.description ?? 'background task').slice(0, 200),
          prompt: String(a.prompt ?? ''),
          ...(typeof a.model === 'string' && a.model.trim() ? { model: a.model.trim() } : {}),
          detach: true,
        },
        {
          token: opts.token ?? '',
          model, autoApprove, verbose, depth, settings,
          abortSignal: loopSignal,
          ...(loadedGroups?.size ? { toolGroups: [...loadedGroups] } : {}),
          ...(opts.context ? { context: opts.context } : {}),
          ...(tokenTracker ? { tokenTracker } : {}),
          ...(opts.planMode ? { planMode: true } : {}),
          toolScope: rule === 'readonly'
            ? narrowScope(scope, { layer: { label: 'its delegate rule (read-only children)', tools: readOnlyBuiltinNames(), mcp: 'readonly' } })
            : scope,
          ...(longJob ? { subagentMaxMs: subAgentMaxMs(settings) } : {}),
          onSubagentStart: opts.onSubagentStart,
          onSubagentStop: opts.onSubagentStop,
        },
      );
      return raw.startsWith('[error]') ? { error: raw.slice('[error] '.length) } : raw;
    }));
  }

  // Add MCP tools. A browser-QA sub-agent keeps only the Playwright tools; the
  // conversation itself keeps every MCP tool it had, so the tool set — and the
  // cache behind it — does not change because one message mentioned a URL.
  // Scope, plan mode and `disabledTools` apply to them as to built-ins.
  const currentMcpTools = () => mcpRegistry.getToolsForAgent().filter((t) =>
    (toolProfile === 'browser-qa' && depth > 0 ? t.name.startsWith('mcp__playwright__') : true)
    && mcpToolAllowed(t.name, { scope, planMode: opts.planMode, settings }),
  );
  let mcpTools = currentMcpTools();
  /*
    Through the same pipeline as every built-in: PreToolUse hooks, the scope and
    plan-mode guards, the permission prompt, the vault's guards and redaction,
    and PostToolUse. These calls used to go straight to the server, so `ask`
    mode never asked before an MCP tool that deletes, and a hook that blocks a
    tool could not see one. A throw becomes an error result in the pipeline,
    the same shape the old catch produced.
  */
  const installMcpHandler = (t: (typeof mcpTools)[number]) => {
    handlers.set(t.name, wrapInPipeline(t.name, async (call) =>
      // Same budget as before; the overflow is kept rather than cut.
      spillResult(await t.execute(call.arguments), 80_000, t.name, call.callId)));
  };
  for (const t of mcpTools) installMcpHandler(t);

  /*
    The ToolDef array for the provider, always in one canonical order:
    built-ins (less any unloaded on-demand group, plus LoadTools while one is
    left), then Task and Investigate, then MCP. Rebuilt in place when the MCP
    set or the loaded groups move, so the request after a change and the first
    request of the next turn are byte-identical — any order that differed
    between them would cost a second prefix miss for the same change.

    `depth` is passed so the schemas agree with the handlers: without it a
    sub-agent was shown Supervise (and, in a browser-QA child, every built-in)
    with no handler behind it.
  */
  const toolDefs: ToolDef[] = [];
  let builtGroups = loadedGroups ? [...loadedGroups].sort().join() : '';
  const rebuildToolDefs = (): void => {
    const next = buildToolDefs({
      agentType: opts.agentType, planMode: opts.planMode, toolProfile, depth,
      // A run nobody is attached to is not shown the tools that wait for one.
      // `resolveToolSet` has always honoured this; it was never passed, so a
      // background agent was offered AskUserQuestion and CredentialRequest.
      ...(opts.headless ? { headless: true } : {}),
      ...(toolRegistry ? { toolRegistry } : {}),
      ...(opts.agentSpecTools ? { agentSpecTools: opts.agentSpecTools } : {}),
      ...(settings ? { settings } : {}),
      ...(loadedGroups ? { loadedGroups } : {}),
      ...(handlerOpts.scope ? { scope: handlerOpts.scope } : {}),
      ...(extraGroups.length ? { customGroups: extraGroups } : {}),
    });
    // Task. The handler's own condition: at depth 0 a QA-shaped message keeps
    // the tool set whole (see resolveToolSet), so the schema must stay too —
    // dropping it there was the same cache break that rule exists to prevent.
    if (mayDelegate) {
      // Not for the browser copilot, which hands such work to a chat (COPILOT_WITHHELD).
      if (!(depth === 0 && currentRunContext()?.handOff)) {
        next.push({
          name: taskToolDefinition.name,
          description: taskToolDefinition.description,
          inputSchema: taskToolDefinition.inputSchema,
        });
      }
      // Same depth gate as Task, and the same reason: it spawns sub-agents.
      // Offered only where they can actually run, so the model is never shown a
      // fan-out it would be refused for using.
      if (!settings?.disabledTools?.includes('Investigate')) {
        next.push({
          name: investigateDefinition.name,
          description: investigateDefinition.description,
          inputSchema: investigateDefinition.inputSchema,
        });
      }
    }
    // Only while this session has an approved long job: ordinary sessions
    // never carry the schema (tools/long-job).
    if (longJob) next.push({ name: longJobDefinition.name, description: longJobDefinition.description, inputSchema: longJobDefinition.inputSchema });
    // A deferred server's schemas only once its `mcp:<server>` group is loaded.
    for (const t of mcpTools) {
      const group = loadedGroups ? extraGroups.find(g => g.id.startsWith('mcp:') && g.tools.includes(t.name)) : undefined;
      if (group && !loadedGroups!.has(group.id)) continue;
      next.push({ name: t.name, description: t.description, inputSchema: t.inputSchema });
    }
    // Custom tools last, in store order; a pack's schemas only once it is
    // loaded wherever deferral applies (a hand-picked list shows its own).
    const deferCustom = loadedGroups !== undefined && isWholesale({
      ...(toolRegistry ? { toolRegistry } : {}),
      ...(opts.agentSpecTools ? { agentSpecTools: opts.agentSpecTools } : {}),
      ...(opts.agentType ? { agentType: opts.agentType } : {}),
    });
    for (const t of customTools.values()) {
      if (deferCustom && !loadedGroups!.has(groupIdOf(t))) continue;
      next.push({ name: t.name, description: t.def.description, inputSchema: providerSchema(t.def) });
    }
    toolDefs.splice(0, toolDefs.length, ...next);
  };
  rebuildToolDefs();
  /**
   * Bring the MCP tools up to date with the registry, mid-turn.
   *
   * `McpAddServer` loads a server the moment it is called, and the reply says
   * "healthy, 24 tools" — but the tool list the model was shown was built at
   * the top of the turn, so the model guessed at names that did not exist and
   * fell back to writing its own driver. Now a step after the registry changed
   * offers, and can dispatch, what the registry holds. Returns whether the set
   * moved, so the caller can leave the definitions — and the cache behind them
   * — untouched on the steps where nothing did.
   */
  const syncMcpTools = (): boolean => {
    const now = currentMcpTools();
    const before = new Set(mcpTools.map(t => t.name));
    const after = new Set(now.map(t => t.name));
    if (before.size === after.size && [...before].every(n => after.has(n))) return false;
    for (const name of before) if (!after.has(name)) handlers.delete(name);
    for (const t of now) installMcpHandler(t);
    mcpTools = now;
    setMcpGroups(now);
    rebuildToolDefs();
    return true;
  };
  /** Offer the schemas of any group loaded since the last request. */
  const syncDeferredTools = (): boolean => {
    if (!loadedGroups) return false;
    const now = [...loadedGroups].sort().join();
    if (now === builtGroups) return false;
    builtGroups = now;
    rebuildToolDefs();
    return true;
  };

  // ── Build user message ─────────────────────────────────────────────
  /**
   * Image bytes already fetched for this run, by reference id.
   *
   * A turn is many requests and the pictures do not change between them, so
   * reading them from the store on every step would make a screenshot cost
   * more the longer the agent spent working on it.
   */
  const imageCache = new Map<string, ImagePart>();

  /*
    The resolver every request uses: images this run holds itself first, then
    the injected store.

    A run with no store of its own — the CLI, a sub-agent — keeps what its tools
    produced in memory (see `tools/tool-images`), and those references resolve
    here. Everything else goes to the store that took it, as before.
  */
  const toolImageSink = currentRunContext()?.toolImages;
  const resolveImages = async (refs: ImageRef[]): Promise<Array<ImagePart | undefined>> => {
    const local = refs.map(ref => toolImageSink?.local.get(ref.id));
    const missing = refs.filter((_, index) => local[index] === undefined);
    if (missing.length === 0 || !opts.resolveImages) return local;
    const fetched = await opts.resolveImages(missing);
    let next = 0;
    return local.map(part => part ?? fetched[next++]);
  };

  /*
    The vision fallback (ADR 0017 §9): when this model cannot read images and
    the person chose a vision model, that model describes each picture once.
    Counted in this run's tracker so spend ceilings see it; not sent to
    `onTokens`, which reports the work model's own usage.
  */
  const imageDescriber = visionDescriber({
    settings, mainModel: model,
    signal: () => loopSignal,
    onUsage: (input, output, cached, cacheWrite) => tokenTracker?.add(input, output, cached, cacheWrite),
  });

  let userMessage = task;

  if (showPlan && toolProfile !== 'browser-qa') {
    userMessage =
      'Before using any tools, write a brief numbered plan (2–5 steps) describing what you will do. ' +
      'Then execute the plan step by step.\n\n' + userMessage;
  }

  if (filePath) {
    try {
      const { readFile } = await import('./tools/read.js');
      const fileContent = await readFile({ file_path: filePath });
      userMessage = `File: ${filePath}\n\`\`\`\n${fileContent}\n\`\`\`\n\nTask: ${userMessage}`;
    } catch { /* proceed without file context */ }
  }

  // Embed conversation history as XML — LEGACY PATH ONLY.
  //
  // When a session log is supplied the history already lives in it as real
  // assistant/tool messages, and `transcript.messages()` derives them for every
  // request. Flattening them into a string here as well would duplicate the
  // conversation and destroy the tool-call/result pairing the log preserves.
  if (opts.session === undefined && conversationHistory.length > 0) {
    const history = conversationHistory
      .map((m) => `<${m.role}>\n${m.content}\n</${m.role}>`)
      .join('\n\n');
    userMessage = `${history}\n\n<user>\n${userMessage}\n</user>`;
  }

  // Append attachments as inline text
  if (opts.attachments?.length) {
    userMessage += attachmentsToText(opts.attachments);
  }

  // ── Hooks ──────────────────────────────────────────────────────────
  // Session-lifecycle hooks fire once per SESSION, not once per agent. Now that
  // sub-agents inherit settings (so tool hooks reach them), these must be gated
  // on depth or a fan-out of ten sub-agents would fire ten SessionStart hooks.
  // Sub-agent lifecycle has its own SubagentStart/SubagentStop events.
  if (settings && depth === 0) {
    await runHooks('SessionStart',     { event: 'SessionStart' }, settings);
    await runHooks('UserPromptSubmit', { event: 'UserPromptSubmit', userPrompt: task }, settings);
  }

  // ── Select provider ────────────────────────────────────────────────
  // Resolution order: an explicitly supplied provider (the test seam), then the
  // composed `llm` capability, then the historical direct selection. The loop
  // never learns which concrete class answered — that is the seam.
  const provider = opts.provider
    ?? opts.context?.get('llm')?.resolve(model, settings)
    ?? selectProvider(model, settings);

  // ── Render the prompt for this provider ────────────────────────────
  // Deferred to here because the dialect belongs to the provider, and the
  // provider is only known now. `reprise` is non-empty only for vendors whose
  // long-context guidance asks for key instructions to be restated after the
  // transcript; it rides in the tail alongside the volatile state, since both
  // must stay outside the cached prefix.
  const dialect = provider.promptDialect ?? DEFAULT_DIALECT;
  const rendered = renderPrompt(promptDoc, dialect, provider.id);
  const systemPrompt = rendered.system;
  const volatileContext = renderTail(volatileDoc, rendered.reprise, dialect, provider.id);
  // The same tail without the one-shot skill suggestion, for every step after
  // a request carrying it has completed.
  const laterVolatileDoc = volatileDoc.clone();
  const hadSkillNote = laterVolatileDoc.remove('matching_skills');
  const laterVolatileContext = hadSkillNote
    ? renderTail(laterVolatileDoc, rendered.reprise, dialect, provider.id)
    : volatileContext;
  let skillNoteDelivered = !hadSkillNote;

  // ── Auto-detect context window on first interaction ────────────────
  // If the model's context window isn't already persisted in settings,
  // query the provider's model-info endpoint to detect it. The result is
  // cached permanently in ~/.aico/settings.json so detection runs only once.
  // Non-blocking — if detection fails, the built-in table is used.
  try {
    /*
      Ask the provider that will actually serve the model.

      `detectProviderType` knows the legacy single-provider settings and
      nothing about configured instances, so for a model on an "OpenAI
      Compatible" endpoint it named whichever legacy key existed — and the
      detector asked OpenRouter, or a local Ollama, about a model neither had
      heard of. Nothing came back, 128K was assumed, and compaction fired at
      96K on a model that holds a million. This mirrors `selectProvider`: the
      instance that routes the request is the one that gets asked.
    */
    const instance = settings?.providerInstances?.length
      ? resolveInstance(settings, { model })
      : undefined;
    const provId = instance?.type ?? detectProviderType(model, settings);
    if (provId) {
      ensureContextWindow(model, provId, settings, instance).catch(() => {});
    }
  } catch {
    // Detection failure is non-fatal
  }

  // ── Transcript ─────────────────────────────────────────────────────
  // Where this run's history is kept, and where the next request comes from.
  // Session-backed: durable events, request re-derived from the log each step.
  // Legacy: an in-memory array, discarded when the run returns.
  const transcript: Transcript = opts.session === undefined
    ? new LegacyTranscript()
    : new SessionTranscript(opts.session, { recordChunks: opts.recordChunks ?? false });

  // Record the request identity (route + prompt + tool set) before the turn
  // opens, so a transcript can explain why two requests behaved differently.
  transcript.recordRequestHeader(canonicalHeader({
    provider: detectProviderType(model, settings) ?? 'unknown',
    model,
    /*
      The cached prefix only. The tail used to be hashed in as well, which
      made every turn a "change" — the git status moves whenever a file is
      written — and left the header unable to say the one thing it is for:
      whether the part of the request a provider can cache stayed the same.
      Per-section hashes go with it so a change can be named, not just seen.
    */
    systemPrompt,
    sectionHashes: sectionHashes(promptDoc, dialect, provider.id),
    tools: toolDefs.map(d => d.name),
  }));

  /*
    A turn the process died in the middle of.

    Every normal exit closes its turn, including errors and cancels — so a
    turn still open when the next one starts means the process stopped mid-
    step: a crash, a closed terminal, a restarted server. The log then held a
    turn with no end, and the model was handed its half-finished work with no
    word that it had been interrupted. Closed here, honestly labelled, and
    the new turn is told — so "continue" resumes from what is on disk instead
    of assuming the last step completed.
  */
  let interruptedNote: string | undefined;
  if (opts.session?.hasOpenTurn) {
    const turn = opts.session.lastTurn;
    opts.session.append('turn/end', {
      turn,
      reason: { kind: 'aborted', cause: 'interrupted — the process stopped before the turn finished' },
    });
    const open = await pendingTodoLines().catch(() => [] as string[]);
    interruptedNote = [
      `[Resuming] The previous turn (turn ${turn}) was interrupted before it finished — the `
        + 'process stopped mid-step. Whatever it changed up to that point is on disk; the step it '
        + 'was on may be half-done. Check the actual state before building on it.',
      ...(open.length > 0 ? [`Open todos at the time:\n${open.join('\n')}`] : []),
    ].join('\n');
  }

  transcript.beginTurn();
  if (interruptedNote) {
    transcript.recordUserMessage(interruptedNote, { kind: 'plugin', plugin: 'resume' });
  }
  /*
    Whatever reached the inbox's step queue while no turn was running — a
    background agent's report that landed after the last turn ended
    (agents/report-back), a steer sent a moment too late — is read now, before
    the request, rather than after this turn's first answer. Recorded with its
    own source, so a report is never shown as something the person typed.
  */
  for (const pending of opts.inbox?.claimStep() ?? []) {
    transcript.recordUserMessage(pending.content, pending.source);
  }
  // The images ride with this exact message, not the turn: a completion-gate
  // nudge later in the same turn is a different message and must not inherit
  // the reader's screenshot.
  transcript.recordUserMessage(userMessage, opts.taskSource, opts.images, opts.shownAttachments);

  // Recording starts here, before any tool can write, and captures each file
  // as it was when the turn began. Only the root agent opens one: a sub-agent
  // writes into the same tree, and its edits belong to the turn that delegated
  // them — separate checkpoints per sub-agent would fragment one undo into
  // several that have to be replayed in the right order.
  //
  // Off when there is no session workspace to write to, and off when the tool
  // is disabled, so switching the feature off stops the recording too rather
  // than leaving snapshots nobody can reach.
  const checkpointStore = depth === 0 && !settings?.disabledTools?.includes('Checkpoint')
    ? await checkpointDir().catch(() => undefined)
    : undefined;
  if (checkpointStore) beginCheckpoint(task.slice(0, 120), checkpointStore);

  let finalContent = '';
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCachedTokens = 0;
  let totalCacheWriteTokens = 0;
  // How many model requests this turn actually reported usage for. Zero means
  // the provider never sent a usage event, and the turn falls back to an
  // estimate so it is not invisible to the cost tracker.
  let committedRequests = 0;

  // Optional wall-clock timeout wrapper (validated/coerced in loadSettings)
  const agentTimeout = settings?.agentTimeout === undefined || settings.agentTimeout === 0
    ? 0 : settings.agentTimeout;

  // Safety cap against an infinite tool-calling loop. High enough that real
  // agentic work never trips it; sub-agents handle decomposition. Overridable.
  // A named agent's own budget (design §5.4) can only lower it.
  const budget = bounds?.budget;
  const maxIterations = Math.min(
    settings?.maxIterations && settings.maxIterations > 0 ? settings.maxIterations : 100,
    budget?.maxIterations && budget.maxIterations > 0 ? budget.maxIterations : Infinity,
  );
  // What the run had already cost when it started: the budget is per run, and
  // a persona's tracker is the whole session's.
  const budgetCostAtStart = budget?.maxUsd && tokenTracker ? tokenTracker.estimateCost(model, settings) : 0;
  const budgetStartedAt = Date.now();

  // Width of the parallel-safe tool pool per step. Resolved once per run so an
  // invalid value fails at the start rather than at the first tool group.
  const maxParallel = resolveMaxParallel(settings?.maxParallelToolCalls);

  // Completion gate: before accepting a text-only turn as "done", check whether
  // open todos remain and nudge the model to continue rather than stopping early.
  // Disabled for sub-agents (depth >= 1, which should return promptly to their
  // orchestrator) and plan mode (read-only, no work to verify).
  const completionGateEnabled =
    settings?.completionGate?.enabled !== false &&
    depth === 0 &&
    !opts.planMode;

  // ── Merged abort controller ────────────────────────────────────────
  // Combines the caller's abortSignal with an optional wall-clock timeout into
  // ONE signal that the loop observes and that is forwarded into the provider
  // stream. This replaces the old Promise.race approach, which (a) treated the
  // timeout as retryable and burned 5 backoff cycles, (b) never cancelled the
  // in-flight HTTP stream, and (c) reused an already-rejected timer across
  // retries. Aborts are non-retryable, so withRetry stops immediately.
  // The controller itself is created earlier, so tool-pipeline stages can hold
  // its signal; only the timeout and caller-abort wiring happen here.
  let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
  if (agentTimeout > 0) {
    timeoutTimer = setTimeout(() => {
      loopController.abort(new Error(`Agent timed out after ${agentTimeout}ms`));
    }, agentTimeout);
  }
  // The agent's wall clock: checked at every step boundary, and this timer
  // stops a step that would run past it (a long tool call, a slow stream).
  let budgetTimer: ReturnType<typeof setTimeout> | undefined;
  if (budget?.maxMinutes && budget.maxMinutes > 0) {
    budgetTimer = setTimeout(() => {
      loopController.abort(new Error(`Agent cancelled: ${bounds!.name}'s time budget (${budget.maxMinutes} min) ran out`));
    }, budget.maxMinutes * 60_000);
    budgetTimer.unref?.();
  }
  // If the caller aborts, propagate into the loop controller too. The handle is
  // kept so the listener can be detached when this run ends — a sub-agent
  // attaches to its PARENT's signal, which outlives it, so leaving them on
  // accumulates one listener per child for the parent's whole lifetime.
  let detachCallerAbort: (() => void) | undefined;
  if (opts.abortSignal) {
    if (opts.abortSignal.aborted) loopController.abort();
    else {
      const callerSignal = opts.abortSignal;
      const onCallerAbort = (): void => loopController.abort();
      callerSignal.addEventListener('abort', onCallerAbort, { once: true });
      detachCallerAbort = () => callerSignal.removeEventListener('abort', onCallerAbort);
    }
  }
  const throwIfLoopAborted = (): void => {
    if (loopSignal.aborted) {
      throw new Error(opts.abortSignal?.aborted ? 'Agent cancelled' : 'Agent cancelled');
    }
  };

  // Sticky across the whole turn: once any step is truncated at the output
  // ceiling, a later step completing normally must not upgrade the outcome back
  // to "completed" — the user still received a cut-short reply.
  let sawMaxTokens = false;
  let sawRefusal = false;

  // "Verified" is a claim about this piece of work, not something the session
  // accumulates. Last turn's passing verdict says nothing about this turn's
  // artifact, so the evidence starts empty every time.
  resetVerification();
  resetObservations();
  resetEditNotes();
  let editNoteFlushed = false;
  resetChecks();
  resetChangeSafety();
  // The user's own words are the standard the work is held to. Taken from the
  // task rather than from anything the model writes: a model that authors its
  // own acceptance criteria authors ones it has met.
  setBrief(opts.task ?? '');

  const managedDayCap = dayBudgetCap();
  let daySpend = 0;
  const refreshDaySpend = (): void => {
    void import('./audit/usage.js').then(u => u.todaySpend(settings)).then(v => { daySpend = v; }, () => { /* keep the last figure */ });
  };
  if (managedDayCap !== undefined) {
    try { daySpend = await (await import('./audit/usage.js')).todaySpend(settings); } catch { /* the session cap still applies */ }
  }

  /**
   * Whether cumulative spend has passed a configured ceiling.
   *
   * Returns a human-readable breach description, or undefined to continue.
   * Evaluated at the top of every step so it fires *before* another model call
   * is paid for, rather than describing one already made. Reads the live
   * tracker, which now includes the in-flight turn.
   */
  const checkSafetyLimits = (): string | undefined => {
    // The organisation's daily cap (ADR 0035): today's estimated spend across
    // every session, refreshed in the background at most every 20 s.
    if (managedDayCap !== undefined) {
      refreshDaySpend();
      const dayRefusal = dayBudgetRefusal(daySpend);
      if (dayRefusal) return dayRefusal;
    }
    // The agent's own budget first: it is the tighter, per-run bound.
    if (budget?.maxUsd && budget.maxUsd > 0 && tokenTracker) {
      const spent = tokenTracker.estimateCost(model, settings) - budgetCostAtStart;
      if (spent > budget.maxUsd) {
        return `${bounds!.name}'s budget reached ($${spent.toFixed(4)} > $${budget.maxUsd} budget.maxUsd)`;
      }
    }
    if (budget?.maxMinutes && budget.maxMinutes > 0 && Date.now() - budgetStartedAt > budget.maxMinutes * 60_000) {
      return `${bounds!.name}'s time budget reached (${budget.maxMinutes} min budget.maxMinutes)`;
    }
    const limits = settings?.safetyLimits;
    if (!limits || !tokenTracker) return undefined;
    const usage = tokenTracker.getUsage();

    const total = usage.inputTokens + usage.outputTokens;
    // Session ceilings against the conversation's tracker: a delegated agent's
    // own is only its share, and a background agent has no parent step left to
    // re-check for it (tokens.ts createChildTracker).
    const whole = tokenTracker.session ?? tokenTracker;
    const sessionUsage = whole === tokenTracker ? usage : whole.getUsage();
    const sessionTotal = sessionUsage.inputTokens + sessionUsage.outputTokens;
    if (limits.maxTokensPerSession && limits.maxTokensPerSession > 0
        && sessionTotal > limits.maxTokensPerSession) {
      return `token limit reached (${sessionTotal.toLocaleString()} > `
        + `${limits.maxTokensPerSession.toLocaleString()} maxTokensPerSession)`;
    }

    if (limits.maxCostPerSession && limits.maxCostPerSession > 0) {
      const cost = whole.estimateCost(model, settings);
      if (cost > limits.maxCostPerSession) {
        return `cost limit reached ($${cost.toFixed(4)} > `
          + `$${limits.maxCostPerSession} maxCostPerSession)`;
      }
    }

    // Delegated work is held to its own ceiling as well. Inside a sub-agent
    // `tokenTracker` is that agent's own — see `createChildTracker` — so these
    // measure what this one agent spent rather than what the session did.
    // Without it, one looping researcher among six running in parallel is
    // indistinguishable from six behaving normally until the whole budget is
    // gone and the other five are cut off for its mistake.
    if (depth > 0) {
      if (limits.maxTokensPerSubagent && limits.maxTokensPerSubagent > 0
          && total > limits.maxTokensPerSubagent) {
        return `sub-agent token limit reached (${total.toLocaleString()} > `
          + `${limits.maxTokensPerSubagent.toLocaleString()} maxTokensPerSubagent)`;
      }
      if (limits.maxCostPerSubagent && limits.maxCostPerSubagent > 0) {
        const cost = tokenTracker.estimateCost(model, settings);
        if (cost > limits.maxCostPerSubagent) {
          return `sub-agent cost limit reached ($${cost.toFixed(4)} > `
            + `$${limits.maxCostPerSubagent} maxCostPerSubagent)`;
        }
      }
    }
    return undefined;
  };
  // Assigned by whichever path ends the loop; the caller closes the turn with it.
  let turnEndReason: TurnEndReason | undefined;

  const notice = (text: string): void => {
    opts.onNotice?.(text);
    if (!silent) showError(text);
  };

  /*
    Context management inside the turn — see `session/context-manager.ts`.

    Only on the session path: masking and compaction are log events, and the
    legacy transcript has no log to write them to.
  */
  const contextManager = transcript.session
    ? new ContextManager({
      session: transcript.session,
      model,
      settings,
      overheadTokens: estimateTokens(systemPrompt) + estimateTokens(JSON.stringify(toolDefs))
        + estimateTokens(volatileContext ?? ''),
      notice,
      // Appended at the end of the history, so the cached prefix is untouched.
      warn: (text) => transcript.recordUserMessage(text, { kind: 'plugin', plugin: 'context-manager' }),
      readTodos: () => readTodos(),
      /*
        The model's own handoff, asked for with the exact request it was about
        to make plus one instruction appended — the same system prompt, tools
        and history, so the whole thing is a cache read and only the note
        itself is paid for at full price. Any failure falls back to the
        heuristic summary rather than failing the turn.
      */
      summarize: async () => {
        // The `compact` role (ADR 0017 §8) is the main model unless the person
        // set another; moving it forfeits the cached prefix, which is theirs
        // to trade. Only an explicit `models.roles.compact` moves it.
        const compactRole = resolveRole('compact', { settings, mainModel: model });
        const moved = compactRole.ok && compactRole.source === 'role' && compactRole.model !== model;
        const summaryModel = moved ? compactRole.model : model;
        const summaryProvider = moved ? selectProvider(summaryModel, settings) : provider;
        const history = await projectImages(
          transcript.messages(), summaryModel, settings, resolveImages, imageCache, imageDescriber,
        );
        let text = '';
        for await (const event of summaryProvider.chat({
          model: summaryModel,
          systemPrompt,
          messages: [...history, { role: 'user', content: HANDOFF_INSTRUCTION }],
          tools: toolDefs,
          maxTokens: 2_000,
          signal: loopSignal,
        })) {
          if (event.type === 'text') text += event.content;
          else if (event.type === 'usage') {
            const read = event.cacheReadTokens ?? 0;
            const write = event.cacheWriteTokens ?? 0;
            tokenTracker?.add(event.inputTokens, event.outputTokens, read, write, true, event.cacheWrite1hTokens ?? 0);
            if (moved) {
              recordRoleSpend('compact', costFor(summaryModel, { inputTokens: event.inputTokens, outputTokens: event.outputTokens, cachedTokens: read, cacheWriteTokens: write }, settings));
            } else {
              onTokens?.(event.inputTokens, event.outputTokens, read, write);
            }
          }
        }
        return text.trim() || undefined;
      },
    })
    : undefined;
  const reciteTodos = depth === 0 && settings?.contextManagement?.reciteTodos !== false;

  // Per turn, not per attempt. These lived inside `runLoop`, and `withRetry`
  // re-runs `runLoop` after a transient failure — so every dropped connection
  // reset the step cap and every gate's nudge budget, and a turn that retried
  // five times could run five times the steps the cap promised.
  let iterations = 0;
  // Track how many times the completion gate has nudged the model to keep
  // working despite open todos. Capped so a stuck agent isn't trapped forever.
  let completionNudges = 0;
  let continueNudges = 0;
  /** Recovery attempts after a step was cut off at the output ceiling. */
  let truncationRetries = 0;
  /** Times this turn has been sent back for an unverified or failing artifact. */
  let verificationNudges = 0;
  /** Times this turn has been sent back over failing or stale project checks. */
  let checksNudges = 0;
  /** Times this turn has been sent back to commit a finished story in an app (apps/app-git.ts). */
  let commitNudges = 0;
  /** Times this turn has been sent back over secrets, unsafe code or weakened tests in its own changes (security/change-safety.ts). */
  let safetyNudges = 0;

  async function runLoop(): Promise<void> {
    throwIfLoopAborted();
    if (!silent) startSpinner('Thinking…');

    /**
 * How many times a turn may recover from an output-ceiling truncation.
 *
 * Two, for the same reason the completion gate stops at its own cap: a model
 * that cannot get under the ceiling after being told twice will not manage it
 * on the fifth attempt, and each attempt is a full paid step.
 */
const MAX_TRUNCATION_RETRIES = 2;

/**
 * How many times a turn may be sent back over an unverified artifact.
 *
 * Three, one more than the other gates, because these nudges buy the most:
 * the first typically produces the first browser run of the whole turn, and
 * the ones after it are real fix-and-recheck cycles rather than reminders.
 */
const MAX_VERIFICATION_NUDGES = 3;

/** How many times a turn may be sent back to commit its work in an app: the message names the exact call, so two is plenty. */
const MAX_COMMIT_NUDGES = 2;

/** How many times a turn may be sent back over its own diff: each nudge names file:line and the fix, and a finding is reported once. */
const MAX_SAFETY_NUDGES = 2;

/**
 * How many times a turn may be sent back over its own project checks.
 *
 * Three, like the browser gate: the first usually buys the only run of the
 * suite in the whole turn, and the ones after it are real fix-and-recheck
 * cycles rather than reminders.
 */
const MAX_CHECKS_NUDGES = 3;

const MAX_COMPLETION_NUDGES = 2;
/** Answers to "shall I continue?" in one turn (continue-gate); beyond this the question reaches the person. */
const MAX_CONTINUE_NUDGES = 3;

/** At the end of a turn, how long a queued edit check may wait for the code graph (codegraph/edit-note). */
const EDIT_NOTE_FLUSH_MS = 30_000;

/**
 * How often a standing objective is restated inside a long turn.
 *
 * Six steps is a judgement, not a measurement: frequent enough that the goal is
 * never far behind the decision, rare enough that a twenty-step turn pays for
 * three short sentences rather than twenty.
 */
const GOAL_REMINDER_EVERY = 6;

    while (true) {
      throwIfLoopAborted();

      // ── Cost circuit breaker ──────────────────────────────────────
      // Checked before the step, not after the turn: a limit that reports
      // overspend once the money is gone is a receipt, not a ceiling.
      const breach = checkSafetyLimits();
      if (breach) {
        if (!silent) stopSpinner();
        if (!silent) showError(`Stopping: ${breach}.`);
        finalContent = finalContent
          ? `⚠ Stopped — ${breach}.\n\n${finalContent}`
          : `⚠ Stopped before making another model call — ${breach}. `
            + `Raise settings.safetyLimits or start a new session.`;
        turnEndReason = { kind: 'aborted', cause: breach };
        break;
      }

      if (++iterations > maxIterations) {
        if (!silent) stopSpinner();
        // A pause, not a crash. The cap exists to stop a runaway loop, but most
        // turns that reach it are long, legitimate work — and throwing threw
        // away the one thing a reader needs next: where it got to. The work
        // done so far is in the log and on disk either way; this says so and
        // makes "continue" the obvious next message.
        const open = await pendingTodoLines().catch(() => [] as string[]);
        finalContent = [
          `⏸ Paused after ${maxIterations} steps — the per-turn step cap `
            + '(settings.maxIterations). Nothing was lost: every change made so far is on disk '
            + 'and in this conversation.',
          open.length > 0 ? `\nStill open:\n${open.join('\n')}` : '',
          '\nSend "continue" to carry on from here.',
          finalContent ? `\n\nLast update before pausing:\n${finalContent}` : '',
        ].join('');
        turnEndReason = {
          kind: 'error',
          code: 'iteration-cap',
          message: `paused at the ${maxIterations}-step cap`,
        };
        break;
      }

      // One step = one model request plus the tools it calls. The boundary is
      // durable, and closing it in a `finally` means a thrown stream still
      // leaves a balanced log for the retry (which opens a fresh step) to
      // append onto.
      transcript.beginStep();
      try {
        // What moved since the last step: MCP tools a management call added
        // or removed, and the caller's volatile sections — an app that
        // started, an install that failed. Both are read here, per request,
        // rather than once per turn; the tail is rebuilt only when the caller
        // gave something to rebuild it from, so an ordinary turn pays nothing.
        syncMcpTools();
        syncDeferredTools();
        let stepVolatileContext = skillNoteDelivered ? laterVolatileContext : volatileContext;
        if (opts.refreshVolatile) {
          const fresh = await opts.refreshVolatile().catch(() => [] as PromptSection[]);
          if (fresh.length > 0) {
            const stepDoc = (skillNoteDelivered ? laterVolatileDoc : volatileDoc).clone();
            for (const section of fresh) stepDoc.add(section);
            stepVolatileContext = renderTail(stepDoc, rendered.reprise, dialect, provider.id);
          }
        }
        const textParts: string[] = [];
        const toolCalls: ToolCall[] = [];
        // Accumulated separately from `textParts`: reasoning is not part of the
        // answer, and for providers that take it back on a later request —
        // Anthropic's signed thinking blocks, DeepSeek's reasoning_content —
        // it has to reach the session log rather than living in provider-local
        // memory, or it is lost the moment the process restarts.
        const reasoningParts: string[] = [];
        let reasoningReplay: string | undefined;
        let stepUsage: Usage | undefined;
        let finishReason: FinishReason | undefined;

        // Make room before the request, not after the provider refuses it:
        // mask old tool output, and compact inside the turn if that is not
        // enough. Both are log events, so the derivation below sees them.
        await contextManager?.beforeStep(iterations);

        /*
          The open todo list, recited at the end of every request.

          In a long turn the list is written once near the start and then sits
          dozens of tool results behind every decision — where models attend
          least. Repeating the open items in the tail puts what is left to do
          next to where the next action is chosen. The tail is after every
          cache breakpoint, so this costs its own few tokens and nothing else.
        */
        if (reciteTodos) {
          const todos = await readTodos().catch(() => []);
          const open = todos.filter(t => t.status === 'pending' || t.status === 'in_progress');
          if (open.length > 0) {
            const done = todos.filter(t => t.status === 'done').length;
            stepVolatileContext = `${stepVolatileContext ?? ''}\n\nTodo list — ${done} of ${todos.length} done. `
              + `Still open (keep it current with TodoWrite):\n${todoChecklist(open).join('\n')}`;
          }
        }

        // Derived fresh every step. On the session path this means the log IS
        // the request rather than a mirror of it, so anything the model sees is
        // by construction reconstructable.
        //
        // Images are the one thing the log does not hold literally: it holds
        // references, and they become bytes — or a sentence saying why not —
        // here, where the model for this request is finally known.
        const requestMessages = await projectImages(
          transcript.messages(), model, settings, resolveImages, imageCache, imageDescriber,
        );
        contextManager?.noteRequest();

        // Stream from provider — forward the merged signal so a cancel/timeout
        // tears down the in-flight HTTP stream instead of leaking the socket.
        try {
          for await (const event of provider.chat({
            model,
            systemPrompt,
            volatileContext: stepVolatileContext,
            messages: requestMessages,
            tools: toolDefs,
            signal: loopSignal,
          })) {
            throwIfLoopAborted();
            if (event.type === 'text') {
              textParts.push(event.content);
              transcript.recordChunk(event.content);
              onChunk?.(textParts.join(''));
            } else if (event.type === 'reasoning') {
              if (event.delta) {
                reasoningParts.push(event.delta);
                // Accumulated rather than the raw delta, matching onChunk: a
                // collapsible "thinking" block replaces its contents on each
                // update instead of having to reassemble them.
                onReasoning?.(reasoningParts.join(''), iterations);
              }
              // An explicit replay payload supersedes the readable deltas —
              // some vendors cannot reconstruct a replayable trace from text.
              if (event.replay !== undefined) reasoningReplay = event.replay;
            } else if (event.type === 'tool_call') {
              toolCalls.push(event);
            } else if (event.type === 'finish') {
              finishReason = event.reason;
              if (event.reason === 'length') sawMaxTokens = true;
              // A safety classifier declined this step. It arrives as a
              // successful HTTP 200 with empty or partial content, so without
              // recording it the turn would close as `completed` on an answer
              // the model never gave.
              if (event.reason === 'blocked') sawRefusal = true;
            } else if (event.type === 'usage') {
              // inputTokens is the TOTAL prompt size on every provider — the
              // two cache counts are subsets of it, not additions to it.
              const cacheRead = event.cacheReadTokens ?? 0;
              const cacheWrite = event.cacheWriteTokens ?? 0;
              totalInputTokens += event.inputTokens;
              totalOutputTokens += event.outputTokens;
              contextManager?.noteUsage(event.inputTokens);
              totalCachedTokens += cacheRead;
              totalCacheWriteTokens += cacheWrite;
              /*
                A prompt the model accepted is proof of the window it has.

                Before `onTokens` fires, so the usage event the client draws
                its meter from already carries the corrected figure rather
                than one more reading of "100% of 128K".
              */
              const grown = noteWindowFromUsage(model, event.inputTokens, settings);
              if (grown && !silent) {
                showError(
                  `Noted: ${model} accepted ${event.inputTokens.toLocaleString()} tokens, `
                  + `so its window is now taken as ${grown.tokens.toLocaleString()}.`,
                );
              }
              // Committed to the tracker HERE, per request, rather than once
              // after the loop. A turn can make up to `maxIterations` model
              // calls, so a tracker that only learns about them afterwards
              // cannot stop a runaway turn — it can only describe one.
              tokenTracker?.add(
                event.inputTokens, event.outputTokens, cacheRead, cacheWrite, true, event.cacheWrite1hTokens ?? 0,
              );
              committedRequests++;
              stepUsage = {
                inputTokens: event.inputTokens,
                outputTokens: event.outputTokens,
                cachedTokens: cacheRead,
              };
              // Forward per-call token usage so callers can track consumption
              // independently of the session-wide tokenTracker (e.g. sub-agent ops panel).
              onTokens?.(event.inputTokens, event.outputTokens, cacheRead, cacheWrite);
            }
          }
        } catch (err) {
          if (!silent) stopSpinner();
          throw err;
        }
        skillNoteDelivered = true;

        const text = textParts.join('');
        // Tagged with the producing provider so it is only ever replayed to a
        // vendor that can parse it; a mid-session model switch then degrades to
        // "no trace" rather than forwarding one vendor's payload to another.
        const traceContent = reasoningReplay ?? (reasoningParts.length > 0
          ? reasoningParts.join('')
          : undefined);
        const stepReasoning: ReasoningTrace | undefined = traceContent
          ? { provider: provider.id, content: traceContent }
          : undefined;
        void finishReason;

        /**
         * Drain steered input and record it as model-visible messages.
         * @returns how many messages were claimed.
         */
        const drainSteeredInput = (): number => {
          const claimed = opts.inbox?.claimStep() ?? [];
          for (const message of claimed) {
            transcript.recordUserMessage(message.content, message.source);
          }
          return claimed.length;
        };

        // ── No tool calls → done (after steering and the completion gate) ──
        if (toolCalls.length === 0) {
          // Steered input takes priority over finishing. Someone who typed a
          // correction while the agent was working meant it to be acted on, not
          // queued behind a summary — so record the assistant turn and continue
          // rather than ending here.
          if ((opts.inbox?.nextStep.length ?? 0) > 0) {
            transcript.recordAssistant(text, [], stepUsage, stepReasoning);
            if (text && !silent) showAssistantMessage(text);
            const claimed = drainSteeredInput();
            if (!silent) showError(`Steering: ${claimed} message(s) received — continuing.`);
            if (!silent) startSpinner('Thinking…');
            continue;
          }
          // Completion gate: if open todos remain and we haven't exhausted nudges,
          // record the assistant turn, then add a synthetic user message telling
          // the model to keep going instead of accepting a premature finish.
          // Does the project still build and pass its own tests? Checked before
          // the browser, because a type error makes every other question moot —
          // and because it is the objection that applies to most work, most of
          // the time. Silent when the project defines no checks or the turn
          // changed no source.
          // An edit changed an exported API before the code graph was ready: its callers
          // are listed now, before the turn may end (codegraph/edit-note). Once per turn.
          if (!editNoteFlushed && hasQueuedEditNotes()) {
            editNoteFlushed = true;
            const note = await flushQueuedEditNotes(EDIT_NOTE_FLUSH_MS);
            if (note) {
              transcript.recordAssistant(text, [], stepUsage, stepReasoning);
              transcript.recordUserMessage(note, { kind: 'plugin', plugin: 'codegraph-edit-note' });
              if (!silent) startSpinner('Thinking…');
              continue;
            }
          }
          if (completionGateEnabled && checksNudges < MAX_CHECKS_NUDGES) {
            // The bound app's checks when there is one, the project's otherwise —
            // profile first, manifest second — plus any sub-project this turn touched.
            const gate = checkProjectGate(gateChecks());
            if (!gate.ok && gate.message) {
              checksNudges++;
              transcript.recordAssistant(text, [], stepUsage, stepReasoning);
              transcript.recordUserMessage(gate.message, { kind: 'plugin', plugin: 'checks-gate' });
              if (!silent) {
                showError(`Checks gate: the project's own checks do not vouch for this code `
                  + `(nudge ${checksNudges}/${MAX_CHECKS_NUDGES}).`);
                startSpinner('Thinking…');
              }
              continue;
            }
          }

          // The other half of finishing: not "are the todos ticked" but "does
          // the thing actually work". Checked before the todo gate because a
          // page that throws on load is a more concrete objection than an open
          // checklist item, and the model should be told the concrete one first.
          if (completionGateEnabled && verificationNudges < MAX_VERIFICATION_NUDGES) {
            const gate = checkVerificationGate();
            if (!gate.ok && gate.message) {
              verificationNudges++;
              transcript.recordAssistant(text, [], stepUsage, stepReasoning);
              transcript.recordUserMessage(gate.message, { kind: 'plugin', plugin: 'verification-gate' });
              if (!silent) {
                showError(`Verification gate: the artifact is not confirmed working `
                  + `(nudge ${verificationNudges}/${MAX_VERIFICATION_NUDGES}).`);
                startSpinner('Thinking…');
              }
              continue;
            }
          }

          // What the turn changed is itself checked (ADR 0033): secrets, high-severity code-rule
          // findings and weakened tests, even where the project defines no checks. Findings past the
          // nudge budget are still recorded (`safety/finding`) for the change-evidence report.
          if (completionGateEnabled && settings?.completionGate?.changeSafety !== false) {
            const safety = await changeSafetyGate({
              root: projectRoot(), written: writtenFiles(), testFailedEarlier: testCheckFailedThisTurn(),
              before: recordedBefore, nudge: safetyNudges < MAX_SAFETY_NUDGES, record: runFindingSink(),
            });
            if (!safety.ok && safety.message) {
              safetyNudges++;
              transcript.recordAssistant(text, [], stepUsage, stepReasoning);
              transcript.recordUserMessage(safety.message, { kind: 'plugin', plugin: 'change-safety' });
              if (!silent) {
                showError(`Change-safety gate: secrets, unsafe code or weakened tests in this turn's changes (nudge ${safetyNudges}/${MAX_SAFETY_NUDGES}).`);
                startSpinner('Thinking…');
              }
              continue;
            }
          }

          // A story is not done until it is committed: in an app's own git repo, a turn that changed
          // source may not end with the tree dirty (ADR 0031). After the browser gate, so the commit
          // describes verified work. Silent outside an app, without git, or when no source changed.
          if (completionGateEnabled && commitNudges < MAX_COMMIT_NUDGES) {
            const gate = appCommitGate(projectRoot(), touchedFiles().length);
            if (!gate.ok && gate.message) {
              commitNudges++;
              transcript.recordAssistant(text, [], stepUsage, stepReasoning);
              transcript.recordUserMessage(gate.message, { kind: 'plugin', plugin: 'commit-gate' });
              if (!silent) {
                showError(`Commit gate: the app has uncommitted changes (nudge ${commitNudges}/${MAX_COMMIT_NUDGES}).`);
                startSpinner('Thinking…');
              }
              continue;
            }
          }

          if (completionGateEnabled && completionNudges < MAX_COMPLETION_NUDGES) {
            let openCount = 0;
            try { openCount = await getOpenTodoCount(); } catch { /* treat as none */ }
            if (openCount > 0) {
              completionNudges++;
              transcript.recordAssistant(text, [], stepUsage, stepReasoning);
              transcript.recordUserMessage(
                `You still have ${openCount} incomplete todo item(s). ` +
                `Continue working until they are verified complete — do not stop with a summary while work remains. ` +
                `If a todo is genuinely blocked, mark it cancelled and explain why.`,
                { kind: 'plugin', plugin: 'completion-gate' },
              );
              if (!silent) {
                showError(`Completion gate: ${openCount} open todo(s) — continuing (nudge ${completionNudges}/${MAX_COMPLETION_NUDGES}).`);
              }
              if (!silent) startSpinner('Thinking…');
              continue;
            }
          }

          // A turn that ends by asking leave to carry on with agreed work: answer it in the loop
          // (continue-gate). Silent when the person asked for check-ins.
          if (completionGateEnabled && continueNudges < MAX_CONTINUE_NUDGES && asksPermissionToContinue(text)) {
            const said = transcript.messages().filter(m => m.role === 'user').map(m => typeof m.content === 'string' ? m.content : '');
            if (!wantsCheckIns(said)) {
              continueNudges++;
              transcript.recordAssistant(text, [], stepUsage, stepReasoning);
              transcript.recordUserMessage(CONTINUE_NUDGE, { kind: 'plugin', plugin: 'continue-gate' });
              if (!silent) {
                showError(`Continue gate: the turn asked leave to carry on — continuing (nudge ${continueNudges}/${MAX_CONTINUE_NUDGES}).`);
                startSpinner('Thinking…');
              }
              continue;
            }
          }

          // A step cut off at the output ceiling is recoverable, and used not to
          // be. The turn simply ended `max-tokens` — which is fatal when the
          // thing being truncated was a *tool call*, because its arguments are
          // output tokens and a half-emitted call performs no action at all.
          // The model wrote nothing, was told nothing useful, and the user paid
          // for the whole attempt.
          //
          // Telling it what happened costs one step and usually fixes it: the
          // model splits the write. Bounded, because a model that cannot get
          // under the ceiling will not manage it on the fifth try either.
          //
          // On *this* step's finish reason, not the sticky turn-level flag. A
          // step truncated after emitting a complete tool call is not stuck —
          // the call ran and the loop carried on — and reading the sticky flag
          // would nudge a later, perfectly healthy step for a truncation that
          // had already been absorbed.
          if (finishReason === 'length' && truncationRetries < MAX_TRUNCATION_RETRIES) {
            truncationRetries++;
            transcript.recordAssistant(text, [], stepUsage, stepReasoning);
            transcript.recordUserMessage(
              'Your previous step was cut off at the output-token ceiling. '
              + 'If you were calling a tool, that call never ran — nothing was written. '
              + 'Do not repeat it as-is. Produce the work in smaller pieces: '
              + 'write a first chunk with Write, then extend it with further Edit or Write calls, '
              + 'keeping every single call well under the limit.',
              { kind: 'plugin', plugin: 'truncation-recovery' },
            );
            // Cleared only because we are actively recovering *this* truncation.
            // If the retry succeeds the turn genuinely completed, and reporting
            // max-tokens on a turn that delivered the artifact would be the
            // misleading answer. Stickiness still holds everywhere else: a
            // truncation nobody recovered from is still reported as one.
            sawMaxTokens = false;
            if (!silent) {
              showError(`Output ceiling hit — asking for smaller pieces `
                + `(attempt ${truncationRetries}/${MAX_TRUNCATION_RETRIES}).`);
              startSpinner('Thinking…');
            }
            continue;
          }

          if (!silent) stopSpinner();
          transcript.recordAssistant(text, [], stepUsage, stepReasoning);
          finalContent = text;
          // If we nudged but the model stopped anyway with todos still open, flag
          // the summary so the user knows completion wasn't verified.
          if (completionNudges > 0) {
            finalContent =
              `⚠️ Note: ${completionNudges} completion nudge(s) were issued; the agent stopped with open todos that may not be verified.\n\n` +
              finalContent;
          }
          if (sawMaxTokens) {
            finalContent =
              `⚠️ Note: the model hit its output-token ceiling during this turn; the reply above may be truncated.\n\n` +
              finalContent;
          }
          if (sawRefusal) {
            finalContent =
              `⚠️ Note: the provider's safety classifier declined part of this turn; the reply above may be incomplete.\n\n` +
              finalContent;
          }
          if (text && !silent) showAssistantMessage(text);
          // Refusal outranks truncation, which outranks completion: reporting
          // the mildest outcome would hide the one the user needs to act on.
          turnEndReason = sawRefusal
            ? { kind: 'error', message: 'provider declined the request', code: 'refusal' }
            : sawMaxTokens ? { kind: 'max-tokens' } : { kind: 'completed' };
          break;
        }

        // ── Tool calls present → show text so far, then execute ──────
        if (text && !silent) showAssistantMessage(text);
        // Note: text was already forwarded to onChunk during streaming

        transcript.recordAssistant(text, toolCalls, stepUsage, stepReasoning);
        // The Sentinel shows the reviewer this as the agent's stated reason (a claim, not authority).
        stepIntent = text;

        if (!silent) stopSpinner();

        // ── Schedule this step's tool calls ─────────────────────────
        // Parallel-safe calls share a bounded rolling pool; exclusive ones are
        // barriers. Dispatch overlaps, but results commit in MODEL order so the
        // log — and therefore the next request — reads in the order the model
        // asked, regardless of which call finished first.
        // What each call answered, by id, for the post-step hooks that read a
        // particular tool's result — the verifier's screenshots, for one.
        const stepOutcomes = new Map<string, { result: unknown; isError: boolean }>();
        const scheduled = await scheduleToolCalls(toolCalls, {
          maxParallel,
          executionMode: (call) => getExecutionMode(call.name),
          onStart: (call) => {
            if (!silent) startSpinner(`${call.name}…`);
            transcript.recordToolCall(call);
            // The same rule the log is read with at turn start, applied as the
            // call is recorded — so a LoadTools (or a call to a deferred tool
            // by name) offers its group from the next step of this turn.
            if (loadedGroups) for (const g of groupsLoadedBy(call.name, call.input, extraGroups)) loadedGroups.add(g);
            if (taints(call.name)) { tainted = true; markTainted(taintCell); }
          },
          dispatch: async (call) => {
            const handler = handlers.get(call.name);
            let result: unknown;
            let contexts: AdditionalContext[] | undefined;

            if (!handler) {
              result = { error: `Unknown tool: ${call.name}` };
              if (!silent) showError(`Unknown tool requested: ${call.name}`);
            } else {
              try {
                // The call id rides along so an image this call produces
                // reaches the model in the order the calls were asked for.
                const invocation = await withToolCall(call.id, () => handler(call.input, call.id));
                result = invocation.result;
                contexts = invocation.additionalContexts;
              } catch (err) {
                result = { error: err instanceof Error ? err.message : String(err) };
              }
            }

            // If the model's tool-call arguments were malformed JSON, append the
            // provider's parse diagnostic so the model sees the real cause and
            // can correct itself, instead of a confusing missing-argument error.
            if (call.parseError && typeof result === 'object' && result !== null) {
              const merged = { ...(result as Record<string, unknown>) };
              merged.error = `${(merged.error as string) || ''}${merged.error ? ' | ' : ''}${call.parseError}`.trim();
              result = merged;
            }

            // The last point before the model sees it. The pipeline already
            // redacts built-in tools; this also covers the handlers that do not
            // run through it (Task, Investigate, MCP) and their error paths.
            result = sinkRedact(result);
            return {
              result,
              isError: typeof result === 'object' && result !== null && 'error' in result,
              ...(contexts?.length ? { additionalContexts: sinkRedact(contexts) } : {}),
            };
          },
          onCommit: (call, outcome) => {
            if (!silent) stopSpinner();
            stepOutcomes.set(call.id, { result: outcome.result, isError: outcome.isError });
            transcript.recordToolResult(
              call,
              typeof outcome.result === 'string' ? outcome.result : JSON.stringify(outcome.result),
              outcome.isError,
            );
          },
          onSkipped: (call) => {
            // A cancelled step must still leave every requested call answered:
            // an assistant message asking for five tools with three results in
            // the log is a shape providers reject outright.
            transcript.recordToolCall(call);
            transcript.recordToolResult(call, TOOL_ABORTED_BEFORE_DISPATCH, true);
          },
          signal: loopSignal,
        });

        // Context contributed by post-execute stages (guard reminders, policy
        // notices), delivered AFTER every tool result in this step so
        // call/result adjacency — which providers require — is never broken by
        // an advisory insertion.
        for (const context of scheduled.additionalContexts) {
          transcript.recordUserMessage(context.content, context.source);
        }

        /*
          Images this step's tools produced — a PNG that was Read, an image URL
          that was fetched, an MCP screenshot — shown to the model now.

          One user message after every result, carrying references: the shape
          an upload has, replayed by the same code, so a reopened session still
          shows them and a model switch still gates them. Each tool already said
          in its own result whether its picture was attached or why not; only
          the attached ones are here, and only a model that reads images ever
          gets one attached.
        */
        const produced = drainToolImages(toolImageSink, toolCalls.map(call => call.id));
        if (produced.length > 0) {
          transcript.recordUserMessage(
            toolImagesMessage(produced),
            { kind: 'plugin', plugin: 'tool-images' },
            produced.map(image => image.ref),
          );
        }

        /*
          Eyes for the verifier, when the model has them.

          VerifyApp saves a screenshot per check and names the paths. A model
          that reads images asked Read for one and was handed bytes; a model
          that does not could never look at all. Here the pictures a check
          produced are stored as attachments and recorded as a user message
          with image references, so the next request carries them — the same
          path a person's pasted screenshot takes. Only for models that read
          images; for the rest the paths in the verdict remain for the person.
        */
        if (opts.storeImage && modelAccepts(model, 'image', settings)) {
          for (const call of toolCalls) {
            if (call.name !== 'VerifyApp') continue;
            const outcome = stepOutcomes.get(call.id);
            const text = typeof outcome?.result === 'string' ? outcome.result : '';
            const block = /Screenshots:\n((?:  - .+\n?)+)/.exec(text);
            if (!block) continue;
            const files = block[1]!.split('\n').map(l => l.replace(/^  - /, '').trim()).filter(Boolean).slice(0, 4);
            const refs: ImageRef[] = [];
            for (const file of files) {
              const ref = await opts.storeImage(file).catch(() => undefined);
              if (ref) refs.push(ref);
            }
            if (refs.length > 0) {
              transcript.recordUserMessage(
                `The ${refs.length === 1 ? 'screenshot' : `${refs.length} screenshots`} VerifyApp took, in order: ${refs.map(r => r.name ?? 'image').join(', ')}. `
                + 'Look at them as a person would — hierarchy, spacing, empty states, anything cut off or overlapping — and fix what a paying user would notice.',
                { kind: 'plugin', plugin: 'verify-app' },
                refs,
              );
            }
          }
        }

        // A cancelled step has recorded results for everything; surface the
        // abort so the turn closes as aborted rather than continuing.
        if (scheduled.aborted) throwIfLoopAborted();

        // A proposed plan is the end of a planning turn, and the loop is what
        // makes that true. The prompt asks the model to call ProposePlan once
        // and stop; watched live, it proposed a plan, carried on, proposed the
        // same plan again, and again — three calls and climbing, each one a
        // paid round trip producing a plan that already existed.
        //
        // Enforced here rather than asked for, for the same reason
        // read-before-edit moved out of the prompt: an instruction the model
        // may decline is not a contract. There is genuinely nothing left to do
        // — the reader has to answer before any of it can happen.
        if (opts.planMode && toolCalls.some(call => call.name === 'ProposePlan')) {
          turnEndReason = { kind: 'completed' };
          if (!silent) stopSpinner();
          return;
        }
        // The same, in any mode, for a plan that became a long-job proposal:
        // the person decides before anything else happens (longjob/).
        if (jobSession && toolCalls.some(call => call.name === 'ProposePlan') && pendingJob(jobSession)) {
          turnEndReason = { kind: 'completed' };
          if (!silent) stopSpinner();
          return;
        }

        // Step boundary: deliver anything steered in while the tools ran, so a
        // correction reaches the model before it decides its next action.
        const steered = drainSteeredInput();
        if (steered > 0 && !silent) {
          showError(`Steering: ${steered} message(s) received — applying at this step.`);
        }

        /*
          Restate the goal, occasionally, where the next decision is made.

          The goal is in the system prompt, and on most vendors that is the only
          place it appears: only Gemini's dialect asks for a tail restatement,
          and those choices are researched rather than arbitrary. So on a turn
          that runs twenty steps, a standing objective sits thousands of tokens
          behind every decision after the first — which is what "I set a goal
          and it was ignored" actually looks like from inside.

          A goal is meant to constrain the whole turn, so it is repeated in the
          turn rather than only in the prompt. Every sixth step, one sentence:
          often enough to stay in view, rare and short enough that it costs
          almost nothing, and appended rather than inserted so the cached prefix
          is untouched.

          It is recorded as a plugin message, so a reader sees a system note
          naming what wrote it rather than words they appear to have typed.
        */
        if (opts.goal?.trim() && iterations > 0 && iterations % GOAL_REMINDER_EVERY === 0) {
          transcript.recordUserMessage(
            `Standing objective for this session: ${opts.goal.trim()}
`
            + 'If the next step does not serve it, say so instead of doing it.',
            { kind: 'plugin', plugin: 'session-goal' },
          );
        }

        // Back to thinking for next iteration
        if (!silent) startSpinner('Thinking…');
      } finally {
        transcript.endStep();
      }
    }
  }

  try {
    await withRetry(runLoop, 5, silent, loopSignal);
    // Every normal exit assigns a reason; the fallback covers the theoretical
    // case of the loop breaking without one rather than logging `undefined`.
    transcript.endTurn(turnEndReason ?? { kind: 'completed' });
  } catch (err) {
    // A failure still closes the turn. An unlabelled turn end would break the
    // balance invariant and make the transcript unreadable at exactly the
    // moment someone is trying to work out what went wrong.
    const reason = classifyTurnEnd(err, loopSignal.aborted);
    transcript.endTurn(reason);

    /*
      Take the model's real context window out of the rejection.

      A provider that refuses an oversized request nearly always states the
      limit — "this model's maximum context length is N tokens". That sentence
      is authoritative, arrives at no cost because the request has already
      failed, and works for models that did not exist when this was written,
      which is the case no built-in table can ever cover.

      Fire-and-forget: learning the number must never be able to change how the
      failure itself is reported.
      */
    if (reason.kind === 'error') {
      void noteWindowFromError(model, reason.message, settings)
        .then(learned => {
          if (learned !== undefined && !silent) {
            showError(
              `Noted: ${model} holds ${learned.toLocaleString()} tokens. `
              + 'Recorded, so this will not happen again.',
            );
          }
        })
        .catch(() => { /* a failed lesson is not worth a second error */ });
    }
    if (reason.kind === 'aborted' && opts.inbox) {
      // Steering input was addressed to a turn that no longer exists, so
      // delivering it to the next one would apply a correction out of context.
      // Queued followups are separate requests and survive — and so does a
      // background agent's report: it is not a correction to this turn, and
      // discarding it would lose the work it describes (ADR 0021).
      const abandoned = opts.inbox.discardStep(m =>
        m.source.kind === 'plugin' && (m.source.plugin === 'background-agent' || m.source.plugin === 'background-command'));
      if (abandoned.length > 0 && !silent) {
        showError(`Cancelled: ${abandoned.length} steering message(s) discarded.`);
      }
    }
    throw err;
  } finally {
    // Always clear the wall-clock timer so it can never keep the event loop
    // alive past completion (the old code discarded the handle entirely).
    if (timeoutTimer) clearTimeout(timeoutTimer);
    if (budgetTimer) clearTimeout(budgetTimer);
    detachCallerAbort?.();
  }

  // Written once the turn is over, so a checkpoint always describes a
  // completed piece of work rather than a snapshot taken mid-edit. Nothing is
  // stored when nothing was written.
  if (checkpointStore) await commitCheckpoint();

  // ── Token tracking ─────────────────────────────────────────────────
  if (tokenTracker) {
    // Usage is committed per request inside the loop, so there is normally
    // nothing left to record here. The exception is a provider that never
    // emitted a usage event at all: without a fallback that turn would be
    // free as far as the cost ceiling is concerned, which is precisely the
    // blind spot a ceiling exists to remove.
    if (committedRequests === 0) {
      // Counted from the whole conversation, not just the opening message.
      // The previous version summed the first user message and the system
      // prompt, which for a turn that made a dozen tool calls under-reported
      // the prompt by most of its actual size — and since this is also what
      // the spend ceiling reads, the runs least likely to be measured were
      // also the ones least likely to be stopped.
      const promptText = transcript.messages()
        .map(message => message.content)
        .join('\n');
      tokenTracker.add(
        estimateTokens(systemPrompt) + estimateTokens(promptText),
        estimateTokens(finalContent),
        0,
        0,
        // Not a measurement. Every surface that shows these says so.
        false,
      );
    }
    const inputTokens = totalInputTokens > 0
      ? totalInputTokens
      : estimateTokens(userMessage) + estimateTokens(systemPrompt);

    const totalEstimate = estimateTokens(
      conversationHistory.map(m => m.content).join('\n'),
    ) + inputTokens;
    const CONTEXT_WARNING_THRESHOLD = 100_000;
    if (totalEstimate > CONTEXT_WARNING_THRESHOLD && !silent) {
      showError(
        `Context usage ~${Math.round(totalEstimate / 1000)}K tokens — approaching limit. ` +
        `Use /compact to free space.`,
      );
    }

    // Enforcement lives at the top of the step loop — that is the only place a
    // ceiling can prevent spend rather than describe it. But the breaker can
    // only stop the *next* call, and a single step that blows through the
    // ceiling on its own has already spent the money by the time anyone can
    // check. Reporting that is still worth doing: without it the user first
    // learns they are over budget on some later turn that mysteriously refuses
    // to run. The wording says what actually happened rather than claiming a
    // stop that did not occur.
    const endBreach = checkSafetyLimits();
    if (endBreach && turnEndReason?.kind !== 'aborted') {
      if (!silent) {
        showError(`Over the safety limit: ${endBreach}. The next step will not run.`);
      }
      finalContent =
        `⚠ Over the safety limit — ${endBreach}. The next model call will be blocked.\n\n`
        + finalContent;
    }
  }

  // ── Stop hook ──────────────────────────────────────────────────────
  // Session-scoped, like SessionStart above — see the note there.
  if (settings && depth === 0) await runHooks('Stop', { event: 'Stop' }, settings);

  return finalContent;
}
