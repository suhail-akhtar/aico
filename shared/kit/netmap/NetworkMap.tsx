/**
 * The network topology widget.
 *
 * Draws a NetMapSpec: typed devices with icons, hostnames and addresses, inside
 * zone boxes, joined by links labelled with protocol and port, coloured by
 * state, and optionally ANIMATED to show which way traffic is moving.
 *
 * ONE SVG, NO CANVAS, NO LIBRARY. Everything is laid out by `layout.ts` into
 * plain numbers, so this file only maps geometry to elements. That keeps the
 * hard part testable without a DOM, and it means the diagram is selectable
 * text, themeable by CSS custom properties, and captured correctly by the
 * operating system's own screenshot tool.
 *
 * UNKNOWN IS DRAWN AS UNKNOWN. A node nothing is reporting on renders grey and
 * dashed. It never renders green. On a topology picture the temptation to
 * default to healthy is strong and the consequence is an operator who believes
 * a leg of the path is fine when nothing has ever checked it.
 *
 * VIEWING A BIG ONE. A real estate does not fit in a panel, so the diagram pans
 * and zooms, fits to view, and expands to fill the window. Without that the
 * honest options were "unreadable" or "scroll a 3000px canvas through a 400px
 * slot", and an operator picked neither.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { parseNetMap, type NetMapSpec, type NodeStatus } from './spec.js';
import { layoutNetMap, linkLabelText, type Layout } from './layout.js';
import { iconPaths, KIND_LABEL } from './icons.js';

/** Status → CSS custom property. Unknown is deliberately the muted one. */
const STATUS_VAR: Record<NodeStatus, string> = {
  up: 'var(--ok)',
  degraded: 'var(--warn)',
  down: 'var(--crit)',
  unknown: 'var(--ink4)',
};

const STATUS_WORD: Record<NodeStatus, string> = {
  up: 'up',
  degraded: 'degraded',
  down: 'down',
  unknown: 'not monitored',
};

const ZOOM_MIN = 0.25;
const ZOOM_MAX = 3;

interface View { x: number; y: number; k: number }

export function NetworkMap({ options }: { options?: unknown }) {
  const parsed = useMemo(() => parseNetMap(options), [options]);

  if (!parsed.ok || !parsed.spec) {
    return (
      <div className="wg-error" role="alert">
        <span aria-hidden>⚠</span> network map could not be read: {parsed.error}
      </div>
    );
  }
  return <NetMapView spec={parsed.spec} dangling={parsed.danglingLinks} />;
}

function NetMapView({ spec, dangling }: { spec: NetMapSpec; dangling: string[] }) {
  const layout = useMemo(() => layoutNetMap(spec), [spec]);

  /** Hovered node — transient highlight. */
  const [hover, setHover] = useState<string | null>(null);
  /**
   * Pinned node — survives the mouse leaving.
   *
   * Hover alone made "what talks to this box" a question you could ask but not
   * READ: the moment you moved toward the highlighted lines to follow one, the
   * highlight died. Clicking pins it.
   */
  const [pinned, setPinned] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [view, setView] = useState<View>({ x: 0, y: 0, k: 1 });

  const wrapRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ x: number; y: number; vx: number; vy: number } | null>(null);

  const active = pinned ?? hover;

  /** Scale and centre so the whole diagram is visible in the current box. */
  const fit = useCallback(() => {
    const el = wrapRef.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    if (!width || !height) return;
    // Never scale UP to fit — a four-node diagram blown to 3x looks broken.
    const k = Math.min(1, Math.min(width / layout.width, height / layout.height) * 0.94);
    setView({ k, x: (width - layout.width * k) / 2, y: (height - layout.height * k) / 2 });
  }, [layout.width, layout.height]);

  // Fit on first paint and whenever the diagram or the box changes size.
  useEffect(() => { fit(); }, [fit, expanded]);
  useEffect(() => {
    const el = wrapRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => fit());
    ro.observe(el);
    return () => ro.disconnect();
  }, [fit]);

  // Escape leaves full-screen. A modal you cannot dismiss with Escape is a trap.
  useEffect(() => {
    if (!expanded) return;
    const h = (e: KeyboardEvent): void => { if (e.key === 'Escape') setExpanded(false); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [expanded]);

  const zoomBy = useCallback((factor: number, cx?: number, cy?: number) => {
    setView((v) => {
      const k = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, v.k * factor));
      if (k === v.k) return v;
      const el = wrapRef.current;
      const rect = el?.getBoundingClientRect();
      // Zoom about the pointer when we have one, the centre otherwise — so the
      // thing you are looking at stays where you are looking.
      const px = cx ?? (rect ? rect.width / 2 : 0);
      const py = cy ?? (rect ? rect.height / 2 : 0);
      const ratio = k / v.k;
      return { k, x: px - (px - v.x) * ratio, y: py - (py - v.y) * ratio };
    });
  }, []);

  const onWheel = (e: React.WheelEvent): void => {
    // Only when the pointer is over the diagram, and never letting the page
    // scroll instead — a wheel that sometimes zooms and sometimes scrolls is
    // worse than one that only scrolls.
    e.preventDefault();
    const rect = wrapRef.current?.getBoundingClientRect();
    zoomBy(e.deltaY < 0 ? 1.12 : 1 / 1.12,
      rect ? e.clientX - rect.left : undefined,
      rect ? e.clientY - rect.top : undefined);
  };

  const onPointerDown = (e: React.PointerEvent): void => {
    if (e.button !== 0) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    dragRef.current = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y };
  };
  const onPointerMove = (e: React.PointerEvent): void => {
    const d = dragRef.current;
    if (!d) return;
    setView((v) => ({ ...v, x: d.vx + (e.clientX - d.x), y: d.vy + (e.clientY - d.y) }));
  };
  const endDrag = (e: React.PointerEvent): void => {
    if (dragRef.current) {
      (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
      dragRef.current = null;
    }
  };

  const counts = spec.nodes.reduce<Record<NodeStatus, number>>(
    (acc, n) => { acc[n.status] += 1; return acc; },
    { up: 0, degraded: 0, down: 0, unknown: 0 },
  );

  const body = (
    <div className={`nm${expanded ? ' nm-expanded' : ''}`}>
      <div className="nm-bar">
        <div className="nm-legend">
          {(['down', 'degraded', 'up', 'unknown'] as NodeStatus[])
            .filter((s) => counts[s] > 0)
            .map((s) => (
              <span key={s} className="nm-lg">
                <i style={{ background: STATUS_VAR[s] }} />
                {counts[s]} {STATUS_WORD[s]}
              </span>
            ))}
          {dangling.length > 0 && (
            <span className="nm-lg nm-warn" title={dangling.join('\n')}>
              {dangling.length} link{dangling.length === 1 ? '' : 's'} dropped
            </span>
          )}
          {pinned && (
            <button className="nm-lg nm-pinned" onClick={() => setPinned(null)}>
              pinned: {spec.nodes.find((n) => n.id === pinned)?.label ?? pinned} ✕
            </button>
          )}
        </div>

        <div className="nm-tools">
          <button onClick={() => zoomBy(1 / 1.25)} title="Zoom out" aria-label="Zoom out">−</button>
          <span className="nm-zoom">{Math.round(view.k * 100)}%</span>
          <button onClick={() => zoomBy(1.25)} title="Zoom in" aria-label="Zoom in">+</button>
          <button onClick={fit} title="Fit the whole diagram">Fit</button>
          <button onClick={() => setExpanded((x) => !x)}
            title={expanded ? 'Close full screen (Esc)' : 'Expand to full screen'}>
            {expanded ? '⤡ Close' : '⤢ Expand'}
          </button>
        </div>
      </div>

      <div
        className="nm-canvas"
        ref={wrapRef}
        onWheel={onWheel}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        // Clicking empty canvas clears the pin, which is the obvious gesture.
        onClick={(e) => { if (e.target === e.currentTarget) setPinned(null); }}
      >
        <svg
          className="nm-svg"
          width="100%"
          height="100%"
          role="img"
          aria-label={spec.title ?? `Network diagram with ${spec.nodes.length} devices`}
        >
          <Defs />
          <g transform={`translate(${view.x} ${view.y}) scale(${view.k})`}>
            <Scene layout={layout} active={active} onHover={setHover} onPin={setPinned} pinned={pinned} />
          </g>
        </svg>
      </div>
    </div>
  );

  if (!expanded) return body;

  // Full screen is a fixed overlay rather than a portal: the widget lives
  // inside a scrolling transcript, and a portal would need a mount point the
  // pack cannot assume exists.
  return <div className="nm-overlay" role="dialog" aria-modal="true">{body}</div>;
}

function Defs() {
  return (
    <defs>
      {/* One marker per status so an arrowhead matches its line. */}
      {(['up', 'degraded', 'down', 'unknown'] as NodeStatus[]).map((s) => (
        <marker
          key={s}
          id={`nm-arrow-${s}`}
          viewBox="0 0 8 8"
          refX="7"
          refY="4"
          markerWidth="7"
          markerHeight="7"
          orient="auto-start-reverse"
        >
          <path d="M0 1 L7 4 L0 7 z" fill={STATUS_VAR[s]} />
        </marker>
      ))}
    </defs>
  );
}

function Scene({
  layout, active, pinned, onHover, onPin,
}: {
  layout: Layout;
  active: string | null;
  pinned: string | null;
  onHover: (id: string | null) => void;
  onPin: (id: string | null) => void;
}) {
  return (
    <>
      {/* Zones first, so everything else sits on top of them. */}
      {layout.zones.map((z) => (
        <g key={z.name} className="nm-zone">
          <rect x={z.x} y={z.y} width={z.w} height={z.h} rx={8} />
          <text x={z.x + 10} y={z.y + 13}>{z.name}</text>
        </g>
      ))}

      {layout.links.map((p, i) => {
        const text = linkLabelText(p.link);
        const colour = STATUS_VAR[p.link.status];
        const dim = active !== null && active !== p.link.from && active !== p.link.to;
        const flow = p.link.flow;
        return (
          <g key={`${p.link.from}-${p.link.to}-${i}`} className={`nm-link${dim ? ' dim' : ''}`}>
            <path
              d={p.path}
              stroke={colour}
              strokeDasharray={p.link.dashed || p.link.status === 'unknown' ? '5 4' : undefined}
              markerEnd={`url(#nm-arrow-${p.link.status})`}
              markerStart={p.link.direction === 'both' ? `url(#nm-arrow-${p.link.status})` : undefined}
            />

            {/*
              Animated flow. A second stroke of short dashes slides along the
              same path, so an inbound scan and an outbound API call read
              differently at a glance rather than needing the arrowheads read.
              Drawn only when the author asked for it: motion is a claim that
              something is moving NOW.
            */}
            {flow !== 'none' && (
              <path
                className={`nm-flow nm-flow-${flow === 'reverse' ? 'rev' : 'fwd'}`}
                d={p.path}
                stroke={colour}
                strokeDasharray="2 12"
              />
            )}
            {flow === 'both' && (
              <path className="nm-flow nm-flow-rev" d={p.path} stroke={colour} strokeDasharray="2 12" />
            )}

            {text && (
              <>
                {/* A plate behind the label — an unbacked label on a line is
                    unreadable wherever the two cross. Width comes from layout,
                    which measured the text, rather than from a guess here. */}
                <rect className="nm-lplate" x={p.lx - p.lw / 2} y={p.ly - 7} width={p.lw} height={14} rx={3} />
                <text className="nm-ltext" x={p.lx} y={p.ly + 3}>{text}</text>
              </>
            )}
          </g>
        );
      })}

      {layout.nodes.map((p) => {
        const n = p.node;
        const colour = STATUS_VAR[n.status];
        const dim = active !== null && active !== n.id;
        return (
          <g
            key={n.id}
            className={`nm-node${n.focus ? ' focus' : ''}${dim ? ' dim' : ''}${pinned === n.id ? ' pinned' : ''}`}
            transform={`translate(${p.x} ${p.y})`}
            onMouseEnter={() => onHover(n.id)}
            onMouseLeave={() => onHover(null)}
            onClick={(e) => { e.stopPropagation(); onPin(pinned === n.id ? null : n.id); }}
          >
            <title>
              {`${n.label}${n.address ? ` (${n.address})` : ''}\n${KIND_LABEL[n.kind]} · ${STATUS_WORD[n.status]}`
                + `${n.detail ? `\n${n.detail}` : ''}${n.zone ? `\nZone: ${n.zone}` : ''}`
                + '\nClick to pin'}
            </title>

            <rect
              className="nm-box"
              width={p.w}
              height={p.h}
              rx={7}
              stroke={colour}
              strokeDasharray={n.status === 'unknown' ? '4 3' : undefined}
            />
            {/* A status stripe down the leading edge: readable at a glance even
                when the diagram is zoomed out past the text. */}
            <rect className="nm-stripe" width={3} height={p.h} rx={2} fill={colour} />

            <g transform="translate(13 12)" style={{ color: colour }}>
              {iconPaths(n.kind).map((d, i) => (
                <path key={i} d={d} fill="none" stroke="currentColor"
                  strokeWidth={1.2} strokeLinecap="round" strokeLinejoin="round" />
              ))}
            </g>

            <text className="nm-name" x={38} y={22}>{n.label}</text>
            {n.address && <text className="nm-addr" x={38} y={35}>{n.address}</text>}
            {n.detail && <text className="nm-detail" x={38} y={n.address ? 47 : 35}>{n.detail}</text>}
          </g>
        );
      })}
    </>
  );
}
