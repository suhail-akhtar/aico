/**
 * The autonomy scale (design §4.2): one ordered scale, L0–L4, in place of
 * three unrelated switches (plan mode, the approval mode, "unattended").
 *
 * | Level | Name         | read | write | exec | external        | destructive | Was                  |
 * |-------|--------------|------|-------|------|-----------------|-------------|----------------------|
 * | L0    | Plan         | auto | deny  | deny | deny            | deny        | plan mode            |
 * | L1    | Ask          | auto | ask   | ask  | ask             | ask         | approval `ask`       |
 * | L2    | Edits        | auto | auto  | ask  | ask             | ask         | approval `edits`     |
 * | L3    | Auto         | auto | auto  | auto | first use asked | every use   | approval `auto`      |
 * | L4    | Unattended   | auto | auto  | auto | first use parks | **parks**   | cron, background, mcp-serve |
 *
 * **Migration is a mapping, not a rewrite.** The three approval modes and
 * plan mode stay what clients send and what is stored; this module turns them
 * into a level and back, so nothing a person chose before changes meaning.
 * A client that knows the scale may send `autonomy` instead.
 *
 * **The effective level can only go down.** It is the minimum of what the
 * run asked for, the agent's `autonomy` ceiling (an agent definition field,
 * design §5.4) and the delegating run's level. Nothing a model writes — a tool
 * argument, a skill, a child's request — raises it.
 *
 * **There is no level at which `destructive` runs without a person** (§9).
 * L4 does not run it either: it *parks* the exact call in the approve-later
 * inbox (`autonomy/inbox.ts`) and the run carries on with everything else.
 *
 * The L4 certification gate (Phase 4) is enforced in `runAgent`, which
 * holds a named agent without a current certificate (`evals/certificate`)
 * at L3; `certified: false` here is how the server words the same cap in
 * the turn's notice.
 *
 * @module autonomy/levels
 */

export const AUTONOMY_LEVELS = ['L0', 'L1', 'L2', 'L3', 'L4'] as const;
export type AutonomyLevel = (typeof AUTONOMY_LEVELS)[number];

/** Names a person (or an imported agent file) may use for a level. */
const ALIASES: Record<string, AutonomyLevel> = {
  l0: 'L0', plan: 'L0', consultant: 'L0',
  l1: 'L1', ask: 'L1', operator: 'L1',
  l2: 'L2', edits: 'L2', collaborator: 'L2',
  l3: 'L3', auto: 'L3', approver: 'L3',
  l4: 'L4', unattended: 'L4',
};

/** `'L3'`, `3`, `'auto'`, `'unattended'` … → a level; anything else → undefined. */
export function parseLevel(value: unknown): AutonomyLevel | undefined {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 4) return AUTONOMY_LEVELS[value];
  if (typeof value !== 'string') return undefined;
  return ALIASES[value.trim().toLowerCase()];
}

export function levelRank(level: AutonomyLevel): number {
  return AUTONOMY_LEVELS.indexOf(level);
}

/** The lowest of the levels given; undefined only when none is. */
export function minLevel(...levels: Array<AutonomyLevel | undefined>): AutonomyLevel | undefined {
  let low: AutonomyLevel | undefined;
  for (const l of levels) if (l && (!low || levelRank(l) < levelRank(low))) low = l;
  return low;
}

export type ApprovalModeName = 'auto' | 'edits' | 'ask';

/** Today's switches → a level. Plan mode wins; `unattended` raises `auto` to L4. */
export function levelFromMode(o: { planMode?: boolean; approval?: ApprovalModeName; unattended?: boolean }): AutonomyLevel {
  if (o.planMode) return 'L0';
  if (o.approval === 'ask') return 'L1';
  if (o.approval === 'edits') return 'L2';
  return o.unattended ? 'L4' : 'L3';
}

/** A level → the switches the engine already understands, plus whether it parks. */
export function modeFromLevel(level: AutonomyLevel): { planMode: boolean; approval: ApprovalModeName; parks: boolean } {
  switch (level) {
    case 'L0': return { planMode: true, approval: 'auto', parks: false };
    case 'L1': return { planMode: false, approval: 'ask', parks: false };
    case 'L2': return { planMode: false, approval: 'edits', parks: false };
    case 'L3': return { planMode: false, approval: 'auto', parks: false };
    case 'L4': return { planMode: false, approval: 'auto', parks: true };
  }
}

export interface EffectiveLevel {
  level: AutonomyLevel;
  requested: AutonomyLevel;
  /** Set when something lowered the request, in words for the run's notice. */
  cappedBy?: 'agent' | 'parent' | 'certification';
  reason?: string;
}

/**
 * min(requested, agent ceiling, parent), then the certification rule.
 * `agentCeiling` is read leniently (an agent file's `autonomy:` value); an
 * unreadable ceiling is ignored here and reported by the agent validator.
 */
export function effectiveLevel(o: {
  requested: AutonomyLevel;
  agentCeiling?: unknown;
  parent?: AutonomyLevel;
  /** False when the agent has no valid certificate. Undefined: not checked. */
  certified?: boolean;
}): EffectiveLevel {
  let out: EffectiveLevel = { level: o.requested, requested: o.requested };
  const ceiling = parseLevel(o.agentCeiling);
  if (ceiling && levelRank(ceiling) < levelRank(out.level)) {
    out = { ...out, level: ceiling, cappedBy: 'agent', reason: `the agent's autonomy ceiling is ${ceiling}` };
  }
  if (o.parent && levelRank(o.parent) < levelRank(out.level)) {
    out = { ...out, level: o.parent, cappedBy: 'parent', reason: `the run that delegated this one is at ${o.parent}` };
  }
  if (out.level === 'L4' && o.certified === false) {
    out = { ...out, level: 'L3', cappedBy: 'certification', reason: 'unattended (L4) runs need a certified agent; this one is not certified, so it runs at L3' };
  }
  return out;
}

const LABELS: Record<AutonomyLevel, string> = {
  L0: 'L0 Plan', L1: 'L1 Ask', L2: 'L2 Edits', L3: 'L3 Auto', L4: 'L4 Unattended',
};

export function levelLabel(level: AutonomyLevel): string {
  return LABELS[level];
}
