/**
 * Credentials & passwords — one manager for everything in AICO's vault: the
 * admin password the agent generated for a server, an SSH key, an API token,
 * and the web logins the built-in browser saves (the browser's Passwords page
 * is this component with a "web logins" preset).
 *
 * What this interface holds: names, kinds, usernames, hosts, policies and the
 * audit trail — never a value. Every action that touches a value is main's
 * (electron/credential-manager.ts): Add and Rotate open main's secure prompt,
 * Reveal shows the value in a native dialog that closes itself, Copy puts it
 * on the clipboard and clears it again. Loosening a policy or deleting a
 * credential you stored is confirmed natively in main first.
 *
 * @module desktop/renderer/settings/CredentialManager
 */

import React, { useEffect, useMemo, useState } from 'react';
import { desktop, on, type AuditView, type CredentialView, type PolicyView, type VaultManagerStatus } from '@/desktop';
import { Icon } from '@/lib/icons';
import { ago, cls } from '@/lib/util';
import { toast } from '@/state/desk';
import { Modal } from '@/shell/Modal';
import { openChat } from '@/chat/actions';

const KINDS: Array<{ id: string; label: string; icon: string }> = [
  { id: 'login', label: 'Web / app login', icon: 'globe' },
  { id: 'ssh-key', label: 'SSH key', icon: 'key' },
  { id: 'ssh-password', label: 'SSH password', icon: 'terminal' },
  { id: 'api-token', label: 'API token', icon: 'code' },
  { id: 'basic-auth', label: 'HTTP basic auth', icon: 'lock' },
  { id: 'winrm', label: 'WinRM', icon: 'monitor' },
  { id: 'snmp', label: 'SNMP', icon: 'activity' },
  { id: 'database', label: 'Database', icon: 'database' },
  { id: 'certificate', label: 'Certificate', icon: 'shield' },
  { id: 'note', label: 'Secure note', icon: 'file-text' },
  { id: 'generic', label: 'Other secret', icon: 'lock' },
];
const GENERATABLE = new Set(['login', 'ssh-key', 'ssh-password', 'api-token', 'basic-auth', 'winrm', 'database', 'generic']);
const kindOf = (id: string) => KINDS.find(k => k.id === id) ?? { id, label: id, icon: 'lock' };
const APPROVAL_LABEL: Record<string, string> = {
  auto: 'Never ask (within its scope)', session: 'Ask once per session', 'every-use': 'Ask every time',
};

const isWebLogin = (c: CredentialView): boolean => c.kind === 'login' && Boolean(c.url && /^https?:/i.test(c.url));
const scopeOf = (c: CredentialView): string[] => {
  const p = c.policy;
  const s = [...p.allowedOrigins, ...p.allowedHosts];
  if (s.length) return s;
  return [c.url, c.host ? `${c.host}${c.port ? `:${c.port}` : ''}` : undefined].filter((x): x is string => Boolean(x));
};
const agentSession = (c: CredentialView): string | null => (c.createdBy.startsWith('agent:') ? c.createdBy.slice('agent:'.length) : null);
const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export function CredentialManager({ preset }: { preset?: 'web' }): React.ReactElement {
  const [status, setStatus] = useState<VaultManagerStatus | null>(null);
  const [items, setItems] = useState<CredentialView[] | null>(null);
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState(preset === 'web' ? 'web' : 'all');
  const [creator, setCreator] = useState<'all' | 'user' | 'agent'>('all');
  const [open, setOpen] = useState<string | null>(null);
  const [adding, setAdding] = useState<null | 'add' | 'generate'>(null);
  const [rev, setRev] = useState(0);
  const [error, setError] = useState('');

  useEffect(() => {
    const bump = (): void => setRev(r => r + 1);
    const offs = [desktop.vault.onChanged(bump), on('browser:vault:changed', bump), on('vault:migrated', bump)];
    return () => { for (const o of offs) o(); };
  }, []);
  useEffect(() => {
    let live = true;
    void (async () => {
      const st = await desktop.vault.status().catch((e: Error) => ({ keyProblem: null, lockedByYou: false, error: e.message } as VaultManagerStatus));
      if (!live) return;
      setStatus(st);
      if (st.error || st.lockedByYou || (st.exists && !st.unlocked && st.interactive)) { setItems([]); return; }
      const list = await desktop.vault.list().catch((e: Error) => { setError(e.message); return [] as CredentialView[]; });
      if (live) { setItems(list); setError(''); }
    })();
    return () => { live = false; };
  }, [rev]);

  const list = useMemo(() => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    return (items ?? []).filter(c => (kind === 'all' || (kind === 'web' ? isWebLogin(c) : c.kind === kind))
      && (creator === 'all' || (creator === 'agent' ? agentSession(c) !== null : agentSession(c) === null))
      && words.every(w => [c.name, c.username, c.host, c.url, c.description, ...c.tags, ...scopeOf(c)].join(' ').toLowerCase().includes(w)))
      .sort((a, b) => Number(Boolean(b.quarantined)) - Number(Boolean(a.quarantined)) || a.name.localeCompare(b.name));
  }, [items, query, kind, creator]);

  const run = async <T,>(p: Promise<T>, ok?: string): Promise<T | undefined> => {
    try { const r = await p; if (ok && r) toast.success(ok); setRev(x => x + 1); return r; }
    catch (e) { const m = errText(e); if (m !== 'Cancelled.') toast.error('Credential Manager', m); return undefined; }
  };

  const locked = Boolean(status?.lockedByYou);
  const quarantined = (items ?? []).filter(c => c.quarantined).length;
  return (
    <div>
      <p className="-mt-2 mb-4 text-[13px] leading-relaxed text-aico-muted">
        {preset === 'web'
          ? 'Web logins the built-in browser saved, kept in AICO’s encrypted credential vault. Each is filled only into the exact site it belongs to. The agent can sign in with one by name — it never sees or types the password.'
          : 'Passwords, keys and tokens the agent can use but never see. It refers to them by name; AICO fills them in at the moment of use, only where each one’s policy allows, and asks you when the policy says so. Everything here is metadata — values stay in the vault.'}
      </p>

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <span className="mr-auto flex items-center gap-2 text-[12.5px] text-aico-muted">
          <Icon name={locked ? 'lock' : 'shield-check'} size={15} className={locked ? 'text-aico-warning' : 'text-aico-success'} />
          {status?.error ? status.error
            : locked ? 'Locked — nothing can be used until you unlock it.'
              : `${items?.length ?? '…'} stored${status?.provider ? ` · sealed with ${status.provider === 'injected' ? 'your OS keychain (via AICO Desktop)' : status.provider}` : ''}`}
        </span>
        {!locked && <button className="btn-primary btn-sm" onClick={() => setAdding('add')}><Icon name="plus" size={14} />Add</button>}
        {!locked && preset !== 'web' && <button className="btn-outline btn-sm" onClick={() => setAdding('generate')}><Icon name="sparkles" size={14} />Generate</button>}
        {!locked && <button className="btn-ghost btn-sm" title="Import an encrypted export" onClick={() => void run(desktop.vault.importEncrypted()).then(r => r && toast.success(`Imported ${r.added}`, r.skipped ? `${r.skipped} skipped (names already in use).` : undefined))}><Icon name="download" size={14} />Import</button>}
        {!locked && <button className="btn-ghost btn-sm" title="Export everything, encrypted with a passphrase you choose" onClick={() => void run(desktop.vault.exportEncrypted()).then(r => r && toast.success(`Exported ${r.count}`, r.file))}><Icon name="upload" size={14} />Export</button>}
        {preset === 'web' && !locked && <button className="btn-ghost btn-sm" title="Plain CSV for another browser" onClick={() => void run(desktop.vault.exportCsv()).then(r => r && toast.success(`Exported ${r.count} logins`, `${r.file} — not encrypted: delete it once imported.`))}><Icon name="file-text" size={14} />CSV…</button>}
        <button className="btn-ghost btn-sm" onClick={() => void (locked ? run(desktop.vault.unlock(), 'Vault unlocked') : run(desktop.vault.lock(), 'Vault locked'))}>
          <Icon name={locked ? 'key' : 'lock'} size={14} />{locked ? 'Unlock' : 'Lock'}
        </button>
      </div>

      {status?.keyProblem && (
        <div className="card mb-3 flex items-start gap-3 p-3 text-[12.5px]">
          <Icon name="alert" size={16} className="mt-0.5 shrink-0 text-aico-warning" />
          <div><div className="font-medium">Using the engine’s own key store</div><div className="text-aico-muted">{status.keyProblem} The vault is sealed by the engine’s keyring instead.</div></div>
        </div>
      )}
      {quarantined > 0 && kind === 'all' && (
        <div className="card mb-3 flex items-start gap-3 p-3 text-[12.5px]">
          <Icon name="shield" size={16} className="mt-0.5 shrink-0 text-aico-warning" />
          <div>{quarantined} secret{quarantined === 1 ? ' was' : 's were'} caught in a chat message and moved here. Bind {quarantined === 1 ? 'it' : 'them'} to where {quarantined === 1 ? 'it belongs' : 'they belong'}, or delete {quarantined === 1 ? 'it' : 'them'}.</div>
        </div>
      )}

      {!locked && (
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <div className="flex min-w-[220px] flex-1 items-center gap-2 rounded-full border border-aico-border-subtle px-3 py-1.5">
            <Icon name="search" size={14} className="text-aico-muted" />
            <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search by name, host, username or tag" aria-label="Search credentials"
              className="min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-aico-muted" />
          </div>
          <select className="input h-8 w-auto py-0 text-[12.5px]" value={kind} onChange={e => setKind(e.target.value)} aria-label="Kind">
            <option value="all">All kinds</option>
            <option value="web">Web logins</option>
            {KINDS.map(k => <option key={k.id} value={k.id}>{k.label}</option>)}
          </select>
          <select className="input h-8 w-auto py-0 text-[12.5px]" value={creator} onChange={e => setCreator(e.target.value as typeof creator)} aria-label="Created by">
            <option value="all">Anyone</option>
            <option value="user">Added by you</option>
            <option value="agent">Created by AICO</option>
          </select>
        </div>
      )}

      {error && <div className="mb-2 text-[12.5px] text-aico-danger">{error}</div>}
      {items === null && <div className="py-10 text-center text-[13px] text-aico-muted">Opening the vault…</div>}
      {items !== null && !locked && !items.length && (
        <div className="flex flex-col items-center gap-2 py-12 text-center text-[13px] text-aico-muted">
          <Icon name="key" size={26} />
          <div className="max-w-[440px]">
            {preset === 'web'
              ? 'No saved web logins yet. Sign in to a site in the built-in browser and AICO offers to save it — or import a passwords file you export from another browser.'
              : 'Nothing stored yet. When the agent sets up a service it can create the admin password here itself — you never have to see it. You can also add your own passwords, keys and tokens.'}
          </div>
        </div>
      )}
      {items !== null && items.length > 0 && !list.length && <div className="py-8 text-center text-[13px] text-aico-muted">Nothing matches.</div>}
      {list.length > 0 && (
        <div className="card overflow-hidden p-1" role="list">
          {list.map(c => (
            <CredentialRow key={c.id} c={c} open={open === c.id} toggle={() => setOpen(o => (o === c.id ? null : c.id))} run={run} />
          ))}
        </div>
      )}
      <p className="mt-6 text-[11.5px] leading-relaxed text-aico-muted">
        Values are encrypted with a key sealed by your operating system’s keychain and are never shown to the agent, put in chats, logs or AICO backups.
        Showing or copying one asks you first; so does anything that lets a credential be used more widely, and deleting or replacing one you added.
      </p>

      {adding && <AddCredential mode={adding} web={preset === 'web'} close={() => setAdding(null)} done={() => { setAdding(null); setRev(r => r + 1); }} />}
    </div>
  );
}

function CredentialRow({ c, open, toggle, run }: {
  c: CredentialView; open: boolean; toggle: () => void;
  run: <T>(p: Promise<T>, ok?: string) => Promise<T | undefined>;
}): React.ReactElement {
  const k = kindOf(c.kind);
  const session = agentSession(c);
  const scope = scopeOf(c);
  return (
    <div role="listitem" className={cls('rounded-xl', open && 'bg-aico-hover/60')}>
      <button className="group flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left hover:bg-aico-hover" onClick={toggle} aria-expanded={open}>
        <Icon name={k.icon} size={16} className="shrink-0 text-aico-secondary" />
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <span className="truncate text-[13px] font-medium">{c.name}</span>
            {session !== null && <span className="chip h-5 shrink-0 py-0 text-[10.5px]">AICO</span>}
            {c.quarantined && <span className="chip h-5 shrink-0 py-0 text-[10.5px] text-aico-warning">Caught in chat</span>}
          </span>
          <span className="block truncate text-[11.5px] text-aico-muted">
            {k.label}{c.username ? ` · ${c.username}` : ''}{scope.length ? ` · ${scope.slice(0, 2).join(', ')}${scope.length > 2 ? ` +${scope.length - 2}` : ''}` : ' · not bound — every use asks'}
          </span>
        </span>
        <span className="shrink-0 text-[11.5px] text-aico-muted">{c.lastUsedAt ? `used ${ago(c.lastUsedAt)}` : 'never used'}</span>
        <Icon name={open ? 'chevron-up' : 'chevron-down'} size={14} className="shrink-0 text-aico-muted" />
      </button>
      {open && <CredentialDetails c={c} run={run} />}
    </div>
  );
}

function CredentialDetails({ c, run }: { c: CredentialView; run: <T>(p: Promise<T>, ok?: string) => Promise<T | undefined> }): React.ReactElement {
  const [audit, setAudit] = useState<AuditView[] | null>(null);
  const [editing, setEditing] = useState(false);
  const session = agentSession(c);
  useEffect(() => {
    let live = true;
    void desktop.vault.audit({ id: c.id, limit: 40 }).then(a => { if (live) setAudit(a); }).catch(() => { if (live) setAudit([]); });
    return () => { live = false; };
  }, [c.id, c.updatedAt, c.lastUsedAt]);
  const p = c.policy;
  return (
    <div className="px-4 pb-4 pt-1 text-[12.5px]">
      <dl className="grid grid-cols-[130px_1fr] gap-x-3 gap-y-1.5">
        <dt className="text-aico-muted">Created</dt>
        <dd>
          {session !== null
            ? <>By AICO{session && session !== 'cli' ? <> for <button className="text-aico-accent hover:underline" onClick={() => void openChat(session)}>this chat</button></> : ''}, {new Date(c.createdAt).toLocaleString()}</>
            : <>By you, {new Date(c.createdAt).toLocaleString()}</>}
        </dd>
        {c.username && <><dt className="text-aico-muted">Username</dt><dd className="selectable">{c.username}</dd></>}
        {(c.url || c.host) && <><dt className="text-aico-muted">For</dt><dd className="selectable break-all">{c.url ?? `${c.host}${c.port ? `:${c.port}` : ''}`}</dd></>}
        <dt className="text-aico-muted">Holds</dt><dd>{c.fields.join(', ') || '—'} <span className="text-aico-muted">(values hidden)</span></dd>
        {c.description && <><dt className="text-aico-muted">About</dt><dd className="selectable">{c.description}</dd></>}
        {c.tags.length > 0 && <><dt className="text-aico-muted">Tags</dt><dd>{c.tags.join(', ')}</dd></>}
        {c.public?.publicKey && (
          <>
            <dt className="text-aico-muted">Public key</dt>
            <dd className="min-w-0">
              <div className="selectable truncate font-mono text-[11.5px]" title={c.public.publicKey}>{c.public.publicKey}</div>
              {c.public.fingerprint && <div className="font-mono text-[11px] text-aico-muted">{c.public.fingerprint}</div>}
              <button className="btn-ghost btn-sm mt-1" onClick={() => { void navigator.clipboard.writeText(c.public!.publicKey!); toast.success('Public key copied', 'Public keys are safe to share.'); }}><Icon name="copy" size={13} />Copy public key</button>
            </dd>
          </>
        )}
        <dt className="text-aico-muted">Used</dt><dd>{c.useCount ? `${c.useCount} time${c.useCount === 1 ? '' : 's'}, last ${c.lastUsedAt ? ago(c.lastUsedAt) + ' ago' : '—'}` : 'Not yet'}</dd>
      </dl>

      <div className="mt-3 flex flex-wrap gap-2">
        <button className="btn-outline btn-sm" onClick={() => void run(desktop.vault.reveal(c.id))}><Icon name="eye" size={13} />Reveal…</button>
        <button className="btn-outline btn-sm" onClick={() => void run(desktop.vault.copy(c.id), 'Copied — cleared from the clipboard in 45 seconds')}><Icon name="copy" size={13} />Copy…</button>
        {GENERATABLE.has(c.kind) && c.kind !== 'ssh-key' && <button className="btn-ghost btn-sm" onClick={() => void run(desktop.vault.rotate(c.id, 'generate'), 'New value stored')}><Icon name="refresh" size={13} />Generate new</button>}
        <button className="btn-ghost btn-sm" onClick={() => void run(desktop.vault.rotate(c.id, 'enter'), 'Value replaced')}><Icon name="edit" size={13} />Replace…</button>
        <button className="btn-ghost btn-sm" onClick={() => setEditing(e => !e)}><Icon name="shield" size={13} />{editing ? 'Close policy' : 'Edit policy'}</button>
        <button className="btn-ghost btn-sm text-aico-danger" onClick={() => void run(desktop.vault.remove(c.id), 'Deleted')}><Icon name="trash" size={13} />Delete…</button>
      </div>

      {!editing && (
        <div className="mt-3 rounded-lg border border-aico-border-subtle p-2.5 text-[12px] text-aico-secondary">
          <div><b className="font-medium text-aico-primary">Where:</b> {scopeOf(c).join(', ') || 'anywhere — so every use asks you'}</div>
          <div><b className="font-medium text-aico-primary">By:</b> {p.allowedTools.length ? p.allowedTools.join(', ') : 'any trusted AICO tool'}{p.allowShell ? '; shell commands too (each one asks you)' : '; never in shell commands'}</div>
          <div><b className="font-medium text-aico-primary">Asks you:</b> {APPROVAL_LABEL[p.approval] ?? p.approval}{p.allowSelfSigned ? ' · accepts a self-signed certificate there' : ''}{p.allowInsecureHttp ? ' · plain http allowed' : ''}{p.expiresAt ? ` · expires ${new Date(p.expiresAt).toLocaleDateString()}` : ''}</div>
        </div>
      )}
      {editing && <PolicyEditor c={c} run={run} done={() => setEditing(false)} />}

      <div className="mt-4">
        <div className="mb-1 text-[12px] font-medium text-aico-muted">History</div>
        {audit === null && <div className="text-aico-muted">Loading…</div>}
        {audit?.length === 0 && <div className="text-aico-muted">Nothing recorded yet.</div>}
        {audit && audit.length > 0 && (
          <div className="max-h-48 overflow-y-auto rounded-lg border border-aico-border-subtle thin-scroll">
            {audit.map((e, i) => (
              <div key={i} className="flex gap-2 border-b border-aico-border-subtle px-2.5 py-1 last:border-0">
                <span className="w-[62px] shrink-0 text-aico-muted" title={new Date(e.at).toLocaleString()}>{ago(e.at)}</span>
                <span className={cls('w-[68px] shrink-0', e.outcome === 'ok' ? 'text-aico-success' : 'text-aico-warning')}>{e.action}{e.outcome !== 'ok' ? ` · ${e.outcome}` : ''}</span>
                <span className="min-w-0 flex-1 truncate" title={[e.tool, e.target, e.purpose, e.reason, e.actor].filter(Boolean).join(' · ')}>
                  {[e.tool, e.target, e.purpose ?? e.reason, e.actor].filter(Boolean).join(' · ') || '—'}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

const lines = (s: string): string[] => s.split(/[\n,]+/).map(x => x.trim()).filter(Boolean);

function PolicyEditor({ c, run, done }: { c: CredentialView; run: <T>(p: Promise<T>, ok?: string) => Promise<T | undefined>; done: () => void }): React.ReactElement {
  const p = c.policy;
  const [origins, setOrigins] = useState(p.allowedOrigins.join('\n'));
  const [hosts, setHosts] = useState(p.allowedHosts.join('\n'));
  const [tools, setTools] = useState(p.allowedTools.join(', '));
  const [approval, setApproval] = useState(p.approval);
  const [allowShell, setAllowShell] = useState(p.allowShell);
  const [selfSigned, setSelfSigned] = useState(Boolean(p.allowSelfSigned));
  const [http, setHttp] = useState(Boolean(p.allowInsecureHttp));
  const [expires, setExpires] = useState(p.expiresAt ? new Date(p.expiresAt).toISOString().slice(0, 10) : '');
  const save = async (): Promise<void> => {
    const next: Partial<PolicyView> = {
      allowedOrigins: lines(origins), allowedHosts: lines(hosts), allowedTools: lines(tools), approval, allowShell,
      allowSelfSigned: selfSigned, allowInsecureHttp: http,
      // null (not undefined, which JSON drops) is how "no expiry" reaches the vault.
      expiresAt: (expires ? new Date(`${expires}T23:59:59`).getTime() : null) as number | undefined,
    };
    const r = await run(desktop.vault.policy(c.id, next), 'Policy saved');
    if (r) done();
  };
  return (
    <div className="mt-3 rounded-lg border border-aico-border-subtle p-3">
      <div className="grid grid-cols-2 gap-3">
        <label className="block"><span className="mb-1 block text-[11.5px] font-medium text-aico-muted">Web origins (one per line)</span>
          <textarea className="input h-16 w-full resize-none py-1 font-mono text-[11.5px]" value={origins} onChange={e => setOrigins(e.target.value)} placeholder="https://10.0.0.5:8443" /></label>
        <label className="block"><span className="mb-1 block text-[11.5px] font-medium text-aico-muted">Hosts (name, *.domain, IP or CIDR)</span>
          <textarea className="input h-16 w-full resize-none py-1 font-mono text-[11.5px]" value={hosts} onChange={e => setHosts(e.target.value)} placeholder="10.0.0.5" /></label>
        <label className="block"><span className="mb-1 block text-[11.5px] font-medium text-aico-muted">Tools (empty = any trusted tool)</span>
          <input className="input w-full font-mono text-[11.5px]" value={tools} onChange={e => setTools(e.target.value)} placeholder="Browser, browser_login, SSH" /></label>
        <label className="block"><span className="mb-1 block text-[11.5px] font-medium text-aico-muted">Ask me</span>
          <select className="input w-full" value={approval} onChange={e => setApproval(e.target.value as PolicyView['approval'])}>
            {Object.entries(APPROVAL_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select></label>
        <label className="block"><span className="mb-1 block text-[11.5px] font-medium text-aico-muted">Expires</span>
          <input className="input w-full" type="date" value={expires} onChange={e => setExpires(e.target.value)} /></label>
      </div>
      <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-[12px]">
        <label className="flex items-center gap-1.5"><input type="checkbox" checked={allowShell} onChange={e => setAllowShell(e.target.checked)} />Allow in shell commands (each asks you)</label>
        <label className="flex items-center gap-1.5"><input type="checkbox" checked={selfSigned} onChange={e => setSelfSigned(e.target.checked)} />Accept a self-signed certificate on these origins</label>
        <label className="flex items-center gap-1.5"><input type="checkbox" checked={http} onChange={e => setHttp(e.target.checked)} />Allow plain http to public addresses</label>
      </div>
      <p className="mt-2 text-[11.5px] text-aico-muted">Narrowing is saved at once. Anything that widens where or how it may be used asks you to confirm in a system dialog — the agent cannot do that itself.</p>
      <div className="mt-2 flex justify-end gap-2">
        <button className="btn-outline btn-sm" onClick={done}>Cancel</button>
        <button className="btn-primary btn-sm" onClick={() => void save()}>Save policy</button>
      </div>
    </div>
  );
}

function AddCredential({ mode, web, close, done }: { mode: 'add' | 'generate'; web: boolean; close: () => void; done: () => void }): React.ReactElement {
  const [kind, setKind] = useState(web ? 'login' : mode === 'generate' ? 'login' : 'login');
  const [name, setName] = useState('');
  const [username, setUsername] = useState('');
  const [where, setWhere] = useState('');
  const [description, setDescription] = useState('');
  const [approval, setApproval] = useState<PolicyView['approval']>('session');
  const [selfSigned, setSelfSigned] = useState(false);
  const [length, setLength] = useState(24);
  const [symbols, setSymbols] = useState(true);
  const [err, setErr] = useState('');
  const [made, setMade] = useState<{ name: string; publicKey?: string; fingerprint?: string } | null>(null);
  const kinds = mode === 'generate' ? KINDS.filter(k => GENERATABLE.has(k.id)) : KINDS;
  const target = (): { url?: string; host?: string; port?: number } => {
    const w = where.trim();
    if (!w) return {};
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(w)) return { url: w };
    const m = /^(.*?)(?::(\d+))?$/.exec(w)!;
    return { host: m[1]!, ...(m[2] ? { port: Number(m[2]) } : {}) };
  };
  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setErr('');
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(name)) { setErr('Names use letters, digits, - and _ (no spaces or dots), e.g. nas-admin.'); return; }
    const t = target();
    try {
      if (mode === 'generate') {
        const r = await desktop.vault.generate({ name, kind, ...(username ? { username } : {}), ...t, ...(description ? { description } : {}), length, symbols, ...(selfSigned ? { allowSelfSigned: true } : {}) });
        if (r.publicKey) { setMade({ name: r.name, publicKey: r.publicKey, ...(r.fingerprint ? { fingerprint: r.fingerprint } : {}) }); return; }
        toast.success(`Generated ${r.name}`, 'Stored in the vault. Nobody has seen it.');
        done();
        return;
      }
      const r = await desktop.vault.add({
        name, kind, ...(username ? { username } : {}), ...t, ...(description ? { description } : {}),
        ...(web ? { tags: ['browser'] } : {}),
        policy: { approval, ...(selfSigned ? { allowSelfSigned: true } : {}), ...(web && t.url ? { allowedOrigins: [new URL(t.url).origin], allowedTools: ['Browser', 'browser_login'] } : {}) },
      });
      if (!r) return; // cancelled in the secure prompt
      toast.success(`Saved ${r.credential.name}`, r.warnings.length ? r.warnings.join(' ') : 'Stored in the vault.');
      done();
    } catch (x) { setErr(errText(x)); }
  };
  return (
    <Modal open onClose={close} title={mode === 'generate' ? 'Generate a credential' : 'Add a credential'} width={480}>
      {made ? (
        <div className="px-5 pb-4 pt-2 text-[13px]">
          <p>Stored <b>{made.name}</b>. Its private key never leaves the vault. Put the public key where it should be trusted:</p>
          <div className="selectable mt-2 break-all rounded-lg bg-aico-code p-2 font-mono text-[11.5px]">{made.publicKey}</div>
          {made.fingerprint && <div className="mt-1 font-mono text-[11px] text-aico-muted">{made.fingerprint}</div>}
          <div className="mt-3 flex justify-end gap-2">
            <button className="btn-outline" onClick={() => { void navigator.clipboard.writeText(made.publicKey ?? ''); toast.success('Public key copied'); }}>Copy public key</button>
            <button className="btn-primary" onClick={done}>Done</button>
          </div>
        </div>
      ) : (
        <form className="px-5 pb-4 pt-2" onSubmit={e => void submit(e)} autoComplete="off">
          {!web && (
            <>
              <label className="mb-1 block text-[12px] font-medium text-aico-muted" htmlFor="cm-kind">Kind</label>
              <select id="cm-kind" className="input mb-3 w-full" value={kind} onChange={e => setKind(e.target.value)}>
                {kinds.map(k => <option key={k.id} value={k.id}>{k.label}</option>)}
              </select>
            </>
          )}
          <label className="mb-1 block text-[12px] font-medium text-aico-muted" htmlFor="cm-name">Name</label>
          <input id="cm-name" className="input mb-3 w-full" value={name} onChange={e => setName(e.target.value)} placeholder="nas-admin" autoFocus spellCheck={false} />
          <label className="mb-1 block text-[12px] font-medium text-aico-muted" htmlFor="cm-where">{web ? 'Site' : 'Used with (URL, origin or host)'}</label>
          <input id="cm-where" className="input mb-3 w-full" value={where} onChange={e => setWhere(e.target.value)} placeholder={web ? 'https://example.com' : 'https://10.0.0.5:8443  or  10.0.0.5'} spellCheck={false} />
          {kind !== 'api-token' && kind !== 'note' && (
            <>
              <label className="mb-1 block text-[12px] font-medium text-aico-muted" htmlFor="cm-user">Username</label>
              <input id="cm-user" className="input mb-3 w-full" value={username} onChange={e => setUsername(e.target.value)} spellCheck={false} />
            </>
          )}
          {!web && (
            <>
              <label className="mb-1 block text-[12px] font-medium text-aico-muted" htmlFor="cm-desc">Description</label>
              <input id="cm-desc" className="input mb-3 w-full" value={description} onChange={e => setDescription(e.target.value)} />
            </>
          )}
          {mode === 'add' && !web && (
            <>
              <label className="mb-1 block text-[12px] font-medium text-aico-muted" htmlFor="cm-appr">Ask me before it is used</label>
              <select id="cm-appr" className="input mb-3 w-full" value={approval} onChange={e => setApproval(e.target.value as PolicyView['approval'])}>
                {Object.entries(APPROVAL_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
            </>
          )}
          {mode === 'generate' && kind !== 'ssh-key' && (
            <div className="mb-3 flex items-center gap-4 text-[12.5px]">
              <label className="flex items-center gap-1.5">Length <input className="input h-7 w-16 py-0" type="number" min={12} max={128} value={length} onChange={e => setLength(Number(e.target.value) || 24)} /></label>
              <label className="flex items-center gap-1.5"><input type="checkbox" checked={symbols} onChange={e => setSymbols(e.target.checked)} />Symbols</label>
            </div>
          )}
          {!web && (
            <label className="mb-1 flex items-center gap-1.5 text-[12.5px]"><input type="checkbox" checked={selfSigned} onChange={e => setSelfSigned(e.target.checked)} />The service uses a self-signed certificate</label>
          )}
          <p className="mt-2 text-[11.5px] text-aico-muted">
            {mode === 'generate'
              ? 'AICO makes a strong random value and stores it. Nobody sees it; the agent uses it by name.'
              : 'Next, a small secure window asks for the secret itself. What you type there goes straight into the vault — not into this window.'}
          </p>
          <div className="h-4 text-[11.5px] text-aico-danger">{err}</div>
          <div className="mt-2 flex justify-end gap-2">
            <button type="button" className="btn-outline" onClick={close}>Cancel</button>
            <button type="submit" className="btn-primary">{mode === 'generate' ? 'Generate' : 'Continue…'}</button>
          </div>
        </form>
      )}
    </Modal>
  );
}
