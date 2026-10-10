/**
 * The explorer: drive a target through everything reachable, record every step.
 *
 * A deterministic, budgeted search, not a model: it tries each control it can
 * see, fingerprints the result, and moves on from states it has not met. A
 * model-driven exploration (an agent deciding what is interesting) plugs into
 * the same {@link Sandbox} and {@link Recorder}; this one is the baseline that
 * needs no tokens and gives the same coverage every run.
 *
 * Replay, not rewind: a web state is reached by starting fresh and replaying
 * the stimuli that led there, because a page cannot be rolled back. That makes
 * every recorded journey replayable on the clone, which is what the twin-test
 * is built on. The cost is more page loads; the step budget bounds it.
 *
 * Per target:
 *  - web: links, buttons and forms, same origin by default (`sameOriginOnly`
 *    is a scope for the crawl, not a policy; switch it off to follow out-links).
 *  - cli: `--help`, `-h`, `--version`, `help`, then each subcommand and flag the
 *    help text names, run with `--help` and, for a flag, with a probe value.
 *  - api: the given seeds, `/`, health and OpenAPI paths, then every path found
 *    in JSON bodies and in an OpenAPI document.
 *
 * @module cleanroom/explorer
 */

import type { Control, Journey, LaunchSpec, Observation, Sandbox, Step, Stimulus } from './types.js';
import { Recorder } from './recorder.js';
import { createSandbox } from './sandbox-api.js';

export interface ExploreOptions {
  maxSteps?: number;
  maxDepth?: number;
  signal?: AbortSignal;
  sameOriginOnly?: boolean;
  /** Values typed into form fields while exploring. */
  fillValues?: { text?: string; email?: string; number?: string };
  /** API: extra requests to start from. */
  seeds?: Extract<Stimulus, { type: 'request' }>[];
  onStep?: (s: Step) => void;
  /** Test seam: build the sandbox. */
  makeSandbox?: (kind: LaunchSpec['kind']) => Sandbox;
}

export async function explore(id: string, target: LaunchSpec, opts: ExploreOptions = {}): Promise<Journey> {
  const rec = new Recorder(id, target);
  const make = opts.makeSandbox ?? createSandbox;
  const max = opts.maxSteps ?? 60;
  const ctx: Ctx = { rec, make, target, opts, steps: 0, max };
  if (target.kind === 'web') await exploreWeb(ctx);
  else if (target.kind === 'cli') await exploreCli(ctx);
  else await exploreApi(ctx);
  const { readJourney } = await import('./recorder.js');
  return readJourney(id);
}

interface Ctx { rec: Recorder; make: (k: LaunchSpec['kind']) => Sandbox; target: LaunchSpec; opts: ExploreOptions; steps: number; max: number }
const done = (c: Ctx): boolean => c.steps >= c.max || !!c.opts.signal?.aborted;

async function record(c: Ctx, sb: Sandbox, from: string, stimulus: Stimulus): Promise<{ obs: Observation; to: string }> {
  await sb.inject(stimulus);
  const obs = await sb.observe();
  const to = await sb.snapshot();
  const step = c.rec.append({ from, stimulus, observation: obs, to });
  c.steps++;
  c.opts.onStep?.(step);
  return { obs, to };
}

// ── web ────────────────────────────────────────────────────────────────────────

async function exploreWeb(c: Ctx): Promise<void> {
  const t = c.target as Extract<LaunchSpec, { kind: 'web' }>;
  const origin = new URL(t.url).origin;
  const maxDepth = c.opts.maxDepth ?? 4;
  const seenStates = new Set<string>();
  const tried = new Set<string>();
  const queue: Stimulus[][] = [[]];
  while (queue.length && !done(c)) {
    const path = queue.shift()!;
    if (path.length > maxDepth) continue;
    // Reach the state silently (its steps are already in the corpus), then read what can be done there.
    const sb = c.make('web');
    let from: string, here: Observation;
    try {
      await sb.start(t, c.opts.signal);
      from = await sb.snapshot();
      for (const s of path) ({ to: from } = await silent(sb, from, s));
      here = await sb.observe();
    } finally { await sb.stop(); }
    if (seenStates.has(from) && path.length) continue;
    seenStates.add(from);
    if (!path.length) { // the landing page is the first recorded state
      c.rec.append({ from: 'start', stimulus: { type: 'navigate', url: t.url }, observation: here, to: from });
      c.steps++;
    }
    for (const ctl of here.controls ?? []) {
      if (done(c)) break;
      const k = `${from}|${ctl.role}|${ctl.selector}`;
      if (tried.has(k) || !worthTrying(ctl, origin, c.opts.sameOriginOnly !== false, here.url)) continue;
      tried.add(k);
      // A button inside a form: fill that form's fields first, as a person would, then press it.
      const fills: Stimulus[] = ctl.formAction === undefined ? [] : (here.controls ?? [])
        .filter(x => x.role === 'textbox' && x.formAction === ctl.formAction)
        .map(x => ({ type: 'fill' as const, selector: x.selector, value: fillValue(x, c.opts) }));
      const stims: Stimulus[] = [...fills, { type: 'click', selector: ctl.selector }];
      const sb2 = c.make('web');
      try {
        await sb2.start(t, c.opts.signal);
        let cur = await sb2.snapshot();
        for (const s of path) ({ to: cur } = await silent(sb2, cur, s));
        let to = cur;
        for (const st of stims) { if (done(c)) break; ({ to } = await record(c, sb2, cur, st)); cur = to; }
        if (!seenStates.has(to)) queue.push([...path, ...stims]);
      } finally { await sb2.stop(); }
    }
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

function worthTrying(ctl: Control, origin: string, sameOrigin: boolean, pageUrl?: string): boolean {
  if (ctl.role === 'textbox' || ctl.role === 'combobox') return false; // typed into by the form handler below
  if (ctl.href) {
    if (/^(mailto:|tel:|javascript:|#?$)/i.test(ctl.href)) return false;
    try { if (sameOrigin && new URL(ctl.href, pageUrl ?? origin).origin !== origin) return false; } catch { return false; }
  }
  return true;
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
  const sb = c.make('cli');
  await sb.start(t, c.opts.signal);
  try {
    let from = 'start';
    const run = async (args: string[], stdin?: string): Promise<Observation> => {
      const r = await record(c, sb, from, { type: 'run', args, ...(stdin !== undefined ? { stdin } : {}) });
      from = r.to; return r.obs;
    };
    const root = await run(['--help']);
    const help = (root.stdout || root.stderr || '');
    for (const probe of [['-h'], ['--version'], ['-V'], ['help'], []]) { if (done(c)) break; await run(probe); }
    const seen = new Set<string>();
    const walk = async (prefix: string[], text: string, depth: number): Promise<void> => {
      const { commands, flags } = parseHelp(text);
      for (const f of flags.slice(0, 20)) { if (done(c)) return; await run([...prefix, f.name, ...(f.takesValue ? ['probe'] : [])]); }
      if (depth >= 3) return;
      for (const cmd of commands) {
        const key = [...prefix, cmd].join(' ');
        if (seen.has(key) || done(c)) continue;
        seen.add(key);
        const o = await run([...prefix, cmd, '--help']);
        await run([...prefix, cmd]);
        await walk([...prefix, cmd], o.stdout || o.stderr || '', depth + 1);
      }
    };
    await walk([], help, 0);
    await run(['--definitely-not-a-flag']); // the error path is part of the contract
  } finally { await sb.stop(); }
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
  const sb = c.make('api');
  await sb.start(t, c.opts.signal);
  try {
    const seen = new Set<string>();
    const missingProbed = new Set<string>();
    const queue: Extract<Stimulus, { type: 'request' }>[] = [
      ...(c.opts.seeds ?? []),
      ...['/', '/health', '/healthz', '/status', '/openapi.json', '/swagger.json', '/api', '/api/v1'].map(p => ({ type: 'request' as const, method: 'GET', path: p })),
    ];
    let from = 'start';
    while (queue.length && !done(c)) {
      const s = queue.shift()!;
      const key = `${s.method} ${s.path} ${JSON.stringify(s.body ?? '')}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const r = await record(c, sb, from, s);
      from = r.to;
      const res = r.obs.response;
      if (res && res.status < 400) for (const p of pathsIn(res.body, t.baseUrl)) queue.push({ type: 'request', method: 'GET', path: p });
      // The error contract is part of the API: for a resource path with an id, also ask for one that cannot exist.
      if (res && res.status < 400 && s.method === 'GET') {
        const pathname = s.path.split('?')[0]!;
        const tpl = pathname.replace(/\/(\d+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?=\/|$)/gi, '/{id}');
        if (tpl !== pathname && !missingProbed.has(tpl)) { missingProbed.add(tpl); queue.push({ type: 'request', method: 'GET', path: tpl.replace(/\{id\}/g, '999999999') }); }
      }
      if (s.method === 'GET' && s.path !== '/') { // the same resource with other methods: what is allowed is part of the contract
        for (const m of ['HEAD', 'OPTIONS']) { if (!done(c)) from = (await record(c, sb, from, { type: 'request', method: m, path: s.path })).to; }
      }
    }
  } finally { await sb.stop(); }
}
