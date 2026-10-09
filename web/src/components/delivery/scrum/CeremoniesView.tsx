/**
 * Sprint review and retrospective: a draft built from the log, edited by people, saved.
 *
 * The review draft lists what merged (with each task's evidence summary and its acceptance
 * criteria) and what did not, from the same facts the burndown uses. The retro draft puts
 * the sprint's facts first (cycle time, trips back for changes, flaky checks, waits on a
 * person) and three open questions. Both arrive as markdown in an editor: nothing is
 * posted anywhere, and nothing is saved until a person presses Save.
 *
 * The draft is a read of the log; "Rebuild from the log" fetches a fresh one and replaces
 * the text on screen (the saved copy is untouched until you save). Edit and Preview share
 * one box so the text a person writes is the text they see rendered.
 *
 * @module web/components/delivery/scrum/CeremoniesView
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { MarkdownRenderer } from '../../../../../shared/ui/MarkdownRenderer';
import { api } from '../../../api';
import { duration, rangeWord, type RetroFacts, type Sprint } from '../../../delivery-scrum';
import { BTN_GHOST, BTN_OUTLINE, BTN_PRIMARY, ErrorLine, Skeleton } from '../ui';

type Kind = 'review' | 'retro';

export function CeremoniesView({ project, sprints, onSaved }: { project: string; sprints: readonly Sprint[]; onSaved: (message: string) => void }): React.ReactElement {
  const eligible = useMemo(() => sprints.filter(s => s.status !== 'planned'), [sprints]);
  const [pick, setPick] = useState<string | null>(null);
  const sprint = eligible.find(s => s.id === pick) ?? eligible.find(s => s.status === 'active') ?? eligible.at(-1);
  const [kind, setKind] = useState<Kind>('review');

  if (!sprint) {
    return (
      <div className="mx-auto mt-10 max-w-md px-6 text-center">
        <p className="text-[15px] font-medium text-aico-primary">Review and retro come with a sprint</p>
        <p className="mt-1 text-[13px] leading-relaxed text-aico-secondary">Once a sprint is running you can draft its review from what landed, and a retrospective from how the work went. Both are editable and nothing is shared without you.</p>
      </div>
    );
  }
  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 sm:px-6">
      <div className="mx-auto max-w-3xl space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <div role="radiogroup" aria-label="Document" className="inline-flex rounded-lg bg-aico-hover p-0.5">
            {([['review', 'Sprint review'], ['retro', 'Retrospective']] as const).map(([id, label]) => (
              <button key={id} type="button" role="radio" aria-checked={kind === id} onClick={() => setKind(id)}
                className={`rounded-md px-3 py-1.5 text-[12.5px] transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-aico-accent ${kind === id ? 'bg-aico-bg font-medium text-aico-primary shadow-sm' : 'text-aico-secondary hover:text-aico-primary'}`}>{label}</button>
            ))}
          </div>
          <span className="flex-1" />
          {eligible.length > 1 && (
            <select aria-label="Sprint" value={sprint.id} onChange={e => setPick(e.target.value)} className="rounded-md border border-aico-border bg-aico-bg px-1.5 py-1 text-[12.5px] text-aico-primary">
              {[...eligible].reverse().map(s => <option key={s.id} value={s.id}>{s.name} ({rangeWord(s)})</option>)}
            </select>
          )}
        </div>
        <Doc key={`${sprint.id}:${kind}`} project={project} sprint={sprint} kind={kind} onSaved={onSaved} />
      </div>
    </div>
  );
}

function Doc({ project, sprint, kind, onSaved }: { project: string; sprint: Sprint; kind: Kind; onSaved: (m: string) => void }): React.ReactElement {
  const [loaded, setLoaded] = useState<{ draft: string; saved?: { text: string; at: string }; facts?: RetroFacts } | null>(null);
  const [text, setText] = useState('');
  const [preview, setPreview] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);

  const load = useCallback(async (keepText: boolean): Promise<void> => {
    setError(null);
    try {
      const r = kind === 'review' ? await api.deliverySprintReview(project, sprint.id) : await api.deliverySprintRetro(project, sprint.id);
      setLoaded(r as never);
      if (!keepText) setText(r.saved?.text ?? r.draft);
    } catch (e) { setError((e as Error).message); }
  }, [project, sprint.id, kind]);
  useEffect(() => { void load(false); }, [load]);

  // A draft that was never saved is still saveable as it is; a saved text is dirty only once it differs.
  const reference = loaded?.saved?.text ?? loaded?.draft ?? '';
  const edited = text !== reference;
  const dirty = loaded?.saved ? text !== loaded.saved.text : true;
  const save = async (): Promise<void> => {
    setSaving(true); setError(null);
    try { await api.deliverySaveNotes(project, sprint.id, kind, text); onSaved(`${kind === 'review' ? 'Sprint review' : 'Retrospective'} saved.`); await load(true); }
    catch (e) { setError((e as Error).message); }
    finally { setSaving(false); }
  };

  if (!loaded && !error) return <div className="space-y-2" aria-busy="true"><Skeleton className="h-6 w-48" /><Skeleton className="h-64" /></div>;
  const facts = loaded?.facts;
  return (
    <div className="space-y-3">
      {facts && (
        <dl className="grid grid-cols-2 gap-2 sm:grid-cols-5" aria-label="Sprint facts">
          {([
            ['Delivered', `${facts.completed} / ${facts.committed}`, 'points'],
            ['Back for changes', String(facts.changeRounds), facts.changeRounds === 1 ? 'time' : 'times'],
            ['Flaky checks', String(facts.flakyChecks), 'runs'],
            ['Waited on you', String(facts.needsWaits), facts.needsWaits ? duration(facts.needsWaitMs) : 'no waits'],
            ['Median cycle', facts.cycleMedianMs !== undefined ? duration(facts.cycleMedianMs) : 'n/a', 'run to landing'],
          ] as const).map(([k, v, u]) => (
            <div key={k} className="rounded-lg border border-aico-border-subtle bg-aico-surface px-3 py-2">
              <dt className="text-[11px] text-aico-muted">{k}</dt>
              <dd className="mt-0.5 text-[16px] font-semibold tabular-nums leading-tight text-aico-primary">{v}</dd>
              <dd className="text-[11px] text-aico-muted">{u}</dd>
            </div>
          ))}
        </dl>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <div role="radiogroup" aria-label="View" className="inline-flex rounded-lg bg-aico-hover p-0.5">
          {([['edit', 'Edit'], ['preview', 'Preview']] as const).map(([id, l]) => (
            <button key={id} type="button" role="radio" aria-checked={(id === 'preview') === preview} onClick={() => setPreview(id === 'preview')}
              className={`rounded-md px-2.5 py-1 text-[12px] focus-visible:outline focus-visible:outline-2 focus-visible:outline-aico-accent ${(id === 'preview') === preview ? 'bg-aico-bg font-medium text-aico-primary shadow-sm' : 'text-aico-secondary'}`}>{l}</button>
          ))}
        </div>
        <span className="text-[12px] text-aico-muted" aria-live="polite">
          {edited ? 'Unsaved changes' : loaded?.saved ? `Saved ${new Date(loaded.saved.at).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}` : 'Draft from the log, not saved'}
        </span>
        <span className="flex-1" />
        <button type="button" className={BTN_GHOST} disabled={saving} onClick={() => void load(false)} title="Fetch a fresh draft from the log and replace the text below. The saved copy stays until you save.">Rebuild from the log</button>
        <button type="button" className={BTN_PRIMARY} disabled={saving || !dirty} onClick={() => void save()}>{saving ? 'Saving…' : 'Save'}</button>
      </div>
      {error && <ErrorLine>{error}</ErrorLine>}
      {preview ? (
        <div className="markdown-body min-h-[16rem] rounded-xl border border-aico-border-subtle bg-aico-bg px-5 py-4 text-[13.5px]"><MarkdownRenderer content={text} /></div>
      ) : (
        <textarea
          ref={area} value={text} onChange={e => setText(e.target.value)} spellCheck
          aria-label={kind === 'review' ? 'Sprint review notes' : 'Retrospective notes'}
          className="block min-h-[26rem] w-full resize-y rounded-xl border border-aico-border bg-aico-bg px-4 py-3 font-mono text-[12.5px] leading-relaxed text-aico-primary focus:border-aico-accent focus:outline-none"
        />
      )}
      <p className="text-[12px] text-aico-muted">Markdown. Nothing here is sent anywhere; copy it where your team keeps its notes.</p>
      {!edited && <div className="flex justify-end"><button type="button" className={BTN_OUTLINE} onClick={() => { void navigator.clipboard?.writeText(text); }}>Copy markdown</button></div>}
    </div>
  );
}
