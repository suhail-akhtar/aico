/**
 * The input, and the one design decision that matters in it.
 *
 * While a turn is running there are three different things typing can mean, and
 * collapsing them into one "send" button is how a chat UI becomes frustrating:
 *
 *   - **steer** — change what the agent is doing *right now*. Delivered at the
 *     next step boundary, so the current tool call finishes first.
 *   - **follow-up** — a separate next turn. The running work is left alone.
 *   - **cancel** — stop.
 *
 * The engine already distinguishes these, so the UI exposes them rather than
 * picking one and hiding the rest. When nothing is running there is no
 * ambiguity and the same box is just "send".
 *
 * The card shares its width with the transcript above, so the two read as one
 * surface. The metric line beneath it is the only always-on telemetry in the
 * app — everything else is a click away.
 *
 * @module components/Composer
 */

import React, { useEffect, useRef, useState } from 'react';
import { useStore } from '../store';
import { ModelPicker } from './ModelPicker';
import { AgentPicker } from './AgentPicker';
import { EffortPicker } from './EffortPicker';
import { ApprovalPicker, type ApprovalMode } from './ApprovalPicker';
import type { EffortChoice } from '../../../shared/reasoning';
import { SetGoalButton } from './GoalBar';
import { TOOLBAR_CONTROL, toolbarTone } from './toolbar';
import { Icon } from './Icon';
import { MentionMenu } from './MentionMenu';
import { mentionAt, searchAgents } from '../agents';
import { api, type AgentSpec } from '../api';

/** Bytes at a scale a person reads. */
function describeBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10240 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function Composer(): React.ReactElement {
  const busy = useStore(s => s.busy);
  const submit = useStore(s => s.submit);
  const prefill = useStore(s => s.composerPrefill);
  const question = useStore(s => s.question);
  const answer = useStore(s => s.answer);
  const steer = useStore(s => s.steer);
  const followup = useStore(s => s.followup);
  const cancel = useStore(s => s.cancel);
  const usage = useStore(s => s.usage);
  const model = useStore(s => s.model ?? s.defaultModel);

  const [text, setText] = useState('');
  // From the store, not local state. A plan approved in the side panel turns
  // planning off, and the toggle has to show that — a switch that disagrees
  // with the mode it controls is worse than no switch.
  const planMode = useStore(s => s.planMode);
  const setPlanMode = useStore(s => s.setPlanMode);
  /*
    Held locally, beside plan mode, because both describe the *next* message
    rather than the session. They survive sending: somebody who lowered the
    effort wants it lowered for the message after this one too.
  */
  const [effort, setEffort] = useState<EffortChoice>('auto');
  const [approval, setApproval] = useState<ApprovalMode>('auto');
  const textarea = useRef<HTMLTextAreaElement>(null);

  // ── @mentions ──────────────────────────────────────────────────────
  //
  // The same act as the picker, reached without leaving the keyboard. The
  // picker is a decision made before you start writing; this is one made three
  // words in, when you realise the question is a security question.
  const setSessionAgent = useStore(s => s.setSessionAgent);
  const mentionsOn = useStore(s => (s.settings as { agents?: { directChat?: boolean } })
    .agents?.directChat !== false);
  const [agents, setAgents] = useState<AgentSpec[]>([]);
  const [mention, setMention] = useState<{ query: string; from: number } | null>(null);
  const [highlighted, setHighlighted] = useState(0);

  // ── attachments ────────────────────────────────────────────────────
  const pendingAttachments = useStore(st => st.pendingAttachments);
  const attachFiles = useStore(st => st.attachFiles);
  const detachFile = useStore(st => st.detachFile);
  const fileInput = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(false);

  /**
   * A screenshot pasted straight into the message.
   *
   * The whole reason images are worth having: the alternative is save the
   * screenshot to a file, find the file, attach the file. Ctrl-V is what
   * people actually do, and a composer that ignored it would have image
   * support nobody used.
   *
   * Only intercepted when the clipboard actually holds an image. Pasting text
   * that happens to come from an app which also offers an image flavour must
   * still paste as text, so the default is left alone unless a file is found.
   */
  const onPaste = (event: React.ClipboardEvent<HTMLTextAreaElement>): void => {
    const images = [...event.clipboardData.files].filter(file => file.type.startsWith('image/'));
    if (images.length === 0) return;
    event.preventDefault();
    // A pasted screenshot arrives named "image.png" or nothing at all, which
    // is indistinguishable from the next one. The time makes the chips tellable
    // apart, which matters as soon as there are two.
    const stamped = images.map(file => new File(
      [file],
      file.name && file.name !== 'image.png'
        ? file.name
        : `pasted-${new Date().toISOString().slice(11, 19).replace(/:/g, '')}.${
          file.type === 'image/jpeg' ? 'jpg' : file.type.slice('image/'.length)}`,
      { type: file.type },
    ));
    void take(stamped);
  };

  const take = async (files: FileList | File[] | null): Promise<void> => {
    if (!files || (files instanceof FileList ? files.length : files.length) === 0) return;
    setUploading(true);
    try { await attachFiles(files); }
    finally {
      setUploading(false);
      if (fileInput.current) fileInput.current.value = '';
    }
  };

  useEffect(() => {
    if (!mentionsOn) return;
    void api.agents()
      .then(r => setAgents(r.agents.filter(a => a.enabled)))
      .catch(() => { /* mentions are a shortcut, not a requirement */ });
  }, [mentionsOn]);

  /** Re-read after every edit and caret move, so the menu tracks what is typed. */
  const syncMention = (value: string, caret: number): void => {
    if (!mentionsOn) return;
    const found = mentionAt(value, caret);
    setMention(found);
    if (found) setHighlighted(0);
  };

  /** Engage the agent and take its `@name` back out of the message. */
  const engage = (name: string): void => {
    const at = mention;
    setMention(null);
    if (at) {
      const node = textarea.current;
      const caret = node?.selectionStart ?? text.length;
      const next = (text.slice(0, at.from) + text.slice(caret)).replace(/^\s+/, '');
      setText(next);
      // The caret goes where the token was, so typing continues in place.
      requestAnimationFrame(() => {
        node?.focus();
        node?.setSelectionRange(at.from, at.from);
      });
    }
    void setSessionAgent(name);
  };

  // Filled from elsewhere — the plan panel's Amend, so far. Appended to what is
  // already typed rather than replacing it: silently discarding a half-written
  // message to make room is never the right trade.
  useEffect(() => {
    if (!prefill) return;
    setText(current => (current.trim() ? `${current.trimEnd()}

${prefill.text}` : prefill.text));
    const node = textarea.current;
    if (node) {
      node.focus();
      requestAnimationFrame(() => {
        resize(node, true);
        node.setSelectionRange(node.value.length, node.value.length);
      });
    }
  }, [prefill]);

  const send = async (mode: 'send' | 'steer' | 'followup'): Promise<void> => {
    const content = text.trim();
    if (!content) return;
    setText('');
    resize(textarea.current, true);

    // A blocked turn takes precedence over every other reading of Enter. It
    // cannot reach a step boundary, so steering would queue the answer behind
    // a boundary that never arrives.
    if (question !== null) { await answer(content); return; }
    if (mode === 'steer') await steer(content);
    else if (mode === 'followup') await followup(content);
    else await submit(content, { planMode, effort, approval });
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    // The menu owns these keys while it is open, so Enter engages the agent
    // rather than sending a message addressed to nobody in particular.
    if (mention) {
      const matches = searchAgents(agents, mention.query);
      if (event.key === 'Escape') { event.preventDefault(); setMention(null); return; }
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setHighlighted(i => Math.min(i + 1, matches.length - 1));
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        setHighlighted(i => Math.max(i - 1, 0));
        return;
      }
      if ((event.key === 'Enter' || event.key === 'Tab') && matches.length > 0) {
        event.preventDefault();
        engage(matches[Math.min(highlighted, matches.length - 1)]!.name);
        return;
      }
    }

    if (event.key !== 'Enter' || event.shiftKey) return;
    event.preventDefault();
    // While running, plain Enter steers — the action someone reaching for the
    // keyboard mid-run almost always wants. Ctrl/Cmd+Enter queues instead.
    if (!busy) void send('send');
    else if (event.ctrlKey || event.metaKey) void send('followup');
    else void send('steer');
  };

  return (
    <div className="px-5 pb-3">
      <div
        className="relative mx-auto w-full max-w-column"
        onDragOver={e => { e.preventDefault(); setDragging(true); }}
        onDragLeave={e => {
          // Only when the pointer actually leaves the box: dragging across a
          // child fires dragleave for the child and would flicker the state.
          if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false);
        }}
        onDrop={e => {
          e.preventDefault();
          setDragging(false);
          void take(e.dataTransfer.files);
        }}
      >
        {mention && (
          <MentionMenu
            agents={agents}
            query={mention.query}
            selected={highlighted}
            onSelectedChange={setHighlighted}
            onChoose={engage}
            onDismiss={() => setMention(null)}
          />
        )}
        {/*
          Above the box, not in the transcript. The turn is stopped until this
          is answered, and a question you can scroll past is a turn that hangs —
          which is exactly what happened before the web had any way to hear one.
        */}
        {dragging && (
          <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center
                          rounded-2xl border-2 border-dashed border-aico-accent bg-aico-accent-soft/80">
            <p className="text-[13px] font-medium text-aico-accent">
              Drop to attach — PDF, Word, Excel, CSV, text, Markdown
            </p>
          </div>
        )}

        {question !== null && (
          <div className="mb-1.5 flex items-start gap-2 rounded-xl border border-aico-accent/40
                          bg-aico-accent-soft px-3 py-2">
            <span className="mt-[1px] shrink-0 text-[12px] text-aico-accent" aria-hidden>?</span>
            <p className="min-w-0 flex-1 text-[13px] leading-[19px] text-aico-primary">{question}</p>
            <span className="shrink-0 text-[11px] text-aico-muted">waiting</span>
          </div>
        )}
        <div
          data-composer
          className="rounded-[22px] border border-aico-border bg-aico-bg shadow-sm transition-colors
                     focus-within:border-aico-accent/40"
        >
          <textarea
            ref={textarea}
            value={text}
            onChange={e => {
              setText(e.target.value);
              resize(e.target);
              syncMention(e.target.value, e.target.selectionStart ?? e.target.value.length);
            }}
            // Clicking or arrowing out of a half-typed mention should close the
            // menu, not leave it hanging over unrelated text.
            onSelect={e => {
              const node = e.target as HTMLTextAreaElement;
              syncMention(node.value, node.selectionStart ?? 0);
            }}
            onBlur={() => setMention(null)}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            rows={1}
            placeholder={question !== null
              ? 'Answer to continue…'
              : busy ? 'Steer the running turn…' : 'Message the agent'}
            className="block max-h-64 w-full resize-none bg-transparent px-5 py-3.5 text-[15px]
                       leading-[24px] text-aico-primary placeholder:text-aico-muted focus:outline-none"
          />

          {/*
            Chips above the controls rather than inside the text. An attachment
            is not part of the sentence, and putting a filename in the textarea
            makes it something you can half-delete.
          */}
          {pendingAttachments.length > 0 && (
            <div className="flex flex-wrap gap-1.5 px-3 pb-1.5">
              {pendingAttachments.map(file => (
                <span
                  key={file.id}
                  className="inline-flex max-w-full items-center gap-1.5 rounded-lg border
                             border-aico-border bg-aico-bg px-2 py-1 text-[12px] text-aico-secondary"
                  title={`${file.name} · ${describeBytes(file.bytes)}`}
                >
                  <span className="shrink-0 text-[10px] uppercase text-aico-muted">
                    {file.extension.slice(1)}
                  </span>
                  <span className="min-w-0 truncate">{file.name}</span>
                  <span className="shrink-0 text-[11px] text-aico-muted">{describeBytes(file.bytes)}</span>
                  <button
                    onClick={() => void detachFile(file.id)}
                    aria-label={`Remove ${file.name}`}
                    className="shrink-0 rounded px-0.5 text-aico-muted hover:text-aico-danger"
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          )}

          <input
            ref={fileInput}
            type="file"
            multiple
            accept=".pdf,.docx,.xlsx,.csv,.txt,.md,.png,.jpg,.jpeg,.webp,.gif"
            onChange={e => void take(e.target.files)}
            className="hidden"
          />

          {/*
            Two groups, not seven controls in a line.

            The left group says what this turn *does*; the right says who does it
            and how carefully. Grouping them means that when the row runs out of
            width it breaks between the groups — which reads as deliberate —
            rather than orphaning whichever control happened to be fourth.

            `flex-wrap` is what makes running out of width survivable at all. A
            row that cannot fit does not clip: it either overflows the container
            or, worse, lets its shrinkable children wrap their own text, so one
            long label silently becomes two lines tall and every neighbour is
            centred against it. That is precisely how this row was wrong.
          */}
          <div
            data-composer-toolbar
            className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-3 pb-2.5"
          >
            <div className="flex items-center gap-1">
            <button
              onClick={() => fileInput.current?.click()}
              disabled={uploading}
              title="Attach a document or image — PDF, Word, Excel, CSV, text, Markdown, PNG, JPEG, WebP or GIF. Screenshots can be pasted straight in."
              aria-label="Attach a document"
              className={`${TOOLBAR_CONTROL} px-2 ${toolbarTone(false)}`}
            >
              {uploading ? '…' : <Icon name="paperclip" size={15} />}
            </button>

            <button
              onClick={() => setPlanMode(!planMode)}
              disabled={busy}
              title="Plan first, then act"
              className={`${TOOLBAR_CONTROL} ${toolbarTone(planMode)}`}
            >
              Plan
            </button>

            <SetGoalButton />

            </div>

            {/*
              The right group is one flex child, and that is the whole trick.

              A bare spacer was not enough: the controls stayed siblings of the
              left-hand ones, so an over-subscribed row broke wherever it ran
              out — leaving `Orchestrator` and the model on the first line and
              `Think`, `Approve` and Send stranded on the second. Two lines, and
              no relationship between them.

              As a group it wraps whole. `flex-1` right-aligns it beside the
              left group on a wide row and gives it the full width on a narrow
              one; `justify-end` keeps it against the same edge either way, so
              the second line looks like a decision rather than an accident.

              It must not wrap *inside*, which the first attempt allowed and
              which looked worse than the bug: `Approve` and Send dropped to a
              second line while `Orchestrator` and the model stayed on the
              first, and the left group — one line tall against a two-line
              neighbour — floated in the middle of both. A group either fits
              beside the left one or takes its own line. Nothing in between.

              What absorbs the squeeze instead is the model id, and only it. It
              is the one label here that can lose characters without losing its
              meaning — the full id is in the tooltip and the menu — so it is
              the only control allowed to shrink, down to a floor below which
              it would stop being a name at all.

              No `min-w-0` here, and that omission is load-bearing. With it the
              group was allowed to be narrower than its own contents, so rather
              than wrapping it simply overflowed — and being right-aligned, it
              overflowed *leftwards*, drawing `Orchestrator` on top of `Plan`
              and `Goal`. Every measurement passed while that happened: the
              heights were identical, nothing crossed the right edge, the page
              did not scroll. It was caught by looking at a screenshot taken
              for something else, which is why the probe now checks that the
              two groups do not intersect.
            */}
            <div className="flex flex-1 items-center justify-end gap-1">
              <AgentPicker />

              <ModelPicker />

              <EffortPicker value={effort} onChange={setEffort} disabled={busy} />

              <ApprovalPicker value={approval} onChange={setApproval} disabled={busy} />

            {busy ? (
              <>
                <button
                  onClick={() => void send('followup')}
                  disabled={!text.trim()}
                  title="Queue as the next turn (⌘/Ctrl+Enter)"
                  className={`${TOOLBAR_CONTROL} ${toolbarTone(false)}`}
                >
                  Queue
                </button>
                <button
                  onClick={() => void send('steer')}
                  disabled={!text.trim()}
                  title="Deliver into the running turn (Enter)"
                  className={`${TOOLBAR_CONTROL} ${toolbarTone(true)}`}
                >
                  Steer
                </button>
                <button
                  onClick={() => void cancel()}
                  title="Stop the running turn"
                  aria-label="Stop"
                  className="flex size-7 shrink-0 items-center justify-center rounded-full
                             bg-aico-elevated text-aico-primary transition-colors hover:bg-aico-hover"
                >
                  <span className="block h-2.5 w-2.5 rounded-[2px] bg-current" />
                </button>
              </>
            ) : (
              <button
                onClick={() => void send('send')}
                disabled={!text.trim()}
                aria-label="Send"
                className="flex size-7 shrink-0 items-center justify-center rounded-full
                           bg-aico-accent text-aico-on-accent transition-colors
                           hover:bg-aico-accent-hover disabled:opacity-30"
              >
                ↑
              </button>
            )}
            </div>
          </div>
        </div>

        <div className="mt-1.5 flex flex-wrap items-center justify-center gap-x-3 gap-y-0.5 text-[11px] text-aico-muted">
          <span>
            {busy
              ? 'Enter steers · ⌘/Ctrl+Enter queues'
              : 'Enter to send · Shift+Enter for a newline'}
          </span>
          {/*
            How full the window is, which is the number people actually want.

            "In 180k" says nothing on its own — that is comfortable in a
            million-token window and nearly fatal in a two-hundred-thousand one,
            and the reader cannot tell which they are in. The most recent
            request's input tokens *are* the current occupancy, because the whole
            conversation is resent every turn.

            Hidden entirely until the server has said how big the window is, so
            an older server shows the counts it always did rather than a bar
            drawn against a guess.
          */}
          {usage.input > 0 && usage.contextWindow > 0 && (
            <>
              <span aria-hidden>·</span>
              <ContextMeter
                used={usage.input}
                total={usage.contextWindow}
                source={usage.contextSource}
              />
            </>
          )}
          {usage.input > 0 && (
            <>
              <span aria-hidden>·</span>
              {/*
                A `~` on the counts when the provider reported no usage and
                these came from counting characters. The gateways that reject
                `stream_options` are exactly the ones whose numbers a reader is
                most likely to be squinting at, so saying which are measured is
                the whole point.
              */}
              <span title={usage.usageEstimated
                ? 'Approximate — this provider reported no usage, so the prompt '
                  + 'size was counted from the text'
                : 'Total input tokens, cached reads included'}>
                In {usage.usageEstimated ? '~' : ''}{format(usage.input)}
              </span>
              <span title={usage.usageEstimated
                ? 'Approximate — counted from the reply text, not reported by the provider'
                : 'Output tokens'}>
                Out {usage.usageEstimated ? '~' : ''}{format(usage.output)}
              </span>
              {usage.cached > 0 && (
                <span title={`${format(usage.cached)} tokens read from cache at ~0.1× rate`}>
                  Cache {Math.round((usage.cached / usage.input) * 100)}%
                </span>
              )}
              {/*
                A cost nobody has real rates for is shown as `~$0.0668?` rather
                than `$0.0668`. The token counts either side of it are measured
                and true; only the money is invented, and printing an invented
                figure in the same style as a measured one is how a reader ends
                up budgeting against a number that came from a placeholder.
              */}
              {usage.costUsd > 0 && (
                <span
                  title={usage.costEstimated
                    ? 'Approximate — no pricing is known for this model, so a '
                      + 'placeholder rate was applied to real token counts. Set '
                      + 'modelPricing in settings for the true figure.'
                    : 'Based on published rates for this model'}
                  className={usage.costEstimated ? 'text-aico-muted' : undefined}
                >
                  {usage.costEstimated ? '~' : ''}${usage.costUsd.toFixed(4)}
                  {usage.costEstimated && <span aria-label="estimated">?</span>}
                </span>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/** Grow with the content up to the CSS max-height, then let it scroll. */
function resize(el: HTMLTextAreaElement | null, reset = false): void {
  if (!el) return;
  el.style.height = 'auto';
  el.style.height = reset ? '' : `${el.scrollHeight}px`;
}

function format(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

/** What each provenance means, for the tooltip. */
const WINDOW_SOURCE: Record<string, string> = {
  user: 'Window size: set by you in settings.',
  api: 'Window size: reported by the provider itself.',
  learned: 'Window size: taken from a limit error the provider itself returned.',
  table: 'Window size: from the built-in list — a guess that detection will replace.',
  assumed: 'Window size: UNKNOWN for this model, so 128K is assumed. '
    + 'Set contextWindows in settings if you know the real figure.',
};

/**
 * How full the context window is.
 *
 * A bar rather than only a percentage, because the thing being communicated is
 * *headroom*, and headroom is a length. The number is there too for anyone who
 * wants the actual figure.
 *
 * Colour changes only near the end. A meter that is amber at 50% trains people
 * to ignore it, and the honest reading of half-full is that nothing is wrong —
 * compaction is a normal part of a long conversation, not a failure. Amber at
 * 75% means "this will compact soon"; red at 90% means "it is about to".
 */
function ContextMeter(
  { used, total, source }: { used: number; total: number; source: string },
): React.ReactElement {
  // Clamped, because a provider that under-reports its own window would
  // otherwise render a bar wider than its track.
  const fraction = Math.min(1, Math.max(0, used / total));
  const percent = Math.round(fraction * 100);

  const tone = fraction >= 0.9 ? 'bg-aico-danger'
    : fraction >= 0.75 ? 'bg-aico-warning'
      : 'bg-aico-accent';

  return (
    <span
      className="inline-flex items-center gap-1.5"
      title={`${used.toLocaleString()} of ${total.toLocaleString()} tokens in the context `
        + `window (${percent}%). The whole conversation is resent each turn, so this is `
        + 'how full it is right now. Older turns are summarised automatically before it fills.'
        + `

${WINDOW_SOURCE[source] ?? ''}`}
    >
      <span
        className="relative inline-block h-1.5 w-10 overflow-hidden rounded-full bg-aico-hover"
        role="progressbar"
        aria-valuenow={percent}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label="Context window used"
      >
        <span
          className={`absolute inset-y-0 left-0 rounded-full ${tone}`}
          style={{ width: `${Math.max(percent, 2)}%` }}
        />
      </span>
      {/*
        A guessed window is marked. Nothing knew this model, so the bar is drawn
        against a fallback — and a bar that looks identical to a measured one is
        how somebody comes to trust a number nothing stands behind.
      */}
      <span>{percent}% of {format(total)}{source === 'assumed' ? '?' : ''}</span>
    </span>
  );
}
