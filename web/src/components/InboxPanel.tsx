/**
 * The "Waiting for you" inbox (design §7.7, §8.3): calls an unattended (L4)
 * run parked for a person, and what became of the ones already decided.
 *
 * Each card shows what someone needs to decide without opening the run —
 * the exact call (secrets by name), the preview, the effect and why it
 * needed a person, where it came from and when it expires — and offers
 * **Approve once** and **Deny**. There is deliberately no "always allow".
 * Approving is sent as a person (the client nonce here; the desktop's window
 * grant there), so the API token the model may hold cannot approve; the
 * engine then runs exactly the parked call, or refuses it if its preview or
 * definition changed. Shared by the web portal and the desktop app.
 *
 * @module components/InboxPanel
 */

import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { expiresIn, newlyPending, originLabel, previewSummary, sortActions, statusLabel, type ParkedAction } from '../inbox';

/** How often the list refreshes while open. Parking is rare; this is a list, not a stream. */
const REFRESH_MS = 15_000;

/**
 * How many calls wait for a person, polled for the nav badge. `onNew` fires
 * for each newly parked call (the desktop turns it into a native
 * notification); the web shows the badge and the count in the tab title.
 */
export function useInboxCount(onNew?: (fresh: ParkedAction[]) => void, everyMs = 30_000): number {
  const [count, setCount] = useState(0);
  useEffect(() => {
    let last: ParkedAction[] | undefined;
    let stopped = false;
    const poll = async (): Promise<void> => {
      try {
        const r = await api.inbox('pending');
        if (stopped) return;
        setCount(r.pending);
        if (last && onNew) { const fresh = newlyPending(last, r.actions); if (fresh.length) onNew(fresh); }
        last = r.actions;
      } catch { /* the engine is restarting or the token expired: keep the last count */ }
    };
    void poll();
    const t = setInterval(() => void poll(), everyMs);
    return () => { stopped = true; clearInterval(t); };
  }, [onNew, everyMs]);
  return count;
}

export function InboxPanel({ onCount }: { onCount?: (pending: number) => void }): React.ReactElement {
  const [actions, setActions] = useState<ParkedAction[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<{ id: string; ok: boolean; text: string } | null>(null);

  const refresh = useCallback(async () => {
    try {
      const r = await api.inbox('all');
      setActions(sortActions(r.actions));
      onCount?.(r.pending);
    } catch { setActions(prev => prev ?? []); }
  }, [onCount]);
  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), REFRESH_MS);
    return () => clearInterval(t);
  }, [refresh]);

  const decide = async (a: ParkedAction, decision: 'approve' | 'deny'): Promise<void> => {
    setBusy(a.id);
    try {
      const r = await api.decideParked(a.id, decision, decision === 'deny' ? note[a.id] : undefined);
      setMsg({ id: a.id, ok: r.ok, text: r.message });
    } catch (e) {
      setMsg({ id: a.id, ok: false, text: (e as Error).message });
    } finally {
      setBusy(null);
      await refresh();
    }
  };

  if (actions === null) return <p className="text-[12px] text-aico-muted">Loading…</p>;
  if (actions.length === 0) {
    return (
      <p className="max-w-xl text-[12px] leading-relaxed text-aico-secondary">
        Nothing is waiting for you. When an unattended run — a schedule, a background job, a chat at L4 — reaches
        a step that needs a person (a destructive tool, say), it parks the exact call here with its preview and
        carries on with the rest. You approve or deny it here; approving runs exactly that call, once.
      </p>
    );
  }

  return (
    <ul className="space-y-2" aria-label="Waiting for you">
      {actions.map(a => {
        const pending = a.status === 'pending';
        return (
          <li key={a.id} className={`rounded-xl border ${pending ? 'border-aico-warning' : 'border-aico-border'} px-3 py-2 text-[12px]`}>
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="font-mono text-[13px] text-aico-primary">{a.tool}</span>
              <span className="rounded bg-aico-hover px-1.5 text-[11px] text-aico-secondary">{a.effect}</span>
              <span className="rounded bg-aico-hover px-1.5 text-[11px] text-aico-secondary">{originLabel(a)}</span>
              <span className={`ml-auto text-[11px] ${pending ? 'text-aico-warning' : 'text-aico-muted'}`}>
                {statusLabel(a.status)}{pending ? ` · ${expiresIn(a.expiresAt)}` : ''}
              </span>
            </div>
            <p className="mt-1 text-aico-muted">Needs a person: {a.why}. Parked {new Date(a.createdAt).toLocaleString()}.</p>
            <pre className="mt-1.5 overflow-x-auto whitespace-pre-wrap break-all rounded-lg bg-aico-code px-2.5 py-1.5 font-mono text-[11.5px] text-aico-primary">{a.call}</pre>
            {a.preview && (
              <details className="mt-1.5" open={pending}>
                <summary className="cursor-pointer text-aico-secondary">{previewSummary(a.preview)}</summary>
                <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-aico-code px-2.5 py-1.5 font-mono text-[11.5px] text-aico-primary">{a.preview}</pre>
              </details>
            )}
            {!pending && a.outcome && (
              <pre className="mt-1.5 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-aico-hover px-2.5 py-1.5 font-mono text-[11.5px] text-aico-secondary">{a.outcome}</pre>
            )}
            {a.newPreview && (
              <details className="mt-1.5">
                <summary className="cursor-pointer text-aico-secondary">What the preview says now</summary>
                <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-aico-code px-2.5 py-1.5 font-mono text-[11.5px] text-aico-primary">{a.newPreview}</pre>
              </details>
            )}
            {pending && (
              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                <button type="button" disabled={busy !== null} onClick={() => void decide(a, 'approve')}
                  className="rounded-lg bg-aico-accent px-3 py-1.5 text-[12px] font-medium text-aico-on-accent transition-colors hover:bg-aico-accent-hover disabled:opacity-50">
                  {busy === a.id ? 'Working…' : 'Approve once'}
                </button>
                <button type="button" disabled={busy !== null} onClick={() => void decide(a, 'deny')}
                  className="rounded-lg px-3 py-1.5 text-[12px] text-aico-secondary transition-colors hover:bg-aico-hover hover:text-aico-danger disabled:opacity-50">
                  Deny
                </button>
                <input
                  aria-label={`Why deny ${a.tool} (optional)`}
                  placeholder="Why (optional, for the agent)"
                  value={note[a.id] ?? ''}
                  onChange={e => setNote(n => ({ ...n, [a.id]: e.target.value }))}
                  className="min-w-0 flex-1 rounded-lg border border-aico-border bg-aico-bg px-2 py-1 text-[12px] text-aico-primary"
                />
              </div>
            )}
            {msg?.id === a.id && (
              <p role="status" className={`mt-1.5 ${msg.ok ? 'text-aico-secondary' : 'text-aico-danger'}`}>{msg.text}</p>
            )}
          </li>
        );
      })}
    </ul>
  );
}
