/**
 * The LLM judge, for the prose a regex cannot read (design §6.2).
 *
 * WHY IT IS FENCED IN. A judge drifts between runs, costs a call per trial,
 * and invites optimising for the judge instead of the task — which is why the
 * skill evals never had one. It is here only for what has no deterministic
 * reading (is this report ordered by severity and does it say how to fix the
 * finding?), under rules that keep it honest:
 *
 *  - a fixed rubric written by a person, answered PASS or FAIL with a reason;
 *  - a different model from the agent's by default (the owner's choice,
 *    §12a: `deepseek-v4-pro`), so a model does not grade its own family's
 *    habits as virtues;
 *  - the caller checks the money cap before the call, and the judge's cost
 *    counts against it;
 *  - it is never the only check on a critical task (`certify.ts` refuses a
 *    task set that does that), and a judge that cannot be parsed is a FAIL,
 *    never a pass.
 *
 * Variance shows up as a disagreement between trials of the same task; the
 * certificate keeps each trial's verdict and reason so it can be read.
 *
 * @module evals/judge
 */

import type { AicoSettings } from '../settings.js';
import type { ProviderAPI } from '../providers/types.js';
import { createTokenTracker } from '../tokens.js';
import { localOnlyRefusal, recordRoleSpend, resolveRole } from '../models/roles.js';

export const DEFAULT_JUDGE_MODEL = 'deepseek-v4-pro';

/**
 * The judge when none is named: the `judge` model role (ADR 0017) —
 * `models.roles.judge`, else `deepseek-v4-pro` where a key reaches it, else
 * the agent's own model (allowed, and reported as not independent).
 */
export function defaultJudgeModel(settings: AicoSettings | undefined, agentModel: string): string {
  const role = resolveRole('judge', { settings, mainModel: agentModel });
  return role.ok ? role.model : DEFAULT_JUDGE_MODEL;
}

export interface JudgeVerdict {
  pass: boolean;
  reason: string;
  costUsd: number;
}

const SYSTEM = [
  'You grade one answer against a rubric. You are strict and literal: the answer passes only if it meets',
  'every PASS condition and none of the FAIL conditions. Judge only what is written in the answer.',
  'Reply with JSON only: {"verdict": "PASS" | "FAIL", "reason": "<one sentence>"}',
].join(' ');

/** Parse a judge reply; anything unreadable is a FAIL. Exported for the tests. */
export function parseVerdict(text: string): { pass: boolean; reason: string } {
  try {
    const json = /\{[\s\S]*\}/.exec(text.replace(/```(?:json)?/g, ''))?.[0] ?? '';
    const parsed = JSON.parse(json) as { verdict?: unknown; reason?: unknown };
    const verdict = String(parsed.verdict ?? '').trim().toUpperCase();
    if (verdict !== 'PASS' && verdict !== 'FAIL') return { pass: false, reason: 'the judge gave no PASS/FAIL verdict' };
    return { pass: verdict === 'PASS', reason: String(parsed.reason ?? '').slice(0, 300) };
  } catch {
    return { pass: false, reason: 'the judge reply was not JSON' };
  }
}

export async function judge(o: {
  rubric: string;
  task: string;
  answer: string;
  model: string;
  settings: AicoSettings;
  provider?: ProviderAPI;
  signal?: AbortSignal;
}): Promise<JudgeVerdict> {
  // Keep-local (models/roles): the answer under review is the person's work,
  // so a judge off this machine is never asked; the check fails and says why.
  const refusal = localOnlyRefusal('judge', o.model, o.settings);
  if (refusal) return { pass: false, reason: `not judged: ${refusal}`, costUsd: 0 };
  // Lazy for the reason optimize.ts gives: the provider registry loads every adapter.
  const provider = o.provider ?? (await import('../providers/index.js')).selectProvider(o.model, o.settings);
  const tracker = createTokenTracker();
  let text = '';
  // Thinking off and room to answer: on a thinking model (deepseek-v4-pro) reasoning tokens come out of
  // maxTokens, and at 300 the judge spent them all thinking and returned no verdict — every judged check failed.
  const { runInContext, currentRunContext } = await import('../run-context.js');
  const ctx = currentRunContext();
  await runInContext({ ...(ctx ?? {}), cwd: ctx?.cwd ?? process.cwd(), effort: 'off' }, async () => {
  for await (const event of provider.chat({
    model: o.model,
    systemPrompt: SYSTEM,
    messages: [{
      role: 'user',
      content: `Rubric:\n${o.rubric}\n\nThe request the answer responds to:\n${o.task}\n\nThe answer:\n${o.answer.slice(0, 12_000)}`,
    }],
    tools: [],
    maxTokens: 1500,
    ...(o.signal ? { signal: o.signal } : {}),
  })) {
    if (event.type === 'text') text += event.content;
    else if (event.type === 'usage') tracker.add(event.inputTokens, event.outputTokens, event.cacheReadTokens ?? 0, event.cacheWriteTokens ?? 0);
  }
  });
  const costUsd = tracker.estimateCost(o.model, o.settings);
  recordRoleSpend('judge', costUsd);
  return { ...parseVerdict(text), costUsd };
}
