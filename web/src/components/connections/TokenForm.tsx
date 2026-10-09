/**
 * Paste a token for a connection that already exists: the "Sign in again" path.
 *
 * A token expires, is revoked, or was never saved because the add flow was left half
 * done. Replacing it should not mean deleting the connection and losing its mappings,
 * so this is the add flow's token step on its own: same uncontrolled input (the value
 * never enters React state, is read once and emptied before the request), same
 * write-only route, then a test so the row shows the new state at once.
 *
 * What it does not do: change the connection's address or CA bundle. The engine fixes
 * both when the first token is stored, so a token cannot be pointed at another host.
 *
 * @module web/components/connections/TokenForm
 */

import React, { useId, useRef, useState } from 'react';
import { api } from '../../api';
import type { Connection } from '../../../../shared/connections/types';
import { providerInfo, tokenPageUrl } from '../../connections';
import { BTN_GHOST, BTN_PRIMARY, ErrorLine, INPUT, LABEL, Spinner } from '../delivery/ui';
import { ExternalLink } from './parts';

export function TokenForm({ connection, onSaved, onCancel }: {
  connection: Connection;
  onSaved: (c: Connection) => void;
  onCancel: () => void;
}): React.ReactElement {
  const uid = useId();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const info = providerInfo(connection.provider);
  // The provider's own page for a cloud product, else the token page of the server this connection points at.
  const tokenLink = info?.cloudUrl && new URL(info.cloudUrl).host === connection.host ? info.tokenHelpUrl : tokenPageUrl(connection.provider, connection.baseUrl) ?? undefined;

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    const typed = input.current?.value.trim() ?? '';
    if (!typed) { setError('Paste the access token.'); return; }
    if (input.current) input.current.value = '';
    setError(null); setBusy('Saving the token…');
    let saved: Connection;
    try { saved = await api.connectionCredential(connection.id, typed); }
    catch (x) { setError(`Could not save the token: ${x instanceof Error ? x.message : String(x)}. Paste it again to retry.`); setBusy(null); return; }
    try {
      setBusy('Testing the connection…');
      onSaved(await api.connectionTest(saved.id));
    } catch (x) {
      onSaved(saved);
      setError(`The token is saved, but the test failed: ${x instanceof Error ? x.message : String(x)}`);
    } finally { setBusy(null); }
  };

  return (
    <form onSubmit={e => void submit(e)} autoComplete="off" noValidate className="space-y-2.5 rounded-lg border border-aico-border-subtle bg-aico-surface p-3">
      <div>
        <label className={LABEL} htmlFor={`${uid}-token`}>New access token for {connection.label}</label>
        <input
          id={`${uid}-token`} ref={input} type="password" autoComplete="new-password" spellCheck={false} data-lpignore="true" data-form-type="other" autoFocus
          disabled={busy !== null} className={`${INPUT} font-mono`}
        />
        <p className="mt-1 text-[12px] text-aico-muted">
          It replaces the stored token and stays bound to {connection.host}.
          {tokenLink ? <> <ExternalLink href={tokenLink}>Create a token</ExternalLink></> : null}
        </p>
      </div>
      {error && <ErrorLine>{error}</ErrorLine>}
      {busy && <p role="status" className="flex items-center gap-2 text-[13px] text-aico-secondary"><Spinner />{busy}</p>}
      <div className="flex gap-2">
        <button type="submit" className={BTN_PRIMARY} disabled={busy !== null}>Save and test</button>
        <button type="button" className={BTN_GHOST} disabled={busy !== null} onClick={() => { if (input.current) input.current.value = ''; onCancel(); }}>Cancel</button>
      </div>
    </form>
  );
}
