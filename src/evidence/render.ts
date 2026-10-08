/**
 * The change packet as text a person pastes into a pull request or a commit.
 *
 * Markdown for a PR description, a one-line `Verified:` summary for a commit
 * body, JSON for anything that reads it by machine. All three come from the
 * same `EvidencePacket`; none adds a fact.
 *
 * Wording is neutral on purpose. It reports "recorded" and "not run", never
 * "safe" or "ready", and it names no author, tool or model as having written the
 * change — the models appear only under *Models and cost*, as what served the
 * requests (AGENTS.md §4.1: no AI attribution in commits, PRs or docs).
 *
 * @module evidence/render
 */

import type { CheckEntry, EvidencePacket } from './packet.js';

const esc = (s: string): string => s.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
const secs = (ms: number): string => `${(ms / 1000).toFixed(1)}s`;
const usd = (n: number): string => (n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`);

function testsCell(c: CheckEntry): string {
  const t = c.tests;
  if (!t) return c.findings ? `secrets ${c.findings.secrets}, high ${c.findings.high}, medium ${c.findings.medium}, advisories ${c.findings.advisories}` : '';
  const unit = t.unit === 'packages' ? ' packages' : '';
  return `${t.passed} passed, ${t.failed} failed, ${t.skipped} skipped${unit} (${t.runner})`;
}

function resultCell(c: CheckEntry): string {
  if (c.outcome === 'flaky') return `FLAKY — failed, then passed on a re-run${c.retry?.flaky?.length ? `: ${c.retry.flaky.slice(0, 3).join(', ')}` : ''}`;
  if (c.outcome === 'passed') return c.editsAfter > 0 || c.shellAfter > 0 ? 'passed (code may have changed afterwards)' : 'passed';
  const retry = c.retry && !c.retry.passed ? ' (failed again on re-run)' : '';
  return `FAILED${retry}`;
}

/** The pull-request form. */
export function renderMarkdown(p: EvidencePacket): string {
  const out: string[] = [];
  out.push('## Change evidence', '');
  out.push(`_Built from the session log (${p.session.events} events, through #${p.session.lastSeq}) and git. It states what was recorded; "not run" means no record of a run._`, '');
  if (p.goal) out.push(`**Goal** (${p.goal.source}): ${p.goal.text}`, '');

  // Files
  const f = p.files;
  if (f.source === 'none') out.push('### Files changed', '', 'No record: no git diff was available and the log shows no file writes.', '');
  else {
    out.push(`### Files changed — ${f.list.length} file${f.list.length === 1 ? '' : 's'}${f.source === 'git' ? `, +${f.added} −${f.removed} against ${f.base}` : ' (from the log; no line counts)'}`, '');
    if (f.list.length > 0) {
      out.push('| File | + | − | Written this session |', '|---|---:|---:|:---:|');
      for (const x of f.list.slice(0, 60)) out.push(`| ${esc(x.path)}${x.untracked ? ' (new, untracked)' : ''}${x.binary ? ' (binary)' : ''} | ${f.source === 'git' ? x.added : ''} | ${f.source === 'git' ? x.removed : ''} | ${x.bySession ? 'yes' : f.source === 'git' ? 'not in this log' : 'yes'} |`);
      if (f.list.length > 60) out.push(`| … ${f.list.length - 60} more | | | |`);
    }
    out.push('');
  }

  // Checks
  out.push('### Checks', '');
  if (p.checks.ran.length === 0) out.push('No check run is recorded in this log.');
  else {
    out.push('| Check | Command | Exit | Result | Detail | Time |', '|---|---|---:|---|---|---:|');
    for (const c of p.checks.ran) out.push(`| ${esc(c.name)}${c.cwd && c.cwd !== '.' ? ` (${esc(c.cwd)})` : ''} | \`${esc(c.command)}\` | ${c.exitCode ?? '—'} | ${esc(resultCell(c))} | ${esc(testsCell(c))} | ${secs(c.ms)} |`);
  }
  if (p.checks.notRun) out.push('', p.checks.notRun.length > 0 ? `**Not run:** ${p.checks.notRun.join(', ')}` : 'Every check the project defines has a recorded run.');
  out.push('');

  // VerifyApp
  out.push('### Browser verification (VerifyApp)', '');
  if (p.verifyApp.length === 0) out.push('Not run.');
  else for (const v of p.verifyApp) out.push(`- #${v.seq} ${v.verdict.toUpperCase()}`, ...v.summary.slice(0, 5).map(l => `  - ${esc(l)}`));
  out.push('');

  // Scans
  out.push('### Scans and findings', '');
  if (p.scans.length === 0) out.push('No scan result is recorded in this log. A control that found nothing may leave no record, so this is not proof that none ran.');
  else for (const s of p.scans) out.push(`- ${s.kind}${s.seq ? ` (#${s.seq})` : ''}: ${esc(s.result)}`, ...(s.findings ?? []).map(x => `  - ${esc(x)}`));
  out.push('');

  // Decisions
  out.push('### Approvals and denials', '');
  const d = p.decisions;
  const none = d.approvedByPerson.length + d.deniedByPerson.length + d.deniedByPolicy.length === 0;
  if (none) out.push('None recorded. (Calls that were auto-approved by a setting, and terminal prompts, leave no record.)');
  else {
    if (d.approvedByPerson.length > 0) out.push(`- Approved by a person: ${d.approvedByPerson.map(x => `${x.name} ×${x.count}`).join(', ')}`);
    if (d.deniedByPerson.length > 0) out.push(`- Refused by a person: ${d.deniedByPerson.map(x => `${x.name} ×${x.count}`).join(', ')}`);
    for (const x of d.deniedByPolicy) out.push(`- Denied by policy: ${x.name} ×${x.count} — ${esc(x.reason)}`);
  }
  out.push('');

  // Models and cost
  out.push('### Models and cost', '');
  if (p.models.length === 0) out.push('No model request is recorded.');
  else {
    for (const m of p.models) out.push(`- ${m.provider ? `${m.provider} / ` : ''}${m.model}: ${m.requests} request${m.requests === 1 ? '' : 's'}, ${m.inputTokens} in / ${m.outputTokens} out${m.cachedTokens ? ` (${m.cachedTokens} cached)` : ''}`);
    out.push('', `Estimated cost: ${usd(p.cost.usd)}${p.cost.delegatedUsd > 0 ? ` plus ${usd(p.cost.delegatedUsd)} for delegated agents` : ''}. ${p.cost.note}`);
  }
  out.push('');

  // Open items
  out.push('### Open items and known gaps', '');
  const o = p.open;
  if (o.todos.length === 0 && o.failingChecks.length === 0 && o.gaps.length === 0) out.push('None recorded.');
  else {
    for (const t of o.todos) out.push(`- [ ] ${esc(t.title)} (${t.status})`);
    if (o.failingChecks.length > 0) out.push(`- Not passing at the end of the log: ${o.failingChecks.join(', ')}`);
    for (const g of o.gaps) out.push(`- ${esc(g)}`);
  }
  out.push('');
  return out.join('\n');
}

/**
 * The commit-body form: one or two lines, facts only.
 *
 * `Verified: typecheck, test (412 passed) · FLAKY: build · not run: lint`.
 */
export function renderShort(p: EvidencePacket): string {
  const ok: string[] = []; const flaky: string[] = []; const failed: string[] = [];
  for (const c of p.checks.latest) {
    if (c.outcome === 'passed' && c.editsAfter === 0 && c.shellAfter === 0) ok.push(c.tests && c.tests.passed + c.tests.failed > 0 ? `${c.name} (${c.tests.passed} passed${c.tests.skipped ? `, ${c.tests.skipped} skipped` : ''})` : c.name);
    else if (c.outcome === 'flaky') flaky.push(c.name);
    else if (c.outcome === 'failed') failed.push(c.name);
    else ok.push(`${c.name} (before later edits)`);
  }
  const parts: string[] = [];
  if (ok.length > 0) parts.push(`Verified: ${ok.join(', ')}`);
  if (failed.length > 0) parts.push(`failing: ${failed.join(', ')}`);
  if (flaky.length > 0) parts.push(`flaky: ${flaky.join(', ')}`);
  const notRun = p.checks.notRun ?? [];
  if (notRun.length > 0) parts.push(`not run: ${notRun.join(', ')}`);
  if (p.verifyApp.length > 0) {
    const v = p.verifyApp[p.verifyApp.length - 1]!;
    parts.push(`VerifyApp ${v.verdict}`);
  }
  if (parts.length === 0) return 'Verified: no check run is recorded.';
  if (ok.length === 0) parts[0] = `Checks: ${parts[0]}`;
  return parts.join(' · ');
}

export function renderJson(p: EvidencePacket): string {
  return JSON.stringify(p, null, 2);
}

export type EvidenceFormat = 'md' | 'json' | 'short';

export function render(p: EvidencePacket, format: EvidenceFormat): string {
  return format === 'json' ? renderJson(p) : format === 'short' ? renderShort(p) : renderMarkdown(p);
}
