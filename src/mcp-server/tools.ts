/**
 * What another AI can ask aico to do.
 *
 * Deliberately small. The temptation with an MCP surface is to expose every
 * internal tool — `Read`, `Bash`, `Edit` — and let the caller drive aico like a
 * remote hand. That would make aico a worse version of the caller's own tools,
 * and it would move every safety property aico has (permission modes, the bash
 * classifier, spend caps, the repeat guard) to the wrong side of the boundary.
 *
 * So the surface is *delegation*, not remote control: hand aico a task, get an
 * id back, ask about it, stop it. Everything the task does then runs under
 * aico's own rules, in aico's own workspace, with aico's own supervision. The
 * caller gets a colleague, not a shell.
 *
 * ## Every admitted job is a ledger record with a ceiling
 *
 * Work arriving over MCP is spawned through the same background-agent path the
 * model itself uses, which means it is mirrored into the ledger for free — it
 * can be listed, supervised and stopped exactly like anything else. Two things
 * are added on top:
 *
 *   - `origin: 'remote'`, so a user reading their own ledger can see which rows
 *     they did not cause.
 *   - A **mandatory** spend ceiling. Local work can be left unbounded because a
 *     person is watching it; work started by another process, possibly
 *     unattended, cannot. There is no way to submit without one.
 *
 * @module mcp-server/tools
 */

import { spawnBackgroundAgent, getBackgroundAgentOpts } from '../background/index.js';
import { listSessionSummaries } from '../session/persistence.js';
import { stopWork } from '../work/handles.js';
import { ledger } from '../work/ledger.js';
import { isTerminal } from '../work/types.js';
import type { WorkRecord } from '../work/types.js';

/**
 * What a remote job may spend before the supervisor stops it.
 *
 * A default rather than a required argument, because a caller that has to name
 * a number will name one it made up. Overridable upward, but never removable.
 */
const DEFAULT_MAX_COST_USD = 2.0;

/** And how long it may run. Same reasoning; a stuck job must not be forever. */
const DEFAULT_DEADLINE_MS = 30 * 60_000;

export interface McpToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  run: (args: Record<string, unknown>) => Promise<string> | string;
}

function str(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function num(args: Record<string, unknown>, key: string): number | undefined {
  const value = args[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function age(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m`;
  return `${Math.floor(ms / 3_600_000)}h${Math.floor((ms % 3_600_000) / 60_000)}m`;
}

function describe(record: WorkRecord, now = Date.now()): string {
  const bits = [
    `${record.id}  [${record.state}]  ${record.kind}  ${record.title}`,
    `  ran ${age((record.endedAt ?? now) - record.startedAt)}`
    + (record.progress?.steps ? ` · ${record.progress.steps} step(s)` : '')
    + (record.cost?.usd ? ` · $${record.cost.usd.toFixed(4)}` : '')
    + (record.origin === 'remote' ? ' · started over MCP' : ''),
  ];
  if (!isTerminal(record.state)) {
    const idle = now - record.heartbeatAt;
    if (idle > 30_000) bits.push(`  nothing for ${age(idle)}`);
    else if (record.progress?.lastTool) bits.push(`  now: ${record.progress.lastTool}`);
  }
  if (record.error) bits.push(`  error: ${record.error}`);
  else if (record.result) bits.push(`  result: ${record.result.slice(0, 800)}`);
  return bits.join('\n');
}

/** Wait for ids to settle, or time out. Subscription, never a poll loop. */
function waitFor(ids: string[], timeoutMs: number): Promise<boolean> {
  return new Promise(resolve => {
    let done = false;
    const finish = (ok: boolean): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      unsubscribe();
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    timer.unref?.();
    const unsubscribe = ledger.subscribe(() => {
      if (ids.every(id => {
        const record = ledger.get(id);
        return !record || isTerminal(record.state);
      })) finish(true);
    });
  });
}

export function buildMcpTools(): McpToolSpec[] {
  return [
    {
      name: 'aico_submit',
      description:
        'Hand aico a task. It runs in aico\'s workspace under aico\'s own permission rules, '
        + 'spend caps and supervision — you are delegating, not driving a shell.\n\n'
        + 'Returns a work id immediately; the task keeps running after this call returns. '
        + 'Use aico_wait to collect the result, or aico_status to check without blocking. '
        + 'Every submitted job carries a spend ceiling and a deadline, and is stopped '
        + 'automatically if it passes either.',
      inputSchema: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: 'What you want done. Be complete — the task runs without you.' },
          description: { type: 'string', description: 'A short label for listings. Defaults to the prompt\'s first line.' },
          model: { type: 'string', description: 'Override the configured model.' },
          maxCostUsd: { type: 'number', description: `Spend ceiling. Default ${DEFAULT_MAX_COST_USD}.` },
          timeoutSeconds: { type: 'number', description: `Wall-clock deadline. Default ${DEFAULT_DEADLINE_MS / 1000}.` },
        },
        required: ['prompt'],
      },
      run: (args) => {
        const prompt = str(args, 'prompt');
        if (!prompt) throw new Error('prompt is required');

        const opts = getBackgroundAgentOpts();
        if (!opts) {
          // Better than spawning into a half-initialised process and failing
          // four minutes later inside a provider call.
          throw new Error(
            'aico is not configured to run agents — no provider or model is set up. '
            + 'Run `aico provider add` first.',
          );
        }

        const description = str(args, 'description')
          ?? prompt.split('\n')[0]!.slice(0, 80);
        const model = str(args, 'model');

        const agentId = spawnBackgroundAgent(
          { description, prompt, ...(model ? { model } : {}) },
          opts,
        );
        // The mirror creates this synchronously on the registry's emit, so the
        // record exists by the time spawn returns.
        const workId = `bg:${agentId}`;
        ledger.setOrigin(workId, 'remote');
        ledger.setPolicy(workId, {
          maxCostUsd: num(args, 'maxCostUsd') ?? DEFAULT_MAX_COST_USD,
          deadlineMs: (num(args, 'timeoutSeconds') ?? DEFAULT_DEADLINE_MS / 1000) * 1000,
          onBreach: 'stop',
          notify: 'on-breach',
        });

        return `Started as ${workId}.\n\n`
          + `It is running now and will keep running after this call. Collect it with `
          + `aico_wait {"id":"${workId}"}, or check without blocking using aico_status. `
          + `It will be stopped automatically if it exceeds its spend ceiling or deadline.`;
      },
    },

    {
      name: 'aico_status',
      description:
        'What aico is working on. With no id, lists everything running plus anything that '
        + 'finished and has not been acknowledged. With an id, reports just that one.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'A work id from aico_submit. Omit for everything.' },
          all: { type: 'boolean', description: 'Include already-acknowledged outcomes.' },
        },
      },
      run: (args) => {
        const id = str(args, 'id');
        if (id) {
          const record = ledger.get(id);
          return record ? describe(record) : `No work with id "${id}".`;
        }
        const now = Date.now();
        const all = ledger.all();
        const live = all.filter(r => !isTerminal(r.state));
        const settled = all.filter(r => isTerminal(r.state) && (args.all === true || !r.reported));
        if (!live.length && !settled.length) return 'aico is idle. Nothing running, nothing unreported.';
        return [
          ...(live.length ? [`${live.length} running:`, '', ...live.map(r => describe(r, now))] : []),
          ...(settled.length ? ['', `${settled.length} finished:`, '', ...settled.map(r => describe(r, now))] : []),
        ].join('\n');
      },
    },

    {
      name: 'aico_wait',
      description:
        'Block until the given work finishes, then return its result. Times out without '
        + 'cancelling anything — a timeout means "still going", not "failed".',
      inputSchema: {
        type: 'object',
        properties: {
          id: {
            oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
            description: 'One work id or several.',
          },
          timeoutSeconds: { type: 'number', description: 'Default 600.' },
        },
        required: ['id'],
      },
      run: async (args) => {
        const raw = args.id;
        const ids = (Array.isArray(raw) ? raw : [raw]).filter((v): v is string => typeof v === 'string');
        if (!ids.length) throw new Error('id is required');

        const unknown = ids.filter(id => !ledger.get(id));
        if (unknown.length === ids.length) return `No work with id ${unknown.join(', ')}.`;

        const timeoutMs = Math.max(1, num(args, 'timeoutSeconds') ?? 600) * 1000;
        const settled = await waitFor(ids.filter(id => ledger.get(id)), timeoutMs);
        const lines = ids.map(id => {
          const record = ledger.get(id);
          return record ? describe(record) : `${id}: not found.`;
        });
        return settled
          ? lines.join('\n\n')
          : `Still running after ${Math.round(timeoutMs / 1000)}s — nothing was cancelled:\n\n`
            + lines.join('\n\n');
      },
    },

    {
      name: 'aico_stop',
      description:
        'Stop work you started. A reason is required: the stopped task\'s own error will only '
        + 'say "aborted", and a reader who cannot tell a deliberate stop from a crash will '
        + 'retry something that was stopped on purpose.',
      inputSchema: {
        type: 'object',
        properties: {
          id: {
            oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
          },
          reason: { type: 'string' },
          force: { type: 'boolean', description: 'Signal immediately rather than asking.' },
        },
        required: ['id', 'reason'],
      },
      run: async (args) => {
        const raw = args.id;
        const ids = (Array.isArray(raw) ? raw : [raw]).filter((v): v is string => typeof v === 'string');
        const reason = str(args, 'reason');
        if (!ids.length) throw new Error('id is required');
        if (!reason) throw new Error('reason is required');

        const stopped: string[] = [];
        const already: string[] = [];
        const missing: string[] = [];
        const mode = args.force === true ? 'kill' : 'stop';

        for (const id of ids) {
          const record = ledger.get(id);
          if (!record) { missing.push(id); continue; }
          if (isTerminal(record.state)) { already.push(`${id} (${record.state})`); continue; }
          for (const child of ledger.descendants(id).reverse()) {
            if (isTerminal(child.state)) continue;
            await stopWork(child.id, mode, `parent ${id} stopped — ${reason}`,
              () => { ledger.close(child.id, 'cancelled', `Stopped with parent: ${reason}`); });
          }
          // Outcome first, then the signal — see stopWork. Otherwise the
          // agent's own "Cancelled by user" wins the race and the caller's
          // reason never reaches the record.
          await stopWork(id, mode, reason,
            () => { ledger.close(id, 'cancelled', reason); });
          stopped.push(id);
        }

        return [
          stopped.length ? `Stopped: ${stopped.join(', ')}.` : '',
          // Claiming a kill that did not happen is worse than reporting the miss.
          already.length ? `Already finished, nothing cancelled: ${already.join(', ')}.` : '',
          missing.length ? `Not found: ${missing.join(', ')}.` : '',
        ].filter(Boolean).join(' ');
      },
    },

    {
      name: 'aico_ack',
      description:
        'Mark outcomes as read so they stop being listed. Nothing is cleared by reading it — '
        + 'an outcome you have not acknowledged will be offered again, which is deliberate.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] },
        },
        required: ['id'],
      },
      run: (args) => {
        const raw = args.id;
        const ids = (Array.isArray(raw) ? raw : [raw]).filter((v): v is string => typeof v === 'string');
        if (!ids.length) throw new Error('id is required');
        const count = ledger.acknowledge(ids);
        return count
          ? `Acknowledged ${count}.`
          : 'Nothing to acknowledge — unknown, still running, or already acknowledged.';
      },
    },

    {
      name: 'aico_sessions',
      description:
        'Recent aico conversations in this workspace, newest first. Read-only — this reports '
        + 'what exists; it does not open or resume anything.',
      inputSchema: {
        type: 'object',
        properties: {
          limit: { type: 'number', description: 'Default 20.' },
        },
      },
      run: async (args) => {
        const limit = Math.max(1, Math.min(100, num(args, 'limit') ?? 20));
        const sessions = await listSessionSummaries(process.cwd());
        if (!sessions.length) return 'No sessions in this workspace yet.';
        return sessions.slice(0, limit).map(s =>
          `${s.id}  ${s.title ?? '(untitled)'}  ${s.turns} turn(s)`).join('\n');
      },
    },
  ];
}
