/**
 * A refused landing, as something a person can act on.
 *
 * WHY: Approve used to show git's own sentence ("The following untracked working tree
 * files would be overwritten by merge ..."), which says what git saw and not what the
 * person may do. This panel names the problem in plain words, lists the files in the way
 * (scrollable, monospace, copyable by selection), and offers the engine's choices as
 * buttons. A choice goes to `resolve-landing`, the person's act, and the result replaces
 * the panel. An error the board does not recognise still shows its message, never nothing.
 *
 * The mapping from an error to this panel is `landingProblem` (delivery-board.ts, tested).
 *
 * @module web/components/delivery/LandingPanel
 */

import React, { useState } from 'react';
import { api } from '../../api';
import { upsertTask } from '../../delivery';
import { landingProblem, type LandingChoice, type LandingProblem } from '../../delivery-board';
import { DvIcon } from './icons';
import { BTN_GHOST, BTN_OUTLINE, BTN_PRIMARY, ErrorLine, Spinner, tint } from './ui';

export function LandingPanel({ taskId, project, problem, onResolved, onDismiss }: {
  taskId: string; project: string; problem: LandingProblem; onResolved: () => void; onDismiss: () => void;
}): React.ReactElement {
  const [busy, setBusy] = useState<string | null>(null);
  const [next, setNext] = useState<LandingProblem | null>(null);
  const p = next ?? problem;

  const choose = async (c: LandingChoice): Promise<void> => {
    if (c.id === 'cancel' || c.id === 'abort') { onDismiss(); return; }
    setBusy(c.id);
    try {
      upsertTask(await api.deliveryResolveLanding(taskId, project, c.id));
      onResolved();
    } catch (e) { setNext(landingProblem(e)); }
    finally { setBusy(null); }
  };

  if (!p.known && p.choices.length === 0) return <ErrorLine>{p.body}</ErrorLine>;
  return (
    <section role="alert" aria-label={p.title} className={`rounded-xl border border-[color-mix(in_srgb,var(--aico-warning)_50%,transparent)] px-3.5 py-3 ${tint('warning')}`}>
      <div className="flex items-start gap-2">
        <DvIcon name="alert" size={16} className="mt-0.5 shrink-0 text-aico-warning" />
        <div className="min-w-0 flex-1">
          <h3 className="text-[13.5px] font-semibold text-aico-primary">{p.title}</h3>
          <p className="mt-0.5 text-[12.5px] leading-snug text-aico-secondary">{p.body}</p>
        </div>
        <button type="button" onClick={onDismiss} aria-label="Dismiss" className="shrink-0 rounded-md p-1 text-aico-muted hover:bg-aico-hover hover:text-aico-primary"><DvIcon name="close" size={14} /></button>
      </div>
      {p.files.length > 0 && (
        <ul aria-label="Files in the way" className="mt-2.5 max-h-32 overflow-y-auto rounded-lg border border-aico-border-subtle bg-aico-bg">
          {p.files.map(f => (
            <li key={f} className="flex items-center gap-2 border-b border-aico-border-subtle px-2.5 py-1 font-mono text-[12px] text-aico-primary last:border-b-0">
              <DvIcon name="file" size={12} className="shrink-0 text-aico-muted" /><span className="min-w-0 truncate" title={f}>{f}</span>
            </li>
          ))}
        </ul>
      )}
      {p.choices.length > 0 ? (
        <div className="mt-3 flex flex-wrap gap-2">
          {p.choices.map(c => (
            <button
              key={c.id} type="button" disabled={busy !== null} onClick={() => void choose(c)} title={c.hint}
              className={c.tone === 'primary' ? BTN_PRIMARY : c.tone === 'danger' ? `${BTN_OUTLINE} !border-aico-danger !text-aico-danger` : BTN_OUTLINE}
            >
              {busy === c.id && <Spinner size={12} />}{c.label}
            </button>
          ))}
        </div>
      ) : (
        <p className="mt-3 text-[12.5px] text-aico-secondary">Fix this in your project folder, then press Approve again. Nothing has been changed.</p>
      )}
      {p.choices.length > 0 && (
        <ul className="mt-2 space-y-0.5 text-[11.5px] text-aico-secondary">
          {p.choices.filter(c => c.hint).map(c => <li key={c.id}><span className="font-medium text-aico-primary">{c.label}.</span> {c.hint}</li>)}
        </ul>
      )}
      <div className="mt-2 flex justify-end"><button type="button" className={`${BTN_GHOST} !py-0.5 !text-[12px]`} onClick={onDismiss}>Dismiss</button></div>
    </section>
  );
}
