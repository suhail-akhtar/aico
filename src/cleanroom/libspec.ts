/**
 * Library specs: from observed calls to signatures, and a declaration file.
 *
 * Nothing here reads the library's code. It has the list of exports, an arity
 * for each function, and a few dozen recorded calls: this argument, that result;
 * this argument, that error. From those it infers what a type checker would need.
 *
 *  - A **parameter's type** is the union of the kinds of argument that were
 *    accepted at that position. A position every probe was accepted at (six or
 *    more kinds) is `unknown`: the function does not care, as far as probing can
 *    tell. A position nothing was accepted at is also `unknown`, and said so.
 *  - A parameter is **optional** when some accepted call left it out or passed
 *    `undefined`.
 *  - A **return type** is the union of the kinds the successful calls returned;
 *    an object result is described by its observed fields; a promise result is
 *    `Promise<T>`.
 *  - **Throws** are the error classes (and one message each) the failing calls
 *    produced.
 *
 * It is inference from samples: a union that is wider or narrower than the
 * original is possible, generics are not recovered, and a function that only
 * works with a specific value nobody tried looks like it rejects everything.
 * The spec's `unknowns` say that, and the twin-test (calling the clone with the
 * same recorded arguments) is what checks it.
 *
 * Output: TypeScript declarations for a Node library, a `.pyi` stub for a Python
 * one. Both go into the spec the implementer is given, since they are a
 * description of behaviour, not of the original's code.
 *
 * @module cleanroom/libspec
 */

import type { CallResult, Journey, LibExport, LibExportInfo, LibMember, LibParam, LibrarySpec, Step } from './types.js';
import { inferSchema, mergeSchema } from './spec.js';
import type { JsonSchema } from './types.js';

type Enc = unknown;

interface Rec { fn: string; owner?: string; construct: boolean; args: Enc[]; result: CallResult; kind: 'call' | 'get' }

/** The kind of one argument, from its recorded (tagged) form. */
export function argKind(a: Enc): string {
  if (a === null) return 'null';
  if (Array.isArray(a)) return 'array';
  if (typeof a === 'object') {
    const t = (a as { $?: string }).$;
    if (t === 'undefined') return 'undefined';
    if (t === 'fn') return 'function';
    if (t === 'NaN' || t === 'Infinity' || t === '-Infinity') return 'number';
    if (t === 'bigint') return 'bigint';
    if (t === 'date') return 'date';
    return 'object';
  }
  return typeof a;
}

/** Turn the worker's tagged value into a plain one the schema inference can read. */
function plain(v: unknown): unknown {
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    const t = (v as { $?: string }).$;
    if (t === 'undefined') return undefined;
    if (t === 'NaN' || t === 'Infinity' || t === '-Infinity') return 0.5;
    if (t === 'date') return '2000-01-01T00:00:00Z';
    if (t === 'bigint') return 1;
    if (t === 'instance') return { __instance: (v as { cls: string }).cls };
    if (t === 'fn') return { __fn: true };
    if (t === 'map' || t === 'set' || t === 'bytes' || t === 'regexp' || t === 'error') return { __kind: t };
    return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, plain(x)]));
  }
  if (Array.isArray(v)) return v.filter(x => !(x && typeof x === 'object' && (x as { $?: string }).$ === 'more')).map(plain);
  return v;
}

function schemaToTs(s: JsonSchema | undefined, py = false): string {
  if (!s) return py ? 'Any' : 'unknown';
  if (s.nullable && !s.type) return py ? 'None' : 'null';
  const t = Array.isArray(s.type) ? s.type : s.type ? [s.type] : [];
  const one = (x: string): string => {
    if (x === 'integer') return py ? 'int' : 'number';
    if (x === 'number') return py ? 'float' : 'number';
    if (x === 'string') return py ? 'str' : 'string';
    if (x === 'boolean') return py ? 'bool' : 'boolean';
    if (x === 'array') return py ? `list[${schemaToTs(s.items, py)}]` : `${wrap(schemaToTs(s.items, py))}[]`;
    if (x === 'object') {
      const props = s.properties ?? {};
      const keys = Object.keys(props);
      if (props.__instance) return 'unknown';
      if (!keys.length) return py ? 'dict[str, Any]' : 'Record<string, unknown>';
      if (py) return 'dict[str, Any]';
      return `{ ${keys.map(k => `${/^[A-Za-z_$][\w$]*$/.test(k) ? k : JSON.stringify(k)}${s.required?.includes(k) ? '' : '?'}: ${schemaToTs(props[k])}`).join('; ')} }`;
    }
    return py ? 'Any' : 'unknown';
  };
  const parts = [...new Set(t.map(one))];
  if (s.nullable) parts.push(py ? 'None' : 'null');
  return parts.length ? parts.join(py ? ' | ' : ' | ') : (py ? 'Any' : 'unknown');
}
const wrap = (t: string): string => (/[|{]/.test(t) ? `(${t})` : t);

/** The TypeScript or Python type of what a call returned. */
function returnType(c: CallResult, py: boolean): string {
  const k = c.kind ?? 'undefined';
  const v = c.value;
  if (k === 'undefined' || (v && typeof v === 'object' && (v as { $?: string }).$ === 'undefined')) return py ? 'None' : 'void';
  if (k.startsWith('instance:')) return k.slice('instance:'.length);
  if (k === 'function') return py ? 'Callable[..., Any]' : '(...args: unknown[]) => unknown';
  if (v && typeof v === 'object' && !Array.isArray(v) && (v as { $?: string }).$) {
    const t = (v as { $: string }).$;
    if (t === 'date') return py ? 'datetime' : 'Date';
    if (t === 'bigint') return py ? 'int' : 'bigint';
    if (t === 'NaN' || t === 'Infinity' || t === '-Infinity') return py ? 'float' : 'number';
    if (t === 'instance') return String((v as { cls: string }).cls);
    if (t === 'set') return py ? 'set[Any]' : 'Set<unknown>';
    if (t === 'map') return py ? 'dict[Any, Any]' : 'Map<unknown, unknown>';
    return py ? 'Any' : 'unknown';
  }
  return schemaToTs(inferSchema(plain(v)), py);
}

function unionOf(types: string[], py: boolean): string {
  const u = [...new Set(types)].filter(Boolean);
  if (!u.length) return py ? 'Any' : 'unknown';
  if (u.length > 4) return py ? 'Any' : 'unknown';
  return u.join(' | ');
}

const KIND_TS: Record<string, [string, string]> = {
  number: ['number', 'float'], string: ['string', 'str'], boolean: ['boolean', 'bool'], array: ['unknown[]', 'list[Any]'],
  object: ['Record<string, unknown>', 'dict[str, Any]'], function: ['(...args: unknown[]) => unknown', 'Callable[..., Any]'],
  null: ['null', 'None'], bigint: ['bigint', 'int'], date: ['Date', 'datetime'],
};

function paramsFrom(calls: Rec[], arity: number, py: boolean, named?: LibExportInfo['params']): LibParam[] {
  const ok = calls.filter(c => c.result.ok);
  const maxArgs = Math.max(arity, ...ok.map(c => c.args.length), 0);
  const out: LibParam[] = [];
  for (let i = 0; i < maxArgs; i++) {
    const accepted = new Set<string>();
    let optional = false;
    for (const c of ok) {
      if (c.args.length <= i) optional = true;
      else { const k = argKind(c.args[i]); if (k === 'undefined') optional = true; else accepted.add(k); }
    }
    const declared = named?.[i];
    if (declared?.hasDefault) optional = true;
    let type: string;
    if (declared?.annotation && py) type = declared.annotation.replace(/^<class '(.*)'>$/, '$1');
    else if (!ok.length) type = py ? 'Any' : 'unknown';
    else if (accepted.size === 0 || accepted.size >= 6) type = py ? 'Any' : 'unknown';
    else {
      const mapped = [...accepted].map(k => (KIND_TS[k] ?? [py ? 'Any' : 'unknown', 'Any'])[py ? 1 : 0]);
      // numbers that were only ever integers are `int` in a stub
      const onlyInts = ok.every(c => typeof c.args[i] !== 'number' || Number.isInteger(c.args[i]));
      type = [...new Set(py && accepted.has('number') && onlyInts ? mapped.map(m => (m === 'float' ? 'int | float' : m)) : mapped)].join(' | ');
    }
    out.push({ name: py ? (declared?.name ?? `arg${i}`) : `arg${i}`, type, optional });
  }
  return out;
}

function throwsOf(calls: Rec[]): { name: string; message: string }[] {
  const seen = new Map<string, string>();
  for (const c of calls) if (!c.result.ok && c.result.error && !seen.has(c.result.error.name)) seen.set(c.result.error.name, c.result.error.message);
  return [...seen].slice(0, 5).map(([name, message]) => ({ name, message }));
}

function examplesOf(calls: Rec[]): { args: string; result: string }[] {
  return calls.filter(c => c.result.ok).slice(0, 3).map(c => ({ args: JSON.stringify(c.args).slice(0, 120), result: JSON.stringify(c.result.value ?? null).slice(0, 120) }));
}

function recordsOf(steps: Step[]): Rec[] {
  const classOf = new Map<string, string>();
  const out: Rec[] = [];
  for (const s of steps) {
    const st = s.stimulus;
    if ((st.type !== 'call' && st.type !== 'get') || !s.observation.call) continue;
    const result = s.observation.call;
    const v = result.value as { $?: string; cls?: string; handle?: string } | undefined;
    if (result.ok && v && typeof v === 'object' && v.$ === 'instance' && v.handle && v.cls) classOf.set(v.handle, v.cls);
    out.push(st.type === 'call'
      ? { fn: st.fn, ...(st.on ? { owner: classOf.get(st.on) ?? st.on } : {}), construct: !!st.construct, args: st.args ?? [], result, kind: 'call' }
      : { fn: st.prop, ...(st.on ? { owner: classOf.get(st.on) ?? st.on } : {}), construct: false, args: [], result, kind: 'get' });
  }
  return out;
}

export function librarySpec(j: Journey, unknowns: string[]): LibrarySpec {
  const t = j.target as Extract<Journey['target'], { kind: 'library' }>;
  const surfaceStep = j.steps.find(s => s.observation.surface);
  const surface = surfaceStep?.observation.surface ?? [];
  const python = (t.language ?? (/\.py$/i.test(t.entry) ? 'python' : 'node')) === 'python';
  const lang: 'node' | 'python' = python ? 'python' : 'node';
  const recs = recordsOf(j.steps);
  const exportsOut: LibExport[] = [];
  const returns = (cs: Rec[]): { returns: string; async: boolean } => {
    const ok = cs.filter(c => c.result.ok);
    const asyncAll = ok.length > 0 && ok.every(c => c.result.async);
    const r = unionOf(ok.map(c => returnType(c.result, python)), python);
    return { returns: r, async: asyncAll };
  };
  for (const e of surface) {
    if (e.kind === 'value') { exportsOut.push({ name: e.name, kind: 'value', params: [], returns: returnType({ ok: true, kind: typeofEnc(e.value), value: e.value }, python), async: false, throws: [], examples: [], value: JSON.stringify(e.value ?? null).slice(0, 80) }); continue; }
    if (e.kind === 'object') {
      const members: LibMember[] = [];
      for (const f of e.fns ?? []) {
        const cs = recs.filter(r => !r.owner && r.fn === `${e.name}.${f.name}`);
        const rt = returns(cs);
        members.push({ name: f.name, kind: 'static', params: paramsFrom(cs, f.arity, python), returns: rt.returns, async: rt.async, throws: throwsOf(cs) });
      }
      exportsOut.push({ name: e.name, kind: 'object', params: [], returns: 'object', async: false, throws: [], examples: [], members });
      continue;
    }
    const callRecs = recs.filter(r => !r.owner && r.fn === e.name);
    const isClass = e.isClass || callRecs.some(r => !r.result.ok && /Class constructor|without 'new'/.test(r.result.error?.message ?? '')) || callRecs.some(r => r.construct && r.result.ok);
    if (!isClass) {
      const cs = callRecs.filter(r => !r.construct);
      const rt = returns(cs);
      exportsOut.push({ name: e.name, kind: 'function', params: paramsFrom(cs, e.arity ?? 0, python, e.params), returns: rt.returns, async: rt.async || !!e.isCoroutine, throws: throwsOf(cs), examples: examplesOf(cs) });
      continue;
    }
    const ctor = callRecs.filter(r => r.construct);
    const members: LibMember[] = [];
    for (const m of e.members ?? []) {
      const ms = recs.filter(r => r.owner === e.name && r.fn === m.name);
      if (m.kind === 'accessor') { const g = ms.find(r => r.kind === 'get' && r.result.ok); members.push({ name: m.name, kind: 'accessor', params: [], returns: g ? returnType(g.result, python) : (python ? 'Any' : 'unknown'), async: false, throws: [] }); continue; }
      const rt = returns(ms.filter(r => r.kind === 'call'));
      members.push({ name: m.name, kind: 'method', params: paramsFrom(ms.filter(r => r.kind === 'call'), m.arity ?? 0, python, m.params), returns: rt.returns, async: rt.async, throws: throwsOf(ms) });
    }
    for (const s of e.statics ?? []) {
      const ms = recs.filter(r => !r.owner && r.fn === `${e.name}.${s.name}`);
      const rt = returns(ms);
      members.push({ name: s.name, kind: 'static', params: paramsFrom(ms, s.arity, python), returns: rt.returns, async: rt.async, throws: throwsOf(ms) });
    }
    exportsOut.push({ name: e.name, kind: 'class', params: paramsFrom(ctor, e.arity ?? 0, python, e.params), returns: e.name, async: false, throws: throwsOf(ctor), examples: examplesOf(ctor), members });
  }
  if (!surface.length) unknowns.push('the library exports could not be listed');
  unknowns.push('types are inferred from sampled calls: a union can be wider or narrower than the original, generics are not recovered, and a function that only accepts a value nobody tried looks like it rejects everything');
  unknowns.push('lifecycle hooks, event emitters and plugin or middleware pipelines are not mapped (only direct calls were probed)');
  if (python) unknowns.push('a Python library was probed unconfined (Python has no portable sandbox): calls could have touched the filesystem');
  const name = t.name ?? j.id;
  const spec: LibrarySpec = { language: lang, name, exports: exportsOut, declarations: '' };
  spec.declarations = python ? renderPyi(spec) : renderDts(spec);
  return spec;
}

const typeofEnc = (v: unknown): string => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);

// ── rendering ──────────────────────────────────────────────────────────────────

const pn = (n: string): string => (/^[A-Za-z_$][\w$]*$/.test(n) ? n : JSON.stringify(n));
const ps = (ps_: LibParam[]): string => ps_.map(p => `${p.name}${p.optional ? '?' : ''}: ${p.type}`).join(', ');
const doc = (throws: { name: string; message: string }[]): string => (throws.length ? `  /** Throws ${throws.map(t => `${t.name} ("${t.message.replace(/\*\//g, '* /')}")`).join('; ')}. */\n` : '');

export function renderDts(s: LibrarySpec): string {
  const L = ['// Inferred by black-box probing, not copied from the original: types come from sampled calls and may be wider or narrower.', ''];
  for (const e of s.exports) {
    if (e.kind === 'value') L.push(`export const ${pn(e.name)}: ${e.returns};`);
    else if (e.kind === 'function') L.push(doc(e.throws).replace(/^  /gm, '') + `export function ${pn(e.name)}(${ps(e.params)}): ${e.async ? `Promise<${e.returns}>` : e.returns};`);
    else if (e.kind === 'object') L.push(`export const ${pn(e.name)}: {`, ...(e.members ?? []).map(m => `  ${pn(m.name)}(${ps(m.params)}): ${m.async ? `Promise<${m.returns}>` : m.returns};`), '};');
    else {
      L.push(`export class ${pn(e.name)} {`, `  constructor(${ps(e.params)});`);
      for (const m of e.members ?? []) {
        if (m.kind === 'accessor') L.push(`  readonly ${pn(m.name)}: ${m.returns};`);
        else L.push(doc(m.throws) + `  ${m.kind === 'static' ? 'static ' : ''}${pn(m.name)}(${ps(m.params)}): ${m.async ? `Promise<${m.returns}>` : m.returns};`);
      }
      L.push('}');
    }
  }
  return L.join('\n') + '\n';
}

export function renderPyi(s: LibrarySpec): string {
  const L = ['# Inferred by black-box probing, not copied from the original: types come from sampled calls.', 'from typing import Any, Callable', 'from datetime import datetime', ''];
  const pp = (params: LibParam[], self = false): string => [...(self ? ['self'] : []), ...params.map(p => `${p.name}: ${p.type}${p.optional ? ' = ...' : ''}`)].join(', ');
  for (const e of s.exports) {
    if (e.kind === 'value') L.push(`${e.name}: ${e.returns}`);
    else if (e.kind === 'function') L.push(`${e.async ? 'async ' : ''}def ${e.name}(${pp(e.params)}) -> ${e.returns}: ...`);
    else if (e.kind === 'object') L.push(`${e.name}: Any`);
    else {
      L.push(`class ${e.name}:`, `    def __init__(${pp(e.params, true)}) -> None: ...`);
      for (const m of e.members ?? []) {
        if (m.kind === 'accessor') L.push('    @property', `    def ${m.name}(self) -> ${m.returns}: ...`);
        else L.push(`    ${m.async ? 'async ' : ''}def ${m.name}(${pp(m.params, true)}) -> ${m.returns}: ...`);
      }
    }
  }
  return L.join('\n') + '\n';
}

// A merge used by the spec for response shapes is re-exported here so library specs share one inference.
export { mergeSchema };
