/**
 * The commands a project is held to, and where each one came from.
 *
 * The table is the profile file made visible: one row per command, a badge
 * for its provenance, and an edit that writes at `user` rank — the one rank
 * nothing observed or detected can undo. Reading the table bootstraps the
 * file from the manifest, so a project with a `package.json` is never shown
 * empty. What the agent runs on the next turn is exactly what this shows.
 *
 * @module components/ProjectCommands
 */

import React, { useCallback, useEffect, useState } from 'react';
import { api, type ProfileSource, type ProjectProfileView } from '../api';
import { useStore } from '../store';

const SOURCE_LABEL: Record<ProfileSource, { text: string; title: string; tone: string }> = {
  user: { text: 'you', title: 'Set by hand here. Nothing observed or detected can change it.', tone: 'bg-aico-accent/15 text-aico-accent' },
  template: { text: 'template', title: 'From the template the app was created from.', tone: 'bg-aico-hover text-aico-primary' },
  observed: { text: 'observed', title: 'A command that succeeded in a session and was recorded.', tone: 'bg-aico-hover text-aico-secondary' },
  detected: { text: 'detected', title: 'Read from the manifest.', tone: 'bg-aico-hover text-aico-muted' },
};

export function ProjectCommands({ cwd }: { cwd?: string }): React.ReactElement | null {
  const busy = useStore(s => s.busy);
  const [view, setView] = useState<ProjectProfileView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ name: string; command: string } | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      setView(await api.projectProfile(cwd));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [cwd]);

  // On open and after each turn: the observer may have just recorded a command.
  useEffect(() => { void refresh(); }, [refresh, busy]);

  if (error) return <p className="text-xs text-aico-danger">{error}</p>;
  if (!view) return null;

  const { profile, names } = view;
  const save = async (name: string, command: string): Promise<void> => {
    if (!command.trim()) return;
    setView(await api.setProjectCommand(cwd, name, command.trim()));
    setEditing(null);
  };

  return (
    <div className="rounded-xl border border-aico-border-subtle bg-aico-surface" data-project-commands>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-aico-border-subtle px-4 py-2.5">
        <span className="min-w-0 truncate font-mono text-[11px] text-aico-muted" title={view.cwd}>{view.cwd}</span>
        <div className="flex-1" />
        {profile.stack && (
          <span className="text-[12px] text-aico-secondary">
            {profile.stack.value}{profile.packageManager ? ` · ${profile.packageManager.value}` : ''}
          </span>
        )}
      </div>
      <table className="w-full text-[12px]">
        <tbody>
          {names.map(name => {
            const entry = profile.commands[name];
            const isEditing = editing?.name === name;
            return (
              <tr key={name} className="border-b border-aico-border-subtle last:border-b-0" data-command-row={name}>
                <td className="w-24 px-4 py-1.5 font-medium text-aico-primary">{name}</td>
                <td className="px-2 py-1.5">
                  {isEditing ? (
                    <input
                      autoFocus
                      value={editing.command}
                      onChange={e => setEditing({ name, command: e.target.value })}
                      onKeyDown={e => {
                        if (e.key === 'Enter') void save(name, editing.command);
                        if (e.key === 'Escape') setEditing(null);
                      }}
                      onBlur={() => setEditing(null)}
                      placeholder="npm run …"
                      className="w-full rounded border border-aico-border bg-aico-bg px-2 py-1 font-mono text-[12px] text-aico-primary outline-none focus:ring-2 focus:ring-aico-accent/40"
                    />
                  ) : (
                    <button
                      onClick={() => setEditing({ name, command: entry?.command ?? '' })}
                      title={entry ? `Recorded ${new Date(entry.at).toLocaleString()}. Click to change.` : 'Not set. Click to set.'}
                      className="w-full text-left font-mono text-[12px] text-aico-primary hover:text-aico-accent"
                    >
                      {entry?.command ?? <span className="text-aico-muted">—</span>}
                    </button>
                  )}
                </td>
                <td className="w-24 px-2 py-1.5">
                  {entry && (
                    <span
                      className={`rounded px-1.5 py-0.5 text-[10px] ${SOURCE_LABEL[entry.source].tone}`}
                      title={SOURCE_LABEL[entry.source].title}
                    >
                      {SOURCE_LABEL[entry.source].text}
                    </span>
                  )}
                </td>
                <td className="w-16 px-2 py-1.5 text-right">
                  {entry && !isEditing && (
                    <button
                      onClick={async () => setView(await api.forgetProjectCommand(cwd, name))}
                      className="text-[11px] text-aico-muted hover:text-aico-danger"
                      title="Forget this command. It will be detected again from the manifest if it is there."
                    >
                      forget
                    </button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="px-4 py-2 text-[11px] text-aico-muted">
        What RunChecks and the checks gate run. Click a command to set it by hand; that outranks anything
        the agent detects or observes. Recorded in <span className="font-mono">.aico/profile.json</span>.
      </p>
    </div>
  );
}
