/**
 * Comment threads on an AICO Docs page: loading them, drawing them in the
 * margin beside the words they are about, and the highlight on those words.
 *
 * The highlight uses the CSS Custom Highlight API rather than wrapping the
 * quoted text in elements: the page is drawn by React (and by the chat's
 * renderer inside each block), and a `<mark>` inserted behind React's back
 * would be thrown away on the next render or, worse, confuse its
 * reconciliation. A highlight is a set of Ranges painted by the browser and
 * touches no node. Where the API is missing the threads still work, unlit.
 *
 * Positions come from a plain-text index of the rendered blocks (see
 * `comments.ts` for why anchors are rendered text). Wide panes show threads
 * in a margin column aligned with their text; narrow ones (the VS Code panel,
 * a half-width window) list them in a drawer.
 *
 * @module shared/ui/canvas/DocComments
 */

import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { MarkdownRenderer } from '../MarkdownRenderer';
import { onCanvasActivity, onCanvasComments, onCanvasEvent, type CanvasHost } from './host';
import {
  arrangeComments, awaitingAgent, locateAnchor, makeAnchor, mentionsAgent, stackCards,
  type CanvasComment, type CommentAnchor,
} from './comments';
import { authorLabel, relativeTime } from './core';
import { CvIcon } from './icons';

// ── Loading ──────────────────────────────────────────────────────────

const POLL_MS = 4000;
const POLL_CAP_MS = 120_000;

export interface CommentsState {
  comments: CanvasComment[];
  /** null while unknown; false when this engine has no comment routes. */
  supported: boolean | null;
  error: string | null;
  refresh(): Promise<void>;
  add(input: { tabId: string; anchor: CommentAnchor; body: string; askAgent?: boolean }): Promise<boolean>;
  reply(commentId: string, body: string): Promise<boolean>;
  resolve(commentId: string, resolved: boolean): Promise<boolean>;
}

export function useComments(host: CanvasHost, id: string): CommentsState {
  const [comments, setComments] = useState<CanvasComment[]>([]);
  const [supported, setSupported] = useState<boolean | null>(host.comments ? null : false);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<number | undefined>(undefined);

  const refresh = useCallback(async (): Promise<void> => {
    if (!host.comments) { setSupported(false); return; }
    try {
      const list = await host.comments.list(id);
      setComments(list);
      setSupported(true);
      setError(null);
    } catch (err) {
      const status = (err as { status?: number }).status;
      if (status === 404) setSupported(false);
      else setError(err instanceof Error ? err.message : String(err));
    }
  }, [host, id]);

  useEffect(() => { void refresh(); }, [refresh]);

  // Somebody (usually the agent) answered or resolved a thread, or the text moved under the anchors.
  useEffect(() => {
    const soon = (): void => { window.clearTimeout(timer.current); timer.current = window.setTimeout(() => { void refresh(); }, 300); };
    const offs = [
      onCanvasComments(cid => { if (cid === id) soon(); }),
      onCanvasEvent(c => { if (c.id === id) soon(); }),
      onCanvasActivity(a => { if (a.canvasId === id && a.status === 'done') soon(); }),
    ];
    return () => { offs.forEach(o => o()); window.clearTimeout(timer.current); };
  }, [id, refresh]);

  // Until the engine announces replies, wait for the agent by asking again — briefly.
  const waiting = comments.some(awaitingAgent);
  useEffect(() => {
    if (!waiting) return;
    const since = Date.now();
    const t = window.setInterval(() => {
      if (Date.now() - since > POLL_CAP_MS) { window.clearInterval(t); return; }
      void refresh();
    }, POLL_MS);
    return () => window.clearInterval(t);
  }, [waiting, refresh]);

  const wrap = useCallback(async (fn: () => Promise<unknown>): Promise<boolean> => {
    try { await fn(); await refresh(); return true; } catch (err) { setError(err instanceof Error ? err.message : String(err)); return false; }
  }, [refresh]);

  return {
    comments, supported, error, refresh,
    add: input => wrap(() => host.comments!.add(id, input)),
    reply: (cid, body) => wrap(() => host.comments!.reply(id, cid, body)),
    resolve: (cid, resolved) => wrap(() => host.comments!.resolve(id, cid, resolved)),
  };
}

// ── The page's text, for anchors ─────────────────────────────────────

export interface TextIndex { text: string; nodes: Array<{ node: Text; start: number }> }

const SKIP = 'button, [data-adoc-ui], .katex-mathml, .adoc-pending, textarea, [contenteditable="true"], .adoc-agent-label';

/** The rendered text of the page's blocks, one line break between blocks. */
export function buildIndex(root: HTMLElement): TextIndex {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: n => (n.parentElement?.closest(SKIP) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  let text = '';
  const nodes: TextIndex['nodes'] = [];
  let lastBlock: Element | null = null;
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const block = n.parentElement?.closest('[data-block]') ?? null;
    if (!block) continue;
    if (lastBlock && block !== lastBlock) text += '\n';
    lastBlock = block;
    nodes.push({ node: n as Text, start: text.length });
    text += n.nodeValue ?? '';
  }
  return { text, nodes };
}

function pointAt(index: TextIndex, offset: number, end: boolean): [Text, number] | null {
  for (const { node, start } of index.nodes) {
    const len = node.nodeValue?.length ?? 0;
    if (offset < start) return [node, 0];
    if (offset < start + len || (end && offset === start + len)) return [node, offset - start];
  }
  const last = index.nodes[index.nodes.length - 1];
  return last ? [last.node, last.node.nodeValue?.length ?? 0] : null;
}

/** The DOM Range for `[start, end)` of the index's text. */
export function rangeFor(index: TextIndex, start: number, end: number): Range | null {
  const a = pointAt(index, start, false);
  const b = pointAt(index, end, true);
  if (!a || !b) return null;
  const r = document.createRange();
  try { r.setStart(a[0], a[1]); r.setEnd(b[0], b[1]); } catch { return null; }
  return r;
}

function offsetOf(index: TextIndex, container: Node, offset: number): number | null {
  const probe = document.createRange();
  try { probe.setStart(container, offset); } catch { return null; }
  for (const { node, start } of index.nodes) {
    if (node === container) return start + offset;
    // The first indexed text at or after the boundary.
    if (probe.comparePoint(node, 0) >= 0) return start;
  }
  return index.text.length;
}

/** An anchor for the current selection on the page, or null when it is not on the page's text. */
export function anchorForSelection(root: HTMLElement): CommentAnchor | null {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
  const r = sel.getRangeAt(0);
  if (!root.contains(r.commonAncestorContainer)) return null;
  const index = buildIndex(root);
  const a = offsetOf(index, r.startContainer, r.startOffset);
  const b = offsetOf(index, r.endContainer, r.endOffset);
  if (a === null || b === null || b <= a) return null;
  const anchor = makeAnchor(index.text, a, b);
  return anchor.quote.trim() ? anchor : null;
}

// ── Highlights ───────────────────────────────────────────────────────

interface HighlightRegistryLike { set(name: string, h: unknown): void; delete(name: string): void }
const registry = (): HighlightRegistryLike | null =>
  (typeof CSS !== 'undefined' && (CSS as unknown as { highlights?: HighlightRegistryLike }).highlights) || null;
const HighlightCtor = (): (new (...r: Range[]) => unknown) | null =>
  (typeof window !== 'undefined' && (window as unknown as { Highlight?: new (...r: Range[]) => unknown }).Highlight) || null;

const painted = new Map<string, { all: Range[]; active: Range[] }>();
function repaint(): void {
  const reg = registry();
  const H = HighlightCtor();
  if (!reg || !H) return;
  const all = [...painted.values()].flatMap(p => p.all);
  const active = [...painted.values()].flatMap(p => p.active);
  reg.set('aico-comment', new H(...all));
  reg.set('aico-comment-active', new H(...active));
}

// ── Drawing the threads ──────────────────────────────────────────────

export interface Composer { anchor: CommentAnchor; top: number }

export function CommentLayer({
  state, page, sheet, tabId, text, wide, drawerOpen, onCloseDrawer, composer, onComposerDone, activeId, onActivate, showResolved,
  onToggleResolved, instance,
}: {
  state: CommentsState; page: HTMLElement | null; sheet: HTMLElement | null; tabId: string; text: string;
  wide: boolean; drawerOpen: boolean; onCloseDrawer: () => void;
  composer: Composer | null; onComposerDone: () => void; activeId: string | null; onActivate: (id: string | null) => void;
  showResolved: boolean; onToggleResolved: () => void; instance: string;
}): React.ReactElement | null {
  const mine = state.comments.filter(c => (c.tabId ?? 't1') === tabId);
  const visible = mine.filter(c => showResolved || !c.resolved);
  const [positions, setPositions] = useState<Record<string, number>>({});
  const cards = useRef(new Map<string, HTMLDivElement>());
  const composerCard = useRef<HTMLDivElement | null>(null);
  const [, bump] = useState(0);

  // Where each thread's words are now, and the highlight on them.
  useLayoutEffect(() => {
    if (!page || !sheet) return;
    const index = buildIndex(page);
    const sheetTop = sheet.getBoundingClientRect().top;
    const next: Record<string, number> = {};
    const all: Range[] = [];
    const active: Range[] = [];
    for (const c of visible) {
      if (c.orphaned) continue;
      const at = locateAnchor(index.text, c.anchor);
      const r = at && rangeFor(index, at.start, at.end);
      if (!r) continue;
      const rect = r.getClientRects()[0] ?? r.getBoundingClientRect();
      next[c.id] = rect.top - sheetTop;
      if (!c.resolved) (c.id === activeId ? active : all).push(r);
    }
    painted.set(instance, { all, active });
    repaint();
    setPositions(prev => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next));
  });
  useEffect(() => () => { painted.delete(instance); repaint(); }, [instance]);

  // Re-measure when the page reflows (images and charts arrive after the text).
  useEffect(() => {
    if (!page || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => bump(n => n + 1));
    ro.observe(page);
    return () => ro.disconnect();
  }, [page]);

  const { placed, orphans } = arrangeComments(visible, c => positions[c.id] ?? null);

  // Stack the margin cards so they never overlap, each as near its words as it can be.
  useLayoutEffect(() => {
    if (!wide) return;
    const items: Array<{ el: HTMLElement; want: number }> = [];
    for (const p of placed) {
      const el = cards.current.get(p.comment.id);
      if (el) items.push({ el, want: p.at });
    }
    if (composer && composerCard.current) items.push({ el: composerCard.current, want: composer.top });
    items.sort((a, b) => a.want - b.want);
    const tops = stackCards(items.map(i => i.want), items.map(i => i.el.offsetHeight));
    items.forEach((it, i) => { it.el.style.top = `${tops[i]}px`; });
  });

  if (state.supported === false) return null;

  const thread = (c: CanvasComment, quote: boolean): React.ReactElement => (
    <Thread key={c.id} comment={c} state={state} active={c.id === activeId} quote={quote}
      onActivate={() => onActivate(c.id === activeId ? null : c.id)}
      refEl={(el) => { if (el) cards.current.set(c.id, el); else cards.current.delete(c.id); }} />
  );

  const composerEl = composer && (
    <NewComment key="new" anchor={composer.anchor} refEl={(el) => { composerCard.current = el; }}
      onPost={async (body, askAgent) => {
        const ok = await state.add({ tabId, anchor: composer.anchor, body, askAgent });
        if (ok) onComposerDone();
        return ok;
      }}
      onCancel={onComposerDone} />
  );

  const resolvedCount = mine.filter(c => c.resolved).length;

  if (wide) {
    return (
      <>
        <div className="adoc-margin" data-adoc-ui aria-label="Comments">
          {placed.map(p => thread(p.comment, false))}
          {composerEl}
        </div>
        {(orphans.length > 0 || resolvedCount > 0) && (
          <OrphanList orphans={orphans} thread={thread} resolvedCount={resolvedCount} showResolved={showResolved} onToggleResolved={onToggleResolved} />
        )}
      </>
    );
  }

  return (
    <>
      {(drawerOpen || composer) && (
        <aside className="adoc-drawer" data-adoc-ui aria-label="Comments">
          <div className="acv-history-head">
            <CvIcon name="comment" size={14} /> Comments
            <span className="aw-grow" />
            {resolvedCount > 0 && (
              <button type="button" className="aw-btn adoc-mini" onClick={onToggleResolved}>{showResolved ? 'Hide' : 'Show'} resolved ({resolvedCount})</button>
            )}
            <button type="button" className="aw-icon-btn" onClick={() => { onCloseDrawer(); onComposerDone(); }} aria-label="Close comments"><CvIcon name="close" size={14} /></button>
          </div>
          <div className="adoc-drawer-list">
            {composerEl}
            {placed.map(p => thread(p.comment, true))}
            {orphans.length > 0 && <div className="adoc-orphans-head">On text that has changed</div>}
            {orphans.map(c => thread(c, true))}
            {!composer && visible.length === 0 && (
              <p className="adoc-empty-note">No comments yet. Select text on the page and choose <b>Comment</b>. Mention <b>@AICO</b> to ask the agent.</p>
            )}
          </div>
        </aside>
      )}
      {!drawerOpen && state.error && <div className="adoc-comment-error" data-adoc-ui>{state.error}</div>}
    </>
  );
}

function OrphanList({ orphans, thread, resolvedCount, showResolved, onToggleResolved }: {
  orphans: CanvasComment[]; thread: (c: CanvasComment, quote: boolean) => React.ReactElement;
  resolvedCount: number; showResolved: boolean; onToggleResolved: () => void;
}): React.ReactElement {
  return (
    <section className="adoc-orphans" data-adoc-ui aria-label="Other comments">
      {orphans.length > 0 && <div className="adoc-orphans-head">Comments on text that has changed</div>}
      <div className="adoc-orphans-list">{orphans.map(c => thread(c, true))}</div>
      {resolvedCount > 0 && (
        <button type="button" className="aw-btn adoc-mini" onClick={onToggleResolved}>{showResolved ? 'Hide' : 'Show'} resolved comments ({resolvedCount})</button>
      )}
    </section>
  );
}

function Body({ text, author }: { text: string; author: 'user' | 'agent' }): React.ReactElement {
  if (author === 'agent') return <div className="adoc-msg-body is-md"><MarkdownRenderer content={text} /></div>;
  const parts = text.split(/(@aico\b)/i);
  return <p className="adoc-msg-body">{parts.map((p, i) => (/^@aico$/i.test(p) ? <span key={i} className="adoc-mention">{p}</span> : p))}</p>;
}

function Thread({ comment: c, state, active, quote, onActivate, refEl }: {
  comment: CanvasComment; state: CommentsState; active: boolean; quote: boolean; onActivate: () => void;
  refEl: (el: HTMLDivElement | null) => void;
}): React.ReactElement {
  const [reply, setReply] = useState('');
  const [busy, setBusy] = useState(false);
  const waiting = awaitingAgent(c);
  const send = async (): Promise<void> => {
    if (!reply.trim()) return;
    setBusy(true);
    if (await state.reply(c.id, reply.trim())) setReply('');
    setBusy(false);
  };
  return (
    <div ref={refEl} className={`adoc-thread${active ? ' is-active' : ''}${c.resolved ? ' is-resolved' : ''}`} data-comment-id={c.id}
      onClick={(e) => { if (!(e.target as HTMLElement).closest('textarea, button, a')) onActivate(); }}>
      {quote && <div className="adoc-thread-quote">“{c.anchor.quote.slice(0, 140)}{c.anchor.quote.length > 140 ? '…' : ''}”</div>}
      <div className="adoc-msg">
        <div className="adoc-msg-top">
          <span className={`acv-who is-${c.author}`}>{authorLabel(c.author)}</span>
          <span className="aw-muted">{relativeTime(c.createdAt)}</span>
          <span className="aw-grow" />
          <button type="button" className="aw-icon-btn adoc-resolve" onClick={() => { void state.resolve(c.id, !c.resolved); }}
            title={c.resolved ? 'Reopen' : 'Resolve'} aria-label={c.resolved ? 'Reopen comment' : 'Resolve comment'}>
            <CvIcon name={c.resolved ? 'restore' : 'check'} size={13} />
          </button>
        </div>
        <Body text={c.body} author={c.author} />
      </div>
      {c.replies.map(r => (
        <div key={r.id} className="adoc-msg is-reply">
          <div className="adoc-msg-top">
            <span className={`acv-who is-${r.author}`}>{authorLabel(r.author)}</span>
            <span className="aw-muted">{relativeTime(r.createdAt)}</span>
          </div>
          <Body text={r.body} author={r.author} />
        </div>
      ))}
      {waiting && <div className="adoc-waiting"><CvIcon name="sparkle" size={12} /> AICO is looking at this…</div>}
      {!c.resolved && (
        <form className="adoc-reply" onSubmit={(e) => { e.preventDefault(); void send(); }}>
          <textarea value={reply} rows={1} placeholder="Reply — @AICO to ask the agent" aria-label="Reply"
            onChange={e => setReply(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void send(); } }} />
          {reply.trim() && <button type="submit" className="aw-btn is-primary adoc-mini" disabled={busy}>Reply</button>}
        </form>
      )}
    </div>
  );
}

function NewComment({ anchor, onPost, onCancel, refEl }: {
  anchor: CommentAnchor; onPost: (body: string, askAgent: boolean) => Promise<boolean>; onCancel: () => void;
  refEl: (el: HTMLDivElement | null) => void;
}): React.ReactElement {
  const [body, setBody] = useState('');
  const [ask, setAsk] = useState(false);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => { input.current?.focus({ preventScroll: true }); }, []);
  const asks = ask || mentionsAgent(body);
  const post = async (): Promise<void> => {
    if (!body.trim()) return;
    setBusy(true);
    await onPost(body.trim(), ask);
    setBusy(false);
  };
  return (
    <div ref={refEl} className="adoc-thread is-new" role="dialog" aria-label="New comment">
      <div className="adoc-thread-quote">“{anchor.quote.slice(0, 140)}{anchor.quote.length > 140 ? '…' : ''}”</div>
      <textarea ref={input} value={body} rows={3} placeholder="Add a comment — @AICO to ask the agent" aria-label="Comment"
        onChange={e => setBody(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void post(); }
          if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
        }} />
      <div className="adoc-new-row">
        <label className="adoc-ask-check">
          <input type="checkbox" checked={ask} onChange={e => setAsk(e.target.checked)} /> Ask AICO
        </label>
        <span className="aw-grow" />
        <button type="button" className="aw-btn adoc-mini" onClick={onCancel}>Cancel</button>
        <button type="button" className="aw-btn is-primary adoc-mini" disabled={!body.trim() || busy} onClick={() => { void post(); }}>
          {asks ? 'Send to AICO' : 'Comment'}
        </button>
      </div>
    </div>
  );
}
