/**
 * Turning signals into proposed rules: one small model call, a parser that
 * trusts nothing, and a deterministic fallback.
 *
 * When: a few seconds after a turn or a rating leaves new signals (debounced,
 * so a turn-end and the 👎 that follows it are one call), and in a periodic
 * batch for whatever is still pending — a call that failed, a server that
 * restarted. Never on the turn's critical path, never more than one in
 * flight, and only when there is something to read: a turn without a
 * correction, a note, a hand edit or a repeated choice costs nothing.
 *
 * The call uses the cheapest model in the work model's family (the naming
 * model, `session/title-service`), with reasoning off and a small output cap.
 * The prompt asks for durable *work* preferences only, scoped, with evidence
 * ids and the topic each decides; the reply is parsed as data — unknown
 * fields dropped, scope and category normalised, every text sanitised again
 * in `preferences.ts` — so a confused or injected reply can at worst propose
 * a rule a person then declines.
 *
 * Without a model (offline, no key, a parse failure) the fallback keeps the
 * person's own standing statements — "always…", "never…", "use X, not Y" —
 * and repeated choices, word for word. Less clever, never invented.
 *
 * @module learning/distill
 */

import type { AicoSettings } from '../settings.js';
import type { Session } from '../session/session.js';
import {
  consumeSignals, queueSignals, readPendingSignals, signalsFromTurn, tallyChoices, feedbackSignal,
  rememberAgentWrites, userEditSignals, type PreferenceSignal,
} from './signals.js';
import {
  loadStore, saveStore, mergeCandidates, normaliseScope, type RuleCandidate, type RuleCategory, type PreferenceRule, type MergeResult,
} from './preferences.js';

const DISTILL_TIMEOUT_MS = 30_000;
const DISTILL_MAX_TOKENS = 800;
/** Signals read per call; the rest wait for the next. */
const DISTILL_BATCH = 20;
const DEBOUNCE_MS = 4_000;
/** The periodic batch: often enough that nothing waits a day, rare enough to cost nothing. */
export const BATCH_INTERVAL_MS = 6 * 3_600_000;

export const DISTILL_SYSTEM = [
  'You distil a software developer\'s durable WORK preferences from evidence, for a coding agent to follow on future tasks.',
  'Reply with JSON only: {"rules":[{"text":"...","topic":"...","scope":"global|project|language:<name>","category":"style|tooling|workflow|communication","evidence":["sig-id"],"replaces":["rule-id"]}]}',
  'Rules:',
  '- Only preferences that should apply to FUTURE tasks. A one-off instruction about this task ("rename this button") is not a rule; return {"rules":[]} when nothing is durable.',
  '- One short imperative sentence per rule, under 20 words, e.g. "Use pnpm, not npm." Never invent beyond the evidence.',
  '- topic: a kebab-case name for the single decision the rule makes (package-manager, indentation, test-runner, commit-style).',
  '- scope: "project" when the evidence says it is about this repository, "language:<name>" when it is about one language, otherwise "global".',
  '- replaces: ids of existing rules this one contradicts. Omit when none.',
  '- Never include secrets, names, emails, paths with user names, or anything about the person rather than the work.',
  '- Never write rules about agreeing with, praising or deferring to the user; rules are about how to do the work.',
].join('\n');

export function buildDistillRequest(signals: readonly PreferenceSignal[], existing: readonly PreferenceRule[]): string {
  const ev = signals.map(s => ({ id: s.id, kind: s.kind, text: s.text, ...(s.language ? { language: s.language } : {}) }));
  const rules = existing.filter(r => r.status === 'active' || r.status === 'proposed').slice(0, 40)
    .map(r => ({ id: r.id, text: r.text, topic: r.topic, scope: r.scope.startsWith('project:') ? 'project' : r.scope, status: r.status }));
  return `Existing rules:\n${JSON.stringify(rules)}\n\nNew evidence:\n${JSON.stringify(ev)}`;
}

const CATEGORIES: readonly RuleCategory[] = ['style', 'tooling', 'workflow', 'communication'];

/**
 * The model's reply as candidates. Tolerates a code fence and prose around
 * the JSON; drops anything that is not a rule with text. Evidence ids that
 * are not in `signals` are ignored — the model cannot cite what it was not shown.
 */
export function parseDistillReply(reply: string, signals: readonly PreferenceSignal[]): RuleCandidate[] | undefined {
  const body = reply.replace(/```(?:json)?/gi, '');
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end <= start) return undefined;
  let parsed: unknown;
  try { parsed = JSON.parse(body.slice(start, end + 1)); } catch { return undefined; }
  const list = (parsed as { rules?: unknown }).rules;
  if (!Array.isArray(list)) return undefined;
  const byId = new Map(signals.map(s => [s.id, s]));
  const out: RuleCandidate[] = [];
  for (const raw of list.slice(0, 10)) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    if (typeof r.text !== 'string' || !r.text.trim()) continue;
    const cited = (Array.isArray(r.evidence) ? r.evidence : []).map(String).map(id => byId.get(id)).filter((s): s is PreferenceSignal => !!s);
    const sources = cited.length ? cited : [...signals];
    const roots = [...new Set(sources.map(s => s.projectRoot).filter(Boolean))] as string[];
    const scope = normaliseScope(typeof r.scope === 'string' ? r.scope : 'global', roots.length === 1 ? roots[0] : undefined);
    out.push({
      text: r.text,
      ...(typeof r.topic === 'string' ? { topic: r.topic } : {}),
      // "project" with evidence from several projects is not one project's rule.
      scope: scope.startsWith('project:') && roots.length !== 1 ? 'global' : scope,
      category: CATEGORIES.includes(r.category as RuleCategory) ? r.category as RuleCategory : 'workflow',
      evidence: sources.slice(0, 5).map(s => ({ sessionId: s.sessionId, ...(s.seq !== undefined ? { seq: s.seq } : {}), kind: s.kind, excerpt: s.text.slice(0, 160), at: s.at })),
      ...(Array.isArray(r.replaces) ? { replaces: r.replaces.map(String) } : {}),
    });
  }
  return out;
}

const STANDING = /\b(always|never|from now on|going forward|by default|in future|every time|prefer)\b|\buse\s+[\w.@/-]+(?:\s*,)?\s+(?:not|instead of|rather than)\s+[\w.@/-]+/i;
const CHOICE_RULES: Record<string, (v: string) => string> = {
  'package-manager': v => `Use ${v} for package management.`,
  indentation: v => `Indent with ${v}.`,
  'test-order': () => 'Write the tests first, then the implementation.',
};

/** Without a model: the person's own standing statements and their repeated choices, kept as they said them. */
export function fallbackCandidates(signals: readonly PreferenceSignal[]): RuleCandidate[] {
  const out: RuleCandidate[] = [];
  for (const s of signals) {
    const evidence = [{ sessionId: s.sessionId, ...(s.seq !== undefined ? { seq: s.seq } : {}), kind: s.kind, excerpt: s.text.slice(0, 160), at: s.at }];
    if (s.kind === 'choice') {
      const m = /^Chose ([\w ]+) "([^"]+)"/.exec(s.text);
      const dim = m?.[1]?.replace(' ', '-');
      const make = dim ? CHOICE_RULES[dim] : undefined;
      if (m && make) out.push({ text: make(m[2]!), scope: 'global', category: dim === 'indentation' ? 'style' : 'tooling', evidence });
      continue;
    }
    if (s.kind !== 'correction' && s.kind !== 'feedback') continue;
    const said = s.kind === 'feedback' ? /"([^"]+)"/.exec(s.text)?.[1] ?? '' : s.text;
    if (!STANDING.test(said)) continue;
    const text = said.replace(/^\s*(?:no|nope|wrong|stop)[\s,.!:;—–-]+/i, '').replace(/^\s*(?:please|and)\s+/i, '');
    const project = /\b(this (?:project|repo|repository|codebase)|in here)\b/i.test(said) && s.projectRoot;
    out.push({ text, scope: project ? normaliseScope('project', s.projectRoot) : 'global', category: /\b(indent|tabs?|spaces|quotes?|semicolons?|naming|format)/i.test(text) ? 'style' : 'workflow', evidence });
  }
  return out;
}

export type Completer = (system: string, user: string, signal: AbortSignal) => Promise<string>;

/** The real completer: the naming model, reasoning off, no tools, no AICO prompt. */
export function modelCompleter(settings: AicoSettings, workModel?: string): Completer {
  return async (system, user, signal) => {
    const { selectProvider } = await import('../providers/index.js');
    const { pickNamingModel } = await import('../session/title-service.js');
    const model = settings.learning?.model || pickNamingModel(settings, workModel || settings.model || '');
    const providers = (settings.providers ?? {}) as Record<string, Record<string, unknown>>;
    const quiet = {
      ...settings,
      providers: {
        ...providers,
        anthropic: { ...providers.anthropic, thinking: 'off' },
        deepseek: { ...providers.deepseek, thinking: 'off' },
        kimi: { ...providers.kimi, thinking: 'off' },
        openai: { ...providers.openai, reasoningEffort: 'none' },
      },
    } as AicoSettings;
    const provider = selectProvider(model, quiet);
    let text = '';
    for await (const ev of provider.chat({ model, systemPrompt: system, messages: [{ role: 'user', content: user }], tools: [], maxTokens: DISTILL_MAX_TOKENS, signal })) {
      if (ev.type === 'text') text += ev.content;
    }
    return text;
  };
}

export interface DistillOutcome extends MergeResult { read: number; via: 'model' | 'fallback' | 'none' }

/**
 * Read pending signals, propose rules, merge them, consume what was read.
 * A completer that throws or returns nothing usable falls back; either way the
 * signals are consumed, so one bad batch cannot be re-billed forever.
 */
export async function distillPending(opts: { settings?: AicoSettings; complete?: Completer; now?: number } = {}): Promise<DistillOutcome> {
  const pending = readPendingSignals().slice(0, DISTILL_BATCH);
  const empty: DistillOutcome = { read: 0, via: 'none', added: [], merged: [], replaced: [], refused: [] };
  if (pending.length === 0) return empty;
  const store = loadStore();
  let candidates: RuleCandidate[] | undefined;
  let via: DistillOutcome['via'] = 'fallback';
  if (opts.complete) {
    try {
      const reply = await opts.complete(DISTILL_SYSTEM, buildDistillRequest(pending, store.rules), AbortSignal.timeout(DISTILL_TIMEOUT_MS));
      candidates = parseDistillReply(reply, pending);
      if (candidates) via = 'model';
    } catch (err) {
      if (process.env.AICO_DEBUG) console.warn(`  ⚠ preference distillation failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  candidates ??= fallbackCandidates(pending);
  const result = mergeCandidates(store, candidates, { autoAcceptStyle: opts.settings?.learning?.autoAcceptStyle === true, ...(opts.now ? { now: opts.now } : {}) });
  saveStore(store);
  consumeSignals(pending.map(s => s.id));
  return { ...result, read: pending.length, via };
}

// ── Wiring: per turn, per rating, per batch ─────────────────────────────────

let inFlight: Promise<unknown> | undefined;
let timer: NodeJS.Timeout | undefined;

export function preferencesEnabled(settings: AicoSettings | undefined): boolean {
  return settings?.learning?.preferences !== false;
}

/** Distil soon, once: coalesces a turn-end and the rating that follows it into one call. */
export function scheduleDistill(loadSettings: () => Promise<AicoSettings>, workModel?: string, delayMs = DEBOUNCE_MS): void {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = undefined;
    void runDistill(loadSettings, workModel);
  }, delayMs);
  timer.unref?.();
}

async function runDistill(loadSettings: () => Promise<AicoSettings>, workModel?: string): Promise<void> {
  if (inFlight) return;
  inFlight = (async () => {
    try {
      const settings = await loadSettings();
      if (!preferencesEnabled(settings)) return;
      await distillPending({ settings, complete: modelCompleter(settings, workModel) });
    } catch { /* best effort: the signals stay pending for the batch */ }
  })().finally(() => { inFlight = undefined; });
  await inFlight;
}

/** Before a turn: hand edits to what the agent wrote last turn. */
export function beforeTurn(sessionId: string): number {
  try { return queueSignals(userEditSignals(sessionId)); } catch { return 0; }
}

/** After a turn: corrections and choices in it, a snapshot of what the agent wrote, and a distil if anything new. */
export function afterTurn(session: Session, projectRoot: string, settings: AicoSettings, loadSettings: () => Promise<AicoSettings>, workModel?: string): number {
  try {
    if (!preferencesEnabled(settings)) return 0;
    const turn = session.lastTurn;
    if (turn === 0) return 0;
    rememberAgentWrites(session, turn, projectRoot);
    const { signals, choices } = signalsFromTurn(session, turn, projectRoot);
    const added = queueSignals([...signals, ...tallyChoices(choices, session.header.id, projectRoot)]);
    if (added > 0) scheduleDistill(loadSettings, workModel);
    return added;
  } catch {
    return 0;
  }
}

/** A rating with a note: the edits since the last turn too, then distil. */
export function afterFeedback(session: Session, projectRoot: string, targetSeq: number, rating: 'up' | 'down' | 'none', note: string | undefined, settings: AicoSettings, loadSettings: () => Promise<AicoSettings>): number {
  try {
    if (!preferencesEnabled(settings) || rating === 'none' || !note?.trim()) return 0;
    const sig = feedbackSignal(session, targetSeq, rating, note, projectRoot);
    const added = queueSignals([...(sig ? [sig] : []), ...userEditSignals(session.header.id)]);
    if (added > 0) scheduleDistill(loadSettings);
    return added;
  } catch {
    return 0;
  }
}

/** Queue signals from outside a turn (a canvas edit) and distil soon. */
export function noteSignals(signals: PreferenceSignal[], loadSettings: () => Promise<AicoSettings>): number {
  try {
    const added = queueSignals(signals);
    if (added > 0) scheduleDistill(loadSettings);
    return added;
  } catch {
    return 0;
  }
}

/** The periodic batch: now (for whatever a restart left pending), then every {@link BATCH_INTERVAL_MS}. */
export function startBatch(loadSettings: () => Promise<AicoSettings>): () => void {
  const tick = (): void => { if (readPendingSignals().length) void runDistill(loadSettings); };
  const first = setTimeout(tick, 30_000);
  first.unref?.();
  const every = setInterval(tick, BATCH_INTERVAL_MS);
  every.unref?.();
  return () => { clearTimeout(first); clearInterval(every); if (timer) { clearTimeout(timer); timer = undefined; } };
}
