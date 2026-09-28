/**
 * ```geometry — a construction drawn to scale: points, segments, lines, rays,
 * vectors, circles, polygons and marked angles, with the lengths, angles,
 * areas and perimeters computed from the coordinates and listed beneath.
 *
 * The figure is fitted to its own contents with a margin, y points up (as in
 * a maths book, not a screen), and a unit grid helps judge scale.
 *
 * @module shared/kit/math/Geometry
 */

import React, { useMemo } from 'react';
import { angleAt, dist, measurements, parseGeometry, type GeometrySpec, type Pt } from './core';

const W = 640;
const H = 400;

function fit(spec: GeometrySpec): { tx: (p: Pt) => [number, number]; scale: number; bounds: [number, number, number, number] } {
  const ps: Pt[] = Object.values(spec.points);
  for (const c of spec.circles) {
    const ctr = spec.points[c.center]!;
    const r = c.r ?? (c.through ? dist(ctr, spec.points[c.through]!) : 1);
    ps.push([ctr[0] - r, ctr[1] - r], [ctr[0] + r, ctr[1] + r]);
  }
  let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const [x, y] of ps) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  if (spec.axes) { x0 = Math.min(x0, 0); y0 = Math.min(y0, 0); x1 = Math.max(x1, 0); y1 = Math.max(y1, 0); }
  const pad = Math.max(x1 - x0, y1 - y0, 1) * 0.12 + 0.5;
  x0 -= pad; y0 -= pad; x1 += pad; y1 += pad;
  const scale = Math.min(W / (x1 - x0), H / (y1 - y0));
  const ox = (W - (x1 - x0) * scale) / 2;
  const oy = (H - (y1 - y0) * scale) / 2;
  return { tx: ([x, y]) => [ox + (x - x0) * scale, H - (oy + (y - y0) * scale)], scale, bounds: [x0, y0, x1, y1] };
}

function extend(a: [number, number], b: [number, number], both: boolean): [[number, number], [number, number]] {
  const dx = b[0] - a[0]; const dy = b[1] - a[1];
  const k = 4000 / Math.max(1e-9, Math.hypot(dx, dy));
  return [both ? [a[0] - dx * k, a[1] - dy * k] : a, [b[0] + dx * k, b[1] + dy * k]];
}

export function Geometry({ source, streaming = false }: { source: string; streaming?: boolean }): React.ReactElement {
  const parsed = useMemo(() => {
    if (streaming) return null;
    try { const spec = parseGeometry(source); return { spec, view: fit(spec), measures: spec.measure ? measurements(spec) : [] }; }
    catch (err) { return { error: (err as Error).message }; }
  }, [source, streaming]);
  if (streaming) return <p className="p-2 text-[11px] text-aico-muted">Figure arriving…</p>;
  if (!parsed || 'error' in parsed) throw new Error(parsed?.error ?? 'no figure');
  const { spec, view, measures } = parsed;
  const P = (n: string): [number, number] => view.tx(spec.points[n]!);
  const ink = 'var(--aico-text-primary)';
  const accent = 'var(--aico-accent)';
  const muted = 'var(--aico-text-muted)';
  const [bx0, by0, bx1, by1] = view.bounds;

  const grid: React.ReactNode[] = [];
  if (spec.grid && view.scale > 6) {
    const stepU = view.scale < 14 ? 5 : view.scale < 30 ? 2 : 1;
    for (let x = Math.ceil(bx0 / stepU) * stepU; x <= bx1; x += stepU) {
      const [sx] = view.tx([x, 0]);
      grid.push(<line key={`gx${x}`} x1={sx} x2={sx} y1={0} y2={H} stroke="var(--aico-border-subtle)" strokeWidth={x === 0 && spec.axes ? 1.4 : 0.6} />);
    }
    for (let y = Math.ceil(by0 / stepU) * stepU; y <= by1; y += stepU) {
      const [, sy] = view.tx([0, y]);
      grid.push(<line key={`gy${y}`} y1={sy} y2={sy} x1={0} x2={W} stroke="var(--aico-border-subtle)" strokeWidth={y === 0 && spec.axes ? 1.4 : 0.6} />);
    }
  }

  return (
    <div className="p-2">
      {spec.title && <div className="px-1 pb-1 text-[13px] font-semibold text-aico-primary">{spec.title}</div>}
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ maxHeight: 440 }} role="img" aria-label={spec.title ?? 'Geometry figure'}>
        <defs>
          <marker id="geo-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill={accent} /></marker>
        </defs>
        <g>{grid}</g>
        {spec.polygons.map((poly, i) => (
          <polygon key={`pg${i}`} points={poly.points.map(n => P(n).join(',')).join(' ')} fill={poly.fill ? 'color-mix(in srgb, var(--aico-accent) 12%, transparent)' : 'none'} stroke={accent} strokeWidth={1.6} />
        ))}
        {spec.circles.map((c, i) => {
          const r = (c.r ?? (c.through ? dist(spec.points[c.center]!, spec.points[c.through]!) : 1)) * view.scale;
          const [cx, cy] = P(c.center);
          return <circle key={`c${i}`} cx={cx} cy={cy} r={r} fill="none" stroke={accent} strokeWidth={1.6} />;
        })}
        {spec.lines.map(([a, b], i) => { const [p, q] = extend(P(a), P(b), true); return <line key={`l${i}`} x1={p[0]} y1={p[1]} x2={q[0]} y2={q[1]} stroke={muted} strokeWidth={1.2} />; })}
        {spec.rays.map(([a, b], i) => { const [p, q] = extend(P(a), P(b), false); return <line key={`r${i}`} x1={p[0]} y1={p[1]} x2={q[0]} y2={q[1]} stroke={muted} strokeWidth={1.2} />; })}
        {spec.segments.map(([a, b, label], i) => {
          const [x1, y1] = P(a); const [x2, y2] = P(b);
          return (
            <g key={`s${i}`}>
              <line x1={x1} y1={y1} x2={x2} y2={y2} stroke={ink} strokeWidth={2} />
              {label && <text x={(x1 + x2) / 2 + 6} y={(y1 + y2) / 2 - 6} fontSize={13} fill={ink}>{label}</text>}
            </g>
          );
        })}
        {spec.vectors.map(([a, b, label], i) => {
          const [x1, y1] = P(a); const [x2, y2] = P(b);
          return (
            <g key={`v${i}`}>
              <line x1={x1} y1={y1} x2={x2} y2={y2} stroke={accent} strokeWidth={2.2} markerEnd="url(#geo-arrow)" />
              {label && <text x={(x1 + x2) / 2 + 6} y={(y1 + y2) / 2 - 6} fontSize={13} fill={accent} fontStyle="italic">{label}</text>}
            </g>
          );
        })}
        {spec.angles.map(([a, b, c], i) => {
          const [bx, by] = P(b);
          const pa = P(a); const pc = P(c);
          const a1 = Math.atan2(pa[1] - by, pa[0] - bx);
          const a2 = Math.atan2(pc[1] - by, pc[0] - bx);
          const deg = angleAt(spec.points[a]!, spec.points[b]!, spec.points[c]!);
          const r = 26;
          let sweep = a2 - a1;
          while (sweep <= -Math.PI) sweep += 2 * Math.PI;
          while (sweep > Math.PI) sweep -= 2 * Math.PI;
          const start: [number, number] = [bx + r * Math.cos(a1), by + r * Math.sin(a1)];
          const end: [number, number] = [bx + r * Math.cos(a1 + sweep), by + r * Math.sin(a1 + sweep)];
          const mid = a1 + sweep / 2;
          const right = Math.abs(deg - 90) < 0.05;
          return (
            <g key={`a${i}`}>
              {right
                ? <path d={`M${bx + 14 * Math.cos(a1)},${by + 14 * Math.sin(a1)} L${bx + 14 * Math.cos(a1) + 14 * Math.cos(a1 + sweep)},${by + 14 * Math.sin(a1) + 14 * Math.sin(a1 + sweep)} L${bx + 14 * Math.cos(a1 + sweep)},${by + 14 * Math.sin(a1 + sweep)}`} fill="none" stroke="var(--aico-warning)" strokeWidth={1.4} />
                : <path d={`M${start[0]},${start[1]} A${r},${r} 0 0,${sweep > 0 ? 1 : 0} ${end[0]},${end[1]}`} fill="none" stroke="var(--aico-warning)" strokeWidth={1.6} />}
              <text x={bx + (r + 16) * Math.cos(mid)} y={by + (r + 16) * Math.sin(mid) + 4} fontSize={12} fill="var(--aico-warning)" textAnchor="middle">{deg.toFixed(deg % 1 === 0 ? 0 : 1)}°</text>
            </g>
          );
        })}
        {Object.entries(spec.points).map(([name]) => {
          const [x, y] = P(name);
          return (
            <g key={`p${name}`}>
              <circle cx={x} cy={y} r={3.8} fill={ink} />
              <text x={x + 7} y={y - 7} fontSize={14} fontWeight={600} fill={ink}>{name}</text>
            </g>
          );
        })}
        {spec.labels.map((l, i) => {
          const at = typeof l.at === 'string' ? P(l.at) : view.tx(l.at);
          return <text key={`t${i}`} x={at[0] + 8} y={at[1] + 16} fontSize={12} fill={muted}>{l.text}</text>;
        })}
      </svg>
      {measures.length > 0 && (
        <div className="mt-1 flex flex-wrap gap-x-5 gap-y-1 border-t border-aico-border-subtle px-1 pt-2 font-mono text-[12px] text-aico-secondary">
          {measures.map(m => <span key={m}>{m}</span>)}
          <span className="text-aico-muted">(computed from the coordinates)</span>
        </div>
      )}
    </div>
  );
}
