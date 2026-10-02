/**
 * Where an agent's golden tasks come from, and whether they are usable.
 *
 * A person's agent keeps them beside its file — `<agents dir>/<name>.evals/
 * evals.json` — so a project can commit `.aico/agents/<name>.md` and its
 * `.evals/` together and the team certifies against the same tasks (design
 * §6.4). The built-ins' tasks are in code (`builtin-tasks.ts`).
 *
 * The file is `{ "threshold"?: 0..1, "tasks": AgentEvalTask[] }`. Problems are
 * reported, not guessed around: an unknown check kind, a task with no checks,
 * or a critical task whose only check is the LLM judge (design §6.2: the
 * judge is never the only check on a critical task) make the set unusable,
 * and certification says why instead of running it.
 *
 * The raw text is returned too: it is part of the certificate hash, so
 * editing an agent's tests is a change like editing the agent.
 *
 * @module evals/tasks
 */

import fs from 'fs';
import path from 'path';
import { agentFilePath } from '../agents/registry.js';
import type { AgentSpec } from '../agents/types.js';
import { BUILTIN_AGENT_TASKS } from './builtin-tasks.js';
import type { AgentCheck, AgentEvalTask } from './types.js';

export const DEFAULT_THRESHOLD = 0.8;

const KINDS = new Set<AgentCheck['kind']>([
  'output-matches', 'output-lacks', 'file-exists', 'file-matches', 'no-file-changed', 'max-tool-calls',
  'tool-called', 'tool-not-called', 'tool-order', 'approval-requested', 'no-workaround', 'scope',
  'secret-hygiene', 'command', 'mutation', 'judge',
]);

export interface GoldenTasks {
  tasks: AgentEvalTask[];
  threshold: number;
  /** Where they came from, for the report. */
  source: string;
  /** Hashed into the certificate. */
  text: string;
  problems: string[];
}

/** `<agents dir>/<name>.evals/evals.json` for a file agent; undefined for a built-in. */
export function evalsFileFor(spec: Pick<AgentSpec, 'name' | 'source' | 'format'>, cwd: string): string | undefined {
  const file = agentFilePath(spec, cwd);
  return file ? path.join(path.dirname(file), `${spec.name}.evals`, 'evals.json') : undefined;
}

/** Problems with one task, phrased as the fix. */
export function taskProblems(t: Partial<AgentEvalTask>, i: number): string[] {
  const at = `tasks[${i}]${t.id ? ` (${t.id})` : ''}`;
  const out: string[] = [];
  if (!t.id || typeof t.id !== 'string') out.push(`${at}: needs an "id"`);
  if (!t.prompt || typeof t.prompt !== 'string') out.push(`${at}: needs a "prompt" — what the person asks the agent`);
  if (!Array.isArray(t.checks) || t.checks.length === 0) out.push(`${at}: needs at least one check`);
  for (const c of t.checks ?? []) {
    if (!c || !KINDS.has(c.kind)) out.push(`${at}: unknown check kind "${String((c as { kind?: unknown })?.kind)}"`);
    else if (!c.why) out.push(`${at}: every check needs a "why" (what a miss means)`);
  }
  if (t.critical && (t.checks ?? []).length > 0 && (t.checks ?? []).every(c => c?.kind === 'judge')) {
    out.push(`${at}: a critical task cannot rest on the LLM judge alone — add a deterministic check`);
  }
  if (t.files && (typeof t.files !== 'object' || Object.keys(t.files).some(k => path.isAbsolute(k) || k.split(/[\\/]/).includes('..')))) {
    out.push(`${at}: fixture paths must be relative and stay inside the workspace`);
  }
  return out;
}

/** The agent's golden tasks. A file agent without an evals file has none (safety probes still run). */
export function loadGoldenTasks(spec: Pick<AgentSpec, 'name' | 'source' | 'format'>, cwd: string): GoldenTasks {
  if (spec.source === 'builtin') {
    const b = BUILTIN_AGENT_TASKS[spec.name];
    const tasks = b?.tasks ?? [];
    return { tasks, threshold: b?.threshold ?? DEFAULT_THRESHOLD, source: 'built in', text: JSON.stringify(b ?? {}), problems: [] };
  }
  const file = evalsFileFor(spec, cwd)!;
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch {
    return { tasks: [], threshold: DEFAULT_THRESHOLD, source: `${file} (none)`, text: '', problems: [] };
  }
  let parsed: { threshold?: unknown; tasks?: unknown };
  try { parsed = JSON.parse(text) as typeof parsed; } catch (err) {
    return { tasks: [], threshold: DEFAULT_THRESHOLD, source: file, text, problems: [`${file} is not valid JSON: ${(err as Error).message}`] };
  }
  const tasks = Array.isArray(parsed.tasks) ? parsed.tasks as AgentEvalTask[] : [];
  const problems = Array.isArray(parsed.tasks) ? tasks.flatMap(taskProblems) : [`${file}: "tasks" must be a list`];
  const ids = tasks.map(t => t.id);
  const dup = ids.find((id, i) => ids.indexOf(id) !== i);
  if (dup) problems.push(`${file}: task id "${dup}" appears twice`);
  const th = typeof parsed.threshold === 'number' && parsed.threshold > 0 && parsed.threshold <= 1 ? parsed.threshold : DEFAULT_THRESHOLD;
  return { tasks, threshold: th, source: file, text, problems };
}
