/**
 * "About you" — every fact AICO has learned about the person, with its
 * evidence and the controls to confirm, edit, hide or forget it (ADR 0018).
 *
 * Shared by web Settings and the desktop About-you page (which wraps it with
 * its browser-only switch), because a fact that reaches the agent's prompt
 * must be visible from every client that can start a turn — the same reason
 * LearnedPane is shared (ADR 0016).
 *
 * Confirm, edit, add, run-now and switching a source on go to the engine as a
 * person (`postAsPerson`); the engine refuses them on the API token alone.
 * Hide, forget, pause and wipe only take away, so they need nothing. Wipe asks
 * first through the host's confirm (a native dialog on the desktop).
 *
 * @module components/settings/AboutYouPane
 */

import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../../api';
import { BROWSING_STATUS, CATEGORY_LABEL, agoText, evidenceText, groupFacts, type FactCategory, type ProfileOverview } from '../../profile';

export interface AboutYouPaneProps {
  /** Ask before wiping. Default: the browser's confirm(). */
  confirm?: (message: string) => Promise<boolean>;
  /** Rendered under the source switches — the desktop puts its browser switch here. */
  extraSources?: React.ReactNode;
}

const btn = 'rounded-lg px-2 py-1 text-[12px] text-aico-secondary hover:text-aico-primary';

export function AboutYouPane({ confirm, extraSources }: AboutYouPaneProps = {}): React.ReactElement {
  const [data, setData] = useState<ProfileOverview | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [editing, setEditing] = useState<Record<string, string>>({});
  const [draft, setDraft] = useState('');
  const [draftCat, setDraftCat] = useState<FactCategory>('communication');
  const [showHidden, setShowHidden] = useState(false);

  const refresh = useCallback(async (): Promise<void> => {
    try { setData(await api.profile()); } catch (err) { setNote(err instanceof Error ? err.message : String(err)); }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);
  // While a run is going, look again shortly.
  useEffect(() => {
    if (!data?.running) return;
    const t = setTimeout(() => void refresh(), 3000);
    return () => clearTimeout(t);
  }, [data, refresh]);

  const run = async (fn: () => Promise<unknown>, done?: string): Promise<void> => {
    try { await fn(); if (done) setNote(done); await refresh(); } catch (err) { setNote(err instanceof Error ? err.message : String(err)); }
  };
  const exportFacts = async (): Promise<void> => {
    try {
      const url = URL.createObjectURL(new Blob([JSON.stringify(await api.profileExport(), null, 2)], { type: 'application/json' }));
      const a = document.createElement('a');
      a.href = url; a.download = 'aico-about-you.json'; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (err) { setNote(err instanceof Error ? err.message : String(err)); }
  };
  const wipe = async (): Promise<void> => {
    const ask = confirm ?? (async (m: string) => window.confirm(m));
    if (!(await ask('Erase everything About you has learned? Facts you told it to forget stay forgotten. This cannot be undone.'))) return;
    await run(() => api.profileWipe(), 'Erased.');
  };

  const s = data?.settings;
  const facts = (data?.facts ?? []).filter(f => showHidden || f.status !== 'hidden');
  const hiddenCount = (data?.facts ?? []).filter(f => f.status === 'hidden').length;
  const using = new Set(data?.using ?? []);

  return (
    <section data-about-you className="space-y-4">
      <div className="rounded-lg border border-aico-border-subtle bg-aico-surface p-3 text-[12px] leading-relaxed text-aico-secondary" data-privacy>
        Learned on this computer from your work in AICO and, if you allow it, a summary of your browsing (sites by kind,
        topics, routines — never addresses, pages or whole searches). It never infers health, religion, politics,
        sexuality, ethnicity, finances, where you live, or family and relationships; a filter in code drops them.
        Confirmed facts, and learned ones it is fairly sure of, are given to the agent as background — never to helper
        agents or to programs that send AICO work over MCP.
        {data?.learner && (
          <span data-learner>
            {' '}{data.learner.ok
              ? `It phrases facts with ${data.learner.model}${data.learner.provider ? ` (${data.learner.provider}${data.learner.local ? ', on this machine' : ''})` : ''}, at most $${s?.dailyBudgetUsd.toFixed(2)} a day.`
              : 'No model is used: facts keep their plain wording.'}
          </span>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-[12px]">
        <label className="flex items-center gap-1.5">
          <input type="checkbox" checked={s?.enabled ?? true} onChange={e => void run(() => api.profileSettings({ enabled: e.target.checked }))} data-enabled />
          Learn about me
        </label>
        <label className="flex items-center gap-1.5" title="Session logs and the working rules you accepted">
          <input type="checkbox" disabled={!s?.enabled} checked={s?.work ?? true} onChange={e => void run(() => api.profileSettings({ work: e.target.checked }))} data-work />
          From my work
        </label>
        <label className="flex items-center gap-1.5" title={data ? BROWSING_STATUS[data.sources.browsing] ?? data.sources.browsing : ''}>
          <input type="checkbox" disabled={!s?.enabled} checked={s?.browsing ?? true} onChange={e => void run(() => api.profileSettings({ browsing: e.target.checked }))} data-browsing />
          From my browsing
          {data && s?.browsing && <span className="text-aico-muted">({BROWSING_STATUS[data.sources.browsing] ?? data.sources.browsing})</span>}
        </label>
        {extraSources}
      </div>

      <div className="flex flex-wrap items-center gap-2 text-[12px] text-aico-muted" data-last-run>
        <span className="flex-1">
          {data?.running ? 'Learning now…'
            : data?.lastRun ? `Last run ${agoText(data.lastRun.at)} · ${data.lastRun.via === 'model' ? `phrased by ${data.lastRun.model}` : data.lastRun.via === 'deterministic' ? 'plain wording' : 'skipped'} · spent $${(data.spend.today).toFixed(3)} of $${data.spend.budget.toFixed(2)} today${data.lastRun.note ? ` · ${data.lastRun.note}` : ''}`
              : 'Not run yet. It runs every few hours while AICO is idle.'}
        </span>
        <button className={btn} disabled={!s?.enabled || data?.running} onClick={() => void run(() => api.profileRun(), 'Learning started.')} data-run>Run now</button>
        <button className={btn} onClick={() => void exportFacts()} data-export>Export</button>
        <button className="rounded-lg px-2 py-1 text-[12px] text-aico-muted hover:text-aico-danger" onClick={() => void wipe()} data-wipe>Erase all</button>
      </div>
      {note && <p className="text-[12px] text-aico-secondary" data-note>{note}</p>}

      <div className="rounded-lg border border-aico-border-subtle bg-aico-surface p-3">
        <span className="text-[10px] uppercase tracking-wide text-aico-muted">Tell AICO something about you</span>
        <div className="mt-1 flex flex-wrap gap-2">
          <input value={draft} onChange={e => setDraft(e.target.value)} placeholder="e.g. Prefers answers with the code first."
            className="min-w-[200px] flex-1 rounded border border-aico-border bg-aico-bg px-2 py-1 text-[12px] text-aico-primary outline-none focus:ring-2 focus:ring-aico-accent/40" data-new-fact />
          <select value={draftCat} onChange={e => setDraftCat(e.target.value as FactCategory)} className="rounded border border-aico-border bg-aico-bg px-1.5 py-1 text-[11px] text-aico-secondary">
            {(Object.keys(CATEGORY_LABEL) as FactCategory[]).map(c => <option key={c} value={c}>{CATEGORY_LABEL[c]}</option>)}
          </select>
          <button disabled={!draft.trim()} onClick={() => void run(() => api.profileAdd(draftCat, draft), 'Added.').then(() => setDraft(''))}
            className="rounded-lg bg-aico-accent px-2.5 py-1 text-[12px] font-medium text-white hover:opacity-90 disabled:opacity-40">Add</button>
        </div>
      </div>

      {facts.length === 0 && <p className="text-[12px] text-aico-muted" data-empty>Nothing learned yet. Facts appear here after AICO has seen a few days of your work.</p>}
      {groupFacts(facts).map(([cat, list]) => (
        <div key={cat} data-category={cat}>
          <h4 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-aico-muted">{CATEGORY_LABEL[cat]}</h4>
          <ul className="space-y-1.5">
            {list.map(f => {
              const text = editing[f.id];
              return (
                <li key={f.id} className="rounded-lg border border-aico-border-subtle bg-aico-surface px-3 py-2" data-fact={f.id} data-status={f.status}>
                  <div className="flex items-start gap-2">
                    {text !== undefined ? (
                      <textarea value={text} rows={2} onChange={e => setEditing(x => ({ ...x, [f.id]: e.target.value }))}
                        className="flex-1 rounded border border-aico-border bg-aico-bg px-2 py-1 text-[12px] text-aico-primary outline-none focus:ring-2 focus:ring-aico-accent/40" />
                    ) : (
                      <p className={`flex-1 text-[13px] ${f.status === 'hidden' ? 'text-aico-muted line-through' : 'text-aico-primary'}`} title={evidenceText(f)} data-evidence>{f.text}</p>
                    )}
                    <span className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium ${f.status === 'confirmed' ? 'bg-aico-success/15 text-aico-success' : f.status === 'hidden' ? 'bg-aico-hover text-aico-muted' : 'bg-aico-warning/15 text-aico-warning'}`}
                      title={f.status === 'inferred' ? `Learned, ${Math.round(f.confidence * 100)}% sure${using.has(f.id) ? ' — given to the agent' : ' — not used until it is surer or you confirm it'}` : undefined}>
                      {f.origin === 'user' ? 'yours' : f.status === 'inferred' ? `learned · ${Math.round(f.confidence * 100)}%` : f.status}
                    </span>
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-1 text-[11px] text-aico-muted">
                    <span className="flex-1 truncate" title={evidenceText(f)}>{f.evidence[0] ? `Seen ${f.evidence[0].count}× · last ${agoText(f.evidence[0].lastSeen)}` : ''}</span>
                    {text !== undefined ? (
                      <>
                        <button className={btn} onClick={() => setEditing(x => { const n = { ...x }; delete n[f.id]; return n; })}>Cancel</button>
                        <button className="rounded-lg border border-aico-border px-2 py-1 text-[12px] text-aico-primary"
                          onClick={() => void run(() => api.profileAct({ id: f.id, action: 'edit', text })).then(() => setEditing(x => { const n = { ...x }; delete n[f.id]; return n; }))}>Save</button>
                      </>
                    ) : (
                      <>
                        {f.status === 'inferred' && <button className={btn} onClick={() => void run(() => api.profileAct({ id: f.id, action: 'confirm' }))} data-confirm>Confirm</button>}
                        <button className={btn} onClick={() => setEditing(x => ({ ...x, [f.id]: f.text }))} data-edit>Edit</button>
                        {f.status === 'hidden'
                          ? <button className={btn} onClick={() => void run(() => api.profileAct({ id: f.id, action: 'unhide' }))}>Show</button>
                          : <button className={btn} onClick={() => void run(() => api.profileAct({ id: f.id, action: 'hide' }))} data-hide>Hide</button>}
                        <button className="rounded-lg px-2 py-1 text-[12px] text-aico-muted hover:text-aico-danger"
                          onClick={() => void run(() => api.profileAct({ id: f.id, action: 'forget' }), 'Forgotten. It will not be learned again.')} data-forget>Forget</button>
                      </>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
      {hiddenCount > 0 && (
        <button className="text-[12px] text-aico-muted underline decoration-dotted" onClick={() => setShowHidden(v => !v)}>
          {showHidden ? 'Hide' : 'Show'} {hiddenCount} hidden fact{hiddenCount === 1 ? '' : 's'}
        </button>
      )}
    </section>
  );
}
