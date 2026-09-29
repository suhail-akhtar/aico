/**
 * The password manager in the browser chrome: "Save password?" after you sign
 * in, and the key in the address bar that fills a saved login into the page.
 *
 * Neither ever holds a password. The offer names the site and the account;
 * the password waits in main and is saved there if you say so. The key lists
 * the usernames saved for this exact site, and picking one asks main to fill
 * it — main checks the origin again and sends the login to the page itself.
 *
 * @module desktop/renderer/browser/PasswordsBar
 */

import React, { useEffect, useState } from 'react';
import { create } from 'zustand';
import { on } from '@/desktop';
import { Icon } from '@/lib/icons';
import { cls } from '@/lib/util';
import { toast, useDesk } from '@/state/desk';
import { MenuItem, MenuSep, Popover } from '@/shell/Popover';
import type { VaultForPage, VaultOffer } from '@desk/browser-types';
import { call } from './ipc';
import { hostOf } from './urls';
import { showInternal, useActiveTab } from './store';
import { usePageSignals } from './useSuggestions';

interface VaultUi {
  offers: VaultOffer[];
  /** Bumped whenever the saved passwords change, so the key re-reads. */
  rev: number;
}

export const useVaultUi = create<VaultUi>(() => ({ offers: [], rev: 0 }));

/** The browser's Passwords page, from anywhere (a menu, Settings, the chooser's "Manage passwords…"). */
export function openPasswords(): void {
  const d = useDesk.getState();
  if (d.settings) d.closeSettings();
  if (d.route.view !== 'browser') d.navigate({ view: 'browser' });
  setTimeout(() => showInternal('passwords'), 0);
}

let installed = false;
/** Main's password events, subscribed once for the window. */
export function installVaultEvents(): void {
  if (installed) return;
  installed = true;
  on<VaultOffer>('browser:vault:offer', (o) => {
    if (o.unavailable) {
      toast.info('Passwords are not saved on this computer', o.unavailable);
      return;
    }
    useVaultUi.setState(s => ({ offers: [...s.offers.filter(x => x.tabId !== o.tabId), o] }));
  });
  on<string>('browser:vault:offerGone', (id) => useVaultUi.setState(s => ({ offers: s.offers.filter(x => x.id !== id) })));
  on('browser:vault:changed', () => useVaultUi.setState(s => ({ rev: s.rev + 1 })));
  on('browser:vault:manage', () => openPasswords());
}

/** "Save password for example.com?" — under the toolbar, over nothing (the page moves down). */
export function SavePasswordBar(): React.ReactElement | null {
  const tab = useActiveTab();
  const offer = useVaultUi(s => s.offers.find(o => o.tabId === tab?.id));
  if (!offer) return null;
  const answer = (a: 'save' | 'never' | 'dismiss'): void => {
    useVaultUi.setState(s => ({ offers: s.offers.filter(x => x.id !== offer.id) }));
    void call<boolean>('browser:vault:answer', offer.id, a).then((done) => {
      if (done && a === 'save') toast.success(offer.update ? 'Password updated' : 'Password saved', `${hostOf(offer.origin)}${offer.username ? ` · ${offer.username}` : ''}`);
      if (done && a === 'never') toast.info('AICO won’t offer to save passwords for this site', 'Change it on the Passwords page.');
    }).catch((e: Error) => toast.error('Could not save the password', e.message));
  };
  return (
    <div className="bx-bar bg-aico-bg" role="alertdialog" aria-label="Save password">
      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-aico-accent-soft text-aico-accent"><Icon name="key" size={14} /></span>
      <span className="min-w-0 flex-1 truncate">
        {offer.update ? 'Update the saved password for ' : 'Save password for '}
        <b className="font-medium">{offer.username || 'this account'}</b> on <b className="font-medium">{hostOf(offer.origin)}</b>?
        <span className="ml-2 text-[12px] text-aico-muted">Kept encrypted on this computer — never shown to AICO’s agent.</span>
      </span>
      {!offer.update && <button className="btn-ghost btn-sm" onClick={() => answer('never')}>Never for this site</button>}
      <button className="btn-outline btn-sm" onClick={() => answer('dismiss')}>Not now</button>
      <button className="btn-primary btn-sm" onClick={() => answer('save')}>{offer.update ? 'Update' : 'Save'}</button>
    </div>
  );
}

/** The key in the address bar: shown on a page with a sign-in form, or with logins saved for it. */
export function PasswordKey(): React.ReactElement | null {
  const tab = useActiveTab();
  const signals = usePageSignals();
  const rev = useVaultUi(s => s.rev);
  const [page, setPage] = useState<VaultForPage | null>(null);
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  const url = tab?.url ?? '';
  const loading = Boolean(tab?.loading);
  useEffect(() => {
    if (!/^https?:/i.test(url)) { setPage(null); return; }
    let live = true;
    void call<VaultForPage | null>('browser:vault:forPage').then(p => { if (live) setPage(p ?? null); }).catch(() => { if (live) setPage(null); });
    return () => { live = false; };
  }, [url, rev, loading]);
  const hasLogin = Boolean(signals && signals.url === url && signals.fields.password > 0);
  if (!page || page.origin !== safeOrigin(url) || (!page.entries.length && !hasLogin)) return null;
  const fill = (id: string): void => {
    setOpen(false);
    void call<number>('browser:vault:fill', id).catch((e: Error) => toast.error('Could not fill the password', e.message));
  };
  const saved = page.entries.length;
  return (
    <>
      <button ref={setAnchor} className={cls('icon-btn-sm h-6 w-6 shrink-0', saved ? 'text-aico-accent' : 'text-aico-muted', open && 'bg-aico-hover')}
        onMouseDown={e => e.preventDefault()} onClick={() => setOpen(o => !o)} aria-label="Saved passwords"
        title={saved ? `${saved} saved password${saved === 1 ? '' : 's'} for this site` : 'No saved password for this site'}>
        <Icon name="key" size={14} />
      </button>
      <Popover anchor={anchor} open={open} onClose={() => setOpen(false)} placement="bottom-end" width={280}>
        <div className="px-2.5 pb-1 pt-1.5 text-[11.5px] font-medium text-aico-muted">Saved passwords for {hostOf(page.origin)}</div>
        {!page.available && <div className="px-2.5 py-1.5 text-[12.5px] text-aico-muted">Passwords cannot be stored on this computer.</div>}
        {page.available && !saved && <div className="px-2.5 py-1.5 text-[12.5px] text-aico-muted">None yet. Sign in and AICO offers to save it.</div>}
        {page.available && saved > 0 && !page.secure && <div className="px-2.5 py-1.5 text-[12.5px] text-aico-warning">This page is not secure (http): passwords are not filled here.</div>}
        {page.secure && page.entries.map(e => (
          <MenuItem key={e.id} icon="user" label={e.username || '(no username)'} hint="Fill" onClick={() => fill(e.id)} />
        ))}
        <MenuSep />
        <MenuItem icon="key" label="Manage passwords…" onClick={() => { setOpen(false); showInternal('passwords'); }} />
      </Popover>
    </>
  );
}

function safeOrigin(url: string): string {
  try { return new URL(url).origin; } catch { return ''; }
}

