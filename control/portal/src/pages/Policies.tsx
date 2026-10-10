/**
 * The policy editor. The document is the engine's managed-policy JSON (ADR 0035);
 * validation is the engine's own, run on the server as you type, and the
 * "what the engine will enforce" list is the engine's own wording.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { ApiError, api, can, ago, type Me } from '../api';
import { Badge, Button, Card, PageHead, Skeleton, useLoad, useToast } from '../ui';

interface PolicyRow { id: string; scope: 'tenant' | 'role' | 'team'; scopeId: string; name: string; doc: Record<string, unknown>; updatedAt: number; updatedBy: string | null }
interface Problem { level: 'error' | 'warning'; key?: string; message: string }
interface Check { ok: boolean; problems: Problem[]; rules: string[] }
const ROLES = ['owner', 'admin', 'auditor', 'team-lead', 'developer', 'contractor'];
const STARTER = '{\n  "message": "Set by your organisation.",\n  "maxAutonomyLevel": "L3"\n}';

export function Policies({ me }: { me: Me }) {
  const pols = useLoad(() => api<{ policies: PolicyRow[] }>('/v1/admin/policies'));
  const teams = useLoad(() => api<{ teams: Array<{ id: string; name: string }> }>('/v1/admin/teams'));
  const [sel, setSel] = useState<{ scope: PolicyRow['scope']; scopeId: string; label: string }>({ scope: 'tenant', scopeId: '*', label: 'Everyone in the organisation' });
  const toast = useToast();
  const manage = can(me, 'policies.manage');
  const existing = useMemo(() => pols.data?.policies.find(p => p.scope === sel.scope && p.scopeId === sel.scopeId), [pols.data, sel]);
  const [text, setText] = useState('');
  const [check, setCheck] = useState<Check | null>(null);
  const [saving, setSaving] = useState(false);
  const [serverProblems, setServerProblems] = useState<Problem[] | null>(null);
  const seq = useRef(0);

  useEffect(() => { setText(existing ? JSON.stringify(existing.doc, null, 2) : ''); setServerProblems(null); }, [existing?.id, existing?.updatedAt, sel.scope, sel.scopeId]);

  // Validate with the engine's schema, debounced.
  useEffect(() => {
    if (!text.trim()) { setCheck(null); return; }
    let doc: unknown;
    try { doc = JSON.parse(text); } catch (e) { setCheck({ ok: false, problems: [{ level: 'error', message: `Not valid JSON: ${(e as Error).message}` }], rules: [] }); return; }
    const mine = ++seq.current;
    const t = setTimeout(() => {
      api<Check>('/v1/admin/policies/validate', { method: 'POST', body: { doc } }).then(c => { if (mine === seq.current) setCheck(c); }).catch(() => undefined);
    }, 250);
    return () => clearTimeout(t);
  }, [text]);

  const dirty = (existing ? JSON.stringify(existing.doc, null, 2) : '') !== text;
  const save = async (): Promise<void> => {
    setSaving(true);
    try {
      await api('/v1/admin/policies', { method: 'PUT', body: { scope: sel.scope, scopeId: sel.scopeId, name: sel.label, doc: JSON.parse(text) } });
      toast('Policy saved. Devices pick it up within a few minutes.');
      setServerProblems(null);
      pols.reload();
    } catch (e) {
      if (e instanceof ApiError && Array.isArray(e.data.problems)) setServerProblems(e.data.problems as Problem[]);
      toast(e instanceof Error ? e.message : 'Failed', 'bad');
    } finally { setSaving(false); }
  };
  const remove = async (): Promise<void> => {
    if (!existing || !window.confirm('Remove this policy? Devices stop applying it at their next sync.')) return;
    try { await api(`/v1/admin/policies/${existing.id}`, { method: 'DELETE', body: {} }); toast('Policy removed'); pols.reload(); } catch (e) { toast(e instanceof Error ? e.message : 'Failed', 'bad'); }
  };

  const has = (scope: string, id: string): boolean => Boolean(pols.data?.policies.some(p => p.scope === scope && p.scopeId === id));
  const problems = serverProblems ?? check?.problems ?? [];
  const blocked = !check?.ok;

  return (
    <>
      <PageHead title="Policies" sub="Rules that apply to every AICO signed in to this organisation. A policy can only restrict: layers stack (organisation, then role, then team) and none can loosen another." />
      <div className="split">
        <Card flush>
          {pols.loading && !pols.data ? <Skeleton rows={8} /> : (
            <div className="scope-list">
              <h3>Organisation</h3>
              <button aria-current={sel.scope === 'tenant'} onClick={() => setSel({ scope: 'tenant', scopeId: '*', label: 'Everyone in the organisation' })}>Everyone {has('tenant', '*') && <span className="dot" title="Has a policy" />}</button>
              <h3>By role</h3>
              {ROLES.map(r => <button key={r} aria-current={sel.scope === 'role' && sel.scopeId === r} onClick={() => setSel({ scope: 'role', scopeId: r, label: `Role: ${r}` })}>{r}{has('role', r) && <span className="dot" title="Has a policy" />}</button>)}
              <h3>By team</h3>
              {teams.data?.teams.map(t => <button key={t.id} aria-current={sel.scope === 'team' && sel.scopeId === t.id} onClick={() => setSel({ scope: 'team', scopeId: t.id, label: `Team: ${t.name}` })}>{t.name}{has('team', t.id) && <span className="dot" title="Has a policy" />}</button>)}
              {!teams.data?.teams.length && <p className="faint" style={{ padding: '4px 8px' }}>No teams yet.</p>}
            </div>)}
        </Card>
        <Card title={sel.label} actions={existing ? <span className="faint">saved {ago(existing.updatedAt)} by {existing.updatedBy ?? 'unknown'}</span> : <Badge>no policy</Badge>}>
          {!existing && !text && manage && <p className="muted" style={{ marginBottom: 10 }}>Nothing is set here. <button className="btn btn-sm" onClick={() => setText(STARTER)}>Start from an example</button></p>}
          <textarea aria-label="Policy JSON" rows={16} spellCheck={false} value={text} readOnly={!manage} onChange={e => setText(e.target.value)} placeholder='{ "deniedTools": ["Bash(rm *)"], "network": { "mode": "allow-list", "domains": ["github.com"] } }' />
          {problems.length > 0 && <div className="problems" role="list">{problems.map((p, i) => <div key={i} role="listitem" className={`problem ${p.level}`}><strong>{p.level === 'error' ? 'Error' : 'Note'}</strong>{p.key ? ` ${p.key}: ` : ': '}{p.message}</div>)}</div>}
          {check?.ok && check.rules.length > 0 && (<><h2 style={{ marginTop: 16 }}>What the engine will enforce</h2><ul className="rules">{check.rules.map((r, i) => <li key={i}>{r}</li>)}</ul></>)}
          {manage && (
            <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
              <Button kind="primary" busy={saving} disabled={!text.trim() || blocked || !dirty} onClick={() => void save()}>Save policy</Button>
              {existing && <Button kind="danger" onClick={() => void remove()}>Remove</Button>}
            </div>)}
        </Card>
      </div>
    </>
  );
}
