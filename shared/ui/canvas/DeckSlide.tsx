/**
 * One slide on screen — the editor's canvas, its thumbnails and present mode
 * all draw slides through this, with the same renderer the PDF export prints
 * (`deck-render.ts`), so what the person sees is what gets exported.
 *
 * ## Charts and diagrams, drawn once
 *
 * A deck of twenty slides shows each chart three times (thumbnail, canvas,
 * presenter's "next" view). Charts are rendered by ECharts to an SVG string
 * and diagrams by Mermaid, both loaded on demand (the chat already lazy-loads
 * them; a deck without visuals never pays for them), and cached by a key of
 * their content, theme and size. Every slide that shows the same key reuses
 * the string; a finished drawing re-renders the slides waiting for it.
 * Mermaid gets the theme through an `%%{init}%%` directive in the source, so
 * the chat's global Mermaid configuration is never changed.
 *
 * ## Pictures
 *
 * Only pictures the page can show without reaching anywhere else: data URLs
 * (pictures the person chose here) and the engine's own `/api/` files. A
 * project path is drawn as a labelled placeholder in the editor — the
 * exports embed it — rather than the editor fetching files or URLs a slide
 * names.
 *
 * @module shared/ui/canvas/DeckSlide
 */

import React, { useEffect, useMemo, useState } from 'react';
import { mediaUrl } from '../media';
import type { Deck } from './deck-model';
import { layoutSlide, type SlideLayout } from './deck-layout';
import { DECK_SLIDE_CSS, chartKey, deckChartOption, diagramKey, slideHtml, themedMermaid } from './deck-render';
import { themeOfDeck, type DeckTheme } from './deck-themes';

// ── The visuals cache ────────────────────────────────────────────────

const drawn = new Map<string, string>();
const inFlight = new Set<string>();
const waiting = new Set<() => void>();
let mermaidSeq = 0;
const CACHE_MAX = 200;

function remember(key: string, svg: string): void {
  drawn.delete(key);
  drawn.set(key, svg);
  while (drawn.size > CACHE_MAX) drawn.delete(drawn.keys().next().value!);
  for (const w of [...waiting]) w();
}

function failed(message: string): string {
  const safe = message.replace(/[<>&"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]!));
  return `<div class="dk-ph" style="width:100%;height:100%;background:rgba(220,38,38,0.06);color:#B91C1C"><div>Not drawn</div><code>${safe.slice(0, 240)}</code></div>`;
}

function drawVisuals(layout: SlideLayout, theme: DeckTheme): void {
  for (const f of layout.frames) {
    if (f.kind === 'chart') {
      const key = chartKey(f.chart, theme, f.w, f.h);
      if (drawn.has(key) || inFlight.has(key)) continue;
      inFlight.add(key);
      void import('echarts').then((echarts) => {
        const inst = echarts.init(null as unknown as HTMLElement, undefined, { renderer: 'svg', ssr: true, width: Math.round(f.w * 4 / 3), height: Math.round(f.h * 4 / 3) });
        try {
          inst.setOption(deckChartOption(f.chart, theme));
          remember(key, inst.renderToSVGString());
        } finally { inst.dispose(); }
      }).catch(err => remember(key, failed(err instanceof Error ? err.message : String(err)))).finally(() => inFlight.delete(key));
    } else if (f.kind === 'diagram') {
      const key = diagramKey(f.source, theme);
      if (drawn.has(key) || inFlight.has(key)) continue;
      inFlight.add(key);
      void import('mermaid')
        .then(m => m.default.render(`dk-mermaid-${++mermaidSeq}`, themedMermaid(f.source, theme)))
        .then(r => remember(key, r.svg))
        .catch(err => remember(key, failed(err instanceof Error ? err.message : String(err))))
        .finally(() => inFlight.delete(key));
    }
  }
}

/** Re-render when a visual this component waits for is drawn. */
function useVisuals(layout: SlideLayout, theme: DeckTheme): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const wake = (): void => setTick(t => t + 1);
    waiting.add(wake);
    drawVisuals(layout, theme);
    return () => { waiting.delete(wake); };
  }, [layout, theme]);
  return tick;
}

/** A picture the page may show: data URLs and the engine's own files only. */
export function slideImageUrl(src: string): string | undefined {
  if (/^data:image\//i.test(src)) return src;
  if (src.startsWith('/api/')) return mediaUrl(src);
  return undefined;
}

let cssInjected = false;
function injectCss(): void {
  if (cssInjected || typeof document === 'undefined') return;
  cssInjected = true;
  const style = document.createElement('style');
  style.setAttribute('data-aico-deck', '');
  style.textContent = DECK_SLIDE_CSS;
  document.head.appendChild(style);
}

export interface DeckSlideProps {
  deck: Deck;
  index: number;
  /** Width in CSS pixels; the slide scales to it. */
  width: number;
  /** The editor: planned slides show their plan, overflowing text is outlined, fields are clickable. */
  draft?: boolean;
  onField?: (field: string) => void;
  /** Pre-computed layout (the editor already has it). */
  layout?: SlideLayout;
  className?: string;
}

export function DeckSlide({ deck, index, width, draft, onField, layout: given, className }: DeckSlideProps): React.ReactElement {
  injectCss();
  const theme = useMemo(() => themeOfDeck(deck), [deck.theme, deck.palette, deck.fonts]); // eslint-disable-line react-hooks/exhaustive-deps
  const layout = useMemo(() => given ?? layoutSlide(deck, index, { draft: Boolean(draft) }), [given, deck, index, draft]);
  const tick = useVisuals(layout, theme);
  const html = useMemo(() => slideHtml(layout, theme, {
    visual: key => drawn.get(key), image: slideImageUrl, showOverflow: Boolean(draft), fields: Boolean(onField),
  }), [layout, theme, draft, onField, tick]); // eslint-disable-line react-hooks/exhaustive-deps
  const px = layout.w * 4 / 3;
  const scale = width / px;
  return (
    <div className={`adk-slidebox${className ? ` ${className}` : ''}`} style={{ width, height: Math.round((layout.h * 4 / 3) * scale) }}
      onClick={onField ? (e) => {
        const el = (e.target as HTMLElement).closest('[data-field]');
        if (el) onField(el.getAttribute('data-field')!);
      } : undefined}>
      <div className="adk-slidescale" style={{ transform: `scale(${scale})` }} dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  );
}

// ── Present mode ─────────────────────────────────────────────────────

function useViewport(): { w: number; h: number } {
  const [size, setSize] = useState(() => ({ w: window.innerWidth, h: window.innerHeight }));
  useEffect(() => {
    const on = (): void => setSize({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener('resize', on);
    return () => window.removeEventListener('resize', on);
  }, []);
  return size;
}

function fitWidth(boxW: number, boxH: number, ratio: number): number {
  return Math.max(80, Math.floor(Math.min(boxW, boxH * ratio)));
}

function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** What a key does in present mode — pure, so it is tested without a DOM. */
export function presentKey(key: string, shift = false): 'next' | 'prev' | 'first' | 'last' | 'exit' | 'black' | 'presenter' | undefined {
  switch (key) {
    case 'ArrowRight': case 'ArrowDown': case 'PageDown': case ' ': case 'Enter': case 'n': case 'N': return shift && key === ' ' ? 'prev' : 'next';
    case 'ArrowLeft': case 'ArrowUp': case 'PageUp': case 'Backspace': case 'p': case 'P': return 'prev';
    case 'Home': return 'first';
    case 'End': return 'last';
    case 'Escape': return 'exit';
    case 'b': case 'B': case '.': return 'black';
    case 's': case 'S': case 'v': case 'V': return 'presenter';
    default: return undefined;
  }
}

export interface DeckPresentProps {
  deck: Deck;
  start: number;
  /** Open in presenter view (notes, next slide, timer). */
  presenter?: boolean;
  onExit: (at: number) => void;
}

export function DeckPresent({ deck, start, presenter: startPresenter, onExit }: DeckPresentProps): React.ReactElement {
  const [at, setAt] = useState(Math.max(0, Math.min(start, deck.slides.length - 1)));
  const [black, setBlack] = useState(false);
  const [presenter, setPresenter] = useState(Boolean(startPresenter));
  const [began] = useState(() => Date.now());
  const [now, setNow] = useState(Date.now());
  const root = React.useRef<HTMLDivElement | null>(null);
  const atRef = React.useRef(at);
  atRef.current = at;
  const view = useViewport();
  const n = deck.slides.length;
  const ratio = deck.aspect === '4:3' ? 4 / 3 : 16 / 9;

  useEffect(() => {
    const el = root.current;
    el?.focus();
    if (el && document.fullscreenElement == null && el.requestFullscreen) el.requestFullscreen().catch(() => undefined);
    const onFs = (): void => { if (!document.fullscreenElement) onExit(atRef.current); };
    document.addEventListener('fullscreenchange', onFs);
    return () => {
      document.removeEventListener('fullscreenchange', onFs);
      if (document.fullscreenElement) document.exitFullscreen().catch(() => undefined);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!presenter) return;
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [presenter]);

  const go = (i: number): void => { setBlack(false); setAt(Math.max(0, Math.min(n - 1, i))); };
  const onKey = (e: React.KeyboardEvent): void => {
    const act = presentKey(e.key, e.shiftKey);
    if (!act) return;
    e.preventDefault();
    if (act === 'next') go(at + 1);
    else if (act === 'prev') go(at - 1);
    else if (act === 'first') go(0);
    else if (act === 'last') go(n - 1);
    else if (act === 'black') setBlack(b => !b);
    else if (act === 'presenter') setPresenter(p => !p);
    else onExit(at);
  };
  const slide = deck.slides[at];
  const fade = slide?.transition === 'fade';
  const main = presenter ? fitWidth(view.w * 0.62, view.h - 120, ratio) : fitWidth(view.w, view.h, ratio);

  return (
    <div className={`adk-present${presenter ? ' is-presenter' : ''}`} ref={root} tabIndex={0} onKeyDown={onKey} role="dialog" aria-label="Presentation">
      <div className="adk-present-main" onClick={() => go(at + 1)}>
        {black ? <div className="adk-black" style={{ width: main, height: main / ratio }} /> : (
          <div key={at} className={fade ? 'adk-fade' : undefined}>
            <DeckSlide deck={deck} index={at} width={main} />
          </div>
        )}
      </div>
      {presenter && (
        <aside className="adk-presenter-side">
          <div className="adk-presenter-top">
            <span className="adk-timer" aria-label="Elapsed time">{clock(now - began)}</span>
            <span className="adk-counter">{at + 1} / {n}</span>
            <button className="aw-btn" onClick={() => onExit(at)}>End</button>
          </div>
          <div className="adk-presenter-label">Next</div>
          {at + 1 < n ? <DeckSlide deck={deck} index={at + 1} width={Math.floor(view.w * 0.3)} /> : <div className="adk-presenter-end">End of the deck</div>}
          <div className="adk-presenter-label">Notes</div>
          <div className="adk-notes-view">{slide?.notes?.trim() || 'No speaker notes on this slide.'}</div>
        </aside>
      )}
      {!presenter && <div className="adk-present-hint">{at + 1} / {n} · S presenter view · B black · Esc exit</div>}
    </div>
  );
}
