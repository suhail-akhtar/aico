/**
 * Teach AICO — show the built-in browser a task once, and the agent can do it
 * again: recording on the tab in front, the review that turns it into a
 * procedure (a skill with a procedure.json, through the skills' own
 * draft → verify → register flow), and replay in a chat's own tab.
 *
 * RECORDING. While the person demonstrates, the recorder (browser-teach-page.ts)
 * runs in an isolated world of that tab's every document
 * (`Page.addScriptToEvaluateOnNewDocument` with a world name) and reports
 * trusted input through a DevTools binding that exists only in that world
 * (`Runtime.addBinding` with `executionContextName`) — the page can neither
 * see it nor feed it steps. Main turns each report into a step
 * (browser-teach-core.ts), drops anything typed into a secret field, and keeps
 * a small screenshot per step in memory for the review (nothing is written to
 * disk until the person saves; screenshots never leave the review). Input
 * while an agent drives the tab is not the person's and is ignored. Only the
 * tab's own page is recorded — not other windows, not the screen.
 *
 * REPLAY (`browser_run_procedure`). The steps run in the calling chat's own
 * tab through the browser's ordinary agent methods, so every rule that binds
 * the agent binds a procedure too: the purchase/send/delete gate
 * (browser-commit-gate.ts — a procedure waits up to five minutes for the
 * person's Allow instead of twenty seconds), the refusal to type into secret
 * fields, the human-check refusal (a procedure hands over and waits, then
 * retries), Stop / Take over. Each target is found again by its description;
 * a step that cannot be found with confidence is handed back to the model
 * with the step's intent, never clicked on a guess. A run longer than one
 * tool call (27 s) continues in the background and is followed by runId.
 *
 * What it deliberately does not do: record the whole screen, record other
 * apps, store a secret, or let a procedure leave the origin it was taught on.
 *
 * @module desktop/electron/browser-teach
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { WebContents } from 'electron';
import type { DesktopContext } from './context';
import { aicoTeachPage } from './browser-teach-page';
import {
  buildDraftSteps, describeTarget, formatReport, originOfUrl, parseProcedure, prepareProcedure, procedureSkill, relocate, resolveParams,
  sensitiveKind, substitute, summarise, targetPhrase, type RecordedEvent, type Relocated, type StepResult, type StepStatus,
} from './browser-teach-core';
import type {
  DraftStep, Procedure, ProcedureAction, ProcedureSummary, RawTarget, TeachDraft, TeachSaveRequest, TeachState,
} from '../shared/teach-types';

const TEACH_SRC = aicoTeachPage.toString();
/** The in-page teach script as an expression (candidates / value run in the page; record in AICO's own world). */
export const teachPageJs = (op: string, args?: unknown): string => `(${TEACH_SRC})(${JSON.stringify(op)}, ${JSON.stringify(args ?? {})})`;

const WORLD = 'aico-teach';
const BINDING = '__aicoTeachReport';
const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));
const pathOf = (u: string): string => { try { const x = new URL(u); return `${x.origin}${x.pathname}`; } catch { return u; } };

export interface TeachDeps {
  /** The tab in front (the one the person teaches on). */
  front(): { id: string; wc: WebContents } | null;
  cdp<T = unknown>(wc: WebContents, method: string, params?: Record<string, unknown>): Promise<T>;
  /** An agent is driving this tab right now: its input is not the person's. */
  agentDriving(tabId: string): boolean;
}

export interface TeachService {
  list(): ProcedureSummary[];
  /** browser_run_procedure: start (name, params, startAt) or follow (runId) a run; returns within ~20 s. */
  run(args: Record<string, unknown>): Promise<string>;
}

interface Recording {
  id: string;
  tabId: string;
  wc: WebContents;
  startUrl: string;
  origin: string;
  /** The start page's title — the review suggests a name from it. */
  title: string;
  events: RecordedEvent[];
  startShot?: DraftStep['shots'][number];
  pre?: { at: number; shot: Promise<DraftStep['shots'][number] | undefined> };
  scriptId?: string;
  detach: () => void;
}

export function registerTeach(ctx: DesktopContext, deps: TeachDeps): TeachService {
  let rec: Recording | null = null;
  let draft: (TeachDraft & { createdAt: number }) | null = null;
  let lastError: string | undefined;

  const state = (): TeachState => ({
    recording: Boolean(rec), ...(rec ? { tabId: rec.tabId, origin: rec.origin } : draft ? { origin: draft.origin } : {}),
    steps: rec ? rec.events.length + 1 : draft?.steps.length ?? 0,
    ...(rec && rec.events.length ? { last: lastLabel(rec.events[rec.events.length - 1]!) } : {}),
    ...(draft && !rec ? { draft: true } : {}), ...(lastError ? { error: lastError } : {}),
  });
  const push = (): void => ctx.emit('browser:teach:state', state());
  const lastLabel = (e: RecordedEvent): string => {
    const t = e.target ? targetPhrase(describeTarget(e.target)) : '';
    return e.kind === 'navigate' ? `Opened ${e.url.slice(0, 80)}` : e.kind === 'type' ? `Typed into ${t}` : e.kind === 'select' ? `Chose in ${t}` : e.kind === 'press' ? `Pressed ${e.key}` : e.kind === 'upload' ? `File for ${t}` : `Clicked ${t}`;
  };

  /** A small JPEG of the tab for the review, with where the element was. Best effort: a failed capture is a step without a picture. */
  const capture = async (wc: WebContents, rect?: { x: number; y: number; w: number; h: number }): Promise<DraftStep['shots'][number] | undefined> => {
    try {
      if (wc.isDestroyed()) return undefined;
      const img = await Promise.race([wc.capturePage(), sleep(3000).then(() => null)]);
      if (!img || img.isEmpty()) return undefined;
      const { width, height } = img.getSize();
      const small = width > 720 ? img.resize({ width: 720 }) : img;
      return { src: `data:image/jpeg;base64,${small.toJPEG(62).toString('base64')}`, ...(rect ? { rect } : {}), vw: width, vh: height };
    } catch { return undefined; }
  };

  // ── Recording ──
  async function start(): Promise<TeachState> {
    if (rec) return state();
    const f = deps.front();
    if (!f || f.wc.isDestroyed()) throw new Error('Open the page where the task starts, then press Teach.');
    const url = f.wc.getURL();
    const origin = originOfUrl(url);
    if (!origin) throw new Error('Teach works on web pages (http or https). Open the page where the task starts first.');
    if (deps.agentDriving(f.id)) throw new Error('An agent is using this tab right now. Wait for it to finish, or use another tab.');
    const wc = f.wc;
    const r: Recording = { id: crypto.randomUUID(), tabId: f.id, wc, startUrl: url, origin, title: wc.getTitle(), events: [], detach: () => {} };
    const onMessage = (_e: unknown, method: string, params: Record<string, unknown>): void => {
      if (method !== 'Runtime.bindingCalled' || params.name !== BINDING || rec !== r) return;
      const payload = String(params.payload ?? '');
      if (payload.length > 60_000 || deps.agentDriving(r.tabId)) return;
      let ev: Record<string, unknown>;
      try { ev = JSON.parse(payload) as Record<string, unknown>; } catch { return; }
      void onEvent(r, ev);
    };
    const onNav = (_e: unknown, navUrl: string, ...rest: unknown[]): void => {
      if (rec !== r) return;
      // did-navigate-in-page passes isMainFrame; did-navigate passes the status code.
      if (typeof rest[0] === 'boolean' && !rest[0]) return;
      const last = r.events[r.events.length - 1];
      // The outcome of the person's own click / Enter / choice is that action's expectation, not a step.
      if (last && last.kind !== 'navigate' && Date.now() - last.at < 3000) return;
      if (!last && navUrl === r.startUrl) return;
      if (last?.kind === 'navigate' && last.url === navUrl) return;
      if (deps.agentDriving(r.tabId)) return;
      r.events.push({ kind: 'navigate', at: Date.now(), url: navUrl });
      void capture(wc).then((s) => { const e = r.events.find(x => x.kind === 'navigate' && x.url === navUrl && !x.shot); if (e && s) e.shot = s; });
      push();
    };
    const onGone = (): void => { if (rec === r) void stop().catch(() => {}); };
    wc.debugger.on('message', onMessage as never);
    wc.on('did-navigate', onNav as never);
    wc.on('did-navigate-in-page', onNav as never);
    wc.once('destroyed', onGone);
    r.detach = () => {
      wc.debugger.removeListener('message', onMessage as never);
      wc.removeListener('did-navigate', onNav as never);
      wc.removeListener('did-navigate-in-page', onNav as never);
      wc.removeListener('destroyed', onGone);
    };
    try {
      await deps.cdp(wc, 'Runtime.enable');
      await deps.cdp(wc, 'Runtime.addBinding', { name: BINDING, executionContextName: WORLD });
      const src = teachPageJs('record', { binding: BINDING });
      const added = await deps.cdp<{ identifier: string }>(wc, 'Page.addScriptToEvaluateOnNewDocument', { source: src, worldName: WORLD });
      r.scriptId = added.identifier;
      const tree = await deps.cdp<{ frameTree: { frame: { id: string } } }>(wc, 'Page.getFrameTree');
      const world = await deps.cdp<{ executionContextId: number }>(wc, 'Page.createIsolatedWorld', { frameId: tree.frameTree.frame.id, worldName: WORLD });
      await deps.cdp(wc, 'Runtime.evaluate', { expression: src, contextId: world.executionContextId });
    } catch (err) {
      r.detach();
      throw new Error(`Could not start recording on this page: ${(err as Error).message}`);
    }
    rec = r;
    draft = null;
    lastError = undefined;
    r.startShot = await capture(wc);
    push();
    return state();
  }

  async function onEvent(r: Recording, ev: Record<string, unknown>): Promise<void> {
    const kind = String(ev.kind ?? '');
    const rect = ev.rect as { x: number; y: number; w: number; h: number } | undefined;
    // The element's box is in CSS pixels of the page's viewport; the picture is in device pixels.
    const view = Number(ev.vw) > 0 && Number(ev.vh) > 0 ? { vw: Number(ev.vw), vh: Number(ev.vh) } : {};
    if (kind === 'pre') { r.pre = { at: Date.now(), shot: capture(r.wc, rect).then(s => (s ? { ...s, ...view } : s)) }; return; }
    if (!['click', 'type', 'select', 'press', 'upload'].includes(kind)) return;
    const target = (ev.target && typeof ev.target === 'object' ? ev.target : undefined) as RawTarget | undefined;
    const e: RecordedEvent = { kind: kind as RecordedEvent['kind'], at: Date.now(), url: typeof ev.url === 'string' && ev.url ? ev.url : r.wc.getURL(), ...(target ? { target } : {}) };
    // A secret field's value is never kept, whatever the page sent.
    const secret = Boolean(ev.secret) || (target ? sensitiveKind(target) !== null : false);
    if ((kind === 'type' || kind === 'select') && !secret && typeof ev.value === 'string') e.value = ev.value.slice(0, 2000);
    if (kind === 'select' && !secret && typeof ev.optionText === 'string') e.optionText = ev.optionText.slice(0, 200);
    if (kind === 'press') e.key = typeof ev.key === 'string' ? ev.key.slice(0, 20) : 'Enter';
    if (kind === 'upload') e.files = Number(ev.files) || 0;
    if (target && typeof target.checked === 'boolean') e.checked = target.checked;
    r.events.push(e);
    push();
    // The picture: taken as the pointer went down (before the page changed), else now.
    const pre = r.pre && Date.now() - r.pre.at < 2500 && kind === 'click' ? r.pre : null;
    r.pre = undefined;
    const shot = pre ? await pre.shot : await capture(r.wc, rect);
    if (shot) e.shot = { ...shot, ...(rect ? { rect, ...view } : {}) };
  }

  async function stop(): Promise<TeachDraft | null> {
    const r = rec;
    if (!r) return draft;
    rec = null;
    r.detach();
    if (!r.wc.isDestroyed()) {
      await deps.cdp(r.wc, 'Runtime.removeBinding', { name: BINDING }).catch(() => {});
      if (r.scriptId) await deps.cdp(r.wc, 'Page.removeScriptToEvaluateOnNewDocument', { identifier: r.scriptId }).catch(() => {});
      await deps.cdp(r.wc, 'Runtime.disable').catch(() => {});
    }
    await sleep(150);
    const finalUrl = r.wc.isDestroyed() ? undefined : r.wc.getURL();
    const built = buildDraftSteps(r.events, { url: r.startUrl, ...(r.startShot ? { shot: r.startShot } : {}) }, finalUrl);
    draft = { id: r.id, origin: r.origin, startUrl: r.startUrl, title: r.title, steps: built.steps, notes: built.notes, createdAt: Date.now() };
    push();
    return draft;
  }

  function discard(): TeachState {
    if (rec) { const r = rec; rec = null; r.detach(); }
    draft = null;
    push();
    return state();
  }

  // ── Saving: draft → verify → register, through the engine's own skills manager ──
  async function save(req: TeachSaveRequest): Promise<{ ok: boolean; message: string; name?: string }> {
    if (!draft || draft.id !== req.draftId) return { ok: false, message: 'This recording is no longer open — record it again.' };
    const { procedure, errors } = prepareProcedure(req, draft);
    if (!procedure) return { ok: false, message: errors.join('\n') };
    const sk = procedureSkill(procedure);
    const manage = async (body: Record<string, unknown>): Promise<{ ok?: boolean; result?: string; error?: string }> =>
      ctx.engine.request('manage', { registry: 'skills', ...body }) as Promise<{ ok?: boolean; result?: string; error?: string }>;
    const created = await manage({ action: 'create', name: sk.name, description: sk.description, prompt: sk.body, resources: [{ path: 'procedure.json', content: sk.json }] });
    const createdText = created.result ?? created.error ?? '';
    if (!created.ok || /Checks fail/.test(createdText)) return { ok: false, message: `The skill draft did not pass its checks:\n${createdText}` };
    const reg = await manage({ action: 'register', name: sk.name, ...(req.overwrite ? { overwrite: true } : {}) });
    const regText = reg.result ?? reg.error ?? '';
    if (!reg.ok || !/^Registered/.test(regText)) {
      return { ok: false, message: `Saved as a draft, but not registered:\n${regText}${/exist/i.test(regText) ? '\nTick “Replace the existing procedure” to overwrite it.' : ''}` };
    }
    draft = null;
    push();
    return { ok: true, message: regText, name: sk.name };
  }

  // ── The procedures that exist: registered skills with a procedure.json ──
  const skillsDir = (): string => path.join(ctx.paths.aicoHome, 'skills');
  const disabled = (): Set<string> => {
    try {
      const s = JSON.parse(fs.readFileSync(path.join(ctx.paths.aicoHome, 'registry-state.json'), 'utf8')) as { skills?: { disabled?: string[] } };
      return new Set((s.skills?.disabled ?? []).map(n => n.toLowerCase()));
    } catch { return new Set(); }
  };
  /** An imported skill nobody reviewed is not run (src/skills/provenance.ts records that). */
  const unreviewed = (dir: string): boolean => {
    try { return (JSON.parse(fs.readFileSync(path.join(dir, '.aico-meta.json'), 'utf8')) as { trust?: string }).trust === 'unreviewed'; } catch { return false; }
  };
  function readProcedure(name: string): Procedure | { error: string } {
    const safe = name.trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(safe)) return { error: `"${name}" is not a procedure name. Call browser_procedures to list them.` };
    const dir = path.join(skillsDir(), safe);
    let text: string;
    try { text = fs.readFileSync(path.join(dir, 'procedure.json'), 'utf8'); } catch { return { error: `There is no taught procedure called "${name}". Call browser_procedures to list them.` }; }
    if (disabled().has(safe)) return { error: `The procedure "${name}" is switched off (Settings → Skills).` };
    if (unreviewed(dir)) return { error: `The procedure "${name}" was imported and has not been reviewed — the user must review it in Settings → Skills first.` };
    return parseProcedure(text) ?? { error: `The procedure "${name}" has a procedure.json AICO cannot read.` };
  }
  function list(): ProcedureSummary[] {
    let names: string[] = [];
    try { names = fs.readdirSync(skillsDir(), { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name); } catch { return []; }
    const off = disabled();
    const out: ProcedureSummary[] = [];
    for (const n of names) {
      if (off.has(n.toLowerCase())) continue;
      const p = readProcedure(n);
      if ('kind' in p) out.push(summarise(p));
    }
    return out;
  }

  // ── Replay ──
  interface Job {
    id: string; name: string; origin: string; status: 'running' | 'done' | 'stopped' | 'needs_judgement' | 'waiting_for_user' | 'failed' | 'refused';
    steps: StepResult[]; total: number; current?: string; note?: string; finished: Promise<void>; at: number;
  }
  const jobs = new Map<string, Job>();

  class StepStop extends Error { constructor(public status: StepStatus, message: string) { super(message); } }

  async function runTool(args: Record<string, unknown>): Promise<string> {
    const svc = ctx.services.browser;
    if (!svc) throw new Error('The built-in browser is not available.');
    const report = (j: Job): string => {
      const running = j.status === 'running' || j.status === 'waiting_for_user';
      return formatReport({
        name: j.name, origin: j.origin, status: j.status, steps: j.steps, total: j.total,
        note: running
          ? `Still running${j.current ? ` — now: ${j.current}` : ''}${j.status === 'waiting_for_user' ? ' (waiting for the user in AICO)' : ' (if this step buys, sends or deletes, AICO is waiting for the user to allow it)'}. Call browser_run_procedure with runId "${j.id}" to follow it.`
          : j.note,
      });
    };
    if (typeof args.runId === 'string' && args.runId) {
      const j = jobs.get(args.runId);
      if (!j) return `No run "${args.runId}" (runs are kept until the app restarts).`;
      await Promise.race([j.finished, sleep(20_000)]);
      return report(j);
    }
    const name = String(args.name ?? '').trim();
    if (!name) return 'Give the procedure name (browser_procedures lists them).';
    const p = readProcedure(name);
    if (!('kind' in p)) return p.error;
    const { values, missing, unknown } = resolveParams(p, (args.params && typeof args.params === 'object' ? args.params : {}) as Record<string, unknown>);
    if (missing.length) {
      return `Not started: "${p.name}" needs ${missing.map(m => `${m} (${p.params.find(x => x.name === m)?.label ?? m})`).join(', ')}. Ask the user for ${missing.length === 1 ? 'it' : 'them'}, then call again with params.`;
    }
    const startAt = Math.min(p.steps.length, Math.max(1, Math.floor(Number(args.startAt) || 1)));
    // A procedure the person taught may reach a purchase or a send: their Allow can take longer than one tool call.
    svc.setApprovalWait(5 * 60_000);
    const job: Job = { id: `run-${crypto.randomBytes(4).toString('hex')}`, name: p.name, origin: p.origin, status: 'running', steps: [], total: p.steps.length, finished: Promise.resolve(), at: Date.now() };
    if (unknown.length) job.note = `Ignored unknown parameter(s): ${unknown.join(', ')}.`;
    job.finished = execute(job, p, values, startAt).catch((err: Error) => { job.status = 'failed'; job.note = err.message; });
    jobs.set(job.id, job);
    for (const [k, j] of jobs) if (Date.now() - j.at > 6 * 3600_000) jobs.delete(k);
    await Promise.race([job.finished, sleep(20_000)]);
    return report(job);
  }

  async function execute(job: Job, p: Procedure, values: Record<string, string>, startAt: number): Promise<void> {
    for (let i = startAt - 1; i < p.steps.length; i++) {
      const step = p.steps[i]!;
      job.current = `step ${i + 1}: ${step.title}`;
      const res: StepResult = { index: i + 1, title: step.title, status: 'ok', detail: '', verified: true };
      const details: string[] = [];
      try {
        for (const a of step.actions) {
          const r = await runAction(job, p, a, values, step.intent, i);
          details.push(r.detail);
          if (!r.verified) res.verified = false;
        }
        res.detail = details.join('; ');
        job.steps.push(res);
      } catch (err) {
        const msg = (err as Error).message;
        const status: StepStatus = err instanceof StepStop ? err.status
          : /taken control|Take over/i.test(msg) ? 'stopped'
            : /^Refused/.test(msg) ? 'refused' : 'failed';
        job.steps.push({ ...res, status, detail: msg.slice(0, 900), verified: false });
        job.status = status === 'needs_judgement' ? 'needs_judgement' : status === 'stopped' ? 'stopped' : status === 'refused' ? 'refused' : 'failed';
        job.note = status === 'needs_judgement'
          ? `Do step ${i + 1} yourself in your tab (browser_snapshot, then act — intent: ${step.intent}), then call browser_run_procedure with name "${p.name}", the same params and startAt ${i + 2}.`
          : status === 'stopped' ? 'The user took over the tab. Ask them before continuing.'
            : `Stopped at step ${i + 1}. Tell the user what happened; after it is sorted out, run again with startAt ${i + 1}.`;
        job.current = undefined;
        return;
      }
    }
    job.status = 'done';
    job.current = undefined;
    job.note = `All ${p.steps.length - startAt + 1} step(s) ran.`;
  }

  /** Find a step's element on the page now, waiting for it to appear (auto-wait); not sure → the model's judgement. */
  async function find(p: Procedure, a: ProcedureAction, intent: string, index: number): Promise<Relocated & { ref: string; url: string }> {
    const svc = ctx.services.browser!;
    const want = a.target;
    if (!want) throw new StepStop('failed', 'This step has no recorded element.');
    const origin = a.origin || p.origin;
    const deadline = Date.now() + 8000;
    let last: Relocated | null = null;
    let url = '';
    for (;;) {
      const page = await svc.procedurePage<{ url: string; cands: RawTarget[] }>('candidates').catch((err: Error) => { if (/taken control|Human check/i.test(err.message)) throw err; return null; });
      if (page) {
        url = page.url;
        if (originOfUrl(url) === origin) {
          last = relocate(want, page.cands);
          if (last.confidence === 'high' && last.ref) return { ...last, ref: last.ref, url };
        }
      }
      if (Date.now() > deadline) break;
      await sleep(500);
    }
    if (originOfUrl(url) !== origin) throw new StepStop('failed', `The page is ${url || 'not loaded'}, not ${origin} where this procedure was taught — nothing was done there.`);
    const guess = last?.best ? ` Best guess: [${last.best.ref}] ${last.best.role} “${last.best.name}” (score ${last.best.score}${last.runnerUp ? `; next “${last.runnerUp.name}” ${last.runnerUp.score}` : ''}).` : '';
    throw new StepStop('needs_judgement', `Could not find ${targetPhrase(want)} (${want.role}) with confidence — ${last?.reason ?? 'the page has no matching elements'}.${guess} Step intent: ${intent} (step ${index + 1}).`);
  }

  /** A human check (CAPTCHA) on the way: the person does it, then the action is tried once more. */
  async function humanly<T>(job: Job, fn: () => Promise<T>): Promise<T> {
    try { return await fn(); } catch (err) {
      if (!/^Human check detected/i.test((err as Error).message)) throw err;
      const svc = ctx.services.browser!;
      job.status = 'waiting_for_user';
      const answer = await svc.handoff('This page shows a “verify you are human” check. Please complete it, then press Done — AICO will continue the procedure.');
      job.status = 'running';
      if (/did not respond/i.test(answer)) throw new StepStop('needs_user', 'The human check was not completed.');
      return fn();
    }
  }

  async function urlReached(want: string, ms = 10_000): Promise<{ ok: boolean; url: string }> {
    const svc = ctx.services.browser!;
    const deadline = Date.now() + ms;
    let url = '';
    for (;;) {
      const v = await svc.procedurePage<{ url: string }>('url').catch(() => null);
      url = v?.url ?? url;
      if (url && pathOf(url) === want) return { ok: true, url };
      if (Date.now() > deadline) return { ok: false, url };
      await sleep(400);
    }
  }

  async function runAction(job: Job, p: Procedure, a: ProcedureAction, values: Record<string, string>, intent: string, index: number): Promise<{ detail: string; verified: boolean }> {
    const svc = ctx.services.browser!;
    const sub = (s: string | undefined): string => substitute(s ?? '', values);
    switch (a.kind) {
      case 'navigate': {
        const url = sub(a.url);
        if (originOfUrl(url) !== p.origin) throw new StepStop('refused', `Refused: ${url} is outside ${p.origin}, where this procedure was taught.`);
        const r = await svc.open(url) as unknown as { url?: string; humanCheck?: string; error?: string };
        if (r.error) throw new StepStop('failed', r.error);
        if (r.humanCheck) await humanly(job, () => Promise.reject(new Error('Human check detected')));
        const now = r.url ?? url;
        return { detail: `at ${now}`, verified: pathOf(now) === pathOf(url) };
      }
      case 'click': {
        const at = await find(p, a, intent, index);
        const out = await humanly(job, () => svc.click({ ref: at.ref }));
        if (/ is disabled — /.test(out)) throw new StepStop('failed', out);
        if (/file-upload control/.test(out)) throw new StepStop('failed', out);
        let verified = true; let extra = '';
        if (typeof a.expect?.checked === 'boolean') {
          const v = await svc.procedurePage<{ checked?: boolean }>('value', { ref: at.ref }).catch(() => null);
          verified = v?.checked === a.expect.checked;
          extra = verified ? '' : ` (expected it ${a.expect.checked ? 'ticked' : 'unticked'})`;
        } else if (a.expect?.url) {
          const u = await urlReached(a.expect.url);
          if (!u.ok) throw new StepStop('failed', `${out.split('\n')[0]} — but the page did not move on to ${a.expect.url} (now ${u.url}). It may show a validation message: take a snapshot.`);
          extra = ` → ${u.url}`;
        }
        return { detail: `${out.split('\n')[0]}${extra} [matched: ${at.reason.slice(0, 120)}]`, verified };
      }
      case 'type': {
        const at = await find(p, a, intent, index);
        const value = sub(a.value);
        const out = await humanly(job, () => svc.type({ ref: at.ref }, value, { clear: true }));
        const v = await svc.procedurePage<{ value?: string }>('value', { ref: at.ref }).catch(() => null);
        const verified = v?.value !== undefined && v.value.trim() === value.trim();
        return { detail: `${out.split('\n')[0]}${verified ? '' : ' (the field does not show the value afterwards)'}`, verified };
      }
      case 'select': {
        const at = await find(p, a, intent, index);
        const value = sub(a.value);
        let out = await humanly(job, () => svc.select({ ref: at.ref }, value)).catch(async (err: Error) => {
          if (!a.optionText) throw err;
          return svc.select({ ref: at.ref }, a.optionText);
        });
        const v = await svc.procedurePage<{ value?: string; selectedText?: string }>('value', { ref: at.ref }).catch(() => null);
        const verified = Boolean(v && (v.value === value || (a.optionText && v.selectedText === a.optionText)));
        out = out.split('\n')[0]!;
        return { detail: out, verified };
      }
      case 'press': {
        const out = await humanly(job, () => svc.press(a.key || 'Enter'));
        if (a.expect?.url) {
          const u = await urlReached(a.expect.url);
          if (!u.ok) throw new StepStop('failed', `Pressed ${a.key} — but the page did not move on to ${a.expect.url} (now ${u.url}).`);
          return { detail: `${out.split('\n')[0]} → ${u.url}`, verified: true };
        }
        return { detail: out.split('\n')[0]!, verified: true };
      }
      case 'upload': {
        const at = await find(p, a, intent, index);
        const files = sub(a.value).split(/\r?\n|;/).map(s => s.trim()).filter(Boolean);
        if (!files.length) throw new StepStop('needs_user', 'No file path was given for this upload.');
        job.status = 'waiting_for_user';
        let out = await svc.upload({ ref: at.ref }, files);
        for (let k = 0; k < 12 && /browser_upload_wait/.test(out); k++) {
          const id = /uploadId "([^"]+)"/.exec(out)?.[1];
          if (!id) break;
          out = await svc.uploadWait(id, 25);
        }
        job.status = 'running';
        if (/declined/i.test(out)) throw new StepStop('needs_user', out);
        if (!/Attached/.test(out)) throw new StepStop('needs_user', out);
        return { detail: out.split('\n')[0]!, verified: true };
      }
      case 'secret': {
        // The field must be there (and on the right origin) before anyone is asked to fill it.
        await find(p, a, intent, index);
        const credential = a.secret?.kind === 'password' && a.secret.param ? values[a.secret.param] : undefined;
        if (credential) {
          const out = await svc.login({ name: credential, submit: false });
          if (/^(fields filled|signed in)/.test(out)) return { detail: `filled from the stored credential “${credential}” (the value never passed through AICO's agent)`, verified: true };
          if (/not approved this sign-in yet/.test(out)) throw new StepStop('needs_user', out);
          // Otherwise fall through to the person.
        }
        job.status = 'waiting_for_user';
        const what = a.secret?.kind === 'password' ? 'password' : a.secret?.kind === 'otp' ? 'one-time code' : 'card details';
        const answer = await svc.handoff(`Please enter your ${what} in ${targetPhrase(a.target)} and press Done. AICO never records or types it — the procedure continues after you.`);
        job.status = 'running';
        if (/did not respond/i.test(answer)) throw new StepStop('needs_user', `The user did not enter the ${what}.`);
        return { detail: `the user entered the ${what}`, verified: false };
      }
      case 'wait': {
        const out = a.wait?.text ? await svc.waitFor({ text: sub(a.wait.text), timeoutMs: 20_000 }) : await svc.waitFor({ ms: Math.min(20_000, a.wait?.ms ?? 1000) });
        return { detail: out, verified: true };
      }
    }
  }

  // ── The chrome's channels ──
  ctx.handle('browser:teach:state', () => state());
  ctx.handle('browser:teach:start', async () => {
    try { return await start(); } catch (err) { lastError = (err as Error).message; push(); lastError = undefined; throw err; }
  });
  ctx.handle('browser:teach:stop', () => stop());
  ctx.handle('browser:teach:draft', () => draft);
  ctx.handle('browser:teach:discard', () => discard());
  ctx.handle('browser:teach:save', (req: TeachSaveRequest) => save(req));
  ctx.handle('browser:teach:list', () => list());
  // Replays in flight and recent, for the Tasks panel: names, progress and status only — no step
  // details (they can quote page text) and nothing typed.
  ctx.handle('browser:teach:runs', () => [...jobs.values()].map(j => ({
    id: j.id, name: j.name, origin: j.origin, status: j.status, at: j.at,
    done: j.steps.filter(s => s.status === 'ok').length, total: j.total,
    ...(j.current ? { current: j.current.slice(0, 160) } : {}),
  })));

  return { list, run: runTool };
}
