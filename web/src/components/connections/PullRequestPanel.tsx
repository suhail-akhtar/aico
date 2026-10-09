/**
 * A task's pull request in the drawer: where it stands on the remote, and the one action
 * AICO offers on it.
 *
 * The remote is the gate in pull request mode, so this panel's job is to show the remote's
 * own words faithfully: each check by name with its link, the reviews as the remote counts
 * them, and, when it will not merge yet, the reasons it gave. AICO adds none of its own
 * verdict. Check names and summaries are the remote's text (untrusted): they are rendered
 * as plain text, never as markup.
 *
 * Merging is the one thing the person can ask AICO to do here, and it is offered only when
 * the remote itself reports the pull request mergeable with its requirements met
 * (`canMergeOnRemote`), or, where the remote offers it, as "merge when the pipeline succeeds" while a running
 * pipeline is the one thing in the way (`canArmAutoMerge`). It is a destructive-style action: the first click turns the button
 * into a confirmation that names the pull request and the trunk. The remote can still
 * refuse (a check started, someone pushed); its reason is shown as written. AICO never
 * merges on its own and never bypasses a protection.
 *
 * What it does not do: poll (the board's frames carry fresh `pr` state), post comments, or
 * re-run checks.
 *
 * @module web/components/connections/PullRequestPanel
 */

import React, { useState } from 'react';
import { api } from '../../api';
import { upsertTask } from '../../delivery';
import type { Task } from '../../delivery-types';
import type { RemoteCheck } from '../../../../shared/connections/types';
import {
  autoMergeConfirmText, autoMergeLabel, canArmAutoMerge, canMergeOnRemote, mergeBlockers, mergeButtonLabel, mergeConfirmText, prChips, prName, prStateWord, providerLabel, remoteChip,
} from '../../connections';
import { ago } from '../../delivery-model';
import { DvIcon } from '../delivery/icons';
import { BTN_GHOST, BTN_PRIMARY, Callout, ErrorLine, Pill, Spinner } from '../delivery/ui';
import { useBoardConnection } from './context';
import { ChipPill, ExternalLink } from './parts';

const CHECK_ICON: Record<RemoteCheck['state'], { glyph: 'checkCircle' | 'xCircle' | 'clock'; tone: string; word: string }> = {
  success: { glyph: 'checkCircle', tone: 'text-aico-success', word: 'Passed' },
  failure: { glyph: 'xCircle', tone: 'text-aico-danger', word: 'Failed' },
  pending: { glyph: 'clock', tone: 'text-aico-warning', word: 'Running' },
  neutral: { glyph: 'checkCircle', tone: 'text-aico-muted', word: 'Neutral' },
  skipped: { glyph: 'checkCircle', tone: 'text-aico-muted', word: 'Skipped' },
};

export function PullRequestPanel({ task, now }: { task: Task; now: number }): React.ReactElement | null {
  const pr = task.pr;
  const bc = useBoardConnection().connection;
  if (!pr) return null;
  const chips = prChips(pr);
  const blockers = mergeBlockers(pr);
  const where = bc && bc.connection === pr.connection ? providerLabel(bc.provider) : 'the remote';
  const approvals = pr.reviews.required !== undefined ? `${pr.reviews.approved} of ${pr.reviews.required} required approvals` : `${pr.reviews.approved} approval${pr.reviews.approved === 1 ? '' : 's'}`;
  return (
    <section aria-label="Pull request" className="space-y-3 rounded-xl border border-aico-border-subtle bg-aico-surface p-4">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <ExternalLink href={pr.url} className="text-[14px] font-medium" title={`Open on ${where}`}>{prName(pr)} on {where}</ExternalLink>
        <Pill tone={pr.state === 'merged' ? 'success' : 'neutral'}>{prStateWord(pr)}</Pill>
        <span className="flex-1" />
        <span className="text-[11.5px] text-aico-muted">Checked {ago(pr.observedAt, now) || 'just now'}</span>
      </div>

      <ul className="flex flex-wrap gap-1.5" aria-label="Status">
        {chips.map(c => <li key={c.id}><ChipPill chip={c} /></li>)}
      </ul>

      {pr.state === 'open' && (
        <div>
          <h4 className="mb-1 text-[12px] font-medium text-aico-secondary">Checks</h4>
          {pr.checks.items.length === 0 ? (
            <p className="text-[12.5px] text-aico-secondary">The remote reports no checks for this pull request.</p>
          ) : (
            <ul className="overflow-hidden rounded-lg border border-aico-border-subtle bg-aico-bg">
              {pr.checks.items.map((c, i) => {
                const k = CHECK_ICON[c.state] ?? CHECK_ICON.neutral;
                return (
                  <li key={`${c.name}-${i}`} className="flex items-start gap-2 border-b border-aico-border-subtle px-3 py-1.5 text-[12.5px] last:border-b-0">
                    <DvIcon name={k.glyph} size={15} className={`mt-px shrink-0 ${k.tone}`} />
                    <span className="min-w-0 flex-1">
                      {c.url ? <ExternalLink href={c.url} className="break-all">{c.name}</ExternalLink> : <span className="break-all text-aico-primary">{c.name}</span>}
                      {c.summary && <span className="mt-0.5 block line-clamp-3 text-[12px] leading-snug text-aico-secondary">{c.summary}</span>}
                    </span>
                    <span className="shrink-0 text-[11.5px] text-aico-muted">{k.word}</span>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}

      {pr.state === 'open' && (
        <div className="space-y-1 text-[12.5px] text-aico-secondary">
          <p><span className="font-medium text-aico-primary">Reviews:</span> {pr.reviews.state === 'changes' ? `${pr.reviews.changesRequested} reviewer${pr.reviews.changesRequested === 1 ? '' : 's'} asked for changes. ` : ''}{approvals}.</p>
          {pr.protectedBase && <p>The target branch is protected on the remote.</p>}
        </div>
      )}

      {pr.state === 'open' && (
        blockers.length === 0 ? (
          <Callout tone="success">The remote says it can be merged now.</Callout>
        ) : (
          <Callout tone="warning">
            <p className="font-medium">Not ready to merge</p>
            <ul className="mt-1 space-y-0.5 text-aico-secondary">{blockers.map((b, i) => <li key={i}>{b}</li>)}</ul>
          </Callout>
        )
      )}
    </section>
  );
}

/** Where a task came from, with one click to promote it when the remote shows it ready. */
export function RemoteSource({ task, project }: { task: Task; project: string }): React.ReactElement | null {
  const bc = useBoardConnection().connection;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const chip = remoteChip(task.remote, bc && bc.connection === task.remote?.connection ? providerLabel(bc.provider) : 'the remote');
  if (!chip) return null;
  const promote = chip.readyOnRemote && task.status === 'backlog';
  return (
    <section aria-label="Source" className="space-y-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px]">
        <ExternalLink href={chip.url}>{chip.text}</ExternalLink>
        {chip.closed && <span className="text-aico-muted">closed there</span>}
        {promote && <span className="text-aico-secondary">Ready on remote</span>}
        {promote && (
          <button
            type="button" disabled={busy} className={`${BTN_GHOST} !py-1 !text-[12.5px] !text-aico-accent`}
            onClick={() => {
              setBusy(true); setError(null);
              api.deliveryUpdate(task.id, project, { status: 'ready' }).then(upsertTask).catch(e => setError(e instanceof Error ? e.message : String(e))).finally(() => setBusy(false));
            }}
          >
            {busy ? 'Moving…' : 'Move to Ready'}
          </button>
        )}
      </div>
      {promote && <p className="text-[12px] text-aico-muted">The remote shows this item as ready. Nothing starts until you move it.</p>}
      {error && <ErrorLine>{error}</ErrorLine>}
    </section>
  );
}

/** The drawer's foot for a task whose pull request the remote says is mergeable. Nothing renders otherwise. */
export function MergeBar({ task, project, onHandled }: { task: Task; project: string; onHandled: (message: string) => void }): React.ReactElement | null {
  const { connection, trunk } = useBoardConnection();
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const arm = canArmAutoMerge(task);
  if (!task.pr || (!canMergeOnRemote(task) && !arm)) return null;
  const pr = task.pr;

  const merge = async (): Promise<void> => {
    setBusy(true); setError(null);
    try { upsertTask(await api.deliveryMergePr(task.id, project)); onHandled(arm ? `${prName(pr)} will merge into ${trunk} when its pipeline succeeds.` : `Merged ${prName(pr)} into ${trunk}.`); setConfirm(false); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); setConfirm(false); }
    finally { setBusy(false); }
  };

  return (
    <footer className="shrink-0 space-y-2 border-t border-aico-border-subtle bg-aico-bg px-5 py-3">
      {error && <ErrorLine>{error}</ErrorLine>}
      {confirm ? (
        <div className="space-y-2" role="alert">
          <p className="text-[13px] text-aico-primary">{arm ? autoMergeConfirmText(pr, trunk, connection?.provider) : mergeConfirmText(pr, trunk)}</p>
          <div className="flex gap-2">
            <button type="button" className={`${BTN_PRIMARY} !bg-aico-danger !text-white`} disabled={busy} onClick={() => void merge()}>
              {busy ? <><Spinner />{arm ? 'Setting…' : 'Merging…'}</> : arm ? `Merge ${prName(pr)} when the pipeline succeeds` : `Merge ${prName(pr)}`}
            </button>
            <button type="button" className={BTN_GHOST} disabled={busy} onClick={() => setConfirm(false)}>Cancel</button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" className={BTN_PRIMARY} onClick={() => { setError(null); setConfirm(true); }}>
            <DvIcon name="check" size={15} />{arm ? autoMergeLabel(connection?.provider) : mergeButtonLabel(connection?.provider)}
          </button>
          <span className="ml-auto text-[12px] text-aico-muted">{arm ? 'Only the running pipeline is in the way' : 'The remote confirmed it can be merged'}</span>
        </div>
      )}
    </footer>
  );
}
