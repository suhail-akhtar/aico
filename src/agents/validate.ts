/**
 * The one validator for agent definitions (design §6.1 lint, §7.8 rules).
 *
 * Every save path calls it — `AgentManage create|update|import`, `AgentCreate`,
 * the Settings builders (through the engine, never in the client) — and refuses
 * on errors. Before Phase 3 an unknown tool name simply matched nothing, so a
 * typo produced an agent quietly less capable than its file said; a skill that
 * did not exist was the same silent gap. Now both are errors at save time,
 * each phrased as the fix.
 *
 * Errors block; warnings never do (Phase 1's rule for skills): a vague
 * description, a budget missing at L3, L4 (which needs a certificate), write
 * paths beside Bash (which they do not bind).
 *
 * What it checks against: the built-in tool table, custom tools visible from
 * the run's directory (any status — a draft tool is named correctly, it just
 * is not callable until a person enables it, which is a warning), MCP servers
 * in settings or connected, reviewed skills, registered agents.
 *
 * @module agents/validate
 */

import { isMcpEntry } from './effective.js';
import { writeGlobProblem } from './paths-guard.js';
import type { AgentCreateInput, AgentSpec } from './types.js';

export interface AgentValidation {
  errors: string[];
  warnings: string[];
}

/** What a definition is checked against. Loaded once per call by `validationContext`. */
export interface ValidationContext {
  builtinTools: ReadonlySet<string>;
  /** Custom tools by name, with whether a run may call them now. */
  customTools: ReadonlyMap<string, { enabled: boolean }>;
  mcpServers: ReadonlySet<string>;
  /** Whether a definition may name this skill (installed, reviewed, enabled). */
  hasSkill: (name: string) => boolean;
  agents: ReadonlySet<string>;
}

/** Tools governed by `delegate` rather than by name; always known. */
const DELEGATION = new Set(['Task', 'Investigate']);

export async function validationContext(cwd: string): Promise<ValidationContext> {
  const { toolDefinitions } = await import('../tools/index.js');
  const { loadCustomTools } = await import('../custom-tools/store.js');
  const { loadSettings } = await import('../settings.js');
  const { mcpRegistry } = await import('../mcp/registry.js');
  const { skillRegistry } = await import('../skills/index.js');
  const { isDisabled } = await import('../registry-state.js');
  const { listAgentSpecs } = await import('./registry.js');

  const custom = new Map<string, { enabled: boolean }>();
  for (const t of await loadCustomTools(cwd).catch(() => [])) {
    if (!custom.has(t.name)) custom.set(t.name, { enabled: t.status === 'enabled' });
  }
  const settings = await loadSettings().catch(() => ({} as Awaited<ReturnType<typeof loadSettings>>));
  const servers = new Set<string>([...Object.keys(settings.mcpServers ?? {}), ...mcpRegistry.serverNames()]);
  // Not reloaded here: the registry is loaded at startup with the settings'
  // extra directories, and reloading with none would drop them.
  await skillRegistry.ensureProject(cwd).catch(() => undefined);
  return {
    builtinTools: new Set([...toolDefinitions.map(t => t.name), ...DELEGATION]),
    customTools: custom,
    mcpServers: servers,
    hasSkill: (n: string) => {
      const skill = skillRegistry.lookup(n);
      return Boolean(skill) && !isDisabled('skills', skill!.frontmatter.name);
    },
    agents: new Set((await listAgentSpecs(cwd)).map(a => a.name)),
  };
}

/** Problems with one tool-list entry, or undefined when it names something real. */
export function toolEntryProblem(entry: string, field: string, ctx: ValidationContext, warnings: string[]): string | undefined {
  if (/^Bash\(.+\)$/.test(entry)) {
    return `${field}: "${entry}" — command-prefix narrowing is not supported yet; use "Bash" (any command) or leave it out`;
  }
  if (isMcpEntry(entry)) {
    if (entry === 'MCP') return undefined;
    const server = entry.startsWith('mcp:') ? entry.slice(4).split(':')[0]! : entry.slice(5).split('__')[0]!;
    if (!server) return `${field}: "${entry}" names no server — write mcp__<server>__* or mcp:<server>`;
    if (!ctx.mcpServers.has(server)) {
      return `${field}: "${entry}" — there is no MCP server called "${server}". Add it under Settings → MCP first, or remove the entry`;
    }
    return undefined;
  }
  const custom = entry.startsWith('custom:') ? entry.slice('custom:'.length) : undefined;
  const name = custom ?? entry;
  if (!custom && ctx.builtinTools.has(name)) return undefined;
  const tool = ctx.customTools.get(name);
  if (tool) {
    if (!tool.enabled) warnings.push(`${field}: custom tool "${name}" exists but is not enabled yet — the agent cannot call it until a person enables it in Settings → Tools.`);
    return undefined;
  }
  return custom
    ? `${field}: there is no custom tool called "${name}" — create it under Settings → Tools, or remove the entry`
    : `${field}: "${entry}" is not a tool AICO knows — check the spelling (names are case-sensitive, e.g. "Read", "Bash"), or write custom:<name> / mcp__<server>__<tool>`;
}

/** A definition as the forms and files give it: lists may still be strings. */
export type AgentDraftInput = Partial<AgentCreateInput & Pick<AgentSpec, 'role' | 'goals'>>;

/** Validate a definition. Pure given the context. */
export function validateAgentDef(def: AgentDraftInput, ctx: ValidationContext): AgentValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  const name = String(def.name ?? '').trim();

  if (!name) errors.push('name is required — lowercase letters, digits and dashes, e.g. "security-reviewer"');
  else if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(name)) {
    errors.push(`name "${name}" — use lowercase letters, digits, "-" and "_", starting with a letter or digit, at most 64 characters`);
  }

  const description = String(def.description ?? '').trim();
  if (!description) errors.push('description is required — it is what decides when this agent is handed a task ("Use for …")');
  else {
    if (description.length > 1024) errors.push(`description is ${description.length} characters; the limit is 1,024 — move detail into the instructions`);
    if (description.length < 25) warnings.push(`description is ${description.length} characters — say what work to hand it and when, so the orchestrator can choose it`);
    if (/^\s*I\b|\bI am\b|\bI will\b/.test(description)) warnings.push('description is in the first person — describe the agent ("Reviews …"), not "I …"');
  }

  for (const [field, list] of [['tools', def.tools], ['disallowedTools', def.disallowedTools]] as const) {
    for (const raw of list ?? []) {
      const entry = String(raw).trim();
      if (!entry) continue;
      const problem = toolEntryProblem(entry, field, ctx, warnings);
      if (problem) errors.push(problem);
    }
  }
  if ((def.disallowedTools ?? []).some(t => DELEGATION.has(t))) {
    warnings.push('disallowedTools names Task/Investigate — delegation is set by "delegate"; it is treated as delegate: none.');
  }

  const missingSkills = (def.skills ?? []).filter(s => !ctx.hasSkill(s));
  if (missingSkills.length) {
    errors.push(`skills: ${missingSkills.join(', ')} — not installed, not reviewed, or switched off. Install and review them under Settings → Skills, or remove them`);
  }

  for (const server of def.mcpServers ?? []) {
    if (!ctx.mcpServers.has(server)) errors.push(`mcpServers: there is no MCP server called "${server}" — add it under Settings → MCP first, or remove it`);
  }
  if (def.mcpServers?.length && def.tools?.length && !def.tools.some(t => isMcpEntry(t))) {
    warnings.push(`mcpServers lists ${def.mcpServers.join(', ')}, but tools admits no MCP tool — add "mcp__${def.mcpServers[0]}__*" to tools, or the server is loaded for nothing`);
  }

  const delegate = def.delegate;
  if (Array.isArray(delegate)) {
    const unknown = delegate.filter(a => !ctx.agents.has(a) && a !== name);
    if (unknown.length) errors.push(`delegate: ${unknown.join(', ')} — no such agent. Name registered agents, or use none / readonly`);
  } else if (delegate !== undefined && delegate !== 'none' && delegate !== 'readonly') {
    errors.push(`delegate "${String(delegate)}" — use none, readonly, or a list of agent names`);
  }

  if (def.autonomy && !/^L[0-4]$/.test(def.autonomy)) {
    errors.push(`autonomy "${def.autonomy}" — use L0 (plan), L1 (ask), L2 (edits), L3 (auto) or L4 (unattended)`);
  }
  if (def.autonomy === 'L4') {
    warnings.push('autonomy L4 (unattended) needs certification (a current certificate) — certify it (Settings → Agents → Verify, or `aico agent certify <name>`); until then unattended runs are held to L3.');
  }

  const budget = def.budget ?? {};
  for (const key of ['maxUsd', 'maxIterations', 'maxMinutes'] as const) {
    const v = budget[key];
    if (v === undefined) continue;
    if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) errors.push(`budget.${key} must be a positive number`);
  }
  if (budget.maxIterations !== undefined && !Number.isInteger(budget.maxIterations)) errors.push('budget.maxIterations must be a whole number of steps');
  const level = def.autonomy || 'L3';
  if ((level === 'L3' || level === 'L4') && budget.maxUsd === undefined && budget.maxIterations === undefined) {
    warnings.push('no budget — an agent that runs without asking should have one (maxUsd or maxIterations), so a loop stops by itself');
  }

  for (const glob of def.paths?.write ?? []) {
    const problem = writeGlobProblem(String(glob));
    if (problem) errors.push(`paths.write: ${problem}`);
  }
  const allowsBash = !def.tools?.length || def.tools.includes('Bash') || def.tools.includes('Terminal');
  const deniesBash = (def.disallowedTools ?? []).includes('Bash');
  if (def.paths?.write?.length && allowsBash && !deniesBash) {
    warnings.push('paths.write binds AICO\'s file tools only — this agent also has Bash, which can still write anywhere. Remove Bash for a real bound.');
  }

  const body = String(def.instructions ?? '');
  if (body.length > 40_000) errors.push(`instructions are ${body.length.toLocaleString()} characters; keep them under 40,000 — move reference material into a skill`);
  else if (body.length > 12_000) warnings.push(`instructions are ${body.length.toLocaleString()} characters — every turn with this agent pays for them; consider a skill for reference material`);

  return { errors, warnings };
}

/** Validate with a freshly loaded context. */
export async function validateAgent(def: AgentDraftInput, cwd: string): Promise<AgentValidation> {
  return validateAgentDef(def, await validationContext(cwd));
}
