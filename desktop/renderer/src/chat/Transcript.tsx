/**
 * The conversation, turn by turn.
 *
 * Built from the same projection every AICO client uses — the shared reducer's
 * `composeMessages`, edit versions and widget-fix pairing from `web/src` — and
 * drawn the desktop's way: your message as a soft bubble on the right, the
 * agent's work folded under a single "Worked for…" line, and its answer as
 * prose with every widget, chart, formula and diagram the shared renderers
 * draw. Actions sit under each answer: copy (Markdown and rich), rate, retry,
 * branch, export.
 *
 * @module desktop/renderer/chat/Transcript
 */

import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { MessageBubble, type ChatMessage } from '@aico/ui';
import { useStore } from '@web/store';
import { composeMessages } from '@web/reduce';
import { applyVersions, editMarker, seqOf, stripEditMarker } from '@web/message-versions';
import { collectWidgetFixes, fixMarker, widgetHash } from '@web/widget-fixes';
import { widgetById } from '@aico/shared/widgets/catalog';
import { useDesk, toast } from '@/state/desk';
import { Icon } from '@/lib/icons';
import { cls, duration } from '@/lib/util';
import { copyRich, snapshotNode, standaloneHtml } from '@/lib/rich';
import { desktop } from '@/desktop';
import { groupTurns, currentActivity, type Turn } from './turns';
import { ChangesCard } from './ChangesCard';

const FOLLOW_PX = 140;

/**
 * One projection per change, however many components ask. The transcript, the
 * plan card and the task strip all read it; recomputing it three times per
 * streamed chunk was measurable on long chats.
 */
let composedCache: { logged: unknown; draft: unknown; busy: boolean; value: ChatMessage[] } | null = null;
function composeOnce(logged: Parameters<typeof composeMessages>[0], draft: Parameters<typeof composeMessages>[1], busy: boolean): ChatMessage[] {
  if (composedCache && composedCache.logged === logged && composedCache.draft === draft && composedCache.busy === busy) return composedCache.value;
  const value = composeMessages(logged, draft, busy);
  composedCache = { logged, draft, busy, value };
  return value;
}

export function useTranscript(): {
  messages: ChatMessage[];
  versions: Map<string, { total: number; current: number; originalSeq: number }>;
  setVersion: (originalSeq: number, version: number) => void;
  widgetFixes: { replaced: (s: string) => string | undefined; superseded: (s: string) => boolean };
} {
  const logged = useStore(s => s.logged);
  const draft = useStore(s => s.draft);
  const busy = useStore(s => s.busy);
  const composed = useMemo(() => composeOnce(logged, draft, busy), [logged, draft, busy]);
  const [choice, setChoice] = useState<Map<number, number>>(new Map());
  const versioned = useMemo(() => applyVersions(composed, choice), [composed, choice]);
  const fixes = useMemo(() => collectWidgetFixes(versioned.messages), [versioned.messages]);
  const visible = useMemo(
    () => (fixes.hidden.size === 0 ? versioned.messages : versioned.messages.filter((_, i) => !fixes.hidden.has(i))),
    [versioned.messages, fixes],
  );
  const fixesRef = useRef(fixes);
  fixesRef.current = fixes;
  const signature = useMemo(() => [...fixes.replacements].map(([a, b]) => `${a}:${b.length}`).join('|'), [fixes]);
  const widgetFixes = useMemo(() => ({
    replaced: (src: string) => fixesRef.current.replacements.get(widgetHash(src)),
    superseded: (src: string) => fixesRef.current.superseded.has(widgetHash(src)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [signature]);
  const setVersion = useCallback((originalSeq: number, version: number) => {
    setChoice(c => { const n = new Map(c); n.set(originalSeq, version); return n; });
  }, []);
  return { messages: visible, versions: versioned.groups, setVersion, widgetFixes };
}

export function Transcript({ scrollRef }: { scrollRef: React.RefObject<HTMLDivElement | null> }): React.ReactElement {
  const busy = useStore(s => s.busy);
  const submit = useStore(s => s.submit);
  const { messages, versions, setVersion, widgetFixes } = useTranscript();
  const turns = useMemo(() => groupTurns(messages, busy), [messages, busy]);
  const verbose = useDesk(s => s.prefs.verboseAgent);

  const onFix = useCallback(({ kind, source, error }: { kind: string; source: string; error: string }) => {
    const entry = widgetById(kind);
    void submit([
      `The ${kind} you produced does not render. The error was:`, '', error, '',
      'This is the block that failed:', '', '```' + (entry?.languages[0] ?? kind), source, '```', '',
      ...(entry?.spec ? ['This is what the block must look like:', '', entry.spec, ''] : []),
      `Send back a corrected \`${kind}\` block and nothing else. Do not change what it is meant to show.`,
      'The error names where the parser stopped, which is often not where the mistake is.',
      fixMarker(source, kind),
    ].join('\n'));
  }, [submit]);

  // Follow the stream unless the reader scrolled up.
  const [following, setFollowing] = useState(true);
  const wasFollowing = useRef(true);
  useLayoutEffect(() => { wasFollowing.current = following; });
  const last = messages[messages.length - 1];
  useEffect(() => {
    const el = scrollRef.current;
    if (el && wasFollowing.current) el.scrollTop = el.scrollHeight;
  }, [messages.length, last?.content, last?.toolRunning, busy, scrollRef]);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = (): void => setFollowing(el.scrollHeight - el.scrollTop - el.clientHeight <= FOLLOW_PX);
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, [scrollRef]);

  return (
    <div className="transcript mx-auto w-full max-w-column px-6 pb-10 pt-6">
      {turns.map((t, i) => (
        <TurnView key={t.key} turn={t} last={i === turns.length - 1} verbose={verbose}
          onFix={onFix} widgetFixes={widgetFixes} versions={versions} setVersion={setVersion} />
      ))}
      {!following && (
        <button
          className="fixed bottom-[150px] left-1/2 z-20 flex h-9 w-9 -translate-x-1/2 items-center justify-center rounded-full border border-aico-border bg-aico-bg shadow-[var(--desk-shadow)] hover:bg-aico-hover"
          style={{ marginLeft: 'calc(var(--desk-sidebar-w, 0px) / 2)' }}
          onClick={() => { const el = scrollRef.current; if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' }); setFollowing(true); }}
          aria-label="Jump to latest"
        >
          <Icon name="arrow-down" size={16} />
        </button>
      )}
    </div>
  );
}

function TurnView({ turn, last, verbose, onFix, widgetFixes, versions, setVersion }: {
  turn: Turn; last: boolean; verbose: boolean;
  onFix: (r: { kind: string; source: string; error: string }) => void;
  widgetFixes: ReturnType<typeof useTranscript>['widgetFixes'];
  versions: ReturnType<typeof useTranscript>['versions'];
  setVersion: (seq: number, v: number) => void;
}): React.ReactElement {
  const [open, setOpen] = useState(verbose);
  useEffect(() => { setOpen(verbose); }, [verbose]);
  const answerRef = useRef<HTMLDivElement>(null);
  const answerText = turn.answer.filter(m => m.type === 'assistant').map(m => m.content).join('\n\n');
  const hasWork = turn.work.length > 0;

  return (
    <section className="mb-8" aria-label="Turn">
      {turn.user && <UserMessage message={turn.user} version={versions.get(turn.user.id)} setVersion={setVersion} />}

      {(hasWork || turn.running) && (
        <WorkFold turn={turn} last={last} open={open} onToggle={() => setOpen(o => !o)}>
          {turn.work.map(m => (
            <div key={m.id} className="work-item">
              <MessageBubble message={m} onFix={onFix} widgetFixes={widgetFixes} />
            </div>
          ))}
        </WorkFold>
      )}

      <div ref={answerRef} className="space-y-4">
        {turn.answer.map(m => (
          <div key={m.id} className={cls(m.type === 'error' && 'rounded-xl border border-aico-danger/30 bg-aico-danger/5 px-4 py-3')}>
            <MessageBubble message={m} onFix={onFix} widgetFixes={widgetFixes} />
          </div>
        ))}
      </div>

      {!turn.running && answerText && (
        <AnswerActions turn={turn} text={answerText} node={answerRef} />
      )}
      {last && !turn.running && <ChangesCard />}
    </section>
  );
}

function UserMessage({ message, version, setVersion }: {
  message: ChatMessage;
  version?: { total: number; current: number; originalSeq: number };
  setVersion: (seq: number, v: number) => void;
}): React.ReactElement {
  const text = stripEditMarker(message.content);
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(text);
  const submit = useStore(s => s.submit);
  const forkSession = useStore(s => s.forkSession);
  const sessionId = useStore(s => s.sessionId);
  const busy = useStore(s => s.busy);
  const seq = seqOf(message.id);

  const resend = (): void => {
    setEditing(false);
    const original = version?.originalSeq ?? seq;
    if (original === null || original === undefined) return;
    void submit(`${value.trim()}\n${editMarker(original)}`);
  };

  if (editing) {
    return (
      <div className="mb-5 ml-auto w-full max-w-[85%] rounded-3xl border border-aico-border bg-aico-bg p-3">
        <textarea className="w-full resize-none bg-transparent text-[15px] leading-relaxed outline-none" rows={Math.min(12, value.split('\n').length + 1)}
          value={value} onChange={e => setValue(e.target.value)} autoFocus
          onKeyDown={e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) resend(); if (e.key === 'Escape') setEditing(false); }} />
        <div className="mt-2 flex justify-end gap-2">
          <button className="btn-outline btn-sm" onClick={() => setEditing(false)}>Cancel</button>
          <button className="btn-primary btn-sm" onClick={resend} disabled={!value.trim() || busy}>Send</button>
        </div>
      </div>
    );
  }

  return (
    <div className="group mb-5 flex flex-col items-end">
      <div className="user-bubble max-w-[80%] whitespace-pre-wrap break-words rounded-3xl px-4 py-2.5 text-[15px] leading-relaxed selectable">
        {text}
      </div>
      <div className="mt-1 flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
        {version && version.total > 1 && (
          <span className="mr-1 flex items-center text-[12px] text-aico-muted">
            <button className="icon-btn-sm" disabled={version.current <= 1} onClick={() => setVersion(version.originalSeq, version.current - 1)} aria-label="Previous version"><Icon name="chevron-left" size={14} /></button>
            {version.current}/{version.total}
            <button className="icon-btn-sm" disabled={version.current >= version.total} onClick={() => setVersion(version.originalSeq, version.current + 1)} aria-label="Next version"><Icon name="chevron-right" size={14} /></button>
          </span>
        )}
        <button className="icon-btn-sm" title="Copy" aria-label="Copy message" onClick={() => { void desktop.clipboard.writeRich(text); toast.success('Copied'); }}><Icon name="copy" size={14} /></button>
        <button className="icon-btn-sm" title="Edit and resend" aria-label="Edit message" disabled={busy || seq === null} onClick={() => { setValue(text); setEditing(true); }}><Icon name="edit" size={14} /></button>
        {message.turn !== undefined && (
          <button className="icon-btn-sm" title="Ask this differently in a new branch" aria-label="Branch from here" disabled={busy}
            onClick={() => void forkSession(sessionId, message.turn! - 1, text)}><Icon name="git-branch" size={14} /></button>
        )}
      </div>
    </div>
  );
}

/**
 * How long a turn took. Replayed log messages all carry the time they were
 * replayed, not when they happened, so they cannot say; the store can — the
 * running turn's start, and the last finished turn's own summary.
 */
function useTurnDuration(turn: Turn, last: boolean, now: number): number | null {
  const started = useStore(s => s.turnStartedAt);
  const summary = useStore(s => s.turnSummary);
  if (turn.running) return started ? now - started : null;
  if (last && summary?.durationMs) return summary.durationMs;
  return null;
}

function WorkFold({ turn, last, open, onToggle, children }: {
  turn: Turn; last: boolean; open: boolean; onToggle: () => void; children: React.ReactNode;
}): React.ReactElement {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!turn.running) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [turn.running]);
  const elapsed = useTurnDuration(turn, last, now);
  const label = turn.running
    ? `${currentActivity(turn)}`
    : elapsed !== null ? `${turn.onlyThought ? 'Thought' : 'Worked'} for ${duration(elapsed)}` : (turn.onlyThought ? 'Thought' : 'Worked');
  return (
    <div className="mb-3">
      <button className="group flex items-center gap-2 rounded-lg py-1 text-[13.5px] text-aico-muted transition-colors hover:text-aico-primary" onClick={onToggle} aria-expanded={open}>
        {turn.running && <span className="spinner h-3.5 w-3.5" />}
        <span className={cls(turn.running && 'text-aico-secondary')}>{label}</span>
        {turn.running && elapsed !== null && <span className="tabular-nums text-aico-muted">· {duration(elapsed)}</span>}
        {turn.toolCount > 0 && !turn.running && <span className="text-aico-muted">· {turn.toolCount} step{turn.toolCount === 1 ? '' : 's'}</span>}
        <Icon name={open ? 'chevron-down' : 'chevron-right'} size={14} />
      </button>
      {open && turn.work.length > 0 && (
        <div className="ml-1.5 mt-1 space-y-2 border-l-2 border-aico-border-subtle pl-4">
          {children}
        </div>
      )}
    </div>
  );
}

function AnswerActions({ turn, text, node }: { turn: Turn; text: string; node: React.RefObject<HTMLDivElement | null> }): React.ReactElement {
  const rate = useStore(s => s.rate);
  const feedback = useStore(s => s.feedback);
  const submit = useStore(s => s.submit);
  const busy = useStore(s => s.busy);
  const forkSession = useStore(s => s.forkSession);
  const sessionId = useStore(s => s.sessionId);
  const title = useStore(s => s.title);
  const last = [...turn.answer].reverse().find(m => m.type === 'assistant');
  const seq = last ? seqOf(last.id) : null;
  const rating = seq !== null ? feedback[seq]?.rating : undefined;
  const [copied, setCopied] = useState(false);
  const mode = useDesk(s => s.mode);

  const copy = async (): Promise<void> => {
    await copyRich(node.current, text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  const exportAs = async (kind: 'html' | 'pdf'): Promise<void> => {
    if (!node.current) return;
    const html = standaloneHtml(title || 'AICO answer', `<div class="transcript markdown-host">${snapshotNode(node.current).innerHTML}</div>`, { dark: mode === 'dark' && kind === 'html' });
    if (kind === 'pdf') {
      const out = await desktop.exportPdf(html, `${(title || 'answer').slice(0, 60)}.pdf`);
      if (out) toast.success('Saved PDF', out);
    } else {
      const out = await desktop.dialog.saveFile({ defaultName: `${(title || 'answer').slice(0, 60)}.html`, content: html, filters: [{ name: 'HTML', extensions: ['html'] }] });
      if (out) toast.success('Saved HTML', out);
    }
  };

  return (
    <div className="mt-2 flex items-center gap-0.5 text-aico-muted" data-no-export>
      <button className="icon-btn-sm" title={copied ? 'Copied' : 'Copy (Markdown + rich text)'} aria-label="Copy answer" onClick={() => void copy()}>
        <Icon name={copied ? 'check' : 'copy'} size={15} />
      </button>
      {seq !== null && (
        <>
          <button className={cls('icon-btn-sm', rating === 'up' && 'text-aico-accent')} title="Good answer" aria-label="Good answer" aria-pressed={rating === 'up'}
            onClick={() => void rate(seq, rating === 'up' ? 'none' : 'up')}><Icon name="thumbs-up" size={15} /></button>
          <button className={cls('icon-btn-sm', rating === 'down' && 'text-aico-danger')} title="Bad answer" aria-label="Bad answer" aria-pressed={rating === 'down'}
            onClick={() => {
              const note = window.prompt('What was wrong? (optional — it helps the agent learn)') ?? undefined;
              void rate(seq, rating === 'down' ? 'none' : 'down', note || undefined);
            }}><Icon name="thumbs-down" size={15} /></button>
        </>
      )}
      {turn.user && (
        <button className="icon-btn-sm" title="Ask again" aria-label="Retry" disabled={busy}
          onClick={() => { const s = seqOf(turn.user!.id); void submit(s !== null ? `${stripEditMarker(turn.user!.content)}\n${editMarker(s)}` : stripEditMarker(turn.user!.content)); }}>
          <Icon name="refresh" size={15} />
        </button>
      )}
      {last?.turn !== undefined && (
        <button className="icon-btn-sm" title="Continue from here in a new branch" aria-label="Branch" disabled={busy}
          onClick={() => void forkSession(sessionId, last.turn!)}><Icon name="git-branch" size={15} /></button>
      )}
      <button className="icon-btn-sm" title="Save as PDF" aria-label="Save as PDF" onClick={() => void exportAs('pdf')}><Icon name="download" size={15} /></button>
      <button className="icon-btn-sm" title="Save as HTML" aria-label="Save as HTML" onClick={() => void exportAs('html')}><Icon name="share" size={15} /></button>

    </div>
  );
}
