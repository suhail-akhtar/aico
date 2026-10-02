/**
 * The review screen for a skill import — the step between "I have a skill
 * file" and "the agent follows it".
 *
 * An imported skill's text reaches the model as a procedure to follow, so a
 * person looks first (design §5.1, §7.2): every skill the import contains,
 * its files and which are scripts, what the scan found with file and line,
 * the spec's verdict (errors block the skill, warnings never do), what it
 * costs in tokens, and where it came from with its hash. One button —
 * "Install and enable" — is that person's yes; anything less installs
 * nothing usable.
 *
 * Shared by the web Settings pane and AICO Desktop's Settings → Skills (the
 * desktop wraps it in its own Modal). Status is never colour alone: every
 * badge carries its word (§7.8). The logic of what to show lives in
 * `skill-review.ts`, where it is tested.
 *
 * @module components/settings/SkillReview
 */

import React, { useMemo, useState } from 'react';
import {
  defaultSelection, formatBytes, installLabel, kindLabel, selectable, severityLabel, sortFindings,
  sourceLabel, summaryLine, type ImportReview, type ReviewedSkill, type ReviewFinding, type SkillProvenance,
} from '../../skill-review';

const SEVERITY_STYLE: Record<ReviewFinding['severity'], string> = {
  high: 'bg-aico-danger/10 text-aico-danger',
  warn: 'bg-aico-warning/15 text-aico-warning',
  info: 'bg-aico-hover text-aico-muted',
};

function Badge({ children, tone = 'muted', title }: { children: React.ReactNode; tone?: 'muted' | 'warn' | 'danger' | 'good'; title?: string }): React.ReactElement {
  const style = tone === 'danger' ? 'bg-aico-danger/10 text-aico-danger'
    : tone === 'warn' ? 'bg-aico-warning/15 text-aico-warning'
      : tone === 'good' ? 'bg-aico-success/10 text-aico-success'
        : 'bg-aico-hover text-aico-muted';
  return <span title={title} className={`inline-flex items-center rounded px-1.5 py-0.5 text-[10.5px] font-medium ${style}`}>{children}</span>;
}

function Findings({ findings }: { findings: ReviewFinding[] }): React.ReactElement | null {
  const sorted = useMemo(() => sortFindings(findings), [findings]);
  if (!sorted.length) return null;
  return (
    <ul className="mt-1 space-y-1" aria-label="Scan findings">
      {sorted.map((f, i) => (
        <li key={`${f.file}:${f.line ?? 0}:${i}`} className="flex items-start gap-2 text-[12px] leading-[17px]">
          <span className={`mt-px shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${SEVERITY_STYLE[f.severity]}`}>
            {severityLabel(f.severity)}
          </span>
          <span className="min-w-0">
            <span className="font-medium text-aico-primary">{kindLabel(f.kind)}</span>
            <span className="font-mono text-aico-secondary"> {f.file}{f.line ? `:${f.line}` : ''}</span>
            <span className="block break-words text-aico-secondary">{f.message}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}

/** One skill's card: what it is, what it carries, what was found. */
export function ReviewedSkillCard({ skill, checked, onToggle, showCheckbox = true }: {
  skill: ReviewedSkill;
  checked?: boolean;
  onToggle?: () => void;
  showCheckbox?: boolean;
}): React.ReactElement {
  const can = selectable(skill);
  const id = `skill-review-${skill.name.replace(/[^a-z0-9-]/gi, '-')}-${skill.at.replace(/[^a-z0-9-]/gi, '-')}`;
  return (
    <section className="rounded-xl border border-aico-border p-3" aria-labelledby={`${id}-title`}>
      <div className="flex items-start gap-2.5">
        {showCheckbox && (
          <input id={id} type="checkbox" className="mt-1 h-4 w-4 shrink-0 accent-[var(--aico-accent)]"
            checked={!!checked && can} disabled={!can} onChange={onToggle}
            aria-label={`Install ${skill.name}`} />
        )}
        <div className="min-w-0 flex-1">
          <div id={`${id}-title`} className="flex flex-wrap items-center gap-1.5">
            <label htmlFor={showCheckbox ? id : undefined} className="font-mono text-[13px] font-medium text-aico-primary">{skill.name}</label>
            {skill.errors.length > 0 && <Badge tone="danger">Cannot install</Badge>}
            {skill.exists && <Badge tone="warn" title="Ticking it replaces the installed one">{skill.exists.builtin ? 'Replaces a built-in' : 'Already installed'}</Badge>}
            {skill.totals.high > 0 && <Badge tone="danger">{skill.totals.high} high</Badge>}
            {skill.totals.high === 0 && skill.totals.warn === 0 && <Badge tone="good">Nothing flagged</Badge>}
          </div>
          <p className="mt-0.5 text-[12.5px] leading-[18px] text-aico-secondary">{skill.description || '(no description)'}</p>
          <p className="mt-1 text-[11.5px] text-aico-muted">
            {summaryLine(skill)} · ~{skill.tokens.catalogue} tokens in every request, ~{skill.tokens.body.toLocaleString('en-US')} when opened
            {skill.license ? ` · licence: ${skill.license}` : ''}
          </p>
          {skill.allowedTools?.length ? (
            <p className="mt-0.5 text-[11.5px] text-aico-muted">Expects tools: <span className="font-mono">{skill.allowedTools.join(', ')}</span> (shown, never pre-approved)</p>
          ) : null}

          {skill.errors.length > 0 && (
            <ul className="mt-2 space-y-0.5 text-[12px] text-aico-danger" aria-label="Errors">
              {skill.errors.map(e => <li key={e}><span className="font-semibold">Error:</span> {e}</li>)}
            </ul>
          )}
          {skill.warnings.length > 0 && (
            <ul className="mt-1.5 space-y-0.5 text-[12px] text-aico-warning" aria-label="Warnings">
              {skill.warnings.map(w => <li key={w}><span className="font-semibold">Warning:</span> {w}</li>)}
            </ul>
          )}

          <Findings findings={skill.findings.filter(f => f.severity !== 'info')} />

          <details className="mt-2 text-[12px]">
            <summary className="cursor-pointer select-none text-aico-secondary hover:text-aico-primary">
              Files ({skill.files.length}){skill.scripts.length ? ` — ${skill.scripts.length} script${skill.scripts.length === 1 ? '' : 's'}, never run on install` : ''}
            </summary>
            <ul className="mt-1 max-h-48 space-y-0.5 overflow-y-auto pl-1 font-mono text-[11.5px] text-aico-secondary">
              {skill.files.map(f => (
                <li key={f.path} className="flex items-center gap-2">
                  <span className="truncate">{f.path}</span>
                  <span className="shrink-0 text-aico-muted">{formatBytes(f.size)}</span>
                  {f.script && <Badge>script · {f.script}</Badge>}
                </li>
              ))}
            </ul>
          </details>
          <p className="mt-1 break-all font-mono text-[10.5px] text-aico-muted" title="sha256 of the skill's files, as reviewed">sha256 {skill.sha256}</p>
        </div>
      </div>
    </section>
  );
}

/**
 * A staged import's review. `onInstall(select, enable)` — `enable` is the
 * person's "Install and enable"; `false` installs unreviewed (on disk, out
 * of the catalogue).
 */
export function SkillImportReview({ review, busy, onInstall, onCancel }: {
  review: ImportReview;
  busy?: boolean;
  onInstall: (select: string[], enable: boolean, overwrite: boolean) => void;
  onCancel: () => void;
}): React.ReactElement {
  const [selected, setSelected] = useState<string[]>(() => defaultSelection(review));
  const toggle = (name: string): void => setSelected(s => (s.includes(name) ? s.filter(x => x !== name) : [...s, name]));
  const replacing = review.skills.filter(s => selected.includes(s.name) && s.exists).length;
  const highs = review.skills.filter(s => selected.includes(s.name)).reduce((n, s) => n + s.totals.high, 0);

  return (
    <div className="flex min-h-0 flex-col">
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-1">
        <div className="text-[12px] text-aico-secondary">
          <p>
            <span className="font-medium text-aico-primary">{sourceLabel(review.sourceKind)}</span>
            {review.plugin ? <> “{review.plugin.name}”{review.plugin.version ? ` ${review.plugin.version}` : ''}</> : null}
            {' '}— <span className="break-all font-mono text-[11.5px]">{review.source}</span>
          </p>
          {review.sourceSha256 && <p className="break-all font-mono text-[10.5px] text-aico-muted">sha256 {review.sourceSha256}</p>}
          <p className="mt-1">
            {review.skills.length} skill{review.skills.length === 1 ? '' : 's'} found. Nothing has been installed and nothing has been run.
            Read what each one carries; a skill’s text is followed by the agent, and its scripts can be run by the agent later through its normal, approved tools.
          </p>
          {review.notes.map(n => <p key={n} className="mt-1 text-aico-muted">{n}</p>)}
        </div>
        {review.skills.map(s => (
          <ReviewedSkillCard key={`${s.at}:${s.name}`} skill={s} checked={selected.includes(s.name)} onToggle={() => toggle(s.name)}
            showCheckbox={review.skills.length > 1 || !selectable(s) || !!s.exists} />
        ))}
      </div>
      <div className="mt-3 flex flex-wrap items-center justify-end gap-2 border-t border-aico-border pt-3">
        {highs > 0 && <p className="mr-auto text-[12px] text-aico-danger"><span className="font-semibold">{highs} high finding{highs === 1 ? '' : 's'}</span> in the selection — read them first.</p>}
        <button type="button" onClick={onCancel} disabled={busy}
          className="rounded-lg px-3 py-1.5 text-[12.5px] text-aico-secondary transition-colors hover:bg-aico-hover disabled:opacity-40">
          Cancel
        </button>
        <button type="button" onClick={() => onInstall(selected, false, replacing > 0)} disabled={busy || selected.length === 0}
          title="On disk, but the agent cannot use it until someone reviews and enables it"
          className="rounded-lg border border-aico-border px-3 py-1.5 text-[12.5px] text-aico-primary transition-colors hover:bg-aico-hover disabled:opacity-40">
          Install without enabling
        </button>
        <button type="button" onClick={() => onInstall(selected, true, replacing > 0)} disabled={busy || selected.length === 0}
          className="rounded-lg bg-aico-accent px-3 py-1.5 text-[12.5px] font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-40">
          {busy ? 'Installing…' : installLabel(selected.length, replacing)}
        </button>
      </div>
    </div>
  );
}

/** An installed skill's review, for "Review and enable" (or just to look). */
export function InstalledSkillReview({ skill, trust, trustReason, busy, onEnable, onCancel }: {
  skill: ReviewedSkill & { provenance?: SkillProvenance };
  trust: string;
  trustReason?: string;
  busy?: boolean;
  onEnable?: () => void;
  onCancel: () => void;
}): React.ReactElement {
  const p = skill.provenance;
  return (
    <div className="flex min-h-0 flex-col">
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-1">
        <div className="text-[12px] text-aico-secondary">
          {p ? (
            <>
              <p><span className="font-medium text-aico-primary">{sourceLabel(p.sourceKind)}</span> — <span className="break-all font-mono text-[11.5px]">{p.source}</span></p>
              <p className="text-aico-muted">Imported {new Date(p.importedAt).toLocaleString()}{p.reviewedAt ? ` · reviewed ${new Date(p.reviewedAt).toLocaleString()}` : ''}{p.plugin ? ` · from plugin ${p.plugin}` : ''}</p>
            </>
          ) : <p>Written here (no import record).</p>}
          {trust === 'unreviewed' && (
            <p className="mt-1 text-aico-warning"><span className="font-semibold">Needs review:</span> {trustReason ?? 'not reviewed yet'}. The agent cannot use it until you enable it.</p>
          )}
        </div>
        <ReviewedSkillCard skill={skill} showCheckbox={false} />
      </div>
      <div className="mt-3 flex items-center justify-end gap-2 border-t border-aico-border pt-3">
        <button type="button" onClick={onCancel} disabled={busy}
          className="rounded-lg px-3 py-1.5 text-[12.5px] text-aico-secondary transition-colors hover:bg-aico-hover disabled:opacity-40">
          {onEnable ? 'Not now' : 'Close'}
        </button>
        {onEnable && (
          <button type="button" onClick={onEnable} disabled={busy || skill.errors.length > 0}
            className="rounded-lg bg-aico-accent px-3 py-1.5 text-[12.5px] font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-40">
            {busy ? 'Enabling…' : 'Enable this skill'}
          </button>
        )}
      </div>
    </div>
  );
}
