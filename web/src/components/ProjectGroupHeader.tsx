/**
 * The heading over one project's sessions, and its controls.
 *
 * Three affordances, and each earns its place by removing a step that would
 * otherwise take two:
 *
 * **`+` starts a session here.** Without it, working in a second folder means
 * selecting it and *then* starting a session — and the only way to select it
 * was to click one of its existing sessions, which a folder you have just
 * opened does not have. The plus is the whole path in one click.
 *
 * **The caret folds the group.** A project with sixty sessions otherwise pushes
 * every other project off the bottom of the sidebar, which defeats the point of
 * grouping. Collapsed state is per-project and lives in the component tree, not
 * on the server: it is a view preference about right now, not a fact about the
 * project.
 *
 * **The menu renames or forgets.** Rename changes the label only — the path is
 * the identity, since sessions are filed under it. Delete is styled as the
 * destructive thing it is and asks first, because a folder full of history is
 * one click from disappearing out of the list.
 *
 * The launch directory has no delete: the server is running in it, and a list
 * that could not show you where you are would be lying by omission.
 *
 * @module components/ProjectGroupHeader
 */

import React, { useEffect, useRef, useState } from 'react';
import { useStore } from '../store';
import { Portal } from './Portal';
import { Icon } from './Icon';
import { ProjectSettings } from './ProjectSettings';

export interface ProjectGroupHeaderProps {
  label: string;
  path: string;
  /** False for the group holding sessions whose folder is no longer listed. */
  known: boolean;
  isLaunch: boolean;
  collapsed: boolean;
  onToggle: () => void;
  count: number;
}

export function ProjectGroupHeader({
  label, path, known, isLaunch, collapsed, onToggle, count,
}: ProjectGroupHeaderProps): React.ReactElement {
  const newSessionIn = useStore(s => s.newSessionIn);
  const updateProject = useStore(s => s.updateProject);
  const removeProject = useStore(s => s.removeProject);
  const project = useStore(s => s.projects.find(p => p.path === path));

  const [menuOpen, setMenuOpen] = useState(false);
  const [at, setAt] = useState({ top: 0, left: 0 });
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(label);
  const [confirming, setConfirming] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const dismiss = (event: MouseEvent): void => {
      if (buttonRef.current?.contains(event.target as Node)) return;
      if ((event.target as HTMLElement).closest('[data-project-menu]')) return;
      setMenuOpen(false);
      setConfirming(false);
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') { setMenuOpen(false); setConfirming(false); }
    };
    window.addEventListener('mousedown', dismiss, true);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', dismiss, true);
      window.removeEventListener('keydown', onKey);
    };
  }, [menuOpen]);

  const openMenu = (): void => {
    const box = buttonRef.current?.getBoundingClientRect();
    if (box) setAt({ top: box.bottom + 4, left: Math.min(box.left, window.innerWidth - 210) });
    setMenuOpen(v => !v);
    setConfirming(false);
  };

  const commit = (): void => {
    setEditing(false);
    const next = draft.trim();
    if (next && next !== label) void updateProject(path, { name: next });
  };

  if (editing) {
    return (
      <input
        value={draft}
        onChange={e => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={e => {
          if (e.key === 'Enter') commit();
          if (e.key === 'Escape') { setDraft(label); setEditing(false); }
        }}
        autoFocus
        aria-label="Project name"
        className="mx-3 mb-1 mt-3 w-[calc(100%-1.5rem)] rounded-lg border border-aico-accent/50
                   bg-aico-bg px-2 py-1 text-[12px] text-aico-primary focus:outline-none"
      />
    );
  }

  return (
    <div className="group/proj flex items-center gap-0.5 rounded-lg px-1 pb-1 pt-3 hover:bg-aico-hover/60">
      <button
        onClick={onToggle}
        title={collapsed ? `Show ${count} session${count === 1 ? '' : 's'}` : 'Collapse'}
        aria-expanded={!collapsed}
        className="flex min-w-0 flex-1 items-center gap-1.5 px-2 text-left text-[11px] font-medium
                   tracking-wider text-aico-muted"
      >
        <Icon name={collapsed ? 'chevron-right' : 'chevron-down'} size={12} />
        <Icon
          name="folder"
          size={17}
          strokeWidth={1.8}
          {...(project?.color
            ? { style: { color: project.color } }
            : { className: 'text-aico-muted' })}
        />
        {project?.pinned && (
          <Icon name="pin" size={11} className="shrink-0 text-aico-accent" />
        )}
        <span className="min-w-0 truncate" title={project?.description || path}>{label}</span>
        {collapsed && count > 0 && (
          <span className="shrink-0 tabular-nums opacity-70">{count}</span>
        )}
      </button>

      {known && (
        <>
          <button
            ref={buttonRef}
            onClick={openMenu}
            aria-label={`Actions for ${label}`}
            aria-haspopup="menu"
            className={`shrink-0 rounded p-0.5 text-aico-muted transition-opacity hover:text-aico-primary
                        ${menuOpen ? 'opacity-100' : 'opacity-0 focus:opacity-100 group-hover/proj:opacity-100'}`}
          >
            <Icon name="ellipsis" size={14} />
          </button>
          <button
            onClick={() => newSessionIn(path)}
            aria-label={`New session in ${label}`}
            title={`New session in ${label}`}
            className="shrink-0 rounded p-0.5 text-aico-muted opacity-0 transition-opacity
                       hover:text-aico-primary focus:opacity-100 group-hover/proj:opacity-100"
          >
            <Icon name="plus" size={14} />
          </button>
        </>
      )}

      {menuOpen && (
        <Portal>
        <div
          data-project-menu
          role="menu"
          style={{ top: at.top, left: at.left }}
          className="fixed z-50 w-[204px] overflow-hidden rounded-xl border border-aico-border
                     bg-aico-bg py-1 shadow-2xl"
        >
          <button
            role="menuitem"
            onClick={() => { setMenuOpen(false); setDraft(label); setEditing(true); }}
            className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-[13px] text-aico-primary
                       transition-colors hover:bg-aico-hover"
          >
            <Icon name="edit" size={15} className="text-aico-muted" /> Rename
          </button>

          <button
            role="menuitem"
            onClick={() => { setMenuOpen(false); void updateProject(path, { pinned: !project?.pinned }); }}
            className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-[13px] text-aico-primary
                       transition-colors hover:bg-aico-hover"
          >
            <Icon name="pin" size={15} className="text-aico-muted" />
            {project?.pinned ? 'Unpin' : 'Pin to top'}
          </button>

          <button
            role="menuitem"
            onClick={() => { setMenuOpen(false); setSettingsOpen(true); }}
            className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-[13px] text-aico-primary
                       transition-colors hover:bg-aico-hover"
          >
            <Icon name="sliders" size={15} className="text-aico-muted" />
            Description &amp; instructions
            {project?.instructions && (
              <span className="ml-auto h-1.5 w-1.5 rounded-full bg-aico-accent"
                    title="Custom instructions are set" />
            )}
          </button>

          {isLaunch ? (
            <p className="px-3 py-2 text-[11px] leading-snug text-aico-muted">
              The server is running here, so this folder is always listed.
            </p>
          ) : confirming ? (
            <div className="px-3 py-2">
              <p className="text-[11px] leading-snug text-aico-secondary">
                Remove from the list? The sessions stay on disk.
              </p>
              <div className="mt-1.5 flex gap-1.5">
                <button
                  onClick={() => { setMenuOpen(false); void removeProject(path); }}
                  className="rounded-full bg-aico-danger/15 px-2.5 py-1 text-[12px] text-aico-danger
                             transition-colors hover:bg-aico-danger/25"
                >
                  Remove
                </button>
                <button
                  onClick={() => setConfirming(false)}
                  className="rounded-full px-2.5 py-1 text-[12px] text-aico-muted hover:text-aico-primary"
                >
                  Keep
                </button>
              </div>
            </div>
          ) : (
            <button
              role="menuitem"
              onClick={() => setConfirming(true)}
              className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-[13px] text-aico-danger
                         transition-colors hover:bg-aico-danger/10"
            >
              <Icon name="trash" size={15} /> Remove workspace
            </button>
          )}
        </div>
        </Portal>
      )}

      {settingsOpen && project && (
        <ProjectSettings project={project} onClose={() => setSettingsOpen(false)} />
      )}
    </div>
  );
}
