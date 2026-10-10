/**
 * What the board may do on its own at each autonomy level, as pure rules.
 *
 * WHY A SEPARATE, PURE FILE. "May this change land without a person?" is the most
 * consequential question the engine answers, and it must have exactly one answer that can
 * be tested over every combination (level x risk x checks x findings), not a condition
 * spread through the dispatcher. The dispatcher asks; this file only answers. It reads no
 * clock, no git and no policy: the caller hands it the facts, including the organisation's
 * ceiling, so the matrix in the tests is the whole truth.
 *
 * Trust model, in short (ADR 0038 "Autonomy levels" has the long form):
 *  - every level is a CEILING on what the engine does without a person, never a promise to do it;
 *  - the answer can only be "no" more often at lower levels: a rule here never grants what a
 *    lower level denied, and a finding that blocks at one level blocks at all of them;
 *  - a possible secret and a weakened test keep a change from landing automatically AT EVERY LEVEL,
 *    `full` included, as does a high-severity code finding - the gates are not a risk score that
 *    a big enough budget can outvote;
 *  - the organisation's ceiling (`delivery.maxAutonomy`, restrict-only) is applied by lowering the
 *    level before it gets here (`effectiveAutonomy`), so no rule below has to know about policy.
 *
 * @module delivery/autonomy
 */

import { autonomyRank, minAutonomy } from '../../shared/delivery/autonomy.js';
import type { Autonomy, RiskLevel, Task } from './types.js';

export { autonomyRank };

/** The level in force: what the board is set to, lowered to the organisation's ceiling when it has one. */
export function effectiveAutonomy(setting: Autonomy, cap: Autonomy | undefined): Autonomy {
  return cap ? minAutonomy(setting, cap) : setting;
}

/** What each level does, as booleans the dispatcher reads (one place, so the docs and the code say the same). */
export interface Powers {
  /** Start the Backlog prerequisites of a Ready task. */
  promotePrerequisites: boolean;
  /** Pull the next Backlog tasks into Ready when a slot is free. */
  pullBacklog: boolean;
  /** The highest risk level it may land by itself; `undefined`: it never lands by itself. */
  autoLandUpTo: RiskLevel | undefined;
}

export function powersOf(level: Autonomy): Powers {
  switch (level) {
    case 'manual': return { promotePrerequisites: false, pullBacklog: false, autoLandUpTo: undefined };
    case 'assisted': return { promotePrerequisites: true, pullBacklog: false, autoLandUpTo: 'low' };
    case 'autonomous': return { promotePrerequisites: true, pullBacklog: true, autoLandUpTo: 'medium' };
    case 'full': return { promotePrerequisites: true, pullBacklog: true, autoLandUpTo: 'high' };
  }
}

const RISK_RANK: Record<RiskLevel, number> = { low: 0, medium: 1, high: 2 };

export interface LandFacts {
  level: Autonomy;
  risk: NonNullable<Task['risk']>;
  /** The project's checks passed on the exact tree that would land (or it defines none). */
  checksGreen: boolean;
  /** PR mode: landing is the remote's, never an automatic act. */
  prMode: boolean;
}

export interface LandDecision {
  ok: boolean;
  /** One sentence: why it may land by itself, or what keeps it for a person. */
  reason: string;
}

/** The findings that keep a change away from every automatic landing, from the risk record (flags first, then what its reasons say). */
export function safetyFindings(risk: NonNullable<Task['risk']>): string[] {
  const flags = new Set<string>(risk.flags ?? []);
  // A risk record from before flags existed: read the reasons, which name the same findings.
  if (!risk.flags) {
    for (const r of risk.reasons) {
      if (/possible secret/i.test(r)) flags.add('secret');
      if (/weakened tests/i.test(r) || /test expectations loosened/i.test(r)) flags.add('test-tamper');
      if (/high-severity code finding/i.test(r)) flags.add('code-high');
    }
  }
  // A scan that could not run is not a clean scan: the risk record says so in its reasons, and it counts.
  if (risk.reasons.some(r => /scan did not run/i.test(r))) flags.add('scan-failed');
  const words: Record<string, string> = {
    secret: 'a possible secret in the added lines', 'test-tamper': 'a weakened test', 'code-high': 'a high-severity code finding',
    'scan-failed': 'a safety scan that did not run',
  };
  return [...flags].map(f => words[f] ?? f);
}

/** May this reviewed change land without a person? */
export function autoLandDecision(f: LandFacts): LandDecision {
  const powers = powersOf(f.level);
  if (f.prMode) return { ok: false, reason: 'pull-request mode: the remote\'s rules and a person decide the merge' };
  if (!powers.autoLandUpTo) return { ok: false, reason: 'the board is on manual: a person approves every landing' };
  const findings = safetyFindings(f.risk);
  if (findings.length > 0) return { ok: false, reason: `it has ${findings.join(' and ')}; that always waits for a person` };
  if (!f.checksGreen) return { ok: false, reason: 'its checks are not green for the tree that would land' };
  if (RISK_RANK[f.risk.level] > RISK_RANK[powers.autoLandUpTo]) {
    return { ok: false, reason: `it is ${f.risk.level} risk; at ${f.level} the board lands up to ${powers.autoLandUpTo} risk on its own` };
  }
  return { ok: true, reason: `${f.risk.level} risk (${f.risk.score}), checks green, no safety finding, at the ${f.level} level` };
}
