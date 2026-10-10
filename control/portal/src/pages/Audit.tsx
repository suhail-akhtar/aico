import { useState } from 'react';
import { api, can, type Me } from '../api';
import { Badge, Button, Card, Empty, PageHead, Skeleton, useLoad, useToast } from '../ui';

interface Rec { seq: number; time: string; source: string; user: string | null; kind: string; action: string; outcome: string; detail: Record<string, unknown>; hash: string }
interface Verify { ok: boolean; count: number; head: { seq: number; hash: string } | null; brokenAt?: number; reason?: string }

const tone = (o: string): 'ok' | 'bad' | 'warn' | 'neutral' => (o === 'ok' ? 'ok' : o === 'denied' || o === 'error' ? 'bad' : o === 'escalated' ? 'warn' : 'neutral');

export function Audit({ me }: { me: Me }) {
  const [q, setQ] = useState('');
  const [kind, setKind] = useState('');
  const [outcome, setOutcome] = useState('');
  const [source, setSource] = useState('');
  const [applied, setApplied] = useState('');
  const [open, setOpen] = useState<number | null>(null);
  const [verify, setVerify] = useState<Verify | null>(null);
  const [verifying, setVerifying] = useState(false);
  const toast = useToast();
  const qs = applied;
  const { data, error, loading } = useLoad(() => api<{ records: Rec[] }>(`/v1/admin/audit?limit=200${qs}`), [qs]);

  const apply = (e: React.FormEvent): void => {
    e.preventDefault();
    const p = new URLSearchParams();
    if (q.trim()) p.set('q', q.trim());
    if (kind) p.set('kind', kind);
    if (outcome) p.set('outcome', outcome);
    if (source) p.set('source', source);
    setApplied(p.toString() ? `&${p.toString()}` : '');
  };
  const runVerify = async (): Promise<void> => {
    setVerifying(true);
    try { setVerify(await api<Verify>('/v1/admin/audit/verify')); } catch (e) { toast(e instanceof Error ? e.message : 'Failed', 'bad'); } finally { setVerifying(false); }
  };

  return (
    <>
      <PageHead title="Audit" sub="Every record the devices upload, plus the administrative actions taken here, in one tamper-evident chain."
        actions={<>{can(me, 'audit.export') && <><a className="btn" href="/v1/admin/audit/export?format=csv" download>Export CSV</a><a className="btn" href="/v1/admin/audit/export" download>Export JSONL</a></>}<Button kind="primary" busy={verifying} onClick={() => void runVerify()}>Verify chain</Button></>} />
      {verify && (
        <div className={`notice ${verify.ok ? '' : 'bad'}`} role="status">
          {verify.ok
            ? <><strong>Chain intact.</strong> {verify.count} records verified. Head <code>{verify.head?.hash.slice(0, 16)}</code> at #{verify.head?.seq}. Record this value somewhere separate to anchor the trail.</>
            : <><strong>Chain broken at #{verify.brokenAt}.</strong> {verify.reason}. Records from that point cannot be trusted.</>}
        </div>)}
      <Card flush>
        <form className="filters" onSubmit={apply}>
          <input placeholder="Search action, user, target..." aria-label="Search" value={q} onChange={e => setQ(e.target.value)} style={{ minWidth: 220 }} />
          <select aria-label="Kind" value={kind} onChange={e => setKind(e.target.value)}><option value="">All kinds</option>{['tool.call', 'turn.end', 'approval', 'credential', 'settings.change', 'policy.load', 'admin', 'auth', 'device'].map(k => <option key={k}>{k}</option>)}</select>
          <select aria-label="Outcome" value={outcome} onChange={e => setOutcome(e.target.value)}><option value="">Any outcome</option>{['ok', 'denied', 'error', 'escalated'].map(k => <option key={k}>{k}</option>)}</select>
          <select aria-label="Source" value={source} onChange={e => setSource(e.target.value)}><option value="">Devices and server</option><option value="engine">Devices</option><option value="control">Server</option></select>
          <Button type="submit">Search</Button>
        </form>
        {error && <div className="notice bad" style={{ margin: 16 }}>{error}</div>}
        {loading && !data ? <Skeleton rows={7} /> : !data?.records.length ? <Empty title="No records match">Records appear once a device syncs, or when someone acts in this portal.</Empty> : (
          <table>
            <thead><tr><th>#</th><th>Time</th><th>User</th><th>Kind</th><th>Action</th><th>Outcome</th></tr></thead>
            <tbody>{data.records.map(r => (
              <>
                <tr key={r.seq} onClick={() => setOpen(open === r.seq ? null : r.seq)} style={{ cursor: 'pointer' }} aria-expanded={open === r.seq}>
                  <td className="num faint">{r.seq}</td><td className="num muted">{new Date(r.time).toLocaleString()}</td><td>{r.user ?? '-'}</td>
                  <td><Badge tone={r.source === 'control' ? 'accent' : 'neutral'}>{r.kind}</Badge></td><td>{r.action}{typeof r.detail.target === 'string' && <span className="faint"> {r.detail.target.slice(0, 60)}</span>}</td>
                  <td><Badge tone={tone(r.outcome)}>{r.outcome}</Badge></td>
                </tr>
                {open === r.seq && <tr key={`${r.seq}d`}><td colSpan={6}><pre className="mono" style={{ margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{JSON.stringify(r.detail, null, 2)}{'\n'}hash {r.hash}</pre></td></tr>}
              </>))}</tbody>
          </table>)}
      </Card>
    </>
  );
}
