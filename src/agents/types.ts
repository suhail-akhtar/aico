/** Autonomy ceiling an agent declares (design §4.2). The run's level is min(session, ceiling, parent). */
export type AutonomyLevel = 'L0' | 'L1' | 'L2' | 'L3' | 'L4';

/** Per-run spending limits. Each is optional; absent means the session's own limits only. */
export interface AgentBudget {
  maxUsd?: number;
  maxIterations?: number;
  maxMinutes?: number;
}

/**
 * Who an agent may hand work to. `none` removes Task/Investigate; `readonly`
 * lets it delegate, but every child is read-only; a list names the registered
 * agents it may delegate to (Investigate, which is read-only, stays).
 */
export type DelegateRule = 'none' | 'readonly' | string[];

export interface AgentSpec {
  name: string;
  description: string;
  role: string;
  goals: string[];
  skills: string[];
  tools: string[];
  canDelegate: boolean;
  reportFormat: string;
  systemPromptXml: string;
  source: 'builtin' | 'user' | 'project';
  /** Optional: pin this agent to a specific model (e.g. "glm-4.6", "claude-sonnet-5") */
  model?: string;
  /** The Markdown body: the agent's own instructions. Replaces role/goals when present. */
  instructions?: string;
  /** Tools removed after `tools` is applied (Claude Code's `disallowedTools`). */
  disallowedTools?: string[];
  /** MCP servers this agent uses: loaded eagerly, and the only servers its MCP tools may come from. */
  mcpServers?: string[];
  /** Replaces `canDelegate` in the `.md` format; `canDelegate` is derived from it. */
  delegate?: DelegateRule;
  autonomy?: AutonomyLevel;
  budget?: AgentBudget;
  /** Globs (relative to the run's directory) AICO's file tools may write. Bash is not bound. */
  paths?: { write?: string[] };
  /** Which file it was read from, `md` or legacy `json`. Absent for built-ins. */
  format?: 'md' | 'json';
  /** Problems found reading the file that did not stop it loading. */
  warnings?: string[];
}

export interface AgentCreateInput {
  name: string;
  description: string;
  role?: string;
  goals?: string[];
  skills?: string[];
  tools?: string[];
  canDelegate?: boolean;
  reportFormat?: string;
  scope?: 'user' | 'project';
  /** Optional: pin this agent to a specific model */
  model?: string;
  instructions?: string;
  disallowedTools?: string[];
  mcpServers?: string[];
  delegate?: DelegateRule;
  autonomy?: AutonomyLevel;
  budget?: AgentBudget;
  paths?: { write?: string[] };
}

/**
 * Everything a run enforces for one agent, resolved from its definition. One
 * value handed to the run (`AgentOptions.agentBounds`), whether a person is
 * talking to the agent or the orchestrator delegated to it, and the same value
 * the summary is computed from — so the three cannot disagree.
 */
export interface AgentBounds {
  name: string;
  /** Allow-list; undefined admits every tool. */
  tools?: string[];
  disallowedTools?: string[];
  mcpServers?: string[];
  delegate: DelegateRule;
  autonomy?: AutonomyLevel;
  budget?: AgentBudget;
  /** `paths.write` globs; undefined leaves AICO's file tools unbound. */
  writePaths?: string[];
}
