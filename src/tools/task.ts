import { costFor, createChildTracker } from '../tokens.js';
import crypto from 'crypto';
import type { SubAgentType } from './index.js';
import { runHooks } from '../hooks.js';
import type { AicoSettings } from '../settings.js';
import { AGENT_PROMPTS, REPORT_CONTRACT } from '../agents/prompts-registry.js';
import { workOf, absorbWork } from '../checks.js';
import { noteFileWritten } from '../verification.js';
import { loadProfile, renderProfile } from '../project/profile.js';
import { projectRoot } from '../run-context.js';
import { recordRoleSpend, resolveRole, roleForAgentType } from '../models/roles.js';

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
import { humaniseStep } from '../../shared/tasks.js';
import fs from 'fs';
import path from 'path';
import { owningSession, recordOwner } from '../agents/ownership.js';
import { boundReport, reportBack, wakeOnResult } from '../agents/report-back.js';
import { acquireSlot, maxConcurrentFrom, releaseSlot, resumeSlot, suspendSlot } from '../agents/limiter.js';
import { deserializeScope, intersectScopes, serializeScope } from '../agents/scope-json.js';
import { OPEN_SCOPE, type ToolScope } from '../agents/effective.js';
import { ledger } from '../work/ledger.js';
import type { AgentResumeSpec } from '../work/types.js';
import type { WorktreeRecord } from '../worktree/index.js';

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
  /**
   * The sub-agent that spawned this one, when it was not a chat.
   *
   * `sessionId` climbs to the conversation on purpose, which flattens the
   * delegation tree: the Tasks panel could not show that an implementer's
   * reviewer was the implementer's, not the chat's. Read from the ambient
   * run context at spawn (`sub-<agentId>`), so no caller has to pass it.
   */
  parentAgentId?: string;
  /** The registered agent this runs as (`agent_name`), when one was named. */
  agentName?: string;
  /** The last tool call in words ("Editing src/app.ts"), for the Tasks panel. */
  lastStep?: string;
  /** The start of the brief it was given, so a reader can tell siblings apart. */
  brief?: string;
  /** Spawned without waiting (`detach`, `BackgroundTask`): its report is delivered back (ADR 0021). */
  detached?: boolean;
  /** Waiting for a free slot under `agents.maxConcurrent`; mirrored as `queued` in the ledger. */
  queued?: boolean;
  /** How many times it has been continued with `Task {resume}`. */
  resumed?: number;
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
 * `sub-<agentId>` → the conversation that owns it. The map moved to
 * `agents/ownership` so the shell tool can resolve an owner without importing
 * this module (a cycle); re-exported here for every existing caller.
 */
export { owningSession };

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

/**
 * What each agent ran as, so it can be continued (`Task {resume}`) and, after a
 * restart, resumed from its ledger row (ADR 0021). Bounded; the ledger keeps
 * the durable copy.
 */
const _specs = new Map<string, AgentResumeSpec>();

/** Agents a `Supervise wait` is blocking on right now: their report comes back from the wait, not twice. */
const _awaited = new Map<string, number>();
/** Agents whose outcome a wait already handed over, so delivery skips them. */
const _consumedByWait = new Set<string>();
/** Agents whose report was delivered into the conversation, so a later wait does not repeat it whole. */
const _delivered = new Set<string>();

/** The id a caller gave, without the ledger's `agent:` or the log's `sub-` prefix. */
export function normalizeAgentId(id: string): string {
  return id.trim().replace(/^agent:/, '').replace(/^sub-/, '');
}

/** What an agent ran as, from this process or (after a restart) from its ledger row. */
export function agentResumeSpec(agentId: string): AgentResumeSpec | undefined {
  const id = normalizeAgentId(agentId);
  return _specs.get(id) ?? ledger.get(`agent:${id}`)?.resume;
}

/** `Supervise wait` is about to block on these agents. */
export function awaitAgents(agentIds: readonly string[]): void {
  for (const raw of agentIds) {
    const id = normalizeAgentId(raw);
    _awaited.set(id, (_awaited.get(id) ?? 0) + 1);
  }
}

/** The wait is over; `consumed` when it handed the outcomes over itself. */
export function releaseAwaited(agentIds: readonly string[], consumed: boolean): void {
  for (const raw of agentIds) {
    const id = normalizeAgentId(raw);
    if (consumed) _consumedByWait.add(id);
    const n = (_awaited.get(id) ?? 1) - 1;
    if (n > 0) _awaited.set(id, n); else _awaited.delete(id);
  }
}

/** Whether an agent's report was already delivered into its conversation. */
export function reportDelivered(agentId: string): boolean {
  return _delivered.has(normalizeAgentId(agentId));
}

/**
 * Stop every agent a conversation still has running — detached ones from
 * earlier turns included. The composer's Stop means "stop what this chat is
 * doing", and a background agent spawned two turns ago is part of that; before
 * this, only the current turn's children were reached (through its signal).
 */
export function stopSessionAgents(sessionId: string, reason: string): string[] {
  const stopped: string[] = [];
  for (const rec of _registry.values()) {
    if (rec.sessionId !== sessionId || isTerminal(rec.status)) continue;
    if (requestAgentStop(rec.agentId, reason)) stopped.push(rec.agentId);
  }
  return stopped;
}

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
  recordOwner(subSessionId, owner);
}

function _register(record: SubAgentRecord) {
  _registry.set(record.agentId, record);
  if (record.sessionId) recordOwner(`sub-${record.agentId}`, record.sessionId);
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
    'Follow-up to an earlier sub-agent: resume = its id, prompt = the follow-up. It continues with its own conversation, agent, model and limits (a running one gets it at its next step).',
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
        description: 'Default false: the result comes back from the call. True returns an id at once; its full report is delivered into this conversation when it finishes (you are woken for it if your turn has ended), so do not poll. Use it only when you have other work meanwhile; the work is not done until that report arrives. Supervise can watch, guide, stop or wait on it.',
      },
      resume: {
        type: 'string',
        description: 'The id of an earlier sub-agent to continue: prompt is the follow-up. Same agent, model and limits, with its prior conversation.',
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
const WRITING_TOOLS = new Set(['Write', 'Edit', 'NotebookEdit', 'Bash', 'Terminal', 'MultiEdit', 'CodeRewrite', 'Refactor']);

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
  /**
   * Raises the absolute ceiling below, never lowers it. Set only inside an
   * approved long job (`longJobs.subAgentMaxMinutes`), whose milestones can
   * need a child that works longer than everyday delegation should.
   */
  subagentMaxMs?: number;
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
     * work that runs while the parent does something else. Its report is
     * delivered back into the conversation when it finishes (ADR 0021).
     */
    detach?: boolean;
    /** Continue an earlier sub-agent instead of spawning one — see {@link resumeTask}. */
    resume?: string;
  },
  opts: RunTaskOpts,
): Promise<string> {
  if (args.resume) {
    return resumeTask({
      resume: args.resume, prompt: args.prompt,
      ...(args.detach !== undefined ? { detach: args.detach } : {}),
      ...(args.timeout !== undefined ? { timeout: args.timeout } : {}),
    }, opts);
  }
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
  //
  // Below anything explicit, the model role for this kind of agent decides
  // (ADR 0017): `explore` for read-only researchers, `review` for checkers,
  // `coding` for the rest — `models.roles[role]`, then `agentModels` (the
  // legacy key: the name as requested first, so a model configured for a
  // retired role name still applies), then the preset (`balanced`: the
  // parent's model, as before).
  const IMPLEMENTATION_AGENTS = new Set(['frontend', 'backend', 'qa', 'healer']);
  const legacyType = args.subagent_type && opts.settings?.agentModels?.[args.subagent_type]
    ? args.subagent_type : agentType;
  const modelRole = resolveRole(roleForAgentType(args.subagent_type || args.agent_name || agentType), {
    settings: opts.settings, mainModel: opts.model, agentType: legacyType,
  });
  const roleModel = modelRole.ok && modelRole.model ? modelRole.model : undefined;
  const requestedModel = resolvedModel ?? args.model ?? roleModel ?? opts.model;
  const agentModel = (
    IMPLEMENTATION_AGENTS.has(agentType) && requestedModel.includes('haiku')
  ) ? opts.model : requestedModel;

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

  // Read from the ambient run context rather than passed down through options:
  // the Task tool executes inside its caller's context, so this is the session
  // the spawn belongs to without every call site having to remember to say so.
  const spawnedFrom = currentRunContext()?.sessionId;
  const parentAgentId = spawnedFrom?.startsWith('sub-') ? spawnedFrom.slice(4) : undefined;

  /*
    The parent's directory, not the process's.

    `runAgent` was called without a cwd, so `runInContext` fell back to
    `process.cwd()` — which on a server driving several workspaces is wherever
    it happened to be launched, not the project the delegation belongs to. A
    sub-agent asked to read a file was reading the wrong repository's copy of
    it. This is also where the child's log is filed, so it has to be right
    before that starts — and for a grandchild it is the conversation's
    directory, not a worktree its parent happened to be working in, or the
    Tasks panel could never find the transcript.
  */
  const parentCwd = currentCwd();
  const logCwd = (parentAgentId ? _specs.get(parentAgentId)?.logCwd : undefined) ?? parentCwd;

  /*
    Worktree isolation that isolates (ADR 0021).

    The worktree used to be created and then ignored: the child was handed
    `parentCwd` and edited the real checkout. Now the child's directory *is*
    the worktree, and a write bound pins AICO's file tools inside it — an
    absolute path copied from the brief into the parent's checkout is refused
    rather than quietly landing there. Bash is not bound (a command line is not
    a path; agents/paths-guard says so), which is why the brief says where to
    work as well.
  */
  let worktree: WorktreeRecord | undefined;
  let childCwd = parentCwd;
  let worktreeNote: string | undefined;
  if (args.isolation === 'worktree') {
    try {
      const { worktreeManager } = await import('../worktree/index.js');
      worktree = await worktreeManager.createWorktree(agentId, parentCwd);
      childCwd = worktreeManager.childCwd(worktree, parentCwd);
      fs.mkdirSync(childCwd, { recursive: true });
    } catch (err) {
      // Worktree creation failed — continue without isolation, and say so.
      worktree = undefined;
      worktreeNote = `Worktree failed, running in-place: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
  if (worktree) {
    fullPrompt += `\n\n---\n\nYou are working in an isolated git worktree at ${childCwd} (branch ${worktree.branch}), `
      + `a separate checkout of ${worktree.repoRoot ?? parentCwd}. Read and change files only there: a path in this brief `
      + `under ${worktree.repoRoot ?? parentCwd} means the same file inside your worktree. Your changes are committed to `
      + 'the branch for the caller to review and merge — do not merge or push it yourself.';
  }

  return launch({
    agentId,
    description: args.description,
    agentType,
    ...(args.agent_name ? { agentName: args.agent_name } : {}),
    model: agentModel,
    roleName: modelRole.role,
    task: withProjectProfile(fullPrompt),
    brief: args.prompt,
    ...(resolvedTools ? { tools: resolvedTools } : {}),
    ...(resolvedCanDelegate === false ? { canDelegate: false } : {}),
    ...(resolvedBounds ? { bounds: resolvedBounds } : {}),
    cwd: childCwd,
    logCwd,
    ...(worktree ? { worktree } : {}),
    ...(worktreeNote ? { startNote: worktreeNote } : {}),
    detach: args.detach === true,
    ...(args.timeout ? { timeout: args.timeout } : {}),
    ...(spawnedFrom ? { spawnedFrom } : {}),
    depth: opts.depth + 1,
    scope: worktree ? scopeForWorktree(opts.toolScope, worktree) : opts.toolScope,
    planMode: opts.planMode === true,
  }, opts);
}

/**
 * The delegating run's scope, re-rooted into a worktree: every inherited write
 * bound rooted in the repository is moved to the same place in the worktree,
 * and one more bound admits only the worktree. Only ever narrower than the
 * parent's for the real checkout — writes there are refused outright.
 */
function scopeForWorktree(scope: ToolScope | undefined, wt: WorktreeRecord): ToolScope {
  const base = scope ?? OPEN_SCOPE;
  const repo = wt.repoRoot;
  const rebased = (base.writeBounds ?? []).map(b => {
    if (!repo) return b;
    const rel = path.relative(repo, b.root);
    return rel.startsWith('..') || path.isAbsolute(rel) ? b : { ...b, root: path.join(wt.path, rel) };
  });
  return {
    ...base,
    writeBounds: [...rebased, { label: 'its worktree', root: wt.path, globs: ['**'] }],
  };
}

/** One child run, new or continued. Everything `launch` needs to start it and, later, to resume it. */
interface LaunchSpec {
  agentId: string;
  description: string;
  agentType: SubAgentType;
  agentName?: string;
  model: string;
  /** The model role its spend is booked to (ADR 0017). */
  roleName: Parameters<typeof recordRoleSpend>[0];
  /** What the child is told this run: the composed brief, or a follow-up when resumed. */
  task: string;
  /** The brief as the caller gave it, for the record. */
  brief: string;
  tools?: string[] | 'all' | 'readonly' | readonly string[];
  canDelegate?: false;
  bounds?: import('../agents/types.js').AgentBounds;
  cwd: string;
  logCwd: string;
  worktree?: WorktreeRecord;
  /** Said on the record before it starts (a worktree that could not be made). */
  startNote?: string;
  detach: boolean;
  timeout?: number;
  spawnedFrom?: string;
  /** The child's own depth. */
  depth: number;
  scope?: ToolScope | undefined;
  planMode: boolean;
  /** Set when this continues an earlier run of the same agent. */
  resumed?: boolean;
}

/** The ledger-persisted shape of a launch, for resume (ADR 0021). */
function resumeSpecOf(spec: LaunchSpec, opts: RunTaskOpts, owner: string | undefined): AgentResumeSpec {
  const scope = serializeScope(spec.scope);
  return {
    v: 1,
    description: spec.description,
    agentType: spec.agentType,
    ...(spec.agentName ? { agentName: spec.agentName } : {}),
    ...(spec.tools ? { tools: Array.isArray(spec.tools) ? [...spec.tools] : spec.tools as 'all' | 'readonly' } : {}),
    model: spec.model,
    cwd: spec.cwd,
    logCwd: spec.logCwd,
    ...(owner ? { owner } : {}),
    ...(spec.spawnedFrom ? { spawnedFrom: spec.spawnedFrom } : {}),
    depth: spec.depth,
    detach: spec.detach,
    autoApprove: opts.autoApprove,
    ...(spec.planMode ? { planMode: true } : {}),
    ...(scope ? { scope } : {}),
    ...(opts.toolGroups?.length ? { toolGroups: [...opts.toolGroups] } : {}),
    ...(spec.worktree ? {
      worktree: {
        path: spec.worktree.path, branch: spec.worktree.branch,
        base: spec.worktree.baseCommit ?? '', repoRoot: spec.worktree.repoRoot ?? spec.logCwd,
      },
    } : {}),
  };
}

/** Where every agent outside a conversation (a CLI run with no session) shares its slots. */
const NO_SESSION_POOL = '(no session)';

/**
 * Start one child run — a new spawn or a resumed one — blocking or detached.
 *
 * One path for both, so a resumed agent gets exactly the bounds, heartbeat,
 * slot, report delivery and worktree handling a new one does: a second, shorter
 * path beside this one is how "resume" would have become the way around them.
 */
async function launch(spec: LaunchSpec, opts: RunTaskOpts): Promise<string> {
  const { agentId, agentType } = spec;
  const owner = owningSession(spec.spawnedFrom);
  const parentAgentId = spec.spawnedFrom?.startsWith('sub-') ? spec.spawnedFrom.slice(4) : undefined;
  const now = Date.now();
  const previous = _registry.get(agentId);
  const record: SubAgentRecord = {
    agentId,
    ...(owner ? { sessionId: owner } : {}),
    ...(parentAgentId ? { parentAgentId } : {}),
    ...(spec.agentName ? { agentName: spec.agentName } : {}),
    brief: spec.brief.slice(0, 400),
    description: spec.description,
    model: spec.model,
    status: 'running',
    statusMessage: spec.startNote ?? 'Starting…',
    startedAt: now,
    depth: spec.depth,
    agentType,
    lastActivityAt: now,
    toolCallCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: 0,
    ...(spec.detach ? { detached: true } : {}),
    ...(spec.resumed ? { resumed: (previous?.resumed ?? 0) + 1 } : {}),
  };

  // Recorded before the registry emits, so the ledger row the mirror opens
  // carries it — and so does the row after a restart.
  _specs.set(agentId, resumeSpecOf(spec, opts, owner));
  if (_specs.size > 500) _specs.delete(_specs.keys().next().value!);
  // A resume reuses the id; whatever was waiting to clear the old record must
  // not clear this one, and nothing about the old run is still steerable.
  _consumedByWait.delete(agentId);
  _delivered.delete(agentId);
  _register(record);
  if (opts.settings) {
    await runHooks('SubagentStart', {
      event: 'SubagentStart',
      agentId,
      agentType,
      agentDescription: spec.description,
    }, opts.settings);
  }
  opts.onSubagentStart?.(record);

  /*
    A session of the child's own, and an inbox on top of it.

    The inbox is what makes a correction possible at all: it delivers at the
    child's next step boundary, so an instruction lands without discarding the
    tool results it has already gathered. Cancelling and re-briefing throws all
    of that away.

    The log is a side effect worth having on its own. A delegated agent used to
    be a black box that returned a paragraph; now what it actually did is on
    disk beside the conversation that asked for it. Nothing is written unless
    the child records something — see `persistSession`. It is also what a
    resume rebuilds the conversation from: reopening `sub-<id>` replays it.

    Failing to open one is not fatal. The child runs without steering rather
    than not running.
  */
  let sub: Awaited<ReturnType<typeof openSession>> | undefined;
  let inbox: Inbox | undefined;
  try {
    sub = await openSession(`sub-${agentId}`, spec.logCwd);
    inbox = new Inbox(sub.session);
    _inboxes.set(agentId, inbox);
  } catch {
    // No transcript and no steering for this one; the work still happens.
  }

  /*
    The stop handle exists before the child has a slot, so a queued agent can
    be stopped too — it then never starts. Registered so a supervisor (the
    reader watching the panel, the orchestrator between delegations, the
    composer's Stop on a later turn) can stop this one child without taking
    its siblings down with it.
  */
  const abortController = new AbortController();
  _stops.set(agentId, { abort: () => abortController.abort() });
  // Forward an external abort (e.g. studio pipeline cancellation, the parent
  // turn's Stop) into the sub-agent's internal controller so the runAgent call
  // tears down promptly.
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

  const pool = owner ?? NO_SESSION_POOL;
  const maxSlots = maxConcurrentFrom(opts.settings);
  /** How it ended, for the report a detached run delivers. */
  let finalStatus: SubAgentStatus = 'failed';

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
    // A slot under `agents.maxConcurrent` first (agents/limiter). Over the
    // cap the agent waits, shown as queued — never refused.
    const slot = acquireSlot(pool, agentId, maxSlots, abortController.signal);
    if (slot.queued) {
      _update(agentId, { queued: true, statusMessage: `Queued — ${maxSlots} agent(s) already running in this session` });
    }
    await slot.ready;
    if (slot.queued) _update(agentId, { queued: false });

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
    const idleTimeoutMs = (spec.timeout ? spec.timeout * 1000 : undefined)
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
      spec.timeout ? spec.timeout * 1000 * 3 : 0,
      opts.subagentMaxMs ?? 0,
    );

    // Measured from when it got a slot: time spent queued is not time worked.
    const runStartedAt = Date.now();
    let lastActivity = runStartedAt;
    let toolCallCount = 0;

    /*
      A detached child has nobody to ask. It inherits the parent's approval
      posture (autoApprove) and decides everything else from policy, exactly as
      a background agent always has (background/decideHeadlessPermission).
      Without this, a detached child under a parent that asks fell through to
      the terminal prompt and hung until its idle timeout.
    */
    let headless: Partial<Parameters<typeof runAgent>[0]> = {};
    if (spec.detach) {
      const { decideHeadlessPermission } = await import('../background/index.js');
      headless = {
        headless: true,
        onPermissionRequest: async (toolName: string) =>
          decideHeadlessPermission(toolName, 'inherit', opts.autoApprove).allowed,
      };
    }

    const agentPromise = runAgent({
      task: spec.task,
      token: opts.token ?? '',
      model: spec.model,
      autoApprove: opts.autoApprove,
      verbose: opts.verbose,
      showPlan: false,
      conversationHistory: [],
      sessionId: `sub-${agentId}`,
      cwd: spec.cwd,
      ...(sub ? { session: sub.session } : {}),
      ...(inbox ? { inbox } : {}),
      silent: true,
      depth: spec.depth,
      agentType,
      ...headless,
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
      ...(spec.planMode ? { planMode: true } : {}),
      ...(opts.toolGroups?.length ? { toolGroups: opts.toolGroups } : {}),
      // Pass the resolved spec tools so runAgent uses the custom whitelist
      // instead of the hardcoded SUBAGENT_TOOL_SETS for this agent type.
      ...(spec.tools ? { agentSpecTools: spec.tools as string[] | 'all' | 'readonly' } : {}),
      //   toolScope    the parent's effective set — the child's own list is
      //                intersected with it, so `tools: 'all'` means the parent's.
      //   canDelegate  a named agent that may not delegate does not, in code.
      ...(spec.scope ? { toolScope: spec.scope } : {}),
      ...(spec.canDelegate === false ? { canDelegate: false } : {}),
      ...(spec.bounds ? { agentBounds: spec.bounds } : {}),
      abortSignal: abortController.signal,
      // Sub-agent status updates feed back into registry — AND reset heartbeat
      onToolCall: (name: string, toolArgs?: Record<string, unknown>) => {
        const current = _registry.get(agentId);
        if (current && isTerminal(current.status)) return;
        lastActivity = Date.now();
        toolCallCount++;
        _update(agentId, {
          statusMessage: name + '…',
          lastActivityAt: lastActivity,
          toolCallCount,
          currentTool: name,
          lastStep: humaniseStep(name, toolArgs),
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
        // Spend per model role (ADR 0017): explore, review or coding.
        recordRoleSpend(spec.roleName, costFor(spec.model, { inputTokens: input, outputTokens: output, cachedTokens: cached }, opts.settings));
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
        const totalMs = Date.now() - runStartedAt;

        if (idleMs > idleTimeoutMs) {
          abortController.abort();
          clearInterval(checkInterval);
          reject(new Error(
            `Sub-agent "${spec.description}" idle for ${Math.round(idleMs / 1000)}s (no tool activity). ` +
            `Total runtime: ${Math.round(totalMs / 1000)}s, ${toolCallCount} tool calls made.`
          ));
        } else if (totalMs > absoluteMaxMs) {
          abortController.abort();
          clearInterval(checkInterval);
          reject(new Error(
            `Sub-agent "${spec.description}" hit absolute time limit (${Math.round(absoluteMaxMs / 60_000)} min). ` +
            `${toolCallCount} tool calls made. Last activity ${Math.round(idleMs / 1000)}s ago.`
          ));
        }
      }, 10_000);
      checkInterval.unref?.();

      // Clean up interval if agent finishes normally
      agentPromise.then(() => clearInterval(checkInterval), () => clearInterval(checkInterval));
    });

    let result = await Promise.race([agentPromise, heartbeatPromise]);

    _stops.delete(agentId);
    finalStatus = 'completed';
    _update(agentId, { status: 'completed', statusMessage: 'Done', completedAt: Date.now(), result });
    if (opts.settings) {
      await runHooks('SubagentStop', {
        event: 'SubagentStop',
        agentId,
        agentType,
        agentDescription: spec.description,
      }, opts.settings);
    }
    opts.onSubagentStop?.({ ..._registry.get(agentId)! });

    // A worktree's work is committed to its branch, never discarded, and the
    // parent is told where it is and how to take it.
    const wtNote = await finishWorktree(spec);
    if (wtNote) result += `\n\n${wtNote}`;

    // Auto-clear completed agents after 10s so panel stays clean
    const clear = setTimeout(() => {
      const rec = _registry.get(agentId);
      if (rec === record && rec.status === 'completed') _registry.delete(agentId);
      _emit();
    }, 10_000);
    clear.unref?.();

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
    // Never discard a worktree's work, however the run ended (worktree/).
    const wtNote = await finishWorktree(spec);
    if (stopReason) {
      finalStatus = 'cancelled';
      _update(agentId, {
        status: 'cancelled', statusMessage: 'Stopped', queued: false,
        completedAt: Date.now(), error: errMsg,
      });
      // Cleared on the same schedule as a failure — a reader who just stopped
      // something wants to see that it stopped.
      const clear = setTimeout(() => {
        const rec = _registry.get(agentId);
        if (rec === record && rec.status === 'cancelled') _registry.delete(agentId);
        _emit();
      }, 30_000);
      clear.unref?.();
      // From the record, not the loop variable: the counter is scoped to the
      // try block and this is the catch.
      const calls = _registry.get(agentId)?.toolCallCount ?? 0;
      return `[Sub-agent "${spec.description}" was stopped: ${stopReason}. `
        + `It made ${calls} tool call(s) before stopping — anything it had already `
        + `written is still on disk. Decide what to do next rather than re-running it unchanged.]`
        + (wtNote ? `\n\n${wtNote}` : '');
    }
    finalStatus = 'failed';
    _update(agentId, { status: 'failed', statusMessage: 'Failed', queued: false, completedAt: Date.now(), error: errMsg });
    if (opts.settings) {
      await runHooks('SubagentStop', {
        event: 'SubagentStop',
        agentId,
        agentType,
        agentDescription: spec.description,
      }, opts.settings);
    }
    opts.onSubagentStop?.({ ..._registry.get(agentId)! });
    // Auto-clear failed agents after 30s (longer than success 10s so user can read the error)
    const clear = setTimeout(() => {
      const rec = _registry.get(agentId);
      if (rec === record && rec.status === 'failed') _registry.delete(agentId);
      _emit();
    }, 30_000);
    clear.unref?.();
    return `[Sub-agent "${spec.description}" failed: ${errMsg}]` + (wtNote ? `\n\n${wtNote}` : '');
  } finally {
    releaseSlot(pool, agentId);
    detachParentAbort?.();
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

      Not for a worktree child: what it wrote is on its branch, not in the
      parent's tree, and the parent's checks have nothing of it to judge.
    */
    const work = workOf(`sub-${agentId}`);
    if (work && !spec.worktree) {
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

  if (!spec.detach) {
    /*
      A sub-agent blocking on its own child gives its slot up while it waits
      (agents/limiter): otherwise parents waiting on children could hold every
      slot while the children queue for one that never frees.
    */
    if (parentAgentId) suspendSlot(pool, parentAgentId);
    try {
      return await settle();
    } finally {
      if (parentAgentId) await resumeSlot(pool, parentAgentId, maxSlots, opts.abortSignal).catch(() => undefined);
    }
  }

  /*
    Detached: started, not awaited.

    The result is kept so `Supervise wait` can come back for it — the work
    is already in flight and there would otherwise be nothing to await. The
    `catch` is attached immediately and separately: an unhandled rejection here
    would take the process down, and the rejection is genuinely handled, by
    whoever calls `wait`.

    And when it settles, its report goes back to whoever is waiting for it
    (ADR 0021) — the full text, bounded like a Task result, success or not.
  */
  const running = settle();
  // Read after `settle` has asked for its slot (synchronously, before its
  // first await), so the reply can say the agent is waiting for one.
  const queuedAtSpawn = _registry.get(agentId)?.queued === true;
  _detached.set(agentId, running);
  running.catch(() => undefined);
  void running.then(
    text => deliverReport(spec, finalStatus, text, opts.settings),
    err => deliverReport(spec, 'failed', err instanceof Error ? err.message : String(err), opts.settings),
  ).catch(() => undefined);
  /*
    Kept well past the finish, then dropped.

    The registry clears a completed agent after ten seconds so the panel stays
    tidy, which would otherwise make a late `wait` report "nothing to wait for"
    about work that succeeded. Ten minutes is long enough for any parent that
    means to collect a result, and short enough that a server left running for
    days does not accumulate every delegation it ever made.
  */
  void running.finally(() => {
    const forget = setTimeout(() => { if (_detached.get(agentId) === running) _detached.delete(agentId); }, 600_000);
    forget.unref?.();
  });
  return `[Spawned "${spec.description}" as sub-agent ${agentId}, running in the background`
    + `${queuedAtSpawn ? ` (queued: this session already has ${maxSlots} agent(s) running; it starts when one finishes)` : ''}. `
    + 'It is NOT finished and has produced nothing yet. Its full report will be delivered into this '
    + 'conversation when it finishes — you do not need to poll for it. Supervise can watch it ("list"), '
    + 'correct it without restarting it ("guide"), stop it ("stop"), or block on it ("wait") if you cannot '
    + `continue without it. Do not report this task as done until its report has arrived.]`;
}

/** Finish a launch's worktree, if it had one, and describe where the work is. */
async function finishWorktree(spec: LaunchSpec): Promise<string | undefined> {
  if (!spec.worktree) return undefined;
  try {
    const { worktreeManager, describeWorktreeFinish } = await import('../worktree/index.js');
    const finished = await worktreeManager.finish(spec.worktree.worktreeId, {
      message: `AICO sub-agent ${spec.agentId}: ${spec.description}`.slice(0, 200),
    });
    return finished ? describeWorktreeFinish(finished) : undefined;
  } catch (err) {
    return `[Worktree ${spec.worktree.path} was left in place: ${err instanceof Error ? err.message : String(err)}. Nothing was discarded.]`;
  }
}

/**
 * Hand a finished detached agent's report back (agents/report-back).
 *
 * To its parent agent's inbox when another agent spawned it and is still
 * running — that is who asked — and to the conversation otherwise. Skipped
 * when a `Supervise wait` handed the outcome over already: the same report
 * twice is context paid for twice.
 */
async function deliverReport(
  spec: LaunchSpec, status: SubAgentStatus, text: string, settings: AicoSettings | undefined,
): Promise<void> {
  const id = spec.agentId;
  if (_awaited.has(id) || _consumedByWait.has(id)) return;
  const head = status === 'completed'
    ? `[Background agent ${id} finished — "${spec.description}"]`
    : status === 'cancelled'
      ? `[Background agent ${id} was stopped — "${spec.description}"]`
      : `[Background agent ${id} failed — "${spec.description}"]`;
  const body = await boundReport(text, 'BackgroundAgent', id);
  const tail = `\n\n(Its conversation is kept: send it a follow-up with Task {"resume": "${id}", "description": "…", "prompt": "…"}.)`;
  const content = `${head}\n\n${body}${tail}`;
  _delivered.add(id);

  const parentAgentId = spec.spawnedFrom?.startsWith('sub-') ? spec.spawnedFrom.slice(4) : undefined;
  const parentInbox = parentAgentId ? _inboxes.get(parentAgentId) : undefined;
  if (parentInbox) {
    parentInbox.inject(content, { kind: 'plugin', plugin: 'background-agent' });
    return;
  }
  const owner = owningSession(spec.spawnedFrom);
  await reportBack({
    sessionId: owner ?? '',
    content,
    plugin: 'background-agent',
    // A stopped agent never starts a turn: the person (or the model) who
    // stopped it already knows, and a Stop followed by the session talking
    // again by itself would undo what Stop means.
    wake: Boolean(owner) && status !== 'cancelled' && wakeOnResult(settings),
    cwd: spec.logCwd,
    title: `Agent ${status === 'completed' ? 'done' : status}: ${spec.description.slice(0, 50)}`,
    failed: status !== 'completed',
  });
}

/**
 * Continue an earlier sub-agent with a follow-up (`Task {resume}`).
 *
 * Why on `Task` and not a `Supervise message` verb: continuing an agent *is*
 * making a child run, and `Task` is the one place a child is made — the
 * calling run's depth, tool scope, plan mode, delegation rule, token tracker
 * and abort signal are all in hand there and are applied exactly as for a new
 * spawn. `Supervise` runs outside the loop and has none of them; a resume from
 * there would be a second, unbounded way to start a model loop (ADR 0021).
 *
 * - A running agent gets the follow-up at its next step boundary (what
 *   `Supervise guide` does).
 * - A finished, failed, stopped or interrupted one is run again under the same
 *   id: same agent type/name, tools and model, its history rebuilt from its own
 *   `sub-<id>` log — tool calls are never replayed, an unanswered one reads as
 *   unanswered (session/derive) — within the caller's budgets and scope,
 *   intersected with the scope it originally ran under.
 */
export async function resumeTask(
  args: { resume: string; prompt: string; detach?: boolean; timeout?: number },
  opts: RunTaskOpts,
): Promise<string> {
  const id = normalizeAgentId(args.resume);
  const prompt = args.prompt?.trim();
  if (!id) return '[error] resume needs the id of an earlier sub-agent.';
  if (!prompt) return '[error] resume needs a prompt — the follow-up to send it.';
  const spec = agentResumeSpec(id);
  if (!spec) return `[error] No sub-agent "${id}" to resume — it is unknown here (use Supervise "list" with all:true to see ids).`;

  // One conversation must never drive another's agents.
  const caller = owningSession(currentRunContext()?.sessionId);
  if (spec.owner && caller && spec.owner !== caller) {
    return `[error] Sub-agent "${id}" belongs to another conversation and cannot be resumed from this one.`;
  }

  const live = _registry.get(id);
  if (live && !isTerminal(live.status)) {
    if (guideAgent(id, prompt)) {
      return `[Delivered to running sub-agent ${id} ("${live.description}") — it reads it at its next step boundary, `
        + 'keeping everything it has learned so far. Its report comes back as before.]';
    }
    return `[error] Sub-agent "${id}" is still running but cannot be reached right now; try again in a moment or stop it.`;
  }

  if (opts.depth >= 4) return `[error] Sub-agent depth limit reached — max nesting is 4 levels.`;
  if (opts.toolScope && !opts.toolScope.delegate) {
    return '[error] This agent may not delegate (canDelegate is off for it or for an agent above it), so it cannot resume one either.';
  }

  // A named agent is resolved again: its bounds (deny list, budget, write
  // paths) are part of what it is, and a definition switched off since is
  // honoured rather than bypassed by resuming.
  let bounds: import('../agents/types.js').AgentBounds | undefined;
  let canDelegate: false | undefined;
  if (spec.agentName) {
    try {
      const { resolveAgent } = await import('../agents/resolve.js');
      const resolved = await resolveAgent(spec.agentName, spec.logCwd);
      if (!resolved) return `[error] Agent "${spec.agentName}" no longer exists, so sub-agent "${id}" cannot be resumed as it.`;
      bounds = resolved.bounds;
      if (resolved.bounds.delegate === 'none') canDelegate = false;
    } catch {
      return `[error] Failed to load agent "${spec.agentName}" to resume sub-agent "${id}".`;
    }
  }

  // Where to work: its worktree again (re-added from the kept branch when it
  // was removed), else where it worked, else the conversation's directory.
  let cwd = fs.existsSync(spec.cwd) ? spec.cwd : spec.logCwd;
  let worktree: WorktreeRecord | undefined;
  let note: string | undefined;
  if (spec.worktree) {
    const { worktreeManager } = await import('../worktree/index.js');
    const back = await worktreeManager.reattach({ path: spec.worktree.path, branch: spec.worktree.branch, repoRoot: spec.worktree.repoRoot });
    worktree = worktreeManager.getByAgentId(id);
    if (back && worktree) {
      cwd = fs.existsSync(spec.cwd) ? spec.cwd : back;
    } else {
      worktree = undefined;
      cwd = spec.logCwd;
      note = `Its worktree (branch ${spec.worktree.branch}) could not be restored; it continues in ${cwd}.`;
    }
  }

  const callerScope = opts.toolScope;
  const originalScope = deserializeScope(spec.scope);
  const scope = intersectScopes(callerScope, worktree ? scopeForWorktree(originalScope, worktree) : originalScope);
  const agentType = canonicalAgentType(spec.agentType);
  const owner = spec.owner ?? caller;
  if (owner) recordOwner(`sub-${id}`, owner);

  return launch({
    agentId: id,
    description: spec.description,
    agentType,
    ...(spec.agentName ? { agentName: spec.agentName } : {}),
    model: spec.model,
    roleName: roleForAgentType(spec.agentName || agentType),
    task: prompt,
    brief: prompt,
    ...(spec.tools ? { tools: spec.tools as string[] | 'all' | 'readonly' } : {}),
    ...(canDelegate === false ? { canDelegate } : {}),
    ...(bounds ? { bounds } : {}),
    cwd,
    logCwd: spec.logCwd,
    ...(worktree ? { worktree } : {}),
    ...(note ? { startNote: note } : {}),
    detach: args.detach ?? false,
    ...(args.timeout ? { timeout: args.timeout } : {}),
    // Filed under the same parent as before, so ownership and the report's
    // route do not change because someone else asked for the follow-up.
    ...(spec.spawnedFrom ? { spawnedFrom: spec.spawnedFrom } : owner ? { spawnedFrom: owner } : {}),
    depth: opts.depth + 1,
    ...(scope ? { scope } : {}),
    planMode: opts.planMode === true || spec.planMode === true,
    resumed: true,
  }, opts);
}

/**
 * The follow-up an agent interrupted by a restart is resumed with.
 *
 * Says plainly that nothing was replayed: the tool call it was in the middle
 * of reads as unanswered in its history, and it has to look before repeating
 * anything that changes things.
 */
export const RESUME_AFTER_RESTART = '[Resumed after a restart] AICO restarted while you were working. Your conversation so far '
  + 'is above. Any tool call that had not returned was NOT re-run — check the actual state (files, processes) before '
  + 'repeating anything that changes things. Then continue the task and finish with your report.';

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

