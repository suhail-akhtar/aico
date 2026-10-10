/**
 * One task on the board.
 *
 * Structure matters more than looks here: the whole card opens the drawer, but
 * a card also holds real buttons (menu, chat, blocker chips, Review), and a button
 * nested in a button is invalid and unreachable by keyboard. So the title is
 * the one primary control, stretched over the card with an overlay, and the
 * secondary controls sit above it (`relative z-10`). Drag is an enhancement;
 * the card menu does the same job for keyboards, touch and screen readers (Move to,
 * Move up / down / to top), and is where a refused move explains itself. Alt + Up / Down
 * on the focused title reorders too.
 *
 * What a card shows depends on the status. Running: the agent's live line ("Editing
 * src/x.mjs · 2m 10s · $0.03"), its slot name and its chat; Review: a risk spine and
 * badge, the checks line and a Review button; Ready or Backlog: what it is Blocked by
 * (each blocker a button that opens it), because "Ready" that silently never starts was
 * the owner's first complaint. Fields of a true board sit on every card: type, assignee,
 * due date (overdue in the warning hue, with the word), estimate, labels, epic. The
 * compact density keeps only the title, the ref and the marks that need attention.
 *
 * Pull request mode (ADR 0039): a task in "PR open" shows its pull request's link, the remote's
 * checks and reviews as chips, and the names of failing checks; there is no Merge button on the
 * card (the drawer has it, and only when the remote says it can merge). An imported task carries
 * a "from GitHub #12" link, and "Ready on remote" with one click to promote it when the remote
 * marks it ready.
 *
 * A task whose run waits for a person carries a "Needs you" box in ANY column,
 * with the controls to answer it in place (NeedsYou), and is not draggable:
 * it is waiting on a decision, not on a column. The "Chat" link opens the
 * task's real chat (`sessionOf`) for every status that has had a run; it never links the
 * runner's run id.
 *
 * @module web/components/delivery/TaskCard
 */

import React, { useEffect, useRef, useState } from 'react';
import { Portal } from '../Portal';
import type { Task, TaskStatus } from '../../delivery-types';
import {
  PERSON_STATUSES, STATUS_LABEL, ago, checkMove, checksSummary, formatUsd, sessionOf, toMs,
} from '../../delivery-model';
import { autoLandReason, blockersOf, isEpic, liveLine } from '../../delivery-board';
import { failingLine, prChips, prName, providerLabel, remoteChip } from '../../connections';
import { useBoardConnection } from '../connections/context';
import { ChipPill, ExternalLink } from '../connections/parts';
import { Avatar, AutoLanded, BlockedChips, DueChip, EpicBar, EpicChip, TypeIcon } from './board-bits';
import { DvIcon } from './icons';
import { NeedsYou } from './NeedsYou';
import { EstimateChip } from './scrum/bits';
import { PriorityChip, RiskBadge, edge, riskSpine, useTaskRef } from './ui';

export type Density = 'comfortable' | 'compact';

export interface CardContext {
  now: number;
  run?: { runId: string; startedAt: string | number; costUsd: number } | undefined;
  selected: boolean;
  onOpen: (task: Task) => void;
  onMove: (task: Task, to: TaskStatus) => void;
  onOpenSession?: ((sessionId: string) => void) | undefined;
  /** A "Needs you" answer went through: the board shows a one-line confirmation. */
  onHandled: (message: string) => void;
  onDragStart: (task: Task) => void;
  onDragEnd: () => void;
  /** Scrum mode (ADR 0039 section 4): the story-point chip, and whether the agents will skip this ready task because it is outside the sprint. */
  scrum?: { skipped: boolean; onEstimate: (task: Task, points: number | null) => void } | undefined;
  // ── a true board ──
  byId: ReadonlyMap<string, Task>;
  allTasks: readonly Task[];
  /** The dispatcher is paused: a Ready task not starting is then the board's story, told once in the banner, not on every card. */
  paused: boolean;
  density: Density;
  /** Highlighted by J / K. */
  focused: boolean;
  ticked: boolean;
  /** Any card is ticked: every card then shows its checkbox. */
  ticking: boolean;
  onTick: (task: Task) => void;
  /** Reorder inside the column; absent when this column is not reorderable. */
  onReorder?: ((task: Task, to: 'up' | 'down' | 'top') => void) | undefined;
  onDuplicate: (task: Task) => void;
  onArchive: (task: Task) => void;
  onOpenTask: (id: string) => void;
}

export const TaskCard = React.memo(function TaskCard({ task, ctx }: { task: Task; ctx: CardContext }): React.ReactElement {
  const { now, run, selected, byId, density } = ctx;
  const compact = density === 'compact';
  const ref = useTaskRef();
  const movable = PERSON_STATUSES.includes(task.status);
  const checks = task.status === 'review' ? checksSummary(task) : null;
  const sessionId = sessionOf(task);
  const draggable = movable && !task.needs;
  const lastNote = task.status === 'changes' ? task.review?.comments.filter(c => c.by === 'person').at(-1)?.text : undefined;
  const muted = task.status === 'merged' || task.status === 'cancelled';
  const bc = useBoardConnection().connection;
  const from = remoteChip(task.remote, bc && bc.connection === task.remote?.connection ? providerLabel(bc.provider) : 'the remote');
  const promote = Boolean(from?.readyOnRemote) && task.status === 'backlog';
  const epic = task.parentId ? byId.get(task.parentId) : undefined;
  const epicSelf = isEpic(task, ctx.allTasks as Task[]);
  const auto = task.landed?.by === 'auto';
  const open = task.status !== 'merged' && task.status !== 'cancelled';
  const hasMarks = Boolean(task.labels.length || epic || task.dueDate);

  return (
    <article
      draggable={draggable}
      onDragStart={e => { if (!draggable) { e.preventDefault(); return; } e.dataTransfer.setData('text/plain', task.id); e.dataTransfer.effectAllowed = 'move'; ctx.onDragStart(task); }}
      onDragEnd={ctx.onDragEnd}
      data-task={task.id}
      className={`group relative overflow-hidden rounded-xl border bg-aico-bg shadow-[0_1px_0_rgba(0,0,0,0.02)] transition-[border-color,box-shadow] duration-150 ${compact ? 'px-2.5 py-1.5' : 'px-3 py-2.5'}
        ${selected ? 'border-aico-accent shadow-[0_0_0_1px_var(--aico-accent)]' : ctx.ticked ? 'border-aico-accent' : task.needs ? `${edge('warning')} hover:shadow-sm` : 'border-aico-border-subtle hover:border-aico-border hover:shadow-sm'}
        ${ctx.focused ? 'outline outline-2 outline-offset-1 outline-aico-accent' : ''}
        ${task.status === 'review' ? `pl-4 before:absolute before:inset-y-0 before:left-0 before:w-[3px] before:content-[''] ${riskSpine(task.risk?.level)}` : ''}
        ${draggable ? 'cursor-grab active:cursor-grabbing' : ''} ${muted ? 'opacity-80' : ''}`}
    >
      {task.status === 'running' && (
        <span className="pointer-events-none absolute inset-x-0 top-0 h-[2px] overflow-hidden" aria-hidden="true">
          <span className="block h-full w-full animate-pulse bg-aico-accent motion-reduce:animate-none" />
        </span>
      )}

      <div className="flex items-center gap-1.5 text-[11px] text-aico-muted">
        <TypeIcon type={task.type} />
        <span className="font-mono tabular-nums">{ref(task.id)}</span>
        {!compact && <PriorityChip priority={task.priority} />}
        {compact && task.priority <= 2 && <PriorityChip priority={task.priority} />}
        <span className="flex-1" />
        {ctx.scrum?.skipped && <span className="relative z-10 rounded-md border border-dashed border-aico-border px-1.5 text-[10.5px] text-aico-secondary" title="Ready, but not in the running sprint: agents skip it until it joins one">Not in sprint</span>}
        {ctx.scrum ? <EstimateChip id={task.id} title={task.title} estimate={task.estimate} locked={task.status === 'merged' || task.status === 'cancelled'} onSet={p => ctx.scrum!.onEstimate(task, p)} />
          : task.estimate !== undefined ? <span className="relative z-10 rounded-full bg-aico-hover px-1.5 text-[10.5px] tabular-nums text-aico-secondary" title={`Estimate: ${task.estimate} points`}>{task.estimate}</span> : null}
        {!compact && <Avatar assignee={task.assignee} size={18} />}
        <label className={`relative z-10 inline-flex cursor-pointer items-center ${ctx.ticking || ctx.ticked ? '' : 'opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100 max-md:opacity-100'}`}>
          <input type="checkbox" checked={ctx.ticked} onChange={() => ctx.onTick(task)} aria-label={`Select ${ref(task.id)} for a bulk action`} className="h-3.5 w-3.5 accent-[var(--aico-accent)]" />
        </label>
        <CardMenu task={task} sessionId={sessionId} ctx={ctx} />
      </div>

      <h3 className={`font-medium leading-snug text-aico-primary ${compact ? 'mt-0.5 text-[13px]' : 'mt-1 text-[13.5px]'}`}>
        <button
          type="button"
          onClick={() => ctx.onOpen(task)}
          onKeyDown={e => {
            if (e.altKey && ctx.onReorder && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) { e.preventDefault(); ctx.onReorder(task, e.key === 'ArrowUp' ? 'up' : 'down'); }
          }}
          aria-label={`${ref(task.id)} ${task.title}, ${STATUS_LABEL[task.status]}. Open details`}
          className={`${compact ? 'line-clamp-1' : 'line-clamp-3'} text-left after:absolute after:inset-0 after:content-[''] focus-visible:outline-none focus-visible:after:rounded-xl focus-visible:after:outline focus-visible:after:outline-2 focus-visible:after:outline-aico-accent`}
        >
          {task.title}
        </button>
      </h3>

      {((!compact && hasMarks) || open) && (
        <div className="mt-1.5 flex flex-wrap items-center gap-1">
          {open && <BlockedChips task={task} byId={byId} onOpen={ctx.onOpenTask} />}
          {!compact && epic && <EpicChip epic={epic} onOpen={ctx.onOpenTask} />}
          {!compact && <DueChip due={task.dueDate} now={now} done={!open} />}
          {!compact && task.labels.slice(0, 3).map(l => (
            <span key={l} className="rounded-md bg-aico-hover px-1.5 py-px text-[11px] text-aico-secondary">{l}</span>
          ))}
          {!compact && task.labels.length > 3 && <span className="text-[11px] text-aico-muted">+{task.labels.length - 3}</span>}
        </div>
      )}

      {task.status === 'ready' && task.waitingReason && !compact && !ctx.paused && blockersOf(task, byId).length === 0 && (
        <p className="mt-1.5 flex items-start gap-1.5 text-[11.5px] leading-snug text-aico-secondary">
          <DvIcon name="clock" size={12} className="mt-0.5 shrink-0 text-aico-warning" />
          <span title="Why an agent has not taken this yet">{task.waitingReason}</span>
        </p>
      )}

      {task.landingBlock && task.status === 'review' && (
        <p className="mt-1.5 flex items-start gap-1.5 text-[11.5px] leading-snug text-aico-primary">
          <DvIcon name="alert" size={12} className="mt-0.5 shrink-0 text-aico-warning" />
          <span>Landing is waiting on you: {task.landingBlock.files.length} {task.landingBlock.files.length === 1 ? 'file is' : 'files are'} in the way.</span>
        </p>
      )}

      {epicSelf && !compact &&<div className="mt-1.5"><EpicBar epicId={task.id} tasks={ctx.allTasks} compact /></div>}

      {from && !compact && (
        <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11.5px]">
          <span className="relative z-10"><ExternalLink href={from.url} title="Open the original on the remote">{from.text}</ExternalLink></span>
          {from.closed && <span className="text-aico-muted">closed there</span>}
          {promote && (
            <>
              <span className="text-aico-secondary" title="The remote shows this item as ready. Nothing starts until you move it.">Ready on remote</span>
              <button
                type="button" onClick={() => ctx.onMove(task, 'ready')}
                className="relative z-10 rounded-md px-1.5 py-0.5 text-aico-accent hover:bg-aico-accent-soft focus-visible:outline focus-visible:outline-2 focus-visible:outline-aico-accent"
              >
                Move to Ready
              </button>
            </>
          )}
        </div>
      )}

      {task.needs && <NeedsYou task={task} variant="card" now={now} onHandled={ctx.onHandled} onOpenSession={ctx.onOpenSession} />}

      {task.status === 'running' && (
        <div className="mt-2 space-y-1">
          <div className="flex items-start gap-2 text-[11.5px] text-aico-secondary">
            <span className="relative mt-1 flex h-2 w-2 shrink-0" aria-hidden="true">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-aico-accent opacity-60 motion-reduce:animate-none" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-aico-accent" />
            </span>
            <span className="line-clamp-2 min-w-0 flex-1 tabular-nums" title={task.live?.summary ? `${task.live.summary}${task.live.at ? ` (${ago(task.live.at, now)})` : ''}` : 'Time since the agent started, and what it has spent'}>
              {liveLine(task, run?.startedAt, run?.costUsd, now)}
            </span>
          </div>
          {!compact && (
            <div className="flex items-center gap-2 text-[11px] text-aico-muted">
              {task.assignee && <span className="truncate">{task.assignee.name}</span>}
              <span className="flex-1" />
              {sessionId && ctx.onOpenSession && <SessionLink sessionId={sessionId} onOpen={ctx.onOpenSession} label="Chat" title="Watch the agent's chat" />}
            </div>
          )}
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
          {!compact && (
            <p className="line-clamp-2 text-[11.5px] leading-snug text-aico-secondary">
              {checks ?? <span className="text-aico-muted">No checks summary yet</span>}
            </p>
          )}
        </div>
      )}

      {task.status === 'pr' && (
        task.pr ? (
          <div className="mt-2 space-y-1.5">
            <div className="flex items-center gap-2 text-[12px]">
              <span className="relative z-10"><ExternalLink href={task.pr.url} title="Open the pull request on the remote">{prName(task.pr)}</ExternalLink></span>
            </div>
            {!compact && (
              <ul className="flex flex-wrap gap-1" aria-label="Pull request status">
                {prChips(task.pr, { compact: true }).map(c => <li key={c.id}><ChipPill chip={c} /></li>)}
              </ul>
            )}
            {!compact && failingLine(task.pr) && <p className="line-clamp-2 text-[11.5px] leading-snug text-aico-secondary">{failingLine(task.pr)}</p>}
          </div>
        ) : <p className="mt-2 text-[11.5px] text-aico-muted">Waiting for the remote&rsquo;s report.</p>
      )}
      {(task.status === 'changes' || task.status === 'merged') && task.pr && !compact && (
        <p className="mt-1.5 text-[11.5px]"><span className="relative z-10"><ExternalLink href={task.pr.url} title="Open the pull request on the remote">{prName(task.pr)}</ExternalLink></span></p>
      )}

      {lastNote && !compact && <p className="mt-2 line-clamp-2 border-l-2 border-aico-border pl-2 text-[11.5px] italic text-aico-secondary">{lastNote}</p>}

      {(task.status === 'merged' || task.status === 'blocked' || task.status === 'cancelled') && (
        <div className="mt-1.5 flex items-center gap-2 text-[11px] text-aico-muted">
          {auto && task.status === 'merged' && <AutoLanded reason={autoLandReason(task)} />}
          <span className="min-w-0 truncate">{STATUS_LABEL[task.status]}{toMs(task.updatedAt) ? ` ${ago(task.updatedAt, now)}` : ''}{task.costUsd ? ` · ${formatUsd(task.costUsd)}` : ''}</span>
        </div>
      )}

      {sessionId && ctx.onOpenSession && task.status !== 'running' && !compact && (
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

/** The keyboard/touch path for a drag, and where a refusal says why; also reorder, chat, duplicate and archive. */
function CardMenu({ task, sessionId, ctx }: { task: Task; sessionId: string | undefined; ctx: CardContext }): React.ReactElement {
  const ref = useTaskRef();
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!at) return;
    const close = (): void => setAt(null);
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') { e.stopPropagation(); close(); btn.current?.focus(); return; }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const items = [...(menu.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not([aria-disabled="true"])') ?? [])];
        const i = items.indexOf(document.activeElement as HTMLElement);
        items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
      }
    };
    const onDown = (e: MouseEvent): void => { if (!menu.current?.contains(e.target as Node) && e.target !== btn.current) close(); };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('mousedown', onDown);
    window.addEventListener('resize', close);
    document.addEventListener('scroll', close, true);
    menu.current?.querySelector<HTMLElement>('[role="menuitem"]:not([aria-disabled="true"])')?.focus();
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('resize', close);
      document.removeEventListener('scroll', close, true);
    };
  }, [at]);

  const anyOk = MOVE_TARGETS.some(s => checkMove(task, s).ok);
  const whyNot = anyOk ? '' : (checkMove(task, 'backlog') as { reason?: string }).reason ?? '';
  const archive = checkMove(task, 'cancelled');
  const item = 'flex w-full items-center rounded-lg px-2.5 py-1.5 text-left text-[13px] text-aico-primary hover:bg-aico-hover focus:bg-aico-hover focus:outline-none';
  const run = (fn: () => void) => () => { setAt(null); fn(); };

  return (
    <>
      <button
        ref={btn}
        type="button"
        aria-haspopup="menu"
        aria-expanded={Boolean(at)}
        aria-label={`Actions for ${ref(task.id)}`}
        title="Move, reorder, open the chat, duplicate or archive"
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
            aria-label={`Actions for ${task.title}`}
            style={{ position: 'fixed', top: Math.min(at.y, window.innerHeight - 360), left: Math.max(8, at.x - 232), width: 232 }}
            className="z-[80] rounded-xl border border-aico-border bg-aico-bg p-1 shadow-xl"
          >
            <p className="px-2.5 pb-1 pt-1.5 text-[11px] font-medium uppercase tracking-wide text-aico-muted">Move to</p>
            {!anyOk && <p className="px-2.5 pb-2 text-[12px] leading-snug text-aico-secondary">{whyNot}</p>}
            {MOVE_TARGETS.map(s => {
              const c = checkMove(task, s);
              return (
                <button
                  key={s} type="button" role="menuitem" aria-disabled={!c.ok} title={c.ok ? undefined : c.reason}
                  onClick={() => { if (!c.ok) return; setAt(null); ctx.onMove(task, s); }}
                  className={`${item} ${c.ok ? '' : '!cursor-not-allowed !text-aico-muted hover:!bg-transparent'}`}
                >
                  {STATUS_LABEL[s]}
                  {task.status === s && <span className="ml-auto text-[11px] text-aico-muted">here</span>}
                </button>
              );
            })}
            {ctx.onReorder && (
              <>
                <div className="my-1 border-t border-aico-border-subtle" />
                <button type="button" role="menuitem" className={item} onClick={run(() => ctx.onReorder!(task, 'up'))}>Move up<span className="ml-auto text-[11px] text-aico-muted">Alt ↑</span></button>
                <button type="button" role="menuitem" className={item} onClick={run(() => ctx.onReorder!(task, 'down'))}>Move down<span className="ml-auto text-[11px] text-aico-muted">Alt ↓</span></button>
                <button type="button" role="menuitem" className={item} onClick={run(() => ctx.onReorder!(task, 'top'))}>Move to top</button>
              </>
            )}
            <div className="my-1 border-t border-aico-border-subtle" />
            {sessionId && ctx.onOpenSession && <button type="button" role="menuitem" className={item} onClick={run(() => ctx.onOpenSession!(sessionId))}><DvIcon name="chat" size={14} className="mr-2 text-aico-muted" />Open the agent&rsquo;s chat</button>}
            <button type="button" role="menuitem" className={item} onClick={run(() => ctx.onDuplicate(task))}><DvIcon name="copy" size={14} className="mr-2 text-aico-muted" />Duplicate</button>
            <button
              type="button" role="menuitem" aria-disabled={!archive.ok} title={archive.ok ? 'Archive: cancel it and keep the history' : archive.reason}
              onClick={() => { if (!archive.ok) return; setAt(null); ctx.onArchive(task); }}
              className={`${item} ${archive.ok ? '' : '!cursor-not-allowed !text-aico-muted hover:!bg-transparent'}`}
            ><DvIcon name="archive" size={14} className="mr-2 text-aico-muted" />Archive</button>
          </div>
        </Portal>
      )}
    </>
  );
}
