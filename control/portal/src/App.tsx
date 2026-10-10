/**
 * The shell: sign-in gate, navigation by permission, and a tiny history router
 * (the server falls back to index.html for any non-API path).
 */
import { useCallback, useEffect, useState } from 'react';
import { ApiError, api, can, setCsrf, type Me } from './api';
import { Button, Empty, Skeleton, Toasts } from './ui';
import { SignIn } from './pages/SignIn';
import { People } from './pages/People';
import { Roles } from './pages/Roles';
import { Policies } from './pages/Policies';
import { Devices } from './pages/Devices';
import { Audit } from './pages/Audit';
import { Usage } from './pages/Usage';

interface Route { path: string; label: string; perm: string; render: (me: Me) => JSX.Element }
const ROUTES: Route[] = [
  { path: '/', label: 'Users & teams', perm: 'users.read', render: me => <People me={me} /> },
  { path: '/roles', label: 'Roles', perm: 'roles.read', render: me => <Roles me={me} /> },
  { path: '/policies', label: 'Policies', perm: 'policies.read', render: me => <Policies me={me} /> },
  { path: '/devices', label: 'Devices', perm: 'devices.read', render: me => <Devices me={me} /> },
  { path: '/audit', label: 'Audit', perm: 'audit.read', render: me => <Audit me={me} /> },
  { path: '/usage', label: 'Usage & budgets', perm: 'usage.read', render: me => <Usage me={me} /> },
];

export function App() {
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const [path, setPath] = useState(window.location.pathname);

  useEffect(() => {
    api<Me>('/v1/me').then(m => { setCsrf(m.csrf); setMe(m); }).catch((e: unknown) => { if (e instanceof ApiError && e.status === 401) setMe(null); else setMe(null); });
    const pop = (): void => setPath(window.location.pathname);
    window.addEventListener('popstate', pop);
    return () => window.removeEventListener('popstate', pop);
  }, []);

  const go = useCallback((to: string) => { window.history.pushState({}, '', to); setPath(to); }, []);

  if (me === undefined) return <div className="signin"><Skeleton rows={3} /></div>;
  if (me === null) return <SignIn />;

  const visible = ROUTES.filter(r => can(me, r.perm));
  const current = visible.find(r => r.path === path) ?? visible[0];

  const signOut = async (): Promise<void> => {
    try { await api('/auth/logout', { method: 'POST', body: {} }); } finally { window.location.assign('/'); }
  };

  return (
    <Toasts>
      <div className="shell">
        <aside className="side">
          <div className="brand"><span className="brand-mark">A</span><span>AICO Control<small>{me.tenant.name}</small></span></div>
          <nav className="nav" aria-label="Main">
            {visible.map(r => (
              <a key={r.path} href={r.path} aria-current={current?.path === r.path ? 'page' : undefined} onClick={e => { e.preventDefault(); go(r.path); }}>{r.label}</a>
            ))}
          </nav>
          <div className="side-foot">
            <div className="who">{me.user.email}</div>
            <div className="muted">{me.user.role}</div>
            <Button kind="ghost" className="btn-sm" onClick={() => void signOut()}>Sign out</Button>
          </div>
        </aside>
        <main className="main" key={current?.path}>
          {current ? current.render(me) : <Empty title="No access to the portal">Your role ({me.user.role}) does not include the admin portal. To connect AICO on your computer, run <code>aico control login</code>.</Empty>}
        </main>
      </div>
    </Toasts>
  );
}
