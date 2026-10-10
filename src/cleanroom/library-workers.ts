/**
 * The programs that run *inside* a library target: load it, list it, call it.
 *
 * A library cannot be observed from outside the way a page or a command can, so
 * a small worker loads it in its own process and answers JSON lines on stdin and
 * stdout: `list` (what does it export), `call` (call or construct something and
 * report what came back or what was thrown), `get` (read a property). Everything
 * reported is behaviour: a value's kind and a depth-limited rendering, the error
 * class and message, whether the answer was a promise, what was written to the
 * console. The worker never reads a function's source text.
 *
 * Values cross as plain JSON with a small tag for what JSON cannot say
 * (`{"$":"undefined"}`, `NaN`, `Infinity`, `bigint`, a Date, a function stub, a
 * handle to an object an earlier call returned), so a recorded call can be
 * replayed on a clone exactly.
 *
 * Two languages: Node (ES modules and CommonJS) and Python (3.8+). The Node
 * worker is confined by the permission model by the sandbox that starts it
 * (sandbox-library.ts); Python has no portable equivalent, and that is said in
 * the observation and in ADR 0041 rather than implied away.
 *
 * Stored as strings, not files: the engine is bundled, and a worker that has to
 * be found on disk next to the bundle is a way to ship a build that cannot run.
 * `String.raw` keeps backslashes literal; the Node source avoids backticks and
 * `${` so it can sit in one template.
 *
 * @module cleanroom/library-workers
 */

export const NODE_WORKER = String.raw`
import { pathToFileURL } from 'node:url';
import readline from 'node:readline';
const entry = process.argv[2];
const handles = new Map();
let hn = 0;
const realWrite = process.stdout.write.bind(process.stdout);
let captured = '';
const grab = (chunk) => { if (captured.length < 400) captured += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'); return true; };
process.stdout.write = grab;
process.stderr.write = grab;
const send = (o) => realWrite(JSON.stringify(o) + '\n');

function enc(v, d, seen) {
  d = d || 0; seen = seen || new Set();
  if (v === undefined) return { $: 'undefined' };
  if (v === null || typeof v === 'boolean') return v;
  if (typeof v === 'number') return Number.isNaN(v) ? { $: 'NaN' } : v === Infinity ? { $: 'Infinity' } : v === -Infinity ? { $: '-Infinity' } : v;
  if (typeof v === 'string') return v.length > 300 ? v.slice(0, 300) + '…' : v;
  if (typeof v === 'bigint') return { $: 'bigint', v: String(v) };
  if (typeof v === 'symbol') return { $: 'symbol', v: String(v.description || '') };
  if (typeof v === 'function') return { $: 'fn', name: v.name || '', arity: v.length };
  if (d >= 4) return { $: 'deep' };
  if (seen.has(v)) return { $: 'circular' };
  seen.add(v);
  try {
    if (v instanceof Date) return { $: 'date', v: isNaN(v) ? 'Invalid' : v.toISOString() };
    if (v instanceof Error) return { $: 'error', name: v.name, message: String(v.message).split('\n')[0].slice(0, 200) };
    if (v instanceof RegExp) return { $: 'regexp', v: String(v) };
    if (v instanceof Map) return { $: 'map', v: [...v].slice(0, 20).map(([k, x]) => [enc(k, d + 1, seen), enc(x, d + 1, seen)]) };
    if (v instanceof Set) return { $: 'set', v: [...v].slice(0, 20).map(x => enc(x, d + 1, seen)) };
    if (ArrayBuffer.isView(v)) return { $: 'bytes', type: v.constructor.name, length: v.length };
    if (Array.isArray(v)) { const a = v.slice(0, 20).map(x => enc(x, d + 1, seen)); if (v.length > 20) a.push({ $: 'more', n: v.length - 20 }); return a; }
    const proto = Object.getPrototypeOf(v);
    const o = {};
    for (const k of Object.keys(v).slice(0, 20)) { try { o[k] = enc(v[k], d + 1, seen); } catch (e) { o[k] = { $: 'throws-on-read' }; } }
    if (proto === Object.prototype || proto === null) return o;
    const id = 'h' + (++hn);
    handles.set(id, v);
    return { $: 'instance', cls: (proto.constructor && proto.constructor.name) || 'Object', handle: id, props: o };
  } finally { seen.delete(v); }
}

function dec(x) {
  if (x && typeof x === 'object' && !Array.isArray(x) && typeof x.$ === 'string') {
    switch (x.$) {
      case 'undefined': return undefined;
      case 'NaN': return NaN;
      case 'Infinity': return Infinity;
      case '-Infinity': return -Infinity;
      case 'bigint': return BigInt(x.v);
      case 'date': return new Date(x.v);
      case 'fn': return function stub() { return undefined; };
      case 'handle': return handles.get(x.v);
      default: break;
    }
  }
  if (Array.isArray(x)) return x.map(dec);
  if (x && typeof x === 'object') { const o = {}; for (const k of Object.keys(x)) o[k] = dec(x[k]); return o; }
  return x;
}

function kindOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'object') { const p = Object.getPrototypeOf(v); return p === Object.prototype || p === null ? 'object' : 'instance:' + ((p.constructor && p.constructor.name) || 'Object'); }
  return typeof v;
}

function errorOf(e) {
  const isErr = e && typeof e === 'object';
  return { name: isErr ? String(e.name || 'Error') : typeof e, message: String(isErr ? e.message : e).split('\n')[0].slice(0, 200), ...(isErr && e.code ? { code: String(e.code) } : {}) };
}

let mod;
async function load() {
  const ns = await import(pathToFileURL(entry).href);
  const keys = Object.keys(ns);
  mod = keys.length === 1 && keys[0] === 'default' && ns.default && (typeof ns.default === 'object' || typeof ns.default === 'function') ? ns.default : ns;
}

function pathGet(root, p) {
  let cur = root;
  for (const part of String(p).split('.')) { if (cur == null) return undefined; cur = cur[part]; }
  return cur;
}

function describe(name, v) {
  if (typeof v === 'function') {
    const proto = v.prototype && typeof v.prototype === 'object' ? v.prototype : null;
    const members = proto ? Object.getOwnPropertyNames(proto).filter(n => n !== 'constructor').map(n => {
      const d = Object.getOwnPropertyDescriptor(proto, n);
      return d && (d.get || d.set) ? { name: n, kind: 'accessor' } : { name: n, kind: typeof (d && d.value) === 'function' ? 'method' : 'value', arity: typeof (d && d.value) === 'function' ? d.value.length : undefined };
    }) : [];
    const statics = Object.getOwnPropertyNames(v).filter(n => !['length', 'name', 'prototype', 'caller', 'arguments'].includes(n) && typeof v[n] === 'function').map(n => ({ name: n, arity: v[n].length }));
    return { name, kind: 'function', arity: v.length, members, statics };
  }
  if (v && typeof v === 'object') {
    const fns = Object.keys(v).filter(k => typeof v[k] === 'function').map(k => ({ name: k, arity: v[k].length }));
    return { name, kind: 'object', fns, value: enc(v) };
  }
  return { name, kind: 'value', value: enc(v) };
}

async function run(msg) {
  captured = '';
  const t0 = Date.now();
  try {
    if (msg.op === 'list') {
      return { exports: Object.keys(mod).filter(k => k !== 'default' || Object.keys(mod).length > 1).map(k => { let v; try { v = mod[k]; } catch (e) { return { name: k, kind: 'value', value: { $: 'throws-on-read' } }; } return describe(k, v); }) };
    }
    if (msg.op === 'get') {
      const base = msg.on ? handles.get(msg.on) : mod;
      const v = pathGet(base, msg.prop);
      return { ok: true, kind: kindOf(v), value: enc(v) };
    }
    if (msg.op === 'call') {
      const base = msg.on ? handles.get(msg.on) : mod;
      if (msg.on && base === undefined) return { ok: false, error: { name: 'HandleError', message: 'no such handle (the worker restarted or the object was never returned)' } };
      const parts = String(msg.fn).split('.');
      const name = parts.pop();
      const owner = parts.length ? pathGet(base, parts.join('.')) : base;
      const f = owner == null ? undefined : owner[name];
      if (typeof f !== 'function') return { ok: false, error: { name: 'NotCallable', message: String(msg.fn) + ' is not a function (it is ' + kindOf(f) + ')' } };
      const args = (msg.args || []).map(dec);
      let r = msg.construct ? Reflect.construct(f, args) : f.apply(owner, args);
      let isAsync = false;
      if (r && typeof r.then === 'function') {
        isAsync = true;
        r = await Promise.race([r, new Promise((_, rej) => setTimeout(() => rej(Object.assign(new Error('the promise did not settle within 2s'), { name: 'PromiseTimeout' })), 2000))]);
      }
      return { ok: true, async: isAsync, kind: kindOf(r), value: enc(r), ms: Date.now() - t0 };
    }
    return { ok: false, error: { name: 'BadOp', message: String(msg.op) } };
  } catch (e) {
    return { ok: false, error: errorOf(e), ms: Date.now() - t0 };
  }
}

process.on('uncaughtException', (e) => { send({ event: 'uncaught', error: errorOf(e) }); });
process.on('unhandledRejection', (e) => { send({ event: 'uncaught', error: errorOf(e) }); });

try { await load(); send({ event: 'ready' }); } catch (e) { send({ event: 'load-failed', error: errorOf(e) }); process.exit(3); }

const rl = readline.createInterface({ input: process.stdin });
for await (const line of rl) {
  if (!line.trim()) continue;
  let msg;
  try { msg = JSON.parse(line); } catch (e) { continue; }
  const out = await run(msg);
  send({ id: msg.id, ...out, ...(captured ? { output: captured.slice(0, 300) } : {}) });
}
`;

export const PYTHON_WORKER = String.raw`
import sys, json, math, inspect, importlib.util, io, asyncio, datetime, os, contextlib

entry = sys.argv[1]
handles = {}
hn = [0]
real_out = sys.stdout

def send(o):
    real_out.write(json.dumps(o) + "\n"); real_out.flush()

def enc(v, d=0):
    if v is None or isinstance(v, bool): return v
    if isinstance(v, int): return v if abs(v) < 2**53 else {"$": "bigint", "v": str(v)}
    if isinstance(v, float):
        if math.isnan(v): return {"$": "NaN"}
        if math.isinf(v): return {"$": "Infinity"} if v > 0 else {"$": "-Infinity"}
        return v
    if isinstance(v, str): return v if len(v) <= 300 else v[:300] + "…"
    if isinstance(v, (bytes, bytearray)): return {"$": "bytes", "type": type(v).__name__, "length": len(v)}
    if callable(v) and not isinstance(v, type): return {"$": "fn", "name": getattr(v, "__name__", ""), "arity": 0}
    if d >= 4: return {"$": "deep"}
    if isinstance(v, (datetime.datetime, datetime.date)): return {"$": "date", "v": v.isoformat()}
    if isinstance(v, (list, tuple)):
        a = [enc(x, d + 1) for x in list(v)[:20]]
        if len(v) > 20: a.append({"$": "more", "n": len(v) - 20})
        return a
    if isinstance(v, (set, frozenset)): return {"$": "set", "v": [enc(x, d + 1) for x in list(v)[:20]]}
    if isinstance(v, dict): return {str(k): enc(x, d + 1) for k, x in list(v.items())[:20]}
    if isinstance(v, type): return {"$": "class", "name": v.__name__}
    hn[0] += 1; hid = "h" + str(hn[0]); handles[hid] = v
    try: props = {k: enc(x, d + 1) for k, x in list(vars(v).items())[:20] if not k.startswith("_")}
    except Exception: props = {}
    return {"$": "instance", "cls": type(v).__name__, "handle": hid, "props": props}

def dec(x):
    if isinstance(x, dict) and isinstance(x.get("$"), str):
        t = x["$"]
        if t == "undefined": return None
        if t == "NaN": return float("nan")
        if t == "Infinity": return float("inf")
        if t == "-Infinity": return float("-inf")
        if t == "bigint": return int(x["v"])
        if t == "fn": return lambda *a, **k: None
        if t == "handle": return handles.get(x["v"])
    if isinstance(x, list): return [dec(i) for i in x]
    if isinstance(x, dict): return {k: dec(v) for k, v in x.items()}
    return x

def kind_of(v):
    if v is None: return "null"
    if isinstance(v, bool): return "boolean"
    if isinstance(v, (int, float)): return "number"
    if isinstance(v, str): return "string"
    if isinstance(v, (list, tuple)): return "array"
    if isinstance(v, dict): return "object"
    return "instance:" + type(v).__name__

def err(e):
    return {"name": type(e).__name__, "message": str(e).split("\n")[0][:200]}

def sig(f):
    try:
        out = []
        for p in inspect.signature(f).parameters.values():
            out.append({"name": p.name, "kind": str(p.kind).split(".")[-1].lower(), "hasDefault": p.default is not inspect.Parameter.empty, "annotation": None if p.annotation is inspect.Parameter.empty else str(p.annotation)})
        return out
    except Exception:
        return None

def load():
    p = os.path.abspath(entry)
    if os.path.isdir(p):
        init = os.path.join(p, "__init__.py")
        spec = importlib.util.spec_from_file_location(os.path.basename(p), init, submodule_search_locations=[p])
        sys.path.insert(0, os.path.dirname(p))
    else:
        spec = importlib.util.spec_from_file_location(os.path.splitext(os.path.basename(p))[0], p)
        sys.path.insert(0, os.path.dirname(p))
    m = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = m
    spec.loader.exec_module(m)
    return m

def describe(name, v):
    if isinstance(v, type):
        members = []
        for n, x in vars(v).items():
            if n.startswith("_") and n != "__init__": continue
            if isinstance(x, property): members.append({"name": n, "kind": "accessor"})
            elif callable(x) or isinstance(x, (staticmethod, classmethod)):
                f = x.__func__ if isinstance(x, (staticmethod, classmethod)) else x
                members.append({"name": n, "kind": "method", "arity": len(sig(f) or []), "params": sig(f)})
        return {"name": name, "kind": "function", "isClass": True, "arity": 0, "params": sig(v.__init__) if "__init__" in vars(v) else [], "members": members, "statics": []}
    if callable(v):
        return {"name": name, "kind": "function", "arity": len(sig(v) or []), "params": sig(v), "members": [], "statics": [], "isCoroutine": inspect.iscoroutinefunction(v)}
    return {"name": name, "kind": "value", "value": enc(v)}

mod = load()
send({"event": "ready"})

for line in sys.stdin:
    line = line.strip()
    if not line: continue
    try: msg = json.loads(line)
    except Exception: continue
    buf = io.StringIO()
    out = {}
    try:
        with contextlib.redirect_stdout(buf), contextlib.redirect_stderr(buf):
            if msg["op"] == "list":
                names = getattr(mod, "__all__", None) or [n for n in vars(mod) if not n.startswith("_")]
                out = {"exports": [describe(n, getattr(mod, n)) for n in names if getattr(getattr(mod, n), "__module__", mod.__name__) in (mod.__name__, None) or not callable(getattr(mod, n))]}
            elif msg["op"] == "get":
                base = handles.get(msg.get("on")) if msg.get("on") else mod
                v = base
                for part in str(msg["prop"]).split("."): v = getattr(v, part)
                out = {"ok": True, "kind": kind_of(v), "value": enc(v)}
            elif msg["op"] == "call":
                base = handles.get(msg.get("on")) if msg.get("on") else mod
                if msg.get("on") and base is None:
                    out = {"ok": False, "error": {"name": "HandleError", "message": "no such handle"}}
                else:
                    owner = base
                    parts = str(msg["fn"]).split(".")
                    for part in parts[:-1]: owner = getattr(owner, part)
                    f = getattr(owner, parts[-1])
                    args = [dec(a) for a in msg.get("args", [])]
                    r = f(*args)
                    is_async = False
                    if inspect.iscoroutine(r):
                        is_async = True
                        r = asyncio.run(asyncio.wait_for(r, 2))
                    out = {"ok": True, "async": is_async, "kind": kind_of(r), "value": enc(r)}
    except BaseException as e:
        out = {"ok": False, "error": err(e)}
    text = buf.getvalue()
    send({"id": msg.get("id"), **out, **({"output": text[:300]} if text else {})})
`;
