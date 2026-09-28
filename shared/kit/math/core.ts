/**
 * The maths behind the plot, geometry and calc widgets — pure functions, no
 * React, so they are tested on their own.
 *
 * Evaluation is mathjs: real expression parsing (no eval), symbolic
 * derivatives, and units — which is what lets a physics calculation carry its
 * units through every line and convert the answer (`(1/2 * mass * v^2) to J`).
 *
 * @module shared/kit/math/core
 */

import { create, all, type MathJsInstance, type EvalFunction } from 'mathjs';

export const math: MathJsInstance = create(all, { number: 'number', precision: 64 });
/*
  Results are simplified into SI. mathjs otherwise learns a preferred unit
  from whatever it last saw — one "km/h" earlier in a sheet and a fall time of
  2.02 s was printed as "0.000561 h". Conversions ("x to km/h") still work.
*/
(math as unknown as { Unit: { setUnitSystem(name: string): void } }).Unit.setUnitSystem('si');

/** Constants a physics answer needs, by the names people write. */
export const CONSTANTS: Record<string, string> = {
  g0: '9.80665 m/s^2',
  c0: 'speedOfLight',
  G: 'gravitationConstant',
  hbar: 'reducedPlanckConstant',
  planck: 'planckConstant',
  kB: 'boltzmann',
  NA: 'avogadro',
  qe: 'elementaryCharge',
  me: 'electronMass',
  mp: 'protonMass',
  eps0: 'vacuumPermittivity',
  mu0: 'vacuumPermeability',
  R_gas: 'gasConstant',
  sigma_sb: 'stefanBoltzmann',
};

// ── Plot ────────────────────────────────────────────────────────────────────

export interface PlotFunction { fn: string; label?: string; color?: string; dashed?: boolean }
export interface PlotParametric { x: string; y: string; t?: [number, number]; label?: string; color?: string }
export interface PlotPolar { r: string; theta?: [number, number]; label?: string; color?: string }
export interface PlotPoint { x: number; y: number; label?: string }
export interface PlotSpec {
  title?: string;
  x: [number, number];
  y?: [number, number];
  functions: PlotFunction[];
  parametric: PlotParametric[];
  polar: PlotPolar[];
  points: PlotPoint[];
  /** Also draw each function's derivative (computed symbolically). */
  derivatives: boolean;
  /** Shade the area under the first function between these bounds, and report it. */
  integral?: [number, number];
  samples: number;
  xLabel?: string;
  yLabel?: string;
}

/** Accept JSON, or lines like `y = sin(x)` / `f(x) = x^2` / `x: -5..5`. */
export function parsePlotSpec(source: string): PlotSpec {
  const text = source.trim();
  let raw: Record<string, unknown>;
  if (text.startsWith('{')) {
    try { raw = JSON.parse(text) as Record<string, unknown>; }
    catch (err) { throw new Error(`the plot spec is not valid JSON — ${(err as Error).message}`); }
  } else {
    raw = { functions: [] as PlotFunction[] };
    for (const lineRaw of text.split(/\r?\n/)) {
      const line = lineRaw.trim();
      if (!line || line.startsWith('#')) continue;
      const range = /^([xy])\s*[:=]\s*\[?\s*(-?[\d.e+-]+(?:\s*\*?\s*pi)?)\s*(?:\.\.|,|to)\s*(-?[\d.e+-]+(?:\s*\*?\s*pi)?)\s*\]?$/i.exec(line);
      if (range) { raw[range[1]!.toLowerCase()] = [evalNumber(range[2]!), evalNumber(range[3]!)]; continue; }
      const title = /^title\s*:\s*(.+)$/i.exec(line);
      if (title) { raw.title = title[1]; continue; }
      const fn = /^(?:y|[a-z]\w*\(x\))\s*=\s*(.+)$/i.exec(line);
      (raw.functions as PlotFunction[]).push({ fn: (fn ? fn[1]! : line).trim(), label: fn ? line.split('=')[0]!.trim() : undefined });
    }
  }
  const fns = (Array.isArray(raw.functions) ? raw.functions : raw.fn ? [{ fn: raw.fn }] : []) as Array<PlotFunction | string>;
  const functions = fns.map(f => (typeof f === 'string' ? { fn: f } : f)).filter(f => typeof f.fn === 'string' && f.fn.trim());
  const range = (v: unknown, fallback?: [number, number]): [number, number] | undefined => {
    if (Array.isArray(v) && v.length === 2) {
      const a = typeof v[0] === 'string' ? evalNumber(v[0]) : Number(v[0]);
      const b = typeof v[1] === 'string' ? evalNumber(v[1]) : Number(v[1]);
      if (Number.isFinite(a) && Number.isFinite(b) && a !== b) return a < b ? [a, b] : [b, a];
    }
    return fallback;
  };
  const spec: PlotSpec = {
    title: typeof raw.title === 'string' ? raw.title : undefined,
    x: range(raw.x ?? raw.domain, [-10, 10])!,
    y: range(raw.y ?? raw.range),
    functions,
    parametric: (Array.isArray(raw.parametric) ? raw.parametric : []) as PlotParametric[],
    polar: (Array.isArray(raw.polar) ? raw.polar : []) as PlotPolar[],
    points: (Array.isArray(raw.points) ? raw.points : []).map((p: unknown) => (Array.isArray(p) ? { x: Number(p[0]), y: Number(p[1]), label: p[2] !== undefined ? String(p[2]) : undefined } : p as PlotPoint)),
    derivatives: raw.derivatives === true || raw.derivative === true,
    integral: range(raw.integral ?? raw.area),
    samples: Math.max(50, Math.min(4000, Number(raw.samples) || 600)),
    xLabel: typeof raw.xLabel === 'string' ? raw.xLabel : undefined,
    yLabel: typeof raw.yLabel === 'string' ? raw.yLabel : undefined,
  };
  if (!spec.functions.length && !spec.parametric.length && !spec.polar.length && !spec.points.length) {
    throw new Error('nothing to plot — give "functions": [{ "fn": "sin(x)" }] (or a line like y = sin(x))');
  }
  return spec;
}

export function evalNumber(expr: string, scope: Record<string, unknown> = {}): number {
  const v = math.evaluate(expr.replace(/(\d)\s*pi\b/g, '$1*pi'), scope) as unknown;
  const n = typeof v === 'number' ? v : Number((v as { valueOf(): unknown }).valueOf());
  if (!Number.isFinite(n)) throw new Error(`"${expr}" is not a number`);
  return n;
}

export interface Series { name: string; data: Array<[number, number | null]>; color?: string; dashed?: boolean; kind: 'function' | 'derivative' | 'parametric' | 'polar' }

function compile(expr: string): EvalFunction {
  try { return math.compile(expr); }
  catch (err) { throw new Error(`cannot read "${expr}": ${(err as Error).message}`); }
}

/** Sample every curve. Breaks lines at discontinuities (tan(x), 1/x) instead of joining them. */
export function samplePlot(spec: PlotSpec): { series: Series[]; area?: { value: number; data: Array<[number, number]> } } {
  const out: Series[] = [];
  const [x0, x1] = spec.x;
  const n = spec.samples;
  const step = (x1 - x0) / (n - 1);
  const span = spec.y ? spec.y[1] - spec.y[0] : null;
  const sample = (f: EvalFunction): Array<[number, number | null]> => {
    const pts: Array<[number, number | null]> = [];
    let prev: number | null = null;
    for (let i = 0; i < n; i++) {
      const x = x0 + i * step;
      let y: number | null;
      try {
        const v = f.evaluate({ x }) as unknown;
        y = typeof v === 'number' && Number.isFinite(v) ? v : null;
      } catch { y = null; }
      // A jump bigger than the view across one step is an asymptote, not a line.
      if (y !== null && prev !== null && span !== null && Math.abs(y - prev) > span * 1.5) pts.push([x - step / 2, null]);
      pts.push([x, y]);
      prev = y;
    }
    return pts;
  };
  spec.functions.forEach((f, i) => {
    const c = compile(f.fn);
    out.push({ name: f.label ?? `y = ${f.fn}`, data: sample(c), color: f.color, dashed: f.dashed, kind: 'function' });
    if (spec.derivatives) {
      const d = math.derivative(f.fn, 'x');
      out.push({ name: `d/dx: ${d.toString()}`, data: sample(d.compile()), dashed: true, kind: 'derivative' });
    }
    void i;
  });
  for (const p of spec.parametric) {
    const fx = compile(p.x); const fy = compile(p.y);
    const [t0, t1] = p.t ?? [0, 2 * Math.PI];
    const pts: Array<[number, number | null]> = [];
    for (let i = 0; i < n; i++) {
      const t = t0 + (i * (t1 - t0)) / (n - 1);
      try { pts.push([Number(fx.evaluate({ t })), Number(fy.evaluate({ t }))]); } catch { /* skip */ }
    }
    out.push({ name: p.label ?? `(${p.x}, ${p.y})`, data: pts, color: p.color, kind: 'parametric' });
  }
  for (const p of spec.polar) {
    const fr = compile(p.r);
    const [a0, a1] = p.theta ?? [0, 2 * Math.PI];
    const pts: Array<[number, number | null]> = [];
    for (let i = 0; i < n; i++) {
      const theta = a0 + (i * (a1 - a0)) / (n - 1);
      try { const r = Number(fr.evaluate({ theta, t: theta })); pts.push([r * Math.cos(theta), r * Math.sin(theta)]); } catch { /* skip */ }
    }
    out.push({ name: p.label ?? `r = ${p.r}`, data: pts, color: p.color, kind: 'polar' });
  }
  let area: { value: number; data: Array<[number, number]> } | undefined;
  if (spec.integral && spec.functions[0]) {
    const f = compile(spec.functions[0].fn);
    const [a, b] = spec.integral;
    const m = 2000;
    const h = (b - a) / m;
    let sum = 0;
    const data: Array<[number, number]> = [];
    for (let i = 0; i <= m; i++) {
      const x = a + i * h;
      const y = Number(f.evaluate({ x }));
      if (!Number.isFinite(y)) continue;
      sum += (i === 0 || i === m ? 1 : i % 2 ? 4 : 2) * y;
      if (i % 20 === 0) data.push([x, y]);
    }
    area = { value: (sum * h) / 3, data };
  }
  return { series: out, area };
}

// ── Geometry ────────────────────────────────────────────────────────────────

export type Pt = [number, number];
export interface GeometrySpec {
  title?: string;
  points: Record<string, Pt>;
  segments: Array<[string, string, string?]>;
  lines: Array<[string, string]>;
  rays: Array<[string, string]>;
  vectors: Array<[string, string, string?]>;
  circles: Array<{ center: string; r?: number; through?: string; label?: string }>;
  polygons: Array<{ points: string[]; label?: string; fill?: boolean }>;
  angles: Array<[string, string, string]>;
  labels: Array<{ at: string | Pt; text: string }>;
  grid: boolean;
  axes: boolean;
  measure: boolean;
}

export function parseGeometry(source: string): GeometrySpec {
  let raw: Record<string, unknown>;
  try { raw = JSON.parse(source) as Record<string, unknown>; }
  catch (err) { throw new Error(`the geometry spec is not valid JSON — ${(err as Error).message}`); }
  const pts: Record<string, Pt> = {};
  const rawPts = raw.points ?? {};
  if (Array.isArray(rawPts)) {
    for (const p of rawPts as unknown[]) {
      if (Array.isArray(p) && p.length >= 3) pts[String(p[0])] = [Number(p[1]), Number(p[2])];
      else if (p && typeof p === 'object') { const o = p as { name?: string; x?: number; y?: number }; if (o.name) pts[o.name] = [Number(o.x), Number(o.y)]; }
    }
  } else {
    for (const [k, v] of Object.entries(rawPts as Record<string, unknown>)) {
      if (Array.isArray(v)) pts[k] = [Number(v[0]), Number(v[1])];
      else if (v && typeof v === 'object') pts[k] = [Number((v as { x: number }).x), Number((v as { y: number }).y)];
    }
  }
  if (Object.keys(pts).length === 0) throw new Error('a geometry figure needs "points": { "A": [0, 0], "B": [4, 0] }');
  for (const [k, p] of Object.entries(pts)) if (!p.every(Number.isFinite)) throw new Error(`point ${k} has a coordinate that is not a number`);
  const need = (name: string, what: string): void => { if (!pts[name]) throw new Error(`${what} uses point "${name}", which is not defined in "points"`); };
  const pairs = (key: string): Array<[string, string, string?]> => ((Array.isArray(raw[key]) ? raw[key] : []) as unknown[]).map((s) => {
    const a = Array.isArray(s) ? s : typeof s === 'string' ? s.split(/[-\s]+/) : [];
    need(String(a[0]), key); need(String(a[1]), key);
    return [String(a[0]), String(a[1]), a[2] !== undefined ? String(a[2]) : undefined];
  });
  const spec: GeometrySpec = {
    title: typeof raw.title === 'string' ? raw.title : undefined,
    points: pts,
    segments: pairs('segments'),
    lines: pairs('lines').map(([a, b]) => [a, b]),
    rays: pairs('rays').map(([a, b]) => [a, b]),
    vectors: pairs('vectors'),
    circles: ((Array.isArray(raw.circles) ? raw.circles : []) as Array<Record<string, unknown>>).map(c => {
      const center = String(c.center ?? c.c ?? '');
      need(center, 'circle');
      if (c.through) need(String(c.through), 'circle');
      return { center, r: c.r !== undefined ? Number(c.r) : undefined, through: c.through ? String(c.through) : undefined, label: c.label ? String(c.label) : undefined };
    }),
    polygons: ((Array.isArray(raw.polygons) ? raw.polygons : []) as unknown[]).map(p => {
      const list = Array.isArray(p) ? p.map(String) : ((p as { points?: string[] }).points ?? []).map(String);
      list.forEach(n => need(n, 'polygon'));
      return { points: list, label: !Array.isArray(p) ? (p as { label?: string }).label : undefined, fill: Array.isArray(p) ? true : (p as { fill?: boolean }).fill !== false };
    }),
    angles: ((Array.isArray(raw.angles) ? raw.angles : []) as unknown[]).map(a => {
      const t = (Array.isArray(a) ? a : String(a).split(/[-\s]+/)).map(String) as [string, string, string];
      t.forEach(n => need(n, 'angle'));
      return t;
    }),
    labels: ((Array.isArray(raw.labels) ? raw.labels : []) as Array<{ at: string | Pt; text: string }>),
    grid: raw.grid !== false,
    axes: raw.axes === true,
    measure: raw.measure !== false,
  };
  return spec;
}

export const dist = (a: Pt, b: Pt): number => Math.hypot(b[0] - a[0], b[1] - a[1]);

/** Angle ABC at B, in degrees (0..180). */
export function angleAt(a: Pt, b: Pt, c: Pt): number {
  const v1 = [a[0] - b[0], a[1] - b[1]];
  const v2 = [c[0] - b[0], c[1] - b[1]];
  const cos = (v1[0]! * v2[0]! + v1[1]! * v2[1]!) / (Math.hypot(v1[0]!, v1[1]!) * Math.hypot(v2[0]!, v2[1]!));
  return (Math.acos(Math.max(-1, Math.min(1, cos))) * 180) / Math.PI;
}

/** Shoelace area, positive. */
export function polygonArea(ps: Pt[]): number {
  let s = 0;
  for (let i = 0; i < ps.length; i++) {
    const [x1, y1] = ps[i]!; const [x2, y2] = ps[(i + 1) % ps.length]!;
    s += x1 * y2 - x2 * y1;
  }
  return Math.abs(s) / 2;
}

export function measurements(spec: GeometrySpec): string[] {
  const p = spec.points;
  const out: string[] = [];
  const f = (n: number): string => (Math.abs(n - Math.round(n)) < 1e-9 ? String(Math.round(n)) : n.toFixed(3).replace(/0+$/, '').replace(/\.$/, ''));
  for (const [a, b] of spec.segments) out.push(`|${a}${b}| = ${f(dist(p[a]!, p[b]!))}`);
  for (const [a, b, c] of spec.angles) out.push(`∠${a}${b}${c} = ${f(angleAt(p[a]!, p[b]!, p[c]!))}°`);
  for (const poly of spec.polygons) {
    const ps = poly.points.map(n => p[n]!);
    const per = ps.reduce((s, q, i) => s + dist(q, ps[(i + 1) % ps.length]!), 0);
    out.push(`${poly.label ?? poly.points.join('')}: area ${f(polygonArea(ps))}, perimeter ${f(per)}`);
  }
  for (const c of spec.circles) {
    const r = c.r ?? (c.through ? dist(p[c.center]!, p[c.through]!) : 1);
    out.push(`circle ${c.label ?? c.center}: r = ${f(r)}, area ${f(Math.PI * r * r)}, circumference ${f(2 * Math.PI * r)}`);
  }
  return out;
}

// ── Calc ────────────────────────────────────────────────────────────────────

export interface CalcLine { input: string; tex?: string; result?: string; resultTex?: string; error?: string; comment?: string; name?: string }

function constantScope(): Record<string, unknown> {
  const scope: Record<string, unknown> = {};
  for (const [name, expr] of Object.entries(CONSTANTS)) {
    try { scope[name] = math.evaluate(expr); } catch { /* not in this mathjs */ }
  }
  return scope;
}

function formatValue(v: unknown): { text: string; tex: string } {
  if (v === undefined || v === null) return { text: '', tex: '' };
  if (typeof v === 'function') return { text: 'function defined', tex: '\\text{function defined}' };
  const text = math.format(v as never, { precision: 6, lowerExp: -4, upperExp: 9 });
  let tex = text;
  try { tex = math.parse(text).toTex({ parenthesis: 'auto', implicit: 'hide' }); } catch { tex = `\\text{${text.replace(/[{}\\]/g, '')}}`; }
  return { text, tex };
}

/**
 * Evaluate a calc block line by line. Variables carry forward. `# text` is a
 * comment shown as a heading; `expr to unit` / `expr in unit` converts.
 */
export function evaluateCalc(source: string): CalcLine[] {
  const scope = constantScope();
  const lines: CalcLine[] = [];
  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith('#') || line.startsWith('//')) { lines.push({ input: line, comment: line.replace(/^(#+|\/\/)\s*/, '') }); continue; }
    const [codePart, ...commentParts] = line.split(/\s+#\s+|\s+\/\/\s+/);
    let code = codePart!.trim();
    const conv = /^(.*?)\s+(?:to|in)\s+([a-zA-Z°µΩ][\w\s/^*.·°µΩ()-]*)$/.exec(code);
    if (conv && !/^\w+\s*=/.test(code)) code = `(${conv[1]}) to ${conv[2]}`;
    else if (conv && /^\w+\s*=/.test(code)) {
      const [lhs, rhs] = [code.slice(0, code.indexOf('=')), conv[1]!.slice(conv[1]!.indexOf('=') + 1)];
      code = `${lhs.trim()} = (${rhs.trim()}) to ${conv[2]}`;
    }
    const entry: CalcLine = { input: line, comment: commentParts.join(' ').trim() || undefined };
    try {
      const node = math.parse(code);
      entry.tex = node.toTex({ parenthesis: 'auto', implicit: 'hide' });
      let v = node.compile().evaluate(scope) as unknown;
      // A quantity someone wrote ("mass = 1200 kg") is shown as written, not
      // re-prefixed to 1.2 Mg; computed results still get the best prefix.
      if (/^\s*[a-zA-Z_]\w*\s*=\s*-?[\d.]+(?:e[+-]?\d+)?\s*[a-zA-Z°µΩ]/.test(code) && v && typeof v === 'object' && 'fixPrefix' in (v as object)) {
        v = (v as { clone(): { fixPrefix: boolean } }).clone();
        (v as { fixPrefix: boolean }).fixPrefix = true;
        const name = /^\s*([a-zA-Z_]\w*)/.exec(code)![1]!;
        scope[name] = v;
      }
      const f = formatValue(v);
      entry.result = f.text;
      entry.resultTex = f.tex;
      const assign = /^([a-zA-Z_]\w*)\s*(\(.*\))?\s*=/.exec(code);
      if (assign) entry.name = assign[1];
    } catch (err) {
      entry.error = (err as Error).message;
    }
    lines.push(entry);
  }
  if (lines.length === 0) throw new Error('the calc block is empty');
  return lines;
}
