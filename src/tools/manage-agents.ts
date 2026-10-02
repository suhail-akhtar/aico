/**
 * Everything a person can ask to have done to their agents.
 *
 * Third instance of the same shape, and by now the shape is the argument: one
 * tool, one action enum, the same verbs every registry has. Someone who has
 * learned `SkillManage` already knows this one.
 *
 * **An agent's skills are part of its definition.** `AgentSpec.skills` names
 * the procedures that agent should reach for, which is what makes a specialist
 * more than a system prompt with opinions — so `create` and `update` take them,
 * and both check the names actually exist. A skill list that quietly contains a
 * typo produces an agent that is subtly less capable than intended, and nothing
 * would ever say so.
 *
 * **Phase 3 (agents v2).** Definitions are `.md` files (agents/format) with
 * enforced bounds: tools allow/deny, MCP servers, delegate, autonomy ceiling,
 * budget, write paths. Every save is validated by the one engine validator
 * (agents/validate) and refused on errors; `validate` and `effective` return
 * the errors and the engine-generated "what this agent can do" summary
 * (agents/summary) without saving, which is what the Settings builders call.
 * `import` reads AICO JSON, AICO/Claude Code `.md` and Copilot `.agent.md`
 * files; an imported file never raises autonomy (bypassPermissions is
 * ignored with a warning) and unknown tools are dropped with a warning —
 * narrowing is the safe direction.
 *
 * **Phase 4.** `status` reports certified / changed since certification /
 * failed / uncertified (evals/certificate), and `certify` runs the safety
 * pack and the agent's golden tasks k times under a hard $2 cap
 * (evals/certify); a certificate is what lets the agent run unattended (L4).
 *
 * **Built-in agents cannot be edited or deleted, only disabled.** They ship
 * with AICO, so "delete" would mean "until the next install".
 *
 * @module tools/manage-agents
 */

import fs from 'fs';
import path from 'path';
import {
  listAgentSpecs,
  getAgentSpec,
  createAgentSpec,
  deleteProjectAgentSpec,
  updateProjectAgentSpec,
} from '../agents/registry.js';
import { agentToMarkdown, parseAgentMarkdown } from '../agents/format.js';
import { toolEntryProblem, validateAgentDef, validationContext, type AgentDraftInput } from '../agents/validate.js';
import { summarizeAgent } from '../agents/summary.js';
import type { AgentBudget, AgentSpec, AutonomyLevel, DelegateRule } from '../agents/types.js';
import { skillRegistry } from '../skills/index.js';
import { disabledIn, isDisabled, setEnabled, forget } from '../registry-state.js';
import { currentCwd } from '../run-context.js';

export interface AgentManageInput {
  action: 'list' | 'read' | 'create' | 'update' | 'delete' | 'enable' | 'disable' | 'export' | 'import'
    | 'validate' | 'effective' | 'duplicate' | 'certify' | 'status';
  /** certify: trials per task (k, default 3). */
  runs?: number;
  /** certify: hard cap in dollars (default and maximum 2). */
  budgetUsd?: number;
  /** certify: the judge model (default deepseek-v4-pro). */
  judgeModel?: string;
  /** certify: plan and estimate only, spend nothing. */
  dryRun?: boolean;
  name?: string;
  /** For duplicate: the new agent's name. */
  newName?: string;
  description?: string;
  role?: string;
  goals?: string[];
  skills?: string[];
  tools?: string[];
  canDelegate?: boolean;
  reportFormat?: string;
  model?: string;
  scope?: 'user' | 'project';
  path?: string;
  instructions?: string;
  disallowedTools?: string[];
  mcpServers?: string[];
  delegate?: DelegateRule;
  autonomy?: AutonomyLevel;
  budget?: AgentBudget;
  paths?: { write?: string[] };
}

/** Skill names that do not exist, so a typo is caught where it is made. */
function unknownSkills(names: string[]): string[] {
  return names.filter(skill => !skillRegistry.lookup(skill));
}

/** The definition fields an input carries, only those given. */
function defFields(input: AgentManageInput): AgentDraftInput {
  const out: AgentDraftInput = {};
  const keys = ['description', 'role', 'goals', 'skills', 'tools', 'canDelegate', 'reportFormat', 'model',
    'instructions', 'disallowedTools', 'mcpServers', 'delegate', 'autonomy', 'budget', 'paths'] as const;
  for (const k of keys) if (input[k] !== undefined) (out as Record<string, unknown>)[k] = input[k];
  if (out.model !== undefined && /^inherit$/i.test(String(out.model).trim())) out.model = '';
  return out;
}

/** A definition as JSON for the builders: errors, warnings, summary. */
async function checkDefinition(def: AgentDraftInput & { name: string }, cwd: string): Promise<string> {
  const ctx = await validationContext(cwd);
  const { errors, warnings } = validateAgentDef(def, ctx);
  let summary: Awaited<ReturnType<typeof summarizeAgent>> | undefined;
  try { summary = await summarizeAgent({ ...def, name: def.name || 'new-agent' } as AgentSpec, cwd); }
  catch (err) { warnings.push(`summary unavailable: ${err instanceof Error ? err.message : String(err)}`); }
  return JSON.stringify({ ok: errors.length === 0, errors, warnings, ...(summary ? { summary } : {}) }, null, 2);
}

/** Read the files an import path names: one file, or every agent file in a folder. */
function agentFilesAt(target: string): string[] {
  const stat = fs.statSync(target);
  if (stat.isFile()) return [target];
  return fs.readdirSync(target)
    .filter(f => f.endsWith('.md') || f.endsWith('.json'))
    .map(f => path.join(target, f))
    .filter(f => fs.statSync(f).isFile());
}

/** Import Markdown agents (AICO, Claude Code, Copilot): narrowed, validated, never raised. */
async function importMarkdown(files: string[], scope: 'user' | 'project', cwd: string): Promise<{ added: string[]; skipped: string[]; warnings: string[] }> {
  const ctx = await validationContext(cwd);
  const added: string[] = [];
  const skipped: string[] = [];
  const warnings: string[] = [];
  for (const file of files) {
    const base = path.basename(file).replace(/\.agent\.md$|\.md$/, '');
    const parsed = parseAgentMarkdown(fs.readFileSync(file, 'utf8'), { fallbackName: base.toLowerCase(), imported: true });
    const label = parsed.spec?.name || base;
    if (!parsed.spec || parsed.errors.length) { skipped.push(`${label} (${parsed.errors.join('; ')})`); continue; }
    const spec = parsed.spec;
    const notes = [...parsed.warnings];
    if (await getAgentSpec(spec.name, cwd)) { skipped.push(`${spec.name} (already exists)`); continue; }

    // Unknown tools, skills and servers are dropped and named: an imported
    // agent narrowed to what exists here is safe; one refused is just lost.
    const keep = (list: string[] | undefined, field: string): string[] | undefined => {
      if (!list) return list;
      const bad = list.filter(t => toolEntryProblem(t, field, ctx, []));
      if (bad.length) notes.push(`${field}: dropped ${bad.join(', ')} (not available here)`);
      return list.filter(t => !bad.includes(t));
    };
    const tools = keep(spec.tools.length ? spec.tools : undefined, 'tools');
    if (spec.tools.length && !tools?.length) {
      skipped.push(`${spec.name} (none of its tools exist here: ${spec.tools.join(', ')})`);
      continue;
    }
    const disallowedTools = keep(spec.disallowedTools, 'disallowedTools');
    const skills = spec.skills.filter(s => ctx.hasSkill(s));
    if (skills.length < spec.skills.length) notes.push(`skills: dropped ${spec.skills.filter(s => !skills.includes(s)).join(', ')} (not installed and reviewed here)`);
    const mcpServers = spec.mcpServers?.filter(s => ctx.mcpServers.has(s));
    if (spec.mcpServers && (mcpServers?.length ?? 0) < spec.mcpServers.length) {
      notes.push(`mcpServers: dropped ${spec.mcpServers.filter(s => !mcpServers?.includes(s)).join(', ')} (not configured here)`);
    }
    const delegate = Array.isArray(spec.delegate) ? spec.delegate.filter(a => ctx.agents.has(a)) : spec.delegate;
    try {
      await createAgentSpec({
        name: spec.name,
        description: spec.description,
        ...(spec.instructions ? { instructions: spec.instructions } : {}),
        ...(spec.model ? { model: spec.model } : {}),
        ...(tools ? { tools } : { tools: [] }),
        ...(disallowedTools?.length ? { disallowedTools } : {}),
        skills,
        ...(mcpServers?.length ? { mcpServers } : {}),
        delegate: Array.isArray(delegate) && delegate.length === 0 ? 'none' : delegate ?? 'readonly',
        ...(spec.autonomy ? { autonomy: spec.autonomy } : {}),
        ...(spec.budget ? { budget: spec.budget } : {}),
        ...(spec.paths ? { paths: spec.paths } : {}),
        scope,
      }, cwd);
      added.push(spec.name);
      for (const n of notes) warnings.push(`${spec.name}: ${n}`);
    } catch (err) {
      skipped.push(`${spec.name} (${err instanceof Error ? err.message : String(err)})`);
    }
  }
  return { added, skipped, warnings };
}

export async function executeAgentManage(input: AgentManageInput): Promise<string> {
  const cwd = currentCwd();
  const name = input.name?.trim() ?? '';

  switch (input.action) {
    case 'list': {
      const specs = await listAgentSpecs(cwd);
      if (specs.length === 0) return 'No agents defined.';
      const off = disabledIn('agents');
      return [
        `${specs.length} agent(s):`,
        ...specs.map(spec => {
          const marked = off.has(spec.name.toLowerCase()) ? ' [disabled]' : '';
          const skills = spec.skills?.length ? ` — skills: ${spec.skills.join(', ')}` : '';
          return `- ${spec.name} (${spec.source})${marked}: ${spec.description}${skills}`;
        }),
      ].join('\n');
    }

    case 'read': {
      const spec = await getAgentSpec(name, cwd);
      if (!spec) return `There is no agent called "${name}". Use action:"list".`;
      return [
        `name: ${spec.name}`,
        `description: ${spec.description}`,
        `source: ${spec.source}${spec.format ? ` (${spec.format})` : ''}`,
        `enabled: ${!isDisabled('agents', spec.name)}`,
        spec.instructions ? '' : `role: ${spec.role}`,
        spec.model ? `model: ${spec.model}` : '',
        !spec.instructions && spec.goals?.length ? `goals:\n${spec.goals.map(g => `  - ${g}`).join('\n')}` : '',
        spec.skills?.length ? `skills: ${spec.skills.join(', ')}` : '',
        spec.tools?.length ? `tools: ${spec.tools.join(', ')}` : 'tools: (all)',
        spec.disallowedTools?.length ? `disallowedTools: ${spec.disallowedTools.join(', ')}` : '',
        spec.mcpServers?.length ? `mcpServers: ${spec.mcpServers.join(', ')}` : '',
        `delegate: ${Array.isArray(spec.delegate) ? spec.delegate.join(', ') : spec.delegate ?? (spec.canDelegate ? 'readonly' : 'none')}`,
        spec.autonomy ? `autonomy: ${spec.autonomy}` : '',
        spec.budget ? `budget: ${JSON.stringify(spec.budget)}` : '',
        spec.paths?.write?.length ? `paths.write: ${spec.paths.write.join(', ')}` : '',
        spec.reportFormat ? `reportFormat: ${spec.reportFormat}` : '',
        spec.warnings?.length ? `warnings:\n${spec.warnings.map(w => `  - ${w}`).join('\n')}` : '',
        spec.instructions ? `instructions:\n${spec.instructions}` : '',
      ].filter(Boolean).join('\n');
    }

    case 'validate': {
      // The builders' live check: never saves. For an existing agent, the
      // given fields are applied over its definition first.
      const existing = name ? await getAgentSpec(name, cwd) : undefined;
      const base: AgentDraftInput = existing ? { ...existing } : {};
      return checkDefinition({ ...base, ...defFields(input), name }, cwd);
    }

    case 'effective': {
      const spec = await getAgentSpec(name, cwd);
      if (!spec) return `There is no agent called "${name}".`;
      return (await summarizeAgent(spec, cwd)).text;
    }

    case 'status': {
      // JSON, for the panels: one agent, or every agent when no name is given.
      const { loadSettings } = await import('../settings.js');
      const { statusOfSpec } = await import('../evals/certificate.js');
      const settings = await loadSettings().catch(() => ({} as Awaited<ReturnType<typeof loadSettings>>));
      const specs = name ? [await getAgentSpec(name, cwd)].filter((s): s is AgentSpec => Boolean(s)) : await listAgentSpecs(cwd);
      if (name && !specs.length) return `There is no agent called "${name}".`;
      const out: Record<string, unknown> = {};
      for (const spec of specs) out[spec.name] = await statusOfSpec(spec, { cwd, model: spec.model || settings.model || '' });
      return JSON.stringify(name ? out[specs[0]!.name] : out, null, 2);
    }

    case 'certify': {
      const spec = await getAgentSpec(name, cwd);
      if (!spec) return `There is no agent called "${name}".`;
      const { loadSettings } = await import('../settings.js');
      const { certifyAgent, describeCertificate, describePlan } = await import('../evals/certify.js');
      const settings = await loadSettings();
      if (!spec.model && !settings.model) return 'Not certified — no model is configured to run it on. Set a default model in Settings first.';
      // The tool's own deadline (timeout-policy) sits just past this one.
      const signal = AbortSignal.timeout(30 * 60 * 1000);
      const r = await certifyAgent(spec.name, {
        model: spec.model || settings.model!, settings, cwd, signal,
        ...(input.runs ? { runs: input.runs } : {}),
        ...(input.budgetUsd ? { budgetUsd: input.budgetUsd } : {}),
        ...(input.judgeModel ? { judgeModel: input.judgeModel } : {}),
        ...(input.dryRun ? { dryRun: true } : {}),
      });
      if ('error' in r) return r.plan ? `${describePlan(r.plan)}\n\n(Dry run: nothing was spent.)` : r.error;
      return describeCertificate(r.certificate);
    }

    case 'create': {
      if (!name) return 'A name is required.';
      if (!input.description?.trim()) {
        return 'A description is required — it is what decides whether this agent is the right one '
          + 'to hand a task to.';
      }
      const existing = await getAgentSpec(name, cwd);
      if (existing) {
        return `An agent called "${name}" already exists (${existing.source}). `
          + 'Use action:"update" to change it.';
      }
      const missing = unknownSkills(input.skills ?? []);
      if (missing.length) {
        return `Not created — these skills do not exist: ${missing.join(', ')}. `
          + 'Create them first with SkillManage, or leave them out. An agent pointed at a skill that '
          + 'is not there is quietly less capable than it looks.';
      }

      let spec: AgentSpec;
      try {
        spec = await createAgentSpec({
          ...(defFields(input) as Record<string, unknown>),
          name,
          description: input.description,
          scope: input.scope ?? 'user',
        } as Parameters<typeof createAgentSpec>[0], cwd);
      } catch (err) {
        return err instanceof Error ? err.message : String(err);
      }
      const summary = await summarizeAgent(spec, cwd).then(s => s.text).catch(() => '');
      return [
        `Created agent "${spec.name}" (${spec.source}).`,
        spec.skills?.length ? `It will reach for: ${spec.skills.join(', ')}.` : '',
        summary,
        `Hand it work with Task agent_name:"${spec.name}", or talk to it with @${spec.name}.`,
      ].filter(Boolean).join('\n');
    }

    case 'update': {
      const spec = await getAgentSpec(name, cwd);
      if (!spec) return `There is no agent called "${name}".`;
      if (spec.source === 'builtin') {
        return `"${name}" is built in and cannot be edited. Create your own agent instead, or disable this one.`;
      }
      const missing = unknownSkills(input.skills ?? []);
      if (missing.length) return `Not updated — these skills do not exist: ${missing.join(', ')}.`;

      // Only what was named changes; everything else stands. Wrapped because
      // the registry throws for the cases it refuses, and a tool that throws
      // ends the turn instead of telling the model what to do differently.
      try {
        const updated = await updateProjectAgentSpec(name, defFields(input), cwd);
        return updated ? `Updated agent "${name}".` : `Could not update "${name}".`;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return message.startsWith('Not ') ? message : `Not updated: ${message}`;
      }
    }

    case 'duplicate': {
      const spec = await getAgentSpec(name, cwd);
      if (!spec) return `There is no agent called "${name}".`;
      const target = input.newName?.trim() || `${spec.name}-copy`;
      if (await getAgentSpec(target, cwd)) return `Not duplicated — an agent called "${target}" already exists. Give newName.`;
      const { systemPromptXml: _x, source: _s, format: _f, warnings: _w, name: _n, ...def } = spec;
      try {
        const copy = await createAgentSpec({
          ...(def as Record<string, unknown>),
          name: target,
          scope: input.scope ?? 'user',
        } as Parameters<typeof createAgentSpec>[0], cwd);
        return `Duplicated "${spec.name}" as "${copy.name}" (${copy.source}). Edit it to make it yours.`;
      } catch (err) {
        return err instanceof Error ? err.message : String(err);
      }
    }

    case 'delete': {
      const spec = await getAgentSpec(name, cwd);
      if (!spec) return `There is no agent called "${name}".`;
      if (spec.source === 'builtin') {
        return `"${name}" is built in and cannot be deleted — it would come back on the next install. `
          + 'Disable it instead.';
      }
      const done = await deleteProjectAgentSpec(name, cwd);
      if (done) forget('agents', name);
      return done ? `Deleted agent "${name}".` : `Could not delete "${name}".`;
    }

    case 'enable':
    case 'disable': {
      const spec = await getAgentSpec(name, cwd);
      if (!spec) return `There is no agent called "${name}".`;
      const wanted = input.action === 'enable';
      const changed = setEnabled('agents', spec.name, wanted);
      return changed
        ? `"${spec.name}" is now ${wanted ? 'enabled' : 'disabled'}.`
        : `"${spec.name}" was already ${wanted ? 'enabled' : 'disabled'}.`;
    }

    case 'export': {
      if (!input.path) return 'A path is required — where to write the file (.json for any number, .md for one agent).';
      const specs = await listAgentSpecs(cwd);
      const chosen = name ? specs.filter(s => s.name.toLowerCase() === name.toLowerCase()) : specs;
      if (name && chosen.length === 0) return `There is no agent called "${name}".`;

      const target = path.resolve(input.path);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      if (target.endsWith('.md')) {
        if (chosen.length !== 1) return 'A .md export holds one agent — give its name, or export to a .json file.';
        const { systemPromptXml: _x, source: _s, format: _f, warnings: _w, ...def } = chosen[0]!;
        fs.writeFileSync(target, agentToMarkdown(def), 'utf8');
        return `Exported ${chosen[0]!.name} to ${target}.`;
      }
      // The generated XML is left out: it is derived from the rest, and shipping
      // it would freeze a rendering that the importing install may do better.
      fs.writeFileSync(target, JSON.stringify({
        agents: chosen.map(({ systemPromptXml: _drop, source: _src, format: _f, warnings: _w, ...rest }) => rest),
      }, null, 2), 'utf8');
      return `Exported ${chosen.length} agent(s) to ${target}.`;
    }

    case 'import': {
      if (!input.path) return 'A path is required — a .json export, an agent .md file, or a folder of them (.claude/agents, .github/agents).';
      const target = path.resolve(input.path);
      if (!fs.existsSync(target)) return `${target} does not exist.`;
      const files = agentFilesAt(target);
      const mdFiles = files.filter(f => f.endsWith('.md'));
      const jsonFiles = files.filter(f => f.endsWith('.json'));
      if (!files.length) return 'That folder holds no agent files (.md or .json).';

      const added: string[] = [];
      const skipped: string[] = [];
      const warnings: string[] = [];
      if (mdFiles.length) {
        const r = await importMarkdown(mdFiles, input.scope ?? 'user', cwd);
        added.push(...r.added); skipped.push(...r.skipped); warnings.push(...r.warnings);
      }
      for (const file of jsonFiles) {
        let parsed: { agents?: Array<Record<string, unknown>> };
        try { parsed = JSON.parse(fs.readFileSync(file, 'utf8')); }
        catch (err) { skipped.push(`${path.basename(file)} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`); continue; }
        const incoming = parsed.agents ?? [];
        if (incoming.length === 0) { skipped.push(`${path.basename(file)} defines no agents`); continue; }
        for (const raw of incoming) {
          const agentName = String(raw['name'] ?? '').trim();
          if (!agentName) { skipped.push('(unnamed)'); continue; }
          if (await getAgentSpec(agentName, cwd)) { skipped.push(`${agentName} (already exists)`); continue; }
          const missing = unknownSkills((raw['skills'] as string[]) ?? []);
          try {
            await createAgentSpec({
              ...(raw as unknown as Parameters<typeof createAgentSpec>[0]),
              name: agentName,
              // A skill that did not come along is dropped rather than left
              // dangling, and named below so it is not a silent difference.
              skills: ((raw['skills'] as string[]) ?? []).filter(s => !missing.includes(s)),
              scope: input.scope ?? 'user',
            }, cwd);
            added.push(missing.length ? `${agentName} (without missing skills: ${missing.join(', ')})` : agentName);
          } catch (err) {
            skipped.push(`${agentName} (${err instanceof Error ? err.message : String(err)})`);
          }
        }
      }
      return [
        added.length ? `Imported: ${added.join('; ')}` : 'Nothing imported.',
        skipped.length ? `Skipped: ${skipped.join('; ')}` : '',
        warnings.length ? `Warnings:\n${warnings.map(w => `- ${w}`).join('\n')}` : '',
      ].filter(Boolean).join('\n');
    }

    default:
      return `Unknown action "${String(input.action)}".`;
  }
}

export const agentManageToolDefinition = {
  name: 'AgentManage',
  description: [
    'Manage the agents available to delegate to: list, read, create, update, duplicate, delete, enable, disable,',
    'validate, effective (what an agent can do, generated from its bounds), export and import (.json, or',
    'Claude Code / Copilot agent .md files), status and certify (run its safety and golden tasks; costs money,',
    'capped at $2 — say so and get a yes first). Use this whenever someone asks what agents exist, or asks to make,',
    'change, remove, or switch one off. Every save is validated: unknown tools, skills or MCP servers are refused.',
    'To hand work to an agent, use Task with agent_name.',
  ].join(' '),
  inputSchema: {
    type: 'object' as const,
    properties: {
      action: {
        type: 'string',
        enum: ['list', 'read', 'create', 'update', 'duplicate', 'delete', 'enable', 'disable', 'validate', 'effective', 'export', 'import', 'status', 'certify'],
        description:
          'list: every agent and whether it is enabled. read: one in full. create: define a new one. '
          + 'update: change one. duplicate: copy one under newName. delete: remove it. enable/disable: switch without deleting. '
          + 'validate: check fields without saving (JSON: errors, warnings, summary). effective: what it can do. '
          + 'export/import: files. status: certified / changed since certification / failed / uncertified (JSON). '
          + 'certify: run the safety pack and its golden tasks k times (paid; dryRun first for the estimate).',
      },
      name: { type: 'string', description: 'Which agent. Required for everything except list and import.' },
      newName: { type: 'string', description: 'For duplicate: the copy\'s name.' },
      description: { type: 'string', description: 'When to hand it work ("Reviews … Use for …") — it decides when it is chosen.' },
      instructions: { type: 'string', description: 'Its instructions (the Markdown body): how it works and what it reports.' },
      skills: {
        type: 'array', items: { type: 'string' },
        description: 'Skills preloaded for it. Checked — a name that does not exist is refused, not silently kept.',
      },
      tools: {
        type: 'array', items: { type: 'string' },
        description: 'Allow-list: built-in names (Read, Bash…), custom:<name>, mcp__<server>__* or mcp__<server>__<tool>. Omit for all tools.',
      },
      disallowedTools: { type: 'array', items: { type: 'string' }, description: 'Removed after the allow-list, same spellings.' },
      mcpServers: { type: 'array', items: { type: 'string' }, description: 'MCP servers it uses: loaded for it, and the only servers its MCP tools come from.' },
      delegate: {
        description: '"none", "readonly" (may delegate; every child is read-only), or a list of agent names it may hand work to.',
        anyOf: [{ type: 'string', enum: ['none', 'readonly'] }, { type: 'array', items: { type: 'string' } }],
      },
      autonomy: { type: 'string', enum: ['L0', 'L1', 'L2', 'L3', 'L4'], description: 'Ceiling: L0 plan, L1 asks before changes, L2 edits freely, L3 auto. The run is never above the session\'s level.' },
      budget: {
        type: 'object',
        properties: { maxUsd: { type: 'number' }, maxIterations: { type: 'number' }, maxMinutes: { type: 'number' } },
        description: 'Per-run limits; the run stops when one is reached.',
      },
      paths: {
        type: 'object', properties: { write: { type: 'array', items: { type: 'string' } } },
        description: 'write: globs relative to the project that AICO\'s file tools may write (Bash is not bound).',
      },
      canDelegate: { type: 'boolean', description: 'Legacy: false = delegate none, true = delegate readonly.' },
      role: { type: 'string', description: 'Legacy role title, used only when there are no instructions.' },
      goals: { type: 'array', items: { type: 'string' }, description: 'Legacy goals, used only when there are no instructions.' },
      reportFormat: { type: 'string', description: 'How it should shape its final answer.' },
      model: { type: 'string', description: 'Pin it to a specific model, if it should not use the session\'s.' },
      scope: { type: 'string', enum: ['user', 'project'], description: 'user: available everywhere. project: only here.' },
      path: { type: 'string', description: 'For export: where to write (.json, or .md for one agent). For import: a file or folder.' },
      runs: { type: 'number', description: 'For certify: trials per task (default 3).' },
      budgetUsd: { type: 'number', description: 'For certify: hard cap in dollars (default and maximum 2).' },
      judgeModel: { type: 'string', description: 'For certify: the judge model (default deepseek-v4-pro).' },
      dryRun: { type: 'boolean', description: 'For certify: show the plan and estimate without spending anything.' },
    },
    required: ['action'],
  },
};
