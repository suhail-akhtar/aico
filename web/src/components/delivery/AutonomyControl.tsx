/**
 * How much the board does on its own: one control in the header.
 *
 * A chip names the active level (Manual, Assisted, Autonomous, Full); its popover lists
 * the four with a plain-language line each, then the limits that bound them: the daily
 * budget, how many failures pause the agents, and the Running / Review limits. Raising
 * the level asks first, in a dialog that says what will now happen without anyone
 * clicking AND what will still always wait for a person (high-risk changes, anything the
 * secret scan or tests flag, questions and permissions, spending past the budget).
 * Lowering never asks: stopping autonomy should be one click, like stopping spend.
 *
 * WHY a popover and not a settings page: the owner asked to "go autonomous" from the
 * board. It has to be where the agents are, and it has to be honest about the trade, so
 * the consent text lives with the switch, not in documentation.
 *
 * What it does not do: enforce anything. The engine owns what each level does and refuses
 * what it must; the copy here is `AUTONOMY_LEVELS` (delivery-board.ts), kept next to its tests.
 *
 * @module web/components/delivery/AutonomyControl
 */

import React, { useEffect, useRef, useState } from 'react';
import { Portal } from '../Portal';
import { api } from '../../api';
import { refreshBoard } from '../../delivery';
import {
  AUTONOMY_LEVELS, alwaysNeedsYou, automaticAt, autonomyAllowed, autonomyLevel, autonomyNeedsConfirm, parseSettingsDraft, type SettingsDraft,
} from '../../delivery-board';
import type { Autonomy, BoardState } from '../../delivery-types';
import { DvIcon } from './icons';
import { BTN_GHOST, BTN_OUTLINE, BTN_PRIMARY, ErrorLine, INPUT, LABEL, Modal, Spinner, tint } from './ui';

export function AutonomyChip({ board, project }: { board: BoardState; project: string }): React.ReactElement {
  const level = autonomyLevel(board.autonomy);
  const [open, setOpen] = useState(false);
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const [confirm, setConfirm] = useState<Autonomy | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const w = board.settings;
  const fresh = (): SettingsDraft => ({
    budget: w.budgetUsdPerDay !== undefined ? String(w.budgetUsdPerDay) : '', failures: w.pauseAfterFailures !== undefined ? String(w.pauseAfterFailures) : '',
    wipRunning: w.wip?.running !== undefined ? String(w.wip.running) : '', wipReview: w.wip?.review !== undefined ? String(w.wip.review) : '',
  });
  const [draft, setDraft] = useState<SettingsDraft>(fresh);
  const [saved, setSaved] = useState(false);

  const show = (): void => {
    const r = btn.current!.getBoundingClientRect();
    setAt({ x: Math.max(8, Math.min(r.right - 380, window.innerWidth - 392)), y: r.bottom + 6 });
    setDraft(fresh()); setError(null); setSaved(false); setOpen(true);
  };

  useEffect(() => {
    if (!open) return;
    const close = (): void => setOpen(false);
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape' && !confirm) { e.stopPropagation(); close(); btn.current?.focus(); } };
    const onDown = (e: MouseEvent): void => { if (!pop.current?.contains(e.target as Node) && !btn.current?.contains(e.target as Node) && !confirm) close(); };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('mousedown', onDown);
    window.addEventListener('resize', close);
    pop.current?.querySelector<HTMLElement>('[role="radio"][aria-checked="true"]')?.focus();
    return () => { window.removeEventListener('keydown', onKey, true); window.removeEventListener('mousedown', onDown); window.removeEventListener('resize', close); };
  }, [open, confirm]);

  const apply = async (to: Autonomy): Promise<void> => {
    setBusy(true); setError(null);
    try { await api.deliverySettings(project, { autonomy: to }); await refreshBoard(); setConfirm(null); }
    catch (e) { setError((e as Error).message); setConfirm(null); setOpen(true); } // reopen, so the refusal is read where it was asked
    finally { setBusy(false); }
  };
  const pick = (to: Autonomy): void => {
    if (to === level.id) return;
    if (autonomyNeedsConfirm(board.autonomy, to)) { setOpen(false); setConfirm(to); } else void apply(to);
  };
  const saveLimits = async (): Promise<void> => {
    const r = parseSettingsDraft(draft, w.maxParallel);
    if (!r.ok) { setError(r.error); return; }
    setBusy(true); setError(null); setSaved(false);
    try { await api.deliverySettings(project, r.patch); await refreshBoard(); setSaved(true); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };

  const raised = level.id !== 'manual';
  const target = confirm ? AUTONOMY_LEVELS.find(l => l.id === confirm)! : null;

  return (
    <>
      <button
        ref={btn} type="button" aria-haspopup="dialog" aria-expanded={open} onClick={() => (open ? setOpen(false) : show())}
        title={`Autonomy: ${level.label}. ${level.line}`}
        className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[12.5px] font-medium text-aico-primary transition-colors hover:border-aico-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-aico-accent ${raised ? `${tint('accent')} border-[color-mix(in_srgb,var(--aico-accent)_45%,transparent)]` : 'border-aico-border'}`}
      >
        <DvIcon name="shield" size={14} className={raised ? 'text-aico-accent' : 'text-aico-muted'} />
        <span className="max-sm:sr-only text-aico-muted font-normal">Autonomy</span>{level.label}
        <DvIcon name="down" size={12} className="text-aico-muted" />
      </button>

      {open && at && (
        <Portal>
          <div
            ref={pop} role="dialog" aria-label="Autonomy" style={{ position: 'fixed', top: at.y, left: at.x, width: 380, maxWidth: 'calc(100vw - 16px)' }}
            className="z-[75] max-h-[calc(100vh-80px)] overflow-y-auto rounded-xl border border-aico-border bg-aico-bg p-3 shadow-xl"
          >
            <p className="px-1 pb-2 text-[12px] text-aico-secondary">How much the board does without asking you.{board.settings.autonomy !== level.id && ` Set to ${autonomyLevel(board.settings.autonomy).label}, lowered to ${level.label} by your organisation’s policy.`}</p>
            <div role="radiogroup" aria-label="Autonomy level" className="space-y-1">
              {AUTONOMY_LEVELS.map(l => {
                const on = l.id === level.id;
                const allowed = autonomyAllowed(l.id, board.autonomyCap);
                return (
                  <button
                    key={l.id} type="button" role="radio" aria-checked={on} disabled={busy || !allowed} onClick={() => pick(l.id)}
                    title={allowed ? undefined : `Your organisation allows up to ${autonomyLevel(board.autonomyCap).label}`}
                    onKeyDown={e => {
                      const i = AUTONOMY_LEVELS.findIndex(x => x.id === l.id);
                      const n = e.key === 'ArrowDown' ? i + 1 : e.key === 'ArrowUp' ? i - 1 : null;
                      if (n === null) return;
                      e.preventDefault();
                      (e.currentTarget.parentElement?.querySelectorAll<HTMLElement>('[role="radio"]')[(n + AUTONOMY_LEVELS.length) % AUTONOMY_LEVELS.length])?.focus();
                    }}
                    className={`flex w-full items-start gap-2.5 rounded-lg border px-2.5 py-2 text-left transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-aico-accent disabled:opacity-60 ${on ? 'border-aico-accent bg-aico-accent-soft' : 'border-transparent hover:bg-aico-hover'}`}
                  >
                    <span className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border ${on ? 'border-aico-accent bg-aico-accent text-aico-on-accent' : 'border-aico-border'}`} aria-hidden="true">
                      {on && <DvIcon name="check" size={11} />}
                    </span>
                    <span className="min-w-0">
                      <span className="block text-[13px] font-medium text-aico-primary">{l.label}</span>
                      <span className="block text-[12px] leading-snug text-aico-secondary">{l.line}</span>
                      {!allowed && <span className="mt-0.5 block text-[11.5px] text-aico-muted">Your organisation allows up to {autonomyLevel(board.autonomyCap).label}.</span>}
                    </span>
                  </button>
                );
              })}
            </div>

            <form className="mt-3 border-t border-aico-border-subtle pt-3" onSubmit={e => { e.preventDefault(); void saveLimits(); }}>
              <p className="mb-2 text-[12px] font-medium text-aico-secondary">Limits</p>
              <div className="grid grid-cols-2 gap-2.5">
                <div>
                  <label className={LABEL} htmlFor="au-budget">Daily budget (USD)</label>
                  <input id="au-budget" inputMode="decimal" className={INPUT} value={draft.budget} placeholder="no limit" onChange={e => setDraft({ ...draft, budget: e.target.value })} />
                </div>
                <div>
                  <label className={LABEL} htmlFor="au-fail">Pause after failures</label>
                  <input id="au-fail" inputMode="numeric" className={INPUT} value={draft.failures} placeholder="never" onChange={e => setDraft({ ...draft, failures: e.target.value })} />
                </div>
                <div>
                  <label className={LABEL} htmlFor="au-wr">Running limit</label>
                  <input id="au-wr" inputMode="numeric" className={INPUT} value={draft.wipRunning} placeholder={`agents (${w.maxParallel})`} onChange={e => setDraft({ ...draft, wipRunning: e.target.value })} />
                </div>
                <div>
                  <label className={LABEL} htmlFor="au-wv">Review limit</label>
                  <input id="au-wv" inputMode="numeric" className={INPUT} value={draft.wipReview} placeholder="no limit" onChange={e => setDraft({ ...draft, wipReview: e.target.value })} />
                </div>
              </div>
              <p className="mt-1.5 text-[11.5px] leading-snug text-aico-muted">A column turns amber when it reaches its limit. Agents stop starting new tasks when Running is full.</p>
              {error && <div className="mt-2"><ErrorLine>{error}</ErrorLine></div>}
              <div className="mt-2.5 flex items-center gap-2">
                <button type="submit" className={BTN_OUTLINE} disabled={busy}>{busy && !confirm ? <Spinner size={12} /> : null}Save limits</button>
                {saved && <span role="status" className="text-[12px] text-aico-success">Saved</span>}
              </div>
            </form>
          </div>
        </Portal>
      )}

      {target && (
        <Modal title={`Turn on ${target.label}?`} onClose={() => setConfirm(null)} busy={busy} width="max-w-md">
          <div className="space-y-4 text-[13px] text-aico-primary">
            <section aria-label="What will happen automatically">
              <h3 className="mb-1 text-[12px] font-semibold uppercase tracking-wide text-aico-secondary">Will happen without you</h3>
              <ul className="space-y-1">
                {automaticAt(target.id).map(a => <li key={a} className="flex gap-2"><DvIcon name="bolt" size={14} className="mt-0.5 shrink-0 text-aico-accent" />{a}</li>)}
              </ul>
            </section>
            <section aria-label="What still needs you">
              <h3 className="mb-1 text-[12px] font-semibold uppercase tracking-wide text-aico-secondary">Always still needs you</h3>
              <ul className="space-y-1">
                {alwaysNeedsYou(target.id).map(a => <li key={a} className="flex gap-2"><DvIcon name="help" size={14} className="mt-0.5 shrink-0 text-aico-warning" />{a}</li>)}
              </ul>
            </section>
            <p className="text-[12px] text-aico-muted">Agents spend money while they work. You can go back to Manual from this same control at any time.</p>
            <div className="flex justify-end gap-2 pt-1">
              <button type="button" className={BTN_GHOST} disabled={busy} onClick={() => setConfirm(null)}>Cancel</button>
              <button type="button" className={BTN_PRIMARY} disabled={busy} onClick={() => void apply(target.id)}>{busy ? 'Turning on…' : `Turn on ${target.label}`}</button>
            </div>
          </div>
        </Modal>
      )}
    </>
  );
}
