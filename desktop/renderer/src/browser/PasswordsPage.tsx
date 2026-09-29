/**
 * The Passwords page — the built-in browser's saved logins: search, reveal
 * (main asks you to confirm first), copy, edit, delete, export, and a check
 * for weak and reused passwords.
 *
 * The list is origins and usernames only. A password reaches this page only
 * while you are looking at it (revealed, or being edited) and is dropped from
 * memory when you hide it, move on, or after thirty seconds.
 *
 * @module desktop/renderer/browser/PasswordsPage
 */

import React, { useEffect, useMemo, useState } from 'react';
import { Icon } from '@/lib/icons';
import { ago, cls } from '@/lib/util';
import { toast } from '@/state/desk';
import { desktop } from '@/desktop';
import { Modal } from '@/shell/Modal';
import type { VaultItem, VaultStatus } from '@desk/browser-types';
import { call } from './ipc';
import { Favicon } from './Omnibox';
import { hostOf } from './urls';
import { openUrl, showInternal } from './store';
import { openImportWizard } from './ImportWizard';
import { useVaultUi } from './PasswordsBar';

type Filter = 'all' | 'weak' | 'reused';

/** http, except this machine's own loopback (which main fills, as browsers treat it as secure). */
const insecure = (origin: string): boolean => {
  try { const u = new URL(origin); return u.protocol === 'http:' && !/^(localhost|127(\.\d{1,3}){3}|\[::1\])$|\.localhost$/i.test(u.hostname); } catch { return true; }
};
interface Secret { username: string; password: string; note: string }

export function PasswordsPage(): React.ReactElement {
  const rev = useVaultUi(s => s.rev);
  const [status, setStatus] = useState<VaultStatus | null>(null);
  const [items, setItems] = useState<VaultItem[]>([]);
  const [never, setNever] = useState<string[]>([]);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [shown, setShown] = useState<{ id: string; secret: Secret } | null>(null);
  const [edit, setEdit] = useState<{ item?: VaultItem; secret?: Secret } | null>(null);

  const load = async (): Promise<void> => {
    const s = await call<VaultStatus>('browser:vault:status').catch(() => undefined);
    setStatus(s ?? { available: false, reason: 'Saved passwords are not available in this version.', count: 0 });
    if (!s?.available) { setItems([]); return; }
    setItems((await call<VaultItem[]>('browser:vault:list').catch(() => undefined)) ?? []);
    setNever((await call<string[]>('browser:vault:never').catch(() => undefined)) ?? []);
  };
  useEffect(() => { void load(); }, [rev]);
  // A revealed password does not linger.
  useEffect(() => {
    if (!shown) return;
    const t = setTimeout(() => setShown(null), 30_000);
    return () => clearTimeout(t);
  }, [shown]);
  useEffect(() => () => setShown(null), []);

  const weak = items.filter(i => i.weak).length;
  const reused = items.filter(i => i.reused).length;
  const list = useMemo(() => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    return items.filter(i => (filter === 'all' || (filter === 'weak' ? i.weak : i.reused))
      && words.every(w => `${i.origin} ${i.username}`.toLowerCase().includes(w)));
  }, [items, query, filter]);

  const reveal = async (i: VaultItem): Promise<Secret | null> => {
    const s = await call<Secret | null>('browser:vault:reveal', i.id).catch((e: Error) => { toast.error('Could not show the password', e.message); return null; });
    return s ?? null;
  };
  const toggleShow = async (i: VaultItem): Promise<void> => {
    if (shown?.id === i.id) { setShown(null); return; }
    const s = await reveal(i);
    if (s) setShown({ id: i.id, secret: s });
  };
  const copy = async (i: VaultItem, what: 'password' | 'username'): Promise<void> => {
    const done = await call<boolean>('browser:vault:copy', i.id, what).catch((e: Error) => { toast.error('Could not copy', e.message); return false; });
    if (done) toast.success(what === 'password' ? 'Password copied' : 'Username copied', what === 'password' ? 'It is cleared from the clipboard in 45 seconds.' : undefined);
  };
  const startEdit = async (i: VaultItem): Promise<void> => {
    const s = shown?.id === i.id ? shown.secret : await reveal(i);
    if (s) setEdit({ item: i, secret: s });
  };
  const remove = async (i: VaultItem): Promise<void> => {
    const ok = await desktop.dialog.confirm({ title: 'Delete password', message: `Delete the saved password for ${i.username || 'this account'} on ${hostOf(i.origin)}?`, detail: 'This cannot be undone.', ok: 'Delete', danger: true }).catch(() => false);
    if (!ok) return;
    await call('browser:vault:delete', i.id).then(() => toast.success('Password deleted')).catch((e: Error) => toast.error('Could not delete', e.message));
    if (shown?.id === i.id) setShown(null);
  };
  const exportCsv = async (): Promise<void> => {
    const f = await call<string | null>('browser:vault:export').catch((e: Error) => { toast.error('Could not export', e.message); return null; });
    if (f) toast.success('Passwords exported', `${f} — it is not encrypted: delete it once you have imported it.`);
  };

  return (
    <div className="bx-chrome-page thin-scroll">
      <div className="mx-auto w-full max-w-[860px] px-8 pb-16 pt-8">
        <div className="mb-5 flex items-center gap-3">
          <Icon name="key" size={20} className="text-aico-secondary" />
          <h1 className="flex-1 text-[22px] font-semibold tracking-tight">Passwords</h1>
          <button className="btn-ghost btn-sm" disabled={!status?.available} onClick={() => setEdit({})}><Icon name="plus" size={14} />Add</button>
          <button className="btn-ghost btn-sm" disabled={!status?.available} onClick={() => openImportWizard({ passwords: true })}><Icon name="download" size={14} />Import…</button>
          <button className="btn-ghost btn-sm" disabled={!items.length} onClick={() => void exportCsv()}><Icon name="upload" size={14} />Export…</button>
          <button className="icon-btn" onClick={() => showInternal(null)} title="Close (Esc)"><Icon name="x" size={16} /></button>
        </div>

        {status && !status.available && (
          <div className="card mb-5 flex items-start gap-3 p-4 text-[13px]">
            <Icon name="lock" size={18} className="mt-0.5 shrink-0 text-aico-warning" />
            <div><div className="font-medium">Passwords cannot be saved on this computer</div><div className="mt-0.5 text-aico-muted">{status.reason}</div></div>
          </div>
        )}

        {status?.available && (
          <>
            <div className="mb-4 grid grid-cols-3 gap-2.5">
              {([['all', 'Saved', items.length, 'key'], ['weak', 'Weak', weak, 'alert'], ['reused', 'Reused', reused, 'copy']] as const).map(([id, label, n, icon]) => (
                <button key={id} className={cls('card flex items-center gap-3 px-4 py-3 text-left transition-colors', filter === id ? 'border-aico-accent' : 'hover:bg-aico-hover')}
                  aria-pressed={filter === id} onClick={() => setFilter(id)}>
                  <Icon name={icon} size={17} className={id !== 'all' && n > 0 ? 'text-aico-warning' : 'text-aico-secondary'} />
                  <span><span className="block text-[18px] font-semibold tabular-nums">{n}</span><span className="block text-[12px] text-aico-muted">{label}</span></span>
                </button>
              ))}
            </div>
            <div className="mb-4 flex items-center gap-2 rounded-full border border-aico-border-subtle px-4 py-2">
              <Icon name="search" size={15} className="text-aico-muted" />
              <input autoFocus value={query} onChange={e => setQuery(e.target.value)} placeholder="Search passwords by site or username" aria-label="Search passwords"
                className="min-w-0 flex-1 bg-transparent text-[13.5px] outline-none placeholder:text-aico-muted" />
            </div>
            {!items.length && (
              <div className="flex flex-col items-center gap-2 py-14 text-center text-[13px] text-aico-muted">
                <Icon name="key" size={26} />
                No saved passwords yet. Sign in to a site and AICO offers to save it — or import a passwords file you export from another browser.
                <button className="btn-outline btn-sm mt-2" onClick={() => openImportWizard({ passwords: true })}>Import passwords…</button>
              </div>
            )}
            {items.length > 0 && !list.length && <div className="py-10 text-center text-[13px] text-aico-muted">Nothing matches.</div>}
            {list.length > 0 && (
              <div className="card overflow-hidden p-1">
                {list.map(i => (
                  <div key={i.id} className="group flex items-center gap-3 rounded-xl px-3 py-2 hover:bg-aico-hover">
                    <Favicon url={i.origin} size={18} />
                    <button className="w-[30%] min-w-0 text-left" onClick={() => openUrl(i.origin, true)} title={`Open ${i.origin}`}>
                      <span className="block truncate text-[13px]">{hostOf(i.origin)}</span>
                      <span className="block truncate text-[11.5px] text-aico-muted">{insecure(i.origin) ? 'Not secure (http) — never filled' : `Updated ${ago(i.updated)}`}</span>
                    </button>
                    <span className="w-[24%] min-w-0 truncate text-[13px]">{i.username || <span className="text-aico-muted">(no username)</span>}</span>
                    <span className="min-w-0 flex-1 truncate font-mono text-[12.5px]">
                      {shown?.id === i.id ? shown.secret.password : '••••••••••'}
                    </span>
                    {i.weak && <span className="chip h-5 shrink-0 py-0 text-[11px] text-aico-warning" title={`Weak: ${i.weak}`}>Weak</span>}
                    {i.reused && <span className="chip h-5 shrink-0 py-0 text-[11px] text-aico-warning" title={`Also used on ${i.reused - 1} other site${i.reused === 2 ? '' : 's'}`}>Reused</span>}
                    <button className="icon-btn-sm" onClick={() => void toggleShow(i)} title={shown?.id === i.id ? 'Hide' : 'Show password'}><Icon name={shown?.id === i.id ? 'eye-off' : 'eye'} size={14} /></button>
                    <button className="icon-btn-sm" onClick={() => void copy(i, 'password')} title="Copy password"><Icon name="copy" size={14} /></button>
                    <button className="icon-btn-sm opacity-0 group-hover:opacity-100" onClick={() => void copy(i, 'username')} title="Copy username"><Icon name="user" size={14} /></button>
                    <button className="icon-btn-sm opacity-0 group-hover:opacity-100" onClick={() => void startEdit(i)} title="Edit"><Icon name="edit" size={14} /></button>
                    <button className="icon-btn-sm opacity-0 group-hover:opacity-100" onClick={() => void remove(i)} title="Delete"><Icon name="trash" size={14} /></button>
                  </div>
                ))}
              </div>
            )}
            {shown && <p className="mt-2 px-1 text-[11.5px] text-aico-muted">The shown password is hidden again in 30 seconds.</p>}
            {never.length > 0 && (
              <div className="mt-8">
                <div className="mb-1 px-1 text-[12px] font-medium text-aico-muted">Never offered for</div>
                <div className="card p-1">
                  {never.map(o => (
                    <div key={o} className="flex items-center gap-3 rounded-xl px-3 py-1.5 text-[13px] hover:bg-aico-hover">
                      <Favicon url={o} size={16} /><span className="flex-1 truncate">{hostOf(o)}</span>
                      <button className="btn-ghost btn-sm" onClick={() => void call('browser:vault:neverRemove', o).catch(() => {})}>Remove</button>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        )}
        <p className="mt-8 px-1 text-[11.5px] leading-relaxed text-aico-muted">
          Passwords are encrypted with your operating system’s keychain and kept only on this computer. They are never shown to AICO’s agent or the copilot,
          never put in AICO backups, and filled only into the exact site they were saved for, over a secure connection. Passwords from another browser come in
          through a file you export from that browser yourself — AICO never reads another browser’s password store.
        </p>
      </div>
      {edit && <EditLogin item={edit.item} secret={edit.secret} close={() => setEdit(null)} />}
    </div>
  );
}

function EditLogin({ item, secret, close }: { item?: VaultItem; secret?: Secret; close: () => void }): React.ReactElement {
  const [site, setSite] = useState(item?.origin ?? '');
  const [username, setUsername] = useState(secret?.username ?? '');
  const [password, setPassword] = useState(secret?.password ?? '');
  const [note, setNote] = useState(secret?.note ?? '');
  const [show, setShow] = useState(false);
  const [error, setError] = useState('');
  const save = async (): Promise<void> => {
    if (!password) { setError('Enter a password.'); return; }
    try {
      if (item) await call('browser:vault:update', item.id, { username, password, note });
      else await call('browser:vault:add', { origin: site, username, password, note });
      toast.success(item ? 'Password updated' : 'Password saved');
      close();
    } catch (e) { setError((e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')); }
  };
  return (
    <Modal open onClose={close} title={item ? `Edit password for ${hostOf(item.origin)}` : 'Add a password'} width={440}>
      <form className="px-5 pb-4 pt-2" onSubmit={e => { e.preventDefault(); void save(); }} autoComplete="off">
        {!item && (
          <>
            <label className="mb-1 block text-[12px] font-medium text-aico-muted" htmlFor="pw-site">Site</label>
            <input id="pw-site" className="input mb-3 w-full" value={site} onChange={e => setSite(e.target.value)} placeholder="https://example.com" autoFocus />
          </>
        )}
        <label className="mb-1 block text-[12px] font-medium text-aico-muted" htmlFor="pw-user">Username</label>
        <input id="pw-user" className="input mb-3 w-full" value={username} onChange={e => setUsername(e.target.value)} autoFocus={Boolean(item)} />
        <label className="mb-1 block text-[12px] font-medium text-aico-muted" htmlFor="pw-pass">Password</label>
        <div className="mb-3 flex gap-2">
          <input id="pw-pass" className="input min-w-0 flex-1 font-mono" type={show ? 'text' : 'password'} value={password} onChange={e => { setPassword(e.target.value); setError(''); }} />
          <button type="button" className="icon-btn" onClick={() => setShow(s => !s)} title={show ? 'Hide' : 'Show'}><Icon name={show ? 'eye-off' : 'eye'} size={15} /></button>
        </div>
        <label className="mb-1 block text-[12px] font-medium text-aico-muted" htmlFor="pw-note">Note</label>
        <textarea id="pw-note" className="input mb-1 h-16 w-full resize-none py-1.5" value={note} onChange={e => setNote(e.target.value)} />
        <div className="h-4 text-[11.5px] text-aico-danger">{error}</div>
        <div className="mt-3 flex justify-end gap-2">
          <button type="button" className="btn-outline" onClick={close}>Cancel</button>
          <button type="submit" className="btn-primary">Save</button>
        </div>
      </form>
    </Modal>
  );
}
