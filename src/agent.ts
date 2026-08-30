import path from 'path';
import fs from 'fs';
import chalk from 'chalk';
import { buildSystemPrompt, buildVolatileContext } from './prompts.js';
import { PromptDocument, renderPrompt, renderTail, DEFAULT_DIALECT } from './prompt/index.js';
import { spillResult } from './tools/spill.js';
import { toolDefinitions, executeTool, setBashDefaultTimeout, getToolsForAgent, getToolsForSpec, truncateResult, type SubAgentType } from './tools/index.js';
import { taskToolDefinition, runTask } from './tools/task.js';
import { mcpRegistry } from './mcp.js';
import { checkPermission } from './permissions.js';
import { classifyBashCommand, isBashReadOnly } from './safety.js';
import { setAskUserCallback } from './tools/askuser.js';
import { getOpenTodoCount } from './tools/todo.js';
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
import { modelAccepts, explainRefusal } from './model-capabilities.js';
import type { AicoSettings } from './settings.js';
import { selectProvider } from './providers/index.js';
import { detectProviderType } from './providers/index.js';
import { ensureContextWindow } from './context-window.js';
import type { ToolDef, ToolCall, FinishReason, ReasoningTrace } from './providers/types.js';
import type { Inbox, Session, TurnEndReason, Usage } from './session/index.js';
import { canonicalHeader } from './session/index.js';
import { LegacyTranscript, SessionTranscript, type Transcript } from './session/transcript.js';
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
import { runInContext } from './run-context.js';
import { buildRuntimeAwareness } from './capabilities.js';
import { listAgentSpecs } from './agents/registry.js';
import { skillRegistry } from './skills/index.js';
import { cronScheduler } from './cron/scheduler.js';
import { getBackgroundAgents } from './background/index.js';
import { getAgentRegistry } from './tools/task.js';
import { investigate, investigateDefinition, type InvestigateInput } from './tools/investigate.js';
import { checkVerificationGate, resetVerification } from './verification.js';
import { setBrief } from './requirements.js';
import { checkProjectGate, detectChecks, resetChecks } from './checks.js';
import { skillCatalogue, matchingSkills } from './tools/skill.js';
import { loadKnowledge } from './knowledge/store.js';
import { beginCheckpoint, commitCheckpoint } from './checkpoint/index.js';
import { checkpointDir } from './tools/checkpoint.js';
import { matchKnowledge, renderKnowledge } from './knowledge/match.js';
import { activeMemories } from './memory/store.js';
import { currentCwd } from './run-context.js';
import { resetObservations } from './tools/observation.js';

// Increase max listeners to avoid warnings during long tool chains
process.setMaxListeners(50);

// ── Retry helpers ────────────────────────────────────────────────────

function isRetryableError(err: unknown): boolean {
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
    'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE', 'EAI_AGAIN',
    'socket hang up', 'network',
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
  /** Ink UI AskUser callback — agent pauses to ask human a question */
  onAskUser?: (question: string) => Promise<string>;
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
  /**
   * Fetch the bytes behind image references.
   *
   * Injected rather than imported, because the store that holds them belongs
   * to whoever took the upload — the web server here — and the agent core has
   * no business knowing about it. Answers positionally: one slot per reference,
   * `undefined` for anything it cannot find.
   */
  resolveImages?: (refs: ImageRef[]) => Promise<Array<ImagePart | undefined>>;
  /** Sub-agent type — restricts available tools */
  agentType?: SubAgentType;
  /**
   * Dynamic tool whitelist from agent_spec or agent_name resolution. When set,
   * overrides agentType-based tool selection — lets custom agents have exactly
   * the tools their spec defines ('all', 'readonly', or explicit names).
   */
  agentSpecTools?: string[] | 'all' | 'readonly';
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
  onAskUser?: (question: string) => Promise<string>;
  silent?: boolean;
  agentType?: SubAgentType;
  planMode?: boolean;
  /** Composed tool set. Authoritative when present. */
  toolRegistry?: ToolRegistryCapability;
  /** Identity used for per-agent guard state (repeat detection, metrics). */
  agentId: string;
  /** Pipeline to register policy on. A fresh one is built when omitted. */
  pipeline?: ToolPipeline;
  /** Forwarded into each call's context so stages can observe cancellation. */
  signal?: AbortSignal;
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
function resolveToolSet(opts: {
  toolRegistry?: ToolRegistryCapability;
  agentType?: SubAgentType;
  agentSpecTools?: string[] | 'all' | 'readonly';
  toolProfile?: AgentToolProfile;
  planMode?: boolean;
  settings?: AicoSettings;
  /** 0 for the conversation itself; 1 or more inside a delegation. */
  depth?: number;
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

  if (opts.toolProfile === 'browser-qa') {
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
    defs = defs.filter(d => d.name !== 'AgentSupervise');
  }

  // Mini Apps are a plugin, and "off" has to mean the model cannot see the
  // tool — not that it is told not to use it. A tool present in the list is a
  // tool that gets called eventually, and calling it while the host is not
  // listening builds an app nobody can open.
  if (!opts.settings?.miniApps?.enabled) {
    defs = defs.filter(d => d.name !== 'MiniAppManage');
  }

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

  return { defs, dispatch };
}

/** Tools a plan-mode run may use. Read-only by construction. */
const PLAN_MODE_TOOLS = new Set([
  'Read', 'Glob', 'Grep', 'LS', 'WebFetch', 'WebSearch', 'Pwd', 'TodoRead',
  // Read-only, and orientation is most of what a planning turn does. Leaving
  // it out would make planning the one mode that still has to Glob its way
  // around a project it could have asked about once.
  'CodebaseMap',
  // How a planning turn ends. Without it the only way to deliver a plan was
  // prose, which can be read and cannot be answered.
  'ProposePlan',
]);

/**
 * Build a map of { toolName → async handler } for all tools available in this
 * agent context. Handlers include permission checks, safety checks, and hooks.
 */
function buildToolHandlers(opts: ToolHandlerOpts & { toolProfile?: AgentToolProfile; agentSpecTools?: string[] | 'all' | 'readonly'; depth?: number }): Map<string, ToolHandler> {
  // Tool set and dispatch come from the registry when one is composed, and from
  // the historical built-in selection otherwise.
  const { defs, dispatch } = resolveToolSet(opts);

  // ── Policy pipeline ────────────────────────────────────────────────
  // The same concerns the old inline closure handled, now as ordered named
  // stages. Registration order below reproduces the original order exactly:
  //   PreToolUse hook → plan-mode → bash safety → permission → body → PostToolUse
  // Everything after this point can be extended (timeouts, retries, metrics,
  // loop guards) without touching the agent loop.
  const pipeline = opts.pipeline ?? new ToolPipeline();

  pipeline.onPreExecute('hooks:pre-tool-use', async (ctx, next) => {
    if (!opts.settings) return next();
    // Isolated: a throwing hook must not mask the real tool result — degrade to
    // a warning and proceed with the call.
    let hookResult: string | undefined;
    try {
      hookResult = await runHooks(
        'PreToolUse',
        { event: 'PreToolUse', toolName: ctx.name, toolArgs: ctx.arguments },
        opts.settings,
      );
    } catch (hookErr) {
      const reason = hookErr instanceof Error ? hookErr.message : String(hookErr);
      if (!opts.silent) showError(`PreToolUse hook for ${ctx.name} failed: ${reason} (continuing)`);
    }
    if (hookResult === 'block') {
      return { kind: 'deny', reason: 'Blocked by PreToolUse hook' };
    }
    return next();
  });

  if (opts.planMode) {
    pipeline.onGuard('plan-mode', (ctx) => {
      if (ctx.name === 'Bash' && ctx.arguments.command && !isBashReadOnly(String(ctx.arguments.command))) {
        return {
          kind: 'deny',
          reason: 'Plan mode: only read-only commands allowed. This command may modify files.',
        };
      }
      return { kind: 'abstain' };
    });
  }

  pipeline.onGuard('bash-safety', (ctx) => {
    if (ctx.name !== 'Bash' || !ctx.arguments.command) return { kind: 'abstain' };
    const safety = classifyBashCommand(String(ctx.arguments.command));
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

    const args = ctx.arguments;
    let allowed: boolean;
    if (opts.onPermissionRequest) {
      const detail = String(args.command ?? args.file_path ?? args.path ?? args.pattern ?? args.url ?? args.name ?? '');
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
      allowed = await opts.onPermissionRequest(ctx.name, detail.slice(0, 100), fileDiff);
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

  for (const def of defs) {
    handlers.set(def.name, async (args: Record<string, unknown>, callId: string) => {
      if (!opts.silent) showToolCall(def.name, args, opts.verbose);
      opts.onToolCall?.(def.name, args, callId);

      const ctx: ToolCallContext = {
        callId,
        name: def.name,
        arguments: args,
        agentId: opts.agentId,
        state: new Map<string, unknown>(),
        ...(opts.signal ? { signal: opts.signal } : {}),
      };

      const outcome = await pipeline.execute(
        ctx,
        (call) => dispatch(call.name, call.arguments, call.callId, call.signal),
      );
      const result = outcome.outcome.result;

      if (!opts.silent) showToolResult(def.name, result, opts.verbose);
      opts.onToolDone?.(def.name, result, callId);

      return {
        result,
        ...(outcome.additionalContexts.length > 0
          ? { additionalContexts: outcome.additionalContexts }
          : {}),
      };
    });
  }

  return handlers;
}

/**
 * Build the provider-facing ToolDef list (name, description, inputSchema).
 *
 * Shares {@link resolveToolSet} with the handler map so the schemas the model
 * sees and the handlers that can actually run cannot drift apart — a mismatch
 * there is a model calling a tool that does not exist.
 */
function buildToolDefs(opts: {
  toolRegistry?: ToolRegistryCapability;
  agentType?: SubAgentType;
  planMode?: boolean;
  toolProfile?: AgentToolProfile;
  agentSpecTools?: string[] | 'all' | 'readonly';
  settings?: AicoSettings;
}): ToolDef[] {
  return resolveToolSet(opts).defs.map(d => ({
    name: d.name,
    description: d.description,
    inputSchema: d.inputSchema,
  }));
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
 */
export async function projectImages(
  messages: AicoMessage[],
  model: string,
  settings: AicoSettings | undefined,
  resolve: ((refs: ImageRef[]) => Promise<Array<ImagePart | undefined>>) | undefined,
  cache: Map<string, ImagePart>,
): Promise<AicoMessage[]> {
  if (!messages.some(m => m.role === 'user' && m.imageRefs?.length)) return messages;

  if (!modelAccepts(model, 'image', settings)) {
    const reason = explainRefusal(model, 'image', settings)
      ?? 'this model does not read images';
    return messages.map((message) => {
      if (message.role !== 'user' || !message.imageRefs?.length) return message;
      const notes = message.imageRefs
        .map(ref => `[${ref.name ?? 'image'} was attached but not sent: ${reason}]`)
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
  if (wanted.length > 0) {
    try {
      // Answered positionally, so a resolver that cannot find one image says
      // so in that slot rather than returning a shorter list and silently
      // shifting every picture onto the wrong message.
      const parts = await resolve(wanted);
      wanted.forEach((ref, index) => {
        const part = parts[index];
        if (part) cache.set(ref.id, part);
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
    return images.length > 0 ? { ...message, images } : message;
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
export async function runAgent(opts: AgentOptions): Promise<string> {
  return runInContext(
    {
      cwd: opts.cwd ?? process.cwd(),
      ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
      ...(opts.settings ? { settings: opts.settings } : {}),
    },
    () => runAgentInContext(opts),
  );
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
  setWorkspaceRuntime({ settings, sessionId: opts.sessionId });

  // Wire bash default timeout from settings
  if (settings?.bashTimeout !== undefined) {
    setBashDefaultTimeout(settings.bashTimeout);
  }

  const depth = opts.depth ?? 0;
  const toolProfile = selectToolProfile(task);

  // ── System prompt ──────────────────────────────────────────────────
  // Built as a document, not a string: it is rendered below in whatever shape
  // the resolved provider's vendor documents as best (XML for Anthropic,
  // Markdown for the rest). The content is authored once regardless.
  const promptDoc = await buildSystemPrompt(
    model, opts.effort, opts.projectInstructions, opts.goal, skillCatalogue(), opts.planMode,
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
  const runtimeAwareness = await buildRuntimeAwareness({
    model,
    cwd: process.cwd(),
    sessionId: opts.sessionId,
    settings,
    tools: (opts.agentType ? getToolsForAgent(opts.agentType) : toolDefinitions).map((t) => ({
      name: t.name,
      description: t.description,
    })),
    mcpServers: mcpRegistry.getServerInfos(),
    workspace: getWorkspaceInfo({ settings, sessionId: opts.sessionId }),
    agents: await listAgentSpecs(),
    skills: skillRegistry.list(),
    cronJobs: cronScheduler.getJobs(),
    backgroundAgents: getBackgroundAgents(),
    subAgents: getAgentRegistry(),
    // Everything remembered that applies to this directory and this
    // conversation. Read at build time rather than cached: a memory saved
    // during a turn should be in effect on the next one, not next launch.
    memories: activeMemories(currentCwd(), opts.sessionId).map(m => ({
      id: m.id, scope: m.scope, text: m.text,
    })),
  });
  // ── Volatile context ───────────────────────────────────────────────
  // Everything here changes between turns: the working tree moves whenever the
  // agent writes a file, the runtime roster moves as background agents and cron
  // jobs come and go, and the QA note depends on the task. None of it can sit
  // in `systemPrompt` — system renders before messages, so a byte of churn
  // there invalidates the cached transcript behind it, which for a coding agent
  // is most turns. It is delivered at the tail of the request instead, where it
  // invalidates nothing. See ProviderChatOptions.volatileContext.
  const volatileDoc = new PromptDocument()
    .add({ id: 'working_tree', body: await buildVolatileContext() })
    .add({ id: 'runtime_awareness', body: runtimeAwareness });

  // A skill whose trigger matches this request is named as a match rather than
  // left sitting in a list of twenty descriptions. "Prefer a skill when one
  // fits" is easy to write in a prompt and easy to skim past; pointing at the
  // specific skill that fits, in the volatile tail where the request itself
  // lives, is the version that acts. It stays a recommendation — the model can
  // still decide the skill is wrong for this case, which is why the wording
  // says consider rather than must.
  const matched = matchingSkills(task);
  if (matched.length > 0) {
    volatileDoc.add({
      id: 'matching_skills',
      body: [
        'These installed skills declare that they are for requests like this one:',
        ...matched.map(s => `- ${s.frontmatter.name}: ${s.frontmatter.description}`),
        'Open the relevant one with Skill before working the procedure out yourself. '
        + 'If none of them actually fit, say so and carry on.',
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

  const handlerOpts: ToolHandlerOpts & { toolProfile: AgentToolProfile; agentSpecTools?: string[] | 'all' | 'readonly'; depth?: number } = {
    autoApprove, verbose, settings, onToolCall, onToolDone,
    onPermissionRequest, onAskUser, silent,
    agentType: opts.agentType, planMode: opts.planMode, toolProfile,
    agentId, pipeline, signal: loopSignal, depth,
    ...(toolRegistry ? { toolRegistry } : {}),
    ...(opts.agentSpecTools ? { agentSpecTools: opts.agentSpecTools } : {}),
  };
  const handlers = buildToolHandlers(handlerOpts);

  // Loop-breaker. Advisory only: it never vetoes a call, it injects an
  // escalating reminder when the model repeats one verbatim. Registered after
  // the hook stage so a hook's own view of the result is unaffected. Disabled
  // for sub-agents, which are short-lived and return to an orchestrator that
  // can judge repetition itself.
  const repeatGuard = settings?.repeatGuard?.enabled === false || depth > 0
    ? undefined
    : new RepeatToolGuard(settings?.repeatGuard ?? {});
  repeatGuard?.install(pipeline);

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

  // Add Task tool (sub-agent dispatch) if within depth limit
  if (depth < 4 && toolProfile !== 'browser-qa') {
    handlers.set(taskToolDefinition.name, async (args: Record<string, unknown>, callId: string) => {
      const { description, prompt, model: taskModel, subagent_type, agent_name, agent_spec, timeout } = args as {
        description: string; prompt: string; model?: string;
        subagent_type?: SubAgentType; agent_name?: string;
        agent_spec?: { instructions?: string; tools?: string[] | 'all' | 'readonly'; model?: string; role?: string };
        timeout?: number;
      };
      onToolCall?.(taskToolDefinition.name, args, callId);
      try {
        const result = await runTask(
          { description, prompt, model: taskModel, subagent_type, agent_name, agent_spec, timeout },
          {
            token: opts.token ?? '',
            model,
            autoApprove,
            verbose,
            depth,
            settings,
            // Constraints the child must inherit — see the note in runTask.
            ...(opts.context ? { context: opts.context } : {}),
            ...(tokenTracker ? { tokenTracker } : {}),
            ...(opts.planMode ? { planMode: true } : {}),
            onSubagentStart: opts.onSubagentStart,
            onSubagentStop: opts.onSubagentStop,
          },
        );
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
          const result = await investigate(args as InvestigateInput, {
            token: opts.token ?? '',
            model,
            autoApprove,
            verbose,
            depth,
            settings,
            ...(opts.context ? { context: opts.context } : {}),
            ...(tokenTracker ? { tokenTracker } : {}),
            ...(opts.planMode ? { planMode: true } : {}),
            onSubagentStart: opts.onSubagentStart,
            onSubagentStop: opts.onSubagentStop,
          });
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

  // Add MCP tools. In browser QA mode, keep only Playwright tools in the active
  // surface; sending every coding/MCP tool schema slows each model turn.
  const mcpTools = mcpRegistry.getToolsForAgent().filter((t) =>
    toolProfile === 'browser-qa' ? t.name.startsWith('mcp__playwright__') : true,
  );
  for (const t of mcpTools) {
    handlers.set(t.name, async (args: Record<string, unknown>, callId: string) => {
      if (!silent) showToolCall(t.name, args, verbose);
      onToolCall?.(t.name, args, callId);
      try {
        // Same budget as before; the overflow is now kept rather than cut.
        const result = spillResult(await t.execute(args), 80_000, t.name, callId);
        if (!silent) showToolResult(t.name, result, verbose);
        onToolDone?.(t.name, result, callId);
        return { result };
      } catch (err) {
        const error = { error: err instanceof Error ? err.message : String(err) };
        if (!silent) showToolResult(t.name, error, verbose);
        onToolDone?.(t.name, error, callId);
        return { result: error };
      }
    });
  }

  // Build ToolDef array for the provider
  const toolDefs: ToolDef[] = buildToolDefs({
    agentType: opts.agentType, planMode: opts.planMode, toolProfile,
    ...(toolRegistry ? { toolRegistry } : {}),
    ...(opts.agentSpecTools ? { agentSpecTools: opts.agentSpecTools } : {}),
    ...(settings ? { settings } : {}),
  });
  // Add Task tool def
  if (depth < 4 && toolProfile !== 'browser-qa') {
    toolDefs.push({
      name: taskToolDefinition.name,
      description: taskToolDefinition.description,
      inputSchema: taskToolDefinition.inputSchema,
    });
    // Same depth gate as Task, and the same reason: it spawns sub-agents.
    // Offered only where they can actually run, so the model is never shown a
    // fan-out it would be refused for using.
    if (!settings?.disabledTools?.includes('Investigate')) {
      toolDefs.push({
        name: investigateDefinition.name,
        description: investigateDefinition.description,
        inputSchema: investigateDefinition.inputSchema,
      });
    }
  }
  // Add MCP tool defs
  for (const t of mcpTools) {
    toolDefs.push({ name: t.name, description: t.description, inputSchema: t.inputSchema });
  }

  // ── Build user message ─────────────────────────────────────────────
  /**
   * Image bytes already fetched for this run, by reference id.
   *
   * A turn is many requests and the pictures do not change between them, so
   * reading them from the store on every step would make a screenshot cost
   * more the longer the agent spent working on it.
   */
  const imageCache = new Map<string, ImagePart>();

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

  // ── Auto-detect context window on first interaction ────────────────
  // If the model's context window isn't already persisted in settings,
  // query the provider's model-info endpoint to detect it. The result is
  // cached permanently in ~/.aico/settings.json so detection runs only once.
  // Non-blocking — if detection fails, the built-in table is used.
  try {
    const provId = detectProviderType(model, settings);
    if (provId) {
      ensureContextWindow(model, provId, settings).catch(() => {});
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
    // Hashed together so the header still identifies everything non-conversational
    // the model was shown. Moving the volatile half out of `systemPrompt` changed
    // where it is sent, not whether the log can account for it.
    systemPrompt: `${systemPrompt}\n${volatileContext}`,
    tools: toolDefs.map(d => d.name),
  }));

  transcript.beginTurn();
  // The images ride with this exact message, not the turn: a completion-gate
  // nudge later in the same turn is a different message and must not inherit
  // the reader's screenshot.
  transcript.recordUserMessage(userMessage, undefined, opts.images);

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
  const maxIterations = settings?.maxIterations && settings.maxIterations > 0
    ? settings.maxIterations : 100;

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
  resetChecks();
  // The user's own words are the standard the work is held to. Taken from the
  // task rather than from anything the model writes: a model that authors its
  // own acceptance criteria authors ones it has met.
  setBrief(opts.task ?? '');

  /**
   * Whether cumulative spend has passed a configured ceiling.
   *
   * Returns a human-readable breach description, or undefined to continue.
   * Evaluated at the top of every step so it fires *before* another model call
   * is paid for, rather than describing one already made. Reads the live
   * tracker, which now includes the in-flight turn.
   */
  const checkSafetyLimits = (): string | undefined => {
    const limits = settings?.safetyLimits;
    if (!limits || !tokenTracker) return undefined;
    const usage = tokenTracker.getUsage();

    const total = usage.inputTokens + usage.outputTokens;
    if (limits.maxTokensPerSession && limits.maxTokensPerSession > 0
        && total > limits.maxTokensPerSession) {
      return `token limit reached (${total.toLocaleString()} > `
        + `${limits.maxTokensPerSession.toLocaleString()} maxTokensPerSession)`;
    }

    if (limits.maxCostPerSession && limits.maxCostPerSession > 0) {
      const cost = tokenTracker.estimateCost(model, settings);
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

  async function runLoop(): Promise<void> {
    throwIfLoopAborted();
    if (!silent) startSpinner('Thinking…');

    let iterations = 0;
    // Track how many times the completion gate has nudged the model to keep
    // working despite open todos. Capped so a stuck agent isn't trapped forever.
    let completionNudges = 0;
    /** Recovery attempts after a step was cut off at the output ceiling. */
    let truncationRetries = 0;
    /** Times this turn has been sent back for an unverified or failing artifact. */
    let verificationNudges = 0;
    /** Times this turn has been sent back over failing or stale project checks. */
    let checksNudges = 0;
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

/**
 * How many times a turn may be sent back over its own project checks.
 *
 * Three, like the browser gate: the first usually buys the only run of the
 * suite in the whole turn, and the ones after it are real fix-and-recheck
 * cycles rather than reminders.
 */
const MAX_CHECKS_NUDGES = 3;

const MAX_COMPLETION_NUDGES = 2;

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
        throw new Error(
          `Agent exceeded the iteration cap (${maxIterations}) without finishing. ` +
          `Increase settings.maxIterations or restructure the task into smaller sub-tasks.`,
        );
      }

      // One step = one model request plus the tools it calls. The boundary is
      // durable, and closing it in a `finally` means a thrown stream still
      // leaves a balanced log for the retry (which opens a fresh step) to
      // append onto.
      transcript.beginStep();
      try {
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

        // Derived fresh every step. On the session path this means the log IS
        // the request rather than a mirror of it, so anything the model sees is
        // by construction reconstructable.
        //
        // Images are the one thing the log does not hold literally: it holds
        // references, and they become bytes — or a sentence saying why not —
        // here, where the model for this request is finally known.
        const requestMessages = await projectImages(
          transcript.messages(), model, settings, opts.resolveImages, imageCache,
        );

        // Stream from provider — forward the merged signal so a cancel/timeout
        // tears down the in-flight HTTP stream instead of leaking the socket.
        try {
          for await (const event of provider.chat({
            model,
            systemPrompt,
            volatileContext,
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
              totalCachedTokens += cacheRead;
              totalCacheWriteTokens += cacheWrite;
              // Committed to the tracker HERE, per request, rather than once
              // after the loop. A turn can make up to `maxIterations` model
              // calls, so a tracker that only learns about them afterwards
              // cannot stop a runaway turn — it can only describe one.
              tokenTracker?.add(event.inputTokens, event.outputTokens, cacheRead, cacheWrite);
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
          if (completionGateEnabled && checksNudges < MAX_CHECKS_NUDGES) {
            const gate = checkProjectGate(detectChecks(currentCwd()));
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

        if (!silent) stopSpinner();

        // ── Schedule this step's tool calls ─────────────────────────
        // Parallel-safe calls share a bounded rolling pool; exclusive ones are
        // barriers. Dispatch overlaps, but results commit in MODEL order so the
        // log — and therefore the next request — reads in the order the model
        // asked, regardless of which call finished first.
        const scheduled = await scheduleToolCalls(toolCalls, {
          maxParallel,
          executionMode: (call) => getExecutionMode(call.name),
          onStart: (call) => {
            if (!silent) startSpinner(`${call.name}…`);
            transcript.recordToolCall(call);
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
                const invocation = await handler(call.input, call.id);
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

            return {
              result,
              isError: typeof result === 'object' && result !== null && 'error' in result,
              ...(contexts?.length ? { additionalContexts: contexts } : {}),
            };
          },
          onCommit: (call, outcome) => {
            if (!silent) stopSpinner();
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
    if (reason.kind === 'aborted' && opts.inbox) {
      // Steering input was addressed to a turn that no longer exists, so
      // delivering it to the next one would apply a correction out of context.
      // Queued followups are separate requests and survive.
      const abandoned = opts.inbox.claimStep();
      if (abandoned.length > 0 && !silent) {
        showError(`Cancelled: ${abandoned.length} steering message(s) discarded.`);
      }
    }
    throw err;
  } finally {
    // Always clear the wall-clock timer so it can never keep the event loop
    // alive past completion (the old code discarded the handle entirely).
    if (timeoutTimer) clearTimeout(timeoutTimer);
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
