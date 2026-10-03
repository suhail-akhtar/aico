/**
 * The hard filter on what "About you" may say (ADR 0018), applied to every
 * candidate the code derives AND to every line the model phrases.
 *
 * Why twice: a candidate built from aggregates can still be sensitive (a
 * project's dependency named after a clinic, a search word the digest
 * missed), and a model asked to *phrase* "visits developer docs" can still
 * write "…while managing their diabetes". The prompt asks it not to; this is
 * the enforcement (AGENTS.md §4.6). The word and domain lists live in
 * `shared/sensitive-topics.ts`, the same table the desktop's browsing digest
 * uses, so the two sides cannot disagree about what is off limits.
 *
 * Also refused here: a category that is not one of the nine the learner
 * knows (a model inventing "health" or "relationships" as a category is
 * dropped, not mapped), and anything that still looks like an identifier
 * after redaction (emails, phone numbers, long tokens, home paths).
 *
 * @module profile/sensitive
 */

import { sensitiveArea, sensitiveDomain, type SensitiveArea } from '../../shared/sensitive-topics.js';

export { sensitiveArea, sensitiveDomain, type SensitiveArea };

export const FACT_CATEGORIES = [
  'interests', 'expertise', 'stack', 'work-patterns', 'communication', 'likes', 'dislikes', 'browsing-style', 'routines',
] as const;
export type FactCategory = typeof FACT_CATEGORIES[number];

export function isFactCategory(v: unknown): v is FactCategory {
  return typeof v === 'string' && (FACT_CATEGORIES as readonly string[]).includes(v);
}

const IDENTIFIER = /\[(?:secret|email)\]|[\w.+-]+@[\w-]+\.[\w.-]+|\+?\d[\d\s().-]{8,}\d|\b[A-Za-z0-9+/_-]{32,}\b|[A-Za-z]:\\Users\\|\/(?:home|Users)\/\w/i;

/** Why a fact text may not be kept, or undefined when it may. */
export function refuseFact(text: string, category?: unknown): string | undefined {
  if (category !== undefined && !isFactCategory(category)) return 'not a category About you keeps';
  const area = sensitiveArea(text);
  if (area) return `touches ${area}, which About you never infers`;
  if (IDENTIFIER.test(text)) return 'looks like it carries an identifier';
  return undefined;
}
