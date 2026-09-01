/**
 * The composer.
 *
 * The control strip under the input is the part that carries the design: model,
 * mode, and how full the context is, all readable without opening anything. Those
 * are the three facts that change what happens when you press enter, and burying
 * any of them behind a menu means finding out afterwards.
 *
 * Enter sends and Shift+Enter breaks the line. That is the wrong default for a
 * text editor and the right one here — the surrounding application is full of
 * places to write multi-line text, and this is not one of them; it is a place to
 * ask for something.
 *
 * @module components/Composer
 */

import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useStore } from '@web/store';
import { onAsk, onNewSession } from '../host';
import { ModelMenu } from './ModelMenu';
import { ContextMeter } from './ContextMeter';

/** Ceiling for the auto-growing input, in pixels — about eight lines. */
const MAX_INPUT_PX = 160;

export function Composer(): React.ReactElement {
  const [text, setText] = useState('');
  const input = useRef<HTMLTextAreaElement>(null);

  const busy = useStore(s => s.busy);
  const submit = useStore(s => s.submit);
  const cancel = useStore(s => s.cancel);
  const steer = useStore(s => s.steer);
  const planMode = useStore(s => s.planMode);
  const setPlanMode = useStore(s => s.setPlanMode);
  const question = useStore(s => s.question);
  const answer = useStore(s => s.answer);
  const newSession = useStore(s => s.newSession);

  /*
    Grow with the content, up to a ceiling.

    Reset to `auto` first: without it `scrollHeight` is measured against the
    height already set, so the box grows on every keystroke and never shrinks
    when text is deleted.
  */
  useLayoutEffect(() => {
    const el = input.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, MAX_INPUT_PX)}px`;
  }, [text]);

  /**
   * Where a message actually goes.
   *
   * Three destinations, and the difference matters. A pending question is a turn
   * *blocked* on an answer — it resolves a waiting promise. A message typed while
   * a turn is running is a steer, delivered at the next step boundary. Only an
   * idle session takes a new submission. Sending all three the same way would
   * deadlock the first case.
   */
  const dispatch = (value: string): void => {
    if (!value.trim()) return;
    if (question) { void answer(value); return; }
    if (busy) { void steer(value); return; }
    void submit(value, { planMode });
  };

  const send = (): void => {
    const value = text.trim();
    if (!value) return;
    setText('');
    dispatch(value);
  };

  /*
    A request routed in from the editor.

    Context added without a question lands in the box to be edited or abandoned,
    and is appended rather than assigned — arriving mid-sentence should not
    silently discard what was already typed. A request that carries its own
    question goes straight out, because the person has already been asked what
    they wanted and making them press enter again is asking twice.

    Subscribed on every render, deliberately. `dispatch` closes over `busy`,
    `question` and `planMode`; a subscription pinned with an empty dependency
    array would keep the first render's values for ever and steer into a session
    that had long since gone idle.
  */
  useEffect(() => onAsk(({ text: incoming, send: immediate }) => {
    if (immediate) { dispatch(incoming); return; }
    setText(prev => (prev.trim() ? `${prev.trimEnd()}\n\n${incoming}` : incoming));
    input.current?.focus();
  }));

  useEffect(() => onNewSession(() => { setText(''); newSession(); }), [newSession]);

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key !== 'Enter' || event.shiftKey) return;
    // A composition is an IME mid-word — pressing enter there is choosing a
    // candidate, not sending a message. Without this, typing Japanese or Chinese
    // sends a half-finished word on the first commit.
    if (event.nativeEvent.isComposing) return;
    event.preventDefault();
    send();
  };

  const placeholder = question
    ? 'Answer to continue…'
    : busy ? 'Steer the run…' : 'Ask aico…';

  return (
    <div className="shrink-0 border-t border-aico-border-subtle p-2">
      {question && (
        <p className="mb-1.5 px-1 text-[11px] leading-relaxed text-aico-warning">
          {question}
        </p>
      )}

      <div className="rounded border border-aico-border focus-within:border-aico-accent">
        <textarea
          ref={input}
          value={text}
          rows={1}
          placeholder={placeholder}
          onChange={e => setText(e.target.value)}
          onKeyDown={onKeyDown}
          className="block w-full resize-none bg-transparent px-2.5 py-2 text-[13px] text-aico-primary placeholder:text-aico-muted focus:outline-none"
        />

        <div className="flex items-center gap-1.5 px-1.5 pb-1.5">
          <ModelMenu />

          <button
            type="button"
            onClick={() => setPlanMode(!planMode)}
            title="Plan first — investigate and propose, with the write tools removed"
            aria-pressed={planMode}
            className={[
              'rounded px-1.5 py-0.5 text-[11px]',
              planMode
                ? 'bg-aico-accent-soft text-aico-accent'
                : 'text-aico-secondary hover:bg-aico-hover hover:text-aico-primary',
            ].join(' ')}
          >
            {planMode ? 'Plan' : 'Build'}
          </button>

          <span className="flex-1" />

          <ContextMeter />

          {busy ? (
            <button
              type="button"
              onClick={() => void cancel()}
              title="Stop this run"
              aria-label="Stop"
              className="flex size-[22px] items-center justify-center rounded bg-aico-hover text-aico-primary hover:bg-aico-danger hover:text-aico-on-accent"
            >
              <svg viewBox="0 0 16 16" className="size-3" fill="currentColor">
                <rect x="4" y="4" width="8" height="8" rx="1" />
              </svg>
            </button>
          ) : (
            <button
              type="button"
              onClick={send}
              disabled={!text.trim()}
              title="Send"
              aria-label="Send"
              className="flex size-[22px] items-center justify-center rounded bg-aico-accent text-aico-on-accent disabled:opacity-40 disabled:hover:bg-aico-accent hover:bg-aico-accent-hover"
            >
              <svg
                viewBox="0 0 16 16" className="size-3.5" fill="none" stroke="currentColor"
                strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"
              >
                <path d="M8 12.75V3.25M4 7.25 8 3.25l4 4" />
              </svg>
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
