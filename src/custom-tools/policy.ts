/**
 * When a custom tool call may run: its declared effect class, the session's
 * autonomy level and the taint rule decide whether a person is asked
 * (design §4.1–4.2), and the call's arguments are checked before anyone is.
 *
 * Two deny-only guards (ADR 0002 — a guard can refuse, never grant):
 *
 *  1. **`custom-tool:args`** validates the arguments against the tool's
 *     schema. A refused value (shell syntax in free text, a leading `-`, a
 *     `..` segment, a pattern miss) never reaches a prompt or a spawn.
 *  2. **`custom-tool:approval`** applies the matrix below. Asking is the run's
 *     ordinary permission card (the decision gate applies, so the API token
 *     alone cannot answer), or — at L3, where nothing else asks — the
 *     always-ask channel `onApprovalRequired`, or the terminal's own y/N.
 *
 * | effect      | L0 plan | L1/L2 ask/edits | L3 auto                         |
 * |-------------|---------|-----------------|---------------------------------|
 * | read        | run     | as the session  | run                             |
 * | write, exec | refused | asked           | run                             |
 * | external    | refused | asked           | first use asked (every use once the session is tainted) |
 * | destructive | refused | asked + preview | **every use asked + preview**   |
 *
 * `approval` in the definition tightens any row or relaxes `external` to
 * `none`; nothing relaxes `destructive` (validated in format.ts), and there
 * is no "always allow" for it in any client. With nobody to ask (a headless
 * run below L4) a call that needs a person is refused, never run. At L4
 * (unattended, Phase 7) it is **parked** instead: the exact call, its preview
 * and their hashes go to the approve-later inbox (`autonomy/inbox.ts`), the
 * model is told it has not run and must not be worked around, and the run
 * carries on with everything else.
 *
 * Taint: once the session has taken in web pages or MCP results, an
 * `external` call is asked every time even at L3 — derived from the calls
 * the run has seen, not stored.
 *
 * @module custom-tools/policy
 */

import crypto from 'node:crypto';
import readline from 'node:readline';
import type { ToolPipeline } from '../tools/pipeline.js';
import { sinkRedactText } from '../vault/sink.js';
import { describeCall, validateArgs, type ApprovalOverride, type CustomToolDef, type Effect } from './format.js';
import { runCustomTool } from './runner.js';
import type { LoadedTool } from './store.js';

export type ApprovalDecision =
  | { kind: 'allow' }
  | { kind: 'deny'; reason: string }
  | { kind: 'ask'; mode: 'standard' | 'first-use' | 'every-use'; why: string };

/** The matrix, pure. `approvedBefore`: a person already said yes to this tool in this session. */
export function approvalDecision(name: string, effect: Effect, approval: ApprovalOverride | undefined, s: {
  planMode?: boolean; autoApprove: boolean; tainted?: boolean; approvedBefore?: boolean;
}): ApprovalDecision {
  if (s.planMode) {
    return effect === 'read' ? { kind: 'allow' }
      : { kind: 'deny', reason: `Plan mode: ${name} is a ${effect} tool, so it is not available while planning. Propose the step in the plan instead.` };
  }
  if (effect === 'destructive') return { kind: 'ask', mode: 'every-use', why: 'destructive — a person approves every call' };
  const tightened = (): ApprovalDecision | undefined => {
    if (approval === 'every-use') return { kind: 'ask', mode: 'every-use', why: 'its author asks for approval on every call' };
    if (approval === 'first-use' && !s.approvedBefore) return { kind: 'ask', mode: 'first-use', why: 'its author asks for approval on first use' };
    return undefined;
  };
  if (effect === 'read') return tightened() ?? { kind: 'allow' };
  if (!s.autoApprove) return { kind: 'ask', mode: 'standard', why: `${effect} — this session asks before tools that change things` };
  if (effect === 'external') {
    if (s.tainted) return { kind: 'ask', mode: 'every-use', why: 'external, and this session has read web or MCP content, so every call is asked' };
    if (approval === 'none') return { kind: 'allow' };
    if (approval === 'every-use') return { kind: 'ask', mode: 'every-use', why: 'external — its author asks on every call' };
    return s.approvedBefore ? { kind: 'allow' } : { kind: 'ask', mode: 'first-use', why: 'external — asked the first time in this session' };
  }
  return tightened() ?? { kind: 'allow' };
}

/** Tools whose results are untrusted content for the taint rule. */
export function taints(toolName: string): boolean {
  return toolName === 'WebFetch' || toolName === 'WebSearch' || toolName.startsWith('mcp__');
}

/** First-use approvals, per session: one yes covers the rest of that session. */
const firstUse = new Map<string, Set<string>>();

/** A y/N on the terminal with no "always" answer. Resolves false without a TTY. */
export function ttyAsk(title: string, detail: string): Promise<boolean> {
  return new Promise((resolve) => {
    if (!process.stdin.isTTY) { resolve(false); return; }
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false });
    rl.question(`\n  ⚠  ${title}\n${detail.split('\n').map(l => `     ${l}`).join('\n')}\n  Allow this call? [y/N] `, (answer) => {
      rl.close();
      resolve(/^y(es)?$/i.test(answer.trim()));
    });
  });
}

export type UsableTools = ReadonlyMap<string, LoadedTool & { def: CustomToolDef }>;

/** What an L4 run hands the inbox for one call that needs a person. */
export interface ParkRequest {
  tool: LoadedTool & { def: CustomToolDef };
  /** The preview tool as loaded now, so its file hash binds the approval too. */
  previewTool?: LoadedTool & { def: CustomToolDef };
  args: Record<string, unknown>;
  why: string;
  preview?: { text: string; hash: string };
}

export interface CustomToolStageOptions {
  agentId: string;
  /** Session id (or the run's id): first-use approvals are remembered per this key. */
  sessionKey: string;
  sessionId?: string;
  tools: UsableTools;
  planMode?: boolean;
  autoApprove: boolean;
  /** Whoever asks a person; undefined when nobody can be asked. */
  ask?: (title: string, detail: string) => Promise<boolean>;
  /**
   * L4 (unattended): record the call for a person to approve later instead of
   * asking or refusing (Phase 7, `autonomy/inbox.ts`). Wins over `ask`: at L4
   * nobody is waiting on a card. Resolves to the inbox id, or a reason the
   * call could not be parked (it is then refused, never run).
   */
  park?: (call: ParkRequest) => Promise<{ id: string } | { error: string }>;
  tainted: () => boolean;
  cwd: () => string;
}

/**
 * Run a call's preview tool. `text` is what a person reads (redacted, clipped
 * to 3,000 characters); `hash` is over the whole redacted output, so a parked
 * call's preview can be compared later even where the card was clipped
 * (Phase 7: a changed preview refuses the approval as diverged).
 */
export async function runPreview(def: CustomToolDef, args: Record<string, unknown>, ctx: {
  tools: UsableTools; cwd: string; sessionId?: string; signal?: AbortSignal;
}): Promise<{ text: string; hash: string } | undefined> {
  const name = def.preview?.tool;
  if (!name) return undefined;
  const hashed = (text: string, full: string = text): { text: string; hash: string } =>
    ({ text, hash: crypto.createHash('sha256').update(full).digest('hex') });
  const preview = ctx.tools.get(name);
  if (!preview || preview.def.effect !== 'read') return hashed(`Preview (${name}) unavailable: it is not an enabled read tool.`);
  const problems = validateArgs(preview.def.input_schema, args);
  if (problems.length) return hashed(`Preview (${name}) not run: ${problems.join(' ')}`);
  const out = await runCustomTool(preview.def, args, { cwd: ctx.cwd, ...(ctx.signal ? { signal: ctx.signal } : {}), ...(ctx.sessionId ? { sessionId: ctx.sessionId } : {}) });
  const text = typeof out.error === 'string'
    ? `${out.error}\n${String(out.stderr ?? '')}`
    : String(out.stdout ?? JSON.stringify(out));
  const clipped = text.length > 3000 ? `${text.slice(0, 3000)}\n… (${text.length - 3000} more characters)` : text;
  return hashed(`Preview (${name}):\n${sinkRedactText(clipped.trimEnd())}`, `Preview (${name}):\n${sinkRedactText(text.trimEnd())}`);
}

/** Run a preview tool for an approval card. Its output is redacted and bounded. */
async function previewFor(def: CustomToolDef, args: Record<string, unknown>, opts: CustomToolStageOptions, signal?: AbortSignal): Promise<string | undefined> {
  return (await runPreview(def, args, {
    tools: opts.tools, cwd: opts.cwd(),
    ...(opts.sessionId ? { sessionId: opts.sessionId } : {}), ...(signal ? { signal } : {}),
  }))?.text;
}

/** What a person reads before answering: effect, why, the exact call (secrets by name), the preview. */
export async function approvalDetail(def: CustomToolDef, args: Record<string, unknown>, why: string, opts: CustomToolStageOptions, signal?: AbortSignal): Promise<string> {
  const parts = [`${def.effect} · ${why}`, describeCall(def, args)];
  const preview = await previewFor(def, args, opts, signal);
  if (preview) parts.push(preview);
  if (def.effect === 'destructive') parts.push('There is no "always allow" for a destructive tool.');
  return sinkRedactText(parts.join('\n'));
}

/**
 * Install both guards on a run's pipeline. Scoped to this run's agent id and
 * tool set: a composed pipeline may be shared, and one run's tools are not
 * another's. Returns the disposers.
 */
export function installCustomToolGuards(pipeline: ToolPipeline, opts: CustomToolStageOptions): Array<() => void> {
  const mine = (ctx: { agentId: string; name: string }): (LoadedTool & { def: CustomToolDef }) | undefined =>
    ctx.agentId === opts.agentId ? opts.tools.get(ctx.name) : undefined;

  const args = pipeline.onGuard('custom-tool:args', (ctx) => {
    const tool = mine(ctx);
    if (!tool) return { kind: 'abstain' };
    const problems = validateArgs(tool.def.input_schema, ctx.arguments ?? {});
    return problems.length
      ? { kind: 'deny', reason: `${tool.name} was not run — its arguments were refused before anything started: ${problems.join(' ')}` }
      : { kind: 'abstain' };
  });

  const approval = pipeline.onGuard('custom-tool:approval', async (ctx) => {
    const tool = mine(ctx);
    if (!tool) return { kind: 'abstain' };
    const seen = firstUse.get(opts.sessionKey);
    const decision = approvalDecision(tool.name, tool.def.effect, tool.def.approval, {
      ...(opts.planMode ? { planMode: true } : {}),
      autoApprove: opts.autoApprove,
      tainted: opts.tainted(),
      approvedBefore: seen?.has(tool.name) ?? false,
    });
    if (decision.kind === 'allow') return { kind: 'abstain' };
    if (decision.kind === 'deny') return decision;
    if (opts.park) {
      const args = ctx.arguments ?? {};
      const preview = await runPreview(tool.def, args, {
        tools: opts.tools, cwd: opts.cwd(),
        ...(opts.sessionId ? { sessionId: opts.sessionId } : {}), ...(ctx.signal ? { signal: ctx.signal } : {}),
      });
      const previewName = tool.def.preview?.tool;
      const previewTool = previewName ? opts.tools.get(previewName) : undefined;
      let parked: { id: string } | { error: string };
      try {
        parked = await opts.park({ tool, args, why: decision.why, ...(preview ? { preview } : {}), ...(previewTool ? { previewTool } : {}) });
      } catch (err) { parked = { error: (err as Error).message }; }
      if ('error' in parked) {
        return { kind: 'deny', reason: `${tool.name} needs a person's approval (${decision.why}) and could not be parked for one: ${parked.error} It was not run.` };
      }
      return {
        kind: 'deny',
        reason: `PARKED: ${tool.name} needs a person's approval (${decision.why}), and this run is unattended, so the exact call was put in the AICO inbox (id ${parked.id}) for a person to approve later. It has NOT run. `
          + 'Do not try to do the same thing another way — not with another tool, not with a shell command. Finish everything else that does not depend on it, '
          + 'and say in your final report that this step is waiting for approval in the inbox.',
      };
    }
    if (!opts.ask) {
      return {
        kind: 'deny',
        reason: `${tool.name} needs a person's approval (${decision.why}), and nobody is available to give it in this run. `
          + 'It was not run. Unattended runs never run destructive tools; ask the person to run this from a chat.',
      };
    }
    const detail = await approvalDetail(tool.def, ctx.arguments ?? {}, decision.why, opts, ctx.signal);
    let yes = false;
    try { yes = await opts.ask(tool.name, detail); } catch { yes = false; }
    if (!yes) return { kind: 'deny', reason: `The person did not approve ${tool.name}; it was not run. Do not try to do the same thing another way.` };
    // A person saw this exact call: the Sentinel does not ask them again (sentinel `HUMAN_APPROVED`).
    ctx.state.set('human-approved', true);
    if (decision.mode === 'first-use') {
      if (!firstUse.has(opts.sessionKey)) firstUse.set(opts.sessionKey, new Set());
      firstUse.get(opts.sessionKey)!.add(tool.name);
    }
    return { kind: 'abstain' };
  });
  return [args, approval];
}

/** Forget first-use approvals (tests). */
export function resetFirstUseForTest(): void { firstUse.clear(); }
