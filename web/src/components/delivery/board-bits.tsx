/**
 * The small marks a true board card carries: who has it, what kind of work it is,
 * when it is due, what it waits for, which epic it belongs to.
 *
 * WHY one file: every mark appears in three places (the board card, the list row, the
 * drawer) and must read the same in each. Each has a word or a glyph beside its colour
 * (overdue says "Overdue 3d", blocked says "Blocked by #2"), because colour alone fails
 * for some readers and in dark mode. They sit above the card's stretched title button
 * (`relative z-10`) where they are buttons, so a click on a blocker chip opens the blocker,
 * not the card.
 *
 * @module web/components/delivery/board-bits
 */

import React from 'react';
import { blockedChips, dueState, epicProgress, formatDue, initials, TYPE_LABEL, type Blocker } from '../../delivery-board';
import type { Assignee, Task, TaskType } from '../../delivery-types';
import { DvIcon, type DvGlyph } from './icons';
import { tint, useTaskRef } from './ui';

export function Avatar({ assignee, size = 20 }: { assignee?: Assignee | undefined; size?: number }): React.ReactElement {
  if (!assignee) {
    return (
      <span title="Unassigned" aria-label="Unassigned" style={{ width: size, height: size }} className="inline-flex shrink-0 items-center justify-center rounded-full border border-dashed border-aico-border text-aico-muted">
        <DvIcon name="user" size={Math.round(size * 0.6)} />
      </span>
    );
  }
  const agent = assignee.kind === 'agent';
  return (
    <span
      title={`${assignee.name}${agent ? ' (agent)' : ''}`} aria-label={`Assigned to ${assignee.name}`} style={{ width: size, height: size, fontSize: Math.round(size * 0.44) }}
      className={`inline-flex shrink-0 select-none items-center justify-center rounded-full font-semibold leading-none ${agent ? `${tint('accent')} text-aico-primary ring-1 ring-[color-mix(in_srgb,var(--aico-accent)_40%,transparent)]` : 'bg-aico-hover text-aico-secondary ring-1 ring-aico-border'}`}
    >
      {initials(assignee.name)}
    </span>
  );
}

const TYPE_GLYPH: Record<TaskType, DvGlyph> = { feature: 'star', bug: 'bug', chore: 'wrench', spike: 'flask', docs: 'book' };

export function TypeIcon({ type, size = 13 }: { type?: TaskType | undefined; size?: number }): React.ReactElement | null {
  if (!type) return null;
  return (
    <span title={TYPE_LABEL[type]} className={`inline-flex shrink-0 ${type === 'bug' ? 'text-aico-danger' : 'text-aico-muted'}`}>
      <DvIcon name={TYPE_GLYPH[type]} size={size} />
      <span className="sr-only">{TYPE_LABEL[type]}</span>
    </span>
  );
}

export function DueChip({ due, now, done }: { due?: string | undefined; now: number; done?: boolean }): React.ReactElement | null {
  const st = dueState(due, now);
  if (!st || !due) return null;
  const late = st === 'overdue' && !done;
  return (
    <span
      title={`Due ${due.slice(0, 10)}`}
      className={`inline-flex items-center gap-1 whitespace-nowrap rounded-md px-1.5 py-px text-[11px] ${late ? `${tint('warning')} font-medium text-aico-primary` : 'text-aico-secondary'}`}
    >
      <DvIcon name="calendar" size={11} className={late ? 'text-aico-warning' : ''} />{done && st === 'overdue' ? due.slice(5, 10) : formatDue(due, now)}
    </span>
  );
}

/** "Blocked by #2 · Backlog": each prerequisite is a button that opens it. */
export function BlockedChips({ task, byId, onOpen, max = 2 }: { task: Task; byId: ReadonlyMap<string, Task>; onOpen: (id: string) => void; max?: number }): React.ReactElement | null {
  const ref = useTaskRef();
  const chips = blockedChips(task, byId, ref);
  if (chips.length === 0) return null;
  return (
    <>
      {chips.slice(0, max).map(c => (
        <button
          key={c.id} type="button" onClick={() => c.status !== 'missing' && onOpen(c.id)} disabled={c.status === 'missing'}
          title={c.status === 'missing' ? 'This prerequisite no longer exists' : `Open ${ref(c.id)}`}
          className={`relative z-10 inline-flex max-w-full items-center gap-1 rounded-md border px-1.5 py-px text-[11px] text-aico-primary transition-colors hover:bg-aico-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-aico-accent disabled:cursor-default disabled:hover:bg-transparent ${blockerTone(c.status)}`}
        >
          <DvIcon name="lock" size={11} className="shrink-0 text-aico-warning" /><span className="truncate">{c.text}</span>
        </button>
      ))}
      {chips.length > max && <span className="text-[11px] text-aico-muted">+{chips.length - max}</span>}
    </>
  );
}

function blockerTone(status: Blocker['status']): string {
  return status === 'backlog' || status === 'missing'
    ? 'border-[color-mix(in_srgb,var(--aico-warning)_50%,transparent)]'
    : 'border-aico-border';
}

/** The epic a task belongs to, as a chip that opens the epic. */
export function EpicChip({ epic, onOpen }: { epic: Task; onOpen: (id: string) => void }): React.ReactElement {
  return (
    <button
      type="button" onClick={() => onOpen(epic.id)} title={`Epic: ${epic.title}`}
      className="relative z-10 inline-flex max-w-[150px] items-center gap-1 rounded-md bg-aico-hover px-1.5 py-px text-[11px] text-aico-secondary transition-colors hover:text-aico-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-aico-accent"
    >
      <DvIcon name="layers" size={11} className="shrink-0" /><span className="truncate">{epic.title}</span>
    </button>
  );
}

/** A thin progress bar with its numbers in words ("2 of 5 done"); the bar is the extra, not the message. */
export function EpicBar({ epicId, tasks, compact }: { epicId: string; tasks: readonly Task[]; compact?: boolean }): React.ReactElement | null {
  const p = epicProgress(epicId, tasks);
  if (p.total === 0) return null;
  return (
    <div className={`flex items-center gap-2 ${compact ? 'text-[11px]' : 'text-[12px]'} text-aico-secondary`}>
      <span className="h-1.5 w-20 shrink-0 overflow-hidden rounded-full bg-aico-hover" role="progressbar" aria-valuemin={0} aria-valuemax={p.total} aria-valuenow={p.done} aria-label="Epic progress">
        <span className="block h-full rounded-full bg-aico-success" style={{ width: `${p.pct}%` }} />
      </span>
      <span className="tabular-nums">{p.done} of {p.total} done</span>
    </div>
  );
}

/** Marks that a change landed without waiting for a person, and why. */
export function AutoLanded({ reason }: { reason: string }): React.ReactElement {
  return (
    <span title={`Landed automatically: ${reason}`} className={`inline-flex items-center gap-1 whitespace-nowrap rounded-md px-1.5 py-px text-[11px] text-aico-primary ${tint('accent')}`}>
      <DvIcon name="bolt" size={11} className="text-aico-accent" />Landed automatically
    </span>
  );
}

/** A segmented two-to-four way switch, used for Board/List, density and the autonomy popover. */
export function Segmented<T extends string>({ label, value, onChange, items }: {
  label: string; value: T; onChange: (v: T) => void;
  items: ReadonlyArray<{ id: T; label: string; icon?: DvGlyph; hint?: string }>;
}): React.ReactElement {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex rounded-lg bg-aico-hover p-0.5">
      {items.map(it => {
        const on = it.id === value;
        return (
          <button
            key={it.id} type="button" role="radio" aria-checked={on} title={it.hint ?? it.label} tabIndex={on ? 0 : -1}
            onClick={() => onChange(it.id)}
            onKeyDown={e => {
              const i = items.findIndex(x => x.id === value);
              const n = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? i + 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? i - 1 : null;
              if (n === null) return;
              e.preventDefault();
              const target = items[(n + items.length) % items.length]!;
              onChange(target.id);
              (e.currentTarget.parentElement?.querySelectorAll('button')[(n + items.length) % items.length] as HTMLElement | undefined)?.focus();
            }}
            className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-md px-2.5 py-1 text-[12.5px] transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-aico-accent ${on ? 'bg-aico-bg font-medium text-aico-primary shadow-sm' : 'text-aico-secondary hover:text-aico-primary'}`}
          >
            {it.icon && <DvIcon name={it.icon} size={13} />}{it.label}
          </button>
        );
      })}
    </div>
  );
}
