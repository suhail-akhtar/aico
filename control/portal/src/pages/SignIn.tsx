import { useEffect, useState } from 'react';
import { api } from '../api';
import { Button, Field } from '../ui';

export function SignIn() {
  const [slug, setSlug] = useState('');
  useEffect(() => { api<{ defaultTenant: string | null }>('/v1/public').then(p => { if (p.defaultTenant) setSlug(p.defaultTenant); }).catch(() => undefined); }, []);
  const go = (e: React.FormEvent): void => {
    e.preventDefault();
    if (slug.trim()) window.location.assign(`/auth/login?tenant=${encodeURIComponent(slug.trim().toLowerCase())}&next=/`);
  };
  return (
    <div className="signin">
      <form className="signin-card" onSubmit={go}>
        <div className="brand-mark" style={{ width: 36, height: 36, fontSize: 18 }}>A</div>
        <h1>Sign in to AICO Control</h1>
        <p className="muted" style={{ marginBottom: 22 }}>You will be sent to your organisation's identity provider. AICO never sees your password.</p>
        <Field label="Organisation" hint="The short name your administrator gave you, e.g. acme."><input value={slug} onChange={e => setSlug(e.target.value)} autoFocus autoComplete="organization" placeholder="acme" /></Field>
        <Button kind="primary" type="submit" disabled={!slug.trim()} style={{ width: '100%', justifyContent: 'center' }}>Continue</Button>
      </form>
    </div>
  );
}
