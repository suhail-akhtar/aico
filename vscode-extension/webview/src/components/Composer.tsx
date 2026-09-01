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
import { onAsk, onNewSession, onFocusComposer } from '../host';
import {
  buildContextBlock, onEditorContext, EMPTY, NO_ATTACHMENTS,
  type Attachments, type EditorContext, type FindResult,
} from '../context';
import { ModelMenu } from './ModelMenu';
import { ContextMeter } from './ContextMeter';
import { ContextChips } from './ContextChips';
import { FindMenu } from './FindMenu';

/** Ceiling for the auto-growing input, in pixels — about eight lines. */
const MAX_INPUT_PX = 160;

/**
 * The `#` being typed, if any.
 *
 * Anchored to a word boundary so a `#` inside `issue#42` or a markdown heading
 * does not open a file picker. Only the token the caret is sitting in counts.
 */
function findToken(value: string, caret: number): { query: string; from: number } | null {
  const before = value.slice(0, caret);
  const hash = before.lastIndexOf('#');
  if (hash < 0) return null;
  if (hash > 0 && !/[\s(["'`]/.test(before[hash - 1])) return null;
  const query = before.slice(hash + 1);
  // A space ends it: `#src/api and then some prose` is prose, not a search.
  if (/\s/.test(query)) return null;
  return { query, from: hash };
}

export function Composer(): React.ReactElement {
  const [text, setText] = useState('');
  const input = useRef<HTMLTextAreaElement>(null);

  const [editor, setEditor] = useState<EditorContext>(EMPTY);
  const [attached, setAttached] = useState<Attachments>(NO_ATTACHMENTS);
  const [find, setFind] = useState<{ query: string; from: number } | null>(null);
  const [findSelected, setFindSelected] = useState(0);

  useEffect(() => onEditorContext(setEditor), []);

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

    /*
      Context is attached at send, not carried in the box.

      Building it here means the message reflects what was on screen when enter
      was pressed — the chips and the payload cannot disagree. It also means the
      user is never editing a block of generated prose they did not write.

      Only a *new* message carries it. A steer joins a run that already has this
      context, and an answer is resolving a question the agent asked; prepending
      a selection to either is noise at best and confusing at worst.
    */
    const block = (question || busy) ? '' : buildContextBlock(editor, attached);
    const payload = block ? `${value}\n\n${block}` : value;

    setText('');
    setFind(null);
    /*
      Attachments reset with the message they went out on. A chip is a statement
      about *this* message; leaving pins and dismissals in place would make the
      third message in a conversation silently carry the first one's decisions.
    */
    setAttached(NO_ATTACHMENTS);
    dispatch(payload);
  };

  /** Track the caret so `#` opens a menu only where a token is being typed. */
  const syncFind = (value: string, caret: number): void => {
    const found = findToken(value, caret);
    if (found?.query !== find?.query || found?.from !== find?.from) setFindSelected(0);
    setFind(found);
  };

  /** Attach what was chosen, and take the `#query` back out of the message. */
  const choose = (result: FindResult): void => {
    if (find) {
      const node = input.current;
      const caret = node?.selectionStart ?? text.length;
      const next = text.slice(0, find.from) + text.slice(caret);
      setText(next);
      requestAnimationFrame(() => {
        node?.focus();
        node?.setSelectionRange(find.from, find.from);
      });
    }
    setFind(null);
    setAttached(prev => (
      prev.pinned.some(p => p.uri === result.uri && p.symbol === (result.kind === 'symbol' ? result.label : undefined))
        ? prev
        : {
          ...prev,
          pinned: [...prev.pinned, {
            path: result.detail,
            uri: result.uri,
            line: result.line,
            ...(result.kind === 'symbol' ? { symbol: result.label } : {}),
          }],
        }
    ));
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

  /*
    The caret, when the editor asks for it.

    A frame late on purpose: `reveal` may have only just made the view visible,
    and focusing an element in a webview that is still being laid out silently
    does nothing.
  */
  useEffect(() => onFocusComposer(() => {
    requestAnimationFrame(() => input.current?.focus());
  }), []);

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    /*
      The menu takes the keys it needs, first.

      Arrows and enter belong to the list while it is open — otherwise enter
      sends a message containing a half-typed `#src/ap`, which is the most
      annoying possible outcome of having started to point at a file.
    */
    if (find) {
      if (event.key === 'Escape') { event.preventDefault(); setFind(null); return; }
      if (event.key === 'ArrowDown') {
        event.preventDefault(); setFindSelected(i => i + 1); return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault(); setFindSelected(i => Math.max(0, i - 1)); return;
      }
      if ((event.key === 'Enter' || event.key === 'Tab') && !event.shiftKey) {
        // Handled by FindMenu through `chosen`, which it hands back here.
        event.preventDefault();
        chosen.current?.();
        return;
      }
    }

    if (event.key !== 'Enter' || event.shiftKey) return;
    // A composition is an IME mid-word — pressing enter there is choosing a
    // candidate, not sending a message. Without this, typing Japanese or Chinese
    // sends a half-finished word on the first commit.
    if (event.nativeEvent.isComposing) return;
    event.preventDefault();
    send();
  };

  /**
   * How the textarea commits the menu's highlighted row.
   *
   * The menu owns the results — it is what searched for them — so the keyboard
   * handler cannot know which one is selected. Rather than lift the whole result
   * list into this component to satisfy one keypress, the menu leaves a function
   * here that commits whatever it currently has highlighted.
   */
  const chosen = useRef<(() => void) | null>(null);

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

      {/*
        Chips sit above the box rather than inside it. Inside, they compete with
        the caret for the same line and push the text around as the selection
        changes underneath; above, the writing area stays still.

        Hidden while steering or answering, because context is not attached to
        either — showing chips for something that will not be sent is a lie the
        UI tells about its own behaviour.
      */}
      {!question && !busy && (
        <ContextChips editor={editor} attached={attached} onChange={setAttached} />
      )}

      <div className="relative rounded border border-aico-border focus-within:border-aico-accent">
        {find && (
          <FindMenu
            query={find.query}
            selected={findSelected}
            onSelectedChange={setFindSelected}
            onChoose={choose}
            onDismiss={() => setFind(null)}
            commit={chosen}
          />
        )}

        <textarea
          ref={input}
          value={text}
          rows={1}
          placeholder={placeholder}
          onChange={(e) => {
            setText(e.target.value);
            syncFind(e.target.value, e.target.selectionStart ?? e.target.value.length);
          }}
          onKeyUp={(e) => {
            // Arrow keys and clicks move the caret without changing the text, and
            // moving out of a `#token` has to close the menu.
            const node = e.currentTarget;
            syncFind(node.value, node.selectionStart ?? 0);
          }}
          onBlur={() => setFind(null)}
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
