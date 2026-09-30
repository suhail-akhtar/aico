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
import { AttachmentStrip, MessageBubble, type ChatMessage } from '@aico/ui';
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
import { extractSources } from './sources';
import { Favicon, useSourcesPanel } from './SourcesPanel';
import { MenuButton, MenuItem } from '@/shell/Popover';
import { create } from 'zustand';

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
  /** Following is paused until then, while a finished reply is being shown from its start. */
  const holdUntil = useRef(0);
  /** When the reader last scrolled, clicked or pressed a key in the transcript. */
  const touchedAt = useRef(0);
  useLayoutEffect(() => { wasFollowing.current = following; });
  const last = messages[messages.length - 1];
  useEffect(() => {
    const el = scrollRef.current;
    if (el && wasFollowing.current && Date.now() > holdUntil.current) el.scrollTop = el.scrollHeight;
  }, [messages.length, last?.content, last?.toolRunning, busy, scrollRef]);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = (): void => {
      setFollowing(el.scrollHeight - el.scrollTop - el.clientHeight <= FOLLOW_PX);
      setAnswerAbove(answerStartAbove(el));
    };
    const touched = (): void => { touchedAt.current = Date.now(); };
    el.addEventListener('scroll', onScroll, { passive: true });
    el.addEventListener('wheel', touched, { passive: true });
    el.addEventListener('pointerdown', touched, { passive: true });
    el.addEventListener('keydown', touched);
    return () => {
      el.removeEventListener('scroll', onScroll);
      el.removeEventListener('wheel', touched);
      el.removeEventListener('pointerdown', touched);
      el.removeEventListener('keydown', touched);
    };
  }, [scrollRef]);

  /*
    A reply that finishes while you were watching it stream leaves you at its
    last line, and a long answer then has to be scrolled back up by hand to be
    read from the top. So, when it finishes, go to where it starts: the question
    if the question and the answer's opening fit on screen together, otherwise
    the answer's first line. Only when you were following — if you had scrolled
    away to read something else, the transcript leaves you there.
  */
  const jump = useDesk(s => s.prefs.jumpToAnswer);
  const [answerAbove, setAnswerAbove] = useState(false);
  const wasBusy = useRef(busy);
  useEffect(() => {
    const finished = wasBusy.current && !busy;
    wasBusy.current = busy;
    if (!finished || !jump || !wasFollowing.current) return;
    const el = scrollRef.current;
    if (!el) return;
    // Stop following first: the turn's final log lands just after it ends, and
    // following would carry the view straight back down to the bottom.
    wasFollowing.current = false;
    setFollowing(false);
    holdUntil.current = Date.now() + 2000;
    const started = Date.now();
    const place = (): void => { if (touchedAt.current < started) scrollToAnswerStart(el, 'auto'); };
    // Once the last chunk has painted, and again when late widgets have settled
    // — unless the reader has moved in between.
    let raf = requestAnimationFrame(() => { raf = requestAnimationFrame(place); });
    const again = setTimeout(place, 500);
    return () => { cancelAnimationFrame(raf); clearTimeout(again); };
  }, [busy, jump, scrollRef]);

  return (
    <div className="transcript mx-auto w-full max-w-column px-6 pb-10 pt-6">
      {turns.map((t, i) => (
        <TurnView key={t.key} turn={t} last={i === turns.length - 1} verbose={verbose}
          onFix={onFix} widgetFixes={widgetFixes} versions={versions} setVersion={setVersion} />
      ))}
      {(!following || (answerAbove && !busy)) && (
        <div className="fixed bottom-[150px] left-1/2 z-20 flex -translate-x-1/2 items-center gap-1 rounded-full border border-aico-border bg-aico-bg p-0.5 shadow-[var(--desk-shadow)]"
          style={{ marginLeft: 'calc(var(--desk-sidebar-w, 0px) / 2)' }}>
          {answerAbove && !busy && (
            <button className="flex h-8 items-center gap-1.5 rounded-full px-3 text-[12.5px] text-aico-secondary hover:bg-aico-hover hover:text-aico-primary"
              onClick={() => { const el = scrollRef.current; if (el) scrollToAnswerStart(el, 'smooth'); }}
              title="Scroll to where the last answer starts" aria-label="Jump to the start of the answer">
              <Icon name="arrow-up" size={14} /> Start of answer
            </button>
          )}
          {!following && (
            <button className="flex h-8 w-8 items-center justify-center rounded-full hover:bg-aico-hover"
              onClick={() => { const el = scrollRef.current; if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' }); setFollowing(true); }}
              title="Jump to latest" aria-label="Jump to latest">
              <Icon name="arrow-down" size={16} />
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** The last turn's question and answer, as scroll targets inside `el`. */
function lastTurnNodes(el: HTMLElement): { turn: HTMLElement; answer: HTMLElement | null } | null {
  const turn = el.querySelector<HTMLElement>('section[data-turn="last"]');
  if (!turn) return null;
  return { turn, answer: turn.querySelector<HTMLElement>('[data-answer]') };
}

/** Offset of `node` from the top of the scrolling `el`'s content. */
function offsetIn(el: HTMLElement, node: HTMLElement): number {
  return node.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop;
}

/**
 * Where the last answer starts: the question above it when both fit in the top
 * part of the view together, otherwise the answer itself.
 */
export function scrollToAnswerStart(el: HTMLElement, behavior: ScrollBehavior = 'smooth'): number {
  const nodes = lastTurnNodes(el);
  if (!nodes) return -1;
  const turnTop = offsetIn(el, nodes.turn);
  const answerTop = nodes.answer && nodes.answer.offsetHeight > 0 ? offsetIn(el, nodes.answer) : turnTop;
  const target = answerTop - turnTop < el.clientHeight * 0.4 ? turnTop : answerTop;
  const top = Math.max(0, Math.min(target - 16, el.scrollHeight - el.clientHeight));
  el.scrollTo({ top, behavior });
  return top;
}

/** True when the last answer's first line is above the top of the view. */
function answerStartAbove(el: HTMLElement): boolean {
  const nodes = lastTurnNodes(el);
  const node = nodes?.answer ?? nodes?.turn;
  if (!node || node.offsetHeight < el.clientHeight * 0.6) return false;
  return offsetIn(el, node) < el.scrollTop - 40;
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
    <section className="mb-8" aria-label="Turn" data-turn={last ? 'last' : undefined}>
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

      <div ref={answerRef} className="space-y-4" data-answer>
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
      {message.attachments?.length ? <AttachmentStrip attachments={message.attachments} /> : null}
      {text.trim() !== '' && (
        <div className="user-bubble max-w-[80%] whitespace-pre-wrap break-words rounded-3xl px-4 py-2.5 text-[15px] leading-relaxed selectable">
          {text}
        </div>
      )}
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
  const sources = useMemo(() => extractSources([...turn.work, ...turn.answer]), [turn.work, turn.answer]);
  const showSources = useSourcesPanel(s => s.show);
  const reading = useReadAloud(s => s.id !== null && s.id === (last?.id ?? ''));

  const copy = async (): Promise<void> => {
    await copyRich(node.current, text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  const exportAs = async (kind: 'html' | 'pdf' | 'md'): Promise<void> => {
    const name = (title || 'answer').replace(/[\\/:*?"<>|]+/g, ' ').slice(0, 60);
    if (kind === 'md') {
      const out = await desktop.dialog.saveFile({ defaultName: `${name}.md`, content: text, filters: [{ name: 'Markdown', extensions: ['md'] }] });
      if (out) toast.success('Saved Markdown', out);
      return;
    }
    if (!node.current) return;
    const html = standaloneHtml(title || 'AICO answer', `<div class="transcript markdown-host">${snapshotNode(node.current).innerHTML}</div>`, { dark: mode === 'dark' && kind === 'html' });
    if (kind === 'pdf') {
      const out = await desktop.exportPdf(html, `${name}.pdf`);
      if (out) toast.success('Saved PDF', out);
    } else {
      const out = await desktop.dialog.saveFile({ defaultName: `${name}.html`, content: html, filters: [{ name: 'HTML', extensions: ['html'] }] });
      if (out) toast.success('Saved HTML', out);
    }
  };
  const openSources = (): void => showSources(sources, turn.user ? stripEditMarker(turn.user.content).slice(0, 60) : '');

  return (
    <div className="mt-2 flex items-center gap-0.5 text-aico-muted" data-no-export>
      <button className="icon-btn-sm" title={copied ? 'Copied' : 'Copy response'} aria-label="Copy answer" onClick={() => void copy()}>
        <Icon name={copied ? 'check' : 'copy'} size={15} />
      </button>
      {seq !== null && (
        <>
          <button className={cls('icon-btn-sm', rating === 'up' && 'text-aico-accent')} title="Good response" aria-label="Good answer" aria-pressed={rating === 'up'}
            onClick={() => { void rate(seq, rating === 'up' ? 'none' : 'up'); if (rating !== 'up') toast.success('Thanks — noted'); }}><Icon name="thumbs-up" size={15} /></button>
          <BadAnswer rating={rating} onRate={(note) => void rate(seq, rating === 'down' ? 'none' : 'down', note)} />
        </>
      )}
      {turn.user && (
        <button className="icon-btn-sm" title="Try again" aria-label="Retry" disabled={busy}
          onClick={() => { const s = seqOf(turn.user!.id); void submit(s !== null ? `${stripEditMarker(turn.user!.content)}\n${editMarker(s)}` : stripEditMarker(turn.user!.content)); }}>
          <Icon name="refresh" size={15} />
        </button>
      )}
      <MenuButton className="icon-btn-sm" title="Share and save" ariaLabel="Share" placement="bottom-start" width={230} button={<Icon name="share" size={15} />}>
        {close => (
          <>
            <MenuItem icon="copy" label="Copy response" onClick={() => { close(); void copy(); }} />
            <MenuItem icon="download" label="Save as PDF" hint="with every visual" onClick={() => { close(); void exportAs('pdf'); }} />
            <MenuItem icon="globe" label="Save as HTML" onClick={() => { close(); void exportAs('html'); }} />
            <MenuItem icon="file-text" label="Save as Markdown" onClick={() => { close(); void exportAs('md'); }} />
          </>
        )}
      </MenuButton>
      {sources.length > 0 && (
        <button className="ml-1 flex h-7 items-center gap-1.5 rounded-full border border-aico-border-subtle px-2 text-[12px] text-aico-secondary transition-colors hover:bg-aico-hover hover:text-aico-primary"
          onClick={openSources} title={`${sources.length} source${sources.length === 1 ? '' : 's'} the agent searched and read`}>
          <span className="flex -space-x-1.5">
            {[...new Map(sources.map(s => [s.host, s])).values()].slice(0, 3).map(s => (
              <span key={s.host} className="rounded-full ring-2 ring-aico-bg"><Favicon host={s.host} size={14} /></span>
            ))}
          </span>
          Sources
        </button>
      )}
      <MenuButton className="icon-btn-sm" title="More actions" ariaLabel="More actions" placement="bottom-start" width={240} button={<Icon name="more" size={15} />}>
        {close => (
          <>
            <MenuItem icon="book" label="View sources" hint={sources.length ? String(sources.length) : 'none'} disabled={!sources.length} onClick={() => { close(); openSources(); }} />
            {last?.turn !== undefined && (
              <MenuItem icon="git-branch" label="Branch in new chat" disabled={busy} title="Continue from here in a new chat" onClick={() => { close(); void forkSession(sessionId, last.turn!); }} />
            )}
            <MenuItem icon={reading ? 'stop' : 'volume'} label={reading ? 'Stop reading' : 'Read aloud'} onClick={() => { close(); readAloud(last?.id ?? '', node.current?.innerText ?? text); }} />
          </>
        )}
      </MenuButton>
    </div>
  );
}

/** Thumbs-down with an optional note, in a popover — `window.prompt` does not exist in Electron, so the old note never worked. */
function BadAnswer({ rating, onRate }: { rating?: string; onRate: (note?: string) => void }): React.ReactElement {
  const [note, setNote] = useState('');
  if (rating === 'down') {
    return <button className="icon-btn-sm text-aico-danger" title="Bad response — click to undo" aria-label="Bad answer" aria-pressed onClick={() => onRate()}><Icon name="thumbs-down" size={15} /></button>;
  }
  return (
    <MenuButton className="icon-btn-sm" title="Bad response" ariaLabel="Bad answer" placement="bottom-start" width={320} button={<Icon name="thumbs-down" size={15} />}>
      {close => (
        <div className="p-2">
          <div className="mb-1.5 text-[13px] font-medium">What was wrong?</div>
          <div className="mb-2 flex flex-wrap gap-1.5">
            {['Wrong or made up', 'Did not follow instructions', 'Too long', 'Too short', 'Bad formatting'].map(r => (
              <button key={r} className="chip" onClick={() => { close(); onRate(r); toast.success('Thanks — the agent learns from this'); }}>{r}</button>
            ))}
          </div>
          <textarea className="input min-h-[60px] text-[13px]" placeholder="Anything else (optional)" value={note} onChange={e => setNote(e.target.value)} autoFocus />
          <div className="mt-2 flex justify-end">
            <button className="btn-primary btn-sm" onClick={() => { close(); onRate(note.trim() || undefined); toast.success('Thanks — the agent learns from this'); }}>Send</button>
          </div>
        </div>
      )}
    </MenuButton>
  );
}

/** One answer read aloud at a time, with the system's voices. */
const useReadAloud = create<{ id: string | null }>(() => ({ id: null }));
function readAloud(id: string, text: string): void {
  const synth = window.speechSynthesis;
  if (!synth) { toast.warning('Read aloud is not available on this system'); return; }
  const stop = useReadAloud.getState().id === id;
  synth.cancel();
  useReadAloud.setState({ id: null });
  if (stop) return;
  // Prose only: code blocks and markup are left to the eye.
  const clean = text.replace(/```[\s\S]*?```/g, ' ').replace(/[#*_`>|]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 20000);
  const u = new SpeechSynthesisUtterance(clean);
  u.onend = () => { if (useReadAloud.getState().id === id) useReadAloud.setState({ id: null }); };
  u.onerror = () => { if (useReadAloud.getState().id === id) useReadAloud.setState({ id: null }); };
  useReadAloud.setState({ id });
  synth.speak(u);
}
