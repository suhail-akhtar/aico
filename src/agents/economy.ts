/**
 * Which model a sub-agent should run on, given the one the conversation runs on.
 *
 * A read-only fan-out — an `Investigate` across six files, a review of one
 * diff — does not need the model that writes the code. Spending the frontier
 * model on it is the single largest avoidable cost in a session that
 * delegates, and the fix is one setting: `agentModels` per role. This module
 * says what that setting should be, from the same cheap-model table session
 * naming uses, so the recommendation and the naming model never disagree
 * about a vendor's small model.
 *
 * A recommendation, never a silent default: Settings shows it with an Apply
 * button, and `/doctor` mentions it when nothing is set. The user's own
 * `agentModels` are always respected.
 *
 * @module agents/economy
 */

import type { AicoSettings } from '../settings.js';
import { CHEAP_MODELS, familyOfModel } from '../../shared/models.js';

/** Roles that are read-only or short-lived, and the reason each fits a cheap model. */
export const CHEAP_ROLES: Array<{ role: string; why: string }> = [
  { role: 'explore', why: 'reads and reports; never writes' },
  { role: 'plan', why: 'reads and lists; the work model executes the plan' },
  { role: 'review', why: 'one diff, a bounded question' },
  { role: 'verification', why: 'opens a page and checks it' },
  { role: 'security-audit', why: 'reads and greps; a short, separate conversation' },
  { role: 'devsecops', why: 'runs scanners and reads their output' },
];

export interface AgentModelRecommendation {
  /** The conversation's model this was derived for. */
  workModel: string;
  family?: string;
  /** The cheap model for that family, or undefined when the family is unknown. */
  cheap?: string;
  /** Role → model, for the roles that fit a cheap model. Empty when nothing can be recommended. */
  agentModels: Record<string, string>;
  /** Which of those the user has already set (to anything), so Apply does not overwrite a choice. */
  alreadySet: string[];
}

export function recommendedAgentModels(workModel: string, settings?: AicoSettings): AgentModelRecommendation {
  const family = familyOfModel(workModel) ?? settings?.activeProvider ?? settings?.provider;
  const cheap = family ? CHEAP_MODELS[family] : undefined;
  const current = settings?.agentModels ?? {};
  const agentModels: Record<string, string> = {};
  if (cheap && cheap !== workModel) {
    for (const { role } of CHEAP_ROLES) agentModels[role] = cheap;
  }
  return {
    workModel,
    ...(family ? { family } : {}),
    ...(cheap ? { cheap } : {}),
    agentModels,
    alreadySet: Object.keys(agentModels).filter(role => current[role] !== undefined),
  };
}

/** The roles whose model is still the work model — what `/doctor` warns about. */
export function unsetCheapRoles(settings?: AicoSettings): string[] {
  const current = settings?.agentModels ?? {};
  if (current.default) return [];
  return CHEAP_ROLES.map(r => r.role).filter(role => current[role] === undefined);
}
