import { useState } from 'react';
import { api, can, fmtUsd, type Me } from '../api';
import { Button, Card, Empty, Field, Modal, PageHead, Skeleton, useLoad, useToast } from '../ui';

interface Row { key: string; label: string; events: number; inputTokens: number; outputTokens: number; costUsd: number }
interface Budget { id: string; scope: 'tenant' | 'team' | 'user'; scopeId: string; period: 'day' | 'month'; limitUsd: number; spentUsd: number }
type By = 'user' | 'team' | 'model' | 'day';
const nf = (n: number): string => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n));

export function Usage({ me }: { me: Me }) {
  const [by, setBy] = useState<By>('user');
  const [days, setDays] = useState(30);
  const usage = useLoad(() => api<{ rows: Row[]; totalUsd: number }>(`/v1/admin/usage?by=${by}&days=${days}`), [by, days]);
  const budgets = useLoad(() => api<{ budgets: Budget[] }>('/v1/admin/budgets'));
  const users = useLoad(() => api<{ users: Array<{ id: string; email: string }> }>('/v1/admin/users'));
  const teams = useLoad(() => api<{ teams: Array<{ id: string; name: string }> }>('/v1/admin/teams'));
  const [adding, setAdding] = useState(false);
  const toast = useToast();
  const label = (b: Budget): string => b.scope === 'tenant' ? 'Whole organisation' : b.scope === 'team' ? `Team ${teams.data?.teams.find(t => t.id === b.scopeId)?.name ?? b.scopeId}` : (users.data?.users.find(u => u.id === b.scopeId)?.email ?? b.scopeId);
  const max = Math.max(0.0001, ...(usage.data?.rows.map(r => r.costUsd) ?? [0]));
  const del = async (b: Budget): Promise<void> => { try { await api(`/v1/admin/budgets/${b.id}`, { method: 'DELETE', body: {} }); budgets.reload(); } catch (e) { toast(e instanceof Error ? e.message : 'Failed', 'bad'); } };

  return (
    <>
      <PageHead title="Usage & budgets" sub="Estimated spend reported by devices (token counts times the price table; not an invoice). A budget that is reached stops model calls on every device until it resets (UTC)." />
      <div className="stats">
        <div className="stat"><div className="big">{usage.data ? fmtUsd(usage.data.totalUsd) : '-'}</div><div className="label">estimated, last {days} days</div></div>
        <div className="stat"><div className="big">{budgets.data?.budgets.filter(b => b.spentUsd >= b.limitUsd).length ?? '-'}</div><div className="label">budgets reached</div></div>
      </div>
      <Card title="Budgets" actions={can(me, 'budgets.manage') && <Button kind="primary" className="btn-sm" onClick={() => setAdding(true)}>Add budget</Button>} flush>
        {budgets.loading && !budgets.data ? <Skeleton rows={2} /> : !budgets.data?.budgets.length ? <Empty title="No budgets">Without one, spend is reported but never limited.</Empty> : (
          <table>
            <thead><tr><th>Applies to</th><th>Period</th><th>Spent / limit</th><th style={{ width: 160 }} /><th /></tr></thead>
            <tbody>{budgets.data.budgets.map(b => {
              const pct = Math.min(100, (b.spentUsd / b.limitUsd) * 100);
              return (
                <tr key={b.id}><td style={{ fontWeight: 600 }}>{label(b)}</td><td>{b.period === 'day' ? 'per day' : 'per month'}</td><td className="num">{fmtUsd(b.spentUsd)} / {fmtUsd(b.limitUsd)}</td>
                  <td><div className={`bar ${pct >= 100 ? 'hot' : ''}`} role="progressbar" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100}><i style={{ width: `${pct}%` }} /></div></td>
                  <td className="right">{can(me, 'budgets.manage') && <Button kind="ghost" className="btn-sm btn-danger" onClick={() => void del(b)}>Remove</Button>}</td></tr>);
            })}</tbody>
          </table>)}
      </Card>
      <Card title="Spend" actions={<div style={{ display: 'flex', gap: 8 }}>
        <select className="inline" aria-label="Group by" value={by} onChange={e => setBy(e.target.value as By)}><option value="user">By user</option><option value="team">By team</option><option value="model">By model</option><option value="day">By day</option></select>
        <select className="inline" aria-label="Period" value={days} onChange={e => setDays(Number(e.target.value))}><option value={7}>7 days</option><option value={30}>30 days</option><option value={90}>90 days</option></select></div>} flush>
        {usage.loading && !usage.data ? <Skeleton /> : !usage.data?.rows.length ? <Empty title="No usage yet">Devices report finished turns when they sync.</Empty> : (
          <table>
            <thead><tr><th>{by}</th><th className="right">Turns</th><th className="right">Input</th><th className="right">Output</th><th className="right">Est. cost</th><th style={{ width: 140 }} /></tr></thead>
            <tbody>{usage.data.rows.map(r => (
              <tr key={r.key}><td style={{ fontWeight: 600 }}>{r.label}</td><td className="right num">{r.events}</td><td className="right num">{nf(r.inputTokens)}</td><td className="right num">{nf(r.outputTokens)}</td><td className="right num">{fmtUsd(r.costUsd)}</td>
                <td><div className="bar"><i style={{ width: `${(r.costUsd / max) * 100}%` }} /></div></td></tr>))}</tbody>
          </table>)}
      </Card>
      {adding && <BudgetModal users={users.data?.users ?? []} teams={teams.data?.teams ?? []} onClose={() => setAdding(false)} onDone={() => { setAdding(false); budgets.reload(); }} />}
    </>
  );
}

function BudgetModal({ users, teams, onClose, onDone }: { users: Array<{ id: string; email: string }>; teams: Array<{ id: string; name: string }>; onClose: () => void; onDone: () => void }) {
  const [scope, setScope] = useState<'tenant' | 'team' | 'user'>('tenant');
  const [scopeId, setScopeId] = useState('');
  const [period, setPeriod] = useState<'day' | 'month'>('day');
  const [limit, setLimit] = useState('20');
  const toast = useToast();
  const save = async (): Promise<void> => {
    try { await api('/v1/admin/budgets', { method: 'PUT', body: { scope, scopeId, period, limitUsd: Number(limit) } }); toast('Budget saved'); onDone(); } catch (e) { toast(e instanceof Error ? e.message : 'Failed', 'bad'); }
  };
  return (
    <Modal title="Add budget" onClose={onClose} footer={<><Button onClick={onClose}>Cancel</Button><Button kind="primary" disabled={!(Number(limit) > 0) || (scope !== 'tenant' && !scopeId)} onClick={() => void save()}>Save</Button></>}>
      <Field label="Applies to"><select value={scope} onChange={e => { setScope(e.target.value as typeof scope); setScopeId(''); }}><option value="tenant">Whole organisation</option><option value="team">A team</option><option value="user">One person</option></select></Field>
      {scope === 'team' && <Field label="Team"><select value={scopeId} onChange={e => setScopeId(e.target.value)}><option value="">Choose...</option>{teams.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}</select></Field>}
      {scope === 'user' && <Field label="Person"><select value={scopeId} onChange={e => setScopeId(e.target.value)}><option value="">Choose...</option>{users.map(u => <option key={u.id} value={u.id}>{u.email}</option>)}</select></Field>}
      <Field label="Period" hint="Resets at 00:00 UTC (day) or the 1st of the month."><select value={period} onChange={e => setPeriod(e.target.value as typeof period)}><option value="day">Per day</option><option value="month">Per month</option></select></Field>
      <Field label="Limit (USD, estimated)"><input type="number" min="0.01" step="0.01" value={limit} onChange={e => setLimit(e.target.value)} /></Field>
    </Modal>
  );
}
