/**
 * Tooltips that look like part of the app.
 *
 * The native `title` tooltip arrives late, in the OS's font, in a yellow or
 * grey box that ignores the theme. Every control in the app already says what
 * it does in `title`, so rather than wrapping hundreds of buttons, one layer
 * watches the pointer and keyboard focus: an element with a `title` hands its
 * text over (the attribute is moved to `data-tip`, which also stops the native
 * one) and a small dark pill appears above it — below when there is no room —
 * after a short delay, and immediately when moving between neighbours, as
 * tooltips in every good toolbar do. A `(Ctrl+K)`-style suffix is drawn as a
 * key hint.
 *
 * An icon-only control whose only name was its `title` keeps that name: the
 * text is copied to `aria-label` when there is none, so moving the attribute
 * never costs a screen reader anything.
 *
 * @module desktop/renderer/shell/Tooltips
 */

import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

const SHOW_DELAY = 450;
/** Moving from one tooltip'd control to the next within this long shows at once. */
const WARM_MS = 600;

interface Tip { text: string; kbd?: string; x: number; y: number; below: boolean }

function tipTarget(node: EventTarget | null): HTMLElement | null {
  let el = node instanceof Element ? node as HTMLElement : null;
  while (el && el !== document.body) {
    if (el.hasAttribute('title') || el.hasAttribute('data-tip')) return el;
    // Inside the built-in browser's still, a Monaco editor or a chart, their own tooltips win.
    if (el.classList.contains('monaco-editor') || el.hasAttribute('data-no-tip')) return null;
    el = el.parentElement;
  }
  return null;
}

/** Moves `title` to `data-tip` (keeping an accessible name) and returns the text. */
function adopt(el: HTMLElement): string {
  const title = el.getAttribute('title');
  if (title !== null) {
    el.removeAttribute('title');
    if (title) el.setAttribute('data-tip', title);
    else el.removeAttribute('data-tip');
    if (title && !el.getAttribute('aria-label') && !el.textContent?.trim()) el.setAttribute('aria-label', title);
  }
  return el.getAttribute('data-tip') ?? '';
}

export function splitShortcut(text: string): { text: string; kbd?: string } {
  const m = text.match(/^([\s\S]*?)\s*\(((?:Ctrl|Alt|Shift|Cmd|Win|F\d+|Esc|Enter|Tab)[^()]*)\)\s*$/);
  return m ? { text: m[1]!, kbd: m[2]! } : { text };
}

export function Tooltips(): React.ReactElement | null {
  const [tip, setTip] = useState<Tip | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const current = useRef<HTMLElement | null>(null);
  const lastHidden = useRef(0);

  useEffect(() => {
    const hide = (): void => {
      window.clearTimeout(timer.current);
      if (current.current) lastHidden.current = Date.now();
      current.current = null;
      setTip(null);
    };
    const show = (el: HTMLElement): void => {
      const raw = adopt(el).trim();
      if (!raw || !el.isConnected) return;
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) return;
      const below = r.top < 44;
      setTip({ ...splitShortcut(raw), x: r.left + r.width / 2, y: below ? r.bottom + 8 : r.top - 8, below });
    };
    const enter = (target: EventTarget | null, immediate: boolean): void => {
      const el = tipTarget(target);
      if (el === current.current) return;
      window.clearTimeout(timer.current);
      if (!el) { if (current.current) hide(); return; }
      adopt(el);
      current.current = el;
      setTip(null);
      const warm = Date.now() - lastHidden.current < WARM_MS;
      timer.current = window.setTimeout(() => { if (current.current === el) show(el); }, immediate || warm ? 0 : SHOW_DELAY);
    };
    const over = (e: MouseEvent): void => enter(e.target, false);
    const focus = (e: FocusEvent): void => {
      // Keyboard focus only; a click also focuses, and a tooltip popping up under the pointer then is noise.
      if ((e.target as HTMLElement | null)?.matches?.(':focus-visible')) enter(e.target, false);
    };
    const leaveWindow = (e: MouseEvent): void => { if (!e.relatedTarget) hide(); };
    document.addEventListener('mouseover', over, true);
    document.addEventListener('focusin', focus, true);
    document.addEventListener('mouseout', leaveWindow, true);
    document.addEventListener('mousedown', hide, true);
    document.addEventListener('keydown', hide, true);
    window.addEventListener('scroll', hide, true);
    window.addEventListener('blur', hide);
    return () => {
      document.removeEventListener('mouseover', over, true);
      document.removeEventListener('focusin', focus, true);
      document.removeEventListener('mouseout', leaveWindow, true);
      document.removeEventListener('mousedown', hide, true);
      document.removeEventListener('keydown', hide, true);
      window.removeEventListener('scroll', hide, true);
      window.removeEventListener('blur', hide);
      window.clearTimeout(timer.current);
    };
  }, []);

  // Kept on screen: measured after render, then nudged inside the window.
  const ref = useRef<HTMLDivElement>(null);
  const [dx, setDx] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !tip) { setDx(0); return; }
    const r = el.getBoundingClientRect();
    const left = r.left - dx; const right = r.right - dx;
    const margin = 8;
    setDx(left < margin ? margin - left : right > window.innerWidth - margin ? window.innerWidth - margin - right : 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tip]);

  if (!tip) return null;
  return createPortal(
    <div
      ref={ref}
      role="tooltip"
      className="desk-tooltip"
      style={{
        left: tip.x + dx,
        top: tip.y,
        transform: `translate(-50%, ${tip.below ? '0' : '-100%'})`,
      }}
    >
      <span>{tip.text}</span>
      {tip.kbd && <kbd>{tip.kbd}</kbd>}
    </div>,
    document.body,
  );
}
