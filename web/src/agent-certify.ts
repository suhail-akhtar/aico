/**
 * What the panels show about an agent's certification (design §6.4, §7.6
 * "Verify"), kept free of React so `test:web:unit` can check it.
 *
 * The engine decides everything — the status, the plan, the verdict — and
 * the panels only word it. A badge is never colour alone: every status has a
 * symbol and a word (§7.6), and "changed since certification" says so in
 * full, because the difference between it and "certified" is the whole point.
 *
 * @module agent-certify
 */

export type CertStatus = 'uncertified' | 'certified' | 'changed' | 'failed';

export interface CertBadge {
  label: string;
  symbol: string;
  tone: 'good' | 'warn' | 'bad' | 'muted';
  /** What it means for unattended (L4) runs, for a title attribute. */
  hint: string;
}

const BADGES: Record<CertStatus, CertBadge> = {
  certified: { label: 'certified', symbol: '✓', tone: 'good', hint: 'Passed its safety and golden tasks as it is now; it may run unattended (L4).' },
  changed: { label: 'changed since certification', symbol: '↻', tone: 'warn', hint: 'Something it depends on changed after it was certified; unattended runs are held to L3 until it is certified again.' },
  failed: { label: 'failed certification', symbol: '✕', tone: 'bad', hint: 'Its last certification run did not pass; unattended runs are held to L3.' },
  uncertified: { label: 'uncertified', symbol: '○', tone: 'muted', hint: 'Never certified; it works with a person present (L1–L3). Unattended runs need a certificate.' },
};

export function certBadge(status: string | undefined): CertBadge {
  return BADGES[(status as CertStatus) in BADGES ? status as CertStatus : 'uncertified'];
}

/** Reads the engine's certify reply: whether it passed, and the plan's estimate when it was a dry run. */
export function readCertifyReply(text: string | undefined): { passed: boolean | null; estimateUsd?: number; capUsd?: number; dryRun: boolean } {
  const t = text ?? '';
  const est = /Rough estimate \$([0-9.]+); hard cap \$([0-9.]+)/.exec(t);
  const dryRun = /Dry run: nothing was spent/.test(t);
  const passed = /: CERTIFIED on /.test(t) ? true : /: NOT certified on /.test(t) ? false : null;
  return {
    passed, dryRun,
    ...(est ? { estimateUsd: Number(est[1]), capUsd: Number(est[2]) } : {}),
  };
}
