import { bash, bashDefinition } from './bash.js';
import { currentCwd } from '../run-context.js';
import { readFile, readDefinition } from './read.js';
import { readAttachment, readAttachmentDefinition } from './read-attachment.js';
import { writeFile, writeDefinition } from './write.js';
import { editFile, editDefinition } from './edit.js';
import { globFiles, globDefinition } from './glob.js';
import { grepFiles, grepDefinition } from './grep.js';
import { listDirectory, lsDefinition } from './ls.js';
import { webFetch, webFetchDefinition } from './webfetch.js';
import { verifyApp, verifyAppDefinition, formatVerdict } from './verify-app.js';
import { recordVerification, noteFileWritten } from '../verification.js';
import { withTimeout } from './timeout-policy.js';
import { terminal, terminalDefinition } from './terminal.js';
import { observe, blockedReason } from './observation.js';
import { proposePlan, proposePlanDefinition } from './plan.js';
import { runChecks, runChecksDefinition } from './run-checks.js';
import { codeMap, codeMapDefinition } from './codemap.js';
import { gitTool, gitDefinition } from './git.js';
import { knowledgeTool, knowledgeDefinition } from './knowledge.js';
import { checkpointTool, checkpointDefinition } from './checkpoint.js';
import { useSkill, skillDefinition } from './skill.js';
import { noteSourceChanged } from '../checks.js';
import { webSearch, webSearchDefinition } from './websearch.js';
import { notebookEdit, notebookEditDefinition } from './notebook.js';
import { todoRead, todoReadDefinition, todoWrite, todoWriteDefinition } from './todo.js';
import { askUser, askUserDefinition } from './askuser.js';
import { getWorkingDirectory, pwdDefinition } from './pwd.js';
// ── New feature tool imports ─────────────────────────────────────────
import {
  backgroundTaskToolDefinition,
  spawnBackgroundAgent,
  getBackgroundAgentOpts,
} from '../background/index.js';
import {
  pushNotificationToolDefinition,
  executePushNotification,
} from '../background/notifications.js';
import {
  listMcpResourcesToolDefinition,
  readMcpResourceToolDefinition,
  executeListMcpResources,
  executeReadMcpResource,
} from '../mcp/resources.js';
import {
  mcpAddServerToolDefinition,
  mcpRemoveServerToolDefinition,
  mcpReloadServersToolDefinition,
  addMcpServer,
  removeMcpServer,
  reloadMcpServers,
} from '../mcp/manage.js';
import {
  enterWorktreeToolDefinition,
  exitWorktreeToolDefinition,
  executeEnterWorktree,
  executeExitWorktree,
} from '../worktree/tools.js';
import {
  cronCreateToolDefinition,
  cronDeleteToolDefinition,
  cronListToolDefinition,
  cronPauseToolDefinition,
  cronResumeToolDefinition,
  executeCronCreate,
  executeCronDelete,
  executeCronList,
  executeCronPause,
  executeCronResume,
} from '../cron/tools.js';
import {
  capabilityReportToolDefinition,
  executeWorkspaceInfo,
  executeWorkspaceList,
  executeWorkspaceRead,
  executeWorkspaceSetPath,
  executeWorkspaceWrite,
  workspaceInfoToolDefinition,
  workspaceListToolDefinition,
  workspaceReadToolDefinition,
  workspaceSetPathToolDefinition,
  workspaceWriteToolDefinition,
} from './workspace.js';
import {
  agentCreateToolDefinition,
  agentListToolDefinition,
  agentPromptToolDefinition,
  agentReadToolDefinition,
  executeAgentCreate,
  executeAgentList,
  executeAgentPrompt,
  executeAgentRead,
  executeTeamPrompt,
  teamPromptToolDefinition,
} from './agents.js';
import { skillCreateToolDefinition, executeSkillCreate } from '../skills/create.js';
import { skillManageToolDefinition, executeSkillManage } from '../skills/manage.js';
import { mcpManageToolDefinition, executeMcpManage } from '../mcp/manage-tool.js';
import type { McpManageInput } from '../mcp/manage-tool.js';
import { agentManageToolDefinition, executeAgentManage } from './manage-agents.js';
import { memoryManageToolDefinition, executeMemoryManage } from './manage-memory.js';
import type { MemoryManageInput } from './manage-memory.js';
import type { AgentManageInput } from './manage-agents.js';
import type { SkillManageInput } from '../skills/manage.js';
import { buildCapabilityReport } from '../capabilities.js';
import { getWorkspaceInfo, getWorkspaceRuntime } from '../workspace.js';
import { mcpRegistry } from '../mcp/registry.js';
import { listAgentSpecs } from '../agents/registry.js';
import { skillRegistry } from '../skills/index.js';
import { cronScheduler } from '../cron/scheduler.js';
import { getBackgroundAgents } from '../background/index.js';
import { getAgentRegistry } from './task.js';
import { spillResult } from './spill.js';

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** Whether this tool is safe to run concurrently with other safe tools */
  isConcurrencySafe?: boolean;
  /** Maximum result size in characters before truncation (default: 50000) */
  maxResultSizeChars?: number;
}

/** Sub-agent types restrict which tools are available */
export type SubAgentType =
  // Core types
  | 'general' | 'explore' | 'plan' | 'verification' | 'security-audit'
  | 'project' | 'devops' | 'devsecops' | 'review'
  // Studio pipeline types
  | 'frontend' | 'backend' | 'qa' | 'architect'
  | 'tech-writer' | 'product-owner' | 'healer' | 'studio-orchestrator';

/**
 * Tool sets by sub-agent type.
 *
 * `CodebaseMap` is in every read-oriented set on purpose: those agents start
 * their work by finding out where things are, and without it each one repeats
 * the Glob-and-Grep opening sequence its siblings just ran — the cost a shared
 * index exists to pay once.
 */
const SUBAGENT_TOOL_SETS: Record<SubAgentType, Set<string> | 'all'> = {
  // Core
  general: 'all',
  explore: new Set(['CodebaseMap', 'Read', 'Glob', 'Grep', 'LS', 'Bash', 'WebFetch', 'WebSearch', 'Pwd']),
  plan: new Set(['CodebaseMap', 'Read', 'Glob', 'Grep', 'LS', 'Bash', 'WebFetch', 'WebSearch', 'Pwd', 'TodoRead', 'TodoWrite']),
  // VerifyApp included: an agent whose only job is verification could not, until
  // now, open the page it was asked to verify.
  verification: new Set(['Read', 'Glob', 'Grep', 'LS', 'Bash', 'Pwd', 'VerifyApp']),
  'security-audit': new Set(['CodebaseMap', 'Read', 'Glob', 'Grep', 'LS', 'Bash', 'WebFetch', 'WebSearch', 'Pwd', 'TodoRead', 'TodoWrite']),
  // Project orchestrator — full access (it spawns specialists)
  project: 'all',
  // DevOps — full access to create IaC files + run infrastructure commands
  devops: 'all',
  // DevSecOps — read-only + Bash for running scanners (no file modification)
  devsecops: new Set(['CodebaseMap', 'Read', 'Glob', 'Grep', 'LS', 'Bash', 'WebFetch', 'WebSearch', 'Pwd', 'TodoRead', 'TodoWrite']),
  // Code review — read-only + Bash for running linters/tests
  review: new Set(['CodebaseMap', 'Read', 'Glob', 'Grep', 'LS', 'Bash', 'Pwd', 'VerifyApp', 'TodoRead', 'TodoWrite']),
  // Studio — implementation agents (full access)
  frontend: 'all',
  backend: 'all',
  healer: 'all',
  'studio-orchestrator': 'all',
  'tech-writer': 'all',
  // Studio — constrained agents
  qa: new Set(['CodebaseMap', 'Read', 'Grep', 'Glob', 'LS', 'Bash', 'Write', 'Edit', 'Pwd', 'VerifyApp', 'TodoRead', 'TodoWrite', 'McpAddServer', 'McpRemoveServer', 'McpReloadServers', 'ListMcpResources', 'ReadMcpResource', 'WorkspaceInfo', 'WorkspaceWrite', 'WorkspaceRead', 'WorkspaceList', 'CapabilityReport', 'AgentList', 'AgentRead']),
  architect: new Set(['CodebaseMap', 'Read', 'Grep', 'Glob', 'LS', 'Bash', 'Write', 'Edit', 'Pwd', 'WebFetch', 'WebSearch', 'TodoRead', 'TodoWrite']),
  'product-owner': new Set(['CodebaseMap', 'Read', 'Grep', 'Glob', 'LS', 'Bash', 'Write', 'Edit', 'Pwd', 'WebFetch', 'WebSearch']),
};

export const toolDefinitions: ToolDefinition[] = [
  { ...bashDefinition, isConcurrencySafe: false, maxResultSizeChars: 50_000 },
  // Not concurrency-safe, and more strictly than most: one shell has one stdin,
  // and two commands sharing it have no way to tell their replies apart.
  { ...terminalDefinition, isConcurrencySafe: false, maxResultSizeChars: 50_000 },
  { ...readDefinition, isConcurrencySafe: true, maxResultSizeChars: 200_000 },
  { ...readAttachmentDefinition, isConcurrencySafe: true, maxResultSizeChars: 100_000 },
  { ...writeDefinition, isConcurrencySafe: false, maxResultSizeChars: 5_000 },
  { ...editDefinition, isConcurrencySafe: false, maxResultSizeChars: 5_000 },
  { ...globDefinition, isConcurrencySafe: true, maxResultSizeChars: 50_000 },
  { ...grepDefinition, isConcurrencySafe: true, maxResultSizeChars: 50_000 },
  { ...lsDefinition, isConcurrencySafe: true, maxResultSizeChars: 50_000 },
  { ...webFetchDefinition, isConcurrencySafe: true, maxResultSizeChars: 100_000 },
  // Not concurrency-safe: it launches a browser and the verdict it records is
  // read by the completion gate, so two overlapping runs would race over which
  // artifact the turn is judged on.
  { ...verifyAppDefinition, isConcurrencySafe: false, maxResultSizeChars: 40_000 },
  // Not concurrency-safe: two suites running at once fight over ports, build
  // outputs and lock files, and the verdict the gate reads must belong to one
  // known state of the tree.
  { ...runChecksDefinition, isConcurrencySafe: false, maxResultSizeChars: 40_000 },
  // Read-only and answered from a cached index, so several may overlap freely.
  { ...codeMapDefinition, isConcurrencySafe: true, maxResultSizeChars: 30_000 },
  // One index, one HEAD, one staging area. Two git commands overlapping is
  // how a commit ends up containing half of somebody else's work.
  { ...gitDefinition, isConcurrencySafe: false, maxResultSizeChars: 30_000 },
  // Reads dominate, and a write is one small file — safe to overlap.
  { ...knowledgeDefinition, isConcurrencySafe: true, maxResultSizeChars: 20_000 },
  // A restore rewrites files. Nothing else may be running while it does.
  { ...checkpointDefinition, isConcurrencySafe: false, maxResultSizeChars: 20_000 },
  { ...webSearchDefinition, isConcurrencySafe: true, maxResultSizeChars: 50_000 },
  { ...notebookEditDefinition, isConcurrencySafe: false, maxResultSizeChars: 50_000 },
  { ...todoReadDefinition, isConcurrencySafe: true, maxResultSizeChars: 10_000 },
  { ...todoWriteDefinition, isConcurrencySafe: false, maxResultSizeChars: 5_000 },
  { ...proposePlanDefinition, isConcurrencySafe: false, maxResultSizeChars: 5_000 },
  { ...askUserDefinition, isConcurrencySafe: false, maxResultSizeChars: 5_000 },
  { ...pwdDefinition, isConcurrencySafe: true, maxResultSizeChars: 1_000 },
  // ── New feature tools ─────────────────────────────────────────────
  { ...backgroundTaskToolDefinition, isConcurrencySafe: false, maxResultSizeChars: 1_000 },
  { ...pushNotificationToolDefinition, isConcurrencySafe: true, maxResultSizeChars: 500 },
  { ...listMcpResourcesToolDefinition, isConcurrencySafe: true, maxResultSizeChars: 20_000 },
  { ...readMcpResourceToolDefinition, isConcurrencySafe: true, maxResultSizeChars: 100_000 },
  { ...mcpAddServerToolDefinition, isConcurrencySafe: false, maxResultSizeChars: 2_000 },
  { ...mcpRemoveServerToolDefinition, isConcurrencySafe: false, maxResultSizeChars: 1_000 },
  { ...mcpReloadServersToolDefinition, isConcurrencySafe: false, maxResultSizeChars: 5_000 },
  { ...enterWorktreeToolDefinition, isConcurrencySafe: false, maxResultSizeChars: 2_000 },
  { ...exitWorktreeToolDefinition, isConcurrencySafe: false, maxResultSizeChars: 2_000 },
  { ...cronCreateToolDefinition, isConcurrencySafe: false, maxResultSizeChars: 1_000 },
  { ...cronDeleteToolDefinition, isConcurrencySafe: false, maxResultSizeChars: 500 },
  { ...cronListToolDefinition, isConcurrencySafe: true, maxResultSizeChars: 10_000 },
  { ...cronPauseToolDefinition, isConcurrencySafe: false, maxResultSizeChars: 500 },
  { ...cronResumeToolDefinition, isConcurrencySafe: false, maxResultSizeChars: 500 },
  { ...workspaceInfoToolDefinition, isConcurrencySafe: true, maxResultSizeChars: 5_000 },
  { ...workspaceSetPathToolDefinition, isConcurrencySafe: false, maxResultSizeChars: 2_000 },
  { ...workspaceWriteToolDefinition, isConcurrencySafe: false, maxResultSizeChars: 2_000 },
  { ...workspaceReadToolDefinition, isConcurrencySafe: true, maxResultSizeChars: 100_000 },
  { ...workspaceListToolDefinition, isConcurrencySafe: true, maxResultSizeChars: 20_000 },
  { ...capabilityReportToolDefinition, isConcurrencySafe: true, maxResultSizeChars: 100_000 },
  { ...agentCreateToolDefinition, isConcurrencySafe: false, maxResultSizeChars: 5_000 },
  { ...agentListToolDefinition, isConcurrencySafe: true, maxResultSizeChars: 20_000 },
  { ...agentReadToolDefinition, isConcurrencySafe: true, maxResultSizeChars: 50_000 },
  { ...agentPromptToolDefinition, isConcurrencySafe: true, maxResultSizeChars: 100_000 },
  { ...teamPromptToolDefinition, isConcurrencySafe: true, maxResultSizeChars: 120_000 },
  { ...skillCreateToolDefinition, isConcurrencySafe: false, maxResultSizeChars: 5_000 },
  { ...skillManageToolDefinition, isConcurrencySafe: false, maxResultSizeChars: 20_000 },
  { ...mcpManageToolDefinition, isConcurrencySafe: false, maxResultSizeChars: 20_000 },
  { ...agentManageToolDefinition, isConcurrencySafe: false, maxResultSizeChars: 20_000 },
  { ...memoryManageToolDefinition, isConcurrencySafe: false, maxResultSizeChars: 20_000 },
  // Reading a procedure changes nothing, so several can open at once.
  { ...skillDefinition, isConcurrencySafe: true, maxResultSizeChars: 60_000 },
];

/** Get tool definitions filtered for a specific sub-agent type */
export function getToolsForAgent(agentType: SubAgentType = 'general'): ToolDefinition[] {
  const allowedSet = SUBAGENT_TOOL_SETS[agentType];
  if (allowedSet === 'all') return toolDefinitions;
  return toolDefinitions.filter(t => allowedSet.has(t.name));
}

/** Readonly tool preset (same as the 'explore' agent set) */
const READONLY_TOOLS = new Set(['Read', 'Glob', 'Grep', 'LS', 'Bash', 'WebFetch', 'WebSearch', 'Pwd']);

/**
 * Resolve a custom tool whitelist to actual ToolDefinitions.
 * Used by the dynamic agent_spec system — lets the orchestrator define exactly
 * which tools an inline-created agent gets.
 *
 * @param tools - 'all' for everything, 'readonly' for read-only, or an explicit
 *                array of tool names (e.g. ['Read', 'Write', 'Bash'])
 */
export function getToolsForSpec(tools: string[] | 'all' | 'readonly'): ToolDefinition[] {
  if (tools === 'all') return toolDefinitions;
  if (tools === 'readonly') return toolDefinitions.filter(t => READONLY_TOOLS.has(t.name));
  const toolSet = new Set(tools);
  return toolDefinitions.filter(t => toolSet.has(t.name));
}

/** Default bash timeout from settings (injected at startup) */
let _bashDefaultTimeout = 120;
export function setBashDefaultTimeout(secs: number): void {
  _bashDefaultTimeout = secs;
}

// ── Tool result cache (LRU, TTL-based) ──────────────────────────────
const CACHE_TTL = 30_000;  // 30 seconds
const CACHE_MAX = 50;
const _resultCache = new Map<string, { result: unknown; timestamp: number }>();
const CACHEABLE_TOOLS = new Set(['Read', 'Glob', 'Grep', 'LS', 'Pwd', 'WorkspaceInfo', 'WorkspaceRead', 'WorkspaceList', 'CapabilityReport', 'AgentList', 'AgentRead', 'AgentPrompt', 'TeamPrompt']);

function getCachedResult(toolName: string, args: Record<string, unknown>): unknown | undefined {
  if (!CACHEABLE_TOOLS.has(toolName)) return undefined;
  const key = toolName + '\0' + JSON.stringify(args);
  const entry = _resultCache.get(key);
  if (!entry) return undefined;
  if (Date.now() - entry.timestamp > CACHE_TTL) {
    _resultCache.delete(key);
    return undefined;
  }
  return entry.result;
}

function setCachedResult(toolName: string, args: Record<string, unknown>, result: unknown): void {
  if (!CACHEABLE_TOOLS.has(toolName)) return;
  const key = toolName + '\0' + JSON.stringify(args);
  _resultCache.set(key, { result, timestamp: Date.now() });
  // Evict oldest entries if over limit
  if (_resultCache.size > CACHE_MAX) {
    const firstKey = _resultCache.keys().next().value;
    if (firstKey) _resultCache.delete(firstKey);
  }
}

/** Invalidate cache when any write/edit/bash operation happens */
function invalidateCache(): void {
  _resultCache.clear();
}

const WRITE_TOOLS = new Set([
  'Write',
  'Edit',
  'Bash',
  'NotebookEdit',
  'McpAddServer',
  'McpRemoveServer',
  'McpReloadServers',
  'WorkspaceSetPath',
  'WorkspaceWrite',
  'AgentCreate',
]);

// ── Concurrency control ─────────────────────────────────────────────
// Enforces mutual exclusion: non-concurrent tools get exclusive access,
// concurrent-safe tools run in parallel only with other safe tools.
let _activeConcurrentCount = 0;
let _exclusiveLock: Promise<void> | null = null;
let _exclusiveRelease: (() => void) | null = null;
const _waitQueue: Array<() => void> = [];

async function acquireToolLock(toolName: string): Promise<void> {
  const def = toolDefinitions.find(d => d.name === toolName);
  const isSafe = def?.isConcurrencySafe ?? false;

  if (isSafe) {
    // Wait if an exclusive (non-safe) tool is running
    while (_exclusiveLock) {
      await _exclusiveLock;
    }
    _activeConcurrentCount++;
  } else {
    // Wait for all concurrent tools to finish
    while (_activeConcurrentCount > 0 || _exclusiveLock) {
      if (_exclusiveLock) {
        await _exclusiveLock;
      } else {
        await new Promise<void>(r => _waitQueue.push(r));
      }
    }
    // Acquire exclusive lock
    _exclusiveLock = new Promise<void>(resolve => {
      _exclusiveRelease = resolve;
    });
  }
}

function releaseToolLock(toolName: string): void {
  const def = toolDefinitions.find(d => d.name === toolName);
  const isSafe = def?.isConcurrencySafe ?? false;

  if (isSafe) {
    _activeConcurrentCount--;
    // Wake up any exclusive waiters
    if (_activeConcurrentCount === 0 && _waitQueue.length > 0) {
      const next = _waitQueue.shift();
      next?.();
    }
  } else {
    // Release exclusive lock
    _exclusiveLock = null;
    _exclusiveRelease?.();
    _exclusiveRelease = null;
    // Wake up all waiters
    while (_waitQueue.length > 0) {
      _waitQueue.shift()?.();
    }
  }
}

/**
 * Whether oversized output is kept rather than discarded.
 *
 * On unless explicitly disabled. The old behaviour is strictly worse — it
 * destroyed 11 MB of output across this installation's own logs — so the
 * switch exists for a read-only workspace, not as a preference.
 */
let spillOn = true;
export function setSpillEnabled(on: boolean): void { spillOn = on; }
export function spillEnabled(): boolean { return spillOn; }

/** Truncate tool result to maxResultSizeChars, returning truncation notice */
export function truncateResult(result: unknown, maxChars: number): unknown {
  if (typeof result === 'string') {
    if (result.length > maxChars) {
      const removedKB = Math.round((result.length - maxChars) / 1024);
      return result.slice(0, maxChars) + `\n\n... [output truncated - ${removedKB}KB removed]`;
    }
    return result;
  }
  if (result && typeof result === 'object') {
    const str = JSON.stringify(result);
    if (str.length > maxChars) {
      // For objects, try to truncate string fields
      const copy = { ...result } as Record<string, unknown>;
      for (const [key, val] of Object.entries(copy)) {
        if (typeof val === 'string' && val.length > maxChars / 2) {
          const removedKB = Math.round((val.length - maxChars / 2) / 1024);
          copy[key] = val.slice(0, maxChars / 2) + `\n... [${key} truncated - ${removedKB}KB removed]`;
        }
      }
      return copy;
    }
  }
  return result;
}

export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  /** The dispatching call's id, so a spilled file can be traced back to it. */
  callId?: string,
  /**
   * The run's abort signal.
   *
   * Threaded so a long-running tool can stop when the user does. Without it
   * cancellation only ends the *loop*, and the turn stays busy until the
   * in-flight command finishes on its own — which for an install is minutes.
   */
  runSignal?: AbortSignal,
): Promise<unknown> {
  // Check cache for read-only tools
  const cached = getCachedResult(name, args);
  if (cached !== undefined) return cached;

  // Invalidate cache if this is a write operation
  if (WRITE_TOOLS.has(name)) invalidateCache();

  // Acquire concurrency lock
  await acquireToolLock(name);

  let result: unknown;
  try {
  // Every dispatch, not just the ones known to be slow. A tool that never
  // returns is a turn that never ends, and the loop cannot tell the difference
  // between slow and stuck from the outside — the only place that can impose an
  // answer is here, where the waiting happens. Covers tools not written yet.
  await withTimeout(name, async (signal) => {
  switch (name) {
    case 'Bash':
      result = await bash(
        { ...(args as unknown as Parameters<typeof bash>[0]), _defaultTimeout: _bashDefaultTimeout },
        signal,
      );
      break;
    case 'Terminal':
      result = await terminal(args as unknown as Parameters<typeof terminal>[0]);
      break;
    case 'Read':
      result = await readFile(args as unknown as Parameters<typeof readFile>[0]);
      observe(String((args as Record<string, unknown>).file_path ?? ''));
      break;
    // Declared in toolDefinitions but never dispatched, which is the worst of
    // the three possible states: the model is offered the tool, calls it, and
    // is told the tool does not exist.
    case 'ReadAttachment':
      result = await readAttachment(args as unknown as Parameters<typeof readAttachment>[0]);
      observe(String((args as Record<string, unknown>).file_path ?? ''));
      break;
    case 'Write': {
      // Enforced here rather than asked for in the prompt. A prompt rule holds
      // until the model is confident, and a model writing from memory is
      // confident by definition — it has stopped considering the question.
      const target = String((args as Record<string, unknown>).file_path ?? '');
      const blocked = target ? blockedReason(target, 'overwrite') : undefined;
      if (blocked) throw new Error(blocked);
      result = await writeFile(args as unknown as Parameters<typeof writeFile>[0]);
      // Writing a file is the most direct way of knowing what is in it.
      observe(target);
      // Noted here rather than reconstructed at the end of the turn: by then a
      // directory listing cannot distinguish what this turn built from what was
      // already sitting there.
      noteFileWritten(target);
      noteSourceChanged(target);
      break;
    }
    case 'Edit': {
      const target = String((args as Record<string, unknown>).file_path ?? '');
      const blocked = target ? blockedReason(target, 'edit') : undefined;
      if (blocked) throw new Error(blocked);
      result = await editFile(args as unknown as Parameters<typeof editFile>[0]);
      observe(target);
      noteFileWritten(target);
      noteSourceChanged(target);
      break;
    }
    case 'Glob':
      result = await globFiles(args as unknown as Parameters<typeof globFiles>[0]);
      break;
    case 'Grep':
      result = await grepFiles(args as unknown as Parameters<typeof grepFiles>[0]);
      break;
    case 'LS':
      result = await listDirectory(args as unknown as Parameters<typeof listDirectory>[0]);
      break;
    case 'VerifyApp': {
      const verdict = await verifyApp(args as unknown as Parameters<typeof verifyApp>[0]);
      // Recorded as well as returned. The model reads the text; the completion
      // gate reads the verdict, and a turn cannot end `completed` on a failing
      // one — which is the whole reason this tool is not merely advisory.
      recordVerification(verdict, (args as { checks?: { name: string }[] }).checks?.map(c => c.name) ?? []);
      result = formatVerdict(verdict);
      break;
    }
    case 'WebFetch':
      result = await webFetch(args as unknown as Parameters<typeof webFetch>[0]);
      break;
    case 'WebSearch':
      result = await webSearch(args as unknown as Parameters<typeof webSearch>[0]);
      break;
    case 'NotebookEdit':
      result = await notebookEdit(args as unknown as Parameters<typeof notebookEdit>[0]);
      break;
    case 'Skill':
      result = await useSkill(args as unknown as Parameters<typeof useSkill>[0]);
      break;
    case 'RunChecks':
      result = await runChecks(args as unknown as Parameters<typeof runChecks>[0]);
      break;
    case 'CodebaseMap':
      result = await codeMap(args as unknown as Parameters<typeof codeMap>[0]);
      break;
    case 'Git':
      result = await gitTool(args as unknown as Parameters<typeof gitTool>[0]);
      break;
    case 'Knowledge':
      result = await knowledgeTool(args as unknown as Parameters<typeof knowledgeTool>[0]);
      break;
    case 'Checkpoint':
      result = await checkpointTool(args as unknown as Parameters<typeof checkpointTool>[0]);
      break;
    case 'ProposePlan':
      result = await proposePlan(args as unknown as Parameters<typeof proposePlan>[0]);
      break;
    case 'TodoRead':
      result = await todoRead();
      break;
    case 'TodoWrite':
      result = await todoWrite(args as unknown as Parameters<typeof todoWrite>[0]);
      break;
    case 'AskUserQuestion':
      result = await askUser(args as unknown as Parameters<typeof askUser>[0]);
      break;
    case 'Pwd':
      result = await getWorkingDirectory(args as unknown as Parameters<typeof getWorkingDirectory>[0]);
      break;
    // ── New feature tools ─────────────────────────────────────────
    case 'BackgroundTask': {
      const bgArgs = args as { description: string; prompt: string; model?: string };
      const bgOpts = getBackgroundAgentOpts();
      if (!bgOpts) throw new Error('BackgroundTask: runtime options not initialized. Ensure startREPL() has been called.');
      result = { agentId: spawnBackgroundAgent(bgArgs, bgOpts), status: 'spawned' };
      break;
    }
    case 'PushNotification':
      result = executePushNotification(args as { title: string; body: string; level?: 'info' | 'success' | 'warning' | 'error' });
      break;
    case 'ListMcpResources':
      result = await executeListMcpResources(args as { server_name?: string });
      break;
    case 'ReadMcpResource':
      result = await executeReadMcpResource(args as { server_name: string; uri: string });
      break;
    case 'McpAddServer':
      result = await addMcpServer(args as {
        name: string;
        preset?: 'playwright';
        type?: 'stdio' | 'http' | 'sse';
        command?: string;
        args?: string[];
        url?: string;
        env?: Record<string, string>;
        headers?: Record<string, string>;
      });
      break;
    case 'McpRemoveServer':
      result = await removeMcpServer((args as { name: string }).name);
      break;
    case 'McpReloadServers':
      result = await reloadMcpServers();
      break;
    case 'EnterWorktree':
      result = await executeEnterWorktree(args as { agent_id: string; cwd?: string });
      break;
    case 'ExitWorktree':
      result = await executeExitWorktree(args as { worktree_id: string; keep_branch?: boolean });
      break;
    case 'CronCreate':
      result = await executeCronCreate(args as { name: string; schedule: string; prompt: string; model?: string; cwd?: string });
      break;
    case 'CronDelete':
      result = await executeCronDelete(args as { job_id: string });
      break;
    case 'CronList':
      result = executeCronList();
      break;
    case 'CronPause':
      result = await executeCronPause(args as { job_id: string });
      break;
    case 'CronResume':
      result = await executeCronResume(args as { job_id: string });
      break;
    case 'WorkspaceInfo':
      result = await executeWorkspaceInfo();
      break;
    case 'WorkspaceSetPath':
      result = await executeWorkspaceSetPath(args as { path?: string });
      break;
    case 'WorkspaceWrite':
      result = await executeWorkspaceWrite(args as { path: string; content: string; scope?: 'session' | 'common' });
      break;
    case 'WorkspaceRead':
      result = await executeWorkspaceRead(args as { path: string; scope?: 'session' | 'common' });
      break;
    case 'WorkspaceList':
      result = await executeWorkspaceList(args as { path?: string; scope?: 'session' | 'common' });
      break;
    case 'CapabilityReport':
      {
        const runtime = getWorkspaceRuntime();
        result = buildCapabilityReport({
          sessionId: runtime.sessionId,
          settings: runtime.settings,
          cwd: currentCwd(),
          tools: toolDefinitions.map((t) => ({ name: t.name, description: t.description })),
          mcpServers: mcpRegistry.getServerInfos(),
          workspace: getWorkspaceInfo(),
          agents: await listAgentSpecs(),
          skills: skillRegistry.list(),
          cronJobs: cronScheduler.getJobs(),
          backgroundAgents: getBackgroundAgents(),
          subAgents: getAgentRegistry(),
        });
      }
      break;
    case 'AgentCreate':
      result = await executeAgentCreate(args as unknown as Parameters<typeof executeAgentCreate>[0]);
      break;
    case 'AgentList':
      result = await executeAgentList();
      break;
    case 'AgentRead':
      result = await executeAgentRead(args as { name: string });
      break;
    case 'AgentPrompt':
      result = await executeAgentPrompt(args as { name: string; task: string });
      break;
    case 'TeamPrompt':
      result = await executeTeamPrompt(args as { requirements: string; agents?: string[] });
      break;
    case 'MemoryManage':
      result = await executeMemoryManage(args as unknown as MemoryManageInput);
      break;
    case 'McpManage':
      result = await executeMcpManage(args as unknown as McpManageInput);
      break;
    case 'AgentManage':
      result = await executeAgentManage(args as unknown as AgentManageInput);
      break;
    case 'SkillManage':
      result = await executeSkillManage(args as unknown as SkillManageInput);
      break;
    case 'SkillCreate':
      result = await executeSkillCreate(args as {
        name: string; description: string; prompt: string;
        aliases?: string[]; trigger?: string; scope?: 'user' | 'project';
        allowedTools?: string[]; resources?: Array<{ path: string; content: string }>;
      });
      break;
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
  }, runSignal);
  } finally {
    releaseToolLock(name);
  }

  // Bound the result to the tool's budget, keeping whatever did not fit.
  // `spillResult` writes the overflow to the session workspace and hands the
  // model an excerpt plus the path; it falls back to plain truncation when the
  // workspace cannot be written, so this can never fail a tool call.
  const def = toolDefinitions.find(d => d.name === name);
  if (def?.maxResultSizeChars) {
    result = spillEnabled()
      ? spillResult(result, def.maxResultSizeChars, name, callId)
      : truncateResult(result, def.maxResultSizeChars);
  }

  // Cache read-only tool results
  setCachedResult(name, args, result);

  return result;
}
