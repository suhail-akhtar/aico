/**
 * The twin-test: same inputs to the target and the clone, differences reported.
 *
 * Two modes. `recorded` (the default) replays each recorded step against the
 * clone and compares with what the target did *when it was observed*: cheap,
 * needs no live target, and is what runs in CI. `live` runs every step against
 * both at the same moment, which is what a target whose answers change over
 * time needs and what catches drift in the recording itself.
 *
 * Replay, not guess: a step's stimulus is preceded by the stimuli that led to
 * its starting state (found by following `from`/`to` fingerprints back to the
 * landing page), so a deep state is reached the same way on both sides.
 *
 * What is compared, per target kind:
 *  - web: path, title, visible text, the set of controls, the side effects
 *    (non-GET and API requests with their status), the measured colours, and
 *    the screenshot (SSIM and changed-pixel share, pixel.ts).
 *  - cli: exit code, stdout, stderr and the rendered terminal screen, with
 *    ANSI stripped.
 *  - api: status, content type and body (JSON compared structurally).
 * Volatile values (timestamps, UUIDs, ports, durations) are scrubbed first,
 * with caller-supplied patterns on top, so a difference means a difference.
 *
 * `parity` is identical steps over steps replayed. It is a measure over the
 * recorded journeys, and the report says so: it is not a claim about
 * behaviour nobody observed.
 *
 * @module cleanroom/twin
 */

import fs from 'node:fs';
import type { Difference, Journey, LaunchSpec, Observation, Sandbox, Step, Stimulus, TwinReport } from './types.js';
import { createSandbox } from './sandbox-api.js';
import { frameFile } from './recorder.js';
import { comparePng } from './pixel.js';
import { stripAnsi } from './ansi.js';

export interface TwinOptions {
  journey: Journey;
  /** Where the clone runs (same kind as the target). */
  clone: LaunchSpec;
  mode?: 'recorded' | 'live';
  /** Target launch for `live` mode; defaults to the journey's own target. */
  live?: LaunchSpec;
  maxSteps?: number;
  /** Extra patterns scrubbed from text before comparing. */
  scrub?: RegExp[];
  ssimMin?: number;
  changedMax?: number;
  signal?: AbortSignal;
  makeSandbox?: (kind: LaunchSpec['kind']) => Sandbox;
  onStep?: (seq: number, same: boolean) => void;
}

const DEFAULT_SCRUB: RegExp[] = [
  /\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?\b/g,
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
  /(?<=localhost|127\.0\.0\.1):\d{2,5}/g,
  /\b\d+(?:\.\d+)?\s?ms\b/g,
  /0x[0-9a-f]{6,}/gi, // memory addresses in a default object representation
  /\b(?:listening on|on port|port|pid)[ =:]+\d{2,6}\b/gi, // ports and process ids a daemon announces
  /\b(?:ready|listening|bound|serving|running|started)\s+(?:on|at)\s+(?:[\w.:-]*:)?\d{2,6}\b/gi, // "ready on 51234"
];

export function scrub(s: string | undefined, extra: RegExp[] = []): string {
  let out = stripAnsi(s ?? '');
  for (const re of [...DEFAULT_SCRUB, ...extra]) out = out.replace(re, '<x>');
  return out.replace(/\r\n/g, '\n').replace(/[ \t]+\n/g, '\n').trim();
}

/** The stimuli that lead from the landing page to a step's starting state. */
export function prefixFor(steps: Step[], step: Step): Stimulus[] {
  const out: Stimulus[] = [];
  let want = step.from;
  const guard = new Set<number>();
  while (want !== 'start') {
    const parent = steps.find(s => s.to === want && s.seq < step.seq && !guard.has(s.seq));
    if (!parent) break;
    guard.add(parent.seq);
    out.unshift(parent.stimulus);
    want = parent.from;
  }
  return out;
}

export async function twinTest(o: TwinOptions): Promise<TwinReport> {
  const make = o.makeSandbox ?? createSandbox;
  const kind = o.journey.target.kind;
  if (o.clone.kind !== kind) throw new Error(`the clone is a ${o.clone.kind} target but the journey is ${kind}`);
  const mode = o.mode ?? 'recorded';
  if (kind === 'library' || kind === 'daemon') return twinSequential(o, make);
  const steps = o.journey.steps.slice(0, o.maxSteps ?? 200);
  const differences: Difference[] = [];
  const notes: string[] = [];
  let identical = 0, replayed = 0;
  for (const step of steps) {
    if (o.signal?.aborted) break;
    if (step.from === 'start' && (kind === 'web' || kind === 'desktop' || kind === 'mobile')) { /* the landing: replayed as a bare load */ }
    else if (kind !== 'web' && kind !== 'desktop' && kind !== 'mobile' && !['run', 'request'].includes(step.stimulus.type)) { notes.push(`step ${step.seq}: a "${step.stimulus.type}" stimulus is not replayed for ${kind} targets`); continue; }
    const prefix = kind === 'web' || kind === 'desktop' || kind === 'mobile' ? prefixFor(o.journey.steps, step) : [];
    const stim = step.from === 'start' && (kind === 'web' || kind === 'desktop' || kind === 'mobile') ? undefined : step.stimulus;
    let targetObs: Observation = step.observation;
    if (mode === 'live') targetObs = await runStep(make, o.live ?? o.journey.target, prefix, stim, o.signal);
    else if (kind === 'web' || kind === 'desktop' || kind === 'mobile') { const f = frameFile(o.journey.id, step.seq); if (f) targetObs = { ...targetObs, frame: new Uint8Array(fs.readFileSync(f)) }; }
    const cloneObs = await runStep(make, o.clone, prefix, stim, o.signal);
    const diffs = compare(kind, step, targetObs, cloneObs, o);
    replayed++;
    if (diffs.length === 0) identical++; else differences.push(...diffs);
    o.onStep?.(step.seq, diffs.length === 0);
  }
  if (o.journey.platform && o.journey.platform !== process.platform) notes.push(`Recorded on ${o.journey.platform}, replayed on ${process.platform}: line endings, paths, signals and terminal behaviour can differ for reasons that are not the clone's.`);
  notes.push('Parity is measured over the recorded journeys only; behaviour nobody observed is not covered.');
  return { journeys: 1, steps: replayed, identical, differences, parity: replayed ? identical / replayed : 0, notes };
}

/**
 * A library is replayed in order through one process: an object a call returned
 * is a handle the next calls use, so a step cannot be replayed on its own. The
 * handle numbers are assigned in call order, so the same journey on the clone
 * produces the same ones.
 */
async function twinSequential(o: TwinOptions, make: NonNullable<TwinOptions['makeSandbox']>): Promise<TwinReport> {
  const steps = o.journey.steps.slice(0, o.maxSteps ?? 400);
  const differences: Difference[] = [];
  const notes: string[] = [];
  let identical = 0, replayed = 0;
  const kind = o.journey.target.kind;
  const live = o.mode === 'live' ? make(kind) : undefined;
  const sb = make(kind);
  try {
    await sb.start(o.clone, o.signal);
    if (live) await live.start(o.live ?? o.journey.target, o.signal);
    for (const step of steps) {
      if (o.signal?.aborted) break;
      let targetObs: Observation = step.observation;
      let cloneObs: Observation;
      if (step.observation.surface) {
        const list = (sb as unknown as { list(): Promise<import('./types.js').LibExportInfo[]> }).list;
        const surface = await list.call(sb).catch(() => []);
        cloneObs = { at: new Date().toISOString(), kind: 'library', surface };
      } else {
        if (live) { await live.inject(step.stimulus); targetObs = await live.observe(); }
        await sb.inject(step.stimulus);
        cloneObs = await sb.observe();
      }
      const diffs = compare(kind, step, targetObs, cloneObs, o);
      replayed++;
      if (diffs.length === 0) identical++; else differences.push(...diffs);
      o.onStep?.(step.seq, diffs.length === 0);
    }
  } finally { await sb.stop(); await live?.stop(); }
  notes.push('Parity is measured over the recorded calls only; behaviour nobody observed is not covered.');
  return { journeys: 1, steps: replayed, identical, differences, parity: replayed ? identical / replayed : 0, notes };
}

async function runStep(make: NonNullable<TwinOptions['makeSandbox']>, launch: LaunchSpec, prefix: Stimulus[], stim: Stimulus | undefined, signal?: AbortSignal): Promise<Observation> {
  const sb = make(launch.kind);
  try {
    await sb.start(launch, signal);
    for (const s of prefix) await sb.inject(s);
    if (stim) await sb.inject(stim);
    return await sb.observe();
  } catch (e) {
    return { at: new Date().toISOString(), kind: launch.kind, error: e instanceof Error ? e.message : String(e) };
  } finally { await sb.stop(); }
}

function compare(kind: LaunchSpec['kind'], step: Step, t: Observation, c: Observation, o: TwinOptions): Difference[] {
  const out: Difference[] = [];
  const d = (field: string, target: unknown, clone: unknown): void => { out.push({ step: step.seq, stimulus: step.stimulus, field, target, clone }); };
  const eq = (field: string, a: unknown, b: unknown): void => { if (JSON.stringify(a) !== JSON.stringify(b)) d(field, a, b); };
  const sc = (s?: string): string => scrub(s, o.scrub);
  if (c.error && !t.error) d('error', t.error ?? null, c.error);
  if (kind === 'cli') {
    eq('exitCode', t.exitCode ?? null, c.exitCode ?? null);
    eq('stdout', sc(t.stdout), sc(c.stdout));
    eq('stderr', sc(t.stderr), sc(c.stderr));
    if (t.screen && c.screen) eq('screen', t.screen.map(sc), c.screen.map(sc)); // only when the recording has a screen to compare
  } else if (kind === 'library') {
    if (t.surface || c.surface) {
      const sig = (x?: import('./types.js').LibExportInfo[]): string[] => (x ?? []).map(e => `${e.name}:${e.kind}:${e.arity ?? ''}`).sort();
      eq('exports', sig(t.surface), sig(c.surface));
    } else {
      const a = t.call, b = c.call;
      eq('ok', a?.ok, b?.ok);
      if (a?.ok && b?.ok) { eq('kind', a.kind, b.kind); eq('async', !!a.async, !!b.async); eq('value', sc(JSON.stringify(a.value)), sc(JSON.stringify(b.value))); }
      else if (a && b && !a.ok && !b.ok) { eq('error', a.error?.name, b.error?.name); eq('message', sc(a.error?.message), sc(b.error?.message)); }
      eq('output', sc(a?.output), sc(b?.output));
    }
  } else if (kind === 'daemon') {
    const a = t.daemon, b = c.daemon;
    eq('alive', a?.alive, b?.alive);
    if (a && b && !a.alive && !b.alive) eq('exitCode', a.exitCode ?? null, b.exitCode ?? null);
    eq('reply', sc(a?.reply), sc(b?.reply));
    eq('closed', !!a?.closed, !!b?.closed);
    eq('connectError', !!a?.connectError, !!b?.connectError);
    eq('stdout', sc(a?.newStdout), sc(b?.newStdout));
    eq('stderr', sc(a?.newStderr), sc(b?.newStderr));
    eq('files', (a?.fsChanges ?? []).map(x => `${x.kind} ${x.path}`).sort(), (b?.fsChanges ?? []).map(x => `${x.kind} ${x.path}`).sort());
  } else if (kind === 'api') {
    eq('status', t.response?.status, c.response?.status);
    eq('contentType', t.response?.contentType, c.response?.contentType);
    eq('body', normBody(t.response), normBody(c.response, o.scrub));
    if (t.response && !c.response) { /* already reported through status */ }
  } else { // web and desktop
    eq('path', pathOf(t.url), pathOf(c.url));
    eq('title', sc(t.title), sc(c.title));
    eq('text', sc(t.text), sc(c.text));
    eq('controls', ctl(t), ctl(c));
    eq('effects', effects(t), effects(c));
    if (t.style && c.style) eq('colors', t.style.colors, c.style.colors);
    if (t.frame && c.frame) {
      const p = comparePng(t.frame, c.frame);
      if (!p.comparable) d('frame', p.reason ?? 'not comparable', 'not comparable');
      else if (p.ssim < (o.ssimMin ?? 0.97) || p.changed > (o.changedMax ?? 0.02)) d('frame', { ssim: round(p.ssim), changed: round(p.changed) }, `below ssim ${o.ssimMin ?? 0.97} or above changed ${o.changedMax ?? 0.02}`);
    }
  }
  return out;
}

const round = (n: number): number => Math.round(n * 1000) / 1000;
const pathOf = (u?: string): string => { try { return u ? new URL(u).pathname : ''; } catch { return u ?? ''; } };
const ctl = (o: Observation): string[] => [...new Set((o.controls ?? []).map(c => `${c.role}|${c.name}`))].sort();
const effects = (o: Observation): string[] => (o.network ?? []).filter(n => n.method !== 'GET' || /\/api\/|\.json/.test(n.url)).map(n => `${n.method} ${pathOf(n.url)} ${n.status}`).sort();

function normBody(r: Observation['response'], extra: RegExp[] = []): unknown {
  if (!r) return null;
  if (/json/.test(r.contentType ?? '')) { try { return JSON.parse(scrub(r.body, extra)); } catch { /* fall through to text */ } }
  return scrub(r.body, extra);
}

/** A one-screen summary a person (or the agent) reads first. */
export function renderTwinReport(r: TwinReport): string {
  const lines = [`Parity ${(r.parity * 100).toFixed(1)}% — ${r.identical} of ${r.steps} replayed steps identical, ${r.differences.length} difference(s).`];
  const byField = new Map<string, number>();
  for (const x of r.differences) byField.set(x.field, (byField.get(x.field) ?? 0) + 1);
  if (byField.size) lines.push('Where: ' + [...byField].map(([k, v]) => `${k} ×${v}`).join(', '));
  for (const x of r.differences.slice(0, 12)) lines.push(`- step ${x.step} (${x.stimulus.type}) ${x.field}: target ${short(x.target)} | clone ${short(x.clone)}`);
  if (r.differences.length > 12) lines.push(`… and ${r.differences.length - 12} more`);
  lines.push(...r.notes);
  return lines.join('\n');
}
const short = (v: unknown): string => { const s = typeof v === 'string' ? v : JSON.stringify(v); return (s ?? 'undefined').length > 90 ? (s ?? '').slice(0, 90) + '…' : String(s); };
