/**
 * Layered (Sugiyama-style) graph layout for the Code map's Architecture and
 * Focus views: dependents above the things they depend on, so a person can
 * read a project top to bottom and see at once which parts are foundations.
 *
 * ## Why in-house, and why this shape
 *
 * The force layout (layout.ts) answers "what clusters with what" but gives a
 * hairball nobody can navigate: no direction, no order, and a different picture
 * whenever the data moves. A layered drawing has an obvious reading order and
 * is a pure function of its input. d3/dagre/elk would each be a new runtime
 * dependency (ADR 0028 rejected d3-force on that ground), and the algorithm is
 * a few hundred lines:
 *
 *  1. Cycles: dependencies between folders are often mutual. Of every pair of
 *     opposite edges the lighter one is the "back" edge; longer cycles are broken
 *     by the edges a depth-first search finds pointing back up its own stack
 *     (visiting heavy edges first, starting from the most depended-upon-by-nobody
 *     nodes). Back edges are reported so the picture can draw them red.
 *  2. Layers: longest path from the sources, so every kept edge points down.
 *     Optionally (`reduce`) the forward edges another path already implies
 *     (a→c beside a→b→c) are set aside: the layers already say "a is above c", and
 *     on a folder-level graph they are most of the ink. They are reported, not lost.
 *  3. Long edges get dummy nodes in the layers they cross, so crossings are
 *     counted honestly and each long edge has a route that avoids boxes.
 *  4. Order within layers: barycentre sweeps down and up, keeping the order with
 *     the fewest weighted crossings (counted with a Fenwick tree).
 *  5. Coordinates: repeated passes pulling each node toward the mean of its
 *     neighbours, each layer packed by isotonic regression (pool-adjacent-
 *     violators) so order and spacing hold exactly. Compact and straight enough;
 *     Brandes-Koepf's four-way alignment is better and four times the code.
 *
 * Nodes with no edges at all are not part of the layering (they would all
 * become one enormous top row); they are packed into a grid below it.
 *
 * Deterministic: no randomness, ties broken by index. Pure, so it runs in the
 * web unit suite and could move into a worker unchanged. Bounded: the sweep
 * count falls and long-edge dummies are dropped when the graph is huge, so
 * 5,000 nodes / 15,000 edges still lay out in a couple of seconds.
 *
 * Coordinates are abstract: `b` is across the flow (breadth), `d` along it
 * (depth). The caller maps them to x/y (down: x=b, y=d; right: x=d, y=b).
 *
 * @module web/components/codegraph/layered
 */

export interface LayeredInput {
  n: number;
  /** Extent of each node across the flow. */
  breadth: ArrayLike<number>;
  /** Extent of each node along the flow. */
  depth: ArrayLike<number>;
  /** Edge i goes from[i] → to[i]: from depends on to, so from sits above to. */
  from: ArrayLike<number>;
  to: ArrayLike<number>;
  weight?: ArrayLike<number>;
  nodeGap?: number;
  layerGap?: number;
  /** Down+up barycentre passes (default 6). */
  sweeps?: number;
  /** Set aside forward edges implied by a longer path (transitive reduction); only up to 8,000 nodes. */
  reduce?: boolean;
}

export interface LayeredResult {
  /** Node centre across the flow. */
  b: Float64Array;
  /** Node centre along the flow. */
  d: Float64Array;
  /** Layer per node; connected nodes 0.., isolated nodes one past the last. */
  layer: Int32Array;
  layers: number;
  /** 1 where the edge points against the flow (a back edge: part of a cycle). */
  feedback: Uint8Array;
  /** 1 where `reduce` set the edge aside (it has no route). */
  redundant: Uint8Array;
  /** Per input edge: the route as [b0, d0, b1, d1, …] from `from` to `to` (empty for a self loop). */
  paths: Float32Array[];
  /** Total extent of the drawing. */
  breadthSpan: number;
  depthSpan: number;
  /** Weighted crossings in the final order (for tests and tuning). */
  crossings: number;
}

/**
 * Positions along one line that stay in order and apart, as close as possible
 * (least squares) to where each item would like to be. Pool-adjacent-violators
 * on the offsets; O(n).
 */
export function packLine(desired: ArrayLike<number>, extent: ArrayLike<number>, gap: (i: number) => number, weight?: ArrayLike<number>): number[] {
  const n = desired.length;
  const c = new Array<number>(n);
  const y = new Array<number>(n);
  let acc = 0;
  for (let i = 0; i < n; i++) {
    if (i > 0) acc += (extent[i - 1]! + extent[i]!) / 2 + gap(i - 1);
    c[i] = acc;
    y[i] = desired[i]! - acc;
  }
  const sum: number[] = [];
  const wt: number[] = [];
  const cnt: number[] = [];
  for (let i = 0; i < n; i++) {
    const w = weight ? weight[i]! : 1;
    sum.push(w * y[i]!); wt.push(w); cnt.push(1);
    while (sum.length > 1) {
      const k = sum.length - 1;
      if (sum[k - 1]! / wt[k - 1]! < sum[k]! / wt[k]!) break;
      sum[k - 1]! += sum[k]!; wt[k - 1]! += wt[k]!; cnt[k - 1]! += cnt[k]!;
      sum.pop(); wt.pop(); cnt.pop();
    }
  }
  const out = new Array<number>(n);
  let i = 0;
  for (let k = 0; k < sum.length; k++) {
    const mean = sum[k]! / wt[k]!;
    for (let j = 0; j < cnt[k]!; j++, i++) out[i] = mean + c[i]!;
  }
  return out;
}

interface Csr { start: Int32Array; adj: Int32Array; w: Float64Array }

function csr(count: number, src: number[], dst: number[], w: number[]): Csr {
  const start = new Int32Array(count + 1);
  for (const s of src) start[s + 1]!++;
  for (let i = 0; i < count; i++) start[i + 1]! += start[i]!;
  const fill = start.slice(0, count);
  const adj = new Int32Array(src.length);
  const wt = new Float64Array(src.length);
  for (let e = 0; e < src.length; e++) { const p = fill[src[e]!]!++; adj[p] = dst[e]!; wt[p] = w[e]!; }
  return { start, adj, w: wt };
}

export function layered(inp: LayeredInput): LayeredResult {
  const n = inp.n;
  const m = inp.from.length;
  const nodeGap = inp.nodeGap ?? 24;
  const layerGap = inp.layerGap ?? 64;

  // 1 ── Unique edges (self loops dropped, parallel edges summed).
  const keyOf = new Map<number, number>();
  const ua: number[] = [];
  const ub: number[] = [];
  const uw: number[] = [];
  const edgeUe = new Int32Array(m).fill(-1);
  for (let e = 0; e < m; e++) {
    const a = inp.from[e]!;
    const b = inp.to[e]!;
    if (a === b) continue;
    const k = a * n + b;
    let u = keyOf.get(k);
    if (u === undefined) { u = ua.length; keyOf.set(k, u); ua.push(a); ub.push(b); uw.push(0); }
    uw[u]! += inp.weight ? inp.weight[e]! : 1;
    edgeUe[e] = u;
  }
  const U = ua.length;

  // 2 ── Cycles. state: 0 kept, 1 reversed by the DFS, 2 lighter half of a mutual pair.
  const state = new Uint8Array(U);
  const partner = new Int32Array(U).fill(-1);
  for (let u = 0; u < U; u++) {
    const p = keyOf.get(ub[u]! * n + ua[u]!);
    if (p === undefined) continue;
    partner[u] = p;
    if (uw[u]! < uw[p]! || (uw[u]! === uw[p]! && ua[u]! > ub[u]!)) state[u] = 2;
  }
  const connected = new Uint8Array(n);
  const score = new Float64Array(n);
  const outE: number[][] = Array.from({ length: n }, () => []);
  for (let u = 0; u < U; u++) {
    connected[ua[u]!] = 1; connected[ub[u]!] = 1;
    if (state[u] !== 0) continue;
    score[ua[u]!]! += uw[u]!; score[ub[u]!]! -= uw[u]!;
    outE[ua[u]!]!.push(u);
  }
  for (const list of outE) list.sort((x, y) => (uw[y]! - uw[x]!) || (ub[x]! - ub[y]!) || (x - y));
  const roots: number[] = [];
  for (let i = 0; i < n; i++) if (connected[i]) roots.push(i);
  roots.sort((x, y) => (score[y]! - score[x]!) || (x - y));
  const color = new Uint8Array(n);
  const ptr = new Int32Array(n);
  for (const s of roots) {
    if (color[s]) continue;
    const stack = [s];
    color[s] = 1;
    while (stack.length) {
      const v = stack[stack.length - 1]!;
      const list = outE[v]!;
      if (ptr[v]! < list.length) {
        const e = list[ptr[v]!++]!;
        const t = ub[e]!;
        if (color[t] === 1) state[e] = 1;
        else if (color[t] === 0) { color[t] = 1; stack.push(t); }
      } else { color[v] = 2; stack.pop(); }
    }
  }

  // 3 ── Layers: longest path from the sources over the kept edges.
  const layerOf: number[] = new Array<number>(n).fill(-1);
  {
    const indeg = new Int32Array(n);
    const succ: number[][] = Array.from({ length: n }, () => []);
    for (let u = 0; u < U; u++) if (state[u] === 0) { indeg[ub[u]!]!++; succ[ua[u]!]!.push(ub[u]!); }
    const queue: number[] = [];
    for (let i = 0; i < n; i++) if (connected[i] && indeg[i] === 0) { layerOf[i] = 0; queue.push(i); }
    for (let qi = 0; qi < queue.length; qi++) {
      const v = queue[qi]!;
      for (const t of succ[v]!) {
        if (layerOf[t]! < layerOf[v]! + 1) layerOf[t] = layerOf[v]! + 1;
        if (--indeg[t]! === 0) queue.push(t);
      }
    }
  }
  for (let i = 0; i < n; i++) if (connected[i] && layerOf[i]! < 0) layerOf[i] = 0; // defensive: a cycle left unbroken
  let layerCount = 0;
  for (let i = 0; i < n; i++) if (layerOf[i]! >= layerCount) layerCount = layerOf[i]! + 1;

  // 3b ── Transitive reduction of the kept edges, by reachability bitsets in reverse layer order.
  const redundantUe = new Uint8Array(U);
  if (inp.reduce && n <= 8000) {
    const words = (n + 31) >>> 5;
    const reach: Array<Uint32Array | undefined> = new Array<Uint32Array | undefined>(n);
    const kids: number[][] = Array.from({ length: n }, () => []);
    for (let u = 0; u < U; u++) if (state[u] === 0) kids[ua[u]!]!.push(u);
    const order: number[] = [];
    for (let i = 0; i < n; i++) if (connected[i]) order.push(i);
    order.sort((x, y) => (layerOf[y]! - layerOf[x]!) || (x - y));
    for (const v of order) {
      const bits = new Uint32Array(words);
      reach[v] = bits;
      kids[v]!.sort((x, y) => (layerOf[ub[x]!]! - layerOf[ub[y]!]!) || (x - y));
      for (const e of kids[v]!) {
        const t = ub[e]!;
        if (bits[t >>> 5]! & (1 << (t & 31))) { redundantUe[e] = 1; continue; }
        const r = reach[t]!;
        for (let i = 0; i < words; i++) bits[i]! |= r[i]!;
        bits[t >>> 5]! |= 1 << (t & 31);
      }
    }
  }

  // 4 ── The layered graph: kept edges as they are, reversed ones flipped, long ones split by dummies.
  interface LEdge { u: number; v: number; w: number; chain: number[] }
  const ledges: LEdge[] = [];
  const leOfUe = new Int32Array(U).fill(-1);
  let estimate = 0;
  for (let u = 0; u < U; u++) if (state[u] !== 2 && !redundantUe[u]) estimate += Math.max(0, Math.abs(layerOf[ua[u]!]! - layerOf[ub[u]!]!) - 1);
  const useDummies = estimate <= 60_000;
  const nodeLayer: number[] = layerOf.slice();
  const dummyExt: number[] = [];
  let total = n;
  for (let u = 0; u < U; u++) {
    if (state[u] === 2 || redundantUe[u]) continue;
    const top = state[u] === 0 ? ua[u]! : ub[u]!;
    const bot = state[u] === 0 ? ub[u]! : ua[u]!;
    const chain = [top];
    if (useDummies) {
      for (let l = layerOf[top]! + 1; l < layerOf[bot]!; l++) { chain.push(total++); nodeLayer.push(l); dummyExt.push(10); }
    }
    chain.push(bot);
    leOfUe[u] = ledges.length;
    ledges.push({ u: top, v: bot, w: uw[u]!, chain });
  }
  const ext = (i: number): number => (i < n ? inp.breadth[i]! : dummyExt[i - n]!);
  const gapBetween = (a: number, b: number): number => (a < n && b < n ? nodeGap : nodeGap * 0.45);

  // Unit edges between adjacent layers.
  const ps: number[] = []; const pd: number[] = []; const pw: number[] = [];
  // Without dummies (a huge graph) a long edge joins non-adjacent layers: it keeps its route but takes no part in ordering.
  for (const le of ledges) for (let i = 0; i + 1 < le.chain.length; i++) { const p = le.chain[i]!; const q = le.chain[i + 1]!; if (nodeLayer[q]! - nodeLayer[p]! !== 1) continue; ps.push(p); pd.push(q); pw.push(le.w); }
  const down = csr(total, ps, pd, pw);
  const up = csr(total, pd, ps, pw);

  // 5 ── Order within layers.
  const layers: number[][] = Array.from({ length: layerCount }, () => []);
  {
    // Initial order: depth-first preorder from the sources, so relatives start adjacent.
    const rank = new Int32Array(total).fill(-1);
    let next = 0;
    const visit = (s: number): void => {
      const stack = [s];
      while (stack.length) {
        const v = stack.pop()!;
        if (rank[v]! >= 0) continue;
        rank[v] = next++;
        const lo = down.start[v]!; const hi = down.start[v + 1]!;
        const kids: number[] = [];
        for (let p = lo; p < hi; p++) kids.push(p);
        kids.sort((x, y) => (down.w[y]! - down.w[x]!) || (down.adj[y]! - down.adj[x]!));
        for (const p of kids) stack.push(down.adj[p]!);
      }
    };
    for (let i = 0; i < total; i++) if (nodeLayer[i]! >= 0 && up.start[i + 1]! === up.start[i]!) visit(i);
    for (let i = 0; i < total; i++) if (nodeLayer[i]! >= 0 && rank[i]! < 0) visit(i);
    const members: number[] = [];
    for (let i = 0; i < total; i++) if (nodeLayer[i]! >= 0) members.push(i);
    members.sort((x, y) => rank[x]! - rank[y]!);
    for (const v of members) layers[nodeLayer[v]!]!.push(v);
  }
  const pos = new Float64Array(total);
  const reindex = (l: number): void => { const L = layers[l]!; for (let i = 0; i < L.length; i++) pos[L[i]!] = i; };
  for (let l = 0; l < layerCount; l++) reindex(l);

  const countCrossings = (): number => {
    let sum = 0;
    for (let l = 0; l + 1 < layerCount; l++) {
      const L = layers[l]!;
      const below = layers[l + 1]!;
      if (below.length < 2 || L.length === 0) continue;
      const tree = new Float64Array(below.length + 1);
      let seen = 0;
      for (const v of L) {
        const targets: Array<[number, number]> = [];
        for (let p = down.start[v]!; p < down.start[v + 1]!; p++) targets.push([pos[down.adj[p]!]!, down.w[p]!]);
        for (const [tp, w] of targets) {
          // Weight already inserted with a larger target position.
          let le = 0;
          for (let i = tp + 1; i > 0; i -= i & -i) le += tree[i]!;
          sum += w * (seen - le);
        }
        for (const [tp, w] of targets) { for (let i = tp + 1; i <= below.length; i += i & -i) tree[i]! += w; seen += w; }
      }
    }
    return sum;
  };

  const budgetSweeps = total > 40_000 ? 2 : total > 15_000 ? 3 : (inp.sweeps ?? 6);
  let best = layers.map(L => L.slice());
  let bestCross = countCrossings();
  const sweep = (l: number, adj: Csr): void => {
    const L = layers[l]!;
    const keyed = L.map((v, i) => {
      let s = 0; let w = 0;
      for (let p = adj.start[v]!; p < adj.start[v + 1]!; p++) { s += adj.w[p]! * pos[adj.adj[p]!]!; w += adj.w[p]!; }
      return { v, key: w > 0 ? s / w : i, i };
    });
    keyed.sort((x, y) => (x.key - y.key) || (x.i - y.i));
    for (let i = 0; i < keyed.length; i++) L[i] = keyed[i]!.v;
    reindex(l);
  };
  for (let pass = 0; pass < budgetSweeps && bestCross > 0; pass++) {
    for (let l = 1; l < layerCount; l++) sweep(l, up);
    for (let l = layerCount - 2; l >= 0; l--) sweep(l, down);
    const c = countCrossings();
    if (c < bestCross) { bestCross = c; best = layers.map(L => L.slice()); }
  }
  for (let l = 0; l < layerCount; l++) { layers[l] = best[l]!; reindex(l); }

  // 6 ── Coordinates: pull toward neighbours, pack each layer.
  const bpos = new Float64Array(total);
  for (let l = 0; l < layerCount; l++) {
    const L = layers[l]!;
    const exts = L.map(ext);
    const packed = packLine(L.map(() => 0), exts, i => gapBetween(L[i]!, L[i + 1]!));
    const mid = L.length ? (packed[0]! + packed[L.length - 1]!) / 2 : 0;
    L.forEach((v, i) => { bpos[v] = packed[i]! - mid; });
  }
  const relax = (l: number): void => {
    const L = layers[l]!;
    if (!L.length) return;
    const desired = new Array<number>(L.length);
    const weights = new Array<number>(L.length);
    for (let i = 0; i < L.length; i++) {
      const v = L[i]!;
      let s = 0; let w = 0;
      for (let p = up.start[v]!; p < up.start[v + 1]!; p++) { s += up.w[p]! * bpos[up.adj[p]!]!; w += up.w[p]!; }
      for (let p = down.start[v]!; p < down.start[v + 1]!; p++) { s += down.w[p]! * bpos[down.adj[p]!]!; w += down.w[p]!; }
      desired[i] = w > 0 ? s / w : bpos[v]!;
      weights[i] = v >= n ? 3 : 1;
    }
    const packed = packLine(desired, L.map(ext), i => gapBetween(L[i]!, L[i + 1]!), weights);
    for (let i = 0; i < L.length; i++) bpos[L[i]!] = packed[i]!;
  };
  const iterations = total > 40_000 ? 3 : 8;
  for (let it = 0; it < iterations; it++) {
    for (let l = 1; l < layerCount; l++) relax(l);
    for (let l = layerCount - 2; l >= 0; l--) relax(l);
  }

  // Along the flow: each layer as thick as its thickest node.
  const thick = new Float64Array(layerCount);
  for (let i = 0; i < n; i++) if (layerOf[i]! >= 0) thick[layerOf[i]!] = Math.max(thick[layerOf[i]!]!, inp.depth[i]!);
  const dOfLayer = new Float64Array(layerCount);
  let cursor = 0;
  for (let l = 0; l < layerCount; l++) {
    cursor += thick[l]! / 2;
    dOfLayer[l] = cursor;
    cursor += thick[l]! / 2 + layerGap;
  }
  let depthEnd = layerCount ? cursor - layerGap : 0;

  let minB = Infinity; let maxB = -Infinity;
  for (let i = 0; i < n; i++) if (layerOf[i]! >= 0) { minB = Math.min(minB, bpos[i]! - ext(i) / 2); maxB = Math.max(maxB, bpos[i]! + ext(i) / 2); }
  if (!isFinite(minB)) { minB = 0; maxB = 0; }
  const shift = -minB;

  const b = new Float64Array(n);
  const d = new Float64Array(n);
  const layerOut = new Int32Array(n).fill(-1);
  for (let i = 0; i < n; i++) if (layerOf[i]! >= 0) { b[i] = bpos[i]! + shift; d[i] = dOfLayer[layerOf[i]!]!; layerOut[i] = layerOf[i]!; }
  let breadthSpan = maxB - minB;

  // 7 ── Isolated nodes: a grid under the layering, as wide as the layering is.
  {
    const lone: number[] = [];
    for (let i = 0; i < n; i++) if (!connected[i]) lone.push(i);
    if (lone.length) {
      const wrap = Math.max(breadthSpan, 960);
      let x = 0; let rowTop = layerCount ? depthEnd + layerGap * 1.2 : 0; let rowH = 0;
      for (const i of lone) {
        const w = inp.breadth[i]!;
        if (x > 0 && x + w > wrap) { x = 0; rowTop += rowH + nodeGap; rowH = 0; }
        b[i] = x + w / 2; d[i] = rowTop + inp.depth[i]! / 2; layerOut[i] = layerCount;
        x += w + nodeGap; rowH = Math.max(rowH, inp.depth[i]!);
        breadthSpan = Math.max(breadthSpan, x - nodeGap);
      }
      depthEnd = rowTop + rowH;
    }
  }

  // 8 ── Routes, with ports spread along a node's edge so edges do not leave from one point.
  const bOf = (v: number): number => (v < n ? b[v]! : bpos[v]! + shift);
  const dOf = (v: number): number => (v < n ? d[v]! : dOfLayer[nodeLayer[v]!]!);
  const outPorts = new Map<number, number[]>();
  const inPorts = new Map<number, number[]>();
  ledges.forEach((le, i) => {
    (outPorts.get(le.u) ?? outPorts.set(le.u, []).get(le.u)!).push(i);
    (inPorts.get(le.v) ?? inPorts.set(le.v, []).get(le.v)!).push(i);
  });
  const portOffset = new Map<string, number>();
  const spread = (list: number[], node: number, towards: (le: LEdge) => number, tag: string): void => {
    list.sort((x, y) => (bOf(towards(ledges[x]!)) - bOf(towards(ledges[y]!))) || (x - y));
    const span = Math.min(ext(node) * 0.7, list.length * 14);
    list.forEach((li, k) => portOffset.set(`${tag}${li}`, list.length === 1 ? 0 : -span / 2 + (span * k) / (list.length - 1)));
  };
  for (const [node, list] of outPorts) spread(list, node, le => le.chain[1]!, 'o');
  for (const [node, list] of inPorts) spread(list, node, le => le.chain[le.chain.length - 2]!, 'i');

  const chainPoints = (li: number): number[] => {
    const le = ledges[li]!;
    const pts: number[] = [];
    le.chain.forEach((v, k) => {
      if (k === 0) pts.push(b[v]! + (portOffset.get(`o${li}`) ?? 0), d[v]! + inp.depth[v]! / 2);
      else if (k === le.chain.length - 1) pts.push(b[v]! + (portOffset.get(`i${li}`) ?? 0), d[v]! - inp.depth[v]! / 2);
      else pts.push(bOf(v), dOf(v));
    });
    return pts;
  };
  const reversePts = (pts: number[]): number[] => {
    const r: number[] = [];
    for (let i = pts.length - 2; i >= 0; i -= 2) r.push(pts[i]!, pts[i + 1]!);
    return r;
  };
  const feedbackUe = new Uint8Array(U);
  const pathUe: Array<number[] | undefined> = new Array<number[] | undefined>(U);
  for (let u = 0; u < U; u++) {
    if (state[u] === 2 || redundantUe[u]) continue;
    const pts = chainPoints(leOfUe[u]!);
    pathUe[u] = state[u] === 0 ? pts : reversePts(pts);
    feedbackUe[u] = state[u] === 1 ? 1 : 0;
  }
  for (let u = 0; u < U; u++) {
    if (state[u] !== 2) continue;
    const p = partner[u]!;
    // Same route as its heavier twin, walked the other way and nudged aside.
    const twin = pathUe[p] ? reversePts(pathUe[p]!) : [];
    pathUe[u] = twin.map((val, i) => (i % 2 === 0 ? val + 9 : val));
    feedbackUe[u] = 1;
  }
  const feedback = new Uint8Array(m);
  const redundant = new Uint8Array(m);
  const paths: Float32Array[] = new Array<Float32Array>(m);
  for (let e = 0; e < m; e++) {
    const u = edgeUe[e]!;
    if (u < 0 || redundantUe[u]) { paths[e] = new Float32Array(0); if (u >= 0) redundant[e] = 1; continue; }
    feedback[e] = feedbackUe[u]!;
    paths[e] = Float32Array.from(pathUe[u]!);
  }

  return { b, d, layer: layerOut, layers: layerCount, feedback, redundant, paths, breadthSpan, depthSpan: depthEnd, crossings: bestCross };
}
