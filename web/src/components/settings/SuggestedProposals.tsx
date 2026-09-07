/**
 * What the log proposes, waiting for a person.
 *
 * Each card is one lesson the engine extracted from a turn — a correction you
 * wrote, a steer, a fix after a failing check, an error that repeated — with
 * where it came from and the words it would be kept as. Nothing on this list
 * is in effect. Keep writes it (knowledge, a profile fact, or a line about
 * you); Dismiss records the decision so it is not proposed again. Marked
 * "needs an edit" when the words were inferred rather than written by you.
 *
 * @module components/settings/SuggestedProposals
 */

import React, { useCallback, useEffect, useState } from 'react';
import { api, type Proposal } from '../../api';
import { useStore } from '../../store';

const KIND_LABEL: Record<Proposal['kind'], string> = {
  knowledge: 'knowledge',
  profile: 'project command',
  user: 'about you',
};

export function SuggestedProposals(): React.ReactElement | null {
  const project = useStore(s => s.project);
  const busy = useStore(s => s.busy);
  const [items, setItems] = useState<Proposal[]>([]);
  const [editing, setEditing] = useState<Record<string, { trigger: string; content: string; scope: 'project' | 'global' }>>({});
  const [note, setNote] = useState<string | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const r = await api.learning(project ?? undefined);
      setItems([...r.project, ...r.global]);
    } catch (err) {
      setNote(err instanceof Error ? err.message : String(err));
    }
  }, [project]);

  // After each turn: the turn may have produced one.
  useEffect(() => { void refresh(); }, [refresh, busy]);

  if (items.length === 0) return null;

  const edit = (p: Proposal) => editing[p.id] ?? { trigger: p.trigger ?? '', content: p.content, scope: p.scope };

  const keep = async (p: Proposal): Promise<void> => {
    const e = edit(p);
    try {
      const r = await api.adoptProposal(project ?? undefined, p.id, {
        ...(p.kind === 'knowledge' ? { trigger: e.trigger, scope: e.scope } : {}),
        content: e.content,
      });
      setNote(`Kept — written to ${r.wrote}`);
      await refresh();
    } catch (err) {
      setNote(err instanceof Error ? err.message : String(err));
    }
  };

  const dismiss = async (p: Proposal): Promise<void> => {
    await api.dismissProposal(project ?? undefined, p.id).catch(() => undefined);
    await refresh();
  };

  return (
    <section data-suggested>
      <h3 className="text-[13px] font-medium text-aico-primary">
        Suggested <span className="text-aico-muted">({items.length})</span>
      </h3>
      <p className="mt-0.5 text-[12px] text-aico-muted">
        Lessons the last turns proposed. Nothing here is in effect until you keep it.
      </p>
      {note && <p className="mt-1 text-[12px] text-aico-secondary">{note}</p>}
      <ul className="mt-2 space-y-2">
        {items.map(p => {
          const e = edit(p);
          return (
            <li key={p.id} className="rounded-lg border border-aico-border-subtle bg-aico-surface p-3" data-proposal={p.id}>
              <div className="flex flex-wrap items-center gap-2">
                <span className="rounded bg-aico-hover px-1.5 py-0.5 font-mono text-[10px] text-aico-muted">{KIND_LABEL[p.kind]}</span>
                {p.needsEdit && (
                  <span className="rounded bg-aico-warning/15 px-1.5 py-0.5 text-[10px] text-aico-warning" title="The words were inferred from what happened, not written by you. Read them before keeping.">
                    needs an edit
                  </span>
                )}
                <span className="text-[11px] text-aico-muted">{p.why}</span>
              </div>
              {p.kind === 'knowledge' && (
                <label className="mt-2 block">
                  <span className="text-[10px] uppercase tracking-wide text-aico-muted">When</span>
                  <input
                    value={e.trigger}
                    onChange={ev => setEditing(s => ({ ...s, [p.id]: { ...e, trigger: ev.target.value } }))}
                    className="mt-0.5 w-full rounded border border-aico-border bg-aico-bg px-2 py-1 text-[12px] text-aico-primary outline-none focus:ring-2 focus:ring-aico-accent/40"
                  />
                </label>
              )}
              <label className="mt-2 block">
                <span className="text-[10px] uppercase tracking-wide text-aico-muted">{p.kind === 'knowledge' ? 'Then' : 'Line'}</span>
                <textarea
                  value={e.content}
                  onChange={ev => setEditing(s => ({ ...s, [p.id]: { ...e, content: ev.target.value } }))}
                  rows={2}
                  className="mt-0.5 w-full rounded border border-aico-border bg-aico-bg px-2 py-1 text-[12px] text-aico-primary outline-none focus:ring-2 focus:ring-aico-accent/40"
                />
              </label>
              <div className="mt-2 flex items-center gap-2">
                {p.kind === 'knowledge' && (
                  <select
                    value={e.scope}
                    onChange={ev => setEditing(s => ({ ...s, [p.id]: { ...e, scope: ev.target.value as 'project' | 'global' } }))}
                    className="rounded border border-aico-border bg-aico-bg px-1.5 py-1 text-[11px] text-aico-secondary"
                  >
                    <option value="project">this project</option>
                    <option value="global">every project</option>
                  </select>
                )}
                {p.evidence.seqs.length > 0 && (
                  <span className="text-[10px] text-aico-muted" title={`Session ${p.evidence.sessionId}, events ${p.evidence.seqs.join(', ')}`}>
                    evidence: {p.evidence.sessionId.slice(0, 8)}{p.evidence.turn ? ` turn ${p.evidence.turn}` : ''}
                  </span>
                )}
                <div className="flex-1" />
                <button onClick={() => void dismiss(p)} className="rounded-lg px-2 py-1 text-[12px] text-aico-muted hover:text-aico-danger" data-dismiss>
                  Dismiss
                </button>
                <button onClick={() => void keep(p)} className="rounded-lg bg-aico-accent px-2.5 py-1 text-[12px] font-medium text-white hover:opacity-90" data-keep>
                  Keep
                </button>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
