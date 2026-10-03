/**
 * Aggregates → candidate facts, deterministically (ADR 0018 "deterministic
 * first").
 *
 * Every candidate is a counted observation with a stable subject key
 * ("lang:typescript", "browse:developer docs"), a plain sentence, a category
 * and the evidence that produced it. The thresholds are deliberately high —
 * three sightings across two sessions before anything is said — because a
 * fact about a person that is wrong is worse than one that is missing.
 *
 * This is also the whole learner when no model may be used (no key, the
 * `private` preset without a local model, the day's budget spent): the
 * wording below is what the person then sees. The model only re-phrases and
 * merges these; it cannot add a fact the code did not derive (distill.ts
 * accepts only keys it was given).
 *
 * Every text passes `refuseFact` here, before the model ever sees it, and
 * again when stored.
 *
 * @module profile/candidates
 */

import type { FactCandidate, FactEvidence } from './store.js';
import { refuseFact, sensitiveArea, sensitiveDomain, type FactCategory } from './sensitive.js';
import type { BrowserDigest, Counted, PreferenceSummary, ProfileSources, WorkAggregates } from './sources.js';

const PARTS: Array<[string, number, number]> = [['morning', 5, 12], ['afternoon', 12, 17], ['evening', 17, 22], ['night', 22, 29]];
const ranked = (m: Record<string, Counted>): Array<[string, Counted]> =>
  Object.entries(m).sort((a, b) => b[1].count - a[1].count || b[1].sessions - a[1].sessions || a[0].localeCompare(b[0]));
const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/** The busiest part of the day, when one clearly dominates. */
function peakPart(hours: readonly number[], minShare = 0.45): { part: string; from: number; to: number; share: number } | undefined {
  const total = hours.reduce((a, b) => a + b, 0);
  if (total <= 0) return undefined;
  let best: { part: string; from: number; to: number; share: number } | undefined;
  for (const [part, from, to] of PARTS) {
    let n = 0;
    for (let h = from; h < to; h++) n += hours[h % 24] ?? 0;
    const share = n / total;
    if (!best || share > best.share) best = { part, from, to: to % 24, share };
  }
  return best && best.share >= minShare ? best : undefined;
}
const hh = (h: number): string => `${String(h).padStart(2, '0')}:00`;

const NOT_STACK = new Set(['Markdown']);
const CLI_LABEL: Record<string, string> = {
  git: 'git', gh: 'the GitHub CLI', npm: 'npm', pnpm: 'pnpm', yarn: 'Yarn', bun: 'Bun', npx: 'npx', node: 'Node.js', deno: 'Deno', tsc: 'the TypeScript compiler',
  vite: 'Vite', vitest: 'Vitest', jest: 'Jest', playwright: 'Playwright', eslint: 'ESLint', prettier: 'Prettier', python: 'Python', pip: 'pip', uv: 'uv',
  poetry: 'Poetry', pytest: 'pytest', ruff: 'Ruff', mypy: 'mypy', go: 'the Go toolchain', cargo: 'Cargo', dotnet: 'the .NET CLI', mvn: 'Maven',
  gradle: 'Gradle', docker: 'Docker', kubectl: 'kubectl', helm: 'Helm', terraform: 'Terraform', make: 'make', psql: 'psql', aws: 'the AWS CLI',
  az: 'the Azure CLI', gcloud: 'the gcloud CLI', flutter: 'Flutter', composer: 'Composer', rails: 'Rails',
};

function work(w: WorkAggregates, out: FactCandidate[]): void {
  const ev = (label: string, count: number, lastSeen: number): FactEvidence[] => [{ source: 'work', label, count, lastSeen }];

  // Stack: languages the agent's work touched, again and again.
  const langs = ranked(w.languages).filter(([name, c]) => !NOT_STACK.has(name) && c.count >= 5 && c.sessions >= 2);
  const totalFiles = langs.reduce((n, [, c]) => n + c.count, 0);
  langs.slice(0, 5).forEach(([name, c], i) => {
    const mostly = i === 0 && c.count / Math.max(1, totalFiles) >= 0.5;
    out.push({
      key: `lang:${name.toLowerCase()}`, category: 'stack',
      text: mostly ? `Works mostly in ${name}.` : `Works in ${name}.`,
      evidence: ev(`files in ${name} touched ${plural(c.count, 'time')} across ${plural(c.sessions, 'session')}`, c.count, c.lastSeen),
    });
    if (i === 0 && c.count >= 40 && c.sessions >= 8) {
      out.push({
        key: `expert:${name.toLowerCase()}`, category: 'expertise',
        text: `Experienced with ${name}: most of their recent work is in it.`,
        evidence: ev(`${plural(c.count, `${name} file`)} worked on in ${plural(c.sessions, 'session')}`, c.count, c.lastSeen),
      });
    }
  });
  for (const [fw, c] of ranked(w.frameworks).slice(0, 6)) {
    if (c.sessions < 2) continue;
    out.push({ key: `fw:${fw.toLowerCase()}`, category: 'stack', text: `Builds with ${fw}.`, evidence: ev(`${plural(c.count, 'project')} use ${fw} (${plural(c.sessions, 'session')})`, c.sessions, c.lastSeen || w.lastSeen) });
  }
  for (const [cli, c] of ranked(w.commands).slice(0, 8)) {
    if (c.count < 3 || c.sessions < 2) continue;
    out.push({ key: `cmd:${cli}`, category: 'stack', text: `Uses ${CLI_LABEL[cli] ?? cli}.`, evidence: ev(`ran ${plural(c.count, 'time')} in ${plural(c.sessions, 'session')}`, c.count, c.lastSeen) });
  }

  // Work patterns: what kind of projects, which model, how they delegate.
  for (const [kind, c] of ranked(w.projectKinds).slice(0, 3)) {
    if (c.sessions < 3) continue;
    out.push({ key: `kind:${kind}`, category: 'work-patterns', text: `Works on ${kind}.`, evidence: ev(`${plural(c.count, 'project')} of this kind, ${plural(c.sessions, 'session')}`, c.sessions, c.lastSeen || w.lastSeen) });
  }
  const models = ranked(w.models);
  const modelSessions = models.reduce((n, [, c]) => n + c.sessions, 0);
  const top = models[0];
  if (top && top[1].sessions >= 3 && top[1].sessions / Math.max(1, modelSessions) >= 0.5) {
    out.push({ key: `model:${top[0]}`, category: 'work-patterns', text: `Usually works with the ${top[0]} model.`, evidence: ev(`chosen in ${plural(top[1].sessions, 'session')}`, top[1].sessions, top[1].lastSeen) });
  }
  const task = w.tools.Task;
  if (task && task.count >= 5 && task.sessions >= 3) {
    out.push({ key: 'habit:delegates', category: 'work-patterns', text: 'Often lets AICO split work across helper agents.', evidence: ev(`helper agents started ${plural(task.count, 'time')}`, task.count, task.lastSeen) });
  }

  // Routines: when they send requests.
  if (w.humanMessages >= 15) {
    const peak = peakPart(w.hours);
    if (peak) out.push({ key: `hours:${peak.part}`, category: 'routines', text: `Usually works in the ${peak.part} (most requests between ${hh(peak.from)} and ${hh(peak.to)}).`, evidence: ev(`${Math.round(peak.share * 100)}% of ${plural(w.humanMessages, 'request')}`, w.humanMessages, w.lastSeen) });
    const weekend = ((w.weekdays[0] ?? 0) + (w.weekdays[6] ?? 0)) / Math.max(1, w.humanMessages);
    if (weekend >= 0.3) out.push({ key: 'hours:weekends', category: 'routines', text: 'Often works at weekends.', evidence: ev(`${Math.round(weekend * 100)}% of requests on Saturday or Sunday`, w.humanMessages, w.lastSeen) });
  }

  // Communication: how they ask.
  if (w.humanMessages >= 10) {
    if (w.medianWords > 0 && w.medianWords <= 12) out.push({ key: 'comm:brief', category: 'communication', text: 'Writes short, direct requests.', evidence: ev(`median request ${plural(w.medianWords, 'word')} over ${plural(w.humanMessages, 'request')}`, w.humanMessages, w.lastSeen) });
    else if (w.medianWords >= 60) out.push({ key: 'comm:detailed', category: 'communication', text: 'Writes detailed requests with plenty of context.', evidence: ev(`median request ${plural(w.medianWords, 'word')} over ${plural(w.humanMessages, 'request')}`, w.humanMessages, w.lastSeen) });
  }
}

const NEGATIVE = /\b(never|don'?t|do not|avoid|no\b|not\b|instead of|rather than|stop)\b/i;

function preferences(rules: readonly PreferenceSummary[], out: FactCandidate[]): void {
  for (const r of rules.slice(0, 20)) {
    const category: FactCategory = r.category === 'communication' ? 'communication' : NEGATIVE.test(r.text) ? 'dislikes' : 'likes';
    // A rule the person accepted is strong evidence; counted so it clears the use threshold.
    out.push({ key: `pref:${r.id}`, category, text: r.text, evidence: [{ source: 'preferences', label: 'a working rule you accepted', count: 6 + Math.min(4, r.evidence), lastSeen: r.at }] });
  }
}

const SKIP_BROWSE = new Set(['search', 'other', 'mail & chat']);
const KIND_TEXT: Record<string, string> = {
  docs: 'documentation', code: 'code and repositories', video: 'videos', article: 'articles', qa: 'questions and answers', product: 'products',
};

function browsing(b: BrowserDigest, out: FactCandidate[]): void {
  const at = b.at;
  const ev = (label: string, count: number, lastSeen = at): FactEvidence[] => [{ source: 'browsing', label, count, lastSeen }];
  for (const c of b.categories.filter(c => !SKIP_BROWSE.has(c.category) && (c.minutes >= 30 || c.visits >= 10)).slice(0, 4)) {
    out.push({ key: `browse:${c.category}`, category: 'interests', text: `Spends a good share of browsing time on ${c.category}.`, evidence: ev(`${c.minutes} min over ${plural(c.visits, 'visit')} in 30 days`, Math.max(c.visits, Math.round(c.minutes / 10))) });
  }
  for (const d of b.domains.filter(d => d.days >= 5 && !sensitiveDomain(d.domain)).slice(0, 5)) {
    out.push({ key: `site:${d.domain}`, category: 'likes', text: `Often visits ${d.domain} (${d.category}).`, evidence: ev(`opened on ${plural(d.days, 'day')}, ${d.minutes} min in 30 days`, d.days) });
  }
  for (const t of b.threads.filter(t => t.pages >= 3 && !sensitiveArea(t.terms.join(' '))).slice(0, 4)) {
    const terms = [...t.terms].sort();
    out.push({ key: `topic:${terms.join('+')}`, category: 'interests', text: `Has been reading up on ${t.terms.join(', ')}.`, evidence: ev(`${plural(t.pages, 'page')} on ${plural(t.sites, 'site')}`, t.pages, t.last || at) });
  }
  const terms = b.searchTerms.filter(s => s.count >= 3 && !sensitiveArea(s.term)).slice(0, 6);
  if (terms.length >= 2) {
    out.push({ key: 'search:topics', category: 'interests', text: `Often searches for ${terms.map(t => t.term).join(', ')}.`, evidence: ev(`search words counted over 30 days`, terms.reduce((n, t) => n + t.count, 0)) });
  }
  if (b.reading.style === 'skims' || b.reading.style === 'reads') {
    out.push({
      key: 'read:style', category: 'browsing-style',
      text: b.reading.style === 'skims' ? 'Tends to skim pages rather than read them through.' : 'Usually reads pages through to the end.',
      evidence: ev(`${plural(b.reading.pages, 'page')}, median ${Math.round(b.reading.medianSeconds)} s on a page`, b.reading.pages),
    });
  }
  const kinds = Object.entries(b.kinds).filter(([k]) => KIND_TEXT[k]);
  const totalKinds = Object.values(b.kinds).reduce((a, n) => a + n, 0);
  const topKind = kinds.sort((a, c) => c[1] - a[1])[0];
  if (topKind && topKind[1] >= 5 && topKind[1] / Math.max(1, totalKinds) >= 0.3) {
    out.push({ key: `kind-browse:${topKind[0]}`, category: 'browsing-style', text: `Much of what they open in the browser is ${KIND_TEXT[topKind[0]]}.`, evidence: ev(`${topKind[1]} of ${totalKinds} pages`, topKind[1]) });
  }
  const visits = b.routines.hours.reduce((a, n) => a + n, 0);
  const peak = visits >= 15 ? peakPart(b.routines.hours, 0.5) : undefined;
  if (peak) out.push({ key: `browse-hours:${peak.part}`, category: 'routines', text: `Browses mostly in the ${peak.part}.`, evidence: ev(`${Math.round(peak.share * 100)}% of visits`, Math.round(visits)) });
}

/** All candidates for this run, already free of anything sensitive. Deterministic for given sources. */
export function buildCandidates(sources: Pick<ProfileSources, 'work' | 'preferences' | 'browsing'>): FactCandidate[] {
  const out: FactCandidate[] = [];
  if (sources.work) work(sources.work, out);
  preferences(sources.preferences, out);
  if (sources.browsing) browsing(sources.browsing, out);
  return out.filter(c => !refuseFact(c.text, c.category));
}
