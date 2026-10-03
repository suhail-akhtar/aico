/**
 * The morning brief and the monitors — the service: when they run, what they
 * keep, the one model call, and the `brief/*` routes.
 *
 * ALWAYS ON, QUIET. One timer (a minute, unref'd) checks whether the brief is
 * due (`brief.time`, 08:00 by default) and whether any monitor's poll is due.
 * A store that has never made a brief **arms** itself instead of briefing on
 * its first start, so a fresh install — and every test store — waits for the
 * next slot. `AICO_BRIEF=off` in the environment disables both.
 *
 * COST. Gathering makes no model call (brief/collect). Then exactly one
 * request to the `background` model role (by default the cheapest model of the
 * configured family), reasoning off, at most {@link MAX_RANKED} one-line items
 * in and 600 tokens out — a fraction of a cent. No items, `brief.useModel:
 * false`, or a background role kept local with no local model, means no call
 * at all. Monitors
 * never call a model: they diff what they saw (brief/core `diffMonitor`).
 *
 * PRIVACY. The ranking request carries titles and short details only, through
 * the vault's redactor. Calendar and email come in only from MCP tools the
 * person named in `brief.mcp`. Quiet hours (`brief.quietHours`, 22:00–07:00 by
 * default) hold monitor notices until they end.
 *
 * NEVER ACTS. Nothing here writes to GitHub, a repository or a session. The
 * brief's actions are links a person clicks (brief/core `BriefAction`).
 *
 * STORAGE, under `aicoHome()/brief/`: `briefs.jsonl` (history, newest last,
 * trimmed to the last 60), `state.json` (armed/last-run, monitor snapshots,
 * backoff and notices), `advisories.json` (each project's last audit, at most
 * one a day).
 *
 * @module brief/service
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { aicoHome } from '../home.js';
import { loadSettings, patchUserSettingPath, type AicoSettings } from '../settings.js';
import { pushNotification } from '../background/notifications.js';
import { sinkRedactText } from '../vault/sink.js';
import { recordRoleSpend, resolveRole } from '../models/roles.js';
import {
  applyRanking, briefDue, buildRankingInput, dedupeItems, diffMonitor, dropRepeats, fallbackSummary,
  inQuietHours, nextDelay, nextSlot, parseRankingReply, releaseNotices, resolveBriefSettings, ruleOrder,
  RANKING_SYSTEM, MAX_RANKED,
  type Brief, type BriefItem, type BriefMonitorConfig, type MonitorNotice, type MonitorSnapshot, type ResolvedBriefSettings,
} from './core.js';
import {
  advisoryItems, defaultRunner, ghState, githubForProject, gitHygiene, inboxItems, longJobItems, mcpItems, workItems,
  latestRuns, type CachedAdvisory, type Runner,
} from './collect.js';

const HISTORY_KEEP = 60;
const NOTICES_KEEP = 50;
const MAX_PROJECTS = 12;
const ADVISORY_TTL_MS = 23 * 60 * 60 * 1000;
const RANK_MAX_TOKENS = 600;
const RANK_TIMEOUT_MS = 45_000;
const TICK_MS = 60_000;

// ── files ────────────────────────────────────────────────────────────

export function briefDir(): string { return path.join(aicoHome(), 'brief'); }
const historyFile = (): string => path.join(briefDir(), 'briefs.jsonl');
const stateFile = (): string => path.join(briefDir(), 'state.json');
const advisoryFile = (): string => path.join(briefDir(), 'advisories.json');

export interface BriefState {
  armedAt?: number;
  lastRunAt?: number;
  monitors: Record<string, { snapshot?: MonitorSnapshot; delayMs?: number; nextAt?: number; error?: string }>;
  notices: MonitorNotice[];
}

function readJson<T>(file: string, fallback: T): T {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) as T; } catch { return fallback; /* absent or torn: start clean */ }
}
function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 1));
  fs.renameSync(tmp, file);
}

export function loadBriefState(): BriefState {
  const s = readJson<Partial<BriefState>>(stateFile(), {});
  return { ...s, monitors: s.monitors ?? {}, notices: Array.isArray(s.notices) ? s.notices : [] };
}
export function saveBriefState(s: BriefState): void {
  writeJson(stateFile(), { ...s, notices: s.notices.slice(-NOTICES_KEEP) });
}

/** History, newest first. A torn last line (a crash mid-append) is skipped. */
export function listBriefs(limit = 30): Brief[] {
  let text = '';
  try { text = fs.readFileSync(historyFile(), 'utf8'); } catch { return []; }
  const out: Brief[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line) as Brief); } catch { /* torn line */ }
  }
  return out.reverse().slice(0, limit);
}

export function appendBrief(b: Brief): void {
  fs.mkdirSync(briefDir(), { recursive: true });
  fs.appendFileSync(historyFile(), `${JSON.stringify(b)}\n`);
  const all = listBriefs(HISTORY_KEEP + 20);
  if (all.length > HISTORY_KEEP) {
    const kept = all.slice(0, HISTORY_KEEP).reverse();
    const tmp = `${historyFile()}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, kept.map(x => JSON.stringify(x)).join('\n') + '\n');
    fs.renameSync(tmp, historyFile());
  }
}

// ── the brief ────────────────────────────────────────────────────────

export interface BriefDeps {
  run?: Runner;
  /** Project folders to look at; default the server's project list. */
  projects?: string[];
  /** Replaces the ranking call (tests). Returns the reply text and its cost. */
  rank?: (system: string, user: string) => Promise<{ text: string; model: string; costUsd: number }>;
  /** Replaces the advisory audit (tests): advisories for a folder, or undefined when none could be run. */
  audit?: (cwd: string) => Promise<CachedAdvisory[] | undefined>;
  now?: number;
}

let launchCwd = process.cwd();
let generating: Promise<Brief> | undefined;

async function projectFolders(): Promise<string[]> {
  const { listProjects } = await import('../server/projects.js');
  const list = await listProjects(launchCwd).catch(() => []);
  return list.filter(p => p.exists).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, MAX_PROJECTS).map(p => p.path);
}

/** Every ecosystem the project uses, through DependencyAudit's own runners. Undefined when no auditor ran. */
async function realAudit(cwd: string): Promise<CachedAdvisory[] | undefined> {
  const { auditOne, detectEcosystems } = await import('../tools/dependency-audit.js');
  const ecos = detectEcosystems(cwd);
  if (!ecos.length) return undefined;
  const out: CachedAdvisory[] = []; let ran = false;
  for (const eco of ecos) {
    const a = await auditOne(eco, cwd, AbortSignal.timeout(150_000)).catch(() => undefined);
    if (a?.status !== 'ok') continue;
    ran = true;
    for (const v of a.advisories) out.push({ id: v.id, pkg: v.pkg, severity: v.severity, title: v.title, ...(v.fix ? { fix: v.fix } : {}) });
  }
  return ran ? out : undefined;
}

interface AdvisoryCache { [cwd: string]: { at: number; ids: string[]; advisories: CachedAdvisory[] } }

/**
 * The project's advisories, from the cache when it is less than a day old.
 * Returns the items new since the previous audit and the critical ids (for
 * the monitors).
 */
async function advisoriesFor(cwd: string, now: number, audit: NonNullable<BriefDeps['audit']>): Promise<{ items: BriefItem[]; critical: string[]; titles: Record<string, string> }> {
  const cache = readJson<AdvisoryCache>(advisoryFile(), {});
  const prev = cache[cwd];
  let current = prev?.advisories ?? [];
  let items: BriefItem[] = [];
  if (!prev || now - prev.at > ADVISORY_TTL_MS) {
    const found = await audit(cwd);
    if (found) {
      items = advisoryItems(cwd, found, prev?.ids);
      current = found;
      const fresh = readJson<AdvisoryCache>(advisoryFile(), {});
      fresh[cwd] = { at: now, ids: found.map(a => a.id), advisories: found.slice(0, 200) };
      writeJson(advisoryFile(), fresh);
    }
  }
  const critical = current.filter(a => a.severity === 'critical');
  return { items, critical: critical.map(a => a.id), titles: Object.fromEntries(critical.map(a => [a.id, `${a.pkg}: ${a.title} (${a.id})`])) };
}

/** The one cheap model call: the `background` role's model (ADR 0017), reasoning off, no tools. */
async function realRank(settings: AicoSettings, model: string, system: string, user: string): Promise<{ text: string; model: string; costUsd: number }> {
  const { withoutReasoning } = await import('../session/title-service.js');
  const { selectProvider } = await import('../providers/index.js');
  const { costFor } = await import('../tokens.js');
  const provider = selectProvider(model, withoutReasoning(settings));
  let text = ''; let usage = { inputTokens: 0, outputTokens: 0, cachedTokens: 0 };
  for await (const ev of provider.chat({ model, systemPrompt: system, messages: [{ role: 'user', content: user }], tools: [], maxTokens: RANK_MAX_TOKENS, signal: AbortSignal.timeout(RANK_TIMEOUT_MS) })) {
    if (ev.type === 'text') text += ev.content;
    else if (ev.type === 'usage') usage = { inputTokens: ev.inputTokens, outputTokens: ev.outputTokens, cachedTokens: ev.cacheReadTokens ?? 0 };
  }
  const costUsd = costFor(model, usage, settings);
  recordRoleSpend('background', costUsd);
  return { text, model, costUsd };
}

/** Gather, dedupe, rank once, keep. Single-flight: a second call while one runs gets the same brief. */
export function generateBrief(trigger: Brief['trigger'], deps: BriefDeps = {}): Promise<Brief> {
  if (generating) return generating;
  generating = buildBrief(trigger, deps).finally(() => { generating = undefined; });
  return generating;
}

async function buildBrief(trigger: Brief['trigger'], deps: BriefDeps): Promise<Brief> {
  const now = deps.now ?? Date.now();
  const settings = await loadSettings();
  const r = resolveBriefSettings(settings.brief);
  const run = deps.run ?? defaultRunner;
  const previous = listBriefs(1)[0];
  const since = previous?.createdAt ?? now - 24 * 60 * 60 * 1000;
  const items: BriefItem[] = [];
  const notes: string[] = [];

  // Local, free, always.
  const { listActions } = await import('../autonomy/inbox.js');
  items.push(...inboxItems(listActions({ status: 'pending', limit: 50 }), now));
  const { listJobs } = await import('../longjob/index.js');
  items.push(...longJobItems(listJobs(), since));
  const { ledger } = await import('../work/ledger.js');
  items.push(...workItems(ledger.all(), since));

  const projects = deps.projects ?? await projectFolders();
  let gh: 'ok' | 'missing' | 'signed-out' = 'missing';
  if (r.github) {
    gh = await ghState(run);
    if (gh === 'missing') notes.push('GitHub: the gh CLI is not installed (https://cli.github.com), so PRs, issues and CI were not checked.');
    if (gh === 'signed-out') notes.push('GitHub: gh is not signed in (run `gh auth login`), so PRs, issues and CI were not checked.');
  }
  const seenRepos = new Set<string>();
  for (const cwd of projects) {
    let defaultBranch: string | undefined;
    if (gh === 'ok') {
      const res = await githubForProject(run, cwd, since).catch(() => undefined);
      if (res?.repo) {
        defaultBranch = res.repo.defaultBranch;
        // Two folders on one repository (a worktree, a second clone) are one repository.
        if (!seenRepos.has(res.repo.nameWithOwner)) { seenRepos.add(res.repo.nameWithOwner); items.push(...res.items); }
      }
    }
    if (r.git) items.push(...await gitHygiene(run, cwd, now, defaultBranch).catch(() => []));
    if (r.advisories) items.push(...(await advisoriesFor(cwd, now, deps.audit ?? realAudit).catch(() => ({ items: [] }))).items);
  }
  if (r.mcp.length) {
    const { mcpRegistry } = await import('../mcp/registry.js');
    const got = await mcpItems(r.mcp, mcpRegistry.getToolsForAgent(), sinkRedactText);
    items.push(...got.items); notes.push(...got.notes);
  }

  let list = ruleOrder(dropRepeats(dedupeItems(items), previous?.items));
  let summary = fallbackSummary(list);
  let rankedBy: Brief['rankedBy'] = 'rules';
  let model: string | undefined; let costUsd: number | undefined;
  // The background role decides the model (legacy key `brief.model`). When it
  // must stay on this machine and none is set, the brief is ranked by rule —
  // never sent to another provider instead.
  const role = deps.rank ? undefined : resolveRole('background', { settings, mainModel: settings.model ?? '', feature: 'brief' });
  if (role && !role.ok && r.useModel && list.length > 0) {
    notes.push(`Ranked by rule, not by a model: ${role.fellBack ?? 'no background model may be used'}`);
  }
  if (r.useModel && list.length > 0 && (!role || role.ok)) {
    const { user, ranked } = buildRankingInput(list, sinkRedactText);
    try {
      const out = await (deps.rank ?? ((sys, u) => realRank(settings, role!.model, sys, u)))(RANKING_SYSTEM, user);
      model = out.model; costUsd = out.costUsd;
      const reply = parseRankingReply(out.text, ranked.length);
      if (reply) {
        list = applyRanking(ranked, list.slice(MAX_RANKED), reply);
        if (reply.summary) summary = reply.summary;
        rankedBy = 'model';
      } else notes.push('The ranking model replied with nothing usable; this brief is in rule order.');
    } catch (err) {
      notes.push(`The ranking call failed (${(err as Error).message.slice(0, 120)}); this brief is in rule order.`);
    }
  }

  const brief: Brief = {
    id: `brief-${now.toString(36)}-${crypto.randomBytes(3).toString('hex')}`,
    createdAt: now, since, items: list, summary, rankedBy,
    ...(model ? { model } : {}), ...(costUsd !== undefined ? { costUsd } : {}),
    notes, trigger,
  };
  appendBrief(brief);
  const state = loadBriefState();
  saveBriefState({ ...state, lastRunAt: now, armedAt: state.armedAt ?? now });
  const urgent = list.filter(i => i.urgency === 'urgent').length;
  pushNotification({ title: 'Your brief is ready', body: urgent ? `${urgent} urgent. ${summary}` : summary, level: urgent ? 'warning' : 'info', sourceId: brief.id });
  return brief;
}

// ── monitors ─────────────────────────────────────────────────────────

/** Poll every monitor that is due. No model; a notice only when something changed. */
export async function pollMonitors(deps: BriefDeps = {}): Promise<MonitorNotice[]> {
  const now = deps.now ?? Date.now();
  const settings = await loadSettings();
  const r = resolveBriefSettings(settings.brief);
  const state = loadBriefState();
  const due = r.monitors.filter(m => (m.ci || m.reviews || m.advisories) && (state.monitors[m.path]?.nextAt ?? 0) <= now);
  const fresh: MonitorNotice[] = [];
  if (due.length) {
    const run = deps.run ?? defaultRunner;
    const needGh = due.some(m => m.ci || m.reviews);
    const gh = needGh ? await ghState(run) : 'ok';
    for (const m of due) {
      const prev = state.monitors[m.path] ?? {};
      try {
        if ((m.ci || m.reviews) && gh !== 'ok') throw new Error(gh === 'missing' ? 'gh is not installed' : 'gh is not signed in');
        const snap: MonitorSnapshot = {};
        const urls: Parameters<typeof diffMonitor>[4] = { ci: {}, reviews: {}, titles: {}, advisories: {} };
        if (m.ci || m.reviews) {
          const res = await githubForProject(run, m.path, now, { ci: !!m.ci, reviews: !!m.reviews, mine: false, issues: false });
          if (!res.repo) throw new Error('not a GitHub repository gh can see');
          if (m.ci) {
            snap.ci = {};
            for (const x of latestRuns(res.runs, res.repo.defaultBranch)) {
              const wf = x.workflowName ?? 'workflow';
              snap.ci[wf] = `${x.databaseId}:${x.conclusion ?? ''}`;
              if (x.url) urls.ci![wf] = x.url;
            }
          }
          if (m.reviews) {
            snap.reviews = res.reviews.map(p => p.number);
            for (const p of res.reviews) { urls.reviews![p.number] = p.url; urls.titles![p.number] = p.title; }
          }
        }
        if (m.advisories) {
          const adv = await advisoriesFor(m.path, now, deps.audit ?? realAudit);
          snap.critical = adv.critical; urls.advisories = adv.titles;
        }
        const notices = diffMonitor(m.path, prev.snapshot, snap, now, urls);
        fresh.push(...notices);
        const delayMs = nextDelay(prev.delayMs, notices.length ? 'changed' : 'same');
        state.monitors[m.path] = { snapshot: snap, delayMs, nextAt: now + delayMs };
      } catch (err) {
        const delayMs = nextDelay(prev.delayMs, 'error');
        state.monitors[m.path] = { ...prev, delayMs, nextAt: now + delayMs, error: (err as Error).message.slice(0, 160) };
      }
    }
  }
  // Already-known notices are not repeated; held ones are released when quiet hours end.
  const known = new Set(state.notices.map(n => n.key));
  const before = new Set(state.notices.filter(n => n.releasedAt).map(n => n.key));
  state.notices = releaseNotices([...state.notices, ...fresh.filter(n => !known.has(n.key))], now, r.quiet);
  for (const n of state.notices.filter(x => x.releasedAt && !before.has(x.key))) {
    pushNotification({ title: n.title, body: n.body, level: n.kind === 'review' ? 'info' : 'warning', sourceId: n.key });
  }
  saveBriefState(state);
  return fresh;
}

// ── the timer ────────────────────────────────────────────────────────

let timer: ReturnType<typeof setInterval> | undefined;

/** One tick: arm on first sight, brief when due, poll monitors. Exported for the tests. */
export async function briefTick(deps: BriefDeps = {}): Promise<{ briefed: boolean; notices: number }> {
  const now = deps.now ?? Date.now();
  const settings = await loadSettings();
  const r = resolveBriefSettings(settings.brief);
  const state = loadBriefState();
  if (state.armedAt === undefined) { saveBriefState({ ...state, armedAt: now }); return { briefed: false, notices: 0 }; }
  let briefed = false;
  if (!generating && briefDue(now, state.lastRunAt ?? state.armedAt, r)) {
    await generateBrief('schedule', deps);
    briefed = true;
  }
  const notices = r.monitors.length ? (await pollMonitors(deps)).length : 0;
  return { briefed, notices };
}

export function startBriefService(opts: { launchCwd: string }): void {
  launchCwd = opts.launchCwd;
  if (timer || process.env.AICO_BRIEF === 'off') return;
  void briefTick().catch(() => { /* a failed tick is retried on the next one */ });
  timer = setInterval(() => { void briefTick().catch(() => { /* retried next tick */ }); }, TICK_MS);
  timer.unref?.();
}

export function stopBriefService(): void {
  if (timer) clearInterval(timer);
  timer = undefined;
}

// ── routes (`/api/brief/*`) ──────────────────────────────────────────

/**
 * Reads, a manual run, and the per-project monitor switches. Nothing here
 * approves or executes anything, so nothing needs the decision gate — the
 * one-click actions are performed by the client, through the routes that
 * already guard them (the inbox's approve needs a person).
 */
export async function handleBriefRoute(route: string, method: string, body: Record<string, unknown>, query: URLSearchParams): Promise<{ status: number; body: unknown } | undefined> {
  switch (route) {
    case 'brief/latest': {
      if (method !== 'GET') return { status: 405, body: { error: 'GET only' } };
      const settings = await loadSettings();
      const r = resolveBriefSettings(settings.brief);
      const state = loadBriefState();
      const now = Date.now();
      return {
        status: 200,
        body: {
          brief: listBriefs(1)[0] ?? null,
          generating: Boolean(generating),
          nextAt: nextSlot(now, r) ?? null,
          quietNow: inQuietHours(now, r.quiet),
          settings: { enabled: r.enabled, time: r.time, useModel: r.useModel, notify: r.notify, quietHours: settings.brief?.quietHours ?? '22:00-07:00' },
          monitors: r.monitors.map(m => ({ ...m, ...(state.monitors[m.path]?.error ? { error: state.monitors[m.path]!.error } : {}), ...(state.monitors[m.path]?.nextAt ? { nextAt: state.monitors[m.path]!.nextAt } : {}) })),
          notices: state.notices.filter(n => n.releasedAt).slice(-20).reverse(),
        },
      };
    }
    case 'brief/history': {
      if (method !== 'GET') return { status: 405, body: { error: 'GET only' } };
      const id = query.get('id');
      const all = listBriefs(HISTORY_KEEP);
      if (id) { const b = all.find(x => x.id === id); return b ? { status: 200, body: { brief: b } } : { status: 404, body: { error: 'no such brief' } }; }
      return {
        status: 200,
        body: { briefs: all.slice(0, Math.min(HISTORY_KEEP, Number(query.get('limit')) || 14)).map(b => ({ id: b.id, createdAt: b.createdAt, summary: b.summary, items: b.items.length, urgent: b.items.filter(i => i.urgency === 'urgent').length, trigger: b.trigger })) },
      };
    }
    case 'brief/run': {
      if (method !== 'POST') return { status: 405, body: { error: 'POST only' } };
      if (generating) return { status: 409, body: { ok: false, error: 'A brief is already being prepared.' } };
      void generateBrief('manual').catch(() => { /* the next read shows no new brief; the notes would have said why */ });
      return { status: 202, body: { ok: true, started: true } };
    }
    case 'brief/monitors': {
      if (method !== 'POST') return { status: 405, body: { error: 'POST only' } };
      const p = typeof body.path === 'string' ? path.resolve(body.path) : '';
      if (!p) return { status: 400, body: { error: 'path required' } };
      const { isKnownProject } = await import('../server/projects.js');
      if (!await isKnownProject(launchCwd, p)) return { status: 403, body: { error: 'not a workspace' } };
      const settings = await loadSettings();
      const current = resolveBriefSettings(settings.brief).monitors.filter(m => path.resolve(m.path) !== p);
      const next: BriefMonitorConfig = { path: p, ci: body.ci === true, reviews: body.reviews === true, advisories: body.advisories === true };
      const list = next.ci || next.reviews || next.advisories ? [...current, next] : current;
      await patchUserSettingPath('brief.monitors', list);
      return { status: 200, body: { ok: true, monitors: list } };
    }
    default:
      return undefined;
  }
}
