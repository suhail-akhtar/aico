/**
 * Play and Present for a design board (ADR 0037): one screen full size and
 * interactive, its links opening the board's other screens.
 *
 * The screen runs in a frame with `sandbox="allow-scripts"` (never
 * `allow-same-origin`) from the composed document (`board-docs`). A click on
 * a link inside it arrives here as `{aicoBoard: 'nav', href}` — accepted only
 * from this frame's own window — and is resolved against the board
 * (`frameForHref`); a link to something that is not a screen says so instead
 * of navigating anywhere. The screen is drawn at its device width and scaled
 * down (never up) to fit, so a phone stays phone-sized and a desktop screen
 * is seen whole. One frame element is kept and given each new screen's
 * document: measured in Chrome, a frame created in place of the previous one
 * loaded its document but stayed white, and keeping the element also avoids a
 * flash between screens.
 *
 * Present is the same view with the board's chrome hidden and the frames in
 * board order: ← → step, Esc leaves. It asks for full screen and treats
 * leaving full screen as leaving Present.
 *
 * @module web/components/board/BoardPlayer
 */

import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { frameForHref, orderedFrames, playScale, type Board, type BoardFrame } from '../../../../shared/ui/board/board-model';
import type { BoardDocs, FrameHost } from './board-docs';
import { BoardIcon } from './icons';

export function ScreenFrame({ frame, doc, host, live, title, onWindow }: {
  frame: BoardFrame;
  doc: string;
  host?: FrameHost;
  /** Interactive (Play) or a picture on the board. */
  live: boolean;
  title: string;
  onWindow?: (w: Window | null) => void;
}): React.ReactElement {
  const [url, setUrl] = useState<string | null>(null);
  const ref = useRef<HTMLIFrameElement>(null);
  useEffect(() => {
    if (!host) return;
    let alive = true;
    setUrl(null);
    host(doc).then(u => { if (alive) setUrl(u); }, () => { if (alive) setUrl(''); });
    return () => { alive = false; };
  }, [doc, host]);
  useEffect(() => { onWindow?.(ref.current?.contentWindow ?? null); });
  if (host && url === null) return <div className="h-full w-full bg-white" />;
  return (
    <iframe
      ref={ref}
      title={title}
      // allow-scripts only: never allow-same-origin, forms, popups, downloads or top navigation.
      sandbox="allow-scripts"
      referrerPolicy="no-referrer"
      {...(host && url ? { src: url } : { srcDoc: doc })}
      tabIndex={live ? 0 : -1}
      aria-hidden={live ? undefined : true}
      style={{ width: frame.width, height: frame.height, pointerEvents: live ? 'auto' : 'none' }}
      className="block border-0 bg-white"
    />
  );
}

export function BoardPlayer({ board, docs, host, startId, present, onClose, onDownload }: {
  board: Board;
  docs: BoardDocs;
  host?: FrameHost;
  startId: string;
  present: boolean;
  onClose: (lastId: string) => void;
  onDownload: (frame: BoardFrame) => void;
}): React.ReactElement | null {
  const frames = orderedFrames(board);
  const [id, setId] = useState(startId);
  const frame = frames.find(f => f.id === id) ?? frames[0];
  const [doc, setDoc] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const stage = useRef<HTMLDivElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const win = useRef<Window | null>(null);
  const at = frame ? frames.indexOf(frame) : -1;
  const section = board.sections.find(s => frame && s.frames.includes(frame));

  useEffect(() => {
    if (!frame) return;
    let alive = true;
    // The previous screen stays until this one is ready, and the same frame element loads it.
    setError(null);
    docs.live(frame).then(d => { if (alive) setDoc(d); }, (e: unknown) => { if (alive) setError(e instanceof Error ? e.message : String(e)); });
    return () => { alive = false; };
  }, [frame, docs]);

  useLayoutEffect(() => {
    const el = stage.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  const go = useCallback((by: number) => {
    if (!frames.length || at < 0) return;
    const next = frames[Math.max(0, Math.min(frames.length - 1, at + by))]!;
    setId(next.id);
  }, [frames, at]);
  const close = useCallback(() => onClose(frame?.id ?? startId), [onClose, frame, startId]);

  // Links clicked inside the screen, and keys pressed while it has focus.
  useEffect(() => {
    const onMessage = (e: MessageEvent): void => {
      if (!win.current || e.source !== win.current) return;
      const data = e.data as { aicoBoard?: string; href?: unknown; key?: unknown } | null;
      if (!data || typeof data !== 'object') return;
      if (data.aicoBoard === 'nav' && typeof data.href === 'string' && frame) {
        const target = frameForHref(board, frame.file, data.href);
        if (target) { setId(target.id); setNotice(null); } else setNotice(`“${data.href.slice(0, 80)}” is not a screen on this board`);
      } else if (data.aicoBoard === 'key') {
        if (data.key === 'Escape') close();
        else if (data.key === 'ArrowRight' && present) go(1);
        else if (data.key === 'ArrowLeft' && present) go(-1);
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [board, frame, close, go, present]);

  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 3200);
    return () => clearTimeout(t);
  }, [notice]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') { e.preventDefault(); close(); }
      else if (e.key === 'ArrowRight' || e.key === 'PageDown' || (present && e.key === ' ')) { e.preventDefault(); go(1); }
      else if (e.key === 'ArrowLeft' || e.key === 'PageUp') { e.preventDefault(); go(-1); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [close, go, present]);

  // Present asks for full screen; leaving full screen (Esc does that first) leaves Present.
  useEffect(() => {
    if (!present) return;
    const el = root.current;
    let entered = false;
    el?.requestFullscreen?.().then(() => { entered = true; }, () => { /* not allowed here: Present still works in the window */ });
    const onChange = (): void => { if (entered && !document.fullscreenElement) close(); };
    document.addEventListener('fullscreenchange', onChange);
    return () => {
      document.removeEventListener('fullscreenchange', onChange);
      if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
    };
  }, [present]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!frame) return null;
  const pad = present ? 0 : 32;
  const scale = playScale(frame.width, frame.height, Math.max(1, size.w - pad * 2), Math.max(1, size.h - pad * 2));

  return (
    <div ref={root} className="absolute inset-0 z-30 flex flex-col bg-[#101114] text-white" role="dialog" aria-label={`${present ? 'Presenting' : 'Playing'} ${frame.title}`}>
      <div className={`flex h-12 shrink-0 items-center gap-2 border-b border-white/10 px-3 ${present ? 'absolute inset-x-0 top-0 z-10 bg-[#101114]/85 opacity-0 backdrop-blur transition-opacity duration-200 hover:opacity-100 focus-within:opacity-100' : ''}`}>
        <button type="button" onClick={close} className="flex items-center gap-1.5 rounded-md px-2 py-1.5 text-[13px] text-white/80 hover:bg-white/10 hover:text-white" title="Back to the board (Esc)">
          <BoardIcon name="back" size={15} />Board
        </button>
        <div className="mx-1 h-5 w-px bg-white/15" />
        <div className="min-w-0 flex-1 truncate text-[13px]">
          {section && <span className="text-white/50">{section.title}<span className="px-1.5">›</span></span>}
          <span className="font-medium">{frame.title}</span>
          <span className="ml-2 text-[12px] tabular-nums text-white/40">{frame.width}×{frame.height}{scale < 0.999 ? ` · ${Math.round(scale * 100)}%` : ''}</span>
        </div>
        <div className="flex items-center" role="group" aria-label="Screens">
          <button type="button" onClick={() => go(-1)} disabled={at <= 0} className="rounded-md p-1.5 text-white/80 hover:bg-white/10 disabled:opacity-30" title="Previous screen (←)" aria-label="Previous screen"><BoardIcon name="back" /></button>
          <span className="min-w-[52px] text-center text-[12px] tabular-nums text-white/60" aria-live="polite">{at + 1} / {frames.length}</span>
          <button type="button" onClick={() => go(1)} disabled={at >= frames.length - 1} className="rounded-md p-1.5 text-white/80 hover:bg-white/10 disabled:opacity-30" title="Next screen (→)" aria-label="Next screen"><BoardIcon name="next" /></button>
        </div>
        <button type="button" onClick={() => onDownload(frame)} className="rounded-md p-1.5 text-white/80 hover:bg-white/10" title="Download this screen (HTML)" aria-label="Download this screen"><BoardIcon name="download" /></button>
        <button type="button" onClick={close} className="rounded-md p-1.5 text-white/80 hover:bg-white/10" title="Close (Esc)" aria-label="Close"><BoardIcon name="close" /></button>
      </div>
      <div ref={stage} className="relative min-h-0 flex-1 overflow-hidden">
        {error ? (
          <div className="grid h-full place-items-center text-[13px] text-white/70">{error}</div>
        ) : !doc ? (
          <div className="grid h-full place-items-center"><span className="h-6 w-6 animate-spin rounded-full border-2 border-white/20 border-t-white/80" role="status" aria-label="Loading the screen" /></div>
        ) : (
          <div className="absolute left-1/2 top-1/2 overflow-hidden rounded-[6px] shadow-[0_24px_80px_rgba(0,0,0,0.55)] ring-1 ring-white/10"
            style={{ width: frame.width, height: frame.height, transform: `translate(-50%, -50%) scale(${scale})` }}>
            <ScreenFrame frame={frame} doc={doc} host={host} live title={frame.title} onWindow={w => { win.current = w; }} />
          </div>
        )}
        {notice && (
          <div className="pointer-events-none absolute bottom-5 left-1/2 -translate-x-1/2 rounded-full bg-black/80 px-4 py-2 text-[12.5px] text-white shadow-lg ring-1 ring-white/10" role="status">{notice}</div>
        )}
        {present && (
          <div className="pointer-events-none absolute bottom-3 right-4 text-[11.5px] tabular-nums text-white/35">{at + 1} / {frames.length} · ← → · Esc</div>
        )}
      </div>
    </div>
  );
}
