/**
 * Choosing a directory to work in.
 *
 * A browser cannot open a native folder dialog and hand back a path the server
 * can use — the File System Access API deliberately yields an opaque handle
 * scoped to the page, which is exactly the wrong shape when the thing that must
 * open the folder is a process on the other side of a socket. So the server
 * enumerates directories and this navigates them.
 *
 * Three things it does that a plain tree does not:
 *
 * **The path is editable.** Anyone who already knows where they are going types
 * or pastes it and presses Enter. Clicking through six levels of
 * `E:\github_repos\AI-Projects\…` to reach a directory whose path was on the
 * clipboard is a chore invented by pickers, not by people.
 *
 * **Everything is one click.** A row navigates *into* a folder; the button on
 * that row opens it. A picker where selecting and descending are the same
 * gesture makes choosing a folder with subfolders oddly hard, and every
 * filesystem has those.
 *
 * **Unreadable directories are not errors.** A system folder you cannot list
 * shows as empty and says so. Throwing a dialog because the pointer passed over
 * `C:\System Volume Information` would make the picker unusable on Windows.
 *
 * @module components/ProjectPicker
 */

import React, { useEffect, useRef, useState } from 'react';
import { api, type BrowseResult } from '../api';
import { useStore } from '../store';
import { Icon } from './Icon';

export interface ProjectPickerProps {
  onClose: () => void;
}

export function ProjectPicker({ onClose }: ProjectPickerProps): React.ReactElement {
  const addProject = useStore(s => s.addProject);
  const projects = useStore(s => s.projects);

  const [view, setView] = useState<BrowseResult | null>(null);
  const [typed, setTyped] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);

  const go = async (target?: string): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const next = await api.browse(target);
      setView(next);
      setTyped(next.path);
      // Back to the top: the new listing has nothing to do with how far down
      // the previous one had been scrolled.
      if (listRef.current) listRef.current.scrollTop = 0;
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void go(); }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const open = async (dir: string): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await addProject(dir);
      onClose();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  const already = (dir: string): boolean => projects.some(p => p.path === dir);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-0 sm:p-6"
      onMouseDown={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Open a project"
    >
      <div
        onMouseDown={e => e.stopPropagation()}
        className="flex h-full w-full max-w-2xl flex-col overflow-hidden bg-aico-bg shadow-2xl
                   sm:h-[min(34rem,88vh)] sm:rounded-2xl sm:border sm:border-aico-border"
      >
        <header className="flex shrink-0 items-center gap-3 border-b border-aico-border-subtle px-5 py-3.5">
          <h2 className="text-[16px] font-semibold tracking-tight text-aico-primary">Open a project</h2>
          <div className="flex-1" />
          <button
            onClick={onClose}
            aria-label="Close"
            className="rounded-full p-1.5 text-aico-muted transition-colors hover:bg-aico-hover hover:text-aico-primary"
          >
            <Icon name="close" size={18} />
          </button>
        </header>

        {/* Where you are, and the fastest way to be somewhere else. */}
        <div className="flex shrink-0 items-center gap-2 border-b border-aico-border-subtle px-5 py-2.5">
          <button
            onClick={() => view?.parent && void go(view.parent)}
            disabled={!view?.parent}
            title="Up one level"
            className="rounded-lg p-1.5 text-aico-secondary transition-colors hover:bg-aico-hover
                       hover:text-aico-primary disabled:opacity-30"
          >
            <Icon name="arrow-up" size={17} />
          </button>
          <input
            value={typed}
            onChange={e => setTyped(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') void go(typed); }}
            spellCheck={false}
            placeholder="Type or paste a path, then press Enter"
            className="min-w-0 flex-1 rounded-lg border border-aico-border-subtle bg-aico-surface px-3 py-1.5
                       font-mono text-[12px] text-aico-primary placeholder:text-aico-muted
                       transition-colors focus:border-aico-accent/60 focus:outline-none"
          />
        </div>

        <div className="flex min-h-0 flex-1">
          <nav className="hidden w-40 shrink-0 overflow-y-auto border-r border-aico-border-subtle p-2 sm:block">
            <div className="px-2 pb-1 text-[11px] font-semibold uppercase tracking-wider text-aico-muted">
              Places
            </div>
            {(view?.roots ?? []).map(root => (
              <button
                key={root.path}
                onClick={() => void go(root.path)}
                className="mb-0.5 flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[13px]
                           text-aico-secondary transition-colors hover:bg-aico-hover hover:text-aico-primary"
              >
                <Icon name="folder" size={18} className="text-aico-muted" />
                <span className="min-w-0 truncate">{root.name}</span>
              </button>
            ))}
          </nav>

          <div ref={listRef} className="min-w-0 flex-1 overflow-y-auto p-2">
            {loading && <p className="px-3 py-4 text-[13px] text-aico-muted">Reading…</p>}

            {!loading && view?.denied && (
              <p className="px-3 py-4 text-[13px] text-aico-muted">
                This folder cannot be read. You can still open it if the agent has access,
                or go somewhere else.
              </p>
            )}

            {!loading && !view?.denied && view?.entries.length === 0 && (
              <p className="px-3 py-4 text-[13px] text-aico-muted">No subfolders here.</p>
            )}

            {!loading && view?.entries.map(entry => (
              <div
                key={entry.path}
                className="group/row flex items-center gap-1 rounded-lg pr-1 hover:bg-aico-hover"
              >
                <button
                  onClick={() => void go(entry.path)}
                  className="flex min-w-0 flex-1 items-center gap-2.5 px-2.5 py-1.5 text-left text-[13px]
                             text-aico-primary"
                >
                  <Icon name="folder" size={17} className="text-aico-muted" />
                  <span className="min-w-0 truncate">{entry.name}</span>
                </button>
                {already(entry.path) ? (
                  <span className="shrink-0 px-2 text-[11px] text-aico-muted">added</span>
                ) : (
                  <button
                    onClick={() => void open(entry.path)}
                    disabled={busy}
                    className="shrink-0 rounded-full px-2.5 py-1 text-[12px] text-aico-accent opacity-0
                               transition-opacity hover:bg-aico-accent-soft focus:opacity-100
                               group-hover/row:opacity-100 disabled:opacity-40"
                  >
                    Open
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>

        {error && (
          <div className="shrink-0 border-t border-aico-danger/30 bg-aico-danger/10 px-5 py-2 text-[12px] text-aico-danger">
            {error}
          </div>
        )}

        <footer className="flex shrink-0 items-center gap-3 border-t border-aico-border-subtle px-5 py-3">
          <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-aico-muted" title={view?.path}>
            {view?.path}
          </span>
          <button
            onClick={onClose}
            className="rounded-full px-3 py-1.5 text-[12px] text-aico-secondary
                       transition-colors hover:bg-aico-hover hover:text-aico-primary"
          >
            Cancel
          </button>
          <button
            onClick={() => view && void open(view.path)}
            disabled={!view || busy || already(view.path)}
            className="rounded-full bg-aico-accent px-4 py-1.5 text-[12px] font-medium text-aico-on-accent
                       transition-colors hover:bg-aico-accent-hover disabled:opacity-40"
          >
            {already(view?.path ?? '') ? 'Already open' : busy ? 'Opening…' : 'Open this folder'}
          </button>
        </footer>
      </div>
    </div>
  );
}
