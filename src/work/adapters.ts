/**
 * Mirroring the existing registries into the ledger.
 *
 * The five registries are not being replaced. `tools/task.ts` still owns
 * sub-agents and still hands `SubAgentRecord`s to the code that wants them;
 * `background/index.ts` still owns background agents. Rewriting either to store
 * `WorkRecord`s would touch the spawn path of every agent in the product to buy
 * a shape change, and the spawn path is the last place to take risk for tidiness.
 *
 * Instead each subsystem's existing change notification is mirrored here. That
 * keeps the ledger's promise — one query sees everything — without a single
 * edit inside the code that runs agents.
 *
 * The cost of mirroring is that the ledger learns things a beat late and only
 * as often as the source emits. For supervision that is fine: the sweep runs
 * every five seconds anyway, and no limit here is enforced to the millisecond.
 *
 * Two subsystems have no subscription — backgrounded shell commands and cron
 * firings — so those register directly, from the two call sites that already
 * know when they start and stop.
 *
 * @module work/adapters
 */

import { getBackgroundAgents, cancelBackgroundAgent, subscribeToBackgroundAgents } from '../background/index.js';
import type { BackgroundAgentRecord } from '../background/index.js';
import { subscribeToApps, stopApp } from '../miniapps/process.js';
import { requestAgentStop, subscribeToAgents } from '../tools/task.js';
import type { SubAgentRecord } from '../tools/task.js';
import { costFor } from '../tokens.js';
import type { AicoSettings } from '../settings.js';
import { registerStopHandle } from './handles.js';
import { ledger } from './ledger.js';
import type { WorkState } from './types.js';

/** Settings for pricing. Set once at boot; absent just means list prices. */
let settings: AicoSettings | undefined;

export function setAdapterSettings(next: AicoSettings | undefined): void {
  settings = next;
}

/**
 * Both agent registries use the same four status words, and they map to ledger
 * states one-to-one. `queued` is the one that differs in spirit — a background
 * agent that has not started is genuinely queued, not blocked, because nothing
 * is waiting on a condition.
 */
function agentState(status: string): WorkState {
  switch (status) {
    case 'queued': return 'queued';
    case 'completed': return 'done';
    case 'failed': return 'failed';
    case 'cancelled': return 'cancelled';
    default: return 'running';
  }
}

/**
 * Reflect one agent-shaped record into the ledger.
 *
 * Idempotent: called on every emission, for every record the source holds, so
 * it has to be safe to run against a record that has not changed. The ledger's
 * own guards do most of that — `close` on an already-terminal record is a
 * no-op, and `beat` on one is ignored.
 */
function reflectAgent(
  source: SubAgentRecord | BackgroundAgentRecord,
  opts: { id: string; kind: 'agent'; sessionId?: string; stop: (reason: string) => void },
): void {
  const state = agentState(source.status);
  const existing = ledger.get(opts.id);

  if (!existing) {
    ledger.open({
      id: opts.id,
      kind: opts.kind,
      title: source.description,
      origin: 'model',
      state,
      ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
    });
    registerStopHandle(opts.id, (_mode, reason) => opts.stop(reason));
  }

  const tokens = 'inputTokens' in source
    ? source.inputTokens + source.outputTokens
    : 0;
  const usd = 'inputTokens' in source
    ? costFor(source.model, {
      inputTokens: source.inputTokens,
      outputTokens: source.outputTokens,
      cachedTokens: source.cachedTokens,
    }, settings)
    : 0;

  if (state === 'done' || state === 'failed' || state === 'cancelled') {
    // Final counts before the close, or the record lands terminal with the
    // second-to-last beat's numbers and a spend report that is quietly short.
    ledger.beat(opts.id, {
      steps: source.toolCallCount,
      ...(source.currentTool ? { lastTool: source.currentTool } : {}),
    }, { usd, tokens });
    ledger.close(opts.id, state, source.error ?? source.result ?? source.statusMessage);
    return;
  }

  ledger.beat(opts.id, {
    steps: source.toolCallCount,
    ...(source.currentTool ? { lastTool: source.currentTool } : {}),
    ...(source.statusMessage ? { note: source.statusMessage } : {}),
  }, { usd, tokens });
}

let unsubscribers: Array<() => void> = [];

/**
 * Start mirroring. Idempotent, so a second call does not double-subscribe.
 *
 * Sub-agent ids are prefixed and Mini App slugs are prefixed, because the
 * ledger's id space is shared and a Mini App called `researcher` must not
 * collide with a sub-agent of the same id. Background agents keep their own
 * ids because they are already UUIDs.
 */
export function startLedgerMirroring(): void {
  if (unsubscribers.length) return;

  unsubscribers.push(subscribeToAgents(records => {
    for (const record of records) {
      reflectAgent(record, {
        id: `agent:${record.agentId}`,
        kind: 'agent',
        ...(record.sessionId ? { sessionId: record.sessionId } : {}),
        stop: reason => { requestAgentStop(record.agentId, reason); },
      });
    }
  }));

  unsubscribers.push(subscribeToBackgroundAgents(records => {
    for (const record of records) {
      reflectAgent(record, {
        id: `bg:${record.agentId}`,
        kind: 'agent',
        stop: () => { cancelBackgroundAgent(record.agentId); },
      });
    }
  }));

  unsubscribers.push(subscribeToApps(apps => {
    for (const app of apps) {
      const id = `miniapp:${app.slug}`;
      // `stopped` and `failed` are reported in the snapshot rather than by
      // removal, so they are settled here rather than by the absence sweep below.
      if (app.state === 'stopped' || app.state === 'failed') {
        ledger.close(id, app.state === 'failed' ? 'failed' : 'done',
          app.error ?? (app.state === 'failed' ? 'Failed to start' : 'Stopped'));
        continue;
      }
      if (!ledger.get(id)) {
        ledger.open({
          id,
          kind: 'process',
          title: `Mini App ${app.slug}`,
          origin: 'user',
          // `installing` and `starting` are not yet serving. Marked `queued` so
          // a first run that spends four minutes in `npm install` is not read
          // as a server that has been up for four minutes.
          state: app.state === 'running' ? 'running' : 'queued',
        });
        registerStopHandle(id, () => { void stopApp(app.slug); });
      } else if (app.state === 'running') {
        ledger.setState(id, 'running');
      }
      ledger.beat(id, { steps: 0, note: app.url ?? app.state });
    }
    // An app that has left the snapshot entirely has gone without saying so.
    const live = new Set(apps.map(a => `miniapp:${a.slug}`));
    for (const record of ledger.query({ kind: 'process', live: true })) {
      if (record.id.startsWith('miniapp:') && !live.has(record.id)) {
        ledger.close(record.id, 'done', 'Stopped');
      }
    }
  }));
}

export function stopLedgerMirroring(): void {
  for (const off of unsubscribers) off();
  unsubscribers = [];
}

/** Tests only. */
export function resetAdaptersForTest(): void {
  stopLedgerMirroring();
  settings = undefined;
}
