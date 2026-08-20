import { readFile, writeFile, mkdir } from 'fs/promises';
import path from 'path';
import os from 'os';
import type { McpServerConfig } from './mcp.js';

import type { ProviderInstance } from './providers/instances.js';

export interface AicoSettings {
  model?: string;

  /**
   * Active AI provider.
   * Auto-detected from model name / available API keys when omitted.
   * Explicit values: 'openrouter' | 'anthropic' | 'openai' | 'gemini' | 'ollama'
   */
  provider?: string;

  /**
   * Configured provider instances.
   *
   * Supersedes the vendor-keyed `providers` map below, which could hold only
   * one configuration per vendor and had no way to express a provider that
   * merely speaks the OpenAI protocol. Both are read: when this is absent or
   * incomplete, instances are derived from `providers` and the environment, so
   * an existing installation keeps working untouched.
   *
   * @see providers/instances
   */
  providerInstances?: ProviderInstance[];

  /** Id of the provider instance turns run on by default. */
  activeProvider?: string;

  /**
   * Per-provider configuration (API keys, base URLs, default models).
   * API keys here override the corresponding environment variables.
   *
   * @deprecated Prefer {@link AicoSettings.providerInstances}. Still read for
   * compatibility, and still the place vendor-specific tuning lives.
   */
  providers?: {
    openrouter?: { apiKey?: string; defaultModel?: string };
    anthropic?: {
      apiKey?: string;
      defaultModel?: string;
      /**
       * Adaptive thinking on Claude 4.6+ models. Default: 'adaptive'.
       * 'off' sends `{type:'disabled'}`. Older models never receive the
       * parameter either way — they use the retired `budget_tokens` form.
       */
      thinking?: 'adaptive' | 'off';
      /** `output_config.effort`. Default: unset (the API's own default, 'high'). */
      effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
      /**
       * Output ceiling. Caps thinking AND response text together, so a value
       * tuned for a non-thinking model can truncate the answer. Default: 32000.
       */
      maxTokens?: number;
    };
    openai?: {
      apiKey?: string;
      baseUrl?: string;
      defaultModel?: string;
      /**
       * Reasoning effort for models driven through the Responses API
       * (gpt-5.6+). 'none' disables reasoning. Default: 'low'.
       */
      reasoningEffort?: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
      /**
       * Output-token ceiling for the Responses API. Reasoning tokens are drawn
       * from the same budget as visible output, so this is set well above the
       * Chat Completions default. Default: 32000.
       */
      maxOutputTokens?: number;
    };
    gemini?:     { apiKey?: string; defaultModel?: string };
    deepseek?: {
      apiKey?: string;
      baseUrl?: string;
      defaultModel?: string;
      /**
       * Thinking depth. DeepSeek's own default is `high`; `off` sends
       * `thinking: {type:'disabled'}`. Note that thinking mode rejects
       * temperature/top_p, which AICO never sends anyway.
       */
      thinking?: 'low' | 'high' | 'max' | 'off';
      /**
       * Output-token ceiling. Reasoning tokens are drawn from the same budget
       * as visible output, so a cap sized for a non-reasoning model can leave
       * no room to answer. Default: 32000 (the platform allows up to 384K).
       */
      maxOutputTokens?: number;
    };
    zai?:        { apiKey?: string; baseUrl?: string; defaultModel?: string; useCodingEndpoint?: boolean };
    ollama?:     { baseUrl?: string; defaultModel?: string };
  };

  /** Automatic session naming. */
  sessionTitles?: {
    /** Off keeps the deterministic first-prompt title and makes no model call. */
    enabled?: boolean;
    /** Override the naming model. Defaults to the cheapest in the same family. */
    model?: string;
  };

  autoApprove?: boolean;
  /**
   * Agent timeout in milliseconds.
   * 0 = no timeout (unlimited).
   * Default: 0 (unlimited — let the agent finish naturally).
   */
  agentTimeout?: number;
  /**
   * Default bash command timeout in seconds.
   * 0 = no timeout. Default: 120 (2 min).
   */
  bashTimeout?: number;
  hooks?: {
    PreToolUse?: string[];
    PostToolUse?: string[];
    UserPromptSubmit?: string[];
    Stop?: string[];
    SessionStart?: string[];
    PreCompact?: string[];
    PostCompact?: string[];
    SubagentStart?: string[];
    SubagentStop?: string[];
    BackgroundAgentStart?: string[];
    BackgroundAgentComplete?: string[];
    BackgroundAgentFailed?: string[];
    CronJobStart?: string[];
    CronJobComplete?: string[];
    CronJobFailed?: string[];
    SessionEnd?: string[];
    Notification?: string[];
  };
  env?: Record<string, string>;
  mcpServers?: Record<string, McpServerConfig>;
  /** Project/session workspace used for artifacts, reports, logs, and scratch files. */
  workspace?: {
    /** Absolute path or project-relative path. Default: ~/.aico/workspace/projects/<project>. */
    path?: string;
  };
  /**
   * Directories the browser client offers to work in.
   *
   * A *project* is a directory you point AICO at; sessions already live under
   * `~/.aico/projects/<hash>/sessions/` keyed by exactly this path, so adding
   * one here does not move anything — it makes an existing grouping reachable
   * from the client. The directory the server was launched in is always
   * available whether or not it is listed.
   *
   * Deliberately not called "workspaces", which in this codebase already means
   * the scratch area artifacts are written to (see {@link AicoSettings.workspace}).
   * Two meanings for one word across the settings screen and the sidebar would
   * be worse than an unfamiliar label.
   */
  projects?: Array<{
    /** Absolute path. The identity — two entries cannot share one. */
    path: string;
    /** What to call it. Defaults to the directory's own name. */
    name?: string;
    addedAt?: number;
    /** Kept at the top of the list, above recency. */
    pinned?: boolean;
    /** Swatch tinting the folder icon. A hex string from the client palette. */
    color?: string;
    /** A note to yourself about what this folder is. Never sent to the model. */
    description?: string;
    /**
     * Instructions every session in this folder must follow.
     *
     * Sent to the model at the *end* of the system prompt, after the general
     * behaviour rules, because later instructions win when two conflict and
     * these are the ones the user chose for this specific project. They are
     * repeated in the tail on dialects whose vendors ask for that, for the
     * same reason.
     *
     * Distinct from AICO.md, which is a file in the repository and is shared
     * with anyone who clones it. This is per-machine and per-person: "always
     * run the linter before you tell me you are done" is a working agreement,
     * not a project fact.
     */
    instructions?: string;
  }>;
  /**
   * Containers you make, as opposed to the ones the filesystem made for you.
   *
   * A group never replaces a session's working directory — an agent has to run
   * somewhere — so membership only changes where a session appears in the list.
   * That is what lets one group hold sessions from several projects, which is
   * the only version of this worth having: if a group were just another folder,
   * the folders would already do it.
   *
   * @see server/groups
   */
  groups?: Array<{
    id: string;
    name: string;
    color?: string;
    description?: string;
    /** Instructions every session in this group follows. */
    instructions?: string;
    pinned?: boolean;
    /** Working directory for sessions started from this group. */
    cwd?: string;
    createdAt?: number;
  }>;
  /** Automatic context compaction before the conversation gets too large. */
  autoCompact?: {
    enabled?: boolean;
    /** Absolute token threshold. Default: auto-calculated as 75% of model context window. */
    thresholdTokens?: number;
    /**
     * Percentage of context window that triggers compaction (0-100).
     * Overrides thresholdTokens when set. Default: 75 (compact at 75% of context).
     * Dynamically adapts to each model's actual context limit.
     */
    thresholdPercent?: number;
    keepRecentTurns?: number;
  };
  /** MCP security posture controls and trust metadata. */
  mcpSecurity?: {
    trustedServers?: string[];
    allowedCommands?: string[];
    warnUntrusted?: boolean;
  };
  /**
   * Talking to a specialist directly, rather than only through the orchestrator.
   *
   * A master switch for the whole idea. Off, sessions always run as the
   * orchestrator and the picker and `@` menu are hidden — because a control
   * that is visible but inert is worse than one that is absent.
   */
  agents?: {
    directChat?: boolean;
  };

  /** Extra skill directories and options */
  skills?: {
    dirs?: string[];
    disableBuiltins?: boolean;
  };
  /** Memory caching configuration */
  memory?: {
    cacheTtl?: number;          // seconds (default: 60)
    maxSizePerType?: number;    // chars per type section (default: 50_000)
    watchFiles?: boolean;       // fs.watch invalidation (default: true)
  };
  /** Cron/scheduling configuration */
  cron?: {
    enabled?: boolean;          // master switch (default: true)
    maxConcurrentJobs?: number; // default: 3
  };
  /**
   * Prompt caching. On by default — the system prompt and tool definitions are
   * the largest static content; caching them yields ~90% input-token savings on
   * repeat turns (Anthropic) and surfaces cache hits from automatic server-side
   * caching (OpenAI/OpenRouter/Gemini). Set enabled: false to disable.
   */
  promptCaching?: {
    enabled?: boolean;          // default: true
  };
  /** Terminal theme: 'dark' (default), 'light', or 'auto' */
  theme?: 'dark' | 'light' | 'auto';
  /**
   * Dynamic model context-window overrides. Map of model → max context tokens.
   * Populated automatically by runtime detection (first interaction queries
   * the provider's model-info endpoint) and persists permanently. Users can
   * also manually correct values here.
   *
   * Example: { "deepseek/deepseek-v4-flash": 1000000 }
   */
  contextWindows?: Record<string, number>;
  /**
   * Hard cap on agentic tool-calling iterations per run. A safety net against a
   * model that loops on tools indefinitely. Default: 100 (effectively unlimited
   * for real work; sub-agents handle decomposition so 100 is rarely reached).
   */
  maxIterations?: number;
  /**
   * Maximum parallel-safe tool calls in flight per step. `1` is fully serial.
   * Exclusive tools (Bash, Write, Edit) always run alone regardless.
   * Default: 8.
   */
  maxParallelToolCalls?: number;
  /**
   * Completion gate. When enabled (default), the agent loop checks for open
   * todos before accepting a text-only turn as "done". If open todos remain it
   * nudges the model to continue (up to 2 times) rather than stopping early.
   * Disable for sub-agents or when you want the model's stop signal to be final.
   */
  completionGate?: {
    enabled?: boolean;          // default: true
  };
  /**
   * Cost circuit breaker. Evaluated at the top of every step, so a breach stops
   * the agent *before* it pays for another model call and closes the turn as
   * `aborted`. Cumulative across the session, not per turn.
   *
   * Both are off unless set, because the right ceiling depends on your budget
   * and no default can be guessed honestly. For unattended runs set at least
   * one: a turn may make up to `maxIterations` (default 100) model calls, and
   * without a ceiling nothing bounds the spend of a model that loops.
   *
   * A rough starting point for interactive work is maxCostPerSession around
   * 5–10 USD; raise it rather than removing it.
   */
  safetyLimits?: {
    /** USD. Stop once the estimated cumulative cost exceeds this. */
    maxCostPerSession?: number;
    /** Stop once cumulative input+output tokens exceed this. */
    maxTokensPerSession?: number;
  };
  /**
   * Repeat-tool loop breaker. Advisory: it never blocks a call, it injects an
   * escalating reminder when the model repeats one verbatim. The completion
   * gate cannot catch this case — a looping model never tries to stop.
   */
  /**
   * File-effect confinement for the agent's own file tools.
   *
   * `workspace-write` confines Write/Edit/NotebookEdit to the workspace root
   * and the temp directory. `read-only` refuses writes outright.
   * `danger-full-access` (the default, preserving existing behaviour) applies
   * no confinement.
   *
   * Honest scope: this governs AICO's file tools completely and spawned
   * processes not at all — a Bash command can still write anywhere the user
   * can. It is defence in depth against a confused agent, not a jail.
   */
  sandbox?: {
    mode?: 'read-only' | 'workspace-write' | 'danger-full-access';
    /** Extra roots writes are permitted under, beyond the workspace and temp. */
    additionalWritableRoots?: string[];
    /** Warn when a tool's confinement is only partially enforced. Default: true. */
    warnOnPartial?: boolean;
  };
  repeatGuard?: {
    enabled?: boolean;              // default: true (root agents only)
    thresholds?: number[];          // default: [3, 5, 8]
    include?: string[];             // tool-name patterns to track; empty = all
    exclude?: string[];             // patterns transparent to the chain
    argumentsPreviewChars?: number; // default: 500 (bounds the reminder only)
  };
}

async function tryReadJson(filePath: string): Promise<AicoSettings> {
  try {
    const text = await readFile(filePath, 'utf8');
    return JSON.parse(text) as AicoSettings;
  } catch {
    return {};
  }
}

/**
 * Settings sections that merge key-by-key rather than being replaced wholesale.
 *
 * These are maps and option bags: a project file that sets one MCP server or one
 * safety limit means "add this", not "and discard everything configured
 * globally". Every other setting — scalars, arrays, and anything added later —
 * is replaced by the more specific layer, which is what "override" normally
 * means and what a reader expects.
 */
const MERGED_SECTIONS = [
  'providers', 'hooks', 'env', 'mcpServers', 'workspace', 'autoCompact',
  'mcpSecurity', 'skills', 'memory', 'cron', 'promptCaching', 'contextWindows',
  'completionGate', 'safetyLimits', 'repeatGuard', 'sandbox', 'sessionTitles',
] as const satisfies ReadonlyArray<keyof AicoSettings>;

/**
 * Merge one settings layer over another.
 *
 * Unknown keys are carried through. That is the whole point of the rewrite:
 * this used to be a hand-written allow-list that copied only the fields it had
 * been taught about, so every setting added afterwards was **silently dropped**
 * — written to disk, read back, merged away, and gone, with no warning
 * anywhere. `providerInstances` was configured, saved, and then invisible to
 * the running server, which is exactly how the bug was found.
 *
 * A pass-through default cannot fail that way. Adding a setting now requires
 * nothing here unless it needs section merging, and forgetting to list it
 * degrades to "replaced by the more specific layer" rather than "ignored".
 */
function deepMerge(base: AicoSettings, override: AicoSettings): AicoSettings {
  const result: AicoSettings = { ...base, ...override };

  for (const section of MERGED_SECTIONS) {
    const overrideValue = override[section];
    if (!overrideValue || typeof overrideValue !== 'object' || Array.isArray(overrideValue)) continue;
    const baseValue = base[section];
    (result as Record<string, unknown>)[section] = {
      ...(baseValue && typeof baseValue === 'object' && !Array.isArray(baseValue) ? baseValue : {}),
      ...overrideValue,
    };
  }

  return result;
}

const KNOWN_PROVIDERS = new Set(['openrouter', 'anthropic', 'openai', 'gemini', 'ollama']);

/** Validate settings and return warnings for bad values */
function validateSettings(s: AicoSettings): string[] {
  const warnings: string[] = [];
  if (s.bashTimeout !== undefined && (typeof s.bashTimeout !== 'number' || s.bashTimeout < 0)) {
    warnings.push(`bashTimeout must be a number >= 0 (got: ${JSON.stringify(s.bashTimeout)})`);
  }
  if (s.agentTimeout !== undefined && (typeof s.agentTimeout !== 'number' || s.agentTimeout < 0)) {
    warnings.push(`agentTimeout must be a number >= 0 (got: ${JSON.stringify(s.agentTimeout)})`);
  }
  if (s.model !== undefined && typeof s.model !== 'string') {
    warnings.push(`model must be a string (got: ${typeof s.model})`);
  }
  if (s.provider !== undefined && typeof s.provider === 'string' && !KNOWN_PROVIDERS.has(s.provider)) {
    warnings.push(
      `provider "${s.provider}" is not recognized. Known: openrouter, anthropic, openai, gemini, ollama. ` +
      `It will be ignored and the provider auto-detected.`,
    );
  }
  if (s.autoApprove !== undefined && typeof s.autoApprove !== 'boolean') {
    warnings.push(`autoApprove must be a boolean (got: ${typeof s.autoApprove})`);
  }
  if (s.hooks !== undefined && typeof s.hooks !== 'object') {
    warnings.push(`hooks must be an object`);
  }
  if (s.workspace?.path !== undefined && typeof s.workspace.path !== 'string') {
    warnings.push(`workspace.path must be a string (got: ${typeof s.workspace.path})`);
  }
  if (s.autoCompact?.thresholdTokens !== undefined && (
    typeof s.autoCompact.thresholdTokens !== 'number' || s.autoCompact.thresholdTokens < 1_000
  )) {
    warnings.push(`autoCompact.thresholdTokens must be a number >= 1000 (got: ${s.autoCompact.thresholdTokens})`);
  }
  if (s.autoCompact?.thresholdPercent !== undefined && (
    typeof s.autoCompact.thresholdPercent !== 'number' ||
    s.autoCompact.thresholdPercent < 1 || s.autoCompact.thresholdPercent > 100
  )) {
    warnings.push(`autoCompact.thresholdPercent must be a number 1-100 (got: ${s.autoCompact.thresholdPercent})`);
  }
  if (s.maxIterations !== undefined && (typeof s.maxIterations !== 'number' || s.maxIterations < 1)) {
    warnings.push(`maxIterations must be a number >= 1 (got: ${JSON.stringify(s.maxIterations)})`);
  }
  return warnings;
}

/**
 * Coerce numeric settings that failed validation into safe defaults. Prevents a
 * bad value (e.g. a string, NaN, or negative) from silently disabling a timeout
 * via setTimeout(..., NaN) or setBashDefaultTimeout(-1). Runs after validation
 * so the user still sees a warning for the original value.
 */
function normalizeNumericSettings(s: AicoSettings): void {
  const at = Number(s.agentTimeout);
  if (s.agentTimeout !== undefined && (!Number.isFinite(at) || at < 0)) {
    s.agentTimeout = 0; // 0 = unlimited (safe)
  }
  const bt = Number(s.bashTimeout);
  if (!Number.isFinite(bt) || bt < 0) {
    s.bashTimeout = 120; // 2 min default
  }
  const mi = Number(s.maxIterations);
  if (s.maxIterations !== undefined && (!Number.isFinite(mi) || mi < 1)) {
    delete s.maxIterations; // fall back to the default applied in agent.ts
  }
}

/** Tracks which settings file contributed each field */
export interface SettingsAudit {
  sources: Array<{ path: string; found: boolean; keys: string[] }>;
}

let _lastAudit: SettingsAudit | null = null;

/** Get the audit trail from the most recent loadSettings() call */
export function getSettingsAudit(): SettingsAudit | null {
  return _lastAudit;
}

export async function loadSettings(): Promise<AicoSettings> {
  const cwd = process.cwd();
  const globalPath = path.join(os.homedir(), '.aico', 'settings.json');
  const projectPath = path.join(cwd, '.aico', 'settings.json');
  const localPath = path.join(cwd, '.aico', 'settings.local.json');

  const defaults: AicoSettings = {};
  const global_ = await tryReadJson(globalPath);
  const project = await tryReadJson(projectPath);
  const local = await tryReadJson(localPath);

  // Build audit trail
  const { existsSync } = await import('fs');
  _lastAudit = {
    sources: [
      { path: globalPath, found: existsSync(globalPath), keys: Object.keys(global_) },
      { path: projectPath, found: existsSync(projectPath), keys: Object.keys(project) },
      { path: localPath, found: existsSync(localPath), keys: Object.keys(local) },
    ],
  };

  let merged = deepMerge(defaults, global_);
  merged = deepMerge(merged, project);
  merged = deepMerge(merged, local);

  // Validate and warn about bad settings, then coerce unfixable numeric values
  // to safe defaults so they can't silently disable timeouts downstream.
  const warnings = validateSettings(merged);
  for (const w of warnings) {
    console.warn(`  ⚠ Settings warning: ${w}`);
  }
  normalizeNumericSettings(merged);

  // Inject any env vars from settings into process.env
  if (merged.env) {
    for (const [k, v] of Object.entries(merged.env)) {
      process.env[k] = v;
    }
  }

  // Inject provider API keys from settings into process.env (so selectProvider sees them)
  const p = merged.providers;
  if (p?.openrouter?.apiKey && !process.env.OPENROUTER_API_KEY) process.env.OPENROUTER_API_KEY = p.openrouter.apiKey;
  if (p?.anthropic?.apiKey  && !process.env.ANTHROPIC_API_KEY)  process.env.ANTHROPIC_API_KEY  = p.anthropic.apiKey;
  if (p?.openai?.apiKey     && !process.env.OPENAI_API_KEY)     process.env.OPENAI_API_KEY     = p.openai.apiKey;
  if (p?.gemini?.apiKey     && !process.env.GEMINI_API_KEY)     process.env.GEMINI_API_KEY     = p.gemini.apiKey;
  if (p?.zai?.apiKey        && !process.env.ZAI_API_KEY)        process.env.ZAI_API_KEY        = p.zai.apiKey;

  return merged;
}

export async function saveUserSetting(key: string, value: unknown): Promise<void> {
  const dir = path.join(os.homedir(), '.aico');
  await mkdir(dir, { recursive: true });
  const filePath = path.join(dir, 'settings.json');
  let existing: Record<string, unknown> = {};
  try {
    const text = await readFile(filePath, 'utf8');
    existing = JSON.parse(text) as Record<string, unknown>;
  } catch {
    // no file yet
  }
  existing[key] = value;
  await writeFile(filePath, JSON.stringify(existing, null, 2));
}

export function getProjectLocalSettingsPath(cwd = process.cwd()): string {
  return path.join(cwd, '.aico', 'settings.local.json');
}

export async function saveProjectMcpServers(
  mcpServers: Record<string, McpServerConfig>,
  cwd = process.cwd(),
): Promise<void> {
  const filePath = getProjectLocalSettingsPath(cwd);
  await mkdir(path.dirname(filePath), { recursive: true });

  const existing = await tryReadJson(filePath);
  const updated: AicoSettings = {
    ...existing,
    mcpServers,
  };

  await writeFile(filePath, JSON.stringify(updated, null, 2));
}

export async function saveProjectWorkspacePath(
  workspacePath: string | undefined,
  cwd = process.cwd(),
): Promise<void> {
  const filePath = getProjectLocalSettingsPath(cwd);
  await mkdir(path.dirname(filePath), { recursive: true });

  const existing = await tryReadJson(filePath);
  const updated: AicoSettings = {
    ...existing,
    workspace: workspacePath ? { ...(existing.workspace ?? {}), path: workspacePath } : { path: '' },
  };

  await writeFile(filePath, JSON.stringify(updated, null, 2));
}

export async function saveProjectSettingsPatch(
  patch: AicoSettings,
  cwd = process.cwd(),
): Promise<AicoSettings> {
  const filePath = getProjectLocalSettingsPath(cwd);
  await mkdir(path.dirname(filePath), { recursive: true });

  const existing = await tryReadJson(filePath);
  const updated = deepMerge(existing, patch);
  await writeFile(filePath, JSON.stringify(updated, null, 2));
  return updated;
}
