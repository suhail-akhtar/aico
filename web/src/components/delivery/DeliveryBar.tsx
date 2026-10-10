/**
 * The slim bar under a chat's header when that chat is a Delivery task's run:
 * "Delivery task #3 · Running · Make API authentication fail closed … Open on board".
 *
 * WHY: the owner opened an agent's chat from the board and had no way back to the task
 * it was working on, or any sign of what stage it was in. The link is the engine's word
 * (the session summary carries `delivery: { taskId, title, status, project }`); the status
 * chip is live because the bar follows the board while it is shown (the same reference-
 * counted store the board uses), and falls back to the engine's snapshot until the board
 * arrives. Nothing is drawn for a chat that is not a task's run.
 *
 * Opening the board is the host's act (the portal routes with an event, the desktop with
 * its own router), so this takes `onOpenBoard`; the default is the portal's event.
 *
 * What it does not do: fetch a board for chats that are not task runs (a chat's open must
 * not wake a project's board), or decide anything about the task.
 *
 * @module web/components/delivery/DeliveryBar
 */

import React, { useEffect, useMemo } from 'react';
import { useStore } from '../../store';
import { followDelivery, useDelivery } from '../../delivery';
import { makeRef } from '../../delivery-model';
import { deliveryChip, taskForSession } from '../../delivery-board';
import type { TaskStatus } from '../../delivery-types';
import { DvIcon } from './icons';
import { Pill } from './ui';

export interface DeliveryLink { taskId: string; title: string; status: TaskStatus; project: string }

/** The portal's way to the board: an event App listens for, so this file needs no router. */
export function openBoardInPortal(link: { project: string; taskId: string }): void {
  window.dispatchEvent(new CustomEvent('aico:navigate', { detail: { destination: 'delivery', projectPath: link.project, taskId: link.taskId } }));
}

const TONE = { accent: 'info', warning: 'warning', success: 'success', danger: 'danger', neutral: 'neutral' } as const;

export function DeliveryBar({ onOpenBoard = openBoardInPortal }: { onOpenBoard?: (link: { project: string; taskId: string }) => void }): React.ReactElement | null {
  const sessionId = useStore(s => s.sessionId);
  const summary = useStore(s => s.sessions.find(x => x.id === sessionId));
  const link = summary?.delivery;
  const project = link?.project;
  const board = useDelivery(s => s.board);
  const boardProject = useDelivery(s => s.project);

  // Follow the board only for a chat that is a task's run, and let go when it is not.
  useEffect(() => (project ? followDelivery(project) : undefined), [project]);

  const live = useMemo(() => {
    if (!link || !board || !boardProject) return undefined;
    const same = (a: string, b: string): boolean => a.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase() === b.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
    if (!same(boardProject, link.project)) return undefined;
    return board.tasks.find(t => t.id === link.taskId) ?? taskForSession(board.tasks, sessionId);
  }, [link, board, boardProject, sessionId]);

  if (!link) return null;
  const status = live?.status ?? link.status;
  const title = live?.title ?? link.title;
  const num = live && board ? makeRef(board.tasks)(live.id) : '';
  const chip = deliveryChip(status);

  return (
    <div role="region" aria-label="Delivery task" className="shrink-0 border-b border-aico-border-subtle bg-aico-surface">
      <div className="mx-auto flex w-full max-w-column items-center gap-2 px-5 py-1.5 text-[12.5px]">
        <DvIcon name="delivery" size={14} className="shrink-0 text-aico-accent" />
        <span className="shrink-0 font-medium text-aico-primary">Delivery task{num ? ` ${num}` : ''}</span>
        <Pill tone={TONE[chip.tone]}>{chip.label}</Pill>
        <span className="min-w-0 flex-1 truncate text-aico-secondary" title={title}>{title}</span>
        <button
          type="button" onClick={() => onOpenBoard({ project: link.project, taskId: link.taskId })}
          className="inline-flex shrink-0 items-center gap-1 rounded-md px-2 py-1 font-medium text-aico-accent transition-colors hover:bg-aico-accent-soft focus-visible:outline focus-visible:outline-2 focus-visible:outline-aico-accent"
          title="Open this task on the Delivery board"
        >
          Open on board<DvIcon name="arrow" size={13} />
        </button>
      </div>
    </div>
  );
}
