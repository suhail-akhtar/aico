/**
 * "New SSH terminal…": pick a stored credential by name and a host; main
 * makes the connection (terminal-ssh.ts).
 *
 * This window never holds a secret: it lists credential metadata (name,
 * kind, user, host) and sends main a name. An unknown host key, and any
 * approval the credential's policy asks for, are native dialogs in main.
 *
 * @module desktop/renderer/ide/TerminalSshDialog
 */

import React, { useEffect, useMemo, useState } from 'react';
import { Modal } from '@/shell/Modal';
import { desktop, invoke, type CredentialView } from '@/desktop';
import { Icon } from '@/lib/icons';
import { useDesk } from '@/state/desk';

const SSH_KINDS = new Set(['ssh-password', 'ssh-key', 'login', 'basic-auth', 'generic']);

export interface SshOpened { id: string; title: string; cwd: string; owner: 'ssh'; ssh?: { host: string; port: number; user: string } }

export function TerminalSshDialog({ open, onClose, onOpened }: {
  open: boolean; onClose: () => void; onOpened: (t: SshOpened) => void;
}): React.ReactElement | null {
  const [creds, setCreds] = useState<CredentialView[] | null>(null);
  const [loadError, setLoadError] = useState('');
  const [name, setName] = useState('');
  const [host, setHost] = useState('');
  const [port, setPort] = useState('');
  const [user, setUser] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) return;
    setError(''); setBusy(false);
    desktop.vault.list().then(list => setCreds(list.filter(c => SSH_KINDS.has(c.kind) && !c.quarantined)))
      .catch((e: Error) => { setCreds([]); setLoadError(e.message); });
  }, [open]);

  const chosen = useMemo(() => creds?.find(c => c.name === name), [creds, name]);
  useEffect(() => {
    if (!chosen) return;
    if (chosen.host) setHost(chosen.host);
    setPort(chosen.port ? String(chosen.port) : '');
  }, [chosen]);

  const connect = async (): Promise<void> => {
    setBusy(true); setError('');
    const r = await invoke<{ ok: boolean; error?: string } & SshOpened>('term:ssh:create', {
      credential: name, host: host.trim(), ...(port.trim() ? { port: Number(port) } : {}), ...(user.trim() ? { user: user.trim() } : {}),
      cols: 110, rows: 28,
    }).catch((e: Error) => ({ ok: false, error: e.message } as { ok: boolean; error?: string } & SshOpened));
    setBusy(false);
    if (!r.ok) { setError(r.error ?? 'Could not connect.'); return; }
    onOpened(r);
    onClose();
  };

  if (!open) return null;
  return (
    <Modal open={open} onClose={onClose} title="New SSH terminal" width={500}>
      <div className="space-y-3 px-5 pb-5 pt-2 text-[13px]">
        <p className="text-aico-secondary">
          Sign in with a credential from your vault. AICO sends it straight to the server; this window, the chat and the agent never see it.
          A new server's host key is shown for you to check before anything is sent.
        </p>
        {creds && creds.length === 0 && (
          <div className="rounded-lg border border-aico-border-subtle bg-aico-hover/50 p-3 text-aico-secondary">
            {loadError ? `The vault could not be read: ${loadError}` : 'No SSH-capable credentials in the vault yet.'}{' '}
            <button className="text-aico-accent hover:underline" onClick={() => { onClose(); useDesk.getState().openSettings('credentials'); }}>Add one in the Credential Manager</button>
          </div>
        )}
        <label className="block">
          <span className="mb-1 block text-[12px] text-aico-muted">Credential</span>
          <select className="input w-full" value={name} onChange={e => setName(e.target.value)} disabled={!creds?.length}>
            <option value="">{creds === null ? 'Loading…' : 'Choose a credential'}</option>
            {creds?.map(c => (
              <option key={c.id} value={c.name}>{c.name} · {c.kind}{c.username ? ` · ${c.username}` : ''}{c.host ? ` @ ${c.host}` : ''}</option>
            ))}
          </select>
        </label>
        <div className="flex gap-2">
          <label className="block flex-1">
            <span className="mb-1 block text-[12px] text-aico-muted">Host</span>
            <input className="input w-full" value={host} onChange={e => setHost(e.target.value)} placeholder="10.0.0.5 or server.example.com" spellCheck={false} />
          </label>
          <label className="block w-24">
            <span className="mb-1 block text-[12px] text-aico-muted">Port</span>
            <input className="input w-full" value={port} onChange={e => setPort(e.target.value.replace(/[^\d]/g, ''))} placeholder="22" inputMode="numeric" />
          </label>
        </div>
        <label className="block">
          <span className="mb-1 block text-[12px] text-aico-muted">User</span>
          <input className="input w-full" value={user} onChange={e => setUser(e.target.value)} placeholder={chosen?.username ?? 'from the credential'} spellCheck={false} />
        </label>
        {error && <div className="flex gap-2 rounded-lg border border-aico-danger/40 bg-aico-danger/10 p-2.5 text-[12.5px] text-aico-danger"><Icon name="alert" size={14} className="mt-0.5 shrink-0" /><span>{error}</span></div>}
        <div className="flex items-center justify-end gap-2 pt-1">
          {busy && <span className="mr-auto text-[12px] text-aico-muted">Connecting… a host-key or approval dialog may appear.</span>}
          <button className="btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn-primary" disabled={busy || !name || !host.trim()} onClick={() => void connect()}>
            <Icon name="terminal" size={14} />Connect
          </button>
        </div>
      </div>
    </Modal>
  );
}
