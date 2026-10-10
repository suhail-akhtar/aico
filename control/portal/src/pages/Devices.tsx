import { api, can, ago, fmtTime, type Me } from '../api';
import { Badge, Button, Card, Empty, PageHead, Skeleton, useLoad, useToast } from '../ui';

interface Device { id: string; user: string; name: string; platform: string; aicoVersion: string; enrolledAt: number; lastSeenAt: number | null; revokedAt: number | null; revokedReason: string | null }

export function Devices({ me }: { me: Me }) {
  const { data, error, loading, reload } = useLoad(() => api<{ devices: Device[] }>('/v1/admin/devices'));
  const toast = useToast();
  const revoke = async (d: Device): Promise<void> => {
    if (!window.confirm(`Revoke ${d.name} (${d.user})? It stops receiving policy and its sign-in ends at once.`)) return;
    try { await api(`/v1/admin/devices/${d.id}/revoke`, { method: 'POST', body: {} }); toast('Device revoked'); reload(); } catch (e) { toast(e instanceof Error ? e.message : 'Failed', 'bad'); }
  };
  const active = data?.devices.filter(d => !d.revokedAt).length ?? 0;
  return (
    <>
      <PageHead title="Devices" sub="Every AICO that signed in with a code. Revoking ends its sign-in immediately; the person can enrol again." />
      {error && <div className="notice bad">{error}</div>}
      <Card flush title={data ? `${active} active, ${data.devices.length - active} revoked` : undefined}>
        {loading && !data ? <Skeleton /> : !data?.devices.length ? <Empty title="No devices yet">On a computer, run <code>aico control login {window.location.origin}</code>, or use Organisation in AICO's settings.</Empty> : (
          <table>
            <thead><tr><th>Device</th><th>User</th><th>AICO</th><th>Enrolled</th><th>Last seen</th><th>Status</th><th /></tr></thead>
            <tbody>{data.devices.map(d => (
              <tr key={d.id}>
                <td><div style={{ fontWeight: 600 }}>{d.name}</div><div className="faint">{d.platform}</div></td>
                <td>{d.user}</td><td className="num">{d.aicoVersion || '-'}</td><td className="muted">{fmtTime(d.enrolledAt)}</td><td className="muted">{ago(d.lastSeenAt)}</td>
                <td>{d.revokedAt ? <Badge tone="bad">revoked</Badge> : <Badge tone="ok">active</Badge>}{d.revokedReason && <div className="faint">{d.revokedReason}</div>}</td>
                <td className="right">{can(me, 'devices.revoke') && !d.revokedAt && <Button kind="ghost" className="btn-sm btn-danger" onClick={() => void revoke(d)}>Revoke</Button>}</td>
              </tr>))}</tbody>
          </table>)}
      </Card>
    </>
  );
}
