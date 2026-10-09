/**
 * Add a connection: one screen, four steps, no wizard.
 *
 * Provider, address, token, test. The steps are sections of one card that appear as
 * they become answerable, so a person sees where they are and can scroll back; nothing
 * is a modal chain with a Next button. The fourth step is the point of the exercise:
 * the probe's result, shown as capability chips and token permissions, so a wrong or
 * over-broad token is caught here and not when the first pull request fails.
 *
 * The token is the one secret on the page, and it is handled the way the credential
 * vault's prompt handles one (components/VaultPrompts): the input is UNCONTROLLED, so
 * React, the store and a devtools snapshot never hold what is typed; it is read once on
 * submit, emptied before the request goes out, posted write-only to the credential
 * route, and never returned. `autocomplete="new-password"` keeps a browser from filling
 * it. A failed save asks for the token again rather than keeping it to retry with.
 *
 * Creating the connection and storing its token are two requests (the engine's routes
 * are separate, each a person's act). If the first succeeds and a later one fails, the
 * connection is kept and the form locks its address, so the retry repeats only what
 * failed; "Cancel" removes a connection that never got a token.
 *
 * What it does not do: offer a provider the engine cannot talk to (those tiles are
 * disabled with their note), accept an http address that is not a private one, or skip
 * TLS verification. A private CA is a PEM file path, applied by the engine to this
 * connection only.
 *
 * @module web/components/connections/AddConnection
 */

import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import { api } from '../../api';
import type { Connection, ConnectionsPolicyView, ProviderId, ProviderInfo } from '../../../../shared/connections/types';
import {
  asksForAccount, asksForUrl, checkBaseUrl, defaultLabel, hostAllowed, policyView, probeVerdict, providerInfo, providerTiles, serverSwitchLabel,
  tokenPageUrl, validateConnectionForm, wantsHttpOptIn, type ConnectionForm, type FormField,
} from '../../connections';
import { BTN_GHOST, BTN_PRIMARY, Callout, ErrorLine, INPUT, LABEL, Spinner } from '../delivery/ui';
import { parseAzureOrg } from '../../connections-azure';
import { ExternalLink, Monogram, ProbePanel } from './parts';

const EMPTY_FORM: Omit<ConnectionForm, 'provider'> = { label: '', serverUrl: false, baseUrl: '', insecureHttp: false, caBundle: '', username: '' };

export function AddConnection({ providers, policy, projectName, initialProvider, onChanged, onUse, onCancel, onDone, policyShownAbove, onAskConnector }: {
  providers: readonly ProviderInfo[];
  policy: ConnectionsPolicyView | undefined;
  /** The page around this form already shows the organisation banner; do not repeat it. */
  policyShownAbove?: boolean;
  /** The project this connection is for, when the page knows one; enables "Use for this project". */
  projectName?: string | undefined;
  initialProvider?: ProviderId | undefined;
  /** A connection was created or changed: the page folds it into its list. */
  onChanged: (c: Connection) => void;
  onUse?: ((c: Connection) => void) | undefined;
  /** Cancel; the connection that never got a token (if any) is removed first. */
  onCancel: (removed?: string) => void;
  onDone: (c: Connection) => void;
  /** "Other": open a chat that asks AICO to build a connector for a platform it has no adapter for. */
  onAskConnector?: (() => void) | undefined;
}): React.ReactElement {
  const uid = useId();
  const [provider, setProvider] = useState<ProviderId | null>(initialProvider ?? null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [created, setCreated] = useState<Connection | null>(null);
  const [tested, setTested] = useState<Connection | null>(null);
  const [step, setStep] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [errors, setErrors] = useState<Partial<Record<FormField | 'token', string>>>({});
  const token = useRef<HTMLInputElement>(null);
  const result = useRef<HTMLDivElement>(null);
  const pol = policyView(policy);
  const info = provider ? providerInfo(provider, providers) : undefined;
  const tiles = useMemo(() => providerTiles(providers, policy), [providers, policy]);
  const full: ConnectionForm | null = provider ? { provider, ...form } : null;
  const asksUrl = Boolean(full && asksForUrl(info, full));
  const working = step !== null;
  const locked = created !== null;
  const switchLabel = provider ? serverSwitchLabel(provider) : null;
  const optIn = asksUrl && wantsHttpOptIn(form.baseUrl);
  const now = Date.now();

  useEffect(() => { if (tested) result.current?.focus({ preventScroll: false }); }, [tested]);

  const set = (patch: Partial<typeof form>): void => { setForm(f => ({ ...f, ...patch })); setErrors({}); };
  const wipe = (): void => { if (token.current) token.current.value = ''; };

  // Azure DevOps Services: the organization is part of the address, so the page asks for its name (not a URL).
  const azureServices = provider === 'azure-devops' && !form.serverUrl;
  const azureOrg = azureServices ? parseAzureOrg(form.organization ?? '') : null;
  const helpUrl = ((): string | undefined => {
    if (azureServices) return azureOrg?.ok ? `https://dev.azure.com/${azureOrg.org}/_usersSettings/tokens` : info?.tokenHelpUrl;
    if (info && (form.serverUrl || (info.asksUrl && !info.cloudUrl))) {
      // A server a person runs: the token page lives on that server (GitHub Enterprise, self-managed GitLab, Gitea, Forgejo).
      const u = checkBaseUrl(form.baseUrl, form.insecureHttp);
      return u.ok ? tokenPageUrl(info.id, u.url) ?? undefined : undefined;
    }
    return info?.tokenHelpUrl;
  })();

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    if (!full || working) return;
    setError(null);
    // Read from the DOM, never from state. It stays in the field through validation and the
    // create request (so a typo in the address does not cost a re-paste) and is emptied the
    // moment before the request that carries it.
    const typed = token.current?.value.trim() ?? '';
    let current = created;
    if (!current) {
      const check = validateConnectionForm(full, info);
      const next: Partial<Record<FormField | 'token', string>> = { ...check.errors };
      if (check.ok && check.body) {
        const host = check.body.baseUrl ? new URL(check.body.baseUrl).host : info?.cloudUrl ? new URL(info.cloudUrl).host : '';
        if (host && !hostAllowed(policy, host)) next.baseUrl = `Your organization does not allow connections to ${host}.`;
      }
      if (!typed) next.token = 'Paste the access token.';
      if (Object.keys(next).length) { setErrors(next); return; }
      try {
        setStep('Creating the connection…');
        current = await api.connectionCreate(check.body!);
        setCreated(current); onChanged(current);
      } catch (x) { setError(x instanceof Error ? x.message : String(x)); setStep(null); return; }
    } else if (!typed && !current.hasCredential) {
      setErrors({ token: 'Paste the access token.' });
      return;
    }
    try {
      if (typed) {
        setStep('Saving the token…');
        wipe();
        current = await api.connectionCredential(current.id, typed);
        setCreated(current); onChanged(current);
      }
    } catch (x) {
      setError(`Could not save the token: ${x instanceof Error ? x.message : String(x)}. Paste it again to retry.`);
      setStep(null);
      return;
    }
    try {
      setStep('Testing the connection…');
      const t = await api.connectionTest(current.id);
      setCreated(t); setTested(t); onChanged(t);
    } catch (x) {
      setError(`The token is saved, but the test failed: ${x instanceof Error ? x.message : String(x)}`);
    } finally { setStep(null); }
  };

  const cancel = async (): Promise<void> => {
    wipe();
    if (created && !created.hasCredential) {
      try { await api.connectionRemove(created.id); onCancel(created.id); return; } catch { /* it stays in the list as "needs attention" */ }
    }
    onCancel();
  };

  const verdict = tested?.probe ? probeVerdict(tested.probe) : null;
  const err = (f: FormField | 'token'): string | undefined => errors[f];

  return (
    <section aria-label="Add a connection" className="rounded-xl border border-aico-border-subtle bg-aico-surface p-4 sm:p-5">
      <form onSubmit={e => void submit(e)} noValidate autoComplete="off" className="space-y-6">
        {pol.banner && !policyShownAbove && <Callout tone="warning">{pol.banner}</Callout>}

        {/* 1 Provider */}
        <fieldset disabled={locked || working}>
          <Heading n={1} id={`${uid}-h1`}>Where does your team keep its code?</Heading>
          <div role="radiogroup" aria-labelledby={`${uid}-h1`} className="mt-2.5 grid grid-cols-2 gap-2 sm:grid-cols-4">
            {tiles.map(t => {
              const on = provider === t.id;
              return (
                <button
                  key={t.id} type="button" role="radio" aria-checked={on} aria-disabled={!t.enabled || locked} title={t.note}
                  onClick={() => { if (t.enabled && !locked && t.id === 'other') onAskConnector?.(); else if (t.enabled && !locked && t.id !== 'other') { setProvider(t.id); setForm(EMPTY_FORM); setErrors({}); setError(null); } }}
                  className={`flex min-h-[78px] flex-col items-start gap-1.5 rounded-lg border px-3 py-2.5 text-left transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-aico-accent ${
                    on ? 'border-aico-accent bg-aico-accent-soft' : t.enabled && !locked ? 'border-aico-border-subtle bg-aico-bg hover:bg-aico-hover' : 'cursor-not-allowed border-aico-border-subtle bg-aico-bg opacity-60'}`}
                >
                  <span className="flex items-center gap-2"><Monogram provider={t.id} size={24} /><span className="text-[13px] font-medium text-aico-primary">{t.label}</span></span>
                  {t.note && <span className="text-[11.5px] leading-snug text-aico-muted">{t.note}</span>}
                </button>
              );
            })}
          </div>
        </fieldset>

        {provider && info && (
          <>
            {/* 2 Address */}
            <fieldset disabled={locked || working}>
              <Heading n={2} id={`${uid}-h2`}>Address</Heading>
              <div className="mt-2.5 space-y-3">
                {switchLabel && (
                  <label className="flex cursor-pointer items-center gap-2 text-[13px] text-aico-primary">
                    <input type="checkbox" className="accent-[var(--aico-accent)]" checked={form.serverUrl} onChange={e => set({ serverUrl: e.target.checked, baseUrl: '' })} />
                    I use {switchLabel} (a server my company runs)
                  </label>
                )}
                {azureServices ? (
                  <div>
                    <label className={LABEL} htmlFor={`${uid}-org`}>Organization</label>
                    <div className="flex items-center gap-2">
                      <span className="shrink-0 text-[13px] text-aico-muted">dev.azure.com/</span>
                      <input
                        id={`${uid}-org`} className={INPUT} value={form.organization ?? ''} onChange={e => set({ organization: e.target.value })}
                        placeholder="acme" autoComplete="off" spellCheck={false}
                        aria-invalid={Boolean(err('baseUrl'))} aria-describedby={`${uid}-org-note`}
                      />
                    </div>
                    <p id={`${uid}-org-note`} role={err('baseUrl') ? 'alert' : undefined} className={`mt-1 text-[12px] ${err('baseUrl') ? 'text-aico-danger' : 'text-aico-muted'}`}>
                      {err('baseUrl') ?? 'The name after dev.azure.com/ in your project’s address. You can paste the whole address too.'}
                    </p>
                  </div>
                ) : asksUrl ? (
                  <div>
                    <label className={LABEL} htmlFor={`${uid}-url`}>Server address</label>
                    <input
                      id={`${uid}-url`} className={INPUT} value={form.baseUrl} onChange={e => set({ baseUrl: e.target.value })}
                      placeholder={provider === 'azure-devops' ? 'https://tfs.example.com/DefaultCollection' : 'https://git.example.com'} inputMode="url" autoComplete="off" spellCheck={false}
                      aria-invalid={Boolean(err('baseUrl'))} aria-describedby={err('baseUrl') ? `${uid}-url-err` : undefined}
                    />
                    {err('baseUrl') && <p id={`${uid}-url-err`} role="alert" className="mt-1 text-[12px] text-aico-danger">{err('baseUrl')}</p>}
                  </div>
                ) : (
                  <div>
                    <label className={LABEL} htmlFor={`${uid}-cloud`}>Address</label>
                    <input id={`${uid}-cloud`} className={`${INPUT} bg-aico-surface text-aico-secondary`} value={info.cloudUrl ?? ''} readOnly aria-readonly="true" />
                  </div>
                )}
                <div>
                  <label className={LABEL} htmlFor={`${uid}-label`}>Name <span className="font-normal text-aico-muted">(optional)</span></label>
                  <input
                    id={`${uid}-label`} className={INPUT} value={form.label} onChange={e => set({ label: e.target.value })}
                    placeholder={defaultLabel(info, azureServices ? (azureOrg?.ok ? azureOrg.baseUrl : '') : form.baseUrl)} autoComplete="off" aria-invalid={Boolean(err('label'))}
                  />
                  {err('label') && <p role="alert" className="mt-1 text-[12px] text-aico-danger">{err('label')}</p>}
                </div>
                {provider && asksForAccount(provider) && (
                  <div>
                    <label className={LABEL} htmlFor={`${uid}-account`}>Atlassian account email <span className="font-normal text-aico-muted">(API token only)</span></label>
                    <input
                      id={`${uid}-account`} className={INPUT} value={form.username ?? ''} onChange={e => set({ username: e.target.value })}
                      placeholder="you@company.com" inputMode="email" autoComplete="off" spellCheck={false} aria-invalid={Boolean(err('username'))}
                    />
                    <p className={`mt-1 text-[12px] ${err('username') ? 'text-aico-danger' : 'text-aico-muted'}`} role={err('username') ? 'alert' : undefined}>
                      {err('username') ?? 'An Atlassian API token is used with your account email. Leave this empty for a repository, project or workspace access token.'}
                    </p>
                  </div>
                )}
                {asksUrl && (
                  <details open={optIn || Boolean(err('insecureHttp')) || Boolean(err('caBundle'))} className="rounded-lg border border-aico-border-subtle">
                    <summary className="cursor-pointer select-none rounded-lg px-3 py-2 text-[13px] text-aico-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-aico-accent">Private network options</summary>
                    <div className="space-y-3 border-t border-aico-border-subtle px-3 py-3">
                      <div>
                        <label className={LABEL} htmlFor={`${uid}-ca`}>CA bundle for a private certificate authority</label>
                        <input
                          id={`${uid}-ca`} className={`${INPUT} font-mono`} value={form.caBundle} onChange={e => set({ caBundle: e.target.value })}
                          placeholder="C:\certs\company-ca.pem" autoComplete="off" spellCheck={false} aria-invalid={Boolean(err('caBundle'))}
                        />
                        <p className={`mt-1 text-[12px] ${err('caBundle') ? 'text-aico-danger' : 'text-aico-muted'}`} role={err('caBundle') ? 'alert' : undefined}>
                          {err('caBundle') ?? 'The path of a PEM file. It is trusted for this connection only. Certificate checks are never turned off.'}
                        </p>
                      </div>
                      <div>
                        <label className="flex cursor-pointer items-start gap-2 text-[13px] text-aico-primary">
                          <input type="checkbox" className="mt-0.5 accent-[var(--aico-accent)]" checked={form.insecureHttp} onChange={e => set({ insecureHttp: e.target.checked })} />
                          <span>Allow plain http for this private address<span className="block text-[12px] text-aico-muted">Only for an address on your own network. Anything sent travels unencrypted.</span></span>
                        </label>
                        {err('insecureHttp') && <p role="alert" className="mt-1 text-[12px] text-aico-danger">{err('insecureHttp')}</p>}
                      </div>
                    </div>
                  </details>
                )}
              </div>
            </fieldset>

            {/* 3 Token */}
            <fieldset disabled={working}>
              <Heading n={3} id={`${uid}-h3`}>Access token</Heading>
              <div className="mt-2.5 grid gap-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
                <div>
                  <label className={LABEL} htmlFor={`${uid}-token`}>Paste a token</label>
                  <input
                    id={`${uid}-token`} ref={token} type="password" autoComplete="new-password" spellCheck={false} data-lpignore="true" data-form-type="other"
                    className={`${INPUT} font-mono`} aria-invalid={Boolean(err('token'))} aria-describedby={`${uid}-token-note`}
                  />
                  <p id={`${uid}-token-note`} className={`mt-1.5 text-[12px] leading-snug ${err('token') ? 'text-aico-danger' : 'text-aico-muted'}`} role={err('token') ? 'alert' : undefined}>
                    {err('token') ?? 'It goes straight into AICO\u2019s encrypted vault, bound to this address. The agent never sees it, and this page does not keep it.'}
                  </p>
                </div>
                <div>
                  <p className="mb-1 text-[12px] font-medium text-aico-secondary">Give it only these permissions</p>
                  <ul className="space-y-1 text-[12.5px] leading-snug text-aico-secondary">
                    {info.tokenAdvice.map(a => <li key={a} className="flex gap-2"><span className="mt-[7px] h-1 w-1 shrink-0 rounded-full bg-aico-muted" aria-hidden="true" />{a}</li>)}
                  </ul>
                  {helpUrl && <p className="mt-2 text-[12.5px]"><ExternalLink href={helpUrl}>Create a token on {info.label}</ExternalLink></p>}
                </div>
              </div>
            </fieldset>

            {error && <ErrorLine>{error}</ErrorLine>}
            {step && <p role="status" className="flex items-center gap-2 text-[13px] text-aico-secondary"><Spinner />{step}</p>}

            <div className="flex flex-wrap items-center gap-2">
              <button type="submit" className={BTN_PRIMARY} disabled={working || pol.forbidden}>
                {working ? <Spinner /> : null}{created ? 'Save token and test' : 'Connect and test'}
              </button>
              <button type="button" className={BTN_GHOST} disabled={working} onClick={() => void cancel()}>Cancel</button>
            </div>
          </>
        )}

        {!provider && (
          <div className="flex gap-2"><button type="button" className={BTN_GHOST} onClick={() => void cancel()}>Cancel</button></div>
        )}

        {/* 4 Test */}
        {tested && (
          <section aria-labelledby={`${uid}-h4`} className="border-t border-aico-border-subtle pt-5">
            <div ref={result} tabIndex={-1} className="outline-none">
              <Heading n={4} id={`${uid}-h4`}>Test result</Heading>
              <div className="mt-2.5"><ProbePanel connection={tested} now={now} /></div>
              <div className="mt-4 flex flex-wrap items-center gap-2">
                {verdict?.usable && onUse && projectName && (
                  <button type="button" className={BTN_PRIMARY} onClick={() => onUse(tested)}>Use for {projectName}</button>
                )}
                <button type="button" className={verdict?.usable && onUse && projectName ? BTN_GHOST : BTN_PRIMARY} onClick={() => onDone(tested)}>
                  {verdict?.usable ? 'Done' : 'Keep for now'}
                </button>
                {!verdict?.usable && <span className="text-[12.5px] text-aico-secondary">Paste a corrected token above and test again.</span>}
              </div>
            </div>
          </section>
        )}
      </form>
    </section>
  );
}

function Heading({ n, id, children }: { n: number; id: string; children: React.ReactNode }): React.ReactElement {
  return (
    <h4 id={id} className="flex items-center gap-2 text-[14px] font-semibold text-aico-primary">
      <span aria-hidden="true" className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-aico-hover text-[11px] font-medium tabular-nums text-aico-secondary">{n}</span>
      {children}
    </h4>
  );
}
