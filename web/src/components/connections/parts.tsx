/**
 * The small pieces the Connections page and the Delivery board share: a provider
 * monogram, a status pill, a chip, the probe's result, and an external link.
 *
 * WHY here and not in delivery/ui: these know about connections (providers, probes,
 * statuses); the primitives they are built from (Pill, Callout, buttons) are
 * Delivery's, imported, so the page looks like the board it is reached from and
 * there is no second button style.
 *
 * Colour is never the only signal: every status is a word plus a dot, a missing
 * permission is the word "Missing" in red, an extra power is a warning with a
 * sentence. The probe's result is shown as it came; nothing here decides what a
 * scope is worth.
 *
 * @module web/components/connections/parts
 */

import React from 'react';
import type { Connection, ProviderId } from '../../../../shared/connections/types';
import {
  capabilityChips, connectionStatus, probeVerdict, safeExternalUrl, scopeView, type Chip, type StatusChip,
} from '../../connections';
import { ago, toMs } from '../../delivery-model';
import { DvIcon } from '../delivery/icons';
import { Callout, Pill } from '../delivery/ui';

const MONOGRAM: Partial<Record<ProviderId, string>> = {
  github: 'GH', gitlab: 'GL', 'azure-devops': 'AZ', 'bitbucket-cloud': 'BB', 'bitbucket-dc': 'BB',
  gitea: 'Gt', forgejo: 'Fj', gitbucket: 'GB',
};

/** A logo-less mark: two letters in a quiet square. A brand mark is not ours to draw. */
export function Monogram({ provider, size = 36 }: { provider: ProviderId | 'other'; size?: number }): React.ReactElement {
  return (
    <span
      aria-hidden="true" style={{ width: size, height: size }}
      className="inline-flex shrink-0 items-center justify-center rounded-lg border border-aico-border-subtle bg-aico-surface text-[12px] font-semibold tracking-tight text-aico-secondary"
    >
      {provider === 'other' ? '+' : MONOGRAM[provider] ?? '··'}
    </span>
  );
}

const DOT: Record<Chip['tone'], string> = {
  success: 'bg-aico-success', warning: 'bg-aico-warning', danger: 'bg-aico-danger', info: 'bg-aico-accent', neutral: 'bg-aico-muted',
};

export function ChipPill({ chip }: { chip: Chip }): React.ReactElement {
  return (
    <Pill tone={chip.tone} {...(chip.title ? { title: chip.title } : {})} icon={<span className={`h-1.5 w-1.5 shrink-0 rounded-full ${DOT[chip.tone]}`} aria-hidden="true" />}>
      {chip.label}
    </Pill>
  );
}

export function StatusPill({ status }: { status: StatusChip }): React.ReactElement {
  return <ChipPill chip={{ id: 'status', label: status.label, tone: status.tone, ...(status.reason ? { title: status.reason } : {}) }} />;
}

/** A link out of the app: a new tab in a browser, the system browser in the desktop. Anything but http(s) is plain text. */
export function ExternalLink({ href, children, className = '', title }: { href: string | undefined; children: React.ReactNode; className?: string; title?: string }): React.ReactElement {
  const safe = safeExternalUrl(href);
  if (!safe) return <span className={className} title={title}>{children}</span>;
  return (
    <a
      href={safe} target="_blank" rel="noopener noreferrer" title={title}
      className={`inline-flex items-center gap-1 text-aico-accent hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-aico-accent ${className}`}
    >
      {children}<DvIcon name="external" size={12} />
    </a>
  );
}

/** What a probe found, in the order a person asks: can I use it, what can it do, is the token right-sized. */
export function ProbePanel({ connection, now }: { connection: Connection; now: number }): React.ReactElement | null {
  const p = connection.probe;
  if (!p) return null;
  const verdict = probeVerdict(p);
  const chips = capabilityChips(p.capabilities);
  const scopes = scopeView(p);
  const status = connectionStatus(connection, now);
  return (
    <div className="space-y-4" aria-label={`Test result for ${connection.label}`}>
      <Callout tone={verdict.tone} role="status">
        <p className="font-medium">{verdict.headline}</p>
        {status.reason && status.label !== 'Connected' && <p className="mt-0.5 text-aico-secondary">{status.reason}</p>}
      </Callout>

      <section aria-label="What AICO can do here">
        <h4 className="mb-1.5 text-[12px] font-medium text-aico-secondary">What AICO can do here</h4>
        {chips.length > 0
          ? <ul className="flex flex-wrap gap-1.5">{chips.map(c => <li key={c.id}><ChipPill chip={c} /></li>)}</ul>
          : <p className="text-[12.5px] text-aico-secondary">Nothing yet. The token may not be able to read this repository.</p>}
      </section>

      <section aria-label="Token permissions">
        <h4 className="mb-1.5 text-[12px] font-medium text-aico-secondary">Token permissions</h4>
        {scopes.reported && (
          <p className="mb-2 text-[12.5px] text-aico-secondary">
            Found: {scopes.found.length ? <span className="font-mono text-[12px] text-aico-primary">{scopes.found.join(', ')}</span> : 'none listed'}
          </p>
        )}
        <ul className="overflow-hidden rounded-lg border border-aico-border-subtle">
          {scopes.rows.map(r => (
            <li key={r.scope} className="flex items-start gap-2 border-b border-aico-border-subtle px-3 py-2 text-[12.5px] last:border-b-0">
              <DvIcon name={r.status === 'ok' ? 'checkCircle' : 'xCircle'} size={15} className={`mt-px shrink-0 ${r.status === 'ok' ? 'text-aico-success' : r.required ? 'text-aico-danger' : 'text-aico-muted'}`} />
              <span className="min-w-0 flex-1">
                <span className="font-mono text-[12px] text-aico-primary">{r.scope}</span>
                <span className="text-aico-secondary"> · {r.why}</span>
              </span>
              <span className={`shrink-0 text-[11.5px] ${r.status === 'ok' ? 'text-aico-muted' : r.required ? 'font-medium text-aico-danger' : 'text-aico-muted'}`}>
                {r.status === 'ok' ? (r.basis === 'probed' ? 'Works' : 'Granted') : r.required ? 'Missing' : 'Optional, not granted'}
              </span>
            </li>
          ))}
        </ul>
        {scopes.advice.length > 0 && (
          <ul className="mt-2 space-y-1 text-[12.5px] leading-snug text-aico-secondary">
            {scopes.advice.map((a, i) => <li key={i}>{a}</li>)}
          </ul>
        )}
      </section>

      {scopes.extra.length > 0 && (
        <Callout tone="warning" role="status">
          <p className="font-medium">This token is broader than it needs to be</p>
          <p className="mt-0.5 text-aico-secondary">Extra powers: <span className="font-mono text-[12px] text-aico-primary">{scopes.extra.join(', ')}</span>. Anyone who gets this token gets them too.</p>
        </Callout>
      )}

      {p.warnings.length > 0 && (
        <section aria-label="Warnings">
          <ul className="space-y-1 text-[12.5px] leading-snug text-aico-secondary">
            {p.warnings.map((w, i) => (
              <li key={i} className="flex gap-2"><DvIcon name="alert" size={14} className="mt-px shrink-0 text-aico-warning" />{w}</li>
            ))}
          </ul>
        </section>
      )}

      <p className="text-[11.5px] text-aico-muted">
        Tested {ago(p.at, now) || 'just now'}
        {p.tokenExpiresAt && toMs(p.tokenExpiresAt) ? <> · token expires {new Date(toMs(p.tokenExpiresAt)).toLocaleDateString()}</> : null}
      </p>
    </div>
  );
}
