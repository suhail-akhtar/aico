import { createChildTracker } from '../tokens.js';
import crypto from 'crypto';
import type { SubAgentType } from './index.js';
import { runHooks } from '../hooks.js';
import type { AicoSettings } from '../settings.js';
import { AGENT_PROMPTS, REPORT_CONTRACT } from '../agents/prompts-registry.js';
import { workOf, absorbWork } from '../checks.js';
import { noteFileWritten } from '../verification.js';
import { loadProfile, renderProfile } from '../project/profile.js';
import { projectRoot } from '../run-context.js';

/**
 * The parent's project profile, appended to a sub-agent's brief.
 *
 * A specialist that has to rediscover the stack spends its first four tool
 * calls reading manifests the parent already knows by heart. A few hundred
 * tokens in the brief, once, is cheaper than that on every delegation.
 */
function withProjectProfile(brief: string): string {
  const profile = renderProfile(loadProfile(projectRoot()));
  return profile ? `${brief}\n\n---\n\nProject profile (trust this; skip the manifest read):\n${profile}` : brief;
}
import { currentCwd, currentRunContext } from '../run-context.js';
import { openSession } from '../session/open.js';
import { Inbox } from '../session/inbox.js';

// ── Sub-agent status types (mirrors Claude Code's task states) ─────────────
export type SubAgentStatus = 'running' | 'completed' | 'failed' | 'cancelled';

export interface SubAgentRecord {
  agentId: string;
  /**
   * The session that ultimately owns this agent.
   *
   * The registry is one map for the whole process, so a server driving three
   * conversations at once has all of their sub-agents in it. Without an owner
   * every watcher sees every agent, and a browser tab shows work belonging to
   * a session in another window.
   *
   * "Ultimately" matters: a sub-agent runs under a session id of its own
   * (`sub-<agentId>`), so an agent that spawns an agent would otherwise be
   * owned by its parent rather than by the conversation a person is watching.
   * Resolved through {@link OWNER_OF_SUB_SESSION} at spawn time.
   */
  sessionId?: string;
  description: string;
  model: string;
  status: SubAgentStatus;
  statusMessage: string;
  startedAt: number;
  completedAt?: number;
  result?: string;
  error?: string;
  depth: number;
  agentType: SubAgentType;
  /** Last tool activity timestamp — used for heartbeat timeout */
  lastActivityAt: number;
  /** Number of tool calls made by this agent */
  toolCallCount: number;
  /** Current tool being executed */
  currentTool?: string;
  /** Cumulative input tokens consumed by this sub-agent */
  inputTokens: number;
  /** Cumulative output tokens consumed by this sub-agent */
  outputTokens: number;
  /** Cumulative cached tokens consumed by this sub-agent */
  cachedTokens: number;
}

// ── Sub-agent colors (Claude Code uses distinct colors per agent) ──────────
const AGENT_COLORS = [
  'cyan', 'green', 'magenta', 'blue', 'yellow', 'red',
] as const;

// ── Global registry — shared across all runAgent calls ───────────────────
const _registry = new Map<string, SubAgentRecord>();
let _listeners: Array<(records: SubAgentRecord[]) => void> = [];

export function subscribeToAgents(fn: (records: SubAgentRecord[]) => void): () => void {
  _listeners.push(fn);
  fn([..._registry.values()]);  // immediate snapshot
  return () => { _listeners = _listeners.filter(l => l !== fn); };
}

function _emit() {
  const snap = [..._registry.values()];
  _listeners.forEach(l => l(snap));
}

function isTerminal(status: SubAgentStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

/**
 * `sub-<agentId>` → the conversation that owns it.
 *
 * Lets a nested spawn climb back to the session a person is actually looking
 * at. Entries are kept for the life of the process alongside the record they
 * describe; they are two small strings each, and dropping one would orphan any
 * agent a completed agent had spawned.
 */
const OWNER_OF_SUB_SESSION = new Map<string, string>();

/** The conversation a spawn belongs to, climbing out of any nesting. */
export function owningSession(sessionId: string | undefined): string | undefined {
  let current = sessionId;
  // Bounded: a cycle here would be a bug, but an unbounded walk would be a
  // hang, and sub-agent depth is limited to single digits anyway.
  for (let hop = 0; hop < 16 && current; hop++) {
    const owner = OWNER_OF_SUB_SESSION.get(current);
    if (!owner) return current;
    current = owner;
  }
  return current;
}

/**
 * How to stop each running sub-agent, by id.
 *
 * Separate from the record because a record is data — it crosses the wire to a
 * browser, gets serialised into events — and an AbortController is neither
 * serialisable nor anyone else's to hold. Keyed the same way, cleared the
 * moment the agent settles.
 *
 * Until this existed, the only thing that could stop a child was the child's
 * own watchdog or an abort of the entire turn. A supervisor watching one
 * sub-agent go wrong had exactly two options: wait it out, or kill everything
 * including the siblings doing fine.
 */
const _stops = new Map<string, { abort: (reason: string) => void }>();

/** Why a sub-agent was stopped, so the parent is told rather than left guessing. */
const _stopReasons = new Map<string, string>();

/**
 * Each running sub-agent's inbox, so a correction can reach it mid-run.
 *
 * Delivery is at the child's next step boundary, which is the only point where
 * an instruction can land without discarding what it has already learned.
 * Cancelling and re-briefing throws away every tool result it has gathered;
 * this does not.
 */
const _inboxes = new Map<string, Inbox>();

/**
 * Detached runs, so a parent that spawned without waiting can come back for
 * the result.
 *
 * Holding the promise is what makes `wait` possible at all — the work is
 * already in flight, and there is otherwise nothing to await.
 */
const _detached = new Map<string, Promise<string>>();

/** Deliver a correction to a running sub-agent. False when it has no inbox. */
export function guideAgent(agentId: string, message: string): boolean {
  const inbox = _inboxes.get(agentId);
  if (!inbox) return false;
  // `inject`, not `steer`: the distinction is recorded in the log, and a
  // correction from the orchestrator is not something a person typed.
  inbox.inject(message, { kind: 'plugin', plugin: 'supervisor' });
  return true;
}

/** The promise for a detached run, if one is still tracked. */
export function detachedRun(agentId: string): Promise<string> | undefined {
  return _detached.get(agentId);
}

/**
 * Ask one sub-agent to stop.
 *
 * Returns false when there is nothing to stop — already finished, never
 * existed, or a stale id from a previous run. Callers report that difference
 * rather than claiming a kill they did not make.
 *
 * The reason is kept, not just logged: the sub-agent's own error will say
 * "aborted", and a parent reading that with no explanation cannot tell a
 * deliberate termination from a crash. It has to know which, because one means
 * "re-plan" and the other means "retry".
 */
export function requestAgentStop(agentId: string, reason: string): boolean {
  const stop = _stops.get(agentId);
  if (!stop) return false;
  _stopReasons.set(agentId, reason);
  _update(agentId, { statusMessage: `Stopping — ${reason}` });
  stop.abort(reason);
  return true;
}

/**
 * Record an ownership link without spawning anything.
 *
 * Exists so the resolution rules can be tested without a model call. Spawning
 * a real sub-agent to assert that a map lookup climbs two levels would make
 * the check cost money and depend on a provider being up.
 */
export function registerOwnerForTest(subSessionId: string, owner: string): void {
  OWNER_OF_SUB_SESSION.set(subSessionId, owner);
}

function _register(record: SubAgentRecord) {
  _registry.set(record.agentId, record);
  if (record.sessionId) OWNER_OF_SUB_SESSION.set(`sub-${record.agentId}`, record.sessionId);
  _emit();
}

function _update(agentId: string, patch: Partial<SubAgentRecord>) {
  const existing = _registry.get(agentId);
  if (existing) {
    Object.assign(existing, patch);
    _emit();
  }
}

export function getAgentRegistry(): SubAgentRecord[] {
  return [..._registry.values()];
}

export function clearCompletedAgents() {
  for (const [id, rec] of _registry.entries()) {
    if (rec.status === 'completed' || rec.status === 'failed' || rec.status === 'cancelled') {
      _registry.delete(id);
    }
  }
  _emit();
}

// ── Tool definition ───────────────────────────────────────────────────────
/** System prompt prefixes per agent type */
const AGENT_TYPE_PROMPTS: Record<SubAgentType, string> = AGENT_PROMPTS;

/**
 * The roles Task offers: one implementer, and read-only roles named for what
 * they do rather than for a job title.
 */
export const TASK_AGENT_TYPES = ['general', 'explore', 'plan', 'review', 'verification', 'security-audit'] as const;

/**
 * Retired role names, mapped to what they now mean. The implementation
 * personas (frontend, backend, qa, healer, devops…) become `general`, whose
 * prompt follows the code that is there instead of assuming a stack;
 * `architect` designs and so becomes `plan`; `devsecops` is the read-only
 * security role. Mapped, not refused: old sessions, specs and habits name them.
 */
const LEGACY_AGENT_TYPES: Record<string, SubAgentType> = {
  frontend: 'general', backend: 'general', qa: 'general', healer: 'general',
  devops: 'general', project: 'general', 'tech-writer': 'general', 'product-owner': 'general',
  architect: 'plan', devsecops: 'security-audit',
};

/** The role a requested `subagent_type` runs as; unknown or absent is `general`. */
export function canonicalAgentType(requested: string | undefined): SubAgentType {
  const name = (requested ?? '').trim().toLowerCase();
  if ((TASK_AGENT_TYPES as readonly string[]).includes(name)) return name as SubAgentType;
  return LEGACY_AGENT_TYPES[name] ?? 'general';
}

/*
  The tool's description is a decision aid and a brief template, not a
  catalogue.

  It used to list sixteen agent types with a paragraph of dispatch modes —
  ~1.3K tokens on every request, most of it the role-based build team
  (frontend, backend, qa, architect…) that this codebase's own research names
  as the anti-pattern (see tools/investigate.ts). The enum kept offering them,
  and a parent picked `backend` — a TypeScript-server persona — for plain JS
  libraries. The enum now offers only TASK_AGENT_TYPES; an old name from a
  stored session or a habit is mapped by `canonicalAgentType`, so nothing that
  names one breaks.

  The brief is structured because the failure of delegation is not the model
  doing the work badly, it is the model doing different work: a child that was
  never told the scope edits outside it, one never told what "done" means
  stops at "it compiles". Goal, scope, constraints and acceptance criteria are
  separate fields so each one is visibly present or visibly missing, and the
  criteria are required where the child can change files (`briefProblem`).
*/
export const taskToolDefinition = {
  name: 'Task',
  description: [
    'Delegate one self-contained task to a sub-agent. It starts with none of this conversation; several Task calls in one response run in parallel.',
    'Worth it for wide work (many files you would read once), independent pieces, or a clean context. Do it yourself when it is a few files, the steps depend on each other, or briefing would take longer than doing.',
    'Brief it like a capable colleague new to the repo: prompt = the goal and the context you already hold (paths, findings, decisions, the why); files = scope; constraints = what not to change, patterns to follow; acceptance_criteria = checkable conditions for done (required when it can change files), covering the change\'s security and edge cases — never declare one out of scope unless the user did.',
    'It reports STATUS, changes, evidence per criterion and open risks. That report is a claim: files it changes count against this turn\'s checks, so RunChecks (and VerifyApp for pages) still decide when the work is done.',
    'Who runs it: subagent_type — general (default: implements in any language/stack, all tools), explore (fast read-only search), plan (read-only design), review (code review), verification (tries to break the work), security-audit (read-only); agent_name — a registered agent; agent_spec — inline instructions, tools ("all", "readonly" or names) and model.',
  ].join('\n'),
  inputSchema: {
    type: 'object',
    properties: {
      description: {
        type: 'string',
        description: 'Short label shown while it runs.',
      },
      prompt: {
        type: 'string',
        description: 'The goal and the context it needs: what to achieve and why, what you already know (paths, findings, decisions, commands).',
      },
      acceptance_criteria: {
        type: 'array',
        items: { type: 'string' },
        description: 'Checkable conditions that decide it is done, e.g. "npm test passes", "GET /items?page=2 returns 20 rows". Required when it can change files.',
      },
      files: {
        type: 'array',
        items: { type: 'string' },
        description: 'Files or directories in scope.',
      },
      constraints: {
        type: 'array',
        items: { type: 'string' },
        description: 'What not to change; patterns, libraries or conventions to follow.',
      },
      model: {
        type: 'string',
        description: 'Model for this sub-agent; defaults to yours. A cheaper one suits mechanical work.',
      },
      subagent_type: {
        type: 'string',
        enum: [...TASK_AGENT_TYPES],
      },
      agent_name: {
        type: 'string',
        description: 'A registered agent (AgentList).',
      },
      agent_spec: {
        type: 'object',
        description: 'An inline agent. Overrides subagent_type and agent_name.',
        properties: {
          instructions: { type: 'string' },
          tools: {
            oneOf: [
              { type: 'string', enum: ['all', 'readonly'] },
              { type: 'array', items: { type: 'string' } },
            ],
          },
          model: { type: 'string' },
          role: { type: 'string', description: 'Display label.' },
        },
      },
      timeout: {
        type: 'number',
        description: 'Idle seconds before it is stopped (default 60; 300-600 for long implementation). Also raises the 15-minute ceiling.',
      },
      isolation: {
        type: 'string',
        enum: ['worktree'],
        description: 'Run in a temporary git worktree; a branch with its changes is kept.',
      },
      detach: {
        type: 'boolean',
        description: 'Default false: the result comes back from the call. True returns an id at once so you can watch, guide or stop it with Supervise — only when you will supervise, and you MUST wait for it (Supervise "wait") before treating the work as done.',
      },
    },
    required: ['description', 'prompt'],
  },
};

/** The structured parts of a brief, as the model passes them. */
export interface TaskBrief {
  prompt: string;
  acceptance_criteria?: unknown;
  files?: unknown;
  constraints?: unknown;
}

/** Tools that can change the working tree. Bash counts: it can write anywhere. */
const WRITING_TOOLS = new Set(['Write', 'Edit', 'NotebookEdit', 'Bash', 'Terminal', 'MultiEdit']);

/** Agent types whose tool set cannot change files (Bash there is for running scanners and tests). */
const READ_ONLY_TYPES = new Set<SubAgentType>(['explore', 'plan', 'verification', 'security-audit', 'devsecops', 'review']);

/** Whether a resolved sub-agent can change files. */
export function canWrite(tools: string[] | 'all' | 'readonly' | undefined, agentType: SubAgentType): boolean {
  if (tools === 'readonly') return false;
  if (Array.isArray(tools)) return tools.some(t => WRITING_TOOLS.has(t));
  if (tools === 'all') return true;
  return !READ_ONLY_TYPES.has(agentType);
}

function list(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(v => String(v).trim()).filter(Boolean);
  if (typeof value === 'string' && value.trim()) return [value.trim()];
  return [];
}

/**
 * Why a brief cannot be sent as written, or undefined when it can.
 *
 * Refused before anything is spawned, so the cost of a missing criterion is
 * one short tool result rather than a sub-agent run that stops wherever it
 * decides "done" is. Only the model-facing Task call is held to this; the
 * engine's own callers (Investigate, the studio pipeline) compose their briefs
 * themselves.
 */
export function briefProblem(brief: TaskBrief, writable: boolean): string | undefined {
  if (!brief.prompt?.trim()) return 'Task refused: prompt is empty. Give the goal and the context the sub-agent needs.';
  if (writable && list(brief.acceptance_criteria).length === 0) {
    return 'Task refused: this sub-agent can change files, so it needs acceptance_criteria — checkable conditions '
      + 'that decide it is done (e.g. "npm test passes", "the /items route returns 400 for page=0"). '
      + 'Add them and call Task again; for read-only work use subagent_type explore, plan or review.';
  }
  return undefined;
}

/**
 * The brief the sub-agent actually reads: the goal, then each structured part
 * under a plain label, then the report it owes.
 *
 * The report shape is the token saving. A child's final message is the only
 * thing that comes back, and an unstructured one was often the whole story of
 * the run — every file it read, every command it tried. Asking for status,
 * changes, evidence and open items, briefly, gives the parent what it acts on
 * and leaves the rest in the child's own log.
 */
export function composeBrief(
  brief: TaskBrief,
  writable: boolean,
  /** False when the agent's own role prompt already states the report shape. */
  withReport = true,
): string {
  const parts = [brief.prompt.trim()];
  const files = list(brief.files);
  const constraints = list(brief.constraints);
  const criteria = list(brief.acceptance_criteria);
  if (files.length) parts.push(`Scope (stay within these unless a criterion needs more, and say so):\n${files.map(f => `- ${f}`).join('\n')}`);
  if (constraints.length) parts.push(`Constraints:\n${constraints.map(c => `- ${c}`).join('\n')}`);
  if (criteria.length) parts.push(`Done when — check each one yourself and cite the evidence:\n${criteria.map(c => `- ${c}`).join('\n')}`);
  if (withReport) {
    parts.push(writable
      ? REPORT_CONTRACT
      : 'Your final message is all the caller sees. Findings first, each with its file:line or source as evidence; '
        + 'then what you did not check. Under ~250 words unless the task asks for more. Do not narrate your search.');
  }
  return parts.join('\n\n');
}

export interface RunTaskOpts {
  /** GitHub token — optional now, kept for backward compat */
  token?: string;
  model: string;                         // parent model (fallback)
  autoApprove: boolean;
  verbose: boolean;
  depth: number;
  /** Sub-agent timeout in ms (default: 120_000 = 2 min) */
  subagentTimeout?: number;
  settings?: AicoSettings;
  /**
   * Capability context to compose the child from.
   *
   * Without it, a restricted tool set is escapable by delegation in exactly the
   * way plan mode was: compose a narrow context, spawn a sub-agent, and the
   * child resolves the full built-in set instead.
   */
  context?: import('../registry/index.js').Context;
  /**
   * Session token tracker, shared with the child.
   *
   * Cost and token safety limits are evaluated against this tracker. A child
   * with its own tracker spends invisibly, so `maxCostPerSession` could be
   * exceeded arbitrarily by delegating the expensive work.
   */
  tokenTracker?: import('../agent.js').TokenTracker;
  /**
   * Propagate plan mode into the sub-agent.
   *
   * Without this, plan mode is escapable in one tool call: the parent is
   * restricted to read-only tools, but `Task` is offered regardless, and a
   * sub-agent that did not inherit the restriction gets Write, Edit and
   * unrestricted Bash. `/plan` promises "no edits, writes, or commits" — a
   * promise the whole tree has to keep, not just its root.
   */
  planMode?: boolean;
  /** On-demand tool groups the parent has loaded, so the child starts with them. */
  toolGroups?: readonly string[];
  /**
   * What the delegating run may use. The child's own tools (a type's set, a
   * named agent's list, an inline spec's — `'all'` included) are intersected
   * with it, so delegating can never widen what the parent could do. Without
   * it, a read-only reviewer's `tools: 'all'` child got Write. Engine callers
   * that compose their own runs (the studio pipeline) leave it unset.
   */
  toolScope?: import('../agents/effective.js').ToolScope;
  onSubagentStart?: (rec: SubAgentRecord) => void;
  onSubagentStop?: (rec: SubAgentRecord) => void;
  /**
   * External abort signal (e.g. from the studio pipeline). When aborted, the
   * sub-agent's internal AbortController is also aborted so the in-flight
   * runAgent call and its provider stream tear down promptly.
   */
  abortSignal?: AbortSignal;
}

export async function runTask(
  args: {
    description: string;
    prompt: string;
    /** Structured brief parts — see {@link composeBrief}. Used when `contract` is set. */
    acceptance_criteria?: unknown;
    files?: unknown;
    constraints?: unknown;
    /**
     * Hold this call to the delegation contract: refuse a write-capable brief
     * with no acceptance criteria, and compose the brief with the report shape.
     * Set by the model-facing Task handler only.
     */
    contract?: boolean;
    model?: string;
    subagent_type?: SubAgentType;
    agent_name?: string;
    agent_spec?: { instructions?: string; tools?: string[] | 'all' | 'readonly'; model?: string; role?: string };
    timeout?: number;
    isolation?: 'worktree';
    /**
     * Return as soon as it starts, rather than when it finishes.
     *
     * Opt-in, and off by default, because a blocking `Task` is what every
     * existing caller and every agent prompt already expects: the result comes
     * back from the call. Detaching is for the case those cannot express —
     * supervising a child while it works, which is impossible while suspended
     * inside the call that spawned it.
     */
    detach?: boolean;
  },
  opts: RunTaskOpts,
): Promise<string> {
  if (opts.depth >= 4) {
    return `[error] Sub-agent depth limit reached — max nesting is 4 levels.`;
  }
  // The second line behind the tool not being offered at all (agent.ts).
  if (opts.toolScope && !opts.toolScope.delegate) {
    return '[error] This agent may not delegate (canDelegate is off for it or for an agent above it). Do the work yourself.';
  }

  const agentId = crypto.randomUUID().slice(0, 8);
  const agentType: SubAgentType = canonicalAgentType(args.subagent_type);

  // ── Resolve agent spec (dynamic dispatch) ──────────────────────────
  // Three modes in priority order:
  //   1. agent_spec (inline custom) — highest priority
  //   2. agent_name (registered spec lookup)
  //   3. subagent_type (predefined) — fallback
  // The resolved spec controls: system prompt, tool whitelist, model.
  let resolvedInstructions: string | undefined;
  let resolvedTools: string[] | 'all' | 'readonly' | undefined;
  let resolvedModel: string | undefined;
  /** A named agent's `canDelegate`, which the child's run enforces. */
  let resolvedCanDelegate: boolean | undefined;
  /** A named agent's bounds (deny list, ceiling, budget, write paths …), enforced by the child's run. */
  let resolvedBounds: import('../agents/types.js').AgentBounds | undefined;

  if (args.agent_spec) {
    resolvedInstructions = args.agent_spec.instructions;
    resolvedTools = args.agent_spec.tools;
    resolvedModel = args.agent_spec.model;
  } else if (args.agent_name) {
    // Shared with the sticky per-session path, so an agent behaves the same
    // whether the orchestrator delegates to it or a person talks to it.
    try {
      const { resolveAgent } = await import('../agents/resolve.js');
      // The delegating run's directory, so a project's own agents resolve.
      const resolved = await resolveAgent(args.agent_name, currentCwd());
      if (!resolved) {
        return `[error] Agent "${args.agent_name}" not found. Use AgentList to see available agents.`;
      }
      resolvedInstructions = resolved.instructions;
      resolvedTools = resolved.tools;
      resolvedModel = resolved.model;
      resolvedCanDelegate = resolved.bounds.delegate !== 'none';
      resolvedBounds = resolved.bounds;
    } catch {
      return `[error] Failed to load agent "${args.agent_name}".`;
    }
  }

  // ── Model resolution ──────────────────────────────────────────────
  //
  // Priority: explicit args.model > agent_spec.model > settings.agentModels
  // for this role > parent opts.model.
  //
  // The settings layer sits below anything explicit and above the parent's
  // model, which is the useful place for it: a caller that named a model meant
  // it, and everything else used to silently inherit whatever the session was
  // set to. A fleet of explorers running greps was billed at the rate chosen
  // for the session's hardest reasoning.
  const IMPLEMENTATION_AGENTS = new Set(['frontend', 'backend', 'qa', 'healer']);
  // The name as requested first, so a model configured for a retired role
  // name still applies to calls that use it.
  const roleModel = (args.subagent_type ? opts.settings?.agentModels?.[args.subagent_type] : undefined)
    ?? opts.settings?.agentModels?.[agentType]
    ?? opts.settings?.agentModels?.default;
  const requestedModel = resolvedModel ?? args.model ?? roleModel ?? opts.model;
  const agentModel = (
    IMPLEMENTATION_AGENTS.has(agentType) && requestedModel.includes('haiku')
  ) ? opts.model : requestedModel;
  const colorIdx = _registry.size % AGENT_COLORS.length;
  const color = AGENT_COLORS[colorIdx];

  // ── The delegation contract ───────────────────────────────────────
  // Checked after resolution because only then is it known whether this child
  // can change files — an agent_name's tools come from its spec.
  let brief = args.prompt;
  if (args.contract) {
    const writable = canWrite(resolvedTools, agentType);
    const problem = briefProblem(args, writable);
    if (problem) return problem;
    const roleStatesReport = !resolvedInstructions
      && (AGENT_TYPE_PROMPTS[agentType] ?? '').includes(REPORT_CONTRACT);
    brief = composeBrief(args, writable, !(writable && roleStatesReport));
  }

  // ── Prompt resolution ─────────────────────────────────────────────
  // Priority: agent_spec.instructions > agent_name spec prompt > type prompt
  let fullPrompt: string;
  if (resolvedInstructions) {
    fullPrompt = `${resolvedInstructions}\n\n---\n\n${brief}`;
  } else {
    const typePrompt = AGENT_TYPE_PROMPTS[agentType];
    fullPrompt = typePrompt ? `${typePrompt}\n\n---\n\n${brief}` : brief;
  }

  const now = Date.now();
  // Read from the ambient run context rather than passed down through options:
  // the Task tool executes inside its caller's context, so this is the session
  // the spawn belongs to without every call site having to remember to say so.
  const owner = owningSession(currentRunContext()?.sessionId);
  const record: SubAgentRecord = {
    agentId,
    ...(owner ? { sessionId: owner } : {}),
    description: args.description,
    model: agentModel,
    status: 'running',
    statusMessage: 'Starting…',
    startedAt: now,
    depth: opts.depth + 1,
    agentType,
    lastActivityAt: now,
    toolCallCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: 0,
  };

  _register(record);
  if (opts.settings) {
    await runHooks('SubagentStart', {
      event: 'SubagentStart',
      agentId,
      agentType,
      agentDescription: args.description,
    }, opts.settings);
  }
  opts.onSubagentStart?.(record);

  /*
    The parent's directory, not the process's.

    `runAgent` was called without a cwd, so `runInContext` fell back to
    `process.cwd()` — which on a server driving several workspaces is wherever
    it happened to be launched, not the project the delegation belongs to. A
    sub-agent asked to read a file was reading the wrong repository's copy of
    it. This is also where the child's log is filed, so it has to be right
    before that starts.
  */
  const parentCwd = currentCwd();

  /*
    A session of the child's own, and an inbox on top of it.

    The inbox is what makes a correction possible at all: it delivers at the
    child's next step boundary, so an instruction lands without discarding the
    tool results it has already gathered. Cancelling and re-briefing throws all
    of that away.

    The log is a side effect worth having on its own. A delegated agent used to
    be a black box that returned a paragraph; now what it actually did is on
    disk beside the conversation that asked for it. Nothing is written unless
    the child records something — see `persistSession`.

    Failing to open one is not fatal. The child runs without steering rather
    than not running.
  */
  let sub: Awaited<ReturnType<typeof openSession>> | undefined;
  let inbox: Inbox | undefined;
  try {
    sub = await openSession(`sub-${agentId}`, parentCwd);
    inbox = new Inbox(sub.session);
    _inboxes.set(agentId, inbox);
  } catch {
    // No transcript and no steering for this one; the work still happens.
  }

  // Optional worktree isolation
  let worktreeRecord: import('../worktree/index.js').WorktreeRecord | undefined;
  if (args.isolation === 'worktree') {
    try {
      const { worktreeManager } = await import('../worktree/index.js');
      worktreeRecord = await worktreeManager.createWorktree(agentId, parentCwd);
    } catch (err) {
      // Worktree creation failed — continue without isolation, emit warning
      _update(agentId, { statusMessage: `Worktree failed, running in-place: ${err instanceof Error ? err.message : String(err)}` });
    }
  }

  /*
    The whole run, as one promise.

    Named so it can either be awaited — the default, and what every existing
    caller still gets — or left in flight while the parent carries on. The
    detached form is the only way an orchestrator can supervise: `Task` blocks
    its own step, so a parent waiting on a child is suspended and cannot look at
    it.
  */
  const settle = async (): Promise<string> => {
  try {
    // Dynamic import avoids circular dependency
    const { runAgent } = await import('../agent.js');

    _update(agentId, { statusMessage: 'Working…' });

    // ── Heartbeat-based timeout ──────────────────────────────────────
    // Instead of a fixed wall-clock timeout, we track the last tool activity.
    // The agent is considered "alive" as long as it's making tool calls.
    // It only times out after IDLE_TIMEOUT_MS of no activity.
    const STUDIO_AGENT_TYPES = new Set(['frontend', 'backend', 'qa', 'architect', 'tech-writer', 'product-owner', 'healer']);
    const isStudioAgent = STUDIO_AGENT_TYPES.has(agentType);

    // Idle timeout: how long with NO tool activity before we kill the agent
    const idleTimeoutMs = (args.timeout ? args.timeout * 1000 : undefined)
      ?? opts.subagentTimeout
      ?? (isStudioAgent ? 120_000 : 60_000);  // 2 min idle for studio, 1 min for others

    // Absolute max: safety net to prevent truly infinite runs. The idle timeout
    // above is what catches a stuck agent; this only bounds one that keeps
    // working. It was five minutes for every non-studio role, which killed
    // healthy research and review agents mid-stride — a sub-agent making steady
    // tool calls is the thing that should be allowed to finish. An explicit
    // timeout from the caller raises it, since asking for a long idle window
    // on a job the ceiling then cuts short is a contradiction.
    const absoluteMaxMs = Math.max(
      isStudioAgent ? 1_800_000 : 900_000,  // 30 min studio, 15 min others
      args.timeout ? args.timeout * 1000 * 3 : 0,
    );

    let lastActivity = Date.now();
    let toolCallCount = 0;
    const abortController = new AbortController();
    // Registered so a supervisor — the reader watching the panel, or the
    // orchestrator between delegations — can stop this one child without
    // taking its siblings down with it.
    _stops.set(agentId, { abort: () => abortController.abort() });
    // Forward an external abort (e.g. studio pipeline cancellation) into the
    // sub-agent's internal controller so the runAgent call tears down promptly.
    let detachParentAbort: (() => void) | undefined;
    if (opts.abortSignal) {
      if (opts.abortSignal.aborted) abortController.abort();
      else {
        // Detached when the sub-agent settles: this listener lives on the
        // PARENT's signal, which outlives the child, so one is left behind
        // per Task call otherwise.
        const parentSignal = opts.abortSignal;
        const onParentAbort = (): void => abortController.abort();
        parentSignal.addEventListener('abort', onParentAbort, { once: true });
        detachParentAbort = () => parentSignal.removeEventListener('abort', onParentAbort);
      }
    }

    const agentPromise = runAgent({
      task: withProjectProfile(fullPrompt),
      token: opts.token ?? '',
      model: agentModel,
      autoApprove: opts.autoApprove,
      verbose: opts.verbose,
      showPlan: false,
      conversationHistory: [],
      sessionId: `sub-${agentId}`,
      cwd: parentCwd,
      ...(sub ? { session: sub.session } : {}),
      ...(inbox ? { inbox } : {}),
      silent: true,
      depth: opts.depth + 1,
      agentType,
      // ── Inherited constraints ────────────────────────────────────────
      // Everything below is a promise the parent made that the child has to
      // keep too. Omitting any of them makes the corresponding restriction
      // escapable in exactly one tool call.
      //
      //   settings     PreToolUse/PostToolUse hooks (a hook that blocks a tool
      //                in the parent must block it in the child), safetyLimits,
      //                bashTimeout, agentTimeout, maxIterations,
      //                maxParallelToolCalls, and provider configuration such as
      //                reasoningEffort and custom base URLs.
      //   context      the composed tool set and policy pipeline.
      //   tokenTracker so delegated spend counts toward the session cost cap.
      //   planMode     a read-only parent must not delegate writes.
      ...(opts.settings ? { settings: opts.settings } : {}),
      ...(opts.context ? { context: opts.context } : {}),
      // Its own tracker, forwarding to the parent's. Session accounting is
      // unchanged; what this adds is the ability to tell one agent's spend
      // from its siblings', which is what `maxCostPerSubagent` measures.
      ...(opts.tokenTracker ? { tokenTracker: createChildTracker(opts.tokenTracker) } : {}),
      ...(opts.planMode ? { planMode: true } : {}),
      ...(opts.toolGroups?.length ? { toolGroups: opts.toolGroups } : {}),
      // Pass the resolved spec tools so runAgent uses the custom whitelist
      // instead of the hardcoded SUBAGENT_TOOL_SETS for this agent type.
      ...(resolvedTools ? { agentSpecTools: resolvedTools } : {}),
      //   toolScope    the parent's effective set — the child's own list is
      //                intersected with it, so `tools: 'all'` means the parent's.
      //   canDelegate  a named agent that may not delegate does not, in code.
      ...(opts.toolScope ? { toolScope: opts.toolScope } : {}),
      ...(resolvedCanDelegate === false ? { canDelegate: false } : {}),
      ...(resolvedBounds ? { agentBounds: resolvedBounds } : {}),
      abortSignal: abortController.signal,
      // Sub-agent status updates feed back into registry — AND reset heartbeat
      onToolCall: (name: string) => {
        const current = _registry.get(agentId);
        if (current && isTerminal(current.status)) return;
        lastActivity = Date.now();
        toolCallCount++;
        _update(agentId, {
          statusMessage: name + '…',
          lastActivityAt: lastActivity,
          toolCallCount,
          currentTool: name,
        });
      },
      onToolDone: () => {
        const current = _registry.get(agentId);
        if (current && isTerminal(current.status)) return;
        lastActivity = Date.now();
        _update(agentId, {
          statusMessage: 'Working…',
          lastActivityAt: lastActivity,
          currentTool: undefined,
        });
      },
      onChunk: () => {
        const current = _registry.get(agentId);
        if (current && isTerminal(current.status)) return;
        lastActivity = Date.now();
        _update(agentId, { lastActivityAt: lastActivity });
      },
      onTokens: (input, output, cached) => {
        const current = _registry.get(agentId);
        if (!current || isTerminal(current.status)) return;
        _update(agentId, {
          inputTokens: current.inputTokens + input,
          outputTokens: current.outputTokens + output,
          cachedTokens: current.cachedTokens + cached,
        });
      },
    });

    // Heartbeat checker: polls every 10s and kills if idle too long
    const heartbeatPromise = new Promise<never>((_, reject) => {
      const checkInterval = setInterval(() => {
        const idleMs = Date.now() - lastActivity;
        const totalMs = Date.now() - record.startedAt;

        if (idleMs > idleTimeoutMs) {
          abortController.abort();
          clearInterval(checkInterval);
          reject(new Error(
            `Sub-agent "${args.description}" idle for ${Math.round(idleMs / 1000)}s (no tool activity). ` +
            `Total runtime: ${Math.round(totalMs / 1000)}s, ${toolCallCount} tool calls made.`
          ));
        } else if (totalMs > absoluteMaxMs) {
          abortController.abort();
          clearInterval(checkInterval);
          reject(new Error(
            `Sub-agent "${args.description}" hit absolute time limit (${Math.round(absoluteMaxMs / 60_000)} min). ` +
            `${toolCallCount} tool calls made. Last activity ${Math.round(idleMs / 1000)}s ago.`
          ));
        }
      }, 10_000);

      // Clean up interval if agent finishes normally
      agentPromise.then(() => clearInterval(checkInterval), () => clearInterval(checkInterval));
    });

    agentPromise.then(() => detachParentAbort?.(), () => detachParentAbort?.());
    let result = await Promise.race([agentPromise, heartbeatPromise]);

    _stops.delete(agentId);
    _update(agentId, { status: 'completed', statusMessage: 'Done', completedAt: Date.now(), result });
    if (opts.settings) {
      await runHooks('SubagentStop', {
        event: 'SubagentStop',
        agentId,
        agentType,
        agentDescription: args.description,
      }, opts.settings);
    }
    opts.onSubagentStop?.({ ..._registry.get(agentId)! });

    // Cleanup worktree if one was created
    if (worktreeRecord) {
      const { worktreeManager } = await import('../worktree/index.js');
      const cleanup = await worktreeManager.cleanupWorktree(worktreeRecord.worktreeId, {
        cwd: process.cwd(),
        keepBranch: true,  // preserve changes for review
      });
      if (cleanup.cleaned && cleanup.branch) {
        result += `\n\n[Worktree changes saved to branch: ${cleanup.branch}]`;
      }
    }

    // Auto-clear completed agents after 10s so panel stays clean
    setTimeout(() => {
      _update(agentId, { status: 'completed' });  // keep, just don't re-add
      const rec = _registry.get(agentId);
      if (rec?.status === 'completed') _registry.delete(agentId);
      _emit();
    }, 10_000);

    // Verification nudge: for implementation/coding agents, if the result reads
    // like a completion summary but shows no verification evidence (no mention of
    // tsc/build/test passing), append a reminder so the orchestrator is prompted
    // to verify the sub-agent's output before accepting it as done.
    result = appendVerificationNudge(result, agentType);

    return result;

  } catch (err) {
    _stops.delete(agentId);
    /*
      A sub-agent that was stopped on purpose is not a sub-agent that broke.

      The abort surfaces here as an ordinary error reading "aborted", and
      reporting that as a failure tells the parent the wrong thing entirely:
      a crash invites a retry, a termination invites a re-plan. So a recorded
      stop reason wins over the error text, and the status says `cancelled`.
    */
    const stopReason = _stopReasons.get(agentId);
    _stopReasons.delete(agentId);
    const errMsg = stopReason
      ? `stopped by the supervisor: ${stopReason}`
      : err instanceof Error ? err.message : String(err);
    if (stopReason) {
      _update(agentId, {
        status: 'cancelled', statusMessage: 'Stopped',
        completedAt: Date.now(), error: errMsg,
      });
      // Cleared on the same schedule as a failure — a reader who just stopped
      // something wants to see that it stopped.
      setTimeout(() => {
        const rec = _registry.get(agentId);
        if (rec?.status === 'cancelled') _registry.delete(agentId);
        _emit();
      }, 30_000);
      if (worktreeRecord) {
        const { worktreeManager } = await import('../worktree/index.js');
        await worktreeManager.cleanupWorktree(worktreeRecord.worktreeId, { cwd: process.cwd() })
          .catch(() => {});
      }
      // From the record, not the loop variable: the counter is scoped to the
      // try block and this is the catch.
      const calls = _registry.get(agentId)?.toolCallCount ?? 0;
      return `[Sub-agent "${args.description}" was stopped: ${stopReason}. `
        + `It made ${calls} tool call(s) before stopping — anything it had already `
        + `written is still on disk. Decide what to do next rather than re-running it unchanged.]`;
    }
    _update(agentId, { status: 'failed', statusMessage: 'Failed', completedAt: Date.now(), error: errMsg });
    if (opts.settings) {
      await runHooks('SubagentStop', {
        event: 'SubagentStop',
        agentId,
        agentType,
        agentDescription: args.description,
      }, opts.settings);
    }
    opts.onSubagentStop?.({ ..._registry.get(agentId)! });
    // Auto-clear failed agents after 30s (longer than success 10s so user can read the error)
    setTimeout(() => {
      const rec = _registry.get(agentId);
      if (rec?.status === 'failed') _registry.delete(agentId);
      _emit();
    }, 30_000);
    // Cleanup worktree on failure too
    if (worktreeRecord) {
      const { worktreeManager } = await import('../worktree/index.js');
      await worktreeManager.cleanupWorktree(worktreeRecord.worktreeId, { cwd: process.cwd() }).catch(() => {});
    }
    return `[Sub-agent "${args.description}" failed: ${errMsg}]`;
  } finally {
    /*
      The child's file changes are the parent's changes.

      Every gate is per run, and a sub-agent is a run of its own whose gates
      are off — so a parent that delegated an implementation used to finish
      with its checks gate silent: it had touched nothing itself. "Delegation
      does not transfer responsibility" was a sentence in the prompt and
      nothing in the loop. Now what the child wrote is noted in this (the
      parent's) run, together with any check the child actually ran: a real
      RunChecks result is evidence whoever ran it, and a stale one is caught
      by the same mtime rule as the parent's own. Success, failure or stop
      alike — a child cut short can still have written half a change.
    */
    const work = workOf(`sub-${agentId}`);
    if (work) {
      absorbWork(work);
      for (const file of work.written) noteFileWritten(file);
    }
    // Whatever happened, this child can no longer be steered, and its log is
    // flushed. Leaving the inbox behind would let a later `guide` queue an
    // instruction for an agent that will never read it and report success.
    _inboxes.delete(agentId);
    await sub?.close().catch(() => undefined);
  }
  };

  if (!args.detach) return settle();

  /*
    Detached: started, not awaited.

    The result is kept so `Supervise wait` can come back for it — the work
    is already in flight and there would otherwise be nothing to await. The
    `catch` is attached immediately and separately: an unhandled rejection here
    would take the process down, and the rejection is genuinely handled, by
    whoever calls `wait`.
  */
  const running = settle();
  _detached.set(agentId, running);
  running.catch(() => undefined);
  /*
    Kept well past the finish, then dropped.

    The registry clears a completed agent after ten seconds so the panel stays
    tidy, which would otherwise make a late `wait` report "nothing to wait for"
    about work that succeeded. Ten minutes is long enough for any parent that
    means to collect a result, and short enough that a server left running for
    days does not accumulate every delegation it ever made.
  */
  void running.finally(() => {
    const forget = setTimeout(() => _detached.delete(agentId), 600_000);
    forget.unref?.();
  });
  return `[Spawned "${args.description}" as sub-agent ${agentId}, running in the background. `
    + 'It is NOT finished and has produced nothing yet. Use Supervise to watch it '
    + `("list"), correct it without restarting it ("guide"), stop it ("stop"), or collect `
    + `its result ("wait"). Do not report this task as done until you have waited for it.]`;
}

// ── Verification nudge ──────────────────────────────────────────────────────

const CODE_AGENT_TYPES = new Set(['backend', 'frontend', 'qa', 'general']);
const VERIFICATION_SIGNALS = /\b(tsc|typescript|npm test|npm run build|pytest|go test|build passed|tests? pass|lint|typecheck|0 errors|compiled|verified|STATUS:\s*COMPLETE)\b/i;

/**
 * For implementation/coding agents, if the result looks like a completion
 * summary but contains no verification evidence (no STATUS suffix or tsc/build/
 * test mention), append a one-line reminder so the parent orchestrator is nudged
 * to verify the sub-agent's output before accepting it as done.
 *
 * Recognizes the structured report contract: `STATUS: COMPLETE | typecheck: pass
 * | tests: N/N | risks: ...`. If that line is present and shows COMPLETE with
 * passing checks, no nudge is added. If it shows PARTIAL/FAIL, a stronger nudge
 * is added. No-op for non-code agents.
 */
function appendVerificationNudge(result: string, agentType: string): string {
  if (!CODE_AGENT_TYPES.has(agentType)) return result;

  // Check for the structured STATUS contract first (the new report format).
  const statusMatch = result.match(/STATUS:\s*(COMPLETE|PARTIAL|FAIL)/i);
  if (statusMatch) {
    const status = statusMatch[1].toUpperCase();
    if (status === 'COMPLETE') return result; // agent reported verified completion
    return `${result}\n\n⚠ Verification incomplete: the sub-agent reported STATUS: ${status}. Review its output for remaining work or failures before accepting.`;
  }

  // Fall back to keyword detection for agents that cite verification informally.
  if (VERIFICATION_SIGNALS.test(result)) return result;
  return `${result}\n\n(Verification reminder: this implementation agent did not report typecheck/build/test results. Verify it compiles and passes tests before accepting this work; if not, re-task with the specific failures.)`;
}

