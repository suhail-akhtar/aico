/**
 * "Needs you": what a task's run is waiting on, with the controls to answer it
 * where it is seen — on the card and at the top of the drawer.
 *
 * WHY here and not "open the chat": a run that stops to ask is the most time
 * sensitive thing on the board, and the answer is one line or one click. Making
 * a person find the right chat first is how an agent sits idle for an hour.
 * But Delivery adds no second way to say yes: each kind goes through the route
 * that already exists for it (a question to the chat's `answer`, a permission to
 * its `permission`, a parked call to `inbox/decide`), and those already send an
 * allow as a person — the engine's decision gate does not change.
 *
 * Which kind needs which ids is decided in delivery-model `needControls`
 * (tested); when a wait cannot be answered from here the card says why and
 * offers the chat instead of a button that would fail.
 *
 * After a successful answer the wait is marked answered in the store, so the
 * card stops asking at once; the engine confirms on its next frame. A failure
 * stays beside the controls, which stay usable: nothing typed is lost.
 *
 * One real constraint: the engine lets a tool call be ALLOWED only from a window that
 * is showing that chat (decision-gate `checkAllow`), so in the browser an Allow here can
 * be refused with "open it and answer there". The refusal is shown as written and the
 * chat is one click away; Deny and the other two kinds are not gated that way.
 *
 * What it does not do: decide whether the answer is wise, or retry for you.
 *
 * @module web/components/delivery/NeedsYou
 */

import React, { useEffect, useState } from 'react';
import { api } from '../../api';
import { markNeedAnswered } from '../../delivery';
import type { Task } from '../../delivery-types';
import { NEED_ASK, NEED_STALE, NEED_WORD, ago, clipText, needControls, needKey, sessionOf, toMs } from '../../delivery-model';
import { DvIcon } from './icons';
import { BTN_OUTLINE, BTN_PRIMARY, ErrorLine, INPUT, edge, tint, useTaskRef } from './ui';

export interface NeedsYouProps {
  task: Task;
  /** `card` is compact and clipped; `drawer` shows the whole prompt and its detail. */
  variant: 'card' | 'drawer';
  now: number;
  /** After the answer went through: the board shows a one-line confirmation. */
  onHandled: (message: string) => void;
  onOpenSession?: ((sessionId: string) => void) | undefined;
}

export function NeedsYou({ task, variant, now, onHandled, onOpenSession }: NeedsYouProps): React.ReactElement | null {
  const ref = useTaskRef();
  const need = task.needs;
  const key = need ? needKey(need) : '';
  const [text, setText] = useState('');
  const [busy, setBusy] = useState<'answer' | 'allow' | 'deny' | null>(null);
  const [error, setError] = useState<string | null>(null);

  // A different wait is a different question: do not carry the old draft or error into it.
  useEffect(() => { setText(''); setError(null); setBusy(null); }, [key]);

  if (!need) return null;
  const controls = needControls(task);
  const sessionId = sessionOf(task);
  const big = variant === 'drawer';

  const run = async (what: 'answer' | 'allow' | 'deny'): Promise<void> => {
    if (!controls || !controls.ok || busy) return;
    setBusy(what); setError(null);
    try {
      if (controls.kind === 'question') {
        const answer = text.trim();
        if (!answer) { setError('Type an answer first.'); return; }
        // `ok: false` is a 200 from the engine: nothing is waiting for an answer in that chat any more.
        if (!(await api.answer(controls.sessionId, answer)).ok) throw new Error(NEED_STALE.question);
      } else if (controls.kind === 'permission') {
        if (!(await api.permit(controls.sessionId, controls.ref, what === 'allow')).ok) throw new Error(NEED_STALE.permission);
      } else {
        const r = await api.decideParked(controls.ref, what === 'allow' ? 'approve' : 'deny');
        if (!r.ok) throw new Error(r.message || 'The engine did not accept that.');
      }
      markNeedAnswered(task.id, key);
      onHandled(
        controls.kind === 'question' ? `Answer sent for ${ref(task.id)}. The agent carries on.`
          : what === 'allow' ? `${controls.kind === 'approval' ? 'Approved' : 'Allowed'} for ${ref(task.id)}. The agent carries on.`
          : `Denied for ${ref(task.id)}. The agent is told no.`,
      );
    } catch (e) {
      setError(`${controls.kind === 'question' ? 'Could not send your answer' : 'Could not record your decision'}: ${(e as Error).message}`);
    } finally { setBusy(null); }
  };

  const since = toMs(need.since) ? ago(need.since, now) : '';
  const label = `Needs you: ${NEED_WORD[need.kind].toLowerCase()}`;

  return (
    <div
      role="group" aria-label={label}
      className={`relative z-10 rounded-lg border ${edge('warning')} ${tint('warning')} ${big ? 'px-4 py-3' : 'mt-2 px-2.5 py-2'}`}
    >
      <div className={`flex items-center gap-1.5 font-semibold text-aico-primary ${big ? 'text-[13px]' : 'text-[11.5px]'}`}>
        <DvIcon name="help" size={big ? 16 : 14} className="shrink-0 text-aico-warning" />
        <span className="whitespace-nowrap">Needs you</span>
        <span className="ml-auto whitespace-nowrap font-normal text-aico-secondary" title={since ? `${NEED_WORD[need.kind]}, waiting since ${since}` : undefined}>
          {NEED_WORD[need.kind]}{big && since ? <span className="tabular-nums text-aico-muted"> · {since}</span> : null}
        </span>
      </div>
      {big && <p className="mt-0.5 text-[12px] text-aico-secondary">{NEED_ASK[need.kind]}.</p>}

      <p
        className={big ? 'mt-1.5 max-h-40 overflow-y-auto whitespace-pre-wrap break-words text-[13.5px] leading-relaxed text-aico-primary' : 'mt-1 line-clamp-3 break-words text-[12.5px] leading-snug text-aico-primary'}
        title={need.prompt.length > 160 ? need.prompt : undefined}
      >
        {big ? need.prompt : clipText(need.prompt, 220)}
      </p>
      {big && need.detail && (
        <pre className="mt-1.5 max-h-28 overflow-auto whitespace-pre-wrap break-words rounded-md bg-aico-code px-2.5 py-1.5 font-mono text-[12px] text-aico-primary">{need.detail}</pre>
      )}

      {controls && controls.ok && controls.kind === 'question' && (
        <form
          className={`mt-2 flex gap-1.5 ${big ? 'flex-col' : 'flex-wrap'}`}
          onSubmit={e => { e.preventDefault(); void run('answer'); }}
        >
          {big ? (
            <textarea
              rows={3} value={text} onChange={e => setText(e.target.value)} aria-label={`Your answer for ${ref(task.id)}`}
              placeholder="Type your answer. The agent reads it as written."
              onKeyDown={e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void run('answer'); } }}
              className={`${INPUT} resize-y leading-relaxed`}
            />
          ) : (
            <input
              value={text} onChange={e => setText(e.target.value)} aria-label={`Your answer for ${ref(task.id)}`} placeholder="Your answer"
              className={`${INPUT} min-w-[8rem] flex-1 !py-1 !text-[12px]`}
            />
          )}
          <button type="submit" className={`${BTN_PRIMARY} ${big ? 'self-start' : '!px-2.5 !py-1 !text-[12px]'}`} disabled={busy !== null || !text.trim()}>
            {busy === 'answer' ? 'Sending…' : 'Send answer'}
          </button>
        </form>
      )}

      {controls && controls.ok && controls.kind !== 'question' && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          <button type="button" className={`${BTN_PRIMARY} ${big ? '' : '!px-2.5 !py-1 !text-[12px]'}`} disabled={busy !== null} onClick={() => void run('allow')}>
            <DvIcon name="check" size={big ? 14 : 12} />{busy === 'allow' ? 'Sending…' : controls.kind === 'approval' ? 'Approve' : 'Allow'}
          </button>
          <button type="button" className={`${BTN_OUTLINE} ${big ? '' : '!px-2.5 !py-1 !text-[12px]'}`} disabled={busy !== null} onClick={() => void run('deny')}>
            {busy === 'deny' ? 'Sending…' : 'Deny'}
          </button>
        </div>
      )}

      {controls && !controls.ok && (
        <div className="mt-2 space-y-1.5">
          <p className="text-[12px] leading-snug text-aico-secondary">{controls.reason}</p>
          {sessionId && onOpenSession && (
            <button type="button" className={`${BTN_OUTLINE} ${big ? '' : '!px-2.5 !py-1 !text-[12px]'}`} onClick={() => onOpenSession(sessionId)}>
              <DvIcon name="chat" size={13} />Open the agent&rsquo;s chat
            </button>
          )}
        </div>
      )}

      {error && (
        <div className="mt-2 space-y-1.5">
          <ErrorLine compact={!big}>{error}</ErrorLine>
          {/* A tool call can be allowed only from a window that is showing that chat; the way forward is to open it. */}
          {controls && controls.ok && controls.kind === 'permission' && onOpenSession && (
            <button type="button" className={`${BTN_OUTLINE} ${big ? '' : '!px-2.5 !py-1 !text-[12px]'}`} onClick={() => onOpenSession(controls.sessionId)}>
              <DvIcon name="chat" size={13} />Open the agent&rsquo;s chat
            </button>
          )}
        </div>
      )}
    </div>
  );
}
