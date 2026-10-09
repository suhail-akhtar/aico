/**
 * The Review queue: finished work waiting for a person, riskiest first, with a
 * batch path for the work that does not need a close look.
 *
 * WHY a batch: once agents run in parallel the queue fills with small, low-risk,
 * green changes, and landing each one is four clicks of ceremony around a
 * decision that takes no thought. A person can tick them and say yes once. What
 * keeps that safe is that the box exists ONLY on a low-risk task nobody is
 * waiting on (`batchCheck`): a medium, high or unassessed row shows why it is
 * not tickable and says to open it, so no gesture here can wave through the
 * work that deserves a look. The engine checks every id again and refuses the
 * whole set if one is not eligible (a 409 with its reason, shown as written),
 * and the request is a person's act — the same gate as landing one task.
 *
 * Keyboard: arrow keys move between rows, Space ticks the focused row (when it
 * may be), Enter opens it. The checkbox is a real checkbox too, for a pointer
 * or a screen reader. The action bar is sticky at the foot of the scroller, so
 * the list does not move when the first box is ticked.
 *
 * After a batch the result stays on screen until dismissed: how many landed and
 * every skipped task with the engine's reason. What it does not do: land a task
 * that is not green, or pick which ones to tick for you ("Select all low risk"
 * is the one shortcut, and it only ever selects what is already eligible).
 *
 * @module web/components/delivery/ReviewQueue
 */

import React, { useMemo, useRef, useState } from 'react';
import { api } from '../../api';
import { refreshBoard } from '../../delivery';
import type { Task } from '../../delivery-types';
import {
  ago, batchButtonLabel, batchCheck, checksSummary, formatUsd, orderSelection, pruneSelection, selectAllLow, summariseBatch, toMs, toggleSelection,
  type BatchSummary,
} from '../../delivery-model';
import { DvIcon } from './icons';
import { BTN_GHOST, BTN_OUTLINE, BTN_PRIMARY, Callout, ErrorLine, PriorityChip, RiskBadge, Spinner, riskSpine, useTaskRef } from './ui';

export function ReviewQueue({ list, now, selectedId, project, onOpen, onShowBoard }: {
  list: Task[]; now: number; selectedId: string | null; project: string;
  onOpen: (t: Task) => void; onShowBoard: () => void;
}): React.ReactElement {
  const taskRef = useTaskRef();
  const ul = useRef<HTMLUListElement>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [summary, setSummary] = useState<BatchSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  // A task can leave review, turn risky or start waiting on a person while ticked: it drops out of the selection.
  const chosen = useMemo(() => pruneSelection(selected, list), [selected, list]);
  const lowIds = useMemo(() => selectAllLow(list), [list]);
  const picked = new Set(chosen);

  const focusRow = (li: Element | undefined): void => { li?.querySelector<HTMLElement>('[data-row]')?.focus(); };
  const onKey = (e: React.KeyboardEvent): void => {
    const active = document.activeElement as HTMLElement | null;
    const li = active?.closest('li[data-li]');
    if (!li || !ul.current) return;
    const lis = [...ul.current.querySelectorAll('li[data-li]')];
    const i = lis.indexOf(li);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      focusRow(lis[e.key === 'Home' ? 0 : e.key === 'End' ? lis.length - 1 : Math.max(0, Math.min(lis.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))]);
    } else if (e.key === ' ' && active?.hasAttribute('data-row')) {
      // Space on the row ticks it (a button would otherwise open it); the checkbox handles its own Space.
      e.preventDefault();
      const id = li.getAttribute('data-id');
      if (id) setSelected(s => toggleSelection(s, id, list));
    }
  };
  // Firefox fires the button's click on Space's keyup; swallow it so a tick never opens the task.
  const onKeyUp = (e: React.KeyboardEvent): void => {
    if (e.key === ' ' && (document.activeElement as HTMLElement | null)?.hasAttribute('data-row')) e.preventDefault();
  };

  const land = async (): Promise<void> => {
    const ids = orderSelection(chosen, list);
    if (ids.length === 0 || busy) return;
    const titles = new Map(list.map(t => [t.id, t.title]));
    setBusy(true); setError(null); setSummary(null);
    try {
      const r = await api.deliveryApproveBatch(project, ids);
      setSummary(summariseBatch(r, taskRef, id => titles.get(id)));
      setSelected([]);
      void refreshBoard();
    } catch (e) {
      // The engine refuses the set as a whole (409) and says why in words; the ticks stay so the set can be fixed.
      setError((e as Error).message);
    } finally { setBusy(false); }
  };

  if (list.length === 0 && !summary) {
    return (
      <div className="mx-auto mt-14 max-w-md px-6 text-center">
        <DvIcon name="inbox" size={28} className="mx-auto text-aico-muted" />
        <p className="mt-3 text-[15px] font-medium text-aico-primary">Nothing is waiting for review</p>
        <p className="mt-1 text-[13px] leading-relaxed text-aico-secondary">When an agent finishes a task it lands here with a risk rating, riskiest first, so you can work through the queue top to bottom. Low-risk work can be approved together.</p>
        <button type="button" className={`${BTN_OUTLINE} mt-4`} onClick={onShowBoard}>Back to the board</button>
      </div>
    );
  }

  const high = list.filter(t => t.risk?.level === 'high').length;
  const allLowPicked = lowIds.length > 0 && lowIds.every(id => picked.has(id));

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-4 sm:px-6">
      <div className="mx-auto w-full max-w-4xl flex-1 py-4">
        {(summary || error) && (
          <div className="mb-3">
            {error ? (
              <div className="flex items-start gap-2">
                <div className="min-w-0 flex-1"><ErrorLine>{error}</ErrorLine></div>
                <button type="button" className={BTN_GHOST} onClick={() => setError(null)}>Dismiss</button>
              </div>
            ) : summary && (
              <div>
                <Callout tone={summary.tone === 'ok' ? 'success' : summary.tone === 'partial' ? 'warning' : 'danger'} role="status" onDismiss={() => setSummary(null)}>
                  <p className="font-medium">{summary.headline}</p>
                  {summary.skipped.length > 0 && (
                    <ul className="mt-1.5 space-y-1">
                      {summary.skipped.map(s => (
                        <li key={s.id} className="text-[12.5px] text-aico-secondary">
                          <span className="font-mono tabular-nums text-aico-primary">{s.label}</span>
                          {s.title ? <> <span className="text-aico-primary">{s.title}</span></> : null}
                          <span aria-hidden="true"> — </span><span className="sr-only">: </span>{s.reason}
                        </li>
                      ))}
                    </ul>
                  )}
                </Callout>
              </div>
            )}
          </div>
        )}

        {list.length === 0 ? (
          <div className="mt-8 text-center">
            <p className="text-[14px] font-medium text-aico-primary">The queue is clear</p>
            <button type="button" className={`${BTN_OUTLINE} mt-3`} onClick={onShowBoard}>Back to the board</button>
          </div>
        ) : (
          <>
            <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1">
              <p className="text-[13px] text-aico-secondary">
                <span className="font-medium tabular-nums text-aico-primary">{list.length}</span> waiting, riskiest first{high > 0 ? <> · <span className="tabular-nums">{high}</span> high risk</> : null}.
                <span className="hidden md:inline"> Arrow keys move, Space ticks a low-risk row, Enter opens.</span>
              </p>
              <span className="flex-1" />
              {lowIds.length > 0 && (
                <button
                  type="button" className={`${BTN_OUTLINE} !py-1 !text-[12.5px]`} disabled={busy || allLowPicked}
                  onClick={() => setSelected(selectAllLow(list))}
                >
                  Select all low risk <span className="tabular-nums text-aico-muted">({lowIds.length})</span>
                </button>
              )}
            </div>

            <ul ref={ul} onKeyDown={onKey} onKeyUp={onKeyUp} className="space-y-2" aria-label="Tasks waiting for review">
              {list.map(t => {
                const files = t.touches?.files.length ?? 0;
                const check = batchCheck(t);
                const on = picked.has(t.id);
                return (
                  <li
                    key={t.id} data-li data-id={t.id}
                    className={`relative flex items-stretch overflow-hidden rounded-xl border transition-colors before:absolute before:inset-y-0 before:left-0 before:w-[3px] before:content-[''] ${riskSpine(t.risk?.level)} ${
                      on ? 'border-aico-accent bg-aico-accent-soft' : t.id === selectedId ? 'border-aico-accent bg-aico-bg' : 'border-aico-border-subtle bg-aico-bg'}`}
                  >
                    <div className="flex w-12 shrink-0 items-center justify-center pl-1">
                      {check.ok ? (
                        <label className="flex h-full min-h-[44px] w-full cursor-pointer items-center justify-center" title="Select for batch approval">
                          <input
                            type="checkbox" checked={on} disabled={busy}
                            onChange={() => setSelected(s => toggleSelection(s, t.id, list))}
                            aria-label={`Select ${taskRef(t.id)} ${t.title} for batch approval`}
                            className="h-4 w-4 cursor-pointer accent-[var(--aico-accent)]"
                          />
                        </label>
                      ) : (
                        <span title={check.reason} className="flex h-full min-h-[44px] w-full cursor-not-allowed items-center justify-center">
                          <input
                            type="checkbox" disabled checked={false} readOnly
                            aria-label={`${taskRef(t.id)} ${t.title} cannot be selected. ${check.reason}`}
                            className="h-4 w-4 opacity-45"
                          />
                        </span>
                      )}
                    </div>
                    <button
                      type="button" data-row onClick={() => onOpen(t)}
                      className="grid min-w-0 flex-1 grid-cols-1 items-center gap-x-4 gap-y-1.5 py-2.5 pl-1 pr-4 text-left transition-colors hover:bg-aico-hover focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-aico-accent sm:grid-cols-[minmax(0,1fr)_auto]"
                    >
                      <span className="min-w-0">
                        <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11.5px] text-aico-muted">
                          <span className="font-mono tabular-nums">{taskRef(t.id)}</span><PriorityChip priority={t.priority} />
                          {files > 0 && <span className="tabular-nums">{files} {files === 1 ? 'file' : 'files'}</span>}
                          {toMs(t.updatedAt) ? <span>{ago(t.updatedAt, now)}</span> : null}
                          {t.costUsd ? <span className="tabular-nums">{formatUsd(t.costUsd)}</span> : null}
                        </span>
                        <span className="mt-0.5 block truncate text-[14px] font-medium text-aico-primary">{t.title}</span>
                        <span className="mt-0.5 block truncate text-[12.5px] text-aico-secondary">{checksSummary(t, 140) ?? t.risk?.reasons[0] ?? 'No checks summary yet'}</span>
                      </span>
                      <span className="flex flex-wrap items-center gap-x-3 gap-y-1 sm:flex-col sm:items-end sm:gap-1">
                        <RiskBadge level={t.risk?.level} score={t.risk?.score} unassessed={!t.risk} />
                        {!check.ok && <span className="text-[11.5px] leading-tight text-aico-muted sm:max-w-[200px] sm:text-right">{check.hint}</span>}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </div>

      {chosen.length > 0 && (
        <div className="sticky bottom-0 z-10 -mx-4 border-t border-aico-border bg-aico-bg px-4 py-3 shadow-[0_-10px_24px_rgba(0,0,0,0.08)] sm:-mx-6 sm:px-6">
          <div className="mx-auto flex w-full max-w-4xl flex-wrap items-center gap-x-3 gap-y-2">
            <span className="text-[13px] font-medium tabular-nums text-aico-primary" role="status" aria-live="polite">{chosen.length} selected</span>
            {!allLowPicked && lowIds.length > chosen.length && (
              <button type="button" className={BTN_GHOST} disabled={busy} onClick={() => setSelected(selectAllLow(list))}>Select all low risk ({lowIds.length})</button>
            )}
            <span className="hidden flex-1 text-[12px] text-aico-muted lg:block">Lands in the order shown. Anything that cannot land is skipped, with the reason.</span>
            <span className="flex-1 lg:hidden" />
            <button type="button" className={BTN_GHOST} disabled={busy} onClick={() => setSelected([])}>Clear</button>
            <button type="button" className={BTN_PRIMARY} disabled={busy} onClick={() => void land()}>
              {busy ? <Spinner /> : <DvIcon name="check" size={15} />}{batchButtonLabel(chosen.length, busy)}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
