/**
 * Device icons.
 *
 * Hand-drawn SVG paths on a 16×16 grid rather than an icon font or a sprite
 * pack: the widget bundle ships inside a desktop app that must work offline,
 * and a font is a network request plus a licence question. Sixteen shapes is
 * not much code, and they can inherit `currentColor` so status colouring is a
 * property of the node rather than of the icon.
 *
 * They are drawn to be recognisable at 16px on a dark background, which means
 * SILHOUETTES, not detail: a router is a puck with arrows, a firewall is a
 * brick wall. Anyone who has read a network diagram knows them instantly, and
 * detail at this size just turns to mud.
 */
import type { NodeKind } from './spec.js';

const P = (d: string, extra?: Record<string, string | number>) => ({ d, ...extra });

/** 16×16 viewBox paths, stroked with currentColor. */
const PATHS: Record<NodeKind, Array<{ d: string; fill?: string }>> = {
  // A tower: two stacked units with drive lights.
  host: [P('M3 2h10v5H3z'), P('M3 9h10v5H3z'), P('M5 4.5h.01'), P('M5 11.5h.01')],
  // Overlapping panes — a machine that is not a machine.
  vm: [P('M2 3h9v7H2z'), P('M5 6h9v7H5z')],
  // A shipping container: box with vertical ribs.
  container: [P('M2 4h12v8H2z'), P('M5.5 4v8'), P('M8 4v8'), P('M10.5 4v8')],
  // A puck with traffic arrows crossing it.
  router: [P('M2 6h12v5H2z'), P('M5 4l-2 2 2 2'), P('M11 12l2-2-2-2'), P('M3 6h10'), P('M3 10h10')],
  // A flat box with ports along the bottom.
  switch: [P('M2 5h12v6H2z'), P('M4.5 11v1.5'), P('M7 11v1.5'), P('M9.5 11v1.5'), P('M12 11v1.5')],
  // A brick wall.
  firewall: [P('M2 3h12v10H2z'), P('M2 6.3h12'), P('M2 9.6h12'), P('M6 3v3.3'), P('M10 6.3v3.3'), P('M6 9.6V13')],
  // One in, several out.
  loadbalancer: [P('M8 2v4'), P('M3 14V9h10v5'), P('M8 6v3'), P('M3 9h10'), P('M6 2h4')],
  // The classic cylinder.
  database: [P('M3 4c0-1.1 2.2-2 5-2s5 .9 5 2v8c0 1.1-2.2 2-5 2s-5-.9-5-2z'), P('M3 4c0 1.1 2.2 2 5 2s5-.9 5-2'), P('M3 8c0 1.1 2.2 2 5 2s5-.9 5-2')],
  // A stack of platters.
  storage: [P('M2 4h12v3H2z'), P('M2 9h12v3H2z'), P('M4.5 5.5h.01'), P('M4.5 10.5h.01')],
  // A hexagon — a logical thing, not a physical one.
  service: [P('M8 2l5 3v6l-5 3-5-3V5z')],
  cloud: [P('M4.5 12a3 3 0 0 1 .3-6 4 4 0 0 1 7.6 1.2A2.6 2.6 0 0 1 12 12z')],
  // A monitor on a stand.
  client: [P('M2 3h12v8H2z'), P('M6 14h4'), P('M8 11v3')],
  // A question mark in a box: unknown is a real answer, drawn as one.
  unknown: [P('M2 2h12v12H2z'), P('M6.2 6a1.8 1.8 0 1 1 2.3 1.7c-.5.2-.5.6-.5 1.1'), P('M8 11.6h.01')],
};

export function DeviceIcon({ kind, size = 16 }: { kind: NodeKind; size?: number }) {
  const paths = PATHS[kind] ?? PATHS.unknown;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      focusable="false"
    >
      {paths.map((p, i) => <path key={i} d={p.d} />)}
    </svg>
  );
}

/** Icon paths for the SVG diagram, where a nested <svg> would complicate
 *  coordinates — the caller places a <g> and this returns the geometry. */
export function iconPaths(kind: NodeKind): string[] {
  return (PATHS[kind] ?? PATHS.unknown).map((p) => p.d);
}

/** Plain-language name, for a tooltip and for the accessible description. */
export const KIND_LABEL: Record<NodeKind, string> = {
  host: 'Host',
  vm: 'Virtual machine',
  container: 'Container',
  router: 'Router',
  switch: 'Switch',
  firewall: 'Firewall',
  loadbalancer: 'Load balancer',
  database: 'Database',
  storage: 'Storage',
  service: 'Service',
  cloud: 'Cloud / external',
  client: 'Client',
  unknown: 'Unknown device',
};
