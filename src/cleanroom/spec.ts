/**
 * The synthesizer: a recorded journey in, a behavioural spec out.
 *
 * This is the firewall's gate. What leaves here is *described behaviour*: the
 * state graph (State + Event -> State + SideEffect), the routes, the CLI
 * contract with its observed cases, the API operations with inferred schemas,
 * and the measured look of the pages as numbers. What does not leave: raw
 * frames, full HTML, the target's stylesheets and scripts, and response bodies
 * beyond one short example per status. The implementer works from this and
 * from nothing else (implementer.ts), which is what makes the clone derived
 * rather than copied.
 *
 * Honest limits, written into `unknowns` so a clone is never trusted blindly:
 * coverage is whatever the explorer reached; logged-in areas, server-side
 * state and anything random or time-dependent are only as known as they were
 * seen. Everything here is inference from samples; the twin-test is what
 * confirms it.
 *
 * Pure and deterministic: the same journey gives the same spec.
 *
 * @module cleanroom/spec
 */

import fs from 'node:fs';
import path from 'node:path';
import type { ApiSpec, CliSpec, Journey, JsonSchema, Spec, SpecState, SpecTransition, Step, WebSpec } from './types.js';
import { parseHelp, type ExplorerState } from './explorer.js';
import { stripAnsi } from './ansi.js';

export function synthesize(journey: Journey, now = new Date().toISOString(), explored?: ExplorerState): Spec {
  const unknowns: string[] = [];
  const spec: Spec = {
    version: 1, id: journey.id, kind: journey.target.kind, createdAt: now,
    coverage: { steps: journey.steps.length, states: 0, transitions: 0, note: '' }, unknowns,
  };
  if (journey.target.kind === 'web') spec.web = webSpec(journey, unknowns);
  else if (journey.target.kind === 'cli') spec.cli = cliSpec(journey, unknowns);
  else spec.api = apiSpec(journey, unknowns);
  const web = spec.web;
  spec.coverage.states = web ? web.states.length : new Set(journey.steps.map(s => s.to)).size;
  spec.coverage.transitions = web ? web.transitions.length : journey.steps.length;
  spec.coverage.note = 'Only behaviour the explorer reached is described. Parity is measured over these journeys, not over the target as a whole.';
  if (explored) {
    const found = explored.discovered.length;
    const triedOfFound = explored.discovered.filter(d => explored.tried.includes(d)).length;
    Object.assign(spec.coverage, {
      discovered: found, tried: explored.tried.length, ratio: found ? Math.round((triedOfFound / found) * 1000) / 1000 : 1,
      pending: explored.pending.slice(0, 50), skipped: explored.skipped.slice(0, 50), stoppedBy: explored.stoppedBy,
    });
    if (explored.pending.length) unknowns.push(`the exploration stopped with ${explored.pending.length} item(s) unvisited (for example: ${explored.pending.slice(0, 3).join('; ')}): resume it to cover them`);
    if (explored.skipped.length) unknowns.push(`${explored.skipped.length} item(s) were skipped on purpose and are not described (for example: ${explored.skipped.slice(0, 2).map(s => s.item.split('|').pop() + ' — ' + s.reason).join('; ')})`);
  }
  if (journey.steps.length === 0) unknowns.push('nothing was recorded: the target did not respond or the budget was zero');
  return spec;
}

// ── web ────────────────────────────────────────────────────────────────────────

function webSpec(j: Journey, unknowns: string[]): WebSpec {
  const states = new Map<string, SpecState>();
  const trans = new Map<string, SpecTransition>();
  const routes = new Map<string, { path: string; title: string; states: Set<string> }>();
  let first: Step | undefined;
  for (const s of j.steps) {
    const o = s.observation;
    first ??= s;
    if (!states.has(s.to)) {
      states.set(s.to, {
        id: s.to, label: o.title || pathOf(o.url) || s.to,
        summary: (o.text ?? '').slice(0, 240),
        controls: [...new Set((o.controls ?? []).map(c => `${c.role}: ${c.name || c.selector}`))].slice(0, 30),
      });
    }
    if (o.url) {
      const p = pathOf(o.url);
      const r = routes.get(p) ?? { path: p, title: o.title ?? '', states: new Set<string>() };
      r.states.add(s.to); routes.set(p, r);
    }
    if (s.from !== 'start') {
      const event = describeEvent(s);
      const effects = (o.network ?? []).filter(n => n.method !== 'GET' || /\/api\/|\.json/.test(n.url)).map(n => `${n.method} ${pathOf(n.url)} -> ${n.status ?? '?'}`);
      const key = `${s.from}|${event}|${s.to}`;
      const t = trans.get(key) ?? { from: s.from, to: s.to, event, sideEffects: [...new Set(effects)], count: 0 };
      t.count++; trans.set(key, t);
    }
    if (o.error) unknowns.push(`step ${s.seq}: ${o.error}`);
  }
  const st = first?.observation.style;
  if (!st) unknowns.push('the look of the pages was not measured');
  unknowns.push('areas behind a login, and server-side state, are only known where the explorer got to them');
  return {
    states: [...states.values()], transitions: [...trans.values()],
    routes: [...routes.values()].map(r => ({ path: r.path, title: r.title, states: [...r.states] })),
    ...(st ? { tokens: { colors: st.colors, fonts: st.fonts, fontSizes: st.fontSizes, radii: st.radii, spacing: st.spacing }, layout: st.layout, viewport: st.viewport } : {}),
  };
}

function describeEvent(s: Step): string {
  const st = s.stimulus;
  if (st.type === 'click') return `click ${st.selector}`;
  if (st.type === 'fill') return `fill ${st.selector} with ${/pass/i.test(st.selector) ? '<password>' : JSON.stringify(st.value)}`;
  if (st.type === 'navigate') return `navigate ${st.url}`;
  if (st.type === 'press') return `press ${st.key}`;
  return st.type;
}

function pathOf(url?: string): string { if (!url) return ''; try { const u = new URL(url); return u.pathname + u.search; } catch { return url; } }

// ── cli ────────────────────────────────────────────────────────────────────────

function cliSpec(j: Journey, unknowns: string[]): CliSpec {
  const t = j.target as Extract<Journey['target'], { kind: 'cli' }>;
  const cases: CliSpec['cases'] = [];
  const commands = new Map<string, CliSpec['commands'][number]>();
  for (const s of j.steps) {
    if (s.stimulus.type !== 'run') continue;
    const o = s.observation;
    const args = s.stimulus.args;
    cases.push({ args, ...(s.stimulus.stdin !== undefined ? { stdin: s.stimulus.stdin } : {}), stdout: o.stdout ?? '', stderr: o.stderr ?? '', exitCode: o.exitCode ?? null });
    const isHelp = args[args.length - 1] === '--help' || (args.length === 0 && /usage/i.test(o.stdout ?? ''));
    if (isHelp) {
      const prefix = args[args.length - 1] === '--help' ? args.slice(0, -1) : [];
      const text = stripAnsi(o.stdout || o.stderr || '');
      const { flags } = parseHelp(text);
      const usage = text.split(/\r?\n/).find(l => /usage/i.test(l)) ?? '';
      const summary = text.split(/\r?\n/).find(l => l.trim() && !/usage/i.test(l)) ?? '';
      commands.set(prefix.join(' '), { path: prefix, usage: usage.trim(), summary: summary.trim(), flags });
    }
  }
  if (!commands.size) unknowns.push('no help text was found, so the command and flag list is incomplete');
  const ptyRun = j.steps.some(s => s.observation.terminal?.tty);
  const needsTty = j.steps.some(s => /not a tty|not a terminal|isatty|requires? a (real )?terminal|raw mode/i.test(s.observation.stderr ?? '') );
  if (!ptyRun) unknowns.push(needsTty ? 'the program reported it needs a terminal, but it was only observed through pipes: observe it again with --pty' : 'interactive behaviour (prompts, a terminal UI) was only observed through pipes, not a real terminal');
  if (j.platform === 'win32' || j.steps.some(s => s.observation.terminal?.platform === 'win32')) unknowns.push('recorded on Windows: SIGTERM and SIGHUP handlers cannot be observed there (the process is ended outright); only Ctrl-C reaches a handler, and only on a pseudo-terminal');
  if (ptyRun && j.platform === 'win32') unknowns.push('recorded on a Windows pseudo-terminal: end-of-input (Ctrl-D/Ctrl-Z) cannot be delivered to the program');
  return { name: t.name ?? path.basename(t.command), commands: [...commands.values()], cases };
}

// ── api ────────────────────────────────────────────────────────────────────────

/** `/users/42` and `/users/7` are one operation: numeric and UUID segments become {id}. */
export function templatePath(p: string): string {
  const [pathname] = p.split('?');
  return pathname!.split('/').map(seg => (/^\d+$/.test(seg) || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(seg) ? '{id}' : seg)).join('/');
}

export function inferSchema(v: unknown): JsonSchema {
  if (v === null) return { nullable: true };
  if (Array.isArray(v)) return { type: 'array', items: v.length ? v.map(inferSchema).reduce(mergeSchema) : {} };
  if (typeof v === 'object') {
    const props: Record<string, JsonSchema> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) props[k] = inferSchema(x);
    return { type: 'object', properties: props, required: Object.keys(props) };
  }
  if (typeof v === 'string') return { type: 'string', ...(/^\d{4}-\d{2}-\d{2}T/.test(v) ? { format: 'date-time' } : /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(v) ? { format: 'uuid' } : {}) };
  if (typeof v === 'number') return { type: Number.isInteger(v) ? 'integer' : 'number' };
  return { type: typeof v };
}

export function mergeSchema(a: JsonSchema, b: JsonSchema): JsonSchema {
  if (a.nullable && !b.type) return { ...b, nullable: true };
  if (b.nullable && !a.type) return { ...a, nullable: true };
  const ta = a.type, tb = b.type;
  if (ta === 'object' && tb === 'object') {
    const props: Record<string, JsonSchema> = { ...(a.properties ?? {}) };
    for (const [k, v] of Object.entries(b.properties ?? {})) props[k] = props[k] ? mergeSchema(props[k]!, v) : v;
    const required = (a.required ?? []).filter(k => (b.required ?? []).includes(k)); // required = present in every sample
    return { type: 'object', properties: props, required };
  }
  if (ta === 'array' && tb === 'array') return { type: 'array', items: mergeSchema(a.items ?? {}, b.items ?? {}) };
  if (ta === tb) return { ...a, ...(a.format === b.format ? {} : { format: undefined }) };
  if ((ta === 'integer' && tb === 'number') || (ta === 'number' && tb === 'integer')) return { type: 'number' };
  const types = [...new Set([...(Array.isArray(ta) ? ta : ta ? [ta] : []), ...(Array.isArray(tb) ? tb : tb ? [tb] : [])])];
  return { type: types.length === 1 ? types[0]! : types };
}

function apiSpec(j: Journey, unknowns: string[]): ApiSpec {
  const t = j.target as Extract<Journey['target'], { kind: 'api' }>;
  const ops = new Map<string, ApiSpec['operations'][number]>();
  for (const s of j.steps) {
    if (s.stimulus.type !== 'request') continue;
    const res = s.observation.response;
    if (!res) { unknowns.push(`step ${s.seq}: ${s.observation.error ?? 'no response'}`); continue; }
    const p = templatePath(s.stimulus.path);
    const key = `${s.stimulus.method} ${p}`;
    const op = ops.get(key) ?? { method: s.stimulus.method, path: p, responses: [] };
    if (s.stimulus.body !== undefined && typeof s.stimulus.body === 'object') op.requestSchema = op.requestSchema ? mergeSchema(op.requestSchema, inferSchema(s.stimulus.body)) : inferSchema(s.stimulus.body);
    let r = op.responses.find(x => x.status === res.status && x.contentType === res.contentType);
    let parsed: unknown, isJson = false;
    if (/json/.test(res.contentType ?? '')) { try { parsed = JSON.parse(res.body); isJson = true; } catch { /* declared JSON, was not */ } }
    if (!r) {
      r = { status: res.status, ...(res.contentType ? { contentType: res.contentType } : {}) };
      if (isJson) { r.schema = inferSchema(parsed); r.example = shrink(parsed); }
      else if (res.body) r.example = res.body.slice(0, 200);
      op.responses.push(r);
    } else if (isJson && r.schema) r.schema = mergeSchema(r.schema, inferSchema(parsed));
    ops.set(key, op);
  }
  unknowns.push('request bodies and authentication were only observed where the seeds supplied them');
  return { baseUrl: t.baseUrl, operations: [...ops.values()].sort((a, b) => (a.path + a.method).localeCompare(b.path + b.method)) };
}

/** One short example: arrays cut to two items, long strings clipped. */
function shrink(v: unknown, depth = 0): unknown {
  if (Array.isArray(v)) return v.slice(0, 2).map(x => shrink(x, depth + 1));
  if (v && typeof v === 'object') return depth > 4 ? '…' : Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, shrink(x, depth + 1)]));
  if (typeof v === 'string') return v.length > 80 ? v.slice(0, 80) + '…' : v;
  return v;
}

// ── writing the spec out ───────────────────────────────────────────────────────

/** `spec.json` (machine) and `SPEC.md` (what an implementer reads first), nothing else. */
export function writeSpec(spec: Spec, dir: string): { json: string; markdown: string } {
  fs.mkdirSync(dir, { recursive: true });
  const json = path.join(dir, 'spec.json');
  const markdown = path.join(dir, 'SPEC.md');
  fs.writeFileSync(json, JSON.stringify(spec, null, 2));
  fs.writeFileSync(markdown, renderMarkdown(spec));
  return { json, markdown };
}

export function renderMarkdown(spec: Spec): string {
  const cv = spec.coverage;
  const L: string[] = [`# Behaviour specification: ${spec.id}`, '', `Kind: ${spec.kind}. ${cv.note}`, `Recorded ${cv.steps} steps, ${cv.states} states, ${cv.transitions} transitions.${cv.ratio !== undefined ? ` The explorer tried ${Math.round(cv.ratio * 100)}% of what it found (${cv.tried} tried, ${cv.discovered} found).` : ''}`, ''];
  if (spec.web) {
    const w = spec.web;
    L.push('## Routes', ...w.routes.map(r => `- \`${r.path}\` — ${r.title || '(untitled)'}`), '');
    L.push('## States', ...w.states.map(s => `### ${s.label} (\`${s.id}\`)\n${s.summary}\n${(s.controls ?? []).map(c => `- ${c}`).join('\n')}\n`));
    L.push('## Transitions (State + Event -> State + SideEffect)', ...w.transitions.map(t => `- \`${t.from}\` + ${t.event} -> \`${t.to}\`${t.sideEffects.length ? ` + ${t.sideEffects.join('; ')}` : ''}`), '');
    if (w.tokens) L.push('## Measured look', '```json', JSON.stringify({ viewport: w.viewport, ...w.tokens, layout: w.layout }, null, 2), '```', '');
  }
  if (spec.cli) {
    const c = spec.cli;
    L.push(`## Command \`${c.name}\``, '');
    for (const cmd of c.commands) L.push(`### \`${[c.name, ...cmd.path].join(' ')}\``, cmd.usage, cmd.summary, ...cmd.flags.map(f => `- \`${f.name}\`${f.takesValue ? ' <value>' : ''} — ${f.description}`), '');
    L.push('## Observed cases', ...c.cases.map(k => `- \`${[c.name, ...k.args].join(' ')}\`${k.stdin !== undefined ? ` (stdin: ${JSON.stringify(k.stdin)})` : ''} -> exit ${k.exitCode}\n  - stdout: ${JSON.stringify(k.stdout.slice(0, 400))}\n  - stderr: ${JSON.stringify(k.stderr.slice(0, 200))}`), '');
  }
  if (spec.api) {
    L.push(`## API ${spec.api.baseUrl}`, '');
    for (const op of spec.api.operations) {
      L.push(`### ${op.method} ${op.path}`);
      if (op.requestSchema) L.push('Request:', '```json', JSON.stringify(op.requestSchema), '```');
      for (const r of op.responses) L.push(`- ${r.status} ${r.contentType ?? ''}${r.schema ? `\n  \`\`\`json\n  ${JSON.stringify(r.schema)}\n  \`\`\`` : ''}${r.example !== undefined ? `\n  example: ${JSON.stringify(r.example)}` : ''}`);
      L.push('');
    }
  }
  L.push('## Unknowns', ...spec.unknowns.map(u => `- ${u}`), '');
  return L.join('\n');
}
