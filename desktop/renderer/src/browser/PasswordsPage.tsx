/**
 * The browser's Passwords page — the Credential Manager, filtered to web
 * logins (settings/CredentialManager.tsx), inside the browser's chrome.
 *
 * Since 0.29 the browser keeps its passwords in AICO's one credential vault,
 * so this page is not a second manager: the same list, the same Reveal / Copy
 * (confirmed natively in main, never a value in this window), the same
 * policies. It adds only what belongs to the browser: importing a passwords
 * file from another browser, and the sites you told it never to offer saving
 * for.
 *
 * @module desktop/renderer/browser/PasswordsPage
 */

import React, { useEffect, useState } from 'react';
import { Icon } from '@/lib/icons';
import { useDesk } from '@/state/desk';
import { CredentialManager } from '@/settings/CredentialManager';
import { call } from './ipc';
import { Favicon } from './Omnibox';
import { hostOf } from './urls';
import { showInternal } from './store';
import { openImportWizard } from './ImportWizard';
import { useVaultUi } from './PasswordsBar';

export function PasswordsPage(): React.ReactElement {
  const rev = useVaultUi(s => s.rev);
  const [never, setNever] = useState<string[]>([]);
  useEffect(() => {
    let live = true;
    void call<string[]>('browser:vault:never').then(n => { if (live) setNever(n ?? []); }).catch(() => {});
    return () => { live = false; };
  }, [rev]);

  return (
    <div className="bx-chrome-page thin-scroll">
      <div className="mx-auto w-full max-w-[860px] px-8 pb-16 pt-8">
        <div className="mb-5 flex items-center gap-3">
          <Icon name="key" size={20} className="text-aico-secondary" />
          <h1 className="flex-1 text-[22px] font-semibold tracking-tight">Passwords</h1>
          <button className="btn-ghost btn-sm" onClick={() => openImportWizard({ passwords: true })}><Icon name="download" size={14} />Import from a browser…</button>
          <button className="btn-ghost btn-sm" title="Every credential, not only web logins" onClick={() => useDesk.getState().openSettings('credentials')}><Icon name="settings" size={14} />All credentials</button>
          <button className="icon-btn" onClick={() => showInternal(null)} title="Close (Esc)"><Icon name="x" size={16} /></button>
        </div>
        <CredentialManager preset="web" />
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
      </div>
    </div>
  );
}
