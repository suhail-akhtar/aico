/**
 * "What AICO learned about how you work" — the one place preference rules
 * are seen, accepted, edited, switched off, forgotten and exported.
 *
 * Shared by the web Settings and the desktop Settings (imported there as
 * is), because a rule the agent follows must be visible from every client
 * that can start a turn. Proposed rules come first: they are the only ones
 * waiting on the reader. Each shows the evidence it came from — the note,
 * correction, edit or repeated choice — with a link back to the chat.
 *
 * Accept/enable/edit/add go to the engine as a person (`postAsPerson`); the
 * engine refuses them on the API token alone (ADR 0016). The auto-accept
 * toggle for low-risk style rules is a normal setting in this pane's schema.
 *
 * @module components/settings/LearnedPane
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { api, type PreferenceRule } from '../../api';
import { useStore } from '../../store';

const STATUS_ORDER: Record<PreferenceRule['status'], number> = { proposed: 0, active: 1, disabled: 2, superseded: 3 };
const KIND_LABEL: Record<PreferenceRule['evidence'][number]['kind'], string> = {
  feedback: 'your rating', correction: 'your correction', edit: 'your edit', choice: 'your repeated choice',
};

export function scopeLabel(scope: string, cwd?: string): string {
  if (scope === 'global') return 'everywhere';
  if (scope.startsWith('language:')) return scope.slice(9);
  const root = scope.slice(8);
  const name = root.split(/[\\/]/).filter(Boolean).pop() ?? root;
  return cwd && root.toLowerCase() === cwd.toLowerCase() ? `this project (${name})` : `project ${name}`;
}

export function LearnedPane({ onClose }: { onClose?: () => void } = {}): React.ReactElement {
  const project = useStore(s => s.project);
  const busy = useStore(s => s.busy);
  const [data, setData] = useState<{ cwd: string; rules: PreferenceRule[]; applying: string[]; pending: number } | null>(null);
  const [editing, setEditing] = useState<Record<string, string>>({});
  const [draft, setDraft] = useState('');
  const [draftScope, setDraftScope] = useState('global');
  const [note, setNote] = useState<string | null>(null);
  const [showOld, setShowOld] = useState(false);

  const refresh = useCallback(async (): Promise<void> => {
    try { setData(await api.preferences(project ?? undefined)); }
    catch (err) { setNote(err instanceof Error ? err.message : String(err)); }
  }, [project]);
  useEffect(() => { void refresh(); }, [refresh, busy]);

  const act = async (body: Parameters<typeof api.preferenceAct>[0], done?: string): Promise<void> => {
    try {
      await api.preferenceAct({ ...body, ...(project ? { cwd: project } : {}) });
      if (done) setNote(done);
      await refresh();
    } catch (err) {
      setNote(err instanceof Error ? err.message : String(err));
    }
  };

  const exportRules = async (): Promise<void> => {
    try {
      const json = JSON.stringify(await api.preferencesExport(), null, 2);
      const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = 'aico-preferences.json';
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (err) {
      setNote(err instanceof Error ? err.message : String(err));
    }
  };

  const rules = useMemo(() => [...(data?.rules ?? [])]
    .filter(r => showOld || r.status !== 'superseded')
    .sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || b.updatedAt - a.updatedAt), [data, showOld]);
  const byId = useMemo(() => new Map((data?.rules ?? []).map(r => [r.id, r])), [data]);
  const proposed = rules.filter(r => r.status === 'proposed').length;

  return (
    <section data-learned className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <p className="flex-1 text-[12px] leading-relaxed text-aico-secondary">
          Active rules that fit the current project are added to each request — at most ~400 tokens, most relevant first.
          {data && data.pending > 0 ? ` ${data.pending} new signal${data.pending === 1 ? '' : 's'} waiting to be read.` : ''}
        </p>
        <button onClick={() => void exportRules()} className="rounded-lg border border-aico-border px-2 py-1 text-[12px] text-aico-secondary hover:text-aico-primary" data-export>
          Export
        </button>
      </div>
      {note && <p className="text-[12px] text-aico-secondary" data-note>{note}</p>}

      <div className="rounded-lg border border-aico-border-subtle bg-aico-surface p-3">
        <span className="text-[10px] uppercase tracking-wide text-aico-muted">Add a rule yourself</span>
        <div className="mt-1 flex flex-wrap gap-2">
          <input
            value={draft}
            onChange={e => setDraft(e.target.value)}
            placeholder="e.g. Use pnpm, not npm."
            className="min-w-[200px] flex-1 rounded border border-aico-border bg-aico-bg px-2 py-1 text-[12px] text-aico-primary outline-none focus:ring-2 focus:ring-aico-accent/40"
            data-new-rule
          />
          <select value={draftScope} onChange={e => setDraftScope(e.target.value)} className="rounded border border-aico-border bg-aico-bg px-1.5 py-1 text-[11px] text-aico-secondary">
            <option value="global">everywhere</option>
            {project && <option value="project">this project</option>}
            <option value="language:typescript">TypeScript</option>
            <option value="language:python">Python</option>
          </select>
          <button
            disabled={!draft.trim()}
            onClick={() => void act({ action: 'add', text: draft, scope: draftScope }, 'Added and in force.').then(() => setDraft(''))}
            className="rounded-lg bg-aico-accent px-2.5 py-1 text-[12px] font-medium text-white hover:opacity-90 disabled:opacity-40"
          >
            Add
          </button>
        </div>
      </div>

      {rules.length === 0 && (
        <p className="text-[12px] text-aico-muted" data-empty>
          Nothing learned yet. Rate a reply with a note, correct the agent ("use pnpm, not npm"), or edit what it wrote — proposals appear here.
        </p>
      )}
      {proposed > 0 && <h4 className="text-[11px] font-semibold uppercase tracking-wider text-aico-muted">Waiting for you ({proposed})</h4>}
      <ul className="space-y-2">
        {rules.map(r => {
          const text = editing[r.id];
          const applies = data?.applying.includes(r.id);
          return (
            <li key={r.id} className="rounded-lg border border-aico-border-subtle bg-aico-surface p-3" data-rule={r.id} data-status={r.status}>
              <div className="flex flex-wrap items-center gap-2 text-[10px]">
                <span className={`rounded px-1.5 py-0.5 font-medium ${r.status === 'active' ? 'bg-aico-success/15 text-aico-success' : r.status === 'proposed' ? 'bg-aico-warning/15 text-aico-warning' : 'bg-aico-hover text-aico-muted'}`}>
                  {r.status}{r.autoAccepted ? ' (auto)' : ''}
                </span>
                <span className="rounded bg-aico-hover px-1.5 py-0.5 text-aico-muted">{scopeLabel(r.scope, data?.cwd)}</span>
                <span className="rounded bg-aico-hover px-1.5 py-0.5 font-mono text-aico-muted">{r.category} · {r.topic}</span>
                {applies && <span className="text-aico-success" title="Sent with requests in the current project">applies here</span>}
              </div>
              {text !== undefined ? (
                <textarea
                  value={text}
                  rows={2}
                  onChange={e => setEditing(s => ({ ...s, [r.id]: e.target.value }))}
                  className="mt-2 w-full rounded border border-aico-border bg-aico-bg px-2 py-1 text-[12px] text-aico-primary outline-none focus:ring-2 focus:ring-aico-accent/40"
                />
              ) : (
                <p className={`mt-1.5 text-[13px] ${r.status === 'disabled' || r.status === 'superseded' ? 'text-aico-muted line-through' : 'text-aico-primary'}`}>{r.text}</p>
              )}
              {r.replaces?.length ? (
                <p className="mt-1 text-[11px] text-aico-warning">
                  Accepting replaces: {r.replaces.map(id => byId.get(id)?.text ?? id).join(' · ')}
                </p>
              ) : null}
              {r.evidence.length > 0 && (
                <ul className="mt-1.5 space-y-0.5">
                  {r.evidence.map((e, i) => (
                    <li key={i} className="truncate text-[11px] text-aico-muted" title={e.excerpt}>
                      <button
                        className="underline decoration-dotted hover:text-aico-primary"
                        title={`Open the chat (event ${e.seq ?? '?'})`}
                        onClick={() => { void useStore.getState().openSession(e.sessionId); onClose?.(); }}
                      >
                        {KIND_LABEL[e.kind]}
                      </button>
                      {' — '}{e.excerpt}
                    </li>
                  ))}
                </ul>
              )}
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <div className="flex-1" />
                <button onClick={() => void act({ action: 'forget', id: r.id }, 'Forgotten. The same rule will not be proposed again.')} className="rounded-lg px-2 py-1 text-[12px] text-aico-muted hover:text-aico-danger" data-forget>
                  Forget
                </button>
                {text !== undefined ? (
                  <>
                    <button onClick={() => setEditing(s => { const n = { ...s }; delete n[r.id]; return n; })} className="rounded-lg px-2 py-1 text-[12px] text-aico-muted">Cancel</button>
                    <button
                      onClick={() => void act({ action: 'edit', id: r.id, text }).then(() => setEditing(s => { const n = { ...s }; delete n[r.id]; return n; }))}
                      className="rounded-lg border border-aico-border px-2 py-1 text-[12px] text-aico-primary"
                    >
                      Save
                    </button>
                  </>
                ) : r.status !== 'superseded' && (
                  <button onClick={() => setEditing(s => ({ ...s, [r.id]: r.text }))} className="rounded-lg px-2 py-1 text-[12px] text-aico-secondary hover:text-aico-primary" data-edit>
                    Edit
                  </button>
                )}
                {r.status === 'active' && (
                  <button onClick={() => void act({ action: 'disable', id: r.id })} className="rounded-lg px-2 py-1 text-[12px] text-aico-secondary hover:text-aico-primary" data-disable>
                    Disable
                  </button>
                )}
                {r.status === 'disabled' && (
                  <button onClick={() => void act({ action: 'enable', id: r.id })} className="rounded-lg border border-aico-border px-2 py-1 text-[12px] text-aico-primary" data-enable>
                    Enable
                  </button>
                )}
                {r.status === 'proposed' && (
                  <>
                    <button onClick={() => void act({ action: 'disable', id: r.id })} className="rounded-lg px-2 py-1 text-[12px] text-aico-muted" data-decline>
                      Decline
                    </button>
                    <button onClick={() => void act({ action: 'accept', id: r.id })} className="rounded-lg bg-aico-accent px-2.5 py-1 text-[12px] font-medium text-white hover:opacity-90" data-accept>
                      Accept
                    </button>
                  </>
                )}
              </div>
            </li>
          );
        })}
      </ul>
      {(data?.rules ?? []).some(r => r.status === 'superseded') && (
        <button onClick={() => setShowOld(v => !v)} className="text-[11px] text-aico-muted underline decoration-dotted">
          {showOld ? 'Hide replaced rules' : 'Show replaced rules'}
        </button>
      )}
    </section>
  );
}
