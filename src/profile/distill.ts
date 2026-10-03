/**
 * One cheap call that phrases and merges the learner's candidates (ADR 0018).
 *
 * The model is a copy-editor here, not a detective: it receives the
 * deterministic candidates (key, category, sentence, evidence label — all
 * aggregates, already filtered), and may reword them, merge several into
 * one, or drop weak ones, up to {@link MAX_MODEL_FACTS}. It cannot add a
 * fact: a reply line is kept only if it names keys it was given, so whatever
 * it imagines has nowhere to attach. Its text then goes through the same
 * sensitive filter as everything else (store `cleanFactText`), because a
 * prompt asking a model not to infer health or religion is not enforcement.
 *
 * The model comes from the `background` role (src/models/roles.ts). When that
 * role cannot be used — no key, or "keep personal data local" with no local
 * model — the learner runs with no model at all and keeps the candidates'
 * own wording. It never substitutes another model. Reasoning is off and the
 * output small; spend is capped per day by the caller (service.ts).
 *
 * @module profile/distill
 */

import type { AicoSettings } from '../settings.js';
import type { FactCandidate, FactEvidence } from './store.js';
import { isFactCategory } from './sensitive.js';

export const MAX_MODEL_FACTS = 40;
/** Candidates sent per call; the strongest first. */
export const MAX_MODEL_INPUT = 60;
export const PROFILE_MAX_TOKENS = 1_200;
const TIMEOUT_MS = 45_000;

export const PROFILE_SYSTEM = [
  'You edit short notes that describe a software developer, for an assistant that works with them. The notes were derived by code from counts of their own activity.',
  'Reply with JSON only: {"facts":[{"keys":["key", "..."],"category":"...","text":"..."}]}',
  'Rules:',
  `- Rephrase each note as one short, neutral sentence in the third person without a name, under 18 words. At most ${MAX_MODEL_FACTS} facts.`,
  '- You may merge notes that say the same thing; list every merged key in "keys". Never invent a fact: every fact must cite keys you were given.',
  '- category is one of: interests, expertise, stack, work-patterns, communication, likes, dislikes, browsing-style, routines.',
  '- Never mention or guess health, religion, politics, sexuality, ethnicity, money or finances, where they live, family or relationships. Drop a note rather than guess.',
  '- No praise, no judgement, no advice. Describe; do not instruct.',
].join('\n');

export function buildProfileRequest(candidates: readonly FactCandidate[]): string {
  const rows = candidates.slice(0, MAX_MODEL_INPUT).map(c => ({ key: c.key, category: c.category, note: c.text, evidence: c.evidence.map(e => e.label).join('; ') }));
  return `Notes:\n${JSON.stringify(rows)}`;
}

/** Strongest evidence first, so the cut at {@link MAX_MODEL_INPUT} drops the weakest. */
export function rankCandidates(candidates: readonly FactCandidate[]): FactCandidate[] {
  const weight = (c: FactCandidate): number => c.evidence.reduce((n, e) => n + e.count, 0);
  return [...candidates].sort((a, b) => weight(b) - weight(a) || a.key.localeCompare(b.key));
}

/**
 * The reply as candidates. Tolerates fences and prose around the JSON. A fact
 * is kept only when it cites at least one key it was given; its evidence is
 * the union of those keys' evidence; an unknown category falls back to the
 * first key's. Returns undefined when nothing parseable came back.
 */
export function parseProfileReply(reply: string, candidates: readonly FactCandidate[]): FactCandidate[] | undefined {
  const body = reply.replace(/```(?:json)?/gi, '');
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end <= start) return undefined;
  let parsed: unknown;
  try { parsed = JSON.parse(body.slice(start, end + 1)); } catch { return undefined; }
  const list = (parsed as { facts?: unknown }).facts;
  if (!Array.isArray(list)) return undefined;
  const byKey = new Map(candidates.map(c => [c.key, c]));
  const used = new Set<string>();
  const out: FactCandidate[] = [];
  for (const raw of list.slice(0, MAX_MODEL_FACTS)) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    if (typeof r.text !== 'string' || !r.text.trim()) continue;
    const keys = (Array.isArray(r.keys) ? r.keys : typeof r.key === 'string' ? [r.key] : []).map(String).filter(k => byKey.has(k) && !used.has(k));
    if (!keys.length) continue;
    keys.forEach(k => used.add(k));
    const first = byKey.get(keys[0]!)!;
    const evidence: FactEvidence[] = keys.flatMap(k => byKey.get(k)!.evidence);
    out.push({
      key: keys[0]!,
      // A model-chosen category that is not ours is ignored, not mapped: the filter refuses unknown ones anyway.
      category: isFactCategory(r.category) ? r.category : first.category,
      text: r.text,
      evidence,
      ...(keys.length > 1 ? { aliases: keys.slice(1) } : {}),
    });
  }
  return out;
}

export interface CompleteResult { text: string; model: string; provider?: string; costUsd: number }
export type ProfileCompleter = (system: string, user: string, signal: AbortSignal) => Promise<CompleteResult>;

/** The real completer for a resolved `background` role: no tools, no AICO prompt, reasoning off. */
export function roleCompleter(settings: AicoSettings, model: string, provider?: string): ProfileCompleter {
  return async (system, user, signal) => {
    const { selectProvider } = await import('../providers/index.js');
    const { withoutReasoning } = await import('../session/title-service.js');
    const { costFor } = await import('../tokens.js');
    const p = selectProvider(model, withoutReasoning(settings));
    let text = ''; let usage = { inputTokens: 0, outputTokens: 0, cachedTokens: 0 };
    for await (const ev of p.chat({ model, systemPrompt: system, messages: [{ role: 'user', content: user }], tools: [], maxTokens: PROFILE_MAX_TOKENS, signal })) {
      if (ev.type === 'text') text += ev.content;
      else if (ev.type === 'usage') usage = { inputTokens: ev.inputTokens, outputTokens: ev.outputTokens, cachedTokens: ev.cacheReadTokens ?? 0 };
    }
    return { text, model, ...(provider ? { provider } : {}), costUsd: costFor(model, usage, settings) };
  };
}

/** What the call would cost at most, from the price table: the budget check runs before the call. */
export async function estimateCallUsd(settings: AicoSettings, model: string, system: string, user: string): Promise<number> {
  const { costFor, estimateTokens } = await import('../tokens.js');
  return costFor(model, { inputTokens: estimateTokens(system) + estimateTokens(user), outputTokens: PROFILE_MAX_TOKENS, cachedTokens: 0 }, settings);
}

export const DISTILL_TIMEOUT_MS = TIMEOUT_MS;
