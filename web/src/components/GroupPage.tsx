/**
 * A group's own page.
 *
 * A group is a container someone made on purpose — "Test", "Client A" — but
 * clicking one only folded it, and a new chat could not easily be started in
 * it. This is its page: what it is, how many chats and turns it holds, a
 * button that starts a chat in it, the choice to make it the default for new
 * chats, and every chat in it with search and bulk archive or delete.
 *
 * Groups hold chats from any folder, so there is no stack or git here — those
 * belong to a workspace, and each chat's own folder has them.
 *
 * @module components/GroupPage
 */

import React, { useMemo, useState } from 'react';
import { useStore } from '../store';
import { ChatList } from './ChatList';
import { ProjectSettings } from './ProjectSettings';
import { Icon } from './Icon';

interface Props {
  groupId: string;
  /** A session was opened or started; switch the destination back to the chat. */
  onOpenChat: () => void;
}

export function GroupPage({ groupId, onOpenChat }: Props): React.ReactElement {
  const group = useStore(s => s.groups.find(g => g.id === groupId));
  const sessions = useStore(s => s.sessions);
  const openSession = useStore(s => s.openSession);
  const newSessionInGroup = useStore(s => s.newSessionInGroup);
  const updateGroup = useStore(s => s.updateGroup);
  const isTarget = useStore(s => s.targetGroup === groupId);
  const selectTarget = useStore(s => s.selectTarget);
  const clearTarget = useStore(s => s.clearTarget);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const chats = useMemo(() => sessions.filter(s => s.group === groupId), [sessions, groupId]);
  const turns = chats.reduce((n, c) => n + (c.turns ?? 0), 0);
  const last = chats.reduce((t, c) => Math.max(t, c.updatedAt), 0);

  if (!group) {
    return (
      <div className="flex flex-1 items-center justify-center text-[13px] text-aico-muted">
        This group no longer exists.
      </div>
    );
  }

  const openChat = (id: string): void => { void openSession(id).then(onOpenChat); };
  const startHere = (): void => { newSessionInGroup(groupId); onOpenChat(); };

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-4xl space-y-6 px-6 py-6">
        <header className="flex items-start gap-3">
          <Icon
            name="stack"
            size={26}
            filled={Boolean(group.color)}
            className={group.color ? undefined : 'shrink-0 text-aico-muted'}
            {...(group.color ? { style: { color: group.color } } : {})}
          />
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-[19px] font-semibold text-aico-primary">{group.name}</h1>
            <p className="mt-0.5 text-[12px] text-aico-muted">
              Group{group.cwd ? <> · new chats run in <span className="font-mono">{group.cwd}</span></> : ''}
            </p>
            <p className="mt-2 text-[13px] leading-relaxed text-aico-secondary">
              {group.description || <span className="text-aico-muted">No description set.</span>}
            </p>
            {group.instructions && (
              <p className="mt-1 text-[11px] text-aico-muted">Custom instructions are set for this group.</p>
            )}
          </div>
          <div className="flex shrink-0 flex-wrap justify-end gap-2">
            <button
              onClick={startHere}
              className="flex items-center gap-1.5 rounded-full bg-aico-accent px-3 py-1.5 text-[12px] font-medium
                         text-aico-on-accent transition-colors hover:bg-aico-accent-hover"
            >
              <Icon name="plus" size={14} /> New session
            </button>
            <button
              onClick={() => (isTarget ? clearTarget() : selectTarget({ kind: 'group', id: groupId }))}
              aria-pressed={isTarget}
              title={isTarget ? 'New chats go into this group. Click to stop.' : 'Put new chats in this group by default'}
              className={`rounded-full border px-3 py-1.5 text-[12px] transition-colors
                          ${isTarget ? 'border-aico-accent/50 bg-aico-accent-soft text-aico-accent' : 'border-aico-border text-aico-primary hover:bg-aico-hover'}`}
            >
              {isTarget ? 'Default for new chats ✓' : 'Use for new chats'}
            </button>
            <button
              onClick={() => setSettingsOpen(true)}
              className="rounded-full border border-aico-border px-3 py-1.5 text-[12px] text-aico-primary
                         transition-colors hover:bg-aico-hover"
            >
              Edit properties
            </button>
          </div>
        </header>

        <div className="grid grid-cols-3 gap-2">
          {[
            { label: 'Chats', value: String(chats.length) },
            { label: 'Turns', value: String(turns) },
            { label: 'Last active', value: last ? new Date(last).toLocaleDateString() : '—' },
          ].map(t => (
            <div key={t.label} className="rounded-xl border border-aico-border-subtle bg-aico-surface px-3 py-2.5">
              <div className="text-[11px] text-aico-muted">{t.label}</div>
              <div className="mt-0.5 text-[17px] font-semibold tabular-nums text-aico-primary">{t.value}</div>
            </div>
          ))}
        </div>

        <section>
          <h2 className="mb-2 flex items-center gap-1.5 text-[13px] font-semibold text-aico-primary">
            <Icon name="stack" size={15} className="text-aico-muted" />
            Chats <span className="tabular-nums text-aico-muted">({chats.length})</span>
          </h2>
          <ChatList chats={chats} scope="group" onOpen={openChat} />
        </section>
      </div>

      {settingsOpen && (
        <ProjectSettings
          entry={group}
          kind="group"
          onSave={patch => void updateGroup(groupId, patch)}
          onClose={() => setSettingsOpen(false)}
        />
      )}
    </div>
  );
}
