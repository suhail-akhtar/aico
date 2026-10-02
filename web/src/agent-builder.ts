/**
 * The agent builder's state, as plain functions (design §7.6).
 *
 * The form holds text; the engine holds the rules. This module turns one into
 * the other and back — draft from a saved agent, the `AgentManage` input from
 * a draft, a duplicate's draft — and reads the engine's `validate` answer.
 * Nothing here validates: §7.8 says one validator, in the engine, and the
 * builders call it on a debounce. Kept free of React and of `api` so the
 * desktop and web builders share it and `test:web:unit` can test it.
 *
 * @module agent-builder
 */

import type { AgentCheck, AgentSpec } from './api';

export type DelegateMode = 'none' | 'readonly' | 'named';

/** Everything the builder edits, as the form holds it. */
export interface AgentDraft {
  name: string;
  description: string;
  instructions: string;
  model: string;
  tools: string[];
  /** Empty means every tool (no allow-list). */
  allTools: boolean;
  disallowedTools: string[];
  skills: string[];
  mcpServers: string[];
  delegate: DelegateMode;
  delegateTo: string[];
  autonomy: '' | 'L0' | 'L1' | 'L2' | 'L3' | 'L4';
  maxUsd: string;
  maxIterations: string;
  maxMinutes: string;
  writePaths: string;
}

/** A new agent's starting point: read-only tools, no delegation, L3 with a budget. */
export const EMPTY_DRAFT: AgentDraft = {
  name: '', description: '', instructions: '', model: '',
  tools: ['Read', 'Grep', 'Glob', 'LS'], allTools: false, disallowedTools: [], skills: [], mcpServers: [],
  delegate: 'none', delegateTo: [], autonomy: 'L3', maxUsd: '1', maxIterations: '40', maxMinutes: '', writePaths: '',
};

/** A legacy agent's role and goals, as the instructions it migrates to. */
function legacyInstructions(a: AgentSpec): string {
  return [
    a.role ? `You are a ${a.role.replace(/^(a|an) /i, '')}.` : '',
    a.goals?.length ? `\nGoals:\n${a.goals.map(g => `- ${g}`).join('\n')}` : '',
  ].filter(Boolean).join('\n').trim();
}

export function draftOf(a: AgentSpec): AgentDraft {
  const delegate = a.delegate ?? (a.canDelegate ? 'readonly' : 'none');
  return {
    name: a.name,
    description: a.description ?? '',
    instructions: a.instructions ?? legacyInstructions(a),
    model: a.model ?? '',
    tools: a.tools ?? [],
    allTools: !a.tools?.length,
    disallowedTools: a.disallowedTools ?? [],
    skills: a.skills ?? [],
    mcpServers: a.mcpServers ?? [],
    delegate: Array.isArray(delegate) ? 'named' : delegate,
    delegateTo: Array.isArray(delegate) ? delegate : [],
    autonomy: a.autonomy ?? '',
    maxUsd: a.budget?.maxUsd !== undefined ? String(a.budget.maxUsd) : '',
    maxIterations: a.budget?.maxIterations !== undefined ? String(a.budget.maxIterations) : '',
    maxMinutes: a.budget?.maxMinutes !== undefined ? String(a.budget.maxMinutes) : '',
    writePaths: (a.paths?.write ?? []).join('\n'),
  };
}

/** A copy to save under a new name (built-ins included). */
export function duplicateDraft(a: AgentSpec, taken: readonly string[]): AgentDraft {
  let name = `${a.name}-copy`;
  for (let i = 2; taken.includes(name); i++) name = `${a.name}-copy-${i}`;
  return { ...draftOf(a), name };
}

/** Comma or newline separated, empties dropped. */
export function splitList(raw: string): string[] {
  return raw.split(/[,\n]/).map(s => s.trim()).filter(Boolean);
}

/** A number field: blank is unset; anything else is passed through for the engine to judge. */
function num(raw: string): number | undefined {
  if (!raw.trim()) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : NaN;
}

/**
 * The `AgentManage` fields for a draft. Every field is sent (blank clears it
 * on update), so the engine judges exactly what is on screen.
 */
export function inputOf(d: AgentDraft): Record<string, unknown> {
  const budget: Record<string, number> = {};
  for (const [k, v] of [['maxUsd', d.maxUsd], ['maxIterations', d.maxIterations], ['maxMinutes', d.maxMinutes]] as const) {
    const n = num(v);
    if (n !== undefined) budget[k] = n;
  }
  return {
    name: d.name.trim(),
    description: d.description.trim(),
    instructions: d.instructions,
    model: d.model.trim(),
    tools: d.allTools ? [] : d.tools,
    disallowedTools: d.disallowedTools,
    skills: d.skills,
    mcpServers: d.mcpServers,
    delegate: d.delegate === 'named' ? d.delegateTo : d.delegate,
    autonomy: d.autonomy,
    budget,
    paths: { write: splitList(d.writePaths) },
  };
}

/** Add or remove one entry. */
export function toggle(list: readonly string[], value: string): string[] {
  return list.includes(value) ? list.filter(x => x !== value) : [...list, value];
}

/** The engine's `validate` answer, from the manage route's text. A reply that is not JSON is an error. */
export function readCheck(result: string | undefined, error?: string): AgentCheck {
  if (!result) return { ok: false, errors: [error ?? 'The engine did not answer.'], warnings: [] };
  try {
    const parsed = JSON.parse(result) as AgentCheck;
    return { ok: Boolean(parsed.ok), errors: parsed.errors ?? [], warnings: parsed.warnings ?? [], ...(parsed.summary ? { summary: parsed.summary } : {}) };
  } catch {
    return { ok: false, errors: [result], warnings: [] };
  }
}

/** Which form field an engine message is about, so it can be shown at the field (§7.8). */
export function fieldOf(message: string): keyof AgentDraft | 'other' {
  const m = /^(name|description|tools|disallowedTools|skills|mcpServers|delegate|autonomy|budget|paths\.write|instructions)\b/.exec(message);
  if (!m) return /^instructions are/.test(message) ? 'instructions' : 'other';
  const key = m[1]!;
  if (key === 'budget') return 'maxUsd';
  if (key === 'paths.write') return 'writePaths';
  return key as keyof AgentDraft;
}

/** One line per autonomy level, for the picker. Words, never colour alone. */
export const AUTONOMY_CHOICES: ReadonlyArray<{ id: AgentDraft['autonomy']; label: string; hint: string }> = [
  { id: 'L0', label: 'L0 Plan', hint: 'reads only' },
  { id: 'L1', label: 'L1 Ask', hint: 'asks before every change' },
  { id: 'L2', label: 'L2 Edits', hint: 'edits files freely, asks before commands' },
  { id: 'L3', label: 'L3 Auto', hint: 'runs without asking (destructive tools still ask)' },
  { id: 'L4', label: 'L4 Unattended', hint: 'needs certification — not available yet' },
];
