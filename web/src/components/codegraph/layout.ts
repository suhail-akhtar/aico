/**
 * Force-directed layout for the Code map: Barnes-Hut repulsion, springs on
 * dependencies, and a pull toward each module's centre.
 *
 * ## Why not a library
 *
 * ECharts (already a dependency) lays a graph out on the main thread and
 * stalls past a couple of thousand nodes; d3-force is not a dependency and a
 * new one needs an ADR for what is a few hundred lines here (ADR 0028). This
 * runs in a Web Worker (layout.worker.ts) over typed arrays, so a 5,000-file
 * project lays out without the page freezing, and the same code runs in the
 * unit tests.
 *
 * ## Why it starts from modules
 *
 * Positions are seeded module by module (a sunflower of files around each
 * module's centre, modules on a larger sunflower sized by file count), so the
 * very first frame is already a readable map and the simulation only has to
 * relax it. Deterministic: same input, same picture — a map that reshuffles
 * every time cannot be learned.
 *
 * @module web/components/codegraph/layout
 */

export interface LayoutInput {
  n: number;
  /** Edge endpoints, flattened: [a0, b0, a1, b1, …]. */
  edges: Int32Array;
  /** Module (community) per node. */
  groups: Int32Array;
  /** Node mass (≥ 1): bigger files push harder. */
  mass?: Float32Array;
}

const GOLDEN = Math.PI * (3 - Math.sqrt(5));

/** Seed positions: modules on a sunflower, files on a sunflower inside each. */
export function initialPositions(input: LayoutInput, spacing = 14): { pos: Float32Array; centers: Map<number, [number, number]> } {
  const { n, groups } = input;
  const members = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const g = groups[i]!;
    const list = members.get(g);
    if (list) list.push(i); else members.set(g, [i]);
  }
  const order = [...members.entries()].sort((a, b) => b[1].length - a[1].length || a[0] - b[0]);
  const centers = new Map<number, [number, number]>();
  // Module centres on a sunflower whose radius grows with the files placed so far, so the
  // discs pack like one big disc: large modules in the middle, small ones around, no gaps.
  let placed = 0;
  order.forEach(([g, list], k) => {
    if (k === 0) { centers.set(g, [0, 0]); placed = list.length; return; }
    const dist = spacing * 1.25 * Math.sqrt(placed + list.length / 2) + spacing * Math.sqrt(list.length) * 0.6;
    const angle = k * GOLDEN;
    centers.set(g, [Math.cos(angle) * dist, Math.sin(angle) * dist]);
    placed += list.length;
  });
  const pos = new Float32Array(n * 2);
  for (const [g, list] of members) {
    const [cx, cy] = centers.get(g)!;
    list.forEach((node, k) => {
      const r = spacing * Math.sqrt(k + 0.5);
      const a = k * GOLDEN;
      pos[node * 2] = cx + Math.cos(a) * r;
      pos[node * 2 + 1] = cy + Math.sin(a) * r;
    });
  }
  return { pos, centers };
}

/** A Barnes-Hut quadtree over the current positions, in flat arrays. */
class QuadTree {
  // Per cell: centre of mass x/y, mass, bounds (x, y, size), first child index (−1 = leaf), body (−1 = empty, −2 = internal).
  cx: Float64Array; cy: Float64Array; m: Float64Array;
  bx: Float64Array; by: Float64Array; bs: Float64Array;
  child: Int32Array; body: Int32Array;
  count = 0;

  constructor(capacity: number) {
    this.cx = new Float64Array(capacity); this.cy = new Float64Array(capacity); this.m = new Float64Array(capacity);
    this.bx = new Float64Array(capacity); this.by = new Float64Array(capacity); this.bs = new Float64Array(capacity);
    this.child = new Int32Array(capacity); this.body = new Int32Array(capacity);
  }

  private cell(x: number, y: number, size: number): number {
    const c = this.count++;
    this.bx[c] = x; this.by[c] = y; this.bs[c] = size;
    this.cx[c] = 0; this.cy[c] = 0; this.m[c] = 0; this.child[c] = -1; this.body[c] = -1;
    return c;
  }

  build(pos: Float32Array, mass: Float32Array, n: number): void {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let i = 0; i < n; i++) {
      const x = pos[i * 2]!; const y = pos[i * 2 + 1]!;
      if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
    const size = Math.max(maxX - minX, maxY - minY, 1) * 1.01;
    this.count = 0;
    this.cell(minX, minY, size);
    for (let i = 0; i < n; i++) this.insert(0, i, pos, mass, 0);
  }

  private insert(c: number, i: number, pos: Float32Array, mass: Float32Array, depth: number): void {
    const x = pos[i * 2]!; const y = pos[i * 2 + 1]!; const w = mass[i]!;
    // Update centre of mass on the way down.
    const total = this.m[c]! + w;
    this.cx[c] = (this.cx[c]! * this.m[c]! + x * w) / total;
    this.cy[c] = (this.cy[c]! * this.m[c]! + y * w) / total;
    this.m[c] = total;
    if (this.body[c] === -1 && this.child[c] === -1) { this.body[c] = i; return; }
    if (depth > 40) return; // coincident points: keep the mass, stop splitting
    if (this.child[c] === -1) {
      if (this.count + 4 > this.cx.length) return; // out of cells: approximate, never overflow
      const half = this.bs[c]! / 2;
      const first = this.count;
      this.cell(this.bx[c]!, this.by[c]!, half);
      this.cell(this.bx[c]! + half, this.by[c]!, half);
      this.cell(this.bx[c]!, this.by[c]! + half, half);
      this.cell(this.bx[c]! + half, this.by[c]! + half, half);
      this.child[c] = first;
      const old = this.body[c]!;
      this.body[c] = -2;
      if (old >= 0) this.place(c, old, pos, mass, depth);
    }
    this.place(c, i, pos, mass, depth);
  }

  private place(c: number, i: number, pos: Float32Array, mass: Float32Array, depth: number): void {
    const half = this.bs[c]! / 2;
    const q = (pos[i * 2]! >= this.bx[c]! + half ? 1 : 0) + (pos[i * 2 + 1]! >= this.by[c]! + half ? 2 : 0);
    // insert() already counted this body's mass at `c`; the child gets it fresh.
    this.insertChild(this.child[c]! + q, i, pos, mass, depth + 1);
  }

  private insertChild(c: number, i: number, pos: Float32Array, mass: Float32Array, depth: number): void {
    this.insert(c, i, pos, mass, depth);
  }
}

export class ForceLayout {
  readonly n: number;
  readonly pos: Float32Array;
  private readonly vel: Float32Array;
  private readonly force: Float32Array;
  private readonly edges: Int32Array;
  private readonly groups: Int32Array;
  private readonly mass: Float32Array;
  private readonly degree: Float32Array;
  private readonly tree: QuadTree;
  alpha = 1;
  ticks = 0;
  /** Repulsion strength; springs; module pull; centre pull. */
  charge = 60;
  springLength = 26;
  springK = 0.06;
  groupK = 0.035;
  centerK = 0.004;
  /** Beyond this, repulsion stops: unconnected pieces stay near the map instead of drifting off it. */
  maxDistance = 0;
  theta = 0.9;

  constructor(input: LayoutInput, init?: Float32Array) {
    this.n = input.n;
    this.edges = input.edges;
    this.groups = input.groups;
    this.mass = input.mass ?? new Float32Array(input.n).fill(1);
    this.pos = init ? Float32Array.from(init) : initialPositions(input).pos;
    // Two files at exactly the same point push each other nowhere (no direction): a tiny,
    // deterministic nudge per node gives every pair one.
    for (let i = 0; i < this.n; i++) {
      this.pos[i * 2] = this.pos[i * 2]! + Math.cos(i * GOLDEN) * 0.5;
      this.pos[i * 2 + 1] = this.pos[i * 2 + 1]! + Math.sin(i * GOLDEN) * 0.5;
    }
    this.vel = new Float32Array(this.n * 2);
    this.force = new Float32Array(this.n * 2);
    this.degree = new Float32Array(this.n);
    for (let e = 0; e < this.edges.length; e += 2) { this.degree[this.edges[e]!]!++; this.degree[this.edges[e + 1]!]!++; }
    this.tree = new QuadTree(Math.max(16, this.n * 8 + 16));
  }

  /** One step; returns the mean displacement (for stopping). */
  tick(): number {
    const { n, pos, vel, force, mass, tree } = this;
    if (n === 0) return 0;
    force.fill(0);
    tree.build(pos, mass, n);
    const theta2 = this.theta * this.theta;
    const maxD = this.maxDistance || Math.max(300, Math.sqrt(n) * 22);
    const maxD2 = maxD * maxD;
    const stack = new Int32Array(Math.max(64, tree.count));
    // Repulsion (Barnes-Hut).
    for (let i = 0; i < n; i++) {
      const x = pos[i * 2]!; const y = pos[i * 2 + 1]!;
      let fx = 0; let fy = 0;
      let sp = 0;
      stack[sp++] = 0;
      while (sp > 0) {
        const c = stack[--sp]!;
        const m = tree.m[c]!;
        if (m === 0 || tree.body[c] === i) continue;
        const dx = tree.cx[c]! - x;
        const dy = tree.cy[c]! - y;
        const d2 = dx * dx + dy * dy + 0.01;
        const size = tree.bs[c]!;
        if (d2 > maxD2 && (size * size) / d2 < theta2) continue;
        if (tree.child[c] === -1 || (size * size) / d2 < theta2) {
          const f = (this.charge * m * mass[i]!) / d2;
          const inv = 1 / Math.sqrt(d2);
          fx -= dx * inv * f;
          fy -= dy * inv * f;
        } else {
          const first = tree.child[c]!;
          stack[sp++] = first; stack[sp++] = first + 1; stack[sp++] = first + 2; stack[sp++] = first + 3;
        }
      }
      force[i * 2] = fx;
      force[i * 2 + 1] = fy;
    }
    // Springs.
    for (let e = 0; e < this.edges.length; e += 2) {
      const a = this.edges[e]!;
      const b = this.edges[e + 1]!;
      const dx = pos[b * 2]! - pos[a * 2]!;
      const dy = pos[b * 2 + 1]! - pos[a * 2 + 1]!;
      const d = Math.sqrt(dx * dx + dy * dy) || 0.01;
      // Hubs get weaker springs so a utility imported by hundreds is not dragged into the middle of each.
      const k = this.springK / Math.sqrt(Math.min(this.degree[a]!, this.degree[b]!) || 1);
      const f = (d - this.springLength) * k;
      const fx = (dx / d) * f;
      const fy = (dy / d) * f;
      force[a * 2]! += fx; force[a * 2 + 1]! += fy;
      force[b * 2]! -= fx; force[b * 2 + 1]! -= fy;
    }
    // Module pull and centre pull.
    const gx = new Map<number, [number, number, number]>();
    for (let i = 0; i < n; i++) {
      const g = this.groups[i]!;
      const acc = gx.get(g) ?? [0, 0, 0];
      acc[0] += pos[i * 2]!; acc[1] += pos[i * 2 + 1]!; acc[2]++;
      gx.set(g, acc);
    }
    for (let i = 0; i < n; i++) {
      const acc = gx.get(this.groups[i]!)!;
      // Files with no dependencies have nothing else holding them: a stronger pull to the middle.
      const ck = this.degree[i] === 0 ? this.centerK * 6 : this.centerK;
      force[i * 2]! += (acc[0] / acc[2] - pos[i * 2]!) * this.groupK - pos[i * 2]! * ck;
      force[i * 2 + 1]! += (acc[1] / acc[2] - pos[i * 2 + 1]!) * this.groupK - pos[i * 2 + 1]! * ck;
    }
    // Integrate with damping; cap the step so nothing jumps across the map.
    let moved = 0;
    const maxStep = 30 * this.alpha + 1;
    for (let i = 0; i < n * 2; i++) {
      let v = (vel[i]! + (force[i]! * this.alpha) / mass[i >> 1]!) * 0.6;
      if (v > maxStep) v = maxStep; else if (v < -maxStep) v = -maxStep;
      vel[i] = v;
      pos[i]! += v;
      moved += Math.abs(v);
    }
    this.alpha = Math.max(0.02, this.alpha * 0.985);
    this.ticks++;
    return moved / (n * 2);
  }

  /** Run until settled or `maxTicks`. */
  run(maxTicks = 300, stopBelow = 0.05): void {
    for (let t = 0; t < maxTicks; t++) if (this.tick() < stopBelow && this.alpha < 0.2) break;
  }
}

/** Bounding box of positions (optionally only where `mask` is 1). */
export function bounds(pos: Float32Array, n: number, mask?: Uint8Array): { minX: number; minY: number; maxX: number; maxY: number } {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < n; i++) {
    if (mask && !mask[i]) continue;
    const x = pos[i * 2]!; const y = pos[i * 2 + 1]!;
    if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  if (minX === Infinity) return { minX: -100, minY: -100, maxX: 100, maxY: 100 };
  return { minX, minY, maxX, maxY };
}
