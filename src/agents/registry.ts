/**
 * Where agent definitions live, and how they are read and written.
 *
 * Built-ins (`agents/builtin.ts`), then the user's (`aicoHome()/agents`), then
 * the project's (`<cwd>/.aico/agents`); a later one of the same name wins.
 * Each directory holds `<name>.md` (the format since Phase 3, `agents/format`)
 * and legacy `<name>.json`, which is still read; when both exist the `.md`
 * wins. Saving always writes `.md` and removes the `.json` it replaces, so a
 * legacy agent migrates the first time it is edited and never before — a
 * read never rewrites a person's file.
 *
 * Every write is validated first (`agents/validate`) and refused on errors,
 * whichever door it came through: AgentManage, AgentCreate, the Settings
 * builders or `/agents`.
 *
 * @module agents/registry
 */

import path from 'path';
import type { Dirent } from 'fs';
import { aicoHome } from '../home.js';
import { mkdir, readFile, readdir, unlink, writeFile } from 'fs/promises';
import type { AgentCreateInput, AgentSpec } from './types.js';
import { BUILTIN_AGENT_FILES } from './builtin.js';
import { agentToMarkdown, delegateFromCanDelegate, parseAgentMarkdown } from './format.js';

/** The built-ins, parsed from their `.md` text exactly as a person's file is. */
function builtinSpecs(): AgentSpec[] {
  const out: AgentSpec[] = [];
  for (const [name, text] of Object.entries(BUILTIN_AGENT_FILES)) {
    const parsed = parseAgentMarkdown(text, { fallbackName: name });
    if (!parsed.spec) continue;
    const { format: _format, ...rest } = parsed.spec;
    out.push(withXml({ ...rest, source: 'builtin', systemPromptXml: '' }));
  }
  return out;
}

function slugName(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
}

function userAgentsDir(): string {
  return path.join(aicoHome(), 'agents');
}

function projectAgentsDir(cwd = process.cwd()): string {
  return path.join(cwd, '.aico', 'agents');
}

/** The staying-in-role contract, shared by both renderings. See `defaultXml`. */
const STAYING_IN_ROLE = [
  '    <staying_in_role>',
  '      You are this specialist for the whole conversation, not a general assistant',
  '      wearing its name. If a request is outside the remit above:',
  '      1. Say so in one line, plainly, without apologising at length.',
  '      2. Name what should handle it — the orchestrator, or a specific agent.',
  '      3. Offer to hand it back rather than doing it yourself.',
  '      Do not quietly do the work anyway because you are capable of it. The',
  '      person chose a specialist on purpose, and silently behaving like the',
  '      orchestrator makes that choice meaningless.',
  '    </staying_in_role>',
  '    <always_in_scope>',
  '      Questions about who you are, what you handle, and what you would',
  '      decline. Small clarifying exchanges about work that IS in scope.',
  '      Saying that something is out of scope, and why.',
  '    </always_in_scope>',
  '    <judgement>',
  '      Adjacent work that genuinely serves the task in front of you is in',
  '      scope — reading code to review it, running a command to check a',
  '      finding. The line is the purpose of the request, not the tool used.',
  '    </judgement>',
];

/**
 * The system prompt an agent runs under.
 *
 * This used to describe a role and nothing else — name, goals, skills, tools —
 * which reads as flavour rather than as a boundary. Watched live: a session
 * addressed to the security reviewer answered anything put to it, exactly like
 * the orchestrator, because nothing anywhere said what it should *not* do and
 * the general instructions above it say to be useful.
 *
 * So the scope is stated as a contract, with the refusal spelled out. Two
 * details matter more than the wording:
 *
 * **The decline has somewhere to go.** "That is out of scope" is a dead end and
 * people rightly hate it. Naming the orchestrator and offering to hand back
 * turns a refusal into a routing decision, which is what it actually is.
 *
 * **A question about its own remit is always in scope.** Otherwise asking a
 * specialist what it is for gets refused, which is absurd and was the first
 * thing anyone tried.
 *
 * A `.md` agent's body is its instructions, rendered by `instructionsXml`
 * with the same contract around it.
 */
function defaultXml(input: Omit<AgentSpec, 'systemPromptXml'>): string {
  if (input.instructions) return instructionsXml(input);
  return [
    '<agent>',
    `  <name>${input.name}</name>`,
    `  <role>${input.role}</role>`,
    '  <scope>',
    `    <this_agent_handles>${input.role} work: ${input.goals.join('; ')}</this_agent_handles>`,
    ...STAYING_IN_ROLE,
    '  </scope>',
    '  <operating_principles>',
    '    <principle>Understand the requirement before acting.</principle>',
    '    <principle>Use available skills intentionally; do not claim a skill you did not apply.</principle>',
    '    <principle>Prefer production-grade, tested, maintainable implementation over quick patches.</principle>',
    '    <principle>Use WorkspaceWrite for durable plans, reports, QA notes, and handoff artifacts.</principle>',
    '    <principle>Report exact files, commands, results, risks, and remaining work.</principle>',
    input.canDelegate
      ? '    <principle>Delegate narrow subtasks with Task only when parallel work materially helps.</principle>'
      : '    <principle>Do not delegate unless explicitly asked by the lead agent.</principle>',
    '  </operating_principles>',
    '  <goals>',
    ...input.goals.map((g) => `    <goal>${g}</goal>`),
    '  </goals>',
    '  <skills>',
    ...input.skills.map((s) => `    <skill>${s}</skill>`),
    '  </skills>',
    '  <allowed_tools>',
    ...input.tools.map((t) => `    <tool>${t}</tool>`),
    '  </allowed_tools>',
    `  <report_format>${input.reportFormat}</report_format>`,
    '</agent>',
  ].join('\n');
}

/**
 * The prompt for an agent defined by its body. The tool list is not restated:
 * the run is offered exactly the tools it may use (agents/effective), so a
 * list in prose would be a second, driftable copy.
 */
function instructionsXml(input: Omit<AgentSpec, 'systemPromptXml'>): string {
  return [
    '<agent>',
    `  <name>${input.name}</name>`,
    `  <when_used>${input.description}</when_used>`,
    '  <scope>',
    ...STAYING_IN_ROLE,
    '  </scope>',
    '  <instructions>',
    input.instructions!.trim(),
    '  </instructions>',
    ...(input.reportFormat ? [`  <report_format>${input.reportFormat}</report_format>`] : []),
    '</agent>',
  ].join('\n');
}

function withXml(spec: AgentSpec): AgentSpec {
  return spec.systemPromptXml ? spec : { ...spec, systemPromptXml: defaultXml(spec) };
}

/** A legacy JSON definition, with `delegate` derived from `canDelegate` (true → readonly). */
function fromJson(parsed: AgentSpec, source: AgentSpec['source']): AgentSpec {
  return withXml({
    ...parsed,
    goals: parsed.goals ?? [],
    skills: parsed.skills ?? [],
    tools: parsed.tools ?? [],
    role: parsed.role ?? parsed.description ?? '',
    reportFormat: parsed.reportFormat ?? '',
    delegate: parsed.delegate ?? delegateFromCanDelegate(parsed.canDelegate),
    source,
    format: 'json',
    // Regenerated, so an old file's stored XML cannot carry a stale contract.
    systemPromptXml: '',
  });
}

async function readSpecsFromDir(dir: string, source: AgentSpec['source']): Promise<AgentSpec[]> {
  let entries: Dirent[];
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return []; }
  const byName = new Map<string, AgentSpec>();
  // JSON first, so a `.md` of the same name replaces it.
  const files = entries
    .filter(e => e.isFile() && (e.name.endsWith('.json') || e.name.endsWith('.md')))
    .sort((a, b) => Number(a.name.endsWith('.md')) - Number(b.name.endsWith('.md')) || a.name.localeCompare(b.name));
  for (const entry of files) {
    try {
      const raw = await readFile(path.join(dir, entry.name), 'utf8');
      if (entry.name.endsWith('.json')) {
        const spec = fromJson(JSON.parse(raw) as AgentSpec, source);
        byName.set(spec.name, spec);
        continue;
      }
      const parsed = parseAgentMarkdown(raw, { fallbackName: entry.name.slice(0, -3) });
      // A file with errors is not loaded: half an agent is worse than none.
      if (!parsed.spec || parsed.errors.length) continue;
      byName.set(parsed.spec.name, withXml({
        ...parsed.spec, source, systemPromptXml: '',
        ...(parsed.warnings.length ? { warnings: parsed.warnings } : {}),
      }));
    } catch {
      // Ignore malformed agent files; /agents should remain usable.
    }
  }
  return [...byName.values()];
}

export async function listAgentSpecs(cwd = process.cwd()): Promise<AgentSpec[]> {
  const user = await readSpecsFromDir(userAgentsDir(), 'user');
  const project = await readSpecsFromDir(projectAgentsDir(cwd), 'project');
  const all = [...builtinSpecs(), ...user, ...project];
  const byName = new Map<string, AgentSpec>();
  for (const spec of all) byName.set(spec.name, spec);
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * The file a loaded agent was read from, or undefined for a built-in. The
 * certificate hash (evals/certificate) covers its bytes, and its golden tasks
 * live beside it (`<name>.evals/`).
 */
export function agentFilePath(spec: Pick<AgentSpec, 'name' | 'source' | 'format'>, cwd = process.cwd()): string | undefined {
  if (spec.source === 'builtin') return undefined;
  const dir = spec.source === 'project' ? projectAgentsDir(cwd) : userAgentsDir();
  return path.join(dir, `${spec.name}.${spec.format === 'json' ? 'json' : 'md'}`);
}

export async function getAgentSpec(name: string, cwd = process.cwd()): Promise<AgentSpec | undefined> {
  const slug = slugName(name);
  const specs = await listAgentSpecs(cwd);
  return specs.find((s) => s.name === slug || s.name === name);
}

/** Refuse a definition with errors, naming each fix. */
async function assertValid(def: Partial<AgentSpec>, cwd: string): Promise<void> {
  const { validateAgent } = await import('./validate.js');
  const { errors } = await validateAgent(def, cwd);
  if (errors.length) throw new Error(`Not saved — ${errors.join('; ')}.`);
}

async function writeSpecFile(spec: AgentSpec, dir: string, previousText?: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  const { systemPromptXml: _x, source: _s, format: _f, warnings: _w, ...def } = spec;
  await writeFile(path.join(dir, `${spec.name}.md`), agentToMarkdown(def, previousText), 'utf8');
  // The legacy file it replaces, if any: one definition per name.
  await unlink(path.join(dir, `${spec.name}.json`)).catch(() => undefined);
}

export async function createAgentSpec(input: AgentCreateInput, cwd = process.cwd()): Promise<AgentSpec> {
  const name = slugName(input.name);
  if (!name) throw new Error('Agent name must contain letters, numbers, dashes, or underscores');
  const delegate = input.delegate
    ?? (input.canDelegate !== undefined ? delegateFromCanDelegate(input.canDelegate) : 'readonly');
  const instructions = input.instructions?.trim();
  const specBase: Omit<AgentSpec, 'systemPromptXml'> = {
    name,
    description: input.description,
    role: input.role ?? input.description,
    goals: input.goals?.length ? input.goals : instructions ? [] : [
      `Complete tasks matching this agent role: ${input.description}`,
      'Apply relevant skills and report evidence clearly',
      'Escalate blockers with exact missing information',
    ],
    skills: input.skills ?? [],
    tools: input.tools ?? ['Read', 'Grep', 'Glob', 'LS', 'Bash', 'WorkspaceWrite', 'Task'],
    canDelegate: delegate !== 'none',
    delegate,
    reportFormat: input.reportFormat ?? (instructions ? '' : 'Summary, actions taken, files touched, checks run, risks, next actions.'),
    source: input.scope ?? 'project',
    format: 'md',
    ...(input.model ? { model: input.model } : {}),
    ...(instructions ? { instructions } : {}),
    ...(input.disallowedTools?.length ? { disallowedTools: input.disallowedTools } : {}),
    ...(input.mcpServers?.length ? { mcpServers: input.mcpServers } : {}),
    ...(input.autonomy ? { autonomy: input.autonomy } : {}),
    ...(input.budget && Object.keys(input.budget).length ? { budget: input.budget } : {}),
    ...(input.paths?.write?.length ? { paths: { write: input.paths.write } } : {}),
  };
  await assertValid(specBase, cwd);
  const spec = withXml({ ...specBase, systemPromptXml: '' });
  await writeSpecFile(spec, spec.source === 'user' ? userAgentsDir() : projectAgentsDir(cwd));
  return spec;
}

/**
 * Delete an agent the user defined, wherever they defined it.
 *
 * Project *and* user scope, because creating defaults to user and an earlier
 * version could only delete project agents — so the ordinary path produced an
 * agent that could never be removed or edited again. Built-ins are still
 * refused: they come back on the next install, so "deleted" would be a lie.
 */
export async function deleteProjectAgentSpec(name: string, cwd = process.cwd()): Promise<boolean> {
  const slug = slugName(name);
  if (!slug) return false;
  const spec = await getAgentSpec(slug, cwd);
  if (!spec || spec.source === 'builtin') return false;
  const dir = spec.source === 'project' ? projectAgentsDir(cwd) : userAgentsDir();
  let removed = false;
  for (const ext of ['.md', '.json']) {
    try { await unlink(path.join(dir, `${spec.name}${ext}`)); removed = true; } catch { /* that form was absent */ }
  }
  return removed;
}

/** Fields `update` may change. The name is the identity and is not among them. */
export type AgentPatch = Partial<Pick<AgentSpec,
  'description' | 'role' | 'goals' | 'skills' | 'tools' | 'canDelegate' | 'reportFormat' | 'model'
  | 'instructions' | 'disallowedTools' | 'mcpServers' | 'delegate' | 'autonomy' | 'budget' | 'paths'>>;

export async function updateProjectAgentSpec(
  name: string,
  patch: AgentPatch,
  cwd = process.cwd(),
): Promise<AgentSpec> {
  const existing = await getAgentSpec(name, cwd);
  if (!existing) throw new Error(`Agent "${name}" not found`);
  // Built-ins only. A user-scoped agent is one the user made and must be able
  // to change; refusing that made every agent created with the default scope
  // permanently frozen.
  if (existing.source === 'builtin') {
    throw new Error(`"${name}" is built in and cannot be edited. Create your own agent instead.`);
  }
  const { warnings: _warnings, ...base } = existing;
  const merged: AgentSpec = { ...base, ...patch, source: existing.source, systemPromptXml: '' };
  // `canDelegate` alone (the old API) still works; `delegate` wins when both are given.
  if (patch.delegate === undefined && patch.canDelegate !== undefined) merged.delegate = delegateFromCanDelegate(patch.canDelegate);
  merged.canDelegate = (merged.delegate ?? delegateFromCanDelegate(merged.canDelegate)) !== 'none';
  // Empty values clear a field rather than writing an empty one.
  if (!merged.model?.trim()) delete merged.model;
  if (!merged.instructions?.trim()) delete merged.instructions;
  if (!merged.disallowedTools?.length) delete merged.disallowedTools;
  if (!merged.mcpServers?.length) delete merged.mcpServers;
  if (!merged.autonomy) delete merged.autonomy;
  if (merged.budget && !Object.keys(merged.budget).length) delete merged.budget;
  if (!merged.paths?.write?.length) delete merged.paths;
  await assertValid(merged, cwd);
  const updated = withXml({ ...merged, format: 'md' });
  // Rewritten where it already lives, so editing does not silently move an
  // agent from user scope into the project. A legacy JSON agent becomes `.md`
  // here; an existing `.md` keeps the keys this module does not manage.
  const dir = existing.source === 'project' ? projectAgentsDir(cwd) : userAgentsDir();
  const previous = existing.format === 'md'
    ? await readFile(path.join(dir, `${existing.name}.md`), 'utf8').catch(() => undefined)
    : undefined;
  await writeSpecFile(updated, dir, previous);
  return updated;
}

export function formatAgentList(specs: AgentSpec[]): string {
  if (!specs.length) return '(No agents available)';
  return specs.map((s) =>
    `  ${s.name.padEnd(16)} ${s.source.padEnd(7)} ${s.description}`,
  ).join('\n');
}
