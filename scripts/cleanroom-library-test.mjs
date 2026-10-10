/**
 * Library and SDK reconstruction (ADR 0041): probe a real module, infer its
 * public surface and a declaration file, twin-test a clone of it.
 *
 * Real Node and Python libraries written for this test, loaded in real worker
 * processes. Proven: exports are listed; calls return values and typed errors;
 * async results, class instances (handles), accessors, statics and console
 * output are observed; the Node worker is confined (a write outside its scratch
 * folder is denied by the runtime; a call that never returns is killed and the
 * worker restarted); the synthesized .d.ts / .pyi carry parameter types,
 * optionality, return types and throws; and the twin-test passes an identical
 * clone and catches a wrong one. No model, no network.
 */
import './lib/test-home.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import * as T from '../dist-test/test-exports.js';

const C = T.cleanroom;
let passed = 0, failed = 0;
const ok = (c, m, d) => { if (c) { passed++; console.log(`  ok    ${m}`); } else { failed++; console.log(`  FAIL  ${m}`, d === undefined ? '' : JSON.stringify(d).slice(0, 600)); } };
const section = (t) => console.log(`\n── ${t} ──`);
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cleanroom-lib-test-'));
const outsideFile = path.join(base, 'should-not-be-written.txt');

const libSource = (variant) => `
import fs from 'node:fs';
export function add(a, b) { if (typeof a !== 'number' || typeof b !== 'number') throw new TypeError('add expects two numbers'); return ${variant === 'wrong' ? 'a - b' : 'a + b'}; }
export function greet(name = 'world') { return 'Hello, ' + name + '!'; }
export async function fetchUser(id) { if (typeof id !== 'number') throw new TypeError('id must be a number'); return { id, name: 'user' + id }; }
export class Counter {
  constructor(start = 0) { if (typeof start !== 'number') throw new TypeError('start must be a number'); this.n = start; }
  inc(by = 1) { if (typeof by !== 'number') throw new TypeError('by must be a number'); this.n += by; return this.n; }
  get value() { return this.n; }
  static zero() { return new Counter(0); }
}
export const VERSION = '1.2.3';
export const util = { double(x) { return x * 2; }, shout(s) { console.log('shouting'); return String(s).toUpperCase(); } };
export function danger(p) { fs.writeFileSync(p, 'x'); return 'written'; }
export function hang() { while (true) { /* never returns */ } }
${variant === 'missing' ? '' : "export function extra() { return 1; }"}
`;

const writeLib = (name, variant) => { const dir = path.join(base, name); fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, type: 'module' })); fs.writeFileSync(path.join(dir, 'index.mjs'), libSource(variant)); return path.join(dir, 'index.mjs'); };
const target = writeLib('target', 'target');
const lib = (entry, extra = {}) => ({ kind: 'library', entry, timeoutMs: 4000, ...extra });

section('the sandbox: list, call, construct, errors, output');
let sb = new C.LibrarySandbox();
await sb.start(lib(target));
ok(sb.confined === true, 'a Node library runs under the permission model');
const surface = await sb.list();
const names = surface.map(e => e.name);
ok(['add', 'greet', 'fetchUser', 'Counter', 'VERSION', 'util', 'danger', 'hang'].every(n => names.includes(n)), 'the exports are listed', names);
ok(surface.find(e => e.name === 'add').arity === 2 && surface.find(e => e.name === 'VERSION').kind === 'value' && surface.find(e => e.name === 'util').kind === 'object', 'with arity and kind (function, value, object)');
const counter = surface.find(e => e.name === 'Counter');
ok(counter.members.some(m => m.name === 'inc' && m.arity === 0) && counter.members.some(m => m.name === 'value' && m.kind === 'accessor') && counter.statics.some(s => s.name === 'zero'), 'a class lists its methods, accessors and statics');
const call = async (stim) => { await sb.inject(stim); return (await sb.observe()).call; };
let r = await call({ type: 'call', fn: 'add', args: [2, 3] });
ok(r.ok && r.value === 5 && r.kind === 'number', 'a call returns its value and kind', r);
r = await call({ type: 'call', fn: 'add', args: ['a', 1] });
ok(!r.ok && r.error.name === 'TypeError' && /two numbers/.test(r.error.message), 'a failing call reports the error class and message', r);
r = await call({ type: 'call', fn: 'greet', args: [{ $: 'undefined' }] });
ok(r.value === 'Hello, world!', 'an undefined argument is passed as undefined (the default applies)', r);
r = await call({ type: 'call', fn: 'fetchUser', args: [7] });
ok(r.ok && r.async === true && r.value.id === 7 && r.value.name === 'user7', 'a promise is awaited and reported as async', r);
r = await call({ type: 'call', fn: 'Counter', args: [] });
ok(!r.ok && /Class constructor|without 'new'/.test(r.error.message), 'calling a class without new says it is a class', r);
r = await call({ type: 'call', fn: 'Counter', args: [10], construct: true });
const handle = r.value.handle;
ok(r.ok && r.value.$ === 'instance' && r.value.cls === 'Counter' && handle, 'constructing returns a handle to the instance', r);
r = await call({ type: 'call', fn: 'inc', args: [5], on: handle });
ok(r.value === 15, 'a method is called on the instance by handle', r);
r = await call({ type: 'get', prop: 'value', on: handle });
ok(r.value === 15, 'an accessor is read', r);
r = await call({ type: 'call', fn: 'util.shout', args: ['hi'] });
ok(r.value === 'HI' && /shouting/.test(r.output), 'what a call wrote to the console is captured as its side effect', r);
r = await call({ type: 'call', fn: 'danger', args: [outsideFile] });
ok(!r.ok && r.error.code === 'ERR_ACCESS_DENIED' && !fs.existsSync(outsideFile), 'a write outside the scratch folder is denied by the runtime', r);
r = await call({ type: 'call', fn: 'inc', args: [1], on: 'h999' });
ok(!r.ok && r.error.name === 'HandleError', 'a handle that does not exist says so', r);
r = await call({ type: 'call', fn: 'hang', args: [] });
ok(!r.ok && r.error.name === 'Timeout', 'a call that never returns is stopped at the timeout', r);
r = await call({ type: 'call', fn: 'add', args: [1, 1] });
ok(r.ok && r.value === 2, 'and the worker is restarted, so the next call works', r);
r = await call({ type: 'call', fn: 'inc', args: [1], on: handle });
ok(!r.ok && r.error.name === 'HandleError', 'handles from before the restart are gone, and the error says so');
await sb.stop();

section('explore, synthesize, declarations');
const j = await C.explore('lib-target', lib(target, { timeoutMs: 1500 }), { maxSteps: 400 });
const spec = C.synthesize(j, undefined, C.readExplorerState('lib-target'));
const L = spec.library;
const ex = (n) => L.exports.find(e => e.name === n);
ok(j.steps.length > 60 && j.steps[0].observation.surface, 'the surface is the first step and many calls follow', j.steps.length);
ok(ex('add').params.length === 2 && ex('add').params.every(p => p.type === 'number' && !p.optional) && ex('add').returns === 'number', 'add(number, number): number, learned from which arguments were accepted', ex('add'));
ok(ex('add').throws.some(t => t.name === 'TypeError'), 'its TypeError is in the spec', ex('add').throws);
ok(ex('greet').params[0].optional && ex('greet').params[0].type === 'unknown' && ex('greet').returns === 'string', 'a parameter that accepts anything is unknown, and a defaulted one is optional', ex('greet'));
ok(ex('fetchUser').async && /\{ id: number; name: string \}|Record/.test(ex('fetchUser').returns), 'an async function returns its resolved shape', ex('fetchUser'));
ok(ex('Counter').kind === 'class' && ex('Counter').params[0].optional && ex('Counter').params[0].type === 'number', 'a class has constructor parameters', ex('Counter'));
ok(ex('Counter').members.some(m => m.name === 'inc' && m.returns === 'number') && ex('Counter').members.some(m => m.name === 'value' && m.kind === 'accessor' && m.returns === 'number') && ex('Counter').members.some(m => m.name === 'zero' && m.kind === 'static'), 'its methods, accessor and static are typed', ex('Counter').members);
ok(ex('VERSION').kind === 'value' && ex('VERSION').returns === 'string', 'a constant keeps its type');
ok(ex('util').kind === 'object' && ex('util').members.some(m => m.name === 'double'), 'an object of functions is described');
const d = L.declarations;
ok(/export function add\(arg0: number, arg1: number\): number;/.test(d) && /export class Counter \{/.test(d) && /constructor\(arg0\?: number\);/.test(d) && /readonly value: number;/.test(d) && /export const VERSION: string;/.test(d) && /Promise</.test(d), 'the declaration file reads like TypeScript', d);
ok(/Throws TypeError/.test(d), 'throws are documented in the declarations');
ok(spec.unknowns.some(u => /inferred from sampled calls/.test(u)) && spec.unknowns.some(u => /lifecycle hooks/.test(u)), 'the spec says what inference cannot know');

section('the firewall carries the declarations and nothing else');
const ws = path.join(base, 'ws');
C.prepareWorkspace(spec, ws);
ok(fs.readFileSync(path.join(ws, 'spec', 'library.d.ts'), 'utf8').includes('export function add'), 'the declaration file is part of the spec the implementer gets');
ok(C.assertSpecOnly(ws, C.corpusDir('lib-target')).ok, 'and the workspace is still spec-only');
ok(/Declarations inferred from observed calls/.test(fs.readFileSync(path.join(ws, 'spec', 'SPEC.md'), 'utf8')) && !fs.readFileSync(path.join(ws, 'spec', 'SPEC.md'), 'utf8').includes(target), 'SPEC.md shows them and never names where the target lives');

section('twin-test a library clone');
const same = writeLib('same', 'target');
const wrong = writeLib('wrong', 'wrong');
const missing = writeLib('missing', 'missing');
const tSame = await C.twinTest({ journey: j, clone: lib(same, { timeoutMs: 1500 }), maxSteps: 120 });
ok(tSame.parity === 1, 'an identical clone matches every recorded call (values, errors, async, handles, console output)', C.renderTwinReport(tSame));
const tWrong = await C.twinTest({ journey: j, clone: lib(wrong, { timeoutMs: 1500 }), maxSteps: 120 });
ok(tWrong.parity < 1 && tWrong.differences.some(x => x.field === 'value' && x.stimulus.fn === 'add'), 'a clone whose add subtracts is caught on the value', C.renderTwinReport(tWrong));
const tMissing = await C.twinTest({ journey: j, clone: lib(missing, { timeoutMs: 1500 }), maxSteps: 5 });
ok(tMissing.differences.some(x => x.field === 'exports'), 'a clone with a different set of exports is caught', C.renderTwinReport(tMissing));
const specClone = C.synthesize(await C.explore('lib-wrong', lib(wrong, { timeoutMs: 1500 }), { maxSteps: 400 }));
const sd = C.diffSpecs(spec, specClone);
void sd;

section('Python');
const py = ['python3', 'python'].find(c => { try { return spawnSync(c, ['--version'], { windowsHide: true }).status === 0; } catch { return false; } });
if (!py) console.log('  SKIP  no Python on this machine');
else {
  const pyFile = path.join(base, 'pymod.py');
  fs.writeFileSync(pyFile, `
import asyncio
def add(a: int, b: int) -> int:
    if not isinstance(a, (int, float)) or not isinstance(b, (int, float)): raise TypeError("add expects numbers")
    return a + b
def greet(name="world"):
    return "Hello, " + str(name) + "!"
async def fetch(n):
    if not isinstance(n, int): raise ValueError("n must be an int")
    return {"n": n}
class Counter:
    def __init__(self, start=0):
        self.n = start
    def inc(self, by=1):
        self.n += by
        return self.n
    @property
    def value(self):
        return self.n
VERSION = "2.0"
`);
  const jp = await C.explore('lib-py', { kind: 'library', entry: pyFile, timeoutMs: 6000 }, { maxSteps: 220 });
  const sp = C.synthesize(jp);
  const pe = (n) => sp.library.exports.find(e => e.name === n);
  ok(sp.library.language === 'python' && pe('add') && pe('Counter')?.kind === 'class', 'a Python module is probed through the same pipeline', sp.library.exports.map(e => e.name));
  ok(pe('add').params.map(p => p.name).join() === 'a,b' && /def add\(a: int, b: int\) -> int: \.\.\./.test(sp.library.declarations), 'real parameter names and annotations come from the signature; a .pyi stub is produced', sp.library.declarations);
  ok(pe('add').throws.some(t => t.name === 'TypeError') && pe('fetch').async, 'errors and coroutines are observed', pe('fetch'));
  ok(/class Counter:/.test(sp.library.declarations) && /def inc\(self/.test(sp.library.declarations) && /@property/.test(sp.library.declarations), 'a class, its method and a property are stubbed');
  ok(sp.unknowns.some(u => /unconfined/.test(u)), 'the spec says a Python library was probed without a sandbox');
  const tp = await C.twinTest({ journey: jp, clone: { kind: 'library', entry: pyFile, timeoutMs: 6000 }, maxSteps: 80 });
  ok(tp.parity === 1, 'the same Python module replayed matches itself', C.renderTwinReport(tp));
}

try { fs.rmSync(base, { recursive: true, force: true, maxRetries: 3 }); } catch { /* temp */ }
console.log(`\ncleanroom library: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
