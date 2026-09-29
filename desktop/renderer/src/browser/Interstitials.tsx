/**
 * The pages and bar protected browsing puts in front of a page:
 *
 *   - "Deceptive site ahead" — a strong signal; the page was not loaded (or is
 *     hidden and stopped): Back to safety / Details / Continue anyway (once).
 *   - "This site doesn't support a secure connection" — HTTPS-first could not
 *     upgrade it: Continue to the site (remembered) / Go back.
 *   - The warning bar — a weaker signal, or a page you continued to.
 *
 * On a flagged page the agent only looks: main refuses its clicks and typing
 * (electron/browser-privacy.ts), so "Ask AICO why" is safe to press.
 *
 * @module desktop/renderer/browser/Interstitials
 */

import React, { useState } from 'react';
import { Icon } from '@/lib/icons';
import { cls } from '@/lib/util';
import { fire } from './ipc';
import { useActiveTab } from './store';
import { explainThreat } from './protect';
import type { TabState } from './types';

/** The page to show instead of the tab's, or null. */
export function protectPageFor(tab: TabState | undefined): 'threat' | 'https' | null {
  if (!tab) return null;
  if (tab.threat?.level === 'block' && !tab.threat.proceeded) return 'threat';
  if (tab.httpsFallback) return 'https';
  return null;
}

export function ProtectPage({ tab }: { tab: TabState }): React.ReactElement | null {
  const kind = protectPageFor(tab);
  if (kind === 'threat') return <DeceptivePage tab={tab} />;
  if (kind === 'https') return <HttpsFallbackPage tab={tab} />;
  return null;
}

function DeceptivePage({ tab }: { tab: TabState }): React.ReactElement {
  const t = tab.threat!;
  const [details, setDetails] = useState(false);
  return (
    <div className="bx-chrome-page" style={{ background: 'color-mix(in srgb, var(--aico-danger) 9%, var(--aico-bg))' }} role="alertdialog" aria-label="Deceptive site ahead">
      <div className="mx-auto flex min-h-full max-w-[620px] flex-col justify-center px-8 py-16">
        <div className="mb-5 flex h-14 w-14 items-center justify-center rounded-2xl bg-aico-danger/15 text-aico-danger"><Icon name="alert" size={30} /></div>
        <h1 className="text-[26px] font-semibold tracking-tight">Deceptive site ahead</h1>
        <p className="mt-3 text-[14px] leading-relaxed text-aico-secondary">
          <b className="font-medium text-aico-primary">{t.host}</b> may be trying to trick you into entering a password, card details or other
          personal information{t.brand ? <>, by imitating <b className="font-medium text-aico-primary">{t.brand}</b></> : null}.
          {t.stage === 'url' ? ' AICO did not load it.' : ' AICO stopped it and hid it.'}
        </p>
        <ul className="mt-3 space-y-1 text-[13px] text-aico-secondary">
          {t.reasons.slice(0, details ? 8 : 2).map(r => <li key={r.id} className="flex gap-2"><span className="text-aico-danger">•</span>{r.label}</li>)}
        </ul>
        {details && (
          <div className="mt-3 rounded-xl border border-aico-border-subtle bg-aico-bg/70 p-3 text-[12px] text-aico-muted">
            <div className="break-all font-mono text-[11.5px] selectable">{t.url}</div>
            <p className="mt-2">Checked on this device from the address{t.stage === 'page' ? ' and what the page asks for' : ''} (score {t.score}/100). No address was sent anywhere to be checked.
              AICO’s agent will not click or type on this page, even if you continue.</p>
          </div>
        )}
        <div className="mt-7 flex flex-wrap items-center gap-2">
          <button className="btn-accent" autoFocus onClick={() => fire('browser:shield:safety', tab.id)}><Icon name="shield-check" size={14} />Back to safety</button>
          <button className="btn-outline" onClick={() => void explainThreat(tab.id, t)}><span className="bx-orb h-3.5 w-3.5" />Ask AICO why</button>
          <button className="btn-ghost" onClick={() => setDetails(v => !v)} aria-expanded={details}>{details ? 'Hide details' : 'Details'}</button>
        </div>
        {details && (
          <div className="mt-5 flex flex-wrap gap-x-4 gap-y-1 text-[12.5px]">
            <button className="text-aico-danger hover:underline" onClick={() => fire('browser:shield:proceed', tab.id)}>Continue anyway (this time only)</button>
            <button className="text-aico-muted hover:underline" onClick={() => fire('browser:shield:trust', tab.id)}>This is a false alarm — trust {t.host}</button>
          </div>
        )}
      </div>
    </div>
  );
}

function HttpsFallbackPage({ tab }: { tab: TabState }): React.ReactElement {
  const f = tab.httpsFallback!;
  let host = '';
  try { host = new URL(f.httpUrl).host; } catch { host = f.httpUrl; }
  return (
    <div className="bx-chrome-page" style={{ background: 'color-mix(in srgb, var(--aico-warning) 6%, var(--aico-bg))' }} role="alertdialog" aria-label="Secure connection not available">
      <div className="mx-auto flex min-h-full max-w-[600px] flex-col justify-center px-8 py-16">
        <div className="mb-5 flex h-14 w-14 items-center justify-center rounded-2xl bg-aico-warning/15 text-aico-warning"><Icon name="lock" size={28} /></div>
        <h1 className="text-[24px] font-semibold tracking-tight">This site doesn’t support a secure connection</h1>
        <p className="mt-3 text-[14px] leading-relaxed text-aico-secondary">
          AICO tried the secure (https) version of <b className="font-medium text-aico-primary">{host}</b> and it did not work.
          Over http, anyone on the network can see or change what you send and receive — don’t enter passwords or card details there.
        </p>
        <div className="mt-2 text-[12px] text-aico-muted">{f.reason}</div>
        <div className="mt-7 flex flex-wrap gap-2">
          <button className="btn-primary" autoFocus onClick={() => fire('browser:shield:safety', tab.id)}>Go back</button>
          <button className="btn-outline" onClick={() => fire('browser:shield:http', tab.id)}>Continue to the site</button>
        </div>
        <p className="mt-4 text-[11.5px] text-aico-muted">Continuing remembers {host} as an http site; you can undo it in Privacy &amp; security.</p>
      </div>
    </div>
  );
}

/** A weaker warning (or a page you continued to): above the page, with the reason and "Ask AICO why". */
export function ThreatBar(): React.ReactElement | null {
  const tab = useActiveTab();
  const [hidden, setHidden] = useState<string | null>(null);
  const t = tab?.threat;
  if (!tab || !t || (t.level === 'block' && !t.proceeded) || hidden === t.url) return null;
  return (
    <div className={cls('bx-bar', t.level === 'block' ? 'bg-aico-danger/10' : 'bg-aico-warning/10')} role="alert">
      <Icon name="alert" size={15} className={cls('shrink-0', t.level === 'block' ? 'text-aico-danger' : 'text-aico-warning')} />
      <span className="min-w-0 flex-1">
        <b className="font-medium">{t.proceeded ? 'You continued to a page AICO flagged.' : 'This page may be deceptive.'}</b>{' '}
        <span className="text-aico-secondary">{t.reasons[0]?.label}. Don’t enter passwords or card details here. AICO’s agent won’t click or type on it.</span>
      </span>
      <button className="btn-ghost btn-sm shrink-0" onClick={() => void explainThreat(tab.id, t)}><span className="bx-orb h-3 w-3" />Ask AICO why</button>
      <button className="btn-ghost btn-sm shrink-0" onClick={() => fire('browser:shield:trust', tab.id)} title={`Stop flagging ${t.host}`}>Trust site</button>
      <button className="icon-btn-sm shrink-0" onClick={() => setHidden(t.url)} title="Dismiss"><Icon name="x" size={13} /></button>
    </div>
  );
}
