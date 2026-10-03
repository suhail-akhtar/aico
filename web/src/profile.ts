/**
 * "About you" as the clients show it: the shapes `GET /api/profile` returns
 * (engine: src/profile/store.ts, service.ts) and the few pure helpers the
 * page needs. Shared by the web Settings pane and the desktop About-you page;
 * free of React and the API client so it stays cheap to import and test.
 *
 * @module web/profile
 */

export type FactCategory =
  | 'interests' | 'expertise' | 'stack' | 'work-patterns' | 'communication' | 'likes' | 'dislikes' | 'browsing-style' | 'routines';

export interface FactEvidence { source: 'work' | 'browsing' | 'preferences' | 'you'; label: string; count: number; lastSeen: number }

export interface ProfileFact {
  id: string;
  key: string;
  category: FactCategory;
  text: string;
  evidence: FactEvidence[];
  confidence: number;
  status: 'inferred' | 'confirmed' | 'hidden';
  created: number;
  updated: number;
  origin: 'auto' | 'user';
  edited?: boolean;
}

export interface ProfileOverview {
  facts: ProfileFact[];
  /** Ids of the facts the agent may be told (confirmed, or learned at ≥ 0.7). */
  using: string[];
  settings: { enabled: boolean; work: boolean; browsing: boolean; dailyBudgetUsd: number };
  lastRun: { at: number; via: 'model' | 'deterministic' | 'skipped'; model?: string; provider?: string; costUsd?: number; facts: number; added: number; note?: string } | null;
  running: boolean;
  spend: { today: number; budget: number };
  sources: { work: 'on' | 'off'; browsing: string; digestAt?: number };
  learner: { ok: boolean; model?: string; provider?: string; local?: boolean; note?: string };
  categories: FactCategory[];
}

export const CATEGORY_LABEL: Record<FactCategory, string> = {
  interests: 'Interests', expertise: 'Expertise', stack: 'Stack and tools', 'work-patterns': 'How you work', communication: 'How you communicate',
  likes: 'Likes', dislikes: 'Dislikes', 'browsing-style': 'How you browse', routines: 'Routines',
};

const SOURCE_LABEL: Record<FactEvidence['source'], string> = { work: 'your work', browsing: 'your browsing', preferences: 'your working rules', you: 'you' };

export function agoText(t: number, now = Date.now()): string {
  const m = Math.round((now - t) / 60_000);
  if (m < 2) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  return d === 1 ? 'yesterday' : `${d} days ago`;
}

/** "Seen 14× in your work, last 2 days ago — files in TypeScript touched 14 times across 3 sessions". */
export function evidenceText(f: Pick<ProfileFact, 'evidence'>, now = Date.now()): string {
  if (!f.evidence.length) return 'No evidence recorded.';
  return f.evidence.map(e => `Seen ${e.count}× in ${SOURCE_LABEL[e.source] ?? e.source}, last ${agoText(e.lastSeen, now)} — ${e.label}`).join('\n');
}

export const BROWSING_STATUS: Record<string, string> = {
  ok: 'reading the browser digest', missing: 'no digest yet (the desktop browser writes it)', paused: 'browser learning is paused',
  off: 'turned off in the browser', stale: 'the digest is more than two weeks old', invalid: 'the digest could not be read', disabled: 'off',
};

/** Facts grouped by category, in the page's order; hidden ones last within each group. */
export function groupFacts(facts: readonly ProfileFact[]): Array<[FactCategory, ProfileFact[]]> {
  const order = Object.keys(CATEGORY_LABEL) as FactCategory[];
  const rank = (f: ProfileFact): number => (f.status === 'confirmed' ? 0 : f.status === 'inferred' ? 1 : 2);
  return order
    .map(c => [c, facts.filter(f => f.category === c).sort((a, b) => rank(a) - rank(b) || b.confidence - a.confidence)] as [FactCategory, ProfileFact[]])
    .filter(([, list]) => list.length > 0);
}
