/**
 * What the user asked for, and whether anyone checked it.
 *
 * The gap this closes is the last one the benchmark left standing. An artifact
 * of 13,869 bytes, with no canvas and no SVG, loaded cleanly and answered every
 * click — and the brief it was built from asked for a 3D view. The keyword
 * score said twelve features out of twelve. The browser check said it works.
 * Both were right about the question they were asking, and neither was asking
 * whether the thing the user described had been built.
 *
 * So the requirements are read out of the user's own words, and the gate
 * compares them against the checks the verification actually ran. A requirement
 * nobody checked is named in the objection: not "verification incomplete" but
 * "you never checked: export to PDF, egress arrows".
 *
 * Three decisions keep this honest rather than annoying.
 *
 * **The list comes from the brief, not from the model.** A model that writes
 * its own acceptance criteria will write ones it has met. The user's text is
 * the only anchor that cannot be negotiated with.
 *
 * **Only interactions are demanded.** "Warm white, oat, charcoal" is a real
 * requirement and there is no click that proves it. Demanding a check for it
 * would teach the model to write meaningless checks, so only requirements that
 * name an *action* are held to one.
 *
 * **It only engages on a brief that is actually a spec.** "Fix the login bug"
 * has no feature list, and inventing one would tax every ordinary task. Below a
 * handful of extracted interactions this stays silent.
 *
 * @module requirements
 */

import { runScoped } from './run-scoped.js';

/** One thing the user asked for. */
export interface Requirement {
  /** The user's own words, trimmed to something quotable. */
  text: string;
  /** The words that carry the meaning, for matching against check names. */
  keywords: string[];
  /** Whether this names something that can be operated, and so checked. */
  interactive: boolean;
}

/**
 * Verbs that mean "the user will do this and something must happen".
 *
 * A requirement containing one of these describes behaviour, which a check can
 * exercise. A requirement without one describes an appearance or a constraint,
 * which it cannot.
 */
const ACTION_WORDS = new RegExp(
  '\\b(?:switch|toggle|click|tap|press|pick|choose|select|apply|update|change|'
  + 'export|download|save|load|import|animate|animates|place|placing|drag|drop|'
  + 'recolou?rs?|slides?|ticks?|adds?|removes?|deletes?|filters?|sorts?|searches|'
  + 'zoom|pan|rotate|resize|expand|collapse|opens?|closes?|plays?|pause|submit|'
  + 'enter|type|calculate|calculates|generate|generates|show|shows|hide|hides|'
  + 'switching|toggling|selecting|exporting)\\b',
  'i',
);

/** Words too common to identify anything. */
const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'with', 'as',
  'is', 'are', 'be', 'can', 'will', 'that', 'this', 'it', 'its', 'all', 'each',
  'from', 'by', 'at', 'into', 'when', 'user', 'users', 'page', 'app', 'should',
  'must', 'you', 'your', 'their', 'they', 'them', 'so', 'but', 'not', 'no',
  'via', 'per', 'out', 'up', 'down', 'over', 'across', 'between', 'live',
]);

/** Section headings, which announce requirements rather than being one. */
const HEADING = /^(?:visual strategy|colou?r palette|typography|page structure|interaction details|overall vibe|layout|imagery|photography|composition|requirements?|features?|notes?)\s*:?\s*$/i;

/** The words in a phrase that actually identify it. */
function keywordsOf(text: string): string[] {
  return [...new Set(
    text.toLowerCase()
      .replace(/[^a-z0-9\s-]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 2 && !STOPWORDS.has(w)),
  )];
}

/**
 * Read the requirements out of a brief.
 *
 * Bullets and `Label: description` lines, because that is the shape briefs
 * actually arrive in. Prose paragraphs are left alone: splitting them into
 * sentences produces fragments that match everything and mean nothing.
 */
export function extractRequirements(brief: string): Requirement[] {
  const found: Requirement[] = [];

  for (const rawLine of brief.split('\n')) {
    const line = rawLine.trim();
    if (line.length < 8 || line.length > 300) continue;
    if (HEADING.test(line)) continue;

    let text: string | undefined;

    const bullet = /^[-*•]\s+(.*)$/.exec(line);
    if (bullet) {
      text = bullet[1];
    } else {
      // `Label: description` — a requirement only when there is a description.
      // A bare `Interaction Details:` is a heading, and its colon is the only
      // thing it has in common with a requirement.
      const labelled = /^([A-Z][A-Za-z0-9 /&-]{2,40}):\s+(.+)$/.exec(line);
      if (labelled) text = `${labelled[1]}: ${labelled[2]}`;
    }

    if (!text) continue;
    const clean = text.trim().replace(/\s+/g, ' ');
    const keywords = keywordsOf(clean);
    if (keywords.length < 2) continue;

    found.push({
      text: clean.length > 120 ? `${clean.slice(0, 120)}…` : clean,
      keywords,
      interactive: ACTION_WORDS.test(clean),
    });
  }

  return found;
}

export interface Coverage {
  /** Interactive requirements that some check plausibly exercised. */
  covered: Requirement[];
  /** Interactive requirements nothing checked. */
  missing: Requirement[];
}

/**
 * How well the checks that ran cover what was asked for.
 *
 * Matched on shared keywords rather than exact text: a check named "brand
 * colour picker" should satisfy "Brand color picker recolors all branded
 * elements live", and demanding the model restate the requirement verbatim
 * would be a spelling test rather than a coverage test.
 */
export function coverageOf(requirements: Requirement[], checkNames: string[]): Coverage {
  const checks = checkNames.map(n => new Set(keywordsOf(n)));
  const covered: Requirement[] = [];
  const missing: Requirement[] = [];

  for (const req of requirements) {
    if (!req.interactive) continue;
    // Two shared keywords, or one when the requirement is short enough that one
    // is most of it. A single shared word out of ten is a coincidence.
    const needed = req.keywords.length <= 3 ? 1 : 2;
    const hit = checks.some(check => {
      let shared = 0;
      for (const word of req.keywords) if (check.has(word)) shared++;
      return shared >= needed;
    });
    (hit ? covered : missing).push(req);
  }

  // A brief often names the same feature twice — "Brand Color: apply across the
  // room instantly" in the feature list and "Brand color picker recolors all
  // branded elements live" in the interaction list. Checking it once is
  // checking it. Reporting the other phrasing as unchecked would send the model
  // to write a second check for work it had already proved, which is how a
  // coverage report starts being ignored.
  const genuinelyMissing = missing.filter(req => !covered.some(done => {
    let shared = 0;
    for (const word of req.keywords) if (done.keywords.includes(word)) shared++;
    return shared >= 2;
  }));

  return { covered, missing: genuinelyMissing };
}

/**
 * The brief this turn is working from.
 *
 * Per-turn, like the rest of the verification state: the requirements of the
 * task two turns ago are not the standard for this one.
 */
const state = runScoped(() => ({
  brief: '',
  cached: undefined as Requirement[] | undefined,
}));

export function setBrief(text: string): void {
  const s = state.get();
  s.brief = text;
  s.cached = undefined;
}

export function currentRequirements(): Requirement[] {
  const s = state.get();
  s.cached ??= extractRequirements(s.brief);
  return s.cached;
}

/**
 * Below this, a brief is a request rather than a specification.
 *
 * Four interactions is enough to be a feature list and few enough that an
 * ordinary "add a button that does X" task never trips it.
 */
export const MIN_INTERACTIONS_FOR_COVERAGE = 4;
