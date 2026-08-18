/**
 * What you want AICO to know about one folder.
 *
 * Two fields, and the distinction between them is the whole design:
 *
 * **Description** is for you. It never reaches a model. A sidebar of eight
 * folders named `api`, `api-v2` and `web` is a memory test, and one line of
 * "the customer-facing one, deploys on merge" answers it.
 *
 * **Custom instructions** are for the model, and they win. They render last in
 * the system prompt — after the general behaviour rules and after project
 * memory — because when two instructions conflict a model tends to follow the
 * later one, and these are the ones this person chose for this folder. On
 * vendors whose guidance asks for a tail restatement they are repeated there
 * too, closest to the next decision.
 *
 * Distinct from `AICO.md`, which is a file in the repository and travels to
 * everyone who clones it. This is per-machine and per-person: "always run the
 * linter before telling me you are done" is a working agreement, not a project
 * fact, and it does not belong in someone else's checkout.
 *
 * @module components/ProjectSettings
 */

import React, { useEffect, useState } from 'react';
import type { Project } from '../api';
import { useStore } from '../store';
import { Portal } from './Portal';
import { Icon } from './Icon';

/**
 * The swatches on offer.
 *
 * A fixed set rather than a free colour picker. Ten distinguishable hues are
 * what a sidebar can actually use — an arbitrary picker invites two folders a
 * shade apart, which is worse than no colour at all — and every one of these
 * reads on both the light and the dark theme, which a value typed by hand
 * cannot be relied on to do.
 */
export const PALETTE = [
  '#e5484d', '#e5892b', '#e2b53d', '#46a758', '#12a594',
  '#0090ff', '#3e63dd', '#8e4ec6', '#d6409f', '#8b8d98',
];

export interface ProjectSettingsProps {
  project: Project;
  onClose: () => void;
}

export function ProjectSettings({ project, onClose }: ProjectSettingsProps): React.ReactElement {
  const updateProject = useStore(s => s.updateProject);

  const [name, setName] = useState(project.name);
  const [description, setDescription] = useState(project.description ?? '');
  const [instructions, setInstructions] = useState(project.instructions ?? '');
  const [color, setColor] = useState(project.color ?? '');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const save = async (): Promise<void> => {
    setSaving(true);
    await updateProject(project.path, { name, description, instructions, color });
    onClose();
  };

  const dirty = name !== project.name
    || description !== (project.description ?? '')
    || instructions !== (project.instructions ?? '')
    || color !== (project.color ?? '');

  return (
    <Portal>
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-0 sm:p-6"
      onMouseDown={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={`Settings for ${project.name}`}
    >
      <div
        onMouseDown={e => e.stopPropagation()}
        className="flex h-full w-full max-w-2xl flex-col overflow-hidden bg-aico-bg shadow-2xl
                   sm:h-auto sm:max-h-[88vh] sm:rounded-2xl sm:border sm:border-aico-border"
      >
        <header className="flex shrink-0 items-center gap-3 border-b border-aico-border-subtle px-5 py-3.5">
          <Icon name="folder" size={18}
            {...(color ? { style: { color } } : { className: 'text-aico-muted' })} />
          <h2 className="min-w-0 flex-1 truncate text-[16px] font-semibold tracking-tight text-aico-primary">
            {project.name}
          </h2>
          <button
            onClick={onClose}
            aria-label="Close"
            className="rounded-full p-1.5 text-aico-muted transition-colors hover:bg-aico-hover hover:text-aico-primary"
          >
            <Icon name="close" size={16} />
          </button>
        </header>

        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-5 py-5">
          <p className="break-all font-mono text-[11px] text-aico-muted">{project.path}</p>

          <label className="block">
            <span className="text-[13px] font-medium text-aico-primary">Name</span>
            <input
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder={project.path.split(/[\\/]/).filter(Boolean).pop()}
              className="mt-1.5 w-full rounded-lg border border-aico-border-subtle bg-aico-surface px-3 py-2
                         text-[13px] text-aico-primary placeholder:text-aico-muted
                         transition-colors focus:border-aico-accent/60 focus:outline-none"
            />
            <span className="mt-1 block text-[12px] text-aico-muted">
              Blank uses the folder’s own name.
            </span>
          </label>

          <div>
            <span className="text-[13px] font-medium text-aico-primary">Colour</span>
            <p className="mt-0.5 text-[12px] text-aico-muted">
              Tints this folder&rsquo;s icon so it is findable at a glance rather than by reading.
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              <button
                onClick={() => setColor('')}
                aria-label="No colour"
                aria-pressed={!color}
                className={`flex h-8 w-8 items-center justify-center rounded-full border transition-colors
                            ${!color ? 'border-aico-accent' : 'border-aico-border-subtle hover:border-aico-border'}`}
              >
                <Icon name="folder" size={17} className="text-aico-muted" />
              </button>
              {PALETTE.map(swatch => (
                <button
                  key={swatch}
                  onClick={() => setColor(swatch)}
                  aria-label={`Colour ${swatch}`}
                  aria-pressed={color === swatch}
                  className={`flex h-8 w-8 items-center justify-center rounded-full border transition-colors
                              ${color === swatch ? 'border-aico-accent' : 'border-transparent hover:border-aico-border'}`}
                >
                  <Icon name="folder" size={17} style={{ color: swatch }} />
                </button>
              ))}
            </div>
          </div>

          <label className="block">
            <span className="text-[13px] font-medium text-aico-primary">Description</span>
            <textarea
              value={description}
              onChange={e => setDescription(e.target.value)}
              rows={2}
              placeholder="What this folder is, in a line."
              className="mt-1.5 w-full resize-y rounded-lg border border-aico-border-subtle bg-aico-surface
                         px-3 py-2 text-[13px] leading-relaxed text-aico-primary
                         placeholder:text-aico-muted transition-colors
                         focus:border-aico-accent/60 focus:outline-none"
            />
            <span className="mt-1 block text-[12px] text-aico-muted">
              For you, in this sidebar. Never sent to the model.
            </span>
          </label>

          <label className="block">
            <span className="flex items-center gap-2 text-[13px] font-medium text-aico-primary">
              Custom instructions
              <span className="rounded-full bg-aico-accent-soft px-2 py-0.5 text-[10px] text-aico-accent">
                highest priority
              </span>
            </span>
            <textarea
              value={instructions}
              onChange={e => setInstructions(e.target.value)}
              rows={7}
              placeholder={'Always run the test suite before saying a task is done.\n'
                + 'Use tabs, not spaces, in this repository.\n'
                + 'Never touch anything under vendor/.'}
              className="mt-1.5 w-full resize-y rounded-lg border border-aico-border-subtle bg-aico-surface
                         px-3 py-2 font-mono text-[12px] leading-relaxed text-aico-primary
                         placeholder:text-aico-muted transition-colors
                         focus:border-aico-accent/60 focus:outline-none"
            />
            <span className="mt-1 block text-[12px] leading-relaxed text-aico-muted">
              Every session in this folder follows these, and they are placed after the
              general rules so they win where the two disagree. Re-read each turn, so an
              edit applies to your next message.
            </span>
          </label>
        </div>

        <footer className="flex shrink-0 items-center gap-2 border-t border-aico-border-subtle px-5 py-3">
          <span className="flex-1 text-[11px] text-aico-muted">
            {project.isLaunch ? 'The server is running in this folder.' : ''}
          </span>
          <button
            onClick={onClose}
            className="rounded-full px-3 py-1.5 text-[12px] text-aico-secondary
                       transition-colors hover:bg-aico-hover hover:text-aico-primary"
          >
            Cancel
          </button>
          <button
            onClick={() => void save()}
            disabled={!dirty || saving}
            className="rounded-full bg-aico-accent px-4 py-1.5 text-[12px] font-medium text-aico-on-accent
                       transition-colors hover:bg-aico-accent-hover disabled:opacity-40"
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </footer>
      </div>
    </div>
    </Portal>
  );
}
