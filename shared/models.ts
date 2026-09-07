/**
 * The cheap model per provider family — one table, shared by session naming
 * and by the sub-agent recommendation, so the two never disagree about what
 * "the small one" is for a vendor.
 *
 * Keyed by provider family. Session naming uses these directly; the sub-agent
 * recommendation derives per-role suggestions from the same rows, so a change
 * here reaches both.
 *
 * @module shared/models
 */

export const CHEAP_MODELS: Record<string, string> = {
  anthropic: 'claude-haiku-4-5',
  openai: 'gpt-4o-mini',
  deepseek: 'deepseek-v4-flash',
  openrouter: 'deepseek/deepseek-v4-flash',
  gemini: 'gemini-2.0-flash',
  zai: 'glm-4.6',
  // K2.6 is the cheapest Kimi and the only one whose thinking can be switched
  // off. Without this row a Kimi conversation was named by its own work model —
  // kimi-k3 at maximum effort, for a six-word label.
  kimi: 'kimi-k2.6',
};

/** A model's family from its name, or undefined when the name does not say. */
export function familyOfModel(model: string): string | undefined {
  const m = model.toLowerCase();
  if (m.includes('/')) return 'openrouter';
  if (m.startsWith('claude')) return 'anthropic';
  if (/^(gpt|o[1-9]|chatgpt)/.test(m)) return 'openai';
  if (m.startsWith('deepseek')) return 'deepseek';
  if (m.startsWith('gemini')) return 'gemini';
  if (m.startsWith('glm')) return 'zai';
  if (m.startsWith('kimi') || m.startsWith('moonshot')) return 'kimi';
  return undefined;
}
