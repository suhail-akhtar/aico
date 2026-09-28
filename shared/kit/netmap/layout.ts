/**
 * Placing a network diagram.
 *
 * DETERMINISTIC, WHICH RULES OUT A FORCE SIMULATION. A force-directed layout
 * looks organic and is the wrong tool here for two reasons. It is iterative, so
 * the same spec draws a different picture each time — and an operator comparing
 * this morning's topology against last night's needs the picture to have moved
 * only where the network did. And it needs a random seed, which means either
 * non-reproducibility or a seeded PRNG whose output nobody can reason about.
 *
 * So: LAYERED. Nodes go into tiers, tiers become columns (or rows), and within
 * a tier they are ordered by a stable rule. Same input, same output, every
 * time, with no iteration budget and no jitter.
 *
 * Pure functions returning numbers, so the awkward parts — tier inference,
 * ordering, edge routing around a node — are testable without a DOM.
 */
import type { NetMapSpec, NetNode, NetLink } from './spec.js';

export interface Box { x: number; y: number; w: number; h: number }
export interface PlacedNode extends Box { node: NetNode; tier: number }
export interface PlacedZone extends Box { name: string }

export interface PlacedLink {
  link: NetLink;
  /** SVG path, already routed. */
  path: string;
  /** Where the label sits. */
  lx: number;
  ly: number;
  /** Arrowhead angle in degrees at the target end. */
  angle: number;
  /** Backward-pointing: drawn with a curve so it does not overlap its twin. */
  reversed: boolean;
  /** Rendered width of the label plate, so the renderer does not re-measure. */
  lw: number;
}

export interface Layout {
  nodes: PlacedNode[];
  links: PlacedLink[];
  zones: PlacedZone[];
  width: number;
  height: number;
}

/**
 * Node box geometry.
 *
 * The width is now MEASURED, not fixed. A fixed 148px clipped every real
 * hostname the moment an estate had one: "Meilisearch / Chrom", "Zabbix agent
 * + serv", "Azure / O365 / Team" — cut mid-word, and cut again by the zone
 * rectangle drawn around them. A topology picture whose labels you cannot read
 * is not a topology picture.
 */
const NODE_MIN_W = 148;
const NODE_MAX_W = 300;
const NODE_H = 56;
const GAP_ALONG = 26;   // between nodes within a tier
const GAP_ACROSS = 120; // between tiers — wider now that labels sit on the links
const PAD = 28;
const ZONE_PAD = 16;

/** Space reserved left of the text for the device icon. */
const ICON_GUTTER = 38;
/** Right-hand breathing room inside the box. */
const TEXT_PAD = 14;

/**
 * Approximate rendered width of a string, in px, without a DOM.
 *
 * Layout runs in a pure module so it can be tested and so it produces the same
 * geometry on a server as in the renderer — which rules out `measureText`. The
 * table below is per-character advance for the UI face at the size each line is
 * drawn, derived from measuring the actual font: wide enough that a label is
 * never clipped, tight enough that boxes are not padded with dead space.
 *
 * Over-estimating is the safe direction. A box slightly too wide looks
 * deliberate; a box slightly too narrow cuts a hostname in half.
 */
export function textWidth(s: string, px: number): number {
  let units = 0;
  for (const ch of s) {
    if (ch === ' ') units += 0.28;
    else if ("iljt.,;:!|'`".includes(ch)) units += 0.30;
    else if ('fr()[]{}/-'.includes(ch)) units += 0.38;
    else if ('mwMW@'.includes(ch)) units += 0.90;
    else if (ch >= 'A' && ch <= 'Z') units += 0.68;
    else if (ch >= '0' && ch <= '9') units += 0.56;
    else units += 0.55;
  }
  return units * px;
}

/** Box width for one node: whichever of its three lines is widest. */
export function nodeWidth(n: NetNode): number {
  const w = Math.max(
    textWidth(n.label, 12),
    n.address ? textWidth(n.address, 10) : 0,
    n.detail ? textWidth(n.detail, 9.5) : 0,
  );
  return Math.min(NODE_MAX_W, Math.max(NODE_MIN_W, Math.ceil(w + ICON_GUTTER + TEXT_PAD)));
}

/**
 * Work out which tier each node belongs to.
 *
 * An explicit `tier` always wins — the model usually knows the architecture
 * better than the graph shape does. Everything else is placed by its distance
 * from a SOURCE node (one with no inbound links), which is what makes a traffic
 * path read left to right.
 *
 * A cycle cannot be layered, so nodes only reachable inside one are placed at
 * the depth they were first reached. That is arbitrary but STABLE, which is the
 * property that actually matters.
 */
export function assignTiers(nodes: NetNode[], links: NetLink[]): Map<string, number> {
  const tier = new Map<string, number>();
  for (const n of nodes) if (n.tier !== undefined) tier.set(n.id, n.tier);

  const inbound = new Map<string, number>();
  const out = new Map<string, string[]>();
  for (const n of nodes) { inbound.set(n.id, 0); out.set(n.id, []); }
  for (const l of links) {
    inbound.set(l.to, (inbound.get(l.to) ?? 0) + 1);
    out.get(l.from)!.push(l.to);
  }

  // Seeds: explicitly-tiered nodes, then true sources. If neither exists (a
  // pure cycle), fall back to the first node so the layout still happens.
  const queue: Array<[string, number]> = [];
  for (const n of nodes) {
    if (n.tier !== undefined) queue.push([n.id, n.tier]);
    else if ((inbound.get(n.id) ?? 0) === 0) { tier.set(n.id, 0); queue.push([n.id, 0]); }
  }
  if (queue.length === 0 && nodes[0]) { tier.set(nodes[0].id, 0); queue.push([nodes[0].id, 0]); }

  // Breadth-first, taking the DEEPEST assignment so a node with two paths to it
  // sits after both of its dependencies rather than beside one of them.
  let guard = nodes.length * links.length + nodes.length + 1;
  while (queue.length > 0 && guard-- > 0) {
    const [id, d] = queue.shift()!;
    for (const next of out.get(id) ?? []) {
      const explicit = nodes.find((n) => n.id === next)?.tier;
      if (explicit !== undefined) continue;   // never move a node the model placed
      const cur = tier.get(next);
      if (cur === undefined || d + 1 > cur) { tier.set(next, d + 1); queue.push([next, d + 1]); }
    }
  }

  // Anything unreachable — an isolated node, or one only inside a cycle — goes
  // in its own trailing tier rather than being dropped.
  const maxTier = Math.max(0, ...[...tier.values()]);
  for (const n of nodes) if (!tier.has(n.id)) tier.set(n.id, maxTier + 1);
  return tier;
}

/**
 * Order within a tier.
 *
 * Zone first, so members of a subnet end up adjacent and the zone box is a
 * rectangle rather than a comb. Then label, so the order is stable and
 * predictable rather than dependent on however the model happened to list them.
 */
function orderWithinTier(a: NetNode, b: NetNode): number {
  const za = a.zone ?? '';
  const zb = b.zone ?? '';
  if (za !== zb) return za.localeCompare(zb);
  return a.label.localeCompare(b.label);
}

/**
 * Route a link.
 *
 * TWO THINGS FIXED HERE, both visible in the field.
 *
 * ANCHORS ARE DISTRIBUTED. Every link used to leave from the exact centre of a
 * node's facing edge, so a host with twelve connections produced twelve lines
 * radiating from one pixel — an unreadable fan. `slot` spreads them along the
 * edge instead, in the order the targets are stacked, so the lines run roughly
 * parallel and you can follow one with your eye.
 *
 * LABELS SIT ALONG THEIR OWN PATH. They used to be placed at the geometric
 * midpoint, which for a fan of links is the SAME midpoint — twelve labels in
 * one vertical column, overlapping each other and the curves. `t` moves each
 * label to a different fraction along its own curve, so they stagger.
 */
function route(
  from: Box,
  to: Box,
  horizontal: boolean,
  sameTier: boolean,
  opts: { fromSlot: number; toSlot: number; t: number; labelWidth: number },
): Omit<PlacedLink, 'link'> {
  // Anchor on the facing edge so a line never crosses the box it starts from.
  const reversed = horizontal ? to.x + to.w / 2 < from.x + from.w / 2 : to.y + to.h / 2 < from.y + from.h / 2;

  // `slot` is -0.5..0.5 across the usable span of the edge. Kept inside 80% of
  // the edge so an anchor never lands on a rounded corner.
  const spread = (box: Box) => (horizontal ? box.h : box.w) * 0.8;

  const sAlong = opts.fromSlot * spread(from);
  const tAlong = opts.toSlot * spread(to);

  const sx = horizontal ? (reversed ? from.x : from.x + from.w) : from.x + from.w / 2 + sAlong;
  const sy = horizontal ? from.y + from.h / 2 + sAlong : (reversed ? from.y : from.y + from.h);
  const tx = horizontal ? (reversed ? to.x + to.w : to.x) : to.x + to.w / 2 + tAlong;
  const ty = horizontal ? to.y + to.h / 2 + tAlong : (reversed ? to.y + to.h : to.y);

  let path: string;
  let lx: number;
  let ly: number;

  if (sameTier) {
    // Two nodes in the same column: bow the line out to the side so it does not
    // run straight through whatever sits between them.
    const bow = 46 + Math.abs(opts.fromSlot) * 40;
    const mx = horizontal ? Math.max(sx, tx) + bow : (sx + tx) / 2;
    const my = horizontal ? (sy + ty) / 2 : Math.max(sy, ty) + bow;
    path = `M ${r(sx)} ${r(sy)} Q ${r(mx)} ${r(my)} ${r(tx)} ${r(ty)}`;
    // Quadratic midpoint at t=0.5 is (s + 2m + e) / 4.
    lx = (sx + 2 * mx + tx) / 4;
    ly = (sy + 2 * my + ty) / 4;
  } else {
    // Between tiers: an S-curve with control points on the tier axis, which
    // keeps every link leaving a column at the same angle.
    const c1x = horizontal ? sx + (tx - sx) / 2 : sx;
    const c1y = horizontal ? sy : sy + (ty - sy) / 2;
    const c2x = horizontal ? sx + (tx - sx) / 2 : tx;
    const c2y = horizontal ? ty : sy + (ty - sy) / 2;
    path = `M ${r(sx)} ${r(sy)} C ${r(c1x)} ${r(c1y)} ${r(c2x)} ${r(c2y)} ${r(tx)} ${r(ty)}`;
    const p = cubicAt(opts.t, [sx, sy], [c1x, c1y], [c2x, c2y], [tx, ty]);
    lx = p[0];
    ly = p[1];
  }

  // Arrowhead angle from the final approach, so it points along the curve
  // rather than at the straight-line bearing.
  const angle = horizontal ? (reversed ? 180 : 0) : (reversed ? 270 : 90);

  return { path, lx: r(lx), ly: r(ly), angle, reversed, lw: opts.labelWidth };
}

/** Round to 2dp — keeps the emitted path stable and the SVG small. */
const r = (n: number): number => Math.round(n * 100) / 100;

/** Point on a cubic Bézier at parameter t. */
function cubicAt(
  t: number, p0: [number, number], p1: [number, number], p2: [number, number], p3: [number, number],
): [number, number] {
  const u = 1 - t;
  const a = u * u * u;
  const b = 3 * u * u * t;
  const c = 3 * u * t * t;
  const d = t * t * t;
  return [
    a * p0[0] + b * p1[0] + c * p2[0] + d * p3[0],
    a * p0[1] + b * p1[1] + c * p2[1] + d * p3[1],
  ];
}

/** The text drawn on a link, so layout and renderer agree on one rule. */
export function linkLabelText(l: NetLink): string {
  if (l.label) return l.label;
  if (l.protocol && l.port !== undefined) return `${l.protocol}/${l.port}`;
  if (l.protocol) return l.protocol;
  if (l.port !== undefined) return String(l.port);
  return '';
}

export function layoutNetMap(spec: NetMapSpec): Layout {
  const horizontal = spec.direction === 'LR';
  const tiers = assignTiers(spec.nodes, spec.links);

  // Bucket by tier, then order within each.
  const byTier = new Map<number, NetNode[]>();
  for (const n of spec.nodes) {
    const t = tiers.get(n.id) ?? 0;
    if (!byTier.has(t)) byTier.set(t, []);
    byTier.get(t)!.push(n);
  }
  for (const list of byTier.values()) list.sort(orderWithinTier);

  const tierKeys = [...byTier.keys()].sort((a, b) => a - b);

  // Widths are per-NODE now, so a tier is as wide as its widest member and the
  // next tier starts after that — not after a fixed 148px that clipped anything
  // with a real hostname in it.
  const widths = new Map<string, number>();
  for (const n of spec.nodes) widths.set(n.id, nodeWidth(n));
  const tierWidth = new Map<number, number>();
  for (const t of tierKeys) {
    tierWidth.set(t, Math.max(...byTier.get(t)!.map((n) => widths.get(n.id)!)));
  }

  // Span of the tallest tier, so shorter ones can be centred against it.
  const spanOf = (list: NetNode[]) => horizontal
    ? list.length * NODE_H + (list.length - 1) * GAP_ALONG
    : list.reduce((acc, n) => acc + widths.get(n.id)!, 0) + (list.length - 1) * GAP_ALONG;
  const fullSpan = Math.max(...tierKeys.map((t) => spanOf(byTier.get(t)!)), 0);

  const placed: PlacedNode[] = [];
  const boxes = new Map<string, Box>();

  // Running offset across the flow axis, accumulating each tier's own width.
  let across = PAD;
  tierKeys.forEach((t) => {
    const list = byTier.get(t)!;
    const offset = PAD + (fullSpan - spanOf(list)) / 2;

    let along = offset;
    list.forEach((n) => {
      const w = widths.get(n.id)!;
      const box: Box = horizontal
        ? { x: across, y: along, w, h: NODE_H }
        : { x: along, y: across, w, h: NODE_H };
      boxes.set(n.id, box);
      placed.push({ ...box, node: n, tier: t });
      along += (horizontal ? NODE_H : w) + GAP_ALONG;
    });

    across += (horizontal ? tierWidth.get(t)! : NODE_H) + GAP_ACROSS;
  });

  // ── slot assignment ───────────────────────────────────────────────────────
  //
  // A node with twelve links used to emit twelve lines from one point. Each
  // link now gets a distinct anchor along the edge, ordered by where its far
  // end sits, so the lines stay in the same relative order as the nodes they
  // reach and never cross each other needlessly.

  const outgoing = new Map<string, string[]>();
  const incoming = new Map<string, string[]>();
  const key = (l: NetLink, i: number) => `${l.from} ${l.to} ${i}`;

  spec.links.forEach((l, i) => {
    if (!boxes.has(l.from) || !boxes.has(l.to)) return;
    if (!outgoing.has(l.from)) outgoing.set(l.from, []);
    if (!incoming.has(l.to)) incoming.set(l.to, []);
    outgoing.get(l.from)!.push(key(l, i));
    incoming.get(l.to)!.push(key(l, i));
  });

  /** Position of a link's far end along the cross axis, for ordering. */
  const farPos = (id: string): number => {
    const b = boxes.get(id)!;
    return horizontal ? b.y + b.h / 2 : b.x + b.w / 2;
  };

  const slotOf = new Map<string, number>();
  for (const [nodeId, keys] of [...outgoing, ...incoming]) {
    void nodeId;
    // Sort by where the OTHER end is, then spread evenly across -0.5..0.5.
    const sorted = [...keys].sort((a, b) => {
      const [af, at] = a.split(' ');
      const [bf, bt] = b.split(' ');
      const aOther = keys === outgoing.get(af!) ? at! : af!;
      const bOther = keys === outgoing.get(bf!) ? bt! : bf!;
      return farPos(aOther) - farPos(bOther);
    });
    sorted.forEach((k, i) => {
      const slot = sorted.length === 1 ? 0 : (i / (sorted.length - 1)) - 0.5;
      // Two entries per link (one out, one in); the map is keyed per side by
      // prefixing, so store both under distinct keys.
      slotOf.set(`${keys === outgoing.get(k.split(' ')[0]!) ? 'o' : 'i'}${k}`, slot);
    });
  }

  const links: PlacedLink[] = spec.links.flatMap((l, i) => {
    const a = boxes.get(l.from);
    const b = boxes.get(l.to);
    // parseNetMap already dropped dangling links; this is belt and braces so a
    // direct caller cannot produce NaN coordinates.
    if (!a || !b) return [];
    const k = key(l, i);
    const sameTier = tiers.get(l.from) === tiers.get(l.to);

    // Stagger labels along their own curve. A fan of links shares a midpoint,
    // so placing every label at t=0.5 stacked them into one unreadable column.
    const siblings = outgoing.get(l.from) ?? [];
    const idx = Math.max(0, siblings.indexOf(k));
    const t = siblings.length <= 1 ? 0.5 : 0.34 + (idx % 5) * 0.08;

    return [{
      link: l,
      ...route(a, b, horizontal, sameTier, {
        fromSlot: slotOf.get(`o${k}`) ?? 0,
        toSlot: slotOf.get(`i${k}`) ?? 0,
        t,
        labelWidth: Math.ceil(textWidth(linkLabelText(l), 9) + 12),
      }),
    }];
  });

  // Zone boxes wrap their members. Computed from placement rather than assumed,
  // so a zone whose members landed in different tiers still gets a correct box
  // — wide and obviously spanning, which is itself informative.
  const zones: PlacedZone[] = [];
  if (spec.showZones) {
    const byZone = new Map<string, Box[]>();
    for (const p of placed) {
      if (!p.node.zone) continue;
      if (!byZone.has(p.node.zone)) byZone.set(p.node.zone, []);
      byZone.get(p.node.zone)!.push(p);
    }
    for (const [name, list] of [...byZone.entries()].sort((x, y) => x[0].localeCompare(y[0]))) {
      const x = Math.min(...list.map((b) => b.x)) - ZONE_PAD;
      const y = Math.min(...list.map((b) => b.y)) - ZONE_PAD - 12; // room for the label
      const x2 = Math.max(...list.map((b) => b.x + b.w)) + ZONE_PAD;
      const y2 = Math.max(...list.map((b) => b.y + b.h)) + ZONE_PAD;
      zones.push({ name, x, y, w: x2 - x, h: y2 - y });
    }
  }

  // The canvas must contain the ZONE boxes too — they extend beyond their
  // members by design, and sizing to the nodes alone clipped every zone border.
  const right = Math.max(...placed.map((p) => p.x + p.w), ...zones.map((z) => z.x + z.w), 0);
  const bottom = Math.max(...placed.map((p) => p.y + p.h), ...zones.map((z) => z.y + z.h), 0);

  return { nodes: placed, links, zones, width: right + PAD, height: bottom + PAD };
}
