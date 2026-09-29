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

interface Tip { text: string; kbd?: string; x: number; top: number; bottom: number; below: boolean }

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
      setTip({ ...splitShortcut(raw), x: r.left + r.width / 2, top: r.top, bottom: r.bottom, below });
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

  // Kept on screen: measured after render, then moved clear of the window's
  // edges, the native window controls (which are drawn over the title bar and
  // would cover it) and the built-in browser's page (a native view drawn above
  // the interface, which would hide it) — flipping to the other side first,
  // then sliding sideways.
  const ref = useRef<HTMLDivElement>(null);
  const [fit, setFit] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !tip) { setFit(null); return; }
    const w = el.offsetWidth; const h = el.offsetHeight; const gap = 8; const margin = 8;
    const at = (below: boolean): DOMRect => new DOMRect(tip.x - w / 2, below ? tip.bottom + gap : tip.top - gap - h, w, h);
    const blockers = keepOut();
    const bad = (r: DOMRect): boolean => r.top < 2 || r.bottom > window.innerHeight - 2 || blockers.some(b => overlaps(r, b));
    let r = at(tip.below);
    if (bad(r) && !bad(at(!tip.below))) r = at(!tip.below);
    let left = Math.min(Math.max(r.left, margin), window.innerWidth - margin - w);
    for (const b of blockers) {
      if (overlaps(new DOMRect(left, r.top, w, h), b)) left = Math.max(margin, b.left - margin - w);
    }
    setFit({ left, top: r.top });
  }, [tip]);

  if (!tip) return null;
  return createPortal(
    <div
      ref={ref}
      role="tooltip"
      className="desk-tooltip"
      style={fit ? { left: fit.left, top: fit.top } : { left: 0, top: 0, visibility: 'hidden' }}
    >
      <span>{tip.text}</span>
      {tip.kbd && <kbd>{tip.kbd}</kbd>}
    </div>,
    document.body,
  );
}

/** Where a tooltip must not go: the native window controls and a live browser page. */
function keepOut(): DOMRect[] {
  const out: DOMRect[] = [];
  const wco = (navigator as Navigator & { windowControlsOverlay?: { visible: boolean; getTitlebarAreaRect(): DOMRect } }).windowControlsOverlay;
  if (wco?.visible) {
    const t = wco.getTitlebarAreaRect();
    // The title bar area excludes the controls; they sit to its right (or left, on macOS).
    if (t.width > 0 && t.right < window.innerWidth) out.push(new DOMRect(t.right, 0, window.innerWidth - t.right, t.height));
    if (t.width > 0 && t.left > 0) out.push(new DOMRect(0, 0, t.left, t.height));
  }
  for (const page of document.querySelectorAll<HTMLElement>('.bx-page-frame > [data-no-tip]')) {
    // A still or one of the browser's own pages is ordinary interface; only the live native page hides things.
    if (page.childElementCount > 0) continue;
    const r = page.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) out.push(r);
  }
  return out;
}

function overlaps(a: DOMRect, b: DOMRect): boolean {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}
