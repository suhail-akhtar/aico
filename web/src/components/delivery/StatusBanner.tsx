/**
 * Why nothing is moving, and what each agent is doing right now.
 *
 * Two pieces under the board's header. The banner appears only when there is
 * something to say and something to do: Ready tasks that cannot start because their
 * prerequisites sit in Backlog (with the one click that moves them), or a pause the
 * engine caused (budget, repeated failures) with its reason and Resume. A board that is
 * simply idle with nothing Ready stays quiet; the header line says so. The strip shows
 * one chip per agent slot: its name, what it is doing in its own words, and a way to its
 * chat and its task.
 *
 * WHY: a board that says "Agents on · starting…" for ten minutes while two Ready tasks
 * wait for Backlog tasks is lying by omission. These replace that sentence with the
 * cause (delivery-board `statusLine`) and the fix.
 *
 * What it does not do: decide anything. The wording comes from `statusLine`; the clicks
 * call the routes the board owns.
 *
 * @module web/components/delivery/StatusBanner
 */

import React from 'react';
import type { StatusLine } from '../../delivery-board';
import type { BoardAgent } from '../../delivery-types';
import { Avatar } from './board-bits';
import { DvIcon } from './icons';
import { BTN_PRIMARY, Callout, Spinner, useTaskRef } from './ui';

/** Whether the banner has something to say: Ready tasks that cannot start, or a pause the engine caused. */
export function bannerVisible(status: StatusLine): boolean {
  return (status.state !== 'working' && status.stuck) || (status.state === 'paused' && status.text.startsWith('Paused:'));
}

export function StatusBanner({ status, onFix, fixing, onResume, resuming }: {
  status: StatusLine; onFix: () => void; fixing: boolean; onResume: () => void; resuming: boolean;
}): React.ReactElement | null {
  // Two reasons to speak: Ready tasks that cannot start (whatever the agents are doing about it), and a pause the engine caused.
  const blocked = status.state !== 'working' && status.stuck;
  const paused = status.state === 'paused' && status.text.startsWith('Paused:');
  if (!bannerVisible(status)) return null;
  const main = status.state === 'idle' || !status.waits ? status.text : `${status.waits.charAt(0).toUpperCase()}${status.waits.slice(1)}`;
  return (
    <div className="shrink-0 px-4 pt-3 sm:px-6" data-testid="status-banner">
      <Callout tone="warning" role="status">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <div className="min-w-0 flex-1">
            <p className="font-medium">{main}</p>
            {status.waits && status.why && <p className="mt-0.5 text-aico-secondary max-sm:hidden">{status.state === 'off' ? `${status.text}. ` : ''}{status.why}{status.state === 'paused' ? ' Resume the agents to start the rest.' : status.state === 'off' ? ' Start the agents to run the rest.' : ''}</p>}
            {!status.waits && paused && status.detail && <p className="mt-0.5 text-aico-secondary">{status.detail}</p>}
          </div>
          {blocked && status.fix && (
            <button type="button" className={BTN_PRIMARY} disabled={fixing} onClick={onFix}>
              {fixing ? <Spinner size={12} /> : <DvIcon name="arrow" size={14} />}{fixing ? 'Moving…' : status.fix}
            </button>
          )}
          {paused && (
            <button type="button" className={BTN_PRIMARY} disabled={resuming} onClick={onResume}>
              <DvIcon name="play" size={13} />{resuming ? 'Resuming…' : 'Resume agents'}
            </button>
          )}
        </div>
      </Callout>
    </div>
  );
}

const STATE_DOT: Record<BoardAgent['state'], string> = { working: 'bg-aico-accent', waiting: 'bg-aico-warning', idle: 'bg-aico-muted' };
const STATE_WORD: Record<BoardAgent['state'], string> = { working: 'working', waiting: 'waiting for you', idle: 'idle' };

export function AgentsStrip({ status, short, agents, onOpenTask, onOpenChat, sessionFor }: {
  status: StatusLine; /** The banner already says why: show only the state. */ short: boolean; agents: readonly BoardAgent[]; onOpenTask: (id: string) => void; onOpenChat: (taskId: string) => void; sessionFor: (taskId: string) => string | undefined;
}): React.ReactElement {
  const ref = useTaskRef();
  const dot = status.state === 'working' ? 'bg-aico-success' : status.state === 'off' ? 'bg-aico-muted' : 'bg-aico-warning';
  return (
    <section aria-label="Agents" className="flex shrink-0 items-center gap-2 overflow-x-auto border-b border-aico-border-subtle px-4 py-2 sm:px-6">
      <p role="status" aria-live="polite" title={status.detail ? `${status.text}. ${status.detail}` : status.text} className="flex shrink-0 items-center gap-2 pr-1 text-[12.5px] text-aico-secondary">
        <span className="relative flex h-2 w-2" aria-hidden="true">
          {status.state === 'working' && <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-aico-success opacity-60 motion-reduce:animate-none" />}
          <span className={`relative inline-flex h-2 w-2 rounded-full ${dot}`} />
        </span>
        <span className="max-w-[40ch] truncate">{short ? status.text.split(':')[0] : status.text}</span>
      </p>
      <ul className="flex min-w-0 items-stretch gap-2 max-sm:hidden">
        {agents.map(a => (
          <li key={a.name} className="flex min-w-[210px] max-w-[320px] items-center gap-2 rounded-lg border border-aico-border-subtle bg-aico-surface px-2.5 py-1">
            <Avatar assignee={{ kind: 'agent', name: a.name }} size={22} />
            <div className="min-w-0 flex-1 leading-tight">
              <p className="flex items-center gap-1.5 text-[12px] font-medium text-aico-primary">
                <span className="truncate">{a.name}</span>
                <span className="flex items-center gap-1 text-[11px] font-normal text-aico-muted">
                  <span className={`h-1.5 w-1.5 rounded-full ${STATE_DOT[a.state]}`} aria-hidden="true" />{STATE_WORD[a.state]}
                </span>
              </p>
              <p className="truncate text-[11.5px] text-aico-secondary" title={a.summary}>
                {a.taskId ? (
                  <>
                    <button type="button" onClick={() => onOpenTask(a.taskId!)} className="font-mono text-aico-accent hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-aico-accent">{ref(a.taskId)}</button>
                    {a.summary ? <> · &ldquo;{a.summary}&rdquo;</> : null}
                  </>
                ) : <span className="text-aico-muted">Waiting for a Ready task</span>}
              </p>
            </div>
            {a.taskId && sessionFor(a.taskId) && (
              <button type="button" onClick={() => onOpenChat(a.taskId!)} title={`Open ${a.name}'s chat`} aria-label={`Open ${a.name}'s chat`} className="shrink-0 rounded-md p-1 text-aico-muted hover:bg-aico-hover hover:text-aico-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-aico-accent">
                <DvIcon name="chat" size={14} />
              </button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
