/**
 * The explorer: drive a target through everything reachable, record every step,
 * and say how much of what it saw it actually tried.
 *
 * A deterministic, budgeted search by default: it tries each control it can
 * see, fingerprints the result, and moves on from states it has not met. A
 * model can steer it instead (`guide`, see guide.ts): at each state the guide
 * proposes the actions most likely to reveal new behaviour, and anything it
 * proposes that the target does not actually offer is dropped, so a guide can
 * focus the search but never invent a stimulus.
 *
 * **Coverage is measured, not assumed.** Everything the explorer *discovers*
 * (a control, a subcommand, a flag, a linked path) is listed, everything it
 * *tries* is listed, and the difference is the frontier, written to
 * `explorer-state.json` with the reason each skipped item was skipped. The
 * spec and the twin-test report that ratio, so "100% parity" is always read
 * next to "on 84% of what was found".
 *
 * **Resumable.** The search state (seen states, tried items, the unvisited
 * queue) is saved when a run ends, whether it finished or ran out of budget.
 * `resume: true` continues from it into the same journey instead of starting
 * over, so a large target is covered across runs.
 *
 * Replay, not rewind: a web state is reached by starting fresh and replaying
 * the stimuli that led there, because a page cannot be rolled back. Every
 * recorded journey is therefore replayable on the clone.
 *
 * Per target:
 *  - web: links, buttons and forms, same origin by default (`sameOriginOnly`
 *    is a scope for the crawl, not a policy; switch it off to follow out-links).
 *  - cli: `--help`, `-h`, `--version`, `help`, then each subcommand and flag the
 *    help text names, run with `--help` and, for a flag, with a probe value.
 *  - api: the given seeds, `/`, health and OpenAPI paths, then every path found
 *    in JSON bodies and in an OpenAPI document, plus a request for an id that
 *    cannot exist (the error contract).
 *
 * @module cleanroom/explorer
 */

import fs from 'node:fs';
import path from 'node:path';
import type { Control, Journey, LaunchSpec, LibExportInfo, Observation, Sandbox, Step, Stimulus } from './types.js';
import { Recorder, corpusDir, readJourney } from './recorder.js';
import { createSandbox } from './sandbox-api.js';

/** What the search knows, saved between runs. */
export interface ExplorerState {
  version: 1;
  kind: LaunchSpec['kind'];
  discovered: string[];
  tried: string[];
  skipped: { item: string; reason: string }[];
  /** Unvisited work left when the run ended: states not entered, commands not run, paths not requested. */
  pending: string[];
  stoppedBy: 'complete' | 'budget' | 'aborted';
  web?: { seenStates: string[]; queue: Stimulus[][] };
  cli?: { seen: string[]; queue: { args: string[]; expand: boolean; depth: number }[]; started: boolean };
  api?: { seen: string[]; queue: Extract<Stimulus, { type: 'request' }>[]; missingProbed: string[] };
  library?: { listed: boolean; done: string[] };
}

/** What a guide is shown at a state, and what it may answer. */
export interface GuideView {
  kind: LaunchSpec['kind'];
  /** A short description of where the target is now. */
  state: string;
  /** The things on offer here (controls for the web; commands and flags for a CLI; paths for an API). */
  options: string[];
  /** What has been tried so far, most recent last. */
  history: string[];
}
/** Returns the options (by exact text from `options`) to try, most promising first; undefined to fall back to the default order. */
export type Guide = (view: GuideView) => Promise<string[] | undefined>;

export interface ExploreOptions {
  maxSteps?: number;
  maxDepth?: number;
  signal?: AbortSignal;
  sameOriginOnly?: boolean;
  /** Continue a previous run of the same id instead of starting over. */
  resume?: boolean;
  /** Replace an existing recording of this id. */
  overwrite?: boolean;
  /** Steer the search (guide.ts). Never adds a stimulus the target did not offer. */
  guide?: Guide;
  /** Values typed into form fields while exploring. */
  fillValues?: { text?: string; email?: string; number?: string };
  /** API: extra requests to start from. */
  seeds?: Extract<Stimulus, { type: 'request' }>[];
  onStep?: (s: Step) => void;
  /** Test seam: build the sandbox. */
  makeSandbox?: (kind: LaunchSpec['kind']) => Sandbox;
}

const stateFile = (id: string): string => path.join(corpusDir(id), 'explorer-state.json');

export function readExplorerState(id: string): ExplorerState | undefined {
  try { return JSON.parse(fs.readFileSync(stateFile(id), 'utf8')) as ExplorerState; } catch { return undefined; }
}

export async function explore(id: string, target: LaunchSpec, opts: ExploreOptions = {}): Promise<Journey> {
  if (!opts.resume && !opts.overwrite) {
    const existing = (() => { try { return readJourney(id).steps.length; } catch { return 0; } })();
    if (existing > 0) throw new Error(`"${id}" already holds ${existing} recorded step(s). Continue it with --resume, or record again under another id (or --force to start over).`);
  }
  if (!opts.resume && opts.overwrite) fs.rmSync(corpusDir(id), { recursive: true, force: true });
  const rec = new Recorder(id, target, { keepMeta: !!opts.resume });
  const make = opts.makeSandbox ?? createSandbox;
  const prior = opts.resume ? readExplorerState(id) : undefined;
  if (prior && prior.kind !== target.kind) throw new Error(`cannot resume "${id}": it was recorded as a ${prior.kind} target`);
  const st: ExplorerState = prior ?? { version: 1, kind: target.kind, discovered: [], tried: [], skipped: [], pending: [], stoppedBy: 'complete' };
  const c: Ctx = { rec, make, target, opts, steps: 0, max: opts.maxSteps ?? 60, st, discovered: new Set(st.discovered), tried: new Set(st.tried), history: [] };
  try {
    if (target.kind === 'web' || target.kind === 'desktop' || target.kind === 'mobile') await exploreWeb(c);
    else if (target.kind === 'cli') await exploreCli(c);
    else if (target.kind === 'library') await exploreLibrary(c);
    else if (target.kind === 'daemon') await exploreDaemon(c);
    else await exploreApi(c);
  } finally {
    st.discovered = [...c.discovered]; st.tried = [...c.tried];
    st.stoppedBy = opts.signal?.aborted ? 'aborted' : st.pending.length ? 'budget' : 'complete';
    fs.writeFileSync(stateFile(id), JSON.stringify(st, null, 2));
  }
  return readJourney(id);
}

interface Ctx { rec: Recorder; make: (k: LaunchSpec['kind']) => Sandbox; target: LaunchSpec; opts: ExploreOptions; steps: number; max: number; st: ExplorerState; discovered: Set<string>; tried: Set<string>; history: string[] }
const done = (c: Ctx): boolean => c.steps >= c.max || !!c.opts.signal?.aborted;

async function record(c: Ctx, sb: Sandbox, from: string, stimulus: Stimulus): Promise<{ obs: Observation; to: string }> {
  await sb.inject(stimulus);
  const obs = await sb.observe();
  const to = await sb.snapshot();
  const step = c.rec.append({ from, stimulus, observation: obs, to });
  c.steps++;
  c.history.push(describe(stimulus));
  c.opts.onStep?.(step);
  return { obs, to };
}

const describe = (s: Stimulus): string => (s.type === 'click' ? `click ${s.selector}` : s.type === 'fill' ? `fill ${s.selector}` : s.type === 'run' ? `run ${s.args.join(' ')}` : s.type === 'request' ? `${s.method} ${s.path}` : s.type);

/** Put the guide's picks first, keeping only options the target really offered; the rest follow in their own order. */
async function ordered<T>(c: Ctx, view: Omit<GuideView, 'kind' | 'history'>, items: T[], label: (t: T) => string): Promise<T[]> {
  if (!c.opts.guide) return items;
  let picks: string[] | undefined;
  try { picks = await c.opts.guide({ kind: c.target.kind, ...view, history: c.history.slice(-12) }); } catch { picks = undefined; }
  if (!picks?.length) return items;
  const byLabel = new Map(items.map(i => [label(i), i]));
  const first = picks.map(p => byLabel.get(p)).filter((x): x is T => x !== undefined);
  return [...new Set([...first, ...items])];
}

// ── web ────────────────────────────────────────────────────────────────────────

async function exploreWeb(c: Ctx): Promise<void> {
  const t = c.target as Extract<LaunchSpec, { kind: 'web' | 'desktop' | 'mobile' }>;
  const kind = t.kind;
  // A web page is entered by URL; a desktop application by starting it. The landing step records which.
  const origin = t.kind === 'web' ? new URL(t.url).origin : '';
  const landing: Stimulus = t.kind === 'web' ? { type: 'navigate', url: t.url } : { type: 'wait', ms: 0 };
  const maxDepth = c.opts.maxDepth ?? 4;
  const w = (c.st.web ??= { seenStates: [], queue: [[]] });
  const seenStates = new Set(w.seenStates);
  const queue: Stimulus[][] = w.queue.length ? w.queue : (c.opts.resume ? [] : [[]]);
  const skip = (item: string, reason: string): void => { if (!c.st.skipped.some(s => s.item === item)) c.st.skipped.push({ item, reason }); };
  try {
    while (queue.length && !done(c)) {
      const pathTo = queue.shift()!;
      if (pathTo.length > maxDepth) { skip(`state after ${pathTo.map(describe).join(' > ')}`, `deeper than --max-depth ${maxDepth}`); continue; }
      // Reach the state silently (its steps are already in the corpus), then read what can be done there.
      const sb = c.make(kind);
      let from: string, here: Observation;
      try {
        await sb.start(t, c.opts.signal);
        from = await sb.snapshot();
        for (const s of pathTo) ({ to: from } = await silent(sb, from, s));
        here = await sb.observe();
      } finally { await sb.stop(); }
      if (seenStates.has(from) && pathTo.length) continue;
      if (!pathTo.length && !c.opts.resume) { // the landing page is the first recorded state (a resumed run already has it)
        c.rec.append({ from: 'start', stimulus: landing, observation: here, to: from });
        c.steps++;
      }
      const label = (x: Control): string => `${x.role}: ${x.name || x.selector}`;
      const controls = here.controls ?? [];
      for (const ctl of controls) c.discovered.add(`${from}|${label(ctl)}`);
      const candidates: Control[] = [];
      for (const ctl of controls) {
        const k = `${from}|${label(ctl)}`;
        if (c.tried.has(k)) continue;
        const why = skipReason(ctl, origin, c.opts.sameOriginOnly !== false, here.url);
        if (why) { skip(k, why); continue; }
        candidates.push(ctl);
      }
      const order = await ordered(c, { state: `${here.title ?? ''} ${pathOf(here.url)}\n${(here.text ?? '').slice(0, 300)}`, options: candidates.map(label) }, candidates, label);
      for (const ctl of order) {
        if (done(c)) break;
        const k = `${from}|${label(ctl)}`;
        if (c.tried.has(k)) continue;
        c.tried.add(k);
        // A button inside a form: fill that form's fields first, as a person would, then press it.
        const fills: Stimulus[] = ctl.formAction === undefined ? [] : controls
          .filter(x => x.role === 'textbox' && x.formAction === ctl.formAction)
          .map(x => ({ type: 'fill' as const, selector: x.selector, value: fillValue(x, c.opts) }));
        const stims: Stimulus[] = [...fills, { type: 'click', selector: ctl.selector }];
        const sb2 = c.make(kind);
        try {
          await sb2.start(t, c.opts.signal);
          let cur = await sb2.snapshot();
          for (const s of pathTo) ({ to: cur } = await silent(sb2, cur, s));
          let to = cur;
          for (const st of stims) { if (done(c)) break; ({ to } = await record(c, sb2, cur, st)); cur = to; }
          if (!seenStates.has(to)) queue.push([...pathTo, ...stims]);
        } finally { await sb2.stop(); }
      }
      // A state is finished when every control in it was tried; otherwise (the budget ran out) it goes back on the queue so a resume finishes it.
      if (candidates.some(x => !c.tried.has(`${from}|${label(x)}`))) queue.unshift(pathTo);
      else seenStates.add(from);
    }
  } finally {
    w.seenStates = [...seenStates]; w.queue = queue;
    c.st.pending = queue.map(p => (p.length ? `state after ${p.map(describe).join(' > ')}` : 'the landing page'));
  }
}

function fillValue(x: Control, o: ExploreOptions): string {
  const v = o.fillValues ?? {};
  if (x.inputType === 'email' || /mail/i.test(x.name)) return v.email ?? 'probe@example.test';
  if (x.inputType === 'number' || /qty|count|amount|age/i.test(x.name)) return v.number ?? '3';
  if (x.inputType === 'password') return 'probe-Pass-12345';
  return v.text ?? 'probe';
}

async function silent(sb: Sandbox, from: string, s: Stimulus): Promise<{ to: string }> { await sb.inject(s); return { to: await sb.snapshot() }; }

const pathOf = (u?: string): string => { try { return u ? new URL(u).pathname : ''; } catch { return u ?? ''; } };

/** Why a control is not clicked, or undefined when it is worth trying. */
function skipReason(ctl: Control, origin: string, sameOrigin: boolean, pageUrl?: string): string | undefined {
  if (ctl.role === 'textbox' || ctl.role === 'combobox') return 'a field: typed into with its form, not clicked on its own';
  if (ctl.href) {
    if (/^(mailto:|tel:|javascript:)/i.test(ctl.href)) return 'not a page (mailto, tel or javascript link)';
    if (/^#?$/.test(ctl.href)) return 'an empty or in-page link';
    try { if (sameOrigin && new URL(ctl.href, pageUrl ?? origin).origin !== origin) return 'leaves the target\'s origin (--follow-external to follow)'; } catch { return 'an unreadable link'; }
  }
  return undefined;
}

// ── cli ────────────────────────────────────────────────────────────────────────

/** Subcommands and flags named in a help text. Conservative: it only reads the usual two layouts. */
export function parseHelp(text: string): { commands: string[]; flags: { name: string; takesValue: boolean; description: string }[] } {
  const commands = new Set<string>();
  const flags = new Map<string, { name: string; takesValue: boolean; description: string }>();
  let section = '';
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, '');
    const head = /^([A-Za-z][A-Za-z ]*):\s*$/.exec(line);
    if (head) { section = head[1]!.toLowerCase(); continue; }
    const f = /^\s{1,8}(?:-[A-Za-z],?\s+)?(--[a-z0-9][a-z0-9-]*)(?:[ =]([<\[]?[A-Za-z_-]+[>\]]?))?\s{2,}(.*)$/.exec(line) ?? /^\s{1,8}(-[A-Za-z])(?:\s+([<\[]?[A-Za-z_-]+[>\]]?))?\s{2,}(.*)$/.exec(line);
    if (f) { flags.set(f[1]!, { name: f[1]!, takesValue: !!f[2], description: (f[3] ?? '').trim() }); continue; }
    if (/^(commands?|subcommands?|available commands?)$/.test(section)) {
      const m = /^\s{1,8}([a-z][a-z0-9:-]*)(?:\s+[<\[].*?)?\s{2,}\S/.exec(line);
      if (m) commands.add(m[1]!);
    }
  }
  return { commands: [...commands], flags: [...flags.values()] };
}

async function exploreCli(c: Ctx): Promise<void> {
  const t = c.target as Extract<LaunchSpec, { kind: 'cli' }>;
  const k = (c.st.cli ??= { seen: [], queue: [], started: false });
  const seen = new Set(k.seen);
  if (!k.started && !c.opts.resume) {
    k.started = true;
    for (const probe of [['--help'], ['-h'], ['--version'], ['-V'], ['help'], []]) k.queue.push({ args: probe, expand: probe[0] === '--help' || probe[0] === '-h' || probe[0] === 'help', depth: 0 });
  }
  const sb = c.make('cli');
  await sb.start(t, c.opts.signal);
  let from = 'start';
  try {
    while (k.queue.length && !done(c)) {
      const batch = await ordered(c, { state: `running ${t.name ?? t.command}`, options: k.queue.map(q => q.args.join(' ') || '(no arguments)') }, k.queue, q => q.args.join(' ') || '(no arguments)');
      const item = batch[0]!;
      k.queue.splice(k.queue.indexOf(item), 1);
      const key = item.args.join('\u0000');
      if (seen.has(key)) continue;
      seen.add(key);
      c.tried.add(`run ${item.args.join(' ') || '(no arguments)'}`);
      const r = await record(c, sb, from, { type: 'run', args: item.args });
      from = r.to;
      if (!item.expand || item.depth >= 3) continue;
      const prefix = item.args.slice(0, -1);
      const { commands, flags } = parseHelp(r.obs.stdout || r.obs.stderr || '');
      for (const f of flags.slice(0, 20)) { c.discovered.add(`run ${[...prefix, f.name, ...(f.takesValue ? ['probe'] : [])].join(' ')}`); k.queue.push({ args: [...prefix, f.name, ...(f.takesValue ? ['probe'] : [])], expand: false, depth: item.depth }); }
      for (const cmd of commands) {
        c.discovered.add(`run ${[...prefix, cmd, '--help'].join(' ')}`); c.discovered.add(`run ${[...prefix, cmd].join(' ')}`);
        k.queue.push({ args: [...prefix, cmd, '--help'], expand: true, depth: item.depth + 1 }, { args: [...prefix, cmd], expand: false, depth: item.depth + 1 });
      }
    }
    if (!k.queue.length && !seen.has('--definitely-not-a-flag') && !done(c)) { // the error path is part of the contract
      seen.add('--definitely-not-a-flag'); c.tried.add('run --definitely-not-a-flag'); await record(c, sb, from, { type: 'run', args: ['--definitely-not-a-flag'] });
    }
  } finally {
    k.seen = [...seen];
    c.st.pending = k.queue.map(q => `run ${q.args.join(' ') || '(no arguments)'}`);
    await sb.stop();
  }
}

// ── api ────────────────────────────────────────────────────────────────────────

export function pathsIn(body: string, base: string): string[] {
  const out = new Set<string>();
  const add = (s: string): void => {
    try {
      const u = new URL(s, base);
      if (u.origin === new URL(base).origin && !/\.(png|jpe?g|gif|svg|css|js|ico|woff2?)$/i.test(u.pathname)) out.add(u.pathname + u.search);
    } catch { /* not a URL */ }
  };
  for (const m of body.matchAll(/"((?:https?:\/\/[^"\s]+)|(?:\/[A-Za-z0-9_\-./{}?=&%]*))"/g)) if (!m[1]!.includes('{')) add(m[1]!);
  try {
    const doc = JSON.parse(body) as { paths?: Record<string, Record<string, unknown>> };
    for (const [p, ops] of Object.entries(doc.paths ?? {})) if (!p.includes('{') && ops && typeof ops === 'object' && 'get' in ops) out.add(p);
  } catch { /* not JSON */ }
  return [...out];
}

async function exploreApi(c: Ctx): Promise<void> {
  const t = c.target as Extract<LaunchSpec, { kind: 'api' }>;
  const a = (c.st.api ??= { seen: [], queue: [], missingProbed: [] });
  const seen = new Set(a.seen), missingProbed = new Set(a.missingProbed);
  if (!a.queue.length && !c.opts.resume) {
    a.queue.push(...(c.opts.seeds ?? []), ...['/', '/health', '/healthz', '/status', '/openapi.json', '/swagger.json', '/api', '/api/v1'].map(p => ({ type: 'request' as const, method: 'GET', path: p })));
  }
  const sb = c.make('api');
  await sb.start(t, c.opts.signal);
  const keyOf = (s: Extract<Stimulus, { type: 'request' }>): string => `${s.method} ${s.path} ${JSON.stringify(s.body ?? '')}`;
  let from = 'start';
  try {
    while (a.queue.length && !done(c)) {
      const batch = await ordered(c, { state: `API at ${t.baseUrl}`, options: a.queue.map(q => `${q.method} ${q.path}`) }, a.queue, q => `${q.method} ${q.path}`);
      const s = batch[0]!;
      a.queue.splice(a.queue.indexOf(s), 1);
      const key = keyOf(s);
      if (seen.has(key)) continue;
      seen.add(key);
      c.tried.add(`${s.method} ${s.path}`);
      const r = await record(c, sb, from, s);
      from = r.to;
      const res = r.obs.response;
      if (res && res.status < 400) for (const p of pathsIn(res.body, t.baseUrl)) { c.discovered.add(`GET ${p}`); a.queue.push({ type: 'request', method: 'GET', path: p }); }
      // The error contract is part of the API: for a resource path with an id, also ask for one that cannot exist.
      if (res && res.status < 400 && s.method === 'GET') {
        const pathname = s.path.split('?')[0]!;
        const tpl = pathname.replace(/\/(\d+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?=\/|$)/gi, '/{id}');
        if (tpl !== pathname && !missingProbed.has(tpl)) { missingProbed.add(tpl); a.queue.push({ type: 'request', method: 'GET', path: tpl.replace(/\{id\}/g, '999999999') }); }
      }
      if (s.method === 'GET' && s.path !== '/') { // the same resource with other methods: what is allowed is part of the contract
        for (const m of ['HEAD', 'OPTIONS']) { if (!done(c)) { c.tried.add(`${m} ${s.path}`); from = (await record(c, sb, from, { type: 'request', method: m, path: s.path })).to; } }
      }
    }
  } finally {
    a.seen = [...seen]; a.missingProbed = [...missingProbed];
    c.st.pending = a.queue.filter(q => !seen.has(keyOf(q))).map(q => `${q.method} ${q.path}`);
    await sb.stop();
  }
}

/** Coverage in one line for a report. */
export function coverageLine(st: ExplorerState | undefined): string {
  if (!st) return 'Coverage of the exploration was not recorded.';
  const found = st.discovered.length, tried = st.tried.length;
  const pending = st.pending.length;
  const pct = found ? Math.round(Math.min(1, st.discovered.filter(d => st.tried.includes(d)).length / found) * 100) : 100;
  return `The explorer tried ${tried} item(s) and found ${found}; ${pct}% of what it found was tried${pending ? `, ${pending} left unvisited (resume to continue)` : ''}${st.skipped.length ? `, ${st.skipped.length} skipped on purpose` : ''}.`;
}

// ── library ────────────────────────────────────────────────────────────────────

/** The values a library function is called with: one of each kind a type checker would care about. */
const FUZZ: unknown[] = [{ $: 'undefined' }, null, 0, 1, -1, 2.5, { $: 'NaN' }, '', 'a', 'hello world', true, false, [], [1, 2, 3], {}, { a: 1 }, { $: 'fn' }];
const SMALL: unknown[] = [1, 'a', [], {}, true, null];

/** The argument vectors tried for a callable of this arity: none, each kind alone, then pairs and a triple. */
export function argVectors(arity: number, cap = 40): unknown[][] {
  const out: unknown[][] = [[]];
  for (const v of FUZZ) out.push([v]);
  if (arity >= 2) for (const a of SMALL) for (const b of SMALL) out.push([a, b]);
  if (arity >= 3) out.push([1, 1, 1], ['a', 'a', 'a'], [1, 'a', true]);
  return out.slice(0, cap);
}

async function exploreLibrary(c: Ctx): Promise<void> {
  const t = c.target as Extract<LaunchSpec, { kind: 'library' }>;
  const lib = (c.st.library ??= { listed: false, done: [] });
  const doneSet = new Set(lib.done);
  const sb = c.make('library') as Sandbox & { list(): Promise<LibExportInfo[]> };
  await sb.start(t, c.opts.signal);
  let from = 'start';
  try {
    const surface = await sb.list();
    if (!lib.listed) {
      c.rec.append({ from: 'start', stimulus: { type: 'get', prop: '<exports>' }, observation: { at: new Date().toISOString(), kind: 'library', surface }, to: 'listed' });
      c.steps++; lib.listed = true;
    }
    from = 'listed';
    const step = async (stim: Stimulus): Promise<Observation> => { const r = await record(c, sb, from, stim); from = r.to; return r.obs; };
    const capExports = 60;
    const names = await ordered(c, { state: 'a library: choose what to probe first', options: surface.slice(0, capExports).map(e => e.name) }, surface.slice(0, capExports), e => e.name);
    for (const e of names) {
      if (done(c)) break;
      if (doneSet.has(e.name)) continue;
      c.discovered.add(`call ${e.name}`);
      if (e.kind === 'value') { c.tried.add(`call ${e.name}`); doneSet.add(e.name); continue; }
      if (e.kind === 'object') {
        for (const f of e.fns ?? []) {
          c.discovered.add(`call ${e.name}.${f.name}`);
          for (const args of argVectors(f.arity, 24)) { if (done(c)) break; await step({ type: 'call', fn: `${e.name}.${f.name}`, args }); }
          c.tried.add(`call ${e.name}.${f.name}`);
        }
        c.tried.add(`call ${e.name}`); doneSet.add(e.name); continue;
      }
      // A function or a class: call it with nothing first; a class says so (and Python lists it as one).
      const first = await step({ type: 'call', fn: e.name, args: [] });
      const isClass = e.isClass || /Class constructor|without 'new'/.test(first.call?.error?.message ?? '');
      if (!isClass) {
        for (const args of argVectors(e.arity ?? 0).slice(1)) { if (done(c)) break; await step({ type: 'call', fn: e.name, args }); }
      } else {
        let goodArgs: unknown[] | undefined;
        const construct = async (args: unknown[]): Promise<string | undefined> => {
          const o = await step({ type: 'call', fn: e.name, args, construct: true });
          const v = o.call?.value as { $?: string; handle?: string } | undefined;
          return o.call?.ok && v?.$ === 'instance' ? v.handle : undefined;
        };
        if (await construct([])) goodArgs = [];
        for (const v of FUZZ.slice(1, 12)) { if (done(c)) break; if ((await construct([v])) && !goodArgs) goodArgs = [v]; }
        if (goodArgs) {
          for (const m of (e.members ?? []).slice(0, 20)) {
            if (done(c)) break;
            c.discovered.add(`call ${e.name}#${m.name}`);
            // A fresh instance per member: one method's probes must not change the state the next one sees.
            const handle = await construct(goodArgs);
            if (!handle) continue;
            if (m.kind === 'accessor') { await step({ type: 'get', prop: m.name, on: handle }); c.tried.add(`call ${e.name}#${m.name}`); continue; }
            for (const args of argVectors(m.arity ?? 0, 10)) { if (done(c)) break; await step({ type: 'call', fn: m.name, args, on: handle }); }
            c.tried.add(`call ${e.name}#${m.name}`);
          }
        }
        for (const s of e.statics ?? []) { for (const args of argVectors(s.arity, 16)) { if (done(c)) break; await step({ type: 'call', fn: `${e.name}.${s.name}`, args }); } }
      }
      if (!done(c)) { c.tried.add(`call ${e.name}`); doneSet.add(e.name); }
    }
    c.st.pending = surface.filter(e => !doneSet.has(e.name) && e.kind !== 'value').map(e => `call ${e.name}`);
  } finally {
    lib.done = [...doneSet];
    await sb.stop();
  }
}

// ── daemon ─────────────────────────────────────────────────────────────────────

/** What a daemon is sent on each channel: nothing (a banner), the usual verbs, a protocol or two, and garbage (the error contract). */
export const DAEMON_PROBES = ['', 'PING\\n', 'HELP\\n', 'help\\r\\n', 'GET / HTTP/1.0\\r\\n\\r\\n', '{"jsonrpc":"2.0","method":"ping","id":1}\\n', '\\n', 'zzz-unknown-command\\n'];

async function exploreDaemon(c: Ctx): Promise<void> {
  const t = c.target as Extract<LaunchSpec, { kind: 'daemon' }>;
  const sb = c.make('daemon');
  await sb.start(t, c.opts.signal);
  let from = 'start';
  const step = async (stim: Stimulus): Promise<Observation> => { const r = await record(c, sb, from, stim); from = r.to; return r.obs; };
  try {
    const startup = await step({ type: 'wait', ms: 0 }); // what it said while starting
    const channels: string[] = [];
    if (startup.daemon?.port) channels.push('tcp');
    for (const p of t.ipc ?? []) channels.push(/^(tcp:|socket:|pipe:)/.test(p) ? p : (process.platform === 'win32' && /^[\\/]{2}[.?][\\/]pipe/i.test(p) ? `pipe:${p}` : `socket:${p}`));
    for (const ch of channels) c.discovered.add(`channel ${ch}`);
    for (const ch of channels) {
      for (const data of DAEMON_PROBES) {
        if (done(c)) break;
        c.tried.add(`channel ${ch}`);
        await step({ type: 'send', channel: ch, data });
      }
    }
    for (const dir of t.watchDirs ?? []) {
      if (done(c)) break;
      c.discovered.add(`watch ${dir}`);
      const probe = path.join(dir, 'cleanroom-probe.txt');
      await step({ type: 'fs-write', path: probe, content: 'probe' });
      await step({ type: 'fs-write', path: probe, content: 'probe, changed' });
      await step({ type: 'fs-delete', path: probe });
      c.tried.add(`watch ${dir}`);
    }
    // Signals last: a reload leaves it running; a termination ends it. Windows has neither as a signal.
    if (process.platform !== 'win32' && !done(c)) { c.discovered.add('signal SIGHUP'); c.tried.add('signal SIGHUP'); await step({ type: 'signal', signal: 'SIGHUP' }); }
    if (!done(c)) { c.discovered.add('signal SIGTERM'); c.tried.add('signal SIGTERM'); await step({ type: 'signal', signal: 'SIGTERM' }); }
  } finally { await sb.stop(); }
}
