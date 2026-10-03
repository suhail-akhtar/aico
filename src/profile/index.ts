/**
 * "About you" (ADR 0018): a background learner the person controls. The
 * module map, so callers import one place:
 *
 *   sources    — what it reads (session logs, accepted rules, the browser digest), as aggregates
 *   candidates — aggregates → counted, filtered candidate facts (deterministic)
 *   sensitive  — the hard filter on categories and words (shared with the desktop digest)
 *   distill    — the one cheap `background`-role call that phrases and merges them
 *   store      — facts.json: statuses, evidence, forgetting, the person-wins merge
 *   inject     — `<about_user>` for the volatile tail
 *   service    — the six-hourly idle timer, the daily budget, the `profile/*` routes
 *
 * @module profile
 */

export * from './sensitive.js';
export * from './store.js';
export * from './sources.js';
export * from './candidates.js';
export * from './distill.js';
export * from './inject.js';
export * from './service.js';
