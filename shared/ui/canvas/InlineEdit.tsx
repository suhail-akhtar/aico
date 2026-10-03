/**
 * The inline "Ask AICO" panel: one part of the page (a selection, a block, a
 * table's cells, a chart, a diagram, a section) edited by AICO in place,
 * reviewed as a diff, accepted as one undoable change. ADR 0024.
 *
 * ## Why a panel in the page, not a chat message
 *
 * The 0.30 "Ask AI" sent a chat message and let the agent edit the canvas
 * with whatever it chose; the person saw the result only after it landed,
 * and nothing held the agent to the passage. Here the engine answers with a
 * validated proposal for exactly the targeted part (`/api/canvas/edit-part`,
 * nothing written) and this panel shows it where the part is: words struck
 * and inserted for text, cells marked for a table, before and after drawn
 * for a chart or diagram. Accept applies it through the same span rule every
 * block edit uses (`applyPart` — nothing outside the part can change) and
 * saves it as one version with a note, so the version history can restore
 * it and the page's Undo can take it back.
 *
 * Follow-ups ("shorter still") stay on the same part: the thread is sent
 * with each request, and the engine validates the last proposal against the
 * ORIGINAL text under every instruction in the thread.
 *
 * A diagram is additionally parsed by the real Mermaid in the browser before
 * it can be accepted (the engine's check is syntax only); a failure is sent
 * back once as `retryError`, then shown.
 *
 * Deliberately not here: streaming the proposal word by word. The answer is
 * a JSON patch that cannot be validated (or shown honestly) until complete,
 * and parts are small; a spinner with Cancel is the honest progress.
 *
 * @module shared/ui/canvas/InlineEdit
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { MarkdownRenderer } from '../MarkdownRenderer';
import { mermaidParseError } from '../Diagram';
import type { CanvasHost } from './host';
import {
  partActions, resolveTarget, type PartAction, type PartEditResponse, type PartPatch, type PartTarget, type ResolvedPart,
} from './scoped-edit';
import { diffStats, tableDiff, wordDiff, type DiffPart } from './scoped-diff';
import { parseFence, parseTable } from './visual';
import { CvIcon } from './icons';
import './inline-edit.css';

/** One way to scope the edit, offered as a chip ("Selection", "Paragraph", "Whole section"). */
export interface InlineScope { label: string; target: Pick<PartTarget, 'blockIds' | 'range' | 'cells' | 'part'> }

export interface InlineAccept {
  part: NonNullable<PartEditResponse['part']>;
  after: string;
  instruction: string;
  note?: string;
}

export interface InlineEditProps {
  host: CanvasHost;
  canvasId: string;
  tabId?: string;
  getText: () => string;
  scopes: InlineScope[];
  /** Run this instruction at once (a quick action chosen from a block menu). */
  autoRun?: string;
  /** Save pending edits first, so the engine edits what the person sees. */
  saveFirst: () => Promise<boolean>;
  /** Apply an accepted proposal; returns an error to show, or null. */
  onAccept: (a: InlineAccept) => string | null;
  /** The proposal is on screen (the page hides the original part while it is). */
  onReviewing: (reviewing: boolean) => void;
  onScope: (scope: InlineScope) => void;
  onClose: () => void;
}

type Turn = { instruction: string; patch?: PartPatch };
type Phase =
  | { at: 'compose' }
  | { at: 'running'; instruction: string; checking?: boolean }
  | { at: 'review'; instruction: string; res: PartEditResponse }
  | { at: 'error'; instruction: string; message: string; details: string[] };

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function InlineEdit(props: InlineEditProps): React.ReactElement {
  const { host, canvasId, tabId, getText, scopes, autoRun, saveFirst, onAccept, onReviewing, onScope, onClose } = props;
  const [scopeIx, setScopeIx] = useState(0);
  const scope = scopes[Math.min(scopeIx, scopes.length - 1)]!;
  const [phase, setPhase] = useState<Phase>({ at: 'compose' });
  const [thread, setThread] = useState<Turn[]>([]);
  const [value, setValue] = useState('');
  const input = useRef<HTMLInputElement | null>(null);
  const box = useRef<HTMLDivElement | null>(null);
  const abort = useRef<AbortController | null>(null);
  const started = useRef(false);

  // The part as the editor reads it — for its label, its quick actions and the diff's "before".
  const resolved = useMemo((): { ok: true; part: ResolvedPart } | { ok: false; error: string } => resolveTarget(getText(), scope.target),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [scope]);
  const actions: PartAction[] = resolved.ok ? partActions(resolved.part) : [];

  useEffect(() => { onReviewing(phase.at === 'review'); }, [phase.at, onReviewing]);
  useEffect(() => () => { abort.current?.abort(); }, []);
  useEffect(() => { if (phase.at === 'compose' || phase.at === 'review') input.current?.focus({ preventScroll: true }); }, [phase.at]);
  useEffect(() => { box.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }, [phase.at]);

  const run = useCallback(async (instruction: string, opts: { history?: Turn[]; retryError?: string } = {}): Promise<void> => {
    const text = instruction.trim();
    if (!text || !host.editPart) return;
    abort.current?.abort();
    const ac = new AbortController();
    abort.current = ac;
    setPhase({ at: 'running', instruction: text });
    setValue('');
    const history = opts.history ?? thread;
    try {
      if (!(await saveFirst())) throw new Error('your latest changes could not be saved first — try again in a moment');
      let res = await host.editPart(canvasId, {
        ...(tabId ? { tab: tabId } : {}), target: scope.target, instruction: text,
        ...(history.length ? { history } : {}), ...(opts.retryError ? { retryError: opts.retryError } : {}),
      }, ac.signal);
      if (ac.signal.aborted) return;
      // The real Mermaid parser gets the last word on a diagram, once, before the person sees it.
      if (res.ok && res.after && !opts.retryError) {
        const bad = await diagramProblem(res.after);
        if (bad && !ac.signal.aborted) {
          setPhase({ at: 'running', instruction: text, checking: true });
          res = await host.editPart(canvasId, {
            ...(tabId ? { tab: tabId } : {}), target: scope.target, instruction: text,
            history: [...history, { instruction: text, ...(res.patch ? { patch: res.patch } : {}) }], retryError: `Mermaid could not parse the diagram: ${bad}`,
          }, ac.signal);
          if (ac.signal.aborted) return;
          const still = res.ok && res.after ? await diagramProblem(res.after) : null;
          if (still) res = { ...res, ok: false, error: `the diagram still does not parse: ${still}`, errors: [still] };
        }
      }
      if (!res.ok || res.after === undefined || !res.part) {
        setPhase({ at: 'error', instruction: text, message: res.error ?? 'AICO could not make that edit', details: res.errors ?? [] });
        return;
      }
      setThread([...history, { instruction: text, ...(res.patch ? { patch: res.patch } : {}) }]);
      setPhase({ at: 'review', instruction: text, res });
    } catch (err) {
      if (ac.signal.aborted) return;
      setPhase({ at: 'error', instruction: text, message: message(err), details: [] });
    }
  }, [host, canvasId, tabId, scope, thread, saveFirst]);

  useEffect(() => {
    if (autoRun && !started.current) { started.current = true; void run(autoRun, { history: [] }); }
  }, [autoRun, run]);

  const accept = (): void => {
    if (phase.at !== 'review' || !phase.res.part || phase.res.after === undefined) return;
    const err = onAccept({ part: phase.res.part, after: phase.res.after, instruction: thread.map(t => t.instruction).join(' → '), ...(phase.res.note ? { note: phase.res.note } : {}) });
    if (err) setPhase({ at: 'error', instruction: phase.instruction, message: err, details: [] });
  };

  const cancel = (): void => {
    abort.current?.abort();
    setPhase(thread.length ? { at: 'compose' } : { at: 'compose' });
  };

  const submit = (): void => {
    const v = value.trim();
    if (!v) return;
    // In review, a typed line refines the proposal; otherwise it starts the thread.
    void run(v, { history: phase.at === 'review' ? thread : [] });
  };

  const tryAgain = (): void => {
    const last = phase.at === 'review' || phase.at === 'error' ? phase.instruction : thread[thread.length - 1]?.instruction;
    if (!last) return;
    // The same instruction, from the state before it.
    const prior = phase.at === 'review' ? thread.slice(0, -1) : thread;
    setThread(prior);
    void run(last, { history: prior });
  };

  const pickAction = (a: PartAction): void => {
    if (a.ask) {
      setValue(a.instruction);
      requestAnimationFrame(() => { const el = input.current; if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); } });
      return;
    }
    void run(a.instruction, { history: phase.at === 'review' ? thread : [] });
  };

  const onKey = (e: React.KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      if (phase.at === 'running') cancel(); else onClose();
    } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && phase.at === 'review') {
      e.preventDefault();
      accept();
    }
  };

  const busy = phase.at === 'running';
  const reviewing = phase.at === 'review' ? phase : null;
  const label = resolved.ok ? resolved.part.label : 'This part';
  const sel = resolved.ok && resolved.part.selection ? resolved.part.editable.slice(resolved.part.selection.start, resolved.part.selection.end) : '';
  const noun = !resolved.ok ? 'part' : sel ? 'selected words' : resolved.part.kind === 'cells' ? 'selected cells' : resolved.part.what;

  return (
    <div ref={box} className={`aie${reviewing ? ' is-review' : ''}`} data-adoc-ui data-adoc-keep-focus role="dialog" aria-label={`Ask AICO to edit: ${label}`} onKeyDown={onKey}>
      {reviewing && reviewing.res.part && reviewing.res.after !== undefined && (
        <Proposal part={reviewing.res.part} after={reviewing.res.after} />
      )}
      <div className="aie-card">
        <div className="aie-head">
          <CvIcon name="sparkle" size={14} className="aie-spark" />
          {scopes.length > 1 && !busy && !reviewing ? (
            <span className="aie-scopes" role="radiogroup" aria-label="What to edit">
              {scopes.map((s, i) => (
                <button key={s.label} type="button" role="radio" aria-checked={i === scopeIx} className={i === scopeIx ? 'is-on' : ''}
                  onClick={() => { setScopeIx(i); setThread([]); onScope(s); }}>{s.label}</button>
              ))}
            </span>
          ) : <span className="aie-label">{label}</span>}
          <span className="aw-grow" />
          {reviewing && <span className="aie-meta" title={reviewing.res.model ? `${reviewing.res.model}${reviewing.res.costUsd ? ` · $${reviewing.res.costUsd.toFixed(4)}` : ''}` : undefined}>{summary(reviewing.res)}</span>}
          <button type="button" className="aw-icon-btn aie-x" onClick={onClose} aria-label="Close" title="Close (Esc)"><CvIcon name="close" size={13} /></button>
        </div>

        {thread.length > 0 && (reviewing || busy) && (
          <ol className="aie-thread" aria-label="This edit so far">
            {thread.map((t, i) => <li key={i}>{t.instruction}</li>)}
            {busy && phase.instruction !== thread[thread.length - 1]?.instruction && <li className="is-now">{phase.instruction}</li>}
          </ol>
        )}

        {!resolved.ok ? (
          <p className="aie-error" role="alert"><CvIcon name="warn" size={13} /> {resolved.error}</p>
        ) : busy ? (
          <div className="aie-busy" role="status" aria-live="polite">
            <span className="aie-dots" aria-hidden="true"><i /><i /><i /></span>
            <span>{phase.checking ? 'Checking the diagram and asking again…' : `AICO is editing the ${resolved.part.what}…`}</span>
            <span className="aw-grow" />
            <button type="button" className="aw-btn adoc-mini" onClick={cancel}>Cancel</button>
          </div>
        ) : phase.at === 'error' ? (
          <div className="aie-error" role="alert">
            <p><CvIcon name="warn" size={13} /> {phase.message}</p>
            {phase.details.length > 1 && <ul>{phase.details.slice(0, 4).map(d => <li key={d}>{d}</li>)}</ul>}
            <div className="aie-actions">
              <button type="button" className="aw-btn is-primary adoc-mini" onClick={tryAgain}>Try again</button>
              <button type="button" className="aw-btn adoc-mini" onClick={() => { setValue(phase.instruction); setPhase({ at: 'compose' }); }}>Edit instruction</button>
            </div>
          </div>
        ) : reviewing ? (
          <>
            {reviewing.res.note && <p className="aie-note">{reviewing.res.note}</p>}
            {reviewing.res.warnings.length > 0 && (
              <ul className="aie-warn">{reviewing.res.warnings.map(w => <li key={w}><CvIcon name="warn" size={12} /> {w}</li>)}</ul>
            )}
            <div className="aie-actions">
              <button type="button" className="aw-btn is-primary" onClick={accept} disabled={reviewing.res.unchanged} title="Accept (Ctrl+Enter)">
                <CvIcon name="check" size={13} /> Accept
              </button>
              <button type="button" className="aw-btn" onClick={onClose} title="Reject (Esc)">Reject</button>
              <button type="button" className="aw-btn" onClick={tryAgain} title="Ask for another version of the same edit"><CvIcon name="redo" size={12} /> Try again</button>
              <button type="button" className="aw-btn" onClick={() => { setValue(reviewing.instruction); setThread(thread.slice(0, -1)); setPhase({ at: 'compose' }); }}>Edit instruction</button>
            </div>
          </>
        ) : null}

        {resolved.ok && !busy && phase.at !== 'error' && (
          <>
            {sel && !reviewing && <p className="acv-ask-quote aie-quote">“{sel.length > 240 ? `${sel.slice(0, 240)}…` : sel}”</p>}
            <form className="acv-ask-row aie-row" onSubmit={(e) => { e.preventDefault(); submit(); }}>
              <input ref={input} value={value} onChange={e => setValue(e.target.value)} aria-label="Instruction"
                placeholder={reviewing ? 'Refine it — e.g. “shorter still”, “keep the first sentence”' : `How should AICO change the ${noun}?`} />
              <button type="submit" className="acv-ask-send" disabled={!value.trim()} aria-label="Send"><CvIcon name="send" size={15} /></button>
            </form>
            {!reviewing && (
              <div className="acv-ask-chips aie-chips">
                {actions.map(a => <button key={a.id} type="button" className="aw-chip" onClick={() => pickAction(a)}>{a.label}</button>)}
              </div>
            )}
            {!reviewing && <div className="acv-ask-hint">Only the {noun} {/s$/.test(noun) ? 'change' : 'changes'}; nothing else in the document can. You review the edit before it is applied.</div>}
          </>
        )}
      </div>
    </div>
  );
}

function summary(res: PartEditResponse): string {
  if (res.unchanged) return 'No change needed';
  if (!res.part || res.after === undefined) return '';
  const k = res.part.kind;
  if (k === 'table' || k === 'cells') {
    const a = parseTable(res.part.before);
    const b = parseTable(res.after);
    if (a && b) {
      const d = tableDiff(a, b);
      const changed = d.rows.reduce((n, r) => n + r.cells.filter(c => c.state === 'changed').length, 0) + d.header.filter(h => h.state === 'changed').length;
      const bits = [
        changed ? `${changed} cell${changed === 1 ? '' : 's'} changed` : '',
        d.header.some(h => h.state === 'added') ? `${d.header.filter(h => h.state === 'added').length} column(s) added` : '',
        d.rows.some(r => r.state === 'added') ? `${d.rows.filter(r => r.state === 'added').length} row(s) added` : '',
        d.rows.some(r => r.state === 'moved') ? 'rows reordered' : '',
        d.removedRows.length ? `${d.removedRows.length} row(s) removed` : '',
      ].filter(Boolean);
      return bits.join(' · ') || 'Formatting only';
    }
  }
  if (k === 'chart' || k === 'mermaid') return 'Before and after';
  const s = diffStats(wordDiff(res.part.before, res.after));
  return `${s.removed} word${s.removed === 1 ? '' : 's'} out · ${s.added} in`;
}

async function diagramProblem(after: string): Promise<string | null> {
  const f = parseFence(after.trim());
  if (!f || f.lang !== 'mermaid') return null;
  return mermaidParseError(f.body);
}

/** The proposal, drawn where the part is: a diff for words, cells for a table, before/after for a drawing. */
function Proposal({ part, after }: { part: NonNullable<PartEditResponse['part']>; after: string }): React.ReactElement {
  const [view, setView] = useState<'changes' | 'result'>('changes');
  const k = part.kind;
  const drawn = k === 'chart' || k === 'mermaid' || ((k === 'blocks') && /```(?:chart|mermaid)/.test(after) && !/```(?:chart|mermaid)/.test(part.before));
  if (drawn) {
    return (
      <div className="aie-proposal is-drawn" aria-label="Proposed change">
        <div className="aie-side">
          <div className="aie-side-head">Before</div>
          <div className="markdown-body"><MarkdownRenderer content={part.before} /></div>
        </div>
        <div className="aie-side is-after">
          <div className="aie-side-head">After</div>
          <div className="markdown-body"><MarkdownRenderer content={after} /></div>
        </div>
      </div>
    );
  }
  const ta = k === 'table' || k === 'cells' ? parseTable(part.before) : null;
  const tb = ta ? parseTable(after) : null;
  return (
    <div className="aie-proposal" aria-label="Proposed change">
      <div className="aie-tabs" role="tablist">
        <button type="button" role="tab" aria-selected={view === 'changes'} className={view === 'changes' ? 'is-on' : ''} onClick={() => setView('changes')}>Changes</button>
        <button type="button" role="tab" aria-selected={view === 'result'} className={view === 'result' ? 'is-on' : ''} onClick={() => setView('result')}>Result</button>
      </div>
      {view === 'result' ? (
        <div className="markdown-body aie-result"><MarkdownRenderer content={after} /></div>
      ) : ta && tb ? (
        <TableChanges a={ta} b={tb} />
      ) : (
        <WordChanges parts={wordDiff(part.before, after)} />
      )}
    </div>
  );
}

function WordChanges({ parts }: { parts: DiffPart[] }): React.ReactElement {
  return (
    <div className="aie-words">
      {parts.map((p, i) => (p.op === '=' ? <span key={i}>{p.text}</span>
        : p.op === '-' ? <del key={i} className="aie-del">{p.text}</del>
          : <ins key={i} className="aie-ins">{p.text}</ins>))}
    </div>
  );
}

function TableChanges({ a, b }: { a: import('./visual').TableModel; b: import('./visual').TableModel }): React.ReactElement {
  const d = tableDiff(a, b);
  return (
    <div className="aie-table-wrap">
      <table className="aie-table">
        <thead>
          <tr>{d.header.map((h, i) => <th key={i} className={`is-${h.state}`} title={h.was !== undefined ? `Was: ${h.was}` : undefined}>{h.text}</th>)}</tr>
        </thead>
        <tbody>
          {d.rows.map((r, i) => (
            <tr key={i} className={`is-${r.state}`}>
              {r.cells.map((c, j) => (
                <td key={j} className={`is-${c.state}`} title={c.was !== undefined ? `Was: ${c.was || '(empty)'}` : undefined}>
                  {c.state === 'changed' && c.was ? <><del className="aie-del">{c.was}</del> <ins className="aie-ins">{c.text}</ins></> : c.text}
                </td>
              ))}
            </tr>
          ))}
          {d.removedRows.map((r, i) => (
            <tr key={`x${i}`} className="is-removed">{r.map((c, j) => <td key={j}><del className="aie-del">{c}</del></td>)}</tr>
          ))}
        </tbody>
      </table>
      {d.removedColumns.length > 0 && <p className="aie-note">Removed column{d.removedColumns.length === 1 ? '' : 's'}: {d.removedColumns.join(', ')}</p>}
    </div>
  );
}
