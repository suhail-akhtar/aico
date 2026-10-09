/**
 * One task on the board.
 *
 * Structure matters more than looks here: the whole card opens the drawer, but
 * a card also holds real buttons (Move, Open session, Review), and a button
 * nested in a button is invalid and unreachable by keyboard. So the title is
 * the one primary control, stretched over the card with an overlay, and the
 * secondary controls sit above it (`relative z-10`). Drag is an enhancement;
 * the Move menu does the same job for keyboards, touch and screen readers, and
 * is where a refused move explains itself.
 *
 * What a card shows depends on the status — Running: elapsed time, cost, a
 * live dot and the agent's session; Review: a risk spine and badge, the checks
 * line and a Review button — because those are the questions someone asks of
 * a card in that column.
 *
 * A task whose run waits for a person carries a "Needs you" box in ANY column,
 * with the controls to answer it in place (NeedsYou), and is not draggable:
 * it is waiting on a decision, not on a column. The "Session" link opens the
 * task's real chat (`sessionOf`), also for finished tasks, and is hidden when
 * the run had no chat — it never links the runner's run id.
 *
 * @module web/components/delivery/TaskCard
 */

import React, { useEffect, useRef, useState } from 'react';
import { Portal } from '../Portal';
import type { Task, TaskStatus } from '../../delivery-types';
import {
  PERSON_STATUSES, STATUS_LABEL, ago, checkMove, checksSummary, elapsed, formatUsd, sessionOf, toMs, waitsForLabel,
} from '../../delivery-model';
import { DvIcon } from './icons';
import { NeedsYou } from './NeedsYou';
import { PriorityChip, RiskBadge, edge, riskSpine, useTaskRef } from './ui';

export interface CardContext {
  now: number;
  /** Unmet dependency ids for this task (computed once per board). */
  unmet: string[];
  run?: { runId: string; startedAt: string | number; costUsd: number } | undefined;
  selected: boolean;
  onOpen: (task: Task) => void;
  onMove: (task: Task, to: TaskStatus) => void;
  onOpenSession?: ((sessionId: string) => void) | undefined;
  /** A "Needs you" answer went through: the board shows a one-line confirmation. */
  onHandled: (message: string) => void;
  onDragStart: (task: Task) => void;
  onDragEnd: () => void;
}

export const TaskCard = React.memo(function TaskCard({ task, ctx }: { task: Task; ctx: CardContext }): React.ReactElement {
  const { now, unmet, run, selected } = ctx;
  const ref = useTaskRef();
  const movable = PERSON_STATUSES.includes(task.status);
  const waits = waitsForLabel(unmet, ref);
  const checks = task.status === 'review' ? checksSummary(task) : null;
  const sessionId = sessionOf(task);
  const draggable = movable && !task.needs;
  const lastNote = task.status === 'changes' ? task.review?.comments.filter(c => c.by === 'person').at(-1)?.text : undefined;
  const muted = task.status === 'merged' || task.status === 'cancelled';

  return (
    <article
      draggable={draggable}
      onDragStart={e => { if (!draggable) { e.preventDefault(); return; } e.dataTransfer.setData('text/plain', task.id); e.dataTransfer.effectAllowed = 'move'; ctx.onDragStart(task); }}
      onDragEnd={ctx.onDragEnd}
      data-task={task.id}
      className={`group relative overflow-hidden rounded-xl border bg-aico-bg px-3 py-2.5 shadow-[0_1px_0_rgba(0,0,0,0.02)] transition-[border-color,box-shadow] duration-150
        ${selected ? 'border-aico-accent shadow-[0_0_0_1px_var(--aico-accent)]' : task.needs ? `${edge('warning')} hover:shadow-sm` : 'border-aico-border-subtle hover:border-aico-border hover:shadow-sm'}
        ${task.status === 'review' ? `pl-4 before:absolute before:inset-y-0 before:left-0 before:w-[3px] before:content-[''] ${riskSpine(task.risk?.level)}` : ''}
        ${draggable ? 'cursor-grab active:cursor-grabbing' : ''} ${muted ? 'opacity-80' : ''}`}
    >
      {task.status === 'running' && (
        <span className="pointer-events-none absolute inset-x-0 top-0 h-[2px] overflow-hidden" aria-hidden="true">
          <span className="block h-full w-full animate-pulse bg-aico-accent motion-reduce:animate-none" />
        </span>
      )}

      <div className="flex items-center gap-2 text-[11px] text-aico-muted">
        <span className="font-mono tabular-nums">{ref(task.id)}</span>
        <PriorityChip priority={task.priority} />
        <span className="flex-1" />
        <MoveMenu task={task} onMove={ctx.onMove} />
      </div>

      <h3 className="mt-1 text-[13.5px] font-medium leading-snug text-aico-primary">
        <button
          type="button"
          onClick={() => ctx.onOpen(task)}
          aria-label={`${ref(task.id)} ${task.title}, ${STATUS_LABEL[task.status]}. Open details`}
          className="line-clamp-3 text-left after:absolute after:inset-0 after:content-[''] focus-visible:outline-none focus-visible:after:rounded-xl focus-visible:after:outline focus-visible:after:outline-2 focus-visible:after:outline-aico-accent"
        >
          {task.title}
        </button>
      </h3>

      {(task.labels.length > 0 || waits) && (
        <div className="mt-1.5 flex flex-wrap items-center gap-1">
          {waits && (
            <span
              className="inline-flex items-center gap-1 rounded-md border border-aico-border px-1.5 py-px text-[11px] text-aico-secondary"
              title={`Depends on ${unmet.map(ref).join(', ')}, which ${unmet.length === 1 ? 'is' : 'are'} not merged yet`}
            >
              <DvIcon name="clock" size={11} />{waits}
            </span>
          )}
          {task.labels.slice(0, 3).map(l => (
            <span key={l} className="rounded-md bg-aico-hover px-1.5 py-px text-[11px] text-aico-secondary">{l}</span>
          ))}
          {task.labels.length > 3 && <span className="text-[11px] text-aico-muted">+{task.labels.length - 3}</span>}
        </div>
      )}

      {task.needs && <NeedsYou task={task} variant="card" now={now} onHandled={ctx.onHandled} onOpenSession={ctx.onOpenSession} />}

      {task.status === 'running' && (
        <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 whitespace-nowrap text-[11.5px] text-aico-secondary">
          <span className="relative flex h-2 w-2" aria-hidden="true">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-aico-accent opacity-60 motion-reduce:animate-none" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-aico-accent" />
          </span>
          <span className="tabular-nums" title="Time since the agent started">{run ? elapsed(run.startedAt, now) : 'starting'}</span>
          <span className="text-aico-muted" aria-hidden="true">·</span>
          <span className="tabular-nums" title="Spent so far on this task">{formatUsd(run?.costUsd ?? task.costUsd)}</span>
          <span className="flex-1" />
          {sessionId && ctx.onOpenSession && <SessionLink sessionId={sessionId} onOpen={ctx.onOpenSession} label="Session" title="Watch the agent's session" />}
        </div>
      )}

      {task.status === 'review' && (
        <div className="mt-2 space-y-1.5">
          <div className="flex items-center gap-2">
            <RiskBadge compact level={task.risk?.level} score={task.risk?.score} unassessed={!task.risk} />
            <span className="flex-1" />
            <span className="relative z-10">
              <button
                type="button"
                onClick={() => ctx.onOpen(task)}
                className="rounded-md bg-aico-accent px-2.5 py-1 text-[12px] font-medium text-aico-on-accent transition-colors hover:bg-aico-accent-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-aico-accent"
              >
                Review
              </button>
            </span>
          </div>
          <p className="line-clamp-2 text-[11.5px] leading-snug text-aico-secondary">
            {checks ?? <span className="text-aico-muted">No checks summary yet</span>}
          </p>
          {sessionId && ctx.onOpenSession && (
            <div className="flex justify-end"><SessionLink sessionId={sessionId} onOpen={ctx.onOpenSession} label="Chat" title="Open the agent's chat" /></div>
          )}
        </div>
      )}

      {lastNote && <p className="mt-2 line-clamp-2 border-l-2 border-aico-border pl-2 text-[11.5px] italic text-aico-secondary">{lastNote}</p>}

      {(task.status === 'merged' || task.status === 'blocked' || task.status === 'cancelled') && (
        <div className="mt-1.5 flex items-center gap-2 text-[11px] text-aico-muted">
          <span className="min-w-0 truncate">{STATUS_LABEL[task.status]}{toMs(task.updatedAt) ? ` ${ago(task.updatedAt, now)}` : ''}{task.costUsd ? ` · ${formatUsd(task.costUsd)}` : ''}</span>
          <span className="flex-1" />
          {sessionId && ctx.onOpenSession && <SessionLink sessionId={sessionId} onOpen={ctx.onOpenSession} label="Chat" title="Open the agent's chat" />}
        </div>
      )}
      {task.status === 'changes' && sessionId && ctx.onOpenSession && (
        <div className="mt-1.5 flex justify-end"><SessionLink sessionId={sessionId} onOpen={ctx.onOpenSession} label="Chat" title="Open the agent's chat" /></div>
      )}
    </article>
  );
});

/** The link to a task's real chat. Lifted above the card's stretched title button so it stays clickable. */
function SessionLink({ sessionId, onOpen, label, title }: { sessionId: string; onOpen: (id: string) => void; label: string; title: string }): React.ReactElement {
  return (
    <button
      type="button" onClick={() => onOpen(sessionId)} title={title} aria-label={title}
      className="relative z-10 inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11.5px] text-aico-accent transition-colors hover:bg-aico-accent-soft focus-visible:outline focus-visible:outline-2 focus-visible:outline-aico-accent"
    >
      <DvIcon name="chat" size={12} />{label}
    </button>
  );
}

const MOVE_TARGETS: readonly TaskStatus[] = PERSON_STATUSES;

/** The keyboard/touch path for a drag, and where a refusal says why. */
function MoveMenu({ task, onMove }: { task: Task; onMove: (task: Task, to: TaskStatus) => void }): React.ReactElement {
  const ref = useTaskRef();
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!at) return;
    const close = (): void => setAt(null);
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') { e.stopPropagation(); close(); btn.current?.focus(); } };
    const onDown = (e: MouseEvent): void => { if (!menu.current?.contains(e.target as Node) && e.target !== btn.current) close(); };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('mousedown', onDown);
    window.addEventListener('resize', close);
    document.addEventListener('scroll', close, true);
    menu.current?.querySelector<HTMLElement>('button:not([aria-disabled="true"])')?.focus();
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('resize', close);
      document.removeEventListener('scroll', close, true);
    };
  }, [at]);

  const anyOk = MOVE_TARGETS.some(s => checkMove(task, s).ok);
  const whyNot = anyOk ? '' : (checkMove(task, 'backlog') as { reason?: string }).reason ?? '';

  return (
    <>
      <button
        ref={btn}
        type="button"
        aria-haspopup="menu"
        aria-expanded={Boolean(at)}
        aria-label={`Move ${ref(task.id)}`}
        title={anyOk ? 'Move to another column' : whyNot}
        onClick={() => { const r = btn.current!.getBoundingClientRect(); setAt(a => (a ? null : { x: Math.min(r.right, window.innerWidth - 8), y: r.bottom + 4 })); }}
        className="relative z-10 rounded-md p-0.5 text-aico-muted max-md:-m-1.5 max-md:p-2 opacity-0 transition-opacity hover:bg-aico-hover hover:text-aico-primary focus-visible:opacity-100 group-hover:opacity-100 aria-expanded:opacity-100 max-md:opacity-100"
      >
        <DvIcon name="more" size={16} />
      </button>
      {at && (
        <Portal>
          <div
            ref={menu}
            role="menu"
            aria-label={`Move ${task.title}`}
            style={{ position: 'fixed', top: at.y, left: Math.max(8, at.x - 224), width: 224 }}
            className="z-[80] rounded-xl border border-aico-border bg-aico-bg p-1 shadow-xl"
          >
            <p className="px-2.5 pb-1 pt-1.5 text-[11px] font-medium uppercase tracking-wide text-aico-muted">Move to</p>
            {!anyOk && <p className="px-2.5 pb-2 text-[12px] leading-snug text-aico-secondary">{whyNot}</p>}
            {MOVE_TARGETS.map(s => {
              const c = checkMove(task, s);
              return (
                <button
                  key={s}
                  type="button"
                  role="menuitem"
                  aria-disabled={!c.ok}
                  title={c.ok ? undefined : c.reason}
                  onClick={() => { if (!c.ok) return; setAt(null); onMove(task, s); }}
                  className={`flex w-full items-center rounded-lg px-2.5 py-1.5 text-left text-[13px] ${c.ok ? 'text-aico-primary hover:bg-aico-hover focus:bg-aico-hover focus:outline-none' : 'cursor-not-allowed text-aico-muted'}`}
                >
                  {STATUS_LABEL[s]}
                  {task.status === s && <span className="ml-auto text-[11px] text-aico-muted">here</span>}
                </button>
              );
            })}
          </div>
        </Portal>
      )}
    </>
  );
}
