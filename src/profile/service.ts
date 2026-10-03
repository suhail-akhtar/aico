/**
 * "About you" — the service: when the learner runs, what it may read, the one
 * model call and its budget, and the `profile/*` routes (ADR 0018).
 *
 * WHEN. A quiet ten-minute timer (unref'd) runs the learner when it is on,
 * the last run was six hours ago or more, and no turn is running — so it
 * never competes with the person's own work. `AICO_PROFILE=off` in the
 * environment disables the timer (the offline suites set nothing and still
 * never reach a model: a fresh store has no candidates, and no candidates
 * means no call).
 *
 * WHOSE SETTINGS. `profile` is read from the person's own settings file only
 * (`aicoHome()/settings.json`), never from a project's `.aico/settings.json`:
 * a cloned repository must not be able to switch the learner on, widen what
 * it reads, or raise its budget. Enforced here, where the settings are read.
 *
 * COST. At most one call a run, through the `background` role, reasoning off,
 * capped per local day (`profile.dailyBudgetUsd`, default $0.02). The cap is
 * checked BEFORE the call against the price table's worst case for the
 * request, so the day's spend cannot overshoot by a call. No model, a spent
 * budget or a failed call all mean the same thing: the facts keep their
 * deterministic wording.
 *
 * CONTROL. Confirming, editing and adding facts put words in the agent's
 * prompt, so they need a person (`human()`, like ADR 0016's accept); hiding,
 * forgetting, pausing and wiping only ever take away, so they need nothing.
 * Running now needs a person too (it may spend).
 *
 * RECALL. Usable facts are mirrored into the Recall index (src/recall,
 * ADR 0018) so the Recall tool finds them; hidden and forgotten ones are
 * taken out. `connectRecall` wires it at startup and registers the store as
 * Recall's profile source, so a rebuilt index gets the facts back. The index
 * is never the truth: facts.json is.
 *
 * @module profile/service
 */

import fs from 'fs';
import path from 'path';
import { aicoHome } from '../home.js';
import type { AicoSettings } from '../settings.js';
import { buildCandidates } from './candidates.js';
import {
  buildProfileRequest, estimateCallUsd, parseProfileReply, rankCandidates, roleCompleter,
  PROFILE_SYSTEM, DISTILL_TIMEOUT_MS, type ProfileCompleter,
} from './distill.js';
import { gatherSources, type ProfileSources } from './sources.js';
import {
  addUserFact, applyFactAction, cleanFactText, dayKey, loadProfileStore, mergeFacts, saveProfileStore, usableFacts, wipeProfileStore,
  type FactAction, type FactCandidate, type ProfileFact, type ProfileRun, type ProfileStore,
} from './store.js';
import { FACT_CATEGORIES } from './sensitive.js';

export interface ProfileSettings { enabled: boolean; work: boolean; browsing: boolean; dailyBudgetUsd: number }

export const RUN_INTERVAL_MS = 6 * 3_600_000;
const TICK_MS = 10 * 60_000;
export const DEFAULT_BUDGET_USD = 0.02;

/** The person's own `profile` settings — the global file only, never a project layer. */
export function readProfileSettings(file = path.join(aicoHome(), 'settings.json')): ProfileSettings {
  let p: Record<string, unknown> = {};
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as { profile?: unknown };
    if (raw.profile && typeof raw.profile === 'object') p = raw.profile as Record<string, unknown>;
  } catch { /* no file: the defaults */ }
  const budget = typeof p.dailyBudgetUsd === 'number' && Number.isFinite(p.dailyBudgetUsd) && p.dailyBudgetUsd >= 0 ? Math.min(p.dailyBudgetUsd, 1) : DEFAULT_BUDGET_USD;
  return { enabled: p.enabled !== false, work: p.work !== false, browsing: p.browsing !== false, dailyBudgetUsd: budget };
}

// ── Recall seam ─────────────────────────────────────────────────────────────

export interface ProfileIndexItem { id: string; category: string; text: string; confidence: number; status: string; updated: number }
export interface ProfileIndexer { upsert(items: ProfileIndexItem[]): unknown; remove(id: string): unknown }

let indexer: ProfileIndexer | undefined;
/** Wire the Recall index (or anything else that mirrors usable facts). Pass undefined to unwire. */
export function setProfileIndexer(next: ProfileIndexer | undefined): void { indexer = next; }

/** Mirror usable facts into the index and take out the rest. Best effort: the index is never the truth. */
export function syncIndex(store: ProfileStore, removed: string[] = []): void {
  if (!indexer) return;
  try {
    const usable = usableFacts(store);
    const ids = new Set(usable.map(f => f.id));
    void indexer.upsert(usable.map(f => ({ id: f.id, category: f.category, text: f.text, confidence: f.confidence, status: f.status, updated: f.updated })));
    for (const f of store.facts) if (!ids.has(f.id)) void indexer.remove(f.id);
    for (const id of removed) void indexer.remove(id);
  } catch { /* best effort: Recall rebuilds from facts.json */ }
}

// ── The run ─────────────────────────────────────────────────────────────────

export interface RunDeps {
  now?: number;
  /** Profile switches; read from the person's settings file when absent. */
  profile?: ProfileSettings;
  /** Full settings for the role and prices; `loadSettings()` when absent. */
  settings?: AicoSettings;
  /** `null` forces the no-model path; absent resolves the `background` role. */
  complete?: ProfileCompleter | null;
  /** Override where the browsing digest is read from (tests). */
  digestFile?: string;
  /** Use these sources instead of gathering them (tests). */
  sources?: ProfileSources;
}

export interface RunOutcome extends ProfileRun { refused: Array<{ key: string; reason: string }>; sources: ProfileSources['status'] }

let running: Promise<RunOutcome> | undefined;

/** One learner run. Single-flight: a second call while one runs gets the same outcome. */
export function runProfileLearner(deps: RunDeps = {}): Promise<RunOutcome> {
  if (running) return running;
  running = learn(deps).finally(() => { running = undefined; });
  return running;
}

async function learn(deps: RunDeps): Promise<RunOutcome> {
  const now = deps.now ?? Date.now();
  const prof = deps.profile ?? readProfileSettings();
  const store = loadProfileStore();
  if (!prof.enabled) {
    return { at: now, via: 'skipped', facts: store.facts.length, added: 0, note: 'About you is paused.', refused: [], sources: { work: 'disabled', browsing: 'disabled' } };
  }
  const sources = deps.sources ?? await gatherSources({ now, work: prof.work, browsing: prof.browsing, ...(deps.digestFile ? { digestFile: deps.digestFile } : {}) });
  const candidates = rankCandidates(buildCandidates({
    ...(prof.work && sources.work ? { work: sources.work } : {}),
    preferences: prof.work ? sources.preferences : [],
    ...(prof.browsing && sources.browsing ? { browsing: sources.browsing } : {}),
  }));

  let phrased: FactCandidate[] = candidates;
  let via: ProfileRun['via'] = 'deterministic';
  let model: string | undefined; let provider: string | undefined; let costUsd: number | undefined;
  let note: string | undefined;
  const refused: RunOutcome['refused'] = [];
  if (store.spend.day !== dayKey(now)) store.spend = { day: dayKey(now), usd: 0 };

  if (candidates.length) {
    let complete = deps.complete;
    let chosen: string | undefined;
    if (complete === undefined) {
      const settings = deps.settings ?? await (await import('../settings.js')).loadSettings();
      const { resolveRole } = await import('../models/roles.js');
      const role = resolveRole('background', { settings, mainModel: settings.model ?? '', feature: 'learning' });
      if (role.ok && role.model) {
        chosen = role.model;
        provider = role.providerType;
        const user = buildProfileRequest(candidates);
        const est = await estimateCallUsd(settings, role.model, PROFILE_SYSTEM, user).catch(() => Infinity);
        if (store.spend.usd + est > prof.dailyBudgetUsd) { note = `Today's budget for About you ($${prof.dailyBudgetUsd.toFixed(2)}) would be passed; kept the plain wording.`; complete = null; }
        else complete = roleCompleter(settings, role.model, role.providerType);
      } else {
        note = role.fellBack ? `No model for the background role (${role.fellBack}); kept the plain wording.` : 'No model for the background role; kept the plain wording.';
        complete = null;
      }
    } else if (complete && store.spend.usd >= prof.dailyBudgetUsd) {
      note = `Today's budget for About you ($${prof.dailyBudgetUsd.toFixed(2)}) is spent; kept the plain wording.`;
      complete = null;
    }
    if (complete) {
      try {
        const res = await complete(PROFILE_SYSTEM, buildProfileRequest(candidates), AbortSignal.timeout(DISTILL_TIMEOUT_MS));
        model = res.model || chosen; costUsd = res.costUsd; provider = res.provider ?? provider;
        store.spend.usd += Math.max(0, res.costUsd || 0);
        (await import('../models/roles.js')).recordRoleSpend('background', Math.max(0, res.costUsd || 0));
        const parsed = parseProfileReply(res.text, candidates);
        if (parsed && parsed.length) {
          // The model's line for a key, if it survives the filter; otherwise the plain candidate stays.
          const kept: FactCandidate[] = [];
          const covered = new Set<string>();
          for (const p of parsed) {
            const clean = cleanFactText(p.text, p.category);
            if (!clean.ok) { refused.push({ key: p.key, reason: `model wording ${clean.reason}` }); continue; }
            kept.push(p);
            for (const k of [p.key, ...(p.aliases ?? [])]) covered.add(k);
          }
          phrased = [...kept, ...candidates.filter(c => !covered.has(c.key))];
          via = 'model';
        } else note = 'The model replied with nothing usable; kept the plain wording.';
      } catch (err) {
        note = `The model call failed (${(err as Error).message.slice(0, 120)}); kept the plain wording.`;
      }
    }
  } else {
    note = 'Nothing new to learn from yet.';
  }

  const merged = mergeFacts(store, phrased, now);
  refused.push(...merged.refused);
  const run: ProfileRun = {
    at: now, via, facts: store.facts.length, added: merged.added.length,
    ...(model ? { model } : {}), ...(provider ? { provider } : {}), ...(costUsd !== undefined ? { costUsd } : {}), ...(note ? { note } : {}),
  };
  store.lastRun = run;
  saveProfileStore(store);
  syncIndex(store);
  return { ...run, refused, sources: sources.status };
}

// ── The timer ───────────────────────────────────────────────────────────────

let timer: ReturnType<typeof setInterval> | undefined;

/** Due when on, idle, and six hours since the last run. Exported for the tests. */
export function profileDue(now: number, prof: ProfileSettings, store: Pick<ProfileStore, 'lastRun'>, idle: boolean): boolean {
  return prof.enabled && idle && now - (store.lastRun?.at ?? 0) >= RUN_INTERVAL_MS;
}

/** Mirror facts into Recall (src/recall) from now on. Best effort: without it, Recall simply has no About-you rows. */
export async function connectRecall(): Promise<void> {
  try {
    const recall = await import('../recall/index.js');
    const toItems = (store: ProfileStore): ProfileIndexItem[] => usableFacts(store).map(f => ({ id: f.id, category: f.category, text: f.text, confidence: f.confidence, status: f.status, updated: f.updated }));
    const asInput = (items: ProfileIndexItem[]) => items.map(i => ({ id: i.id, text: i.text, title: i.category, importance: i.confidence, updated: i.updated, meta: { category: i.category, status: i.status } }));
    setProfileIndexer({ upsert: items => recall.upsertProfileItems(asInput(items)), remove: id => recall.removeProfileItem(id) });
    recall.registerProfileSource(() => asInput(toItems(loadProfileStore())));
  } catch { /* Recall unavailable (no node:sqlite): About you works without it */ }
}

export function startProfileService(opts: { idle: () => boolean }): void {
  if (!indexer) void connectRecall();
  if (timer || process.env.AICO_PROFILE === 'off') return;
  timer = setInterval(() => {
    try {
      if (!profileDue(Date.now(), readProfileSettings(), loadProfileStore(), opts.idle())) return;
      void runProfileLearner().catch(() => { /* the next tick tries again; the store keeps the last good state */ });
    } catch { /* best effort */ }
  }, TICK_MS);
  timer.unref?.();
}

export function stopProfileService(): void {
  if (timer) clearInterval(timer);
  timer = undefined;
}

// ── Routes (`/api/profile/*`) ───────────────────────────────────────────────

type Human = () => Promise<{ ok: boolean; reason?: string }>;
type Reply = { status: number; body: unknown };

const needsHuman = (reason?: string): Reply => ({ status: 403, body: { ok: false, code: 'human-required', error: reason ?? 'This needs a person in the AICO window.' } });

async function overview(): Promise<Record<string, unknown>> {
  const store = loadProfileStore();
  const prof = readProfileSettings();
  const { readBrowserDigest } = await import('./sources.js');
  const digest = readBrowserDigest();
  let learner: Record<string, unknown> = { ok: false };
  try {
    const { loadSettings } = await import('../settings.js');
    const settings = await loadSettings();
    const { resolveRole } = await import('../models/roles.js');
    const r = resolveRole('background', { settings, mainModel: settings.model ?? '', feature: 'learning' });
    learner = { ok: r.ok, model: r.model, ...(r.providerType ? { provider: r.providerType } : {}), local: r.local, ...(r.fellBack ? { note: r.fellBack } : {}) };
  } catch { /* shown as "no model" */ }
  const today = dayKey(Date.now());
  return {
    facts: store.facts,
    using: usableFacts(store).map(f => f.id),
    settings: prof,
    lastRun: store.lastRun ?? null,
    running: Boolean(running),
    spend: { today: store.spend.day === today ? store.spend.usd : 0, budget: prof.dailyBudgetUsd },
    sources: { work: prof.work ? 'on' : 'off', browsing: prof.browsing ? digest.status : 'disabled', ...(digest.at ? { digestAt: digest.at } : {}) },
    learner,
    categories: FACT_CATEGORIES,
  };
}

export async function handleProfileRoute(route: string, method: string, body: Record<string, unknown>, human: Human): Promise<Reply | undefined> {
  switch (route) {
    case 'profile': {
      if (method !== 'GET') return { status: 405, body: { error: 'GET only' } };
      return { status: 200, body: await overview() };
    }
    case 'profile/act': {
      if (method !== 'POST') return { status: 405, body: { error: 'POST only' } };
      const action = String(body.action ?? '');
      const id = typeof body.id === 'string' ? body.id : '';
      if (!id) return { status: 400, body: { error: 'id required' } };
      let act: FactAction;
      if (action === 'edit') {
        if (typeof body.text !== 'string') return { status: 400, body: { error: 'text required' } };
        act = { action, id, text: body.text };
      } else if (action === 'confirm' || action === 'hide' || action === 'forget' || action === 'unhide') {
        act = { action, id };
      } else return { status: 400, body: { error: 'action must be confirm, hide, unhide, forget or edit' } };
      if (action === 'confirm' || action === 'edit' || action === 'unhide') {
        const v = await human();
        if (!v.ok) return needsHuman(v.reason);
      }
      const store = loadProfileStore();
      const result = applyFactAction(store, act);
      if (!result.ok) return { status: 400, body: { error: result.error } };
      saveProfileStore(store);
      syncIndex(store, action === 'forget' ? [id] : []);
      return { status: 200, body: result };
    }
    case 'profile/add': {
      if (method !== 'POST') return { status: 405, body: { error: 'POST only' } };
      if (typeof body.text !== 'string') return { status: 400, body: { error: 'text required' } };
      const v = await human();
      if (!v.ok) return needsHuman(v.reason);
      const store = loadProfileStore();
      const result = addUserFact(store, body.category, body.text);
      if (!result.ok) return { status: 400, body: { error: result.error } };
      saveProfileStore(store);
      syncIndex(store);
      return { status: 200, body: result };
    }
    case 'profile/run': {
      if (method !== 'POST') return { status: 405, body: { error: 'POST only' } };
      const v = await human();
      if (!v.ok) return needsHuman(v.reason);
      if (running) return { status: 409, body: { ok: false, error: 'About you is already learning.' } };
      void runProfileLearner().catch(() => { /* the next read shows the last run's note */ });
      return { status: 202, body: { ok: true, started: true } };
    }
    case 'profile/settings': {
      if (method !== 'POST') return { status: 405, body: { error: 'POST only' } };
      const { patchUserSettingPath } = await import('../settings.js');
      const changes: Array<[string, unknown]> = [];
      for (const k of ['enabled', 'work', 'browsing'] as const) if (typeof body[k] === 'boolean') changes.push([k, body[k]]);
      if (typeof body.dailyBudgetUsd === 'number' && Number.isFinite(body.dailyBudgetUsd) && body.dailyBudgetUsd >= 0) changes.push(['dailyBudgetUsd', Math.min(1, body.dailyBudgetUsd)]);
      if (!changes.length) return { status: 400, body: { error: 'nothing to change (enabled, work, browsing, dailyBudgetUsd)' } };
      // Turning something on or spending more widens what is learned: a person, not the token.
      const widens = changes.some(([k, v]) => (v === true) || (k === 'dailyBudgetUsd' && (v as number) > readProfileSettings().dailyBudgetUsd));
      if (widens) {
        const v = await human();
        if (!v.ok) return needsHuman(v.reason);
      }
      for (const [k, v] of changes) await patchUserSettingPath(`profile.${k}`, v);
      return { status: 200, body: { ok: true, settings: readProfileSettings() } };
    }
    case 'profile/export': {
      if (method !== 'GET') return { status: 405, body: { error: 'GET only' } };
      const store = loadProfileStore();
      return { status: 200, body: { exportedAt: new Date().toISOString(), format: 'aico-about-you/1', facts: store.facts, lastRun: store.lastRun ?? null } };
    }
    case 'profile/wipe': {
      if (method !== 'POST') return { status: 405, body: { error: 'POST only' } };
      const before = loadProfileStore();
      wipeProfileStore();
      syncIndex(loadProfileStore(), before.facts.map((f: ProfileFact) => f.id));
      return { status: 200, body: { ok: true, removed: before.facts.length } };
    }
    default:
      return undefined;
  }
}
