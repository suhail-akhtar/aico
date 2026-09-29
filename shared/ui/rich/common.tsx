/**
 * Pieces every rich answer block shares: the parse-or-wait hook, images that
 * vanish instead of breaking, a scroll-snap carousel with arrows, an overlay
 * that closes on Escape, external links, and one small icon set.
 *
 * @module shared/ui/rich/common
 */

import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { faviconUrl, initialOf } from './specs';
import { mediaUrl } from '../media';
import './rich.css';

/**
 * Parse a block, or say it is still arriving.
 *
 * While the message streams, a block that does not parse yet is unfinished,
 * not broken — so the placeholder shows. Once it has settled, a parse error is
 * thrown for the widget frame to show with its Fix action.
 */
export function useParsed<T>(source: string, streaming: boolean, parse: (s: string) => T): { spec?: T; waiting: boolean } {
  const result = useMemo(() => {
    try { return { spec: parse(source) }; } catch (err) { return { error: (err as Error).message }; }
  }, [source, parse]);
  if ('spec' in result) return { spec: result.spec, waiting: false };
  if (streaming) return { waiting: true };
  throw new Error(result.error);
}

export function Arriving({ what }: { what: string }): React.ReactElement {
  return <div className="aw aw-arriving">{what} arriving…</div>;
}

/** Links out of the app open in a new tab — in the desktop app, the system browser. */
export function ExtLink({ href, className, children, title, onClick }: {
  href?: string; className?: string; children: React.ReactNode; title?: string; onClick?: (e: React.MouseEvent) => void;
}): React.ReactElement {
  if (!href) return <span className={className} title={title}>{children}</span>;
  return (
    <a href={href} className={className} title={title} target="_blank" rel="noopener noreferrer" onClick={onClick}>
      {children}
    </a>
  );
}

interface DesktopBridge { invoke(channel: string, ...args: unknown[]): Promise<unknown> }

/** The desktop app's bridge, when running inside it. Read, not declared: the desktop owns the type. */
export function desktopBridge(): DesktopBridge | undefined {
  if (typeof window === 'undefined') return undefined;
  const b = (window as unknown as { aicoDesktop?: DesktopBridge }).aicoDesktop;
  return b && typeof b.invoke === 'function' ? b : undefined;
}

/** Open a mailto: link: through the shell in the desktop app, by navigation elsewhere. */
export function openMailto(href: string): void {
  const bridge = desktopBridge();
  if (bridge) { void bridge.invoke('shell:openExternal', href).catch(() => {}); return; }
  const a = document.createElement('a');
  a.href = href;
  a.rel = 'noopener';
  a.click();
}

export async function copyText(text: string, html?: string): Promise<boolean> {
  try {
    if (html && typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write) {
      await navigator.clipboard.write([new ClipboardItem({
        'text/html': new Blob([html], { type: 'text/html' }),
        'text/plain': new Blob([text], { type: 'text/plain' }),
      })]);
      return true;
    }
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try { await navigator.clipboard.writeText(text); return true; } catch { return false; }
  }
}

export function downloadText(name: string, contents: string, type = 'text/plain'): void {
  const url = URL.createObjectURL(new Blob([contents], { type: `${type};charset=utf-8` }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** An image that hides itself (or shows `fallback`) when it cannot load. */
export function SafeImg({ src, alt = '', className, fallback = null, onFail, loading = 'lazy' }: {
  src?: string; alt?: string; className?: string; fallback?: React.ReactNode; onFail?: () => void; loading?: 'lazy' | 'eager';
}): React.ReactElement | null {
  const [failed, setFailed] = useState(false);
  useEffect(() => { setFailed(false); }, [src]);
  if (!src || failed) return <>{fallback}</>;
  return (
    <img
      src={mediaUrl(src)}
      alt={alt}
      className={className}
      loading={loading}
      decoding="async"
      referrerPolicy="no-referrer"
      draggable={false}
      onError={() => { setFailed(true); onFail?.(); }}
    />
  );
}

/** A site's favicon, or its first letter in a badge when there is none. */
export function Favicon({ host, name, size = 16 }: { host?: string; name?: string; size?: number }): React.ReactElement {
  const letter = <span className="aw-letter" style={{ width: size, height: size, fontSize: Math.round(size * 0.62) }}>{initialOf(name ?? host)}</span>;
  if (!host) return letter;
  return <SafeImg src={faviconUrl(host)} className="aw-favicon" alt="" fallback={letter} />;
}

export function Stars({ rating, reviews, compact = false }: { rating?: number; reviews?: number; compact?: boolean }): React.ReactElement | null {
  if (rating === undefined) return null;
  return (
    <span className="aw-stars" aria-label={`Rated ${rating.toFixed(1)} out of 5${reviews ? ` from ${reviews} reviews` : ''}`}>
      <Icon name="star" size={compact ? 11 : 12} className="aw-star" />
      <b>{rating.toFixed(1)}</b>
      {reviews !== undefined && <span className="aw-muted">({compactNumber(reviews)})</span>}
    </span>
  );
}

export function compactNumber(n: number): string {
  if (n < 1000) return String(Math.round(n));
  if (n < 10_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}K`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}K`;
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
}

/**
 * A horizontal row that scrolls, snaps, and shows arrows only when there is
 * somewhere to go — on a phone it is a swipe, on a desktop the arrows do it.
 */
export function Carousel({ children, className = '', label, scrollRef }: {
  children: React.ReactNode; className?: string; label?: string; scrollRef?: React.MutableRefObject<HTMLDivElement | null>;
}): React.ReactElement {
  const ref = useRef<HTMLDivElement | null>(null);
  const [edges, setEdges] = useState({ left: false, right: false });
  const measure = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    setEdges({ left: el.scrollLeft > 4, right: el.scrollLeft + el.clientWidth < el.scrollWidth - 4 });
  }, []);
  useLayoutEffect(() => {
    measure();
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [measure, children]);
  const go = (dir: -1 | 1): void => {
    const el = ref.current;
    if (el) el.scrollBy({ left: dir * Math.max(200, el.clientWidth * 0.8), behavior: 'smooth' });
  };
  return (
    <div className={`aw-carousel ${className}`}>
      <div
        className="aw-track"
        ref={(el) => { ref.current = el; if (scrollRef) scrollRef.current = el; }}
        onScroll={measure}
        role="list"
        aria-label={label}
      >
        {children}
      </div>
      {edges.left && (
        <button type="button" className="aw-arrow aw-arrow-left" onClick={() => go(-1)} aria-label="Scroll back">
          <Icon name="chevron-left" size={16} />
        </button>
      )}
      {edges.right && (
        <button type="button" className="aw-arrow aw-arrow-right" onClick={() => go(1)} aria-label="Scroll on">
          <Icon name="chevron-right" size={16} />
        </button>
      )}
    </div>
  );
}

/**
 * A full-window layer on `document.body`, so no transformed ancestor in the
 * transcript can trap its `position: fixed`. Escape closes it.
 */
export function Overlay({ onClose, children, className = '', label }: {
  onClose: () => void; children: React.ReactNode; className?: string; label: string;
}): React.ReactElement | null {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); onClose(); }
    };
    window.addEventListener('keydown', onKey, true);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { window.removeEventListener('keydown', onKey, true); document.body.style.overflow = prev; };
  }, [onClose]);
  if (typeof document === 'undefined') return null;
  return createPortal(
    <div className={`aw aw-overlay ${className}`} role="dialog" aria-modal="true" aria-label={label}>
      {children}
    </div>,
    document.body,
  );
}

export type RichIcon =
  | 'star' | 'pin' | 'globe' | 'phone' | 'directions' | 'close' | 'chevron-left' | 'chevron-right'
  | 'plus' | 'minus' | 'expand' | 'play' | 'copy' | 'check' | 'edit' | 'mail' | 'download' | 'folder'
  | 'open' | 'swap' | 'clock' | 'external' | 'image' | 'tag' | 'store' | 'drop' | 'wind' | 'humidity'
  | 'sunrise' | 'sunset' | 'news' | 'fit';

const RICH_PATHS: Record<RichIcon, React.ReactNode> = {
  star: <path d="M8 1.6l1.9 4 4.4.5-3.3 3 .9 4.3L8 11.3l-3.9 2.1.9-4.3-3.3-3 4.4-.5z" fill="currentColor" stroke="none" />,
  pin: <><path d="M8 14.5s-4.5-4.2-4.5-7.8a4.5 4.5 0 0 1 9 0c0 3.6-4.5 7.8-4.5 7.8z" /><circle cx="8" cy="6.7" r="1.6" /></>,
  globe: <><circle cx="8" cy="8" r="6" /><path d="M2 8h12M8 2c1.8 1.7 2.6 3.7 2.6 6S9.8 12.3 8 14c-1.8-1.7-2.6-3.7-2.6-6S6.2 3.7 8 2z" /></>,
  phone: <path d="M5.2 2.5 3 3c-.4 4.6 5.4 10.4 10 10l.5-2.2-2.7-1.2-1.3 1.3c-1.6-.8-3.2-2.4-4-4l1.3-1.3z" />,
  directions: <><path d="M8 1.5 14.5 8 8 14.5 1.5 8z" /><path d="M6 9.5V8h3.5M8.3 6.5 9.8 8 8.3 9.5" /></>,
  close: <path d="M4 4l8 8M12 4l-8 8" />,
  'chevron-left': <path d="M10 3.5 5.5 8l4.5 4.5" />,
  'chevron-right': <path d="M6 3.5 10.5 8 6 12.5" />,
  plus: <path d="M8 3v10M3 8h10" />,
  minus: <path d="M3 8h10" />,
  expand: <><path d="M9.5 2.5h4v4" /><path d="M6.5 13.5h-4v-4" /><path d="M13.5 2.5 9 7" /><path d="M2.5 13.5 7 9" /></>,
  play: <path d="M5 3.2v9.6L13 8z" fill="currentColor" stroke="none" />,
  copy: <><rect x="5.5" y="5.5" width="8" height="8" rx="1.5" /><path d="M10.5 3.5H4A1.5 1.5 0 0 0 2.5 5v6.5" /></>,
  check: <path d="m3.5 8.5 3 3 6-7" />,
  edit: <><path d="M10.5 2.5l3 3-8 8H2.5v-3z" /><path d="M9 4l3 3" /></>,
  mail: <><rect x="2" y="3.5" width="12" height="9" rx="1.5" /><path d="m2.5 4.5 5.5 4 5.5-4" /></>,
  download: <><path d="M8 2.5v8" /><path d="m4.5 7.5 3.5 3 3.5-3" /><path d="M2.5 13h11" /></>,
  folder: <path d="M2 4.5A1.5 1.5 0 0 1 3.5 3H6l1.5 1.5h5A1.5 1.5 0 0 1 14 6v5.5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5z" />,
  open: <><path d="M9 2.5h4.5V7" /><path d="M13.5 2.5 7.5 8.5" /><path d="M11.5 9.5v3a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1h3" /></>,
  external: <><path d="M9 2.5h4.5V7" /><path d="M13.5 2.5 7.5 8.5" /><path d="M11.5 9.5v3a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1h3" /></>,
  swap: <><path d="M4.5 2.5v11M2 5l2.5-2.5L7 5" /><path d="M11.5 13.5v-11M9 11l2.5 2.5L14 11" /></>,
  clock: <><circle cx="8" cy="8" r="6" /><path d="M8 4.5V8l2.5 1.5" /></>,
  image: <><rect x="2" y="3" width="12" height="10" rx="1.5" /><circle cx="6" cy="6.5" r="1.2" /><path d="m2.5 12 4-4 3 3 1.5-1.5 2.5 2.5" /></>,
  tag: <><path d="M2.5 2.5h5l6 6-5 5-6-6z" /><circle cx="5.3" cy="5.3" r="1" /></>,
  store: <><path d="M2.5 6.5 3.5 2.5h9l1 4" /><path d="M2.5 6.5c0 1.1.9 2 2 2s1.8-.9 1.8-2c0 1.1.8 2 1.7 2s1.7-.9 1.7-2c0 1.1.9 2 1.9 2s1.9-.9 1.9-2" /><path d="M3.5 8.5v5h9v-5" /></>,
  drop: <path d="M8 2s4 4.3 4 7.2A4 4 0 0 1 4 9.2C4 6.3 8 2 8 2z" />,
  wind: <path d="M2 6h8.5a2 2 0 1 0-2-2M2 9.5h10.5a2 2 0 1 1-2 2M2 13h5" />,
  humidity: <><path d="M8 2s4 4.3 4 7.2A4 4 0 0 1 4 9.2C4 6.3 8 2 8 2z" /><path d="M6 10.5a2 2 0 0 0 2 1.5" /></>,
  sunrise: <><path d="M2 12.5h12M4.5 12.5a3.5 3.5 0 0 1 7 0" /><path d="M8 2.5v4M6 4.5l2-2 2 2" /></>,
  sunset: <><path d="M2 12.5h12M4.5 12.5a3.5 3.5 0 0 1 7 0" /><path d="M8 2.5v4M6 4.5l2 2 2-2" /></>,
  news: <><rect x="2" y="2.5" width="10" height="11" rx="1.2" /><path d="M12 5.5h2v6.5a1.5 1.5 0 0 1-3 0M4.5 5.5h5M4.5 8h5M4.5 10.5h3" /></>,
  fit: <><path d="M2.5 6V2.5H6M10 2.5h3.5V6M13.5 10v3.5H10M6 13.5H2.5V10" /></>,
};

export function Icon({ name, size = 14, className }: { name: RichIcon; size?: number; className?: string }): React.ReactElement {
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} fill="none" stroke="currentColor" strokeWidth={1.4}
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={className}>
      {RICH_PATHS[name]}
    </svg>
  );
}
