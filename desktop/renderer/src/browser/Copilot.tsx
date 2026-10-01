/**
 * The AI copilot beside (or floating over) the page.
 *
 * A real AICO conversation — its own session, so browsing never takes over
 * the chat you are in (see copilot-session.ts) — that knows which page you are
 * on: every message carries a short header naming it, and the agent reads the
 * page itself with its browser tools. Quick actions phrase the common asks
 * well; answers render with the same renderers as the main chat, and links in
 * them open in the browser.
 *
 * Work that is not browsing (code, a project, server ops) is handed to a full
 * chat — by the model's `HandOffToChat`, or by the composer's "Hand off to
 * chat" button — and shows here as a "Continued in chat" card with Open. When
 * the model cannot tell, its one-line "here, or in a new chat?" question is
 * drawn as two buttons.
 *
 * Docked, it is part of the browser pane. Floating, it is drawn by its own
 * view over the page (copilot-main.tsx, placed by electron/browser-overlay.ts),
 * so the page stays live round it: `FloatingCopilot` is that view's content,
 * and its drag and resize move the view itself.
 *
 * @module desktop/renderer/browser/Copilot
 */

import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { MessageBubble, type ChatMessage } from '@aico/ui';
import { composeMessages } from '@web/reduce';
import { Icon } from '@/lib/icons';
import { cls, duration } from '@/lib/util';
import { copyRich } from '@/lib/rich';
import { useDesk, toast } from '@/state/desk';
import { getSendOptions, openChat } from '@/chat/actions';
import { groupTurns, currentActivity, type Turn } from '@/chat/turns';
import { callWithin, fire } from './ipc';
import { contextPageOf, QUICK_ACTIONS, stripContextHeader, withContext, type PageContext, type QuickAction } from './context';
import { hostOf, isBlankUrl } from './urls';
import { ALL_SUGGESTIONS, mergeActions } from './suggest';
import { usePageSuggestions } from './useSuggestions';
import { Favicon } from './Omnibox';
import { activeTab, agentStop, letAgentContinue, openUrl, useActiveTab, useBrowser } from './store';
import {
  answerCopilot, cancelCopilot, handOffNow, newCopilotChat, permitCopilot, sendCopilot, useCopilot,
} from './copilot-session';
import {
  HANDOFF_CHOICE_ANSWERS, HANDOFF_TOOL, isHandOffChoice, parseHandOffResult, type HandOffDone,
} from '@aico/shared/chat-handoff';
import { clampFloat, copilotSurface, minimizeCopilot, toggleCopilot, useCopilotUi } from './copilot-ui';
import { dragFloat, resizeFloat } from './geometry';
import { inBrowserWindow } from './host';
import type { OverlayMessage } from '@desk/copilot-float';
import type { Insights } from './types';

/** What main keeps about every open tab (electron/browser-tab-summary.ts), for the header and the chip. */
interface TabsView {
  tabs: Array<{ id: string; url: string; title: string; site: string; label: string; gist?: string; facts?: string }>;
  lines: string[];
  activeId: string | null;
}

/** Ask the page what the header should say, briefly — sending must not wait on a slow page. */
async function pageContext(quick?: QuickAction): Promise<PageContext | null> {
  const tab = activeTab();
  const share = useCopilotUi.getState().shareTabs;
  const tabsView = share ? await callWithin<TabsView>(800, 'browser:tabs:summary') : undefined;
  const openTabs = tabsView?.lines.length ? tabsView.lines : undefined;
  // On the new tab page there is no page to name, but the open tabs still are worth knowing.
  if (!tab || isBlankUrl(tab.url)) return openTabs ? { url: 'aico://newtab', title: 'New tab', openTabs } : null;
  const [insights, selection] = await Promise.all([
    callWithin<Insights>(1200, 'browser:insights'),
    callWithin<string | { text?: string }>(500, 'browser:selection'),
  ]);
  const sel = typeof selection === 'string' ? selection : selection?.text;
  const others = useBrowser.getState().state.tabs.filter(t => t.id !== tab.id && !isBlankUrl(t.url));
  return {
    url: tab.url,
    title: tab.title,
    ...(sel ? { selection: sel } : {}),
    humanCheck: Boolean(tab.humanCheck || insights?.humanCheck),
    loginWall: Boolean(insights?.loginWall),
    paywall: Boolean(insights?.paywall),
    ...(openTabs ? { openTabs } : share && (quick?.id === 'compare' || others.length <= 4) ? { otherTabs: others.map(t => ({ title: t.title, url: t.url })) } : {}),
  };
}

export async function askCopilot(text: string, quick?: QuickAction): Promise<void> {
  const ui = useCopilotUi.getState();
  // Asking AICO to do something is handing the wheel back after a Stop or Take over.
  if (useBrowser.getState().takenOver) letAgentContinue();
  const ctx = ui.attachPage || quick ? await pageContext(quick) : null;
  const tab = activeTab();
  const started = useCopilot.getState().started;
  const title = started ? undefined : `Browser · ${quick ? quick.label : (tab && !isBlankUrl(tab.url) ? tab.title || hostOf(tab.url) : text.slice(0, 40))}`;
  await sendCopilot(withContext(text, ctx), { title, approval: getSendOptions().approval, effort: getSendOptions().effort });
}

/** Open a chat in the main view — from the floating copilot or the browser's own window, through the main window. */
function openInMain(sessionId: string): void {
  if (copilotSurface() === 'overlay' || inBrowserWindow()) toWindow({ type: 'openChat', sessionId });
  else void openChat(sessionId);
}

/** "Hand off to chat": this request, with the page it is about, to a new chat — no model decision. */
async function handOffFromComposer(text: string): Promise<boolean> {
  const ctx = useCopilotUi.getState().attachPage ? await pageContext() : null;
  const page = ctx && !isBlankUrl(ctx.url) ? { url: ctx.url, title: ctx.title, ...(ctx.selection ? { selection: ctx.selection } : {}) } : null;
  return Boolean(await handOffNow(text, page));
}

/** The docked copilot, in the browser pane. Floating, it is its own view (see FloatingCopilot). */
export function CopilotPanel(): React.ReactElement | null {
  const ui = useCopilotUi();
  if (!ui.open || ui.minimized || ui.mode !== 'dock') return null;
  return (
    <aside className="cp-panel cp-dock relative shrink-0" style={{ width: ui.dockWidth }} aria-label="AICO copilot">
      <DockResize />
      <CopilotBody />
    </aside>
  );
}

/**
 * The floating copilot, filling its own view: `panel` is where main placed it
 * inside the view, `area` the browser area it floats over (for keeping a drag
 * inside it).
 */
export function FloatingCopilot({ panel, area }: {
  panel: { x: number; y: number; width: number; height: number }; area: { width: number; height: number };
}): React.ReactElement {
  const ui = useCopilotUi();
  const box = clampFloat(ui, area);
  return (
    <aside className="cp-panel cp-float cp-overlay" style={{ left: panel.x, top: panel.y, width: panel.width, height: panel.height }} aria-label="AICO copilot">
      <CopilotBody floating box={box} area={area} />
      <FloatResize box={box} area={area} />
    </aside>
  );
}

/** Asks of the main window, from the floating copilot's own view. */
function toWindow(m: OverlayMessage): void { fire('browser:overlay:relay', m); }

/**
 * Follow a drag in screen coordinates: the floating copilot's view moves under
 * the pointer, so positions within it do not hold still, but the screen does.
 */
function trackPointer(e: React.PointerEvent, onMove: (dx: number, dy: number) => void): void {
  e.preventDefault();
  const el = e.currentTarget as HTMLElement;
  const x0 = e.screenX; const y0 = e.screenY;
  try { el.setPointerCapture(e.pointerId); } catch { /* the window listeners still follow it */ }
  let frame = 0; let last: PointerEvent | null = null;
  const move = (ev: PointerEvent): void => {
    last = ev;
    if (frame) return;
    frame = requestAnimationFrame(() => { frame = 0; if (last) onMove(last.screenX - x0, last.screenY - y0); });
  };
  const up = (): void => {
    cancelAnimationFrame(frame);
    if (last) onMove(last.screenX - x0, last.screenY - y0);
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    window.removeEventListener('pointercancel', up);
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', up);
}

function DockResize(): React.ReactElement {
  const start = (e: React.PointerEvent): void => {
    e.preventDefault();
    const x0 = e.clientX;
    const w0 = useCopilotUi.getState().dockWidth;
    const move = (ev: PointerEvent): void => useCopilotUi.setState({ dockWidth: Math.max(320, Math.min(720, w0 - (ev.clientX - x0))) });
    const up = (): void => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  return <div className="cp-resize -left-1 top-0 h-full w-2 cursor-col-resize" onPointerDown={start} role="separator" aria-orientation="vertical" aria-label="Resize copilot" />;
}

function FloatResize({ box, area }: { box: { x: number; y: number; w: number; h: number }; area: { width: number; height: number } }): React.ReactElement {
  const start = (e: React.PointerEvent): void => {
    const b0 = box;
    trackPointer(e, (dx, dy) => useCopilotUi.setState(resizeFloat(b0, dx, dy, area)));
  };
  return (
    <div className="cp-resize bottom-0 left-0 h-4 w-4 cursor-nesw-resize" onPointerDown={start} aria-label="Resize copilot">
      <svg viewBox="0 0 10 10" className="absolute bottom-1 left-1 h-2.5 w-2.5 text-aico-muted" aria-hidden><path d="M1 1v8h8" fill="none" stroke="currentColor" strokeWidth="1.3" /></svg>
    </div>
  );
}

function CopilotBody({ floating, box, area }: {
  floating?: boolean; box?: { x: number; y: number; w: number; h: number }; area?: { width: number; height: number };
}): React.ReactElement {
  const ui = useCopilotUi();
  const sessionId = useCopilot(s => s.sessionId);
  const title = useCopilot(s => s.title);
  const status = useCopilot(s => s.status);
  const logged = useCopilot(s => s.logged);
  const draft = useCopilot(s => s.draft);
  const busy = useCopilot(s => s.busy);
  const error = useCopilot(s => s.error);
  const handoffs = useCopilot(s => s.handoffs);
  const messages = useMemo(() => composeMessages(logged, draft, busy), [logged, draft, busy]);
  const turns = useMemo(() => groupTurns(messages, busy), [messages, busy]);
  const scroll = useRef<HTMLDivElement>(null);
  const follow = useRef(true);

  useLayoutEffect(() => {
    const el = scroll.current;
    if (el && follow.current) el.scrollTop = el.scrollHeight;
  }, [messages, busy]);

  const drag = (e: React.PointerEvent): void => {
    if (!floating || !box || !area || e.button !== 0 || (e.target as HTMLElement).closest('button')) return;
    const b0 = box;
    trackPointer(e, (dx, dy) => useCopilotUi.setState(dragFloat(b0, dx, dy, area)));
  };

  // Links in answers open in the browser, not in another window.
  const onLink = (e: React.MouseEvent): void => {
    const a = (e.target as HTMLElement).closest('a');
    const href = a?.getAttribute('href');
    if (!a || !href || !/^https?:/i.test(href)) return;
    e.preventDefault();
    e.stopPropagation();
    openUrl(href, true);
  };

  return (
    <>
      <div className="cp-head" onPointerDown={drag}>
        <span className={cls('bx-orb h-5 w-5', busy && 'bx-spin')} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13.5px] font-semibold leading-tight">AICO</div>
          <div className="truncate text-[11px] leading-tight text-aico-muted">
            {status === 'lost' ? 'Reconnecting…' : title ? title.replace(/^Browser · /, '') : 'Your browsing copilot'}
          </div>
        </div>
        <button className="icon-btn-sm" onClick={() => newCopilotChat()} disabled={busy} title="New copilot chat"><Icon name="new-chat" size={15} /></button>
        <button className="icon-btn-sm" disabled={!sessionId || turns.length === 0}
          onClick={() => { if (sessionId) openInMain(sessionId); }}
          title="Open in main chat — continue this conversation in the full chat view">
          <Icon name="chat" size={15} />
        </button>
        <button className="icon-btn-sm" onClick={() => useCopilotUi.setState({ mode: ui.mode === 'dock' ? 'float' : 'dock' })}
          title={ui.mode === 'dock' ? 'Float over the page' : 'Dock beside the page'}>
          <Icon name={ui.mode === 'dock' ? 'pip' : 'panel-right'} size={15} />
        </button>
        <button className="icon-btn-sm" onClick={minimizeCopilot} title="Minimise"><Icon name="minus" size={15} /></button>
        <button className="icon-btn-sm" onClick={() => toggleCopilot(false)} title="Close (Ctrl+Shift+A)"><Icon name="x" size={15} /></button>
      </div>

      <div ref={scroll} className="cp-transcript min-h-0 flex-1 overflow-y-auto px-4 pb-3 pt-3 thin-scroll" onClickCapture={onLink}
        onScroll={e => { const el = e.currentTarget; follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80; }}>
        {turns.length === 0 && !busy && handoffs.length === 0 ? <StartScreen /> : turns.map((t, i) => <CopilotTurn key={t.key} turn={t} last={i === turns.length - 1} />)}
        {handoffs.map(h => <HandOffCard key={h.sessionId + h.title} done={h} />)}
        {error && (
          <div className="mt-3 flex items-start gap-2 rounded-xl border border-aico-danger/30 bg-aico-danger/5 px-3 py-2 text-[12.5px] text-aico-danger">
            <Icon name="alert" size={14} className="mt-0.5 shrink-0" /><span className="min-w-0 flex-1 break-words">{error}</span>
          </div>
        )}
      </div>

      <CopilotAttention />
      <CopilotInput />
    </>
  );
}

function StartScreen(): React.ReactElement {
  const tab = useActiveTab();
  const onPage = Boolean(tab && !isBlankUrl(tab.url));
  const busy = useCopilot(s => s.busy);
  const { chips } = usePageSuggestions();
  return (
    <div className="flex flex-col items-center px-1 pt-6 text-center">
      <span className="bx-orb mb-3 h-10 w-10" />
      <div className="text-[16px] font-semibold">{onPage ? 'Ask about this page' : 'What should we do on the web?'}</div>
      <div className="mt-1 max-w-[300px] text-[12.5px] text-aico-muted">
        {onPage ? <>AICO can read <span className="text-aico-secondary">{hostOf(tab!.url)}</span>, act on it for you, and open other sites to compare.</>
          : 'Open a page, or ask AICO to research, compare or fill things in for you.'}
      </div>
      <div className="mt-5 grid w-full grid-cols-1 gap-1.5">
        {mergeActions(chips, QUICK_ACTIONS, onPage ? 9 : 0).map(q => (
          <button key={q.id} className="cp-action" disabled={busy} onClick={() => void askCopilot(q.prompt, q)}>
            <Icon name={q.icon} size={15} className="shrink-0 text-aico-secondary" />
            <span className="min-w-0 flex-1 truncate">{q.label}</span>
            <Icon name="arrow-right" size={13} className="shrink-0 text-aico-muted" />
          </button>
        ))}
      </div>
      <div className="mt-5 flex items-start gap-2 rounded-xl bg-aico-hover/70 px-3 py-2 text-left text-[11.5px] leading-relaxed text-aico-muted">
        <Icon name="shield" size={13} className="mt-0.5 shrink-0" />
        AICO hands the page to you for “I’m human” checks, passwords, card details, one-time codes and payments — it never does those itself.
      </div>
    </div>
  );
}

function CopilotTurn({ turn, last }: { turn: Turn; last: boolean }): React.ReactElement {
  const [open, setOpen] = useState(false);
  const answerRef = useRef<HTMLDivElement>(null);
  const answerText = turn.answer.filter(m => m.type === 'assistant').map(m => m.content).join('\n\n');
  const [copied, setCopied] = useState(false);
  const started = useCopilot(s => s.turnStartedAt);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!turn.running) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [turn.running]);
  const hasWork = turn.work.length > 0;
  // Where the model handed this turn's work, from the tool's result in the log (so a reload still shows it).
  const handedTo = [...turn.work, ...turn.answer]
    .filter(m => m.type === 'tool' && m.toolName === HANDOFF_TOOL && !m.toolRunning)
    .map(m => parseHandOffResult(m.toolResult))
    .filter((d): d is HandOffDone => d !== null);
  return (
    <section className="mb-5" data-turn={last ? 'last' : undefined}>
      {turn.user && <UserLine message={turn.user} />}
      {(hasWork || turn.running) && (
        <div className="mb-2">
          <button className="flex max-w-full items-center gap-1.5 py-0.5 text-[12.5px] text-aico-muted hover:text-aico-primary" onClick={() => setOpen(o => !o)} aria-expanded={open}>
            {turn.running && <span className="spinner h-3 w-3 shrink-0" />}
            <span className={cls('truncate', turn.running && 'bx-shimmer-text')}>{turn.running ? currentActivity(turn) : `${turn.onlyThought ? 'Thought' : 'Worked'}${turn.toolCount ? ` · ${turn.toolCount} step${turn.toolCount === 1 ? '' : 's'}` : ''}`}</span>
            {turn.running && started && <span className="shrink-0 tabular-nums">· {duration(now - started)}</span>}
            <Icon name={open ? 'chevron-down' : 'chevron-right'} size={13} className="shrink-0" />
          </button>
          {open && turn.work.length > 0 && (
            <div className="ml-1 mt-1 space-y-2 border-l-2 border-aico-border-subtle pl-3 text-[12.5px]">
              {turn.work.map(m => <div key={m.id}><MessageBubble message={m} /></div>)}
            </div>
          )}
        </div>
      )}
      <div ref={answerRef} className="space-y-3">
        {turn.answer.map(m => (
          <div key={m.id} className={cls(m.type === 'error' && 'rounded-xl border border-aico-danger/30 bg-aico-danger/5 px-3 py-2')}>
            <MessageBubble message={m} />
          </div>
        ))}
      </div>
      {handedTo.map(d => <HandOffCard key={d.sessionId} done={d} />)}
      {!turn.running && answerText && (
        <div className="mt-1 flex items-center gap-0.5 text-aico-muted" data-no-export>
          <button className="icon-btn-sm h-6 w-6" title={copied ? 'Copied' : 'Copy answer'}
            onClick={() => void copyRich(answerRef.current, answerText).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1400); })}>
            <Icon name={copied ? 'check' : 'copy'} size={13} />
          </button>
        </div>
      )}
    </section>
  );
}

/** "Continued in chat: <title> — Open": where work from the copilot went. */
function HandOffCard({ done }: { done: HandOffDone }): React.ReactElement {
  const where = done.existing ? (done.queued ? 'Queued in chat' : 'Sent to chat') : 'Continued in chat';
  return (
    <div className="cp-handoff mt-2 flex items-center gap-2.5 rounded-xl border border-aico-accent/35 bg-aico-accent/5 px-3 py-2" data-handoff={done.sessionId}>
      <Icon name="chat" size={15} className="shrink-0 text-aico-accent" />
      <div className="min-w-0 flex-1">
        <div className="text-[11px] text-aico-muted">{where}</div>
        <div className="truncate text-[13px] font-medium" title={done.project ? `${done.title} — ${done.project}` : done.title}>{done.title}</div>
      </div>
      <button className="btn-outline btn-sm shrink-0" onClick={() => openInMain(done.sessionId)} title="Open this chat in the main view">
        Open <Icon name="external" size={12} />
      </button>
    </div>
  );
}

function UserLine({ message }: { message: ChatMessage }): React.ReactElement {
  const text = stripContextHeader(message.content);
  const page = contextPageOf(message.content);
  const quick = [...QUICK_ACTIONS, ...ALL_SUGGESTIONS].find(q => q.prompt === text.trim());
  return (
    <div className="mb-3 flex flex-col items-end gap-1">
      <div className="cp-user whitespace-pre-wrap break-words selectable">{quick ? quick.label : text}</div>
      {page && (
        <button className="flex max-w-[88%] items-center gap-1 truncate text-[11px] text-aico-muted hover:text-aico-primary" onClick={() => openUrl(page.url)} title={page.url}>
          <Icon name="globe" size={11} className="shrink-0" /><span className="truncate">{page.title}</span>
        </button>
      )}
    </div>
  );
}

function CopilotAttention(): React.ReactElement | null {
  const question = useCopilot(s => s.question);
  const permission = useCopilot(s => s.permission);
  const [value, setValue] = useState('');
  if (permission) {
    return (
      <div className="mx-3 mb-2 rounded-2xl border border-aico-warning/40 p-3 animate-pop-in" role="alertdialog">
        <div className="flex items-start gap-2">
          <Icon name="shield" size={15} className="mt-0.5 text-aico-warning" />
          <div className="min-w-0 flex-1">
            <div className="text-[13px] font-medium">Allow <span className="font-mono">{permission.tool}</span>?</div>
            <div className="mt-0.5 max-h-24 overflow-y-auto whitespace-pre-wrap break-words text-[12px] text-aico-secondary selectable thin-scroll">{permission.detail}</div>
          </div>
        </div>
        <div className="mt-2 flex justify-end gap-2">
          <button className="btn-outline btn-sm" onClick={() => void permitCopilot(false)}>Deny</button>
          <button className="btn-primary btn-sm" onClick={() => void permitCopilot(true)}>Allow</button>
        </div>
      </div>
    );
  }
  if (question && isHandOffChoice(question)) {
    // The copilot could not tell where this belongs: one line, two buttons.
    return (
      <div className="mx-3 mb-2 rounded-2xl border border-aico-accent/40 p-3 animate-pop-in" role="alertdialog" data-handoff-choice>
        <div className="flex items-start gap-2 text-[13px]"><Icon name="help" size={15} className="mt-0.5 text-aico-accent" /><span className="min-w-0 flex-1 selectable">{question}</span></div>
        <div className="mt-2 flex justify-end gap-2">
          <button className="btn-outline btn-sm" onClick={() => void answerCopilot(HANDOFF_CHOICE_ANSWERS.here)}>Here</button>
          <button className="btn-primary btn-sm" onClick={() => void answerCopilot(HANDOFF_CHOICE_ANSWERS.chat)}>
            <Icon name="chat" size={12} /> New chat
          </button>
        </div>
      </div>
    );
  }
  if (question) {
    return (
      <div className="mx-3 mb-2 rounded-2xl border border-aico-accent/40 p-3 animate-pop-in" role="alertdialog">
        <div className="flex items-start gap-2 text-[13px]"><Icon name="help" size={15} className="mt-0.5 text-aico-accent" /><span className="min-w-0 flex-1 whitespace-pre-wrap selectable">{question}</span></div>
        <form className="mt-2 flex gap-2" onSubmit={e => { e.preventDefault(); if (value.trim()) void answerCopilot(value.trim()).then(() => setValue('')); }}>
          <input className="input flex-1" value={value} onChange={e => setValue(e.target.value)} placeholder="Your answer" autoFocus />
          <button className="btn-primary btn-sm" disabled={!value.trim()}>Answer</button>
        </form>
      </div>
    );
  }
  return null;
}

function CopilotInput(): React.ReactElement {
  const [text, setText] = useState('');
  const busy = useCopilot(s => s.busy);
  const hasTurns = useCopilot(s => s.logged.size > 0 || s.busy);
  const attach = useCopilotUi(s => s.attachPage);
  const prefill = useCopilotUi(s => s.prefill);
  const sendKey = useDesk(s => s.prefs.sendKey);
  const tab = useActiveTab();
  const onPage = Boolean(tab && !isBlankUrl(tab.url));
  const { chips } = usePageSuggestions();
  const box = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!prefill) return;
    setText(prefill.text);
    requestAnimationFrame(() => { const el = box.current; if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); } });
  }, [prefill]);
  useEffect(() => {
    const focus = (): void => { requestAnimationFrame(() => box.current?.focus()); };
    window.addEventListener('aico:copilot-focus', focus);
    focus();
    return () => window.removeEventListener('aico:copilot-focus', focus);
  }, []);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(180, el.scrollHeight)}px`;
  }, [text]);

  const send = useCallback((): void => {
    const t = text.trim();
    if (!t || busy) return;
    setText('');
    void askCopilot(t).catch((e: Error) => {
      // The floating copilot's view has no toasts of its own; it says so in the conversation.
      if (copilotSurface() === 'overlay') useCopilot.setState({ error: `Could not send: ${e.message}` });
      else toast.error('Could not send', e.message);
    });
  }, [text, busy]);
  const stop = (): void => { void cancelCopilot(); agentStop(); };
  const [handing, setHanding] = useState(false);
  const handOff = (): void => {
    const t = text.trim();
    if (!t || busy || handing) return;
    setHanding(true);
    void handOffFromComposer(t).then(done => { if (done) setText(''); }).finally(() => setHanding(false));
  };

  return (
    <div className="shrink-0 px-3 pb-3">
      {hasTurns && onPage && (
        <div className="cp-chipbar">
          {mergeActions(chips, QUICK_ACTIONS).map(q => (
            <button key={q.id} className="cp-chip" disabled={busy} onClick={() => void askCopilot(q.prompt, q)} title={q.label}>
              <Icon name={q.icon} size={12} />{q.label}
            </button>
          ))}
        </div>
      )}
      <div className="cp-input-shell px-3 pb-2 pt-2">
        {onPage && (
          <div className="mb-1.5 flex flex-wrap items-center gap-1.5">
            <button className={cls('cp-page-chip', !attach && 'cp-detached')}
              onClick={() => useCopilotUi.setState({ attachPage: !attach })}
              title={attach ? 'AICO sees which page you are on with each message — click to stop sharing it' : 'Not sharing the page — click to let AICO see which page you are on'}>
              {attach ? <Favicon src={tab!.favicon} url={tab!.url} size={13} /> : <Icon name="eye-off" size={12} />}
              <span className="truncate">{attach ? <>Using this page: <span className="text-aico-primary">{tab!.title || hostOf(tab!.url)}</span></> : 'Page not shared'}</span>
              <Icon name={attach ? 'x' : 'plus'} size={11} className="shrink-0 opacity-70" />
            </button>
            {attach && <OpenTabsChip />}
          </div>
        )}
        <div className="flex items-end gap-2">
          <textarea ref={box} rows={1} value={text} onChange={e => setText(e.target.value)}
            placeholder={onPage ? 'Ask about this page, or tell AICO what to do…' : 'Ask AICO to find, compare or do something…'}
            className="composer-textarea max-h-[180px] min-h-[24px] flex-1 resize-none bg-transparent py-1 text-[14px] leading-6 placeholder:text-aico-muted"
            onKeyDown={e => {
              if (e.key !== 'Enter' || e.nativeEvent.isComposing) return;
              const wantCtrl = sendKey === 'ctrl-enter';
              if ((wantCtrl && (e.ctrlKey || e.metaKey)) || (!wantCtrl && !e.shiftKey && !e.ctrlKey)) { e.preventDefault(); send(); }
            }} />
          {!busy && (
            <button className="icon-btn-sm h-8 w-8 shrink-0 disabled:opacity-30" disabled={!text.trim() || handing} onClick={handOff}
              title="Hand off to chat — do this in a new full chat instead of here (code, projects, long builds)" aria-label="Hand off to chat">
              {handing ? <span className="spinner h-3.5 w-3.5" /> : <Icon name="share" size={15} />}
            </button>
          )}
          {busy ? (
            <button className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-aico-primary text-aico-bg hover:opacity-90" onClick={stop} title="Stop — also stops AICO in the browser">
              <Icon name="stop" size={13} style={{ fill: 'currentColor' }} />
            </button>
          ) : (
            <button className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-aico-primary text-aico-bg transition-opacity hover:opacity-90 disabled:opacity-30" disabled={!text.trim()} onClick={send} title="Send">
              <Icon name="send" size={15} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * "AICO can see N open tabs": what the header tells the agent about the other
 * tabs, opened to show the list, with the switch to stop sharing them.
 */
function OpenTabsChip(): React.ReactElement | null {
  const share = useCopilotUi(s => s.shareTabs);
  const tabKey = useBrowser(s => s.state.tabs.map(t => `${t.id}:${t.url}:${t.loading ? 1 : 0}`).join('|'));
  const [view, setView] = useState<TabsView | null>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    // Main summarises a page ~1 s after it loads; ask again a little later so the chip catches up.
    let live = true;
    const load = (): void => { void callWithin<TabsView>(800, 'browser:tabs:summary').then(v => { if (live) setView(v ?? null); }); };
    load();
    const t = setTimeout(load, 2500);
    return () => { live = false; clearTimeout(t); };
  }, [tabKey, open]);
  const web = (view?.tabs ?? []).filter(t => /^https?:/i.test(t.url));
  if (web.length < 2) return null;
  return (
    <div className="relative">
      <button className={cls('cp-page-chip', !share && 'cp-detached')} onClick={() => setOpen(o => !o)} aria-expanded={open}
        title={share ? 'AICO sees a one-line summary of each open tab with each message' : 'Open tabs are not shared'}>
        <Icon name={share ? 'layers' : 'eye-off'} size={12} />
        <span className="truncate">{share ? `AICO can see ${web.length} open tabs` : 'Tabs not shared'}</span>
        <Icon name={open ? 'chevron-down' : 'chevron-right'} size={11} className="shrink-0 opacity-70" />
      </button>
      {open && (
        <div className="absolute bottom-full left-0 z-20 mb-1 w-[300px] rounded-xl border border-aico-border-subtle bg-aico-bg p-2 text-[12px] shadow-lg" role="dialog" aria-label="Open tabs AICO can see">
          <label className="mb-1.5 flex cursor-pointer items-center gap-2 px-1">
            <input type="checkbox" className="accent-[var(--aico-accent)]" checked={share} onChange={e => useCopilotUi.setState({ shareTabs: e.target.checked })} />
            <span>Share open tabs with AICO</span>
          </label>
          <div className="max-h-56 space-y-0.5 overflow-y-auto thin-scroll">
            {web.map(t => (
              <div key={t.id} className={cls('rounded-lg px-1.5 py-1', !share && 'opacity-50')}>
                <div className="flex items-center gap-1.5">
                  <span className="shrink-0 rounded bg-aico-hover px-1 text-[10.5px] text-aico-secondary">{t.label}</span>
                  <span className="min-w-0 flex-1 truncate">{t.title}</span>
                  {t.facts && <span className="shrink-0 tabular-nums text-aico-secondary">{t.facts}</span>}
                </div>
                {t.gist && <div className="truncate text-[11px] text-aico-muted">{t.gist}</div>}
              </div>
            ))}
          </div>
          <div className="mt-1.5 px-1 text-[11px] text-aico-muted">A line per tab from what each page says about itself, kept on this device. It is sent only with your messages.</div>
        </div>
      )}
    </div>
  );
}
