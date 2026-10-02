/**
 * Tool groups that are offered on demand rather than on every request.
 *
 * ## Why
 *
 * Measured on 2026-10-01: a depth-0 request carried 72 tool schemas worth
 * ~19.9K tokens beside a ~4.3K-token system prompt. The vault, the remote-ops
 * tools, the agent/skill/MCP registries, cron, the world lookups and a handful
 * of session utilities were ~10K of that, and a coding turn calls none of them.
 * That text is paid on every request of every session — cached, but cached
 * is still 2–10% of list price per step, uncached on every first request, and
 * in full for every sub-agent that inherits the whole set. On a 32K local
 * model it was a third of the window before the user said anything.
 *
 * ## How
 *
 * A group's schemas are left out until something loads it. `LoadTools` names
 * the groups and what is in each, in one short description, so the model can
 * see that a tool exists without paying for its schema. Loading is **sticky
 * and derived from the log**: a group is loaded for this session once any
 * `tool/call` event loaded it — a `LoadTools` call naming it, a call to one of
 * its tools, or one of the auto-load rules below. No new event type, nothing
 * to migrate, and the same answer on every turn, so the tool list does not
 * flap.
 *
 * ## Cache
 *
 * Tools render first in every provider's prefix, so loading a group costs one
 * prefix miss — once per group per session, never per step. The list is always
 * rebuilt in one canonical order (the order of `toolDefinitions`), so the
 * request after a turn boundary matches the one before it byte for byte.
 *
 * ## What it deliberately does not do
 *
 * - Defer anything an ordinary coding turn uses (files, shell, search, git,
 *   checks, todos, plans, delegation, memory, canvas, supervision). A tool the
 *   model would load on most turns costs more as a load than as a schema.
 * - Hide a tool from its dispatcher. Handlers exist for every tool; only the
 *   schemas are withheld. A model that calls a deferred tool by name (it has
 *   seen the name in `LoadTools`) is served, and the group is loaded from
 *   then on.
 * - Apply to an explicit tool whitelist (an agent type's set, an agent spec's
 *   array, a composed registry). Someone chose those tools by name.
 *
 * ## MCP servers
 *
 * Each MCP server (not the desktop host's own, and not one whose settings say
 * `alwaysLoad: true`) is a group too, `mcp:<server>`, passed in as `extra`
 * like a pack. Its `LoadTools` line is the server's configured name and tool
 * count — never the server's own self-description, which is untrusted text —
 * so five servers cost five short lines until one is needed (design §5.3).
 *
 * ## Custom tool packs
 *
 * Each pack of custom tools (custom-tools/store.ts) is a group too, with the
 * id `tools:<pack>`, passed in as `extra` by the run that loaded them — the
 * set depends on the run's project, so it cannot be a constant here. A pack
 * costs one line in the `LoadTools` description until it is loaded. A loaded
 * `tools:` id is kept from the log even when the pack is gone (it then loads
 * nothing), so the rule stays "derived from the log" without knowing which
 * packs exist.
 *
 * @module tools/deferred
 */

import type { SessionEvent } from '../session/events.js';

/** One on-demand group. */
export interface ToolGroup {
  id: string;
  /** What the group is for, in the words a request would use. */
  summary: string;
  tools: readonly string[];
  /**
   * Name the group by its summary alone, without listing its tools. For MCP
   * servers: a server's tool names are its own text, and listing thirty of them
   * on every request is the cost deferral exists to remove.
   */
  unlisted?: boolean;
}

/**
 * The groups, in a fixed order.
 *
 * Membership is the decision; the summary is what the model reads to make
 * it. Every tool named here must exist in `toolDefinitions` — the harness
 * checks, so a rename cannot leave a group pointing at nothing.
 */
export const TOOL_GROUPS: readonly ToolGroup[] = [
  {
    id: 'remote',
    summary: 'servers, devices and HTTP APIs with stored credentials',
    tools: ['SshExec', 'SshCopy', 'SshTunnel', 'HttpRequest', 'WinRmExec', 'SnmpQuery'],
  },
  {
    id: 'credentials',
    summary: 'list, request or generate stored secrets (used as {{secret:name}}, never by value)',
    tools: ['CredentialList', 'CredentialRequest', 'CredentialGenerate'],
  },
  {
    id: 'registry',
    summary: 'create or manage durable agents, skills, custom tools and MCP servers; MCP resources',
    tools: [
      'AgentCreate', 'AgentList', 'AgentRead', 'AgentPrompt', 'AgentManage',
      'SkillCreate', 'SkillManage', 'ToolManage',
      'McpManage', 'McpAddServer', 'McpRemoveServer', 'McpReloadServers',
      'ListMcpResources', 'ReadMcpResource',
    ],
  },
  {
    id: 'schedule',
    summary: 'recurring or scheduled prompts (cron)',
    tools: ['CronCreate', 'CronDelete', 'CronList', 'CronPause', 'CronResume'],
  },
  {
    id: 'world',
    summary: 'live weather, places/maps, exchange rates, sports scores',
    tools: ['Weather', 'Places', 'CurrencyRates', 'SportsScores'],
  },
  {
    id: 'image',
    summary: 'generate pictures (spends the user\'s money)',
    tools: ['GenerateImage'],
  },
  {
    id: 'audit',
    summary: 'dependency vulnerabilities and licences',
    tools: ['DependencyAudit'],
  },
  {
    id: 'background',
    summary: 'background agents, desktop notifications, manual git worktrees',
    tools: ['BackgroundTask', 'PushNotification', 'EnterWorktree', 'ExitWorktree'],
  },
  {
    id: 'session',
    summary: 'context-window settings, capability report, workspace location',
    tools: ['ContextWindow', 'CapabilityReport', 'WorkspaceSetPath'],
  },
];

export const LOAD_TOOLS = 'LoadTools';

const GROUP_OF = new Map<string, string>();
for (const group of TOOL_GROUPS) for (const tool of group.tools) GROUP_OF.set(tool, group.id);

/** The group a tool belongs to, or undefined for an always-offered tool. */
export function groupOf(tool: string): string | undefined {
  return GROUP_OF.get(tool);
}

/**
 * Groups a procedure is known to need, loaded when it is opened.
 *
 * Kept to the one documented flow that needs a group: the server-ops skill is
 * nothing but the remote and credential tools, and making it spend a step
 * loading them would be the mechanism getting in the way of its own purpose.
 */
const SKILL_LOADS: Record<string, readonly string[]> = {
  'server-ops': ['remote', 'credentials'],
};

/** A custom tool pack's group id. */
export const CUSTOM_GROUP_RE = /^tools:[a-z0-9][a-z0-9-]{0,39}$/;

/** An MCP server's group id (`mcp:<server>`; server names are `[A-Za-z0-9_-]`). */
export const MCP_GROUP_RE = /^mcp:[A-Za-z0-9_-]{1,64}$/;

/** Groups one tool call loads, if any. Pure; the caller accumulates. */
export function groupsLoadedBy(name: string, input: Record<string, unknown> | undefined, extra: readonly ToolGroup[] = []): string[] {
  if (name === LOAD_TOOLS) {
    const raw = input?.groups;
    const names = Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : [];
    return names.map(String).filter(g => TOOL_GROUPS.some(t => t.id === g) || CUSTOM_GROUP_RE.test(g) || MCP_GROUP_RE.test(g));
  }
  if (name === 'Skill') return [...(SKILL_LOADS[String(input?.name ?? '')] ?? [])];
  const own = groupOf(name) ?? extra.find(g => g.tools.includes(name))?.id;
  return own ? [own] : [];
}

/**
 * Every group this session has loaded, read from its log.
 *
 * Reads `tool/call` events only, and parses their arguments defensively: a
 * malformed call in an old log must not stop the next turn from starting.
 */
export function loadedGroupsFromLog(events: readonly SessionEvent[] | undefined, extra: readonly ToolGroup[] = []): Set<string> {
  const loaded = new Set<string>();
  for (const event of events ?? []) {
    if (event.type !== 'tool/call') continue;
    const data = event.data as { name?: string; arguments?: string };
    if (!data.name) continue;
    let input: Record<string, unknown> | undefined;
    if (data.name === LOAD_TOOLS || data.name === 'Skill') {
      try { input = JSON.parse(data.arguments ?? '{}') as Record<string, unknown>; } catch { input = undefined; }
    }
    for (const g of groupsLoadedBy(data.name, input, extra)) loaded.add(g);
  }
  return loaded;
}

/** Whether a tool's schema is withheld given what is loaded. */
export function isDeferred(tool: string, loaded: ReadonlySet<string>): boolean {
  const group = groupOf(tool);
  return group !== undefined && !loaded.has(group);
}

/**
 * The `LoadTools` schema for the groups still unloaded among `available`.
 *
 * Generated rather than written out, so the description can only list groups
 * that would actually load something in this run — a group whose every tool
 * is disabled, or absent from this agent's set, is not mentioned at all.
 * Undefined when nothing is left to load, in which case the tool is not
 * offered.
 */
export function loadToolsDefinition(available: ReadonlySet<string>, loaded: ReadonlySet<string>, extra: readonly ToolGroup[] = []) {
  const offered = [...TOOL_GROUPS, ...extra]
    .filter(g => !loaded.has(g.id))
    .map(g => ({ ...g, tools: g.tools.filter(t => available.has(t)) }))
    .filter(g => g.tools.length > 0);
  if (offered.length === 0) return undefined;
  return {
    name: LOAD_TOOLS,
    description: [
      'Load tool groups that are not offered by default. A loaded group stays loaded for the rest of the session; its tools are callable from your next step. Load only what the request needs.',
      ...offered.map(g => g.unlisted ? `- ${g.id}: ${g.summary}` : `- ${g.id}: ${g.summary} — ${g.tools.join(', ')}`),
    ].join('\n'),
    inputSchema: {
      type: 'object',
      properties: {
        groups: { type: 'array', items: { type: 'string', enum: offered.map(g => g.id) } },
      },
      required: ['groups'],
    },
  };
}

/** What a `LoadTools` call answers. The loading itself is read from the call. */
export function executeLoadTools(input: { groups?: unknown }, extra: readonly ToolGroup[] = []): string {
  const all = [...TOOL_GROUPS, ...extra];
  const raw = Array.isArray(input.groups) ? input.groups.map(String) : [];
  const known = raw.filter(g => all.some(t => t.id === g));
  const unknown = raw.filter(g => !known.includes(g));
  if (known.length === 0) {
    return `No such group${unknown.length === 1 ? '' : 's'}: ${unknown.join(', ') || '(none given)'}. `
      + `Groups: ${all.map(g => g.id).join(', ')}.`;
  }
  const lines = known.map(id => `${id}: ${all.find(g => g.id === id)!.tools.join(', ')}`);
  return `Loaded — callable from your next step:\n${lines.join('\n')}`
    + (unknown.length ? `\nIgnored unknown: ${unknown.join(', ')}.` : '');
}
