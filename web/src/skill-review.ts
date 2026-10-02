/**
 * The review screen's logic, kept apart from React so it can be tested.
 *
 * An imported skill reaches the model only after a person looked at it and
 * chose "Install and enable" (design §5.1, §7.2). That choice is only as good
 * as what the screen shows, so the decisions about *what to show* live here:
 * which skills start selected (valid ones, and never one that would silently
 * replace something), how findings are ordered (worst first), how a
 * finding is labelled in words (never colour alone, §7.8), and what the
 * button says for the current selection.
 *
 * Types mirror the engine's `ImportReview` (src/skills/import.ts); the client
 * never imports the engine.
 *
 * @module skill-review
 */

export type Severity = 'high' | 'warn' | 'info';

export interface ReviewFinding {
  kind: string;
  severity: Severity;
  file: string;
  line?: number;
  message: string;
}

export interface ReviewedSkill {
  name: string;
  description: string;
  at: string;
  errors: string[];
  warnings: string[];
  files: Array<{ path: string; size: number; script?: string }>;
  findings: ReviewFinding[];
  totals: { high: number; warn: number; info: number };
  scripts: Array<{ file: string; interpreter: string }>;
  tokens: { catalogue: number; body: number };
  sha256: string;
  allowedTools?: string[];
  license?: string;
  exists?: { builtin: boolean; trust?: string };
}

export interface ImportReview {
  id: string;
  source: string;
  sourceKind: 'archive' | 'folder' | 'markdown' | 'pack' | 'plugin' | 'upload' | 'url' | 'draft';
  sourceSha256?: string;
  createdAt: string;
  skills: ReviewedSkill[];
  plugin?: { name: string; version?: string; description?: string; agents: string[]; mcpServers: string[]; commands: string[] };
  notes: string[];
}

export interface SkillProvenance {
  source: string;
  sourceKind: string;
  sha256: string;
  sourceSha256?: string;
  importedAt: string;
  trust: 'authored' | 'reviewed' | 'unreviewed';
  reviewedAt?: string;
  plugin?: string;
  findings?: { high: number; warn: number; info: number };
}

const RANK: Record<Severity, number> = { high: 0, warn: 1, info: 2 };

/** Findings worst first, then by file and line, so the eye lands on what matters. */
export function sortFindings(findings: ReviewFinding[]): ReviewFinding[] {
  return [...findings].sort((a, b) => RANK[a.severity] - RANK[b.severity]
    || a.file.localeCompare(b.file) || (a.line ?? 0) - (b.line ?? 0));
}

/** A severity in words, for a badge that must not rely on colour. */
export function severityLabel(s: Severity): string {
  return s === 'high' ? 'High' : s === 'warn' ? 'Check' : 'Info';
}

/** What a kind of finding is, in a few words. */
export function kindLabel(kind: string): string {
  const labels: Record<string, string> = {
    script: 'Script', binary: 'Compiled program', network: 'Network call', exec: 'Runs programs',
    credentials: 'Credential path', base64: 'Encoded content', injection: 'Instruction aimed at the AI',
    'hidden-unicode': 'Hidden text', oversized: 'Very large file', 'large-body': 'Long body',
  };
  return labels[kind] ?? kind;
}

/**
 * The skills selected when the screen opens: every valid one that would not
 * replace an existing skill. Replacing is a choice a person makes by ticking
 * it, not one a default makes for them.
 */
export function defaultSelection(review: Pick<ImportReview, 'skills'>): string[] {
  return review.skills.filter(s => s.errors.length === 0 && !s.exists).map(s => s.name);
}

/** Whether a skill can be ticked at all. */
export function selectable(s: ReviewedSkill): boolean {
  return s.errors.length === 0;
}

/** One line under the title: what was found, worst first, in words. */
export function summaryLine(s: Pick<ReviewedSkill, 'totals' | 'scripts' | 'files'>): string {
  const bits = [`${s.files.length} file${s.files.length === 1 ? '' : 's'}`];
  if (s.scripts.length) bits.push(`${s.scripts.length} script${s.scripts.length === 1 ? '' : 's'}`);
  if (s.totals.high) bits.push(`${s.totals.high} high finding${s.totals.high === 1 ? '' : 's'}`);
  if (s.totals.warn) bits.push(`${s.totals.warn} to check`);
  if (!s.totals.high && !s.totals.warn) bits.push('nothing flagged');
  return bits.join(' · ');
}

/** The primary button's label for a selection. */
export function installLabel(selected: number, replacing: number): string {
  if (selected === 0) return 'Select a skill to install';
  const what = selected === 1 ? 'skill' : `${selected} skills`;
  return replacing ? `Install and enable ${what} (replaces ${replacing})` : `Install and enable ${selected === 1 ? '' : what}`.trim();
}

/** Bytes for people. */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** Where it came from, in words. */
export function sourceLabel(kind: string): string {
  const labels: Record<string, string> = {
    archive: 'Archive', folder: 'Folder', markdown: 'SKILL.md', pack: 'Skill pack', plugin: 'Claude plugin',
    upload: 'Uploaded folder', url: 'Downloaded', draft: 'Draft',
  };
  return labels[kind] ?? kind;
}

/** The trust badge for an installed skill, in words. */
export function trustLabel(trust: string | undefined): string {
  switch (trust) {
    case 'builtin': return 'built in';
    case 'reviewed': return 'reviewed';
    case 'unreviewed': return 'needs review';
    default: return 'yours';
  }
}
