import { api, type Me } from '../api';
import { Badge, Card, PageHead, Skeleton, useLoad } from '../ui';

interface Role { id: string; label: string; description: string; permissions: string[]; teamScoped: boolean; members: number }

export function Roles(_: { me: Me }) {
  const { data, error } = useLoad(() => api<{ roles: Role[]; permissions: string[] }>('/v1/admin/roles'));
  return (
    <>
      <PageHead title="Roles" sub="What each role may do in this portal. Roles are built in; what a role may do in AICO itself is set by its policy." />
      {error && <div className="notice bad">{error}</div>}
      {!data ? <Skeleton rows={6} /> : (
        <>
          <div className="stats">
            {data.roles.map(r => (
              <div className="stat" key={r.id}>
                <div className="big">{r.members}</div>
                <div className="label"><strong>{r.label}</strong>{r.teamScoped && <> <Badge>own team only</Badge></>}</div>
                <p className="muted" style={{ marginTop: 6, fontSize: 12.5 }}>{r.description}</p>
              </div>
            ))}
          </div>
          <Card title="Permissions" flush>
            <table className="matrix">
              <thead><tr><th>Permission</th>{data.roles.map(r => <th key={r.id}>{r.label}</th>)}</tr></thead>
              <tbody>{data.permissions.map(p => (
                <tr key={p}><td><code>{p}</code></td>{data.roles.map(r => <td key={r.id}>{r.permissions.includes(p) ? <span className="yes" aria-label="allowed">Yes</span> : <span className="faint" aria-label="not allowed">-</span>}</td>)}</tr>
              ))}</tbody>
            </table>
          </Card>
        </>)}
    </>
  );
}
