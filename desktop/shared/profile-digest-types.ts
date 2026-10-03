/**
 * The browsing digest "About you" reads (ADR 0018), as main writes it and the
 * renderer's About-you page shows its status. Shared so the two cannot drift.
 *
 * The digest is the ONLY thing the engine's learner (src/profile) ever sees of
 * the person's browsing: aggregates, never an address with a path, never a
 * whole search, never a page title. The engine re-validates the file on read
 * (src/profile/sources.ts) rather than importing these types — the engine
 * imports nothing from desktop/.
 *
 * IPC (main: browser-learn.ts):
 *   browser:profile:status  ()                → ProfileDigestStatus
 *   browser:profile:set     ({ useBrowsing })  → ProfileDigestStatus   (writes the digest at once)
 *
 * @module desktop/shared/profile-digest-types
 */

export interface ProfileDigest {
  v: 1;
  /** When it was written. */
  at: number;
  windowDays: number;
  /** Browser learning is paused: nothing else is in the file. */
  paused?: true;
  /** "Let About you use my browsing" is off: nothing else is in the file. */
  off?: true;
  /** Registrable domain only (no subdomain, path or query), with what kind of site it is. */
  domains: Array<{ domain: string; category: string; minutes: number; visits: number; days: number }>;
  categories: Array<{ category: string; minutes: number; visits: number }>;
  /** Research threads: their topic words only. */
  threads: Array<{ terms: string[]; pages: number; sites: number; last: number }>;
  /** Words from searches, stop-worded and counted. Never a whole query. */
  searchTerms: Array<{ term: string; count: number }>;
  /** Visits by hour of day (0–23) and by weekday (0 = Sunday). */
  routines: { hours: number[]; weekdays: number[] };
  reading: { pages: number; medianSeconds: number; skim: number; partial: number; read: number; style: 'skims' | 'reads' | 'mixed' | 'unknown' };
  /** What kinds of page were open (docs, video, article, code …), by count. */
  kinds: Record<string, number>;
  /** How much was left out, so the page can say so. */
  dropped: { sensitive: number; excluded: number };
}

export interface ProfileDigestStatus {
  useBrowsing: boolean;
  learningPaused: boolean;
  /** When the digest was last written (0 = never). */
  writtenAt: number;
  domains: number;
}
