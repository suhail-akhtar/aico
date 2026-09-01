/**
 * The panel's title row.
 *
 * Modelled on what VS Code puts at the top of a view: the title on the left,
 * icon-only actions on the right, everything at 22px so it reads as part of the
 * workbench rather than as content inside it.
 *
 * The connection dot is the one addition. A side bar is glanceable by nature and
 * the most common confused question about a long-running agent is "is this thing
 * still connected, or has it quietly died?" — a question a spinner cannot answer
 * because a lost stream also stops spinning.
 *
 * @module components/Header
 */

import React from 'react';
import { useStore } from '@web/store';
import { host } from '../host';

export function Header({ onToggleSessions, sessionsOpen }: {
  onToggleSessions: () => void;
  sessionsOpen: boolean;
}): React.ReactElement {
  const title = useStore(s => s.title);
  const status = useStore(s => s.status);
  const busy = useStore(s => s.busy);
  const newSession = useStore(s => s.newSession);
  const folder = useStore(s => s.project);

  return (
    <div className="flex h-[35px] shrink-0 items-center gap-1.5 border-b border-aico-border-subtle px-3">
      <Dot status={status} busy={busy} />

      <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
        <span className="min-w-0 truncate text-[12px] font-medium text-aico-primary">
          {title || 'Untitled'}
        </span>
        {/*
          Which folder this conversation runs in.

          Added after a real failure: the panel had quietly registered a second
          project for the open folder, and there was no way to tell — the agent
          simply behaved as though it were somewhere else. A run's directory is
          the single most consequential thing about it, and it was the one thing
          the panel did not say.
        */}
        {folder && (
          <span
            title={folder}
            className="shrink-0 truncate text-[10px] text-aico-muted"
          >
            {basename(folder)}
          </span>
        )}
      </span>

      <IconButton title="History" active={sessionsOpen} onClick={onToggleSessions}>
        {/* A clock, matching VS Code's own history affordance. */}
        <circle cx="8" cy="8" r="6.25" />
        <path d="M8 4.5V8l2.5 1.5" />
      </IconButton>

      <IconButton title="New session" onClick={newSession}>
        <path d="M8 3.25v9.5M3.25 8h9.5" />
      </IconButton>

      <IconButton title="Open the full workspace" onClick={host.openWorkspace}>
        <path d="M6.5 2.75h-3.75v10.5h10.5V9.5" />
        <path d="M9.5 2.75h3.75V6.5M13.25 2.75 7.75 8.25" />
      </IconButton>

      <IconButton title="Settings" onClick={host.openSettings}>
        <circle cx="8" cy="8" r="2.25" />
        <path d="M8 1.75v1.5M8 12.75v1.5M14.25 8h-1.5M3.25 8h-1.5M12.42 3.58l-1.06 1.06M4.64 11.36l-1.06 1.06M12.42 12.42l-1.06-1.06M4.64 4.64 3.58 3.58" />
      </IconButton>
    </div>
  );
}

/**
 * Connection at a glance.
 *
 * Colour alone would fail a colourblind reader and fail anyone glancing at a
 * 6px dot, so the title attribute carries the same information in words and the
 * shapes differ: a filled dot is live, a ring is not.
 */
function Dot({ status, busy }: {
  status: 'connecting' | 'live' | 'lost'; busy: boolean;
}): React.ReactElement {
  const label = status === 'live'
    ? (busy ? 'Working' : 'Connected')
    : status === 'connecting' ? 'Connecting…' : 'Reconnecting…';

  const colour = status === 'live'
    ? (busy ? 'bg-aico-accent' : 'bg-aico-success')
    : status === 'connecting' ? 'bg-aico-warning' : 'bg-aico-danger';

  return (
    <span
      title={label}
      aria-label={label}
      className={[
        'size-[6px] shrink-0 rounded-full',
        colour,
        busy ? 'animate-pulse-soft' : '',
      ].join(' ')}
    />
  );
}

function IconButton({ title, onClick, active, children }: {
  title: string;
  onClick: () => void;
  active?: boolean;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      aria-pressed={active}
      onClick={onClick}
      className={[
        'flex size-[22px] shrink-0 items-center justify-center rounded',
        'text-aico-secondary hover:bg-aico-hover hover:text-aico-primary',
        active ? 'bg-aico-hover text-aico-primary' : '',
      ].join(' ')}
    >
      <svg
        viewBox="0 0 16 16" className="size-4" fill="none" stroke="currentColor"
        strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"
      >
        {children}
      </svg>
    </button>
  );
}

/**
 * The last segment of a path, whichever separator it uses.
 *
 * `path.basename` is not available in a webview, and the panel sees Windows and
 * POSIX paths depending on the machine — so both separators are handled rather
 * than assuming the one this happens to be running on.
 */
function basename(p: string): string {
  const parts = p.replace(/[\\/]+$/, '').split(/[\\/]/);
  return parts[parts.length - 1] || p;
}
