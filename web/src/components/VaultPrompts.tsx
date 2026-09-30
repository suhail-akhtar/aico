/**
 * The credential vault's prompts in the browser client and the VS Code panel:
 * a secure prompt when the agent asks for a credential, an approval card when
 * a stored credential's use needs a person's yes, and a notice when a secret
 * pasted into a message was moved into the vault.
 *
 * Why it is careful the way it is:
 *
 *  - **The value never enters application state.** The inputs are
 *    uncontrolled (`ref`s, not `useState`), so React, the store, a devtools
 *    snapshot and a draft saver never hold what is typed. On submit it is read
 *    once, posted write-only to `/api/vault/fulfil`, and the inputs are
 *    emptied. `type=password`, `autocomplete=off`, no spell-check.
 *  - **Approving is a person's act, not a token's.** A standalone server
 *    accepts a yes only with the grant passphrase (the API token may be known
 *    to the model: credential-broker.md §5), so the card asks for it; declining
 *    needs nothing. In AICO Desktop both prompts are the desktop's own native
 *    windows, and these stay hidden (`hostPrompt` / `needs: 'desktop'`).
 *
 * @module components/VaultPrompts
 */

import React, { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { useStore } from '../store';

const FIELD_LABEL: Record<string, string> = {
  password: 'Password', totpSeed: 'TOTP seed', privateKey: 'Private key', passphrase: 'Passphrase', token: 'Token',
  community: 'Community string', authKey: 'Auth key', privKey: 'Privacy key', connectionString: 'Connection string',
  pfx: 'PFX (base64)', text: 'Note', value: 'Value',
};
const MULTILINE = new Set(['privateKey', 'pfx', 'text']);

export function VaultPrompts(): React.ReactElement | null {
  const sessionId = useStore(s => s.sessionId);
  const syncVault = useStore(s => s.syncVault);
  // A reload while the agent waits must bring the prompt back, not leave the turn stuck.
  useEffect(() => { void syncVault(); }, [sessionId, syncVault]);
  return (
    <>
      <VaultNotice />
      <ApprovalCard />
      <CredentialRequestDialog />
    </>
  );
}

/** "I stored that as github-token and removed it from the message." */
export function VaultNotice(): React.ReactElement | null {
  const notice = useStore(s => s.vaultNotice);
  const clear = useStore(s => s.clearVault);
  if (!notice) return null;
  const names = notice.items.map(i => i.name);
  return (
    <div role="status" className="mx-auto mb-2 flex w-full max-w-column items-start gap-2 rounded-xl border border-aico-border-subtle bg-aico-elevated px-3 py-2 text-[12.5px] text-aico-secondary">
      <span aria-hidden className="mt-0.5">🔒</span>
      <span className="min-w-0 flex-1">
        {names.length > 0 && <>I stored {names.length === 1 ? 'that' : 'those'} as {names.map((n, i) => <React.Fragment key={n}>{i ? ', ' : ''}<code className="font-mono text-aico-primary">{n}</code></React.Fragment>)} and removed {names.length === 1 ? 'it' : 'them'} from the message. The agent can use {names.length === 1 ? 'it' : 'them'} by name but never sees the value.</>}
        {notice.dropped > 0 && <> {notice.dropped} secret{notice.dropped === 1 ? '' : 's'} could not be stored and {notice.dropped === 1 ? 'was' : 'were'} removed from the message instead.</>}
      </span>
      <button className="text-aico-muted hover:text-aico-primary" onClick={() => clear('notice')} aria-label="Dismiss">✕</button>
    </div>
  );
}

function ApprovalCard(): React.ReactElement | null {
  const approval = useStore(s => s.vaultApproval);
  const clear = useStore(s => s.clearVault);
  const pass = useRef<HTMLInputElement>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { setErr(''); }, [approval?.id]);
  if (!approval) return null;
  const answer = async (approve: boolean, scope?: 'once' | 'session'): Promise<void> => {
    setBusy(true);
    setErr('');
    const passphrase = pass.current?.value ?? '';
    if (pass.current) pass.current.value = '';
    try {
      if (approve && !passphrase) { setErr('Type the vault\'s grant passphrase to allow it.'); return; }
      await api.vaultApprove(approval.id, approve, approve ? { passphrase, ...(scope ? { scope } : {}) } : {});
      clear('approval');
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  };
  return (
    <div role="alertdialog" aria-label="Use a stored credential?" className="mx-auto mb-3 w-full max-w-column rounded-xl border border-aico-warning/40 bg-aico-elevated px-4 py-3">
      <p className="text-[14px] text-aico-primary">The agent wants to use <strong className="font-mono">{approval.credential.name}</strong>.</p>
      <dl className="mt-1 grid grid-cols-[88px_1fr] gap-x-2 text-[12.5px] text-aico-secondary">
        <dt className="text-aico-muted">Tool</dt><dd className="font-mono">{approval.tool}</dd>
        <dt className="text-aico-muted">Where</dt><dd className="break-all">{approval.target ?? 'not stated — only allow if you are sure'}</dd>
        <dt className="text-aico-muted">To</dt><dd className="break-words">{approval.purpose}</dd>
      </dl>
      <form className="mt-2 flex flex-wrap items-center gap-2" onSubmit={e => { e.preventDefault(); void answer(true, 'once'); }} autoComplete="off">
        <input ref={pass} type="password" autoComplete="off" spellCheck={false} aria-label="Grant passphrase" placeholder="Grant passphrase"
          className="min-w-[180px] flex-1 rounded-lg border border-aico-border-subtle bg-transparent px-2.5 py-1 text-[13px] text-aico-primary outline-none focus:border-aico-accent" />
        <button type="submit" disabled={busy} className="rounded-lg bg-aico-accent px-3 py-1 text-[13px] text-aico-on-accent hover:bg-aico-accent-hover">Allow once</button>
        {approval.mode === 'session' && (
          <button type="button" disabled={busy} onClick={() => void answer(true, 'session')} className="rounded-lg border border-aico-border-subtle px-3 py-1 text-[13px] text-aico-primary hover:bg-aico-hover">Allow for this session</button>
        )}
        <button type="button" disabled={busy} onClick={() => void answer(false)} className="rounded-lg px-3 py-1 text-[13px] text-aico-secondary hover:bg-aico-hover hover:text-aico-primary">Deny</button>
      </form>
      <p className="mt-1.5 text-[11.5px] text-aico-muted">
        The value is sent by AICO itself — the agent never sees it. Allowing needs the passphrase set with <code className="font-mono">aico vault grant-passphrase</code>: the API token alone cannot approve.
      </p>
      {err && <p className="mt-1 text-[12px] text-aico-danger">{err}</p>}
    </div>
  );
}

function CredentialRequestDialog(): React.ReactElement | null {
  const req = useStore(s => s.vaultRequest);
  const clear = useStore(s => s.clearVault);
  const form = useRef<HTMLFormElement>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { setErr(''); }, [req?.requestId]);
  if (!req) return null;
  const wipe = (): void => { for (const el of Array.from(form.current?.querySelectorAll('input, textarea') ?? [])) (el as HTMLInputElement).value = ''; };
  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    if (!form.current) return;
    // Read once from the DOM, never from state; emptied before anything else happens.
    const secret: Record<string, string> = {};
    let username = '';
    for (const el of Array.from(form.current.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('[data-vault-field]'))) {
      const f = el.dataset.vaultField!;
      if (f === '@username') username = el.value.trim();
      else if (el.value) secret[f] = el.value;
    }
    wipe();
    if (!Object.keys(secret).length) { setErr('Enter a value, or Decline.'); return; }
    setBusy(true);
    try {
      await api.vaultFulfil(req.requestId, secret, username || undefined);
      clear('request');
    } catch (x) {
      setErr(x instanceof Error ? x.message : String(x));
    } finally {
      for (const k of Object.keys(secret)) secret[k] = '';
      setBusy(false);
    }
  };
  const decline = async (): Promise<void> => {
    wipe();
    await api.vaultDecline(req.requestId).catch(() => {});
    clear('request');
  };
  const wantsUser = !['api-token', 'note', 'generic', 'ssh-key', 'certificate'].includes(req.kind);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" role="dialog" aria-modal="true" aria-label="The agent needs a credential">
      <form ref={form} autoComplete="off" onSubmit={e => void submit(e)} className="w-full max-w-[460px] rounded-2xl border border-aico-border-subtle bg-aico-elevated p-5 shadow-xl">
        <h2 className="text-[15px] font-semibold text-aico-primary">The agent needs a credential</h2>
        <p className="mt-1 text-[13px] text-aico-secondary">
          <strong className="font-mono">{req.name}</strong> ({req.kind}){req.url ?? req.host ? <> for <span className="break-all">{req.url ?? req.host}</span></> : null}
        </p>
        <p className="mt-1 whitespace-pre-wrap break-words text-[12.5px] text-aico-muted">Reason: {req.reason}</p>
        {wantsUser && (
          <label className="mt-3 block text-[12px] font-medium text-aico-muted">Username
            <input data-vault-field="@username" defaultValue={req.username ?? ''} autoComplete="off" spellCheck={false}
              className="mt-1 w-full rounded-lg border border-aico-border-subtle bg-transparent px-2.5 py-1.5 text-[13px] text-aico-primary outline-none focus:border-aico-accent" />
          </label>
        )}
        {req.fields.map((f, i) => (
          <label key={f} className="mt-3 block text-[12px] font-medium text-aico-muted">{FIELD_LABEL[f] ?? f}
            {MULTILINE.has(f)
              ? <textarea data-vault-field={f} rows={5} autoComplete="off" spellCheck={false} autoFocus={i === 0 && !wantsUser}
                  style={{ WebkitTextSecurity: 'disc' } as React.CSSProperties}
                  className="mt-1 w-full rounded-lg border border-aico-border-subtle bg-transparent px-2.5 py-1.5 font-mono text-[12px] text-aico-primary outline-none focus:border-aico-accent" />
              : <input data-vault-field={f} type="password" autoComplete="off" spellCheck={false} autoFocus={i === 0}
                  className="mt-1 w-full rounded-lg border border-aico-border-subtle bg-transparent px-2.5 py-1.5 font-mono text-[13px] text-aico-primary outline-none focus:border-aico-accent" />}
          </label>
        ))}
        <p className="mt-3 text-[11.5px] text-aico-muted">
          What you type goes straight into AICO’s encrypted vault, bound to that address. The agent gets only the name — never the value — and it is not kept in this page.
        </p>
        {err && <p className="mt-1 text-[12px] text-aico-danger">{err}</p>}
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" onClick={() => void decline()} className="rounded-lg px-3 py-1.5 text-[13px] text-aico-secondary hover:bg-aico-hover hover:text-aico-primary">Decline</button>
          <button type="submit" disabled={busy} className="rounded-lg bg-aico-accent px-3 py-1.5 text-[13px] text-aico-on-accent hover:bg-aico-accent-hover">Save to vault</button>
        </div>
      </form>
    </div>
  );
}
