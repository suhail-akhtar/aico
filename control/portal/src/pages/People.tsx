import { useState } from 'react';
import { api, can, fmtTime, type Me } from '../api';
import { Badge, Button, Card, Empty, Field, Modal, PageHead, Skeleton, useLoad, useToast } from '../ui';

interface User { id: string; email: string; name: string; role: string; teamId: string | null; status: string; lastLoginAt: number | null }
interface Team { id: string; name: string; members: number }
const ROLE_ORDER = ['owner', 'admin', 'auditor', 'team-lead', 'developer', 'contractor'];

export function People({ me }: { me: Me }) {
  const [tab, setTab] = useState<'users' | 'teams'>('users');
  const users = useLoad(() => api<{ users: User[] }>('/v1/admin/users'));
  const teams = useLoad(() => api<{ teams: Team[] }>('/v1/admin/teams'));
  const toast = useToast();
  const [invite, setInvite] = useState(false);
  const [newTeam, setNewTeam] = useState(false);
  const manage = can(me, 'users.manage');
  const manageTeams = can(me, 'teams.manage');

  const patch = async (u: User, body: Record<string, unknown>, ok: string): Promise<void> => {
    try { await api(`/v1/admin/users/${u.id}`, { method: 'PATCH', body }); toast(ok); users.reload(); teams.reload(); } catch (e) { toast(e instanceof Error ? e.message : 'Failed', 'bad'); }
  };
  const teamName = (id: string | null): string => teams.data?.teams.find(t => t.id === id)?.name ?? '-';

  return (
    <>
      <PageHead title="Users & teams" sub="People who can sign in to this organisation, and the teams that scope policy, budgets and what team leads can see."
        actions={<>{manageTeams && <Button onClick={() => setNewTeam(true)}>New team</Button>}{manage && <Button kind="primary" onClick={() => setInvite(true)}>Add user</Button>}</>} />
      <div className="tabs" role="tablist">
        <button role="tab" aria-selected={tab === 'users'} onClick={() => setTab('users')}>Users{users.data ? ` (${users.data.users.length})` : ''}</button>
        <button role="tab" aria-selected={tab === 'teams'} onClick={() => setTab('teams')}>Teams{teams.data ? ` (${teams.data.teams.length})` : ''}</button>
      </div>
      {tab === 'users' && (
        <Card flush>
          {users.loading && !users.data ? <Skeleton /> : users.error ? <div className="notice bad">{users.error}</div> : !users.data?.users.length ? <Empty title="No users yet">Add the first person, or turn on just-in-time creation in the tenant settings.</Empty> : (
            <table>
              <thead><tr><th>User</th><th>Role</th><th>Team</th><th>Status</th><th>Last sign-in</th><th /></tr></thead>
              <tbody>
                {users.data.users.map(u => (
                  <tr key={u.id}>
                    <td><div style={{ fontWeight: 600 }}>{u.name || u.email}</div>{u.name && <div className="faint">{u.email}</div>}</td>
                    <td>{manage && u.id !== me.user.id ? (
                      <select className="inline" aria-label={`Role of ${u.email}`} value={u.role} onChange={e => void patch(u, { role: e.target.value }, `${u.email} is now ${e.target.value}`)}>
                        {ROLE_ORDER.map(r => <option key={r} value={r}>{r}</option>)}
                      </select>) : <Badge tone={u.role === 'owner' ? 'accent' : 'neutral'}>{u.role}</Badge>}</td>
                    <td>{manage ? (
                      <select className="inline" aria-label={`Team of ${u.email}`} value={u.teamId ?? ''} onChange={e => void patch(u, { teamId: e.target.value || null }, 'Team updated')}>
                        <option value="">-</option>{teams.data?.teams.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
                      </select>) : teamName(u.teamId)}</td>
                    <td><Badge tone={u.status === 'active' ? 'ok' : 'bad'}>{u.status}</Badge></td>
                    <td className="muted">{fmtTime(u.lastLoginAt)}</td>
                    <td className="right">{manage && u.id !== me.user.id && (
                      u.status === 'active'
                        ? <Button kind="ghost" className="btn-sm btn-danger" onClick={() => { if (window.confirm(`Disable ${u.email}? Their devices stop working immediately.`)) void patch(u, { status: 'disabled' }, `${u.email} disabled`); }}>Disable</Button>
                        : <Button kind="ghost" className="btn-sm" onClick={() => void patch(u, { status: 'active' }, `${u.email} enabled`)}>Enable</Button>)}</td>
                  </tr>
                ))}
              </tbody>
            </table>)}
        </Card>)}
      {tab === 'teams' && (
        <Card flush>
          {teams.loading && !teams.data ? <Skeleton rows={3} /> : !teams.data?.teams.length ? <Empty title="No teams">Teams let you give a group its own policy and budget.</Empty> : (
            <table>
              <thead><tr><th>Team</th><th className="right">Members</th><th /></tr></thead>
              <tbody>{teams.data.teams.map(t => (
                <tr key={t.id}><td style={{ fontWeight: 600 }}>{t.name}</td><td className="right num">{t.members}</td>
                  <td className="right">{manageTeams && <>
                    <Button kind="ghost" className="btn-sm" onClick={async () => { const n = window.prompt('Rename team', t.name); if (n?.trim()) { try { await api(`/v1/admin/teams/${t.id}`, { method: 'PATCH', body: { name: n } }); teams.reload(); } catch (e) { toast(e instanceof Error ? e.message : 'Failed', 'bad'); } } }}>Rename</Button>
                    <Button kind="ghost" className="btn-sm btn-danger" disabled={t.members > 0} title={t.members ? 'Move the members first' : ''} onClick={async () => { try { await api(`/v1/admin/teams/${t.id}`, { method: 'DELETE', body: {} }); toast('Team deleted'); teams.reload(); } catch (e) { toast(e instanceof Error ? e.message : 'Failed', 'bad'); } }}>Delete</Button></>}</td></tr>
              ))}</tbody>
            </table>)}
        </Card>)}
      {invite && <InviteModal teams={teams.data?.teams ?? []} onClose={() => setInvite(false)} onDone={() => { setInvite(false); users.reload(); }} />}
      {newTeam && <TeamModal onClose={() => setNewTeam(false)} onDone={() => { setNewTeam(false); teams.reload(); }} />}
    </>
  );
}

function InviteModal({ teams, onClose, onDone }: { teams: Team[]; onClose: () => void; onDone: () => void }) {
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [role, setRole] = useState('developer');
  const [teamId, setTeamId] = useState('');
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const save = async (): Promise<void> => {
    setBusy(true);
    try { await api('/v1/admin/users', { method: 'POST', body: { email, name, role, teamId: teamId || undefined } }); toast(`${email} added`); onDone(); } catch (e) { toast(e instanceof Error ? e.message : 'Failed', 'bad'); setBusy(false); }
  };
  return (
    <Modal title="Add user" onClose={onClose} footer={<><Button onClick={onClose}>Cancel</Button><Button kind="primary" busy={busy} disabled={!email.includes('@')} onClick={() => void save()}>Add</Button></>}>
      <Field label="Email" hint="Must match the email your identity provider returns."><input type="email" value={email} onChange={e => setEmail(e.target.value)} /></Field>
      <Field label="Name"><input value={name} onChange={e => setName(e.target.value)} /></Field>
      <Field label="Role"><select value={role} onChange={e => setRole(e.target.value)}>{ROLE_ORDER.map(r => <option key={r}>{r}</option>)}</select></Field>
      <Field label="Team"><select value={teamId} onChange={e => setTeamId(e.target.value)}><option value="">None</option>{teams.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}</select></Field>
    </Modal>
  );
}

function TeamModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [name, setName] = useState('');
  const toast = useToast();
  const save = async (): Promise<void> => { try { await api('/v1/admin/teams', { method: 'POST', body: { name } }); onDone(); } catch (e) { toast(e instanceof Error ? e.message : 'Failed', 'bad'); } };
  return (
    <Modal title="New team" onClose={onClose} footer={<><Button onClick={onClose}>Cancel</Button><Button kind="primary" disabled={!name.trim()} onClick={() => void save()}>Create</Button></>}>
      <Field label="Name"><input value={name} onChange={e => setName(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && name.trim()) void save(); }} /></Field>
    </Modal>
  );
}
