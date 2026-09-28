/**
 * Choosing which folder a not-yet-sent chat will run in.
 *
 * A session's directory is fixed for its whole life from the moment it writes
 * its first event (`RunManager.ensure`'s virgin-retarget guard is the only
 * exception, and only while nothing has been written yet) — so this is a
 * pre-send-only control. Once the first message goes out, the header's
 * project pill (`App.tsx`) is the sole indicator, and it is read-only.
 *
 * Modeled on `ModelPicker`: a toolbar button, a `Portal` dropdown, dismiss on
 * outside click. Unlike the model list, the project list is already in the
 * store — nothing here fetches.
 *
 * @module components/DraftProjectPicker
 */

import React, { useEffect, useRef, useState } from 'react';
import { useStore } from '../store';
import { Portal } from './Portal';
import { Icon } from './Icon';
import { ProjectPicker } from './ProjectPicker';
import { TOOLBAR_CONTROL, toolbarTone } from './toolbar';

export function DraftProjectPicker(): React.ReactElement {
  const project = useStore(s => s.project);
  const projects = useStore(s => s.projects);
  const retargetDraft = useStore(s => s.retargetDraft);

  const [open, setOpen] = useState(false);
  const [browsing, setBrowsing] = useState(false);
  const [at, setAt] = useState({ bottom: 0, left: 0 });
  const buttonRef = useRef<HTMLButtonElement>(null);

  const current = projects.find(p => p.path === project);
  const label = current?.name ?? (project ? project.split(/[/\\]/).filter(Boolean).pop() : undefined);

  useEffect(() => {
    if (!open) return;

    const box = buttonRef.current?.getBoundingClientRect();
    if (box) {
      // Opens upward, same reason as `ModelPicker`: the composer sits at the
      // bottom of the window.
      setAt({ bottom: window.innerHeight - box.top + 6, left: Math.min(box.left, window.innerWidth - 300) });
    }

    const dismiss = (event: MouseEvent): void => {
      if (buttonRef.current?.contains(event.target as Node)) return;
      if ((event.target as HTMLElement).closest('[data-draft-project-picker]')) return;
      setOpen(false);
    };
    const onKey = (event: KeyboardEvent): void => { if (event.key === 'Escape') setOpen(false); };
    window.addEventListener('mousedown', dismiss, true);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', dismiss, true);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const choose = (path: string): void => {
    retargetDraft(path);
    setOpen(false);
  };

  return (
    <>
      <button
        ref={buttonRef}
        onClick={() => setOpen(v => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label="Folder for this chat"
        title={project ? `This chat will run in ${project}` : 'Choose a folder for this chat'}
        className={`${TOOLBAR_CONTROL} min-w-0 max-w-[160px] ${toolbarTone(false)}`}
      >
        <Icon name="folder" size={14} />
        <span className="min-w-0 truncate">{label ?? 'Scratch'}</span>
        <Icon name="chevron-down" size={13} />
      </button>

      {open && (
        <Portal>
          <div
            data-draft-project-picker
            style={{ bottom: at.bottom, left: at.left }}
            className="fixed z-50 w-[280px] overflow-hidden rounded-xl border border-aico-border
                       bg-aico-bg shadow-2xl"
          >
            <div className="max-h-[40vh] overflow-y-auto p-1">
              {projects.map(p => (
                <button
                  key={p.path}
                  role="option"
                  aria-selected={p.path === project}
                  onClick={() => choose(p.path)}
                  className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left
                              text-[12px] transition-colors ${p.path === project
                                ? 'bg-aico-accent-soft text-aico-accent'
                                : 'text-aico-secondary hover:bg-aico-hover hover:text-aico-primary'}`}
                >
                  <span className="w-4 shrink-0">
                    {p.path === project && <Icon name="check" size={14} />}
                  </span>
                  <span className="min-w-0 flex-1 truncate">{p.name}</span>
                </button>
              ))}
            </div>

            <button
              onClick={() => { setBrowsing(true); setOpen(false); }}
              className="flex w-full items-center gap-2 border-t border-aico-border-subtle px-3 py-2
                         text-left text-[12px] text-aico-secondary transition-colors
                         hover:bg-aico-hover hover:text-aico-primary"
            >
              <Icon name="folder" size={14} className="text-aico-muted" />
              Browse for a folder…
            </button>
          </div>
        </Portal>
      )}

      {browsing && <ProjectPicker onClose={() => setBrowsing(false)} />}
    </>
  );
}
