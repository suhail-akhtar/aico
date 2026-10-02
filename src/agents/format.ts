/**
 * Agent files: a superset of Claude Code's subagent Markdown format.
 *
 * WHY MARKDOWN. Agents were JSON with a generated XML prompt. Claude Code,
 * Copilot and the agentskills ecosystem settled on a Markdown file whose
 * frontmatter is the definition and whose body is the instructions — which is
 * what a person wants to read and edit. So `~/.aico/agents/<name>.md` and
 * `<project>/.aico/agents/<name>.md` are the format now (design §5.4); a legacy
 * `<name>.json` is still read, and is rewritten as `.md` the first time it is
 * saved.
 *
 * Fields AICO reads beyond Claude's (`name`, `description`, `tools`,
 * `disallowedTools`, `model`, `skills`, `mcpServers`, `permissionMode`):
 * `delegate`, `autonomy`, `budget`, `paths`. Unknown keys are kept on rewrite
 * (the frontmatter module keeps raw text), so a Claude file round-trips.
 *
 * IMPORT NEVER RAISES. A file brought in from `.claude/agents` or
 * `.github/agents` is untrusted text: `permissionMode: bypassPermissions` or
 * `dontAsk` is ignored with a warning, never mapped upward; `Bash(<prefix>)`
 * entries (command narrowing, not built yet) are dropped with a warning — an
 * agent narrowed to nothing is safer than one widened to every command;
 * Claude's model aliases (`sonnet`, `opus`, `haiku`, `inherit`) become "the
 * session's model". Parsing is the in-house YAML subset (owner decision Q1).
 *
 * @module agents/format
 */

import {
  asList, asText, composeMarkdown, parseFrontmatter, updateFrontmatter,
  type FmMap, type FmValue,
} from '../skills/frontmatter.js';
import type { AgentBudget, AgentSpec, AutonomyLevel, DelegateRule } from './types.js';

/** What reading a file produced: the definition, and what to tell the person. */
export interface ParsedAgentFile {
  spec?: Omit<AgentSpec, 'systemPromptXml' | 'source'>;
  errors: string[];
  warnings: string[];
}

const PERMISSION_MODES: Record<string, AutonomyLevel | null> = {
  plan: 'L0', default: 'L1', acceptedits: 'L2', auto: 'L3',
  // Never mapped: an imported file must not raise autonomy.
  bypasspermissions: null, dontask: null,
};

/** Claude's model aliases name Anthropic models a provider here may not serve. */
const MODEL_ALIASES = new Set(['inherit', 'sonnet', 'opus', 'haiku', 'fable']);

function num(v: FmValue | undefined): number | undefined {
  const t = asText(v);
  if (t === undefined || t.trim() === '') return undefined;
  const n = Number(t);
  return Number.isFinite(n) ? n : NaN;
}

function readDelegate(v: FmValue | undefined, warnings: string[]): DelegateRule | undefined {
  if (v === undefined || v === null) return undefined;
  if (Array.isArray(v)) return asList(v) ?? [];
  const t = String(asText(v) ?? '').trim().toLowerCase();
  if (t === 'none' || t === 'false' || t === 'no') return 'none';
  if (t === 'readonly' || t === 'read-only') return 'readonly';
  // `true` was the legacy canDelegate's yes; it becomes read-only so a
  // converted file never silently widens (design §5.4).
  if (t === 'true' || t === 'yes') return 'readonly';
  const list = asList(v);
  if (list?.length) return list;
  warnings.push(`delegate "${t}" is not none, readonly or a list of agent names — read as none.`);
  return 'none';
}

/**
 * The short label the runtime block lists agents by (`name(role)`, in the
 * cached prompt prefix): the description's first clause, at most 60
 * characters, so a long "Use when …" description costs nothing per request.
 */
export function shortRole(description: string): string {
  const first = description.split(/ — |\. |; |: /)[0]!.trim().replace(/\.$/, '');
  if (first.length <= 60) return first;
  const cut = first.slice(0, 60);
  return `${cut.slice(0, cut.lastIndexOf(' ') > 30 ? cut.lastIndexOf(' ') : 60)}…`;
}

/** Turn the legacy boolean into the rule (true → readonly, per design §5.4). */
export function delegateFromCanDelegate(canDelegate: boolean | undefined): DelegateRule {
  return canDelegate === false ? 'none' : 'readonly';
}

/** Read an agent `.md` (AICO's own or Claude Code's / Copilot's). */
export function parseAgentMarkdown(text: string, opts: { fallbackName?: string; imported?: boolean } = {}): ParsedAgentFile {
  const errors: string[] = [];
  const warnings: string[] = [];
  const fm = parseFrontmatter(text);
  if (!fm.hasBlock) return { errors: ['no frontmatter — an agent file starts with a --- block holding at least name and description'], warnings };
  errors.push(...fm.errors);
  const d = fm.data;

  const name = (asText(d.name) ?? opts.fallbackName ?? '').trim();
  const description = (asText(d.description) ?? '').trim();
  if (!name) errors.push('name is missing — add "name: my-agent" to the frontmatter');

  let tools = asList(d.tools);
  let disallowedTools = asList(d.disallowedTools ?? d['disallowed-tools']);
  const narrow = (list: string[] | undefined, field: string): string[] | undefined => {
    if (!list) return list;
    const kept = list.filter(t => !/^Bash\(.+\)$/.test(t));
    const dropped = list.filter(t => /^Bash\(.+\)$/.test(t));
    if (dropped.length && field === 'tools') {
      warnings.push(`${dropped.join(', ')} dropped: command-prefix narrowing is not supported yet, so the agent gets no Bash from these entries. Add "Bash" yourself if it should run any command.`);
    }
    return kept;
  };
  tools = narrow(tools, 'tools');
  disallowedTools = narrow(disallowedTools, 'disallowedTools');

  let model = asText(d.model)?.trim();
  if (model && MODEL_ALIASES.has(model.toLowerCase())) {
    if (model.toLowerCase() !== 'inherit') warnings.push(`model "${model}" is a Claude alias — it runs on the session's model here. Set a model id to pin one.`);
    model = undefined;
  }

  let autonomy = asText(d.autonomy)?.trim().toUpperCase() as AutonomyLevel | undefined;
  if (autonomy && !/^L[0-4]$/.test(autonomy)) {
    errors.push(`autonomy "${asText(d.autonomy)}" is not one of L0, L1, L2, L3, L4`);
    autonomy = undefined;
  }
  const mode = asText(d.permissionMode)?.trim();
  if (mode) {
    const mapped = PERMISSION_MODES[mode.toLowerCase()];
    if (mapped === null) {
      warnings.push(`permissionMode "${mode}" ignored: an agent file never raises autonomy. Choose the agent's ceiling with "autonomy" (L0–L3).`);
    } else if (mapped === undefined) {
      warnings.push(`permissionMode "${mode}" is not one AICO knows — ignored.`);
    } else if (!autonomy) {
      autonomy = mapped;
    }
  }

  let budget: AgentBudget | undefined;
  if (d.budget && typeof d.budget === 'object' && !Array.isArray(d.budget)) {
    const b = d.budget as FmMap;
    budget = {};
    for (const key of ['maxUsd', 'maxIterations', 'maxMinutes'] as const) {
      const n = num(b[key]);
      if (n === undefined) continue;
      if (Number.isNaN(n) || n <= 0) errors.push(`budget.${key} must be a positive number`);
      else budget[key] = n;
    }
  } else if (d.budget !== undefined && d.budget !== null) {
    errors.push('budget must be a map, e.g. budget: { maxUsd: 1, maxIterations: 40, maxMinutes: 20 }');
  }

  let write: string[] | undefined;
  if (d.paths && typeof d.paths === 'object' && !Array.isArray(d.paths)) {
    write = asList((d.paths as FmMap).write);
  } else if (d.paths !== undefined && d.paths !== null) {
    errors.push('paths must be a map, e.g. paths: { write: ["src/**"] }');
  }

  const delegate = readDelegate(d.delegate, warnings);
  const instructions = fm.body.replace(/^\n+/, '').replace(/\s+$/, '');
  const skills = asList(d.skills) ?? [];
  const mcpServers = asList(d.mcpServers);

  if (errors.length && !name) return { errors, warnings };
  return {
    spec: {
      name,
      description,
      role: shortRole(description),
      goals: [],
      skills,
      tools: tools ?? [],
      canDelegate: delegate ? delegate !== 'none' : true,
      reportFormat: asText(d.reportFormat)?.trim() ?? '',
      ...(model ? { model } : {}),
      ...(instructions ? { instructions } : {}),
      ...(disallowedTools?.length ? { disallowedTools } : {}),
      ...(mcpServers?.length ? { mcpServers } : {}),
      // Claude's default is "may delegate"; ours for an unspecified file is
      // read-only delegation, the same as a legacy `canDelegate: true`.
      delegate: delegate ?? 'readonly',
      ...(autonomy ? { autonomy } : {}),
      ...(budget && Object.keys(budget).length ? { budget } : {}),
      ...(write?.length ? { paths: { write } } : {}),
      format: 'md',
    },
    errors,
    warnings,
  };
}

/** The frontmatter map for a definition, in a stable key order. */
function frontmatterOf(spec: Partial<AgentSpec>): FmMap {
  const d: FmMap = { name: spec.name ?? '', description: spec.description ?? '' };
  if (spec.model) d.model = spec.model;
  if (spec.tools?.length) d.tools = [...spec.tools];
  if (spec.disallowedTools?.length) d.disallowedTools = [...spec.disallowedTools];
  if (spec.skills?.length) d.skills = [...spec.skills];
  if (spec.mcpServers?.length) d.mcpServers = [...spec.mcpServers];
  const delegate = spec.delegate ?? delegateFromCanDelegate(spec.canDelegate);
  d.delegate = Array.isArray(delegate) ? [...delegate] : delegate;
  if (spec.autonomy) d.autonomy = spec.autonomy;
  if (spec.budget && Object.keys(spec.budget).length) {
    const b: FmMap = {};
    for (const [k, v] of Object.entries(spec.budget)) if (typeof v === 'number') b[k] = String(v);
    d.budget = b;
  }
  if (spec.paths?.write?.length) d.paths = { write: [...spec.paths.write] };
  if (spec.reportFormat && !spec.instructions) d.reportFormat = spec.reportFormat;
  return d;
}

/**
 * The body a legacy definition becomes: its role, goals and report format as
 * plain instructions, so converting a JSON agent loses nothing.
 */
export function legacyBody(spec: Pick<AgentSpec, 'role' | 'goals' | 'reportFormat'>): string {
  return [
    spec.role ? `You are a ${spec.role.replace(/^(a|an) /i, '')}.` : '',
    spec.goals?.length ? `\nGoals:\n${spec.goals.map(g => `- ${g}`).join('\n')}` : '',
    spec.reportFormat ? `\nReport format: ${spec.reportFormat}` : '',
  ].filter(Boolean).join('\n').trim();
}

/** Write a definition as an agent `.md`. `previous` keeps keys this module does not manage. */
export function agentToMarkdown(spec: Partial<AgentSpec>, previous?: string): string {
  const body = spec.instructions ?? legacyBody({ role: spec.role ?? '', goals: spec.goals ?? [], reportFormat: spec.reportFormat ?? '' });
  const data = frontmatterOf(spec);
  if (previous) {
    // Managed keys are replaced (removed when unset); everything else stays verbatim.
    const managed = ['name', 'description', 'model', 'tools', 'disallowedTools', 'skills', 'mcpServers',
      'delegate', 'autonomy', 'budget', 'paths', 'reportFormat', 'permissionMode'];
    const patch: Record<string, FmValue | undefined> = {};
    for (const k of managed) patch[k] = data[k];
    const head = updateFrontmatter(previous, patch);
    const close = head.indexOf('\n---', 3);
    return `${head.slice(0, close + 4)}\n${body}\n`;
  }
  return composeMarkdown(data, `\n${body}\n`);
}
