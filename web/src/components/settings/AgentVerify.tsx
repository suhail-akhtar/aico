/**
 * The "Verify" step (design §7.6 step 6), shared by the web Agents pane, the
 * agent builder and the desktop: the agent's certification status, the plan
 * and its estimated cost, and a Certify button.
 *
 * Certification spends money, so the estimate comes first and the button
 * says what it will do (k trials, the cap). Everything is the engine's
 * `AgentManage status|certify` — the panel decides nothing. A run takes
 * minutes; the request simply waits, with the button saying so.
 *
 * @module components/settings/AgentVerify
 */

import React, { useState } from 'react';
import { api } from '../../api';
import { certBadge, readCertifyReply } from '../../agent-certify';

const TONE: Record<string, string> = {
  good: 'bg-aico-success/10 text-aico-success',
  warn: 'bg-aico-warning/15 text-aico-warning',
  bad: 'bg-aico-danger/10 text-aico-danger',
  muted: 'bg-aico-hover text-aico-muted',
};

export function CertBadge({ status, text }: { status?: string; text?: string }): React.ReactElement {
  const b = certBadge(status);
  return (
    <span className={`rounded px-1.5 py-0.5 text-[10px] ${TONE[b.tone]}`} title={text ? `${text} — ${b.hint}` : b.hint}>
      {b.symbol} {b.label}
    </span>
  );
}

export function AgentVerify({ name, status, statusText, onDone }: {
  name: string;
  status?: string;
  statusText?: string;
  onDone?: () => void | Promise<void>;
}): React.ReactElement {
  const [runs, setRuns] = useState(1);
  const [plan, setPlan] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [busy, setBusy] = useState<'plan' | 'run' | null>(null);

  const estimate = async (): Promise<void> => {
    setBusy('plan');
    try {
      const r = await api.manage('agents', { action: 'certify', name, runs, dryRun: true });
      setPlan(r.result ?? r.error ?? '');
      setResult(null);
    } finally { setBusy(null); }
  };
  const certify = async (): Promise<void> => {
    setBusy('run');
    try {
      const r = await api.manage('agents', { action: 'certify', name, runs });
      setResult(r.result ?? r.error ?? '');
      await onDone?.();
    } finally { setBusy(null); }
  };
  const read = readCertifyReply(plan ?? undefined);

  return (
    <div className="space-y-1.5 text-[12px]">
      <div className="flex flex-wrap items-center gap-2">
        <CertBadge status={status} {...(statusText ? { text: statusText } : {})} />
        {statusText && <span className="text-[11px] text-aico-muted">{statusText}</span>}
      </div>
      <p className="text-[11px] text-aico-muted">
        Certifying runs the built-in safety probes (planted instructions, a secret request, a refused deletion,
        a write outside its paths) and its own golden tasks, with real-world effects mocked. Only unattended
        (L4) runs need it. Costs money: capped at $2.
      </p>
      <div className="flex flex-wrap items-center gap-1.5">
        <label className="flex items-center gap-1 text-[11px] text-aico-secondary">
          Trials per task
          <select className="rounded border border-aico-border bg-aico-bg px-1 py-0.5 text-[11px]" value={runs}
            onChange={e => { setRuns(Number(e.target.value)); setPlan(null); }} aria-label="Trials per task">
            <option value={1}>1 (quick)</option>
            <option value={3}>3 (default)</option>
          </select>
        </label>
        <button type="button" onClick={() => void estimate()} disabled={busy !== null}
          className="rounded-lg px-2 py-1 text-[11px] text-aico-secondary transition-colors hover:bg-aico-hover disabled:opacity-40">
          {busy === 'plan' ? 'Planning…' : 'Show plan and cost'}
        </button>
        <button type="button" onClick={() => void certify()} disabled={busy !== null || !plan}
          title={plan ? undefined : 'See the plan and its cost first'}
          className="rounded-lg bg-aico-accent px-2 py-1 text-[11px] font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-40">
          {busy === 'run' ? 'Certifying… (this takes minutes)' : read.estimateUsd !== undefined ? `Certify (≈ $${read.estimateUsd.toFixed(2)}, cap $${read.capUsd?.toFixed(2)})` : 'Certify'}
        </button>
      </div>
      {plan && !result && <pre className="max-h-[180px] overflow-y-auto whitespace-pre-wrap rounded bg-aico-hover/50 p-2 font-mono text-[11px] text-aico-secondary">{plan}</pre>}
      {result && (
        <pre className={`max-h-[220px] overflow-y-auto whitespace-pre-wrap rounded p-2 font-mono text-[11px] ${readCertifyReply(result).passed ? 'bg-aico-success/10 text-aico-success' : 'bg-aico-danger/10 text-aico-danger'}`}>{result}</pre>
      )}
    </div>
  );
}
