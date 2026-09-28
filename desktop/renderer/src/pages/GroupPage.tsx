/**
 * A group's page: its chats (with bulk actions), New chat, Use for new chats,
 * and its name, colour and instructions.
 *
 * @module desktop/renderer/pages/GroupPage
 */

import React, { useMemo, useState } from 'react';
import { useStore } from '@web/store';
import { go, toast } from '@/state/desk';
import { desktop } from '@/desktop';
import { Icon } from '@/lib/icons';
import { cls } from '@/lib/util';
import type { ViewProps } from '@/plugins/registry';
import { ChatTable } from './ProjectPage';
import { Modal } from '@/shell/Modal';

export function GroupPage({ params }: ViewProps): React.ReactElement {
  const id = params?.id ?? '';
  const group = useStore(s => s.groups.find(g => g.id === id));
  const sessions = useStore(s => s.sessions);
  const targetGroup = useStore(s => s.targetGroup);
  const selectTarget = useStore(s => s.selectTarget);
  const clearTarget = useStore(s => s.clearTarget);
  const newSessionInGroup = useStore(s => s.newSessionInGroup);
  const updateGroup = useStore(s => s.updateGroup);
  const deleteGroup = useStore(s => s.deleteGroup);
  const [editing, setEditing] = useState(false);
  const chats = useMemo(() => sessions.filter(s => s.group === id).sort((a, b) => b.updatedAt - a.updatedAt), [sessions, id]);
  const [form, setForm] = useState({ name: '', description: '', instructions: '', color: '' });
  if (!group) return <div className="flex flex-1 items-center justify-center text-aico-muted">This group no longer exists.</div>;
  const isTarget = targetGroup === id;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="border-b border-aico-border-subtle px-8 pb-5 pt-6">
        <div className="flex items-start gap-3">
          <Icon name="stack" size={26} className={group.color ? 'mt-1' : 'mt-1 text-aico-secondary'} style={group.color ? { color: group.color } : undefined} />
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-[24px] font-semibold tracking-tight">{group.name}</h1>
            <div className="text-[12.5px] text-aico-muted">Group · {chats.length} chat{chats.length === 1 ? '' : 's'}{group.cwd ? ` · new chats run in ${group.cwd}` : ''}</div>
            {group.description && <p className="mt-1 text-[13.5px] text-aico-secondary">{group.description}</p>}
          </div>
          <button className="btn-primary" onClick={() => { newSessionInGroup(id); go('home'); }}><Icon name="new-chat" size={15} />New chat</button>
          <button className={cls('btn-outline', isTarget && 'border-aico-accent/60 text-aico-accent')} onClick={() => (isTarget ? clearTarget() : selectTarget({ kind: 'group', id }))}>
            {isTarget ? <><Icon name="check" size={14} />Default for new chats</> : 'Use for new chats'}
          </button>
          <button className="icon-btn" onClick={() => { setForm({ name: group.name, description: group.description ?? '', instructions: group.instructions ?? '', color: group.color ?? '' }); setEditing(true); }} aria-label="Edit group"><Icon name="settings" size={16} /></button>
        </div>
      </div>
      <ChatTable chats={chats} />
      <Modal open={editing} onClose={() => setEditing(false)} title="Edit group" width={560}>
        <div className="space-y-3 px-5 pb-5 pt-2">
          <label className="block space-y-1"><span className="label">Name</span><input className="input" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} /></label>
          <label className="block space-y-1"><span className="label">Description</span><input className="input" value={form.description} onChange={e => setForm({ ...form, description: e.target.value })} /></label>
          <label className="block space-y-1"><span className="label">Instructions for every chat in this group</span><textarea className="input min-h-[120px]" value={form.instructions} onChange={e => setForm({ ...form, instructions: e.target.value })} /></label>
          <div className="flex gap-2">
            {['', '#ef4444', '#f59e0b', '#10b981', '#3b82f6', '#8b5cf6', '#ec4899'].map(c => (
              <button key={c || 'none'} className="h-6 w-6 rounded-full border-2" style={{ background: c || 'transparent', borderColor: form.color === c ? 'var(--aico-text-primary)' : 'var(--aico-border)' }} onClick={() => setForm({ ...form, color: c })} aria-label={c || 'No colour'} />
            ))}
          </div>
          <div className="flex items-center gap-2 pt-2">
            <button className="btn-danger" onClick={() => void desktop.dialog.confirm({ title: 'Delete group', message: `Delete the group “${group.name}”?`, detail: 'Its chats are kept and move back to their folders.', ok: 'Delete', danger: true })
              .then(ok => { if (ok) void deleteGroup(id).then(() => { setEditing(false); go('projects'); toast.info('Group deleted'); }); })}>Delete group</button>
            <div className="flex-1" />
            <button className="btn-outline" onClick={() => setEditing(false)}>Cancel</button>
            <button className="btn-primary" onClick={() => void updateGroup(id, { name: form.name.trim() || group.name, description: form.description, instructions: form.instructions, color: form.color || undefined } as never).then(() => { setEditing(false); toast.success('Group saved'); })}>Save</button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
