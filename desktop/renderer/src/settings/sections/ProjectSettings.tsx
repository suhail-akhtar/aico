/**
 * A project's own settings: its name, colour, what it is, and the standing
 * instructions every chat in it follows. Stored by the engine, so the browser
 * client and the CLI see the same project.
 *
 * @module desktop/renderer/settings/sections/ProjectSettings
 */

import React, { useEffect, useState } from 'react';
import { useStore } from '@web/store';
import { toast, go, useDesk } from '@/state/desk';
import { Row } from '../fields';
import { desktop } from '@/desktop';

const COLORS = ['', '#ef4444', '#f59e0b', '#10b981', '#3b82f6', '#8b5cf6', '#ec4899', '#64748b'];

export function ProjectSettingsSection({ path }: { path: string }): React.ReactElement {
  const project = useStore(s => s.projects.find(p => p.path === path));
  const updateProject = useStore(s => s.updateProject);
  const removeProject = useStore(s => s.removeProject);
  const [name, setName] = useState(project?.name ?? '');
  const [description, setDescription] = useState(project?.description ?? '');
  const [instructions, setInstructions] = useState(project?.instructions ?? '');
  const [color, setColor] = useState(project?.color ?? '');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setName(project?.name ?? ''); setDescription(project?.description ?? '');
    setInstructions(project?.instructions ?? ''); setColor(project?.color ?? '');
  }, [project]);

  if (!project) return <p className="text-aico-muted">This project is no longer registered.</p>;
  const dirty = name !== project.name || description !== (project.description ?? '') || instructions !== (project.instructions ?? '') || color !== (project.color ?? '');

  const save = async (): Promise<void> => {
    setSaving(true);
    try {
      await updateProject(path, { name: name.trim() || project.name, description, instructions, color: color || undefined } as never);
      toast.success('Project saved');
    } catch (err) { toast.error('Could not save', (err as Error).message); }
    finally { setSaving(false); }
  };

  return (
    <div>
      <h1 className="text-[22px] font-semibold tracking-tight">{project.name}</h1>
      <p className="mt-1 text-[13px] text-aico-muted">Manage the folder, what the agent should know about it, and how it looks.</p>

      <h3 className="set-heading">Folder</h3>
      <div className="set-group">
        <Row title={<span className="font-mono text-[12.5px]">{path}</span>} desc={project.exists ? 'On disk' : 'Missing on disk'}>
          <div className="flex gap-2">
            <button className="btn-outline btn-sm" onClick={() => void desktop.shell.openPath(path)}>Reveal</button>
            <button className="btn-outline btn-sm" onClick={() => { useDesk.getState().closeSettings(); go('project', { path }); }}>Open page</button>
          </div>
        </Row>
      </div>

      <h3 className="set-heading">Details</h3>
      <div className="set-group">
        <Row title="Name"><input className="input w-72" value={name} onChange={e => setName(e.target.value)} /></Row>
        <Row title="Colour" desc="Marks the folder in the sidebar.">
          <div className="flex gap-1.5">
            {COLORS.map(c => (
              <button key={c || 'none'} aria-label={c || 'No colour'} aria-pressed={color === c} onClick={() => setColor(c)}
                className="h-6 w-6 rounded-full border-2 transition-transform hover:scale-110"
                style={{ background: c || 'transparent', borderColor: color === c ? 'var(--aico-text-primary)' : 'var(--aico-border)' }} />
            ))}
          </div>
        </Row>
        <Row title="Description" desc="One line about what this project is." stack>
          <input className="input" value={description} onChange={e => setDescription(e.target.value)} placeholder="An inventory API in Go" />
        </Row>
      </div>

      <h3 className="set-heading">Instructions for the agent</h3>
      <div className="set-group">
        <Row title="Standing instructions" desc="Followed in every chat in this project — conventions, commands, things to avoid." stack>
          <textarea className="input min-h-[160px] font-mono text-[12.5px]" value={instructions} onChange={e => setInstructions(e.target.value)}
            placeholder={'Run tests with `npm test`.\nNever commit to main directly.'} />
        </Row>
      </div>

      <div className="mt-5 flex items-center gap-2">
        <button className="btn-primary" onClick={() => void save()} disabled={!dirty || saving}>{saving ? 'Saving…' : 'Save changes'}</button>
        <div className="flex-1" />
        <button className="btn-danger" onClick={() => {
          void desktop.dialog.confirm({ title: 'Remove project', message: `Remove “${project.name}” from AICO?`, detail: 'The folder and its chats stay on disk.', ok: 'Remove', danger: true })
            .then(ok => { if (ok) void removeProject(path).then(() => { useDesk.getState().openSettings('general'); toast.info('Project removed'); }); });
        }}>Remove from AICO</button>
      </div>
    </div>
  );
}
