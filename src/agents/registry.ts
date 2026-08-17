import path from 'path';
import os from 'os';
import { mkdir, readFile, readdir, unlink, writeFile } from 'fs/promises';
import type { AgentCreateInput, AgentSpec } from './types.js';
import { AGENT_PROMPTS } from './prompts-registry.js';

/**
 * Wrap a registry prompt in the <agent> XML envelope the /agents chat path uses.
 * Combines the structured metadata (role/goals/tools/reportFormat) with the full
 * expert prompt from the unified registry — so /agents chat gets the same
 * staff-level instructions as the Task tool and studio pipeline.
 */
function withRegistryXml(spec: Omit<AgentSpec, 'systemPromptXml'>, registryPrompt: string): AgentSpec {
  return {
    ...spec,
    systemPromptXml: [
      '<agent>',
      `  <name>${spec.name}</name>`,
      `  <role>${spec.role}</role>`,
      `  <expert_directive>\n${registryPrompt}\n  </expert_directive>`,
      '  <goals>',
      ...spec.goals.map((g) => `    <goal>${g}</goal>`),
      '  </goals>',
      '  <allowed_tools>',
      ...spec.tools.map((t) => `    <tool>${t}</tool>`),
      '  </allowed_tools>',
      `  <report_format>${spec.reportFormat}</report_format>`,
      '</agent>',
    ].join('\n'),
  };
}

const BUILTIN_AGENTS: AgentSpec[] = [
  {
    name: 'product-owner',
    description: 'Requirements owner and production readiness gate.',
    role: 'Senior Product Owner and acceptance gate validator',
    goals: [
      'Translate user requirements into measurable acceptance criteria',
      'Reject incomplete implementations with specific missing items',
      'Drive follow-up work until P0 requirements are satisfied',
    ],
    skills: ['requirements-analysis', 'acceptance-criteria', 'quality-gate'],
    tools: ['Read', 'Grep', 'Glob', 'LS', 'Bash', 'Task', 'WorkspaceWrite'],
    canDelegate: true,
    reportFormat: 'APPROVED or REJECTED, followed by missing requirements, evidence, and next actions.',
    systemPromptXml: '',
    source: 'builtin',
  },
  {
    name: 'architect',
    description: 'Architecture, task graph, and implementation strategy.',
    role: 'Principal Software Architect',
    goals: [
      'Design maintainable architecture and task decomposition',
      'Identify integration boundaries and risks',
      'Produce implementation-ready plans',
    ],
    skills: ['architecture', 'task-breakdown', 'risk-analysis'],
    tools: ['Read', 'Grep', 'Glob', 'LS', 'WorkspaceWrite', 'Task'],
    canDelegate: true,
    reportFormat: 'Architecture decisions, task graph, risks, and exact files/modules to touch.',
    systemPromptXml: '',
    source: 'builtin',
  },
  {
    name: 'backend',
    description: 'Production backend implementation.',
    role: 'Senior Backend Engineer',
    goals: [
      'Implement APIs, services, persistence, validation, and auth safely',
      'Write tests for business logic and endpoints',
      'Keep security basics in place: validation, authz, secrets hygiene, rate limits where needed',
    ],
    skills: ['backend-engineering', 'api-design', 'security-basics', 'testing'],
    tools: ['Read', 'Write', 'Edit', 'Grep', 'Glob', 'LS', 'Bash', 'WorkspaceWrite'],
    canDelegate: false,
    reportFormat: 'Files changed, behavior implemented, tests run, remaining risks.',
    systemPromptXml: '',
    source: 'builtin',
  },
  {
    name: 'frontend',
    description: 'Production frontend implementation and UX.',
    role: 'Senior Frontend Engineer',
    goals: [
      'Implement accessible, responsive, polished UI flows',
      'Follow existing design system and component patterns',
      'Verify TypeScript, build, and core UI states',
    ],
    skills: ['frontend-engineering', 'accessibility', 'responsive-ui', 'testing'],
    tools: ['Read', 'Write', 'Edit', 'Grep', 'Glob', 'LS', 'Bash', 'WorkspaceWrite'],
    canDelegate: false,
    reportFormat: 'Files changed, UI states covered, checks run, remaining UX risks.',
    systemPromptXml: '',
    source: 'builtin',
  },
  {
    name: 'qa',
    description: 'QA, test automation, browser checks, and defect reporting.',
    role: 'Senior QA Engineer',
    goals: [
      'Create and run meaningful automated tests',
      'Exercise critical user flows through available browser MCP tools',
      'Report reproducible defects with evidence',
    ],
    skills: ['qa', 'test-automation', 'playwright', 'defect-reporting'],
    tools: ['Read', 'Write', 'Edit', 'Grep', 'Glob', 'LS', 'Bash', 'WorkspaceWrite', 'MCP'],
    canDelegate: false,
    reportFormat: 'Pass/fail summary, commands run, browser flows tested, defects with repro steps.',
    systemPromptXml: '',
    source: 'builtin',
  },
  {
    name: 'security',
    description: 'Defensive security review.',
    role: 'Application Security Reviewer',
    goals: [
      'Find practical security flaws and dependency risks',
      'Prioritize findings by severity and exploitability',
      'Recommend concrete fixes without destructive actions',
    ],
    skills: ['security-review', 'owasp', 'dependency-audit'],
    tools: ['Read', 'Grep', 'Glob', 'LS', 'Bash', 'WorkspaceWrite'],
    canDelegate: false,
    reportFormat: 'Severity, file:line, impact, recommendation, SECURITY SCORE.',
    systemPromptXml: '',
    source: 'builtin',
  },
];

/**
 * Map builtin agent names to their registry prompt. The 'security' spec maps to
 * the security-audit registry prompt (the strongest security reviewer). Specs not
 * in this map fall back to the generic defaultXml.
 */
const BUILTIN_REGISTRY_PROMPTS: Record<string, string> = {
  'product-owner': AGENT_PROMPTS['product-owner'],
  'architect': AGENT_PROMPTS.architect,
  'backend': AGENT_PROMPTS.backend,
  'frontend': AGENT_PROMPTS.frontend,
  'qa': AGENT_PROMPTS.qa,
  'security': AGENT_PROMPTS['security-audit'],
};

/** Apply the unified registry prompt to builtin specs that have one. */
function builtinsWithRegistryXml(): AgentSpec[] {
  return BUILTIN_AGENTS.map((spec) => {
    const prompt = BUILTIN_REGISTRY_PROMPTS[spec.name];
    if (!prompt) return withXml(spec);
    return withRegistryXml(spec, prompt);
  });
}

function slugName(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
}

function userAgentsDir(): string {
  return path.join(os.homedir(), '.aico', 'agents');
}

function projectAgentsDir(cwd = process.cwd()): string {
  return path.join(cwd, '.aico', 'agents');
}

function defaultXml(input: Omit<AgentSpec, 'systemPromptXml'>): string {
  return [
    '<agent>',
    `  <name>${input.name}</name>`,
    `  <role>${input.role}</role>`,
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

function withXml(spec: AgentSpec): AgentSpec {
  return spec.systemPromptXml ? spec : { ...spec, systemPromptXml: defaultXml(spec) };
}

async function readSpecsFromDir(dir: string, source: AgentSpec['source']): Promise<AgentSpec[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    const specs: AgentSpec[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      try {
        const raw = await readFile(path.join(dir, entry.name), 'utf8');
        const parsed = JSON.parse(raw) as AgentSpec;
        specs.push(withXml({ ...parsed, source }));
      } catch {
        // Ignore malformed agent files; /agents should remain usable.
      }
    }
    return specs;
  } catch {
    return [];
  }
}

export async function listAgentSpecs(cwd = process.cwd()): Promise<AgentSpec[]> {
  const user = await readSpecsFromDir(userAgentsDir(), 'user');
  const project = await readSpecsFromDir(projectAgentsDir(cwd), 'project');
  const all = [...builtinsWithRegistryXml(), ...user, ...project];
  const byName = new Map<string, AgentSpec>();
  for (const spec of all) byName.set(spec.name, spec);
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export async function getAgentSpec(name: string, cwd = process.cwd()): Promise<AgentSpec | undefined> {
  const slug = slugName(name);
  const specs = await listAgentSpecs(cwd);
  return specs.find((s) => s.name === slug || s.name === name);
}

export async function createAgentSpec(input: AgentCreateInput, cwd = process.cwd()): Promise<AgentSpec> {
  const name = slugName(input.name);
  if (!name) throw new Error('Agent name must contain letters, numbers, dashes, or underscores');
  const specBase: Omit<AgentSpec, 'systemPromptXml'> = {
    name,
    description: input.description,
    role: input.role ?? input.description,
    goals: input.goals?.length ? input.goals : [
      `Complete tasks matching this agent role: ${input.description}`,
      'Apply relevant skills and report evidence clearly',
      'Escalate blockers with exact missing information',
    ],
    skills: input.skills ?? [],
    tools: input.tools ?? ['Read', 'Grep', 'Glob', 'LS', 'Bash', 'WorkspaceWrite', 'Task'],
    canDelegate: input.canDelegate ?? true,
    reportFormat: input.reportFormat ?? 'Summary, actions taken, files touched, checks run, risks, next actions.',
    source: input.scope ?? 'project',
    ...(input.model ? { model: input.model } : {}),
  };
  const spec = withXml({ ...specBase, systemPromptXml: defaultXml(specBase) });
  const dir = spec.source === 'user' ? userAgentsDir() : projectAgentsDir(cwd);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, `${name}.json`), JSON.stringify(spec, null, 2), 'utf8');
  return spec;
}

export async function deleteProjectAgentSpec(name: string, cwd = process.cwd()): Promise<boolean> {
  const slug = slugName(name);
  if (!slug) return false;
  const spec = await getAgentSpec(slug, cwd);
  if (!spec || spec.source !== 'project') return false;
  try {
    await unlink(path.join(projectAgentsDir(cwd), `${spec.name}.json`));
    return true;
  } catch {
    return false;
  }
}

export async function updateProjectAgentSpec(
  name: string,
  patch: Partial<Pick<AgentSpec, 'description' | 'role' | 'goals' | 'skills' | 'tools' | 'canDelegate' | 'reportFormat' | 'model'>>,
  cwd = process.cwd(),
): Promise<AgentSpec> {
  const existing = await getAgentSpec(name, cwd);
  if (!existing) throw new Error(`Agent "${name}" not found`);
  if (existing.source !== 'project') throw new Error(`Only project agents can be edited. "${name}" is ${existing.source}.`);
  const updated = withXml({
    ...existing,
    ...patch,
    source: 'project',
    systemPromptXml: '',
  });
  const dir = projectAgentsDir(cwd);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, `${updated.name}.json`), JSON.stringify(updated, null, 2), 'utf8');
  return updated;
}

export function formatAgentList(specs: AgentSpec[]): string {
  if (!specs.length) return '(No agents available)';
  return specs.map((s) =>
    `  ${s.name.padEnd(16)} ${s.source.padEnd(7)} ${s.description}`,
  ).join('\n');
}
