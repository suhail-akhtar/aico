/**
 * aico as an MCP server — the "other AI can drive it" half.
 *
 * `aico mcp-serve` speaks MCP over stdin/stdout, so Claude Code, another aico,
 * or any MCP client can hand it work and collect the result. **Nothing
 * listens.** There is no socket, no port and no bind address: the transport is
 * the pipe the client already opened by spawning the process, which is why this
 * needs no authentication to be safe — reaching it requires already being able
 * to run a program as you.
 *
 * That is a deliberate limit, not a first step. A networked version would need
 * scoped capability tokens, TLS or a tunnel, rate limits and an audit trail
 * before it could be honestly described as safe, and none of that exists yet.
 *
 * @module mcp-server
 */

import { loadSettings } from '../settings.js';
import { initializeFeatures } from '../bootstrap.js';
import { PROVIDER_DEFAULT_MODELS } from '../providers/index.js';
import { buildMcpTools, type McpToolSpec } from './tools.js';
import { claimStdout, Rpc, textResult } from './protocol.js';

/** The protocol revision aico's own client speaks, so both ends agree. */
const PROTOCOL_VERSION = '2024-11-05';

export interface McpServeOptions {
  /** Where work runs. Defaults to the process's directory. */
  cwd?: string;
  /** Injected by tests to drive the endpoint without a real process. */
  transport?: { write: (line: string) => void };
}

/**
 * Wire the method handlers onto an endpoint.
 *
 * Split from the process plumbing so a test can build one over an in-memory
 * writer and exercise every method without spawning anything — and so the live
 * probe, which *does* spawn, is testing the transport rather than re-testing
 * the dispatch.
 */
export function attachMcpHandlers(rpc: Rpc, tools: McpToolSpec[]): Rpc {
  const byName = new Map(tools.map(t => [t.name, t]));

  rpc.on('initialize', () => ({
    protocolVersion: PROTOCOL_VERSION,
    capabilities: { tools: {} },
    serverInfo: { name: 'aico', version: '0.5.0' },
  }));

  // Answered rather than ignored, because aico's own client sends this as a
  // request with an id and would otherwise wait for a reply that never comes.
  // The `Rpc` layer already declines to answer it when it arrives without one,
  // so both behaviours are correct from the same handler.
  rpc.on('notifications/initialized', () => ({}));

  rpc.on('tools/list', () => ({
    tools: tools.map(t => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
  }));

  rpc.on('tools/call', async (params) => {
    const name = typeof params.name === 'string' ? params.name : '';
    const tool = byName.get(name);
    if (!tool) throw new Error(`Unknown tool: ${name}`);
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    try {
      return textResult(await tool.run(args));
    } catch (err) {
      // A failing tool is a *result* that reports failure, not a transport
      // error. The distinction matters to the caller: a protocol error means
      // "this call was malformed", while `isError` means "the call was fine and
      // the work did not succeed" — and only the second is worth showing a
      // model as something it might respond to.
      return textResult(err instanceof Error ? err.message : String(err), true);
    }
  });

  // Declared so a client's discovery calls get an empty list rather than a
  // method-not-found error, which some clients surface as a broken server.
  rpc.on('resources/list', () => ({ resources: [] }));
  rpc.on('prompts/list', () => ({ prompts: [] }));
  rpc.on('ping', () => ({}));

  return rpc;
}

/**
 * Run the server until stdin closes.
 *
 * Resolves when the client goes away, which is how the process knows to exit —
 * an MCP server's lifetime is its client's, and one that outlived its pipe
 * would be an orphan nothing can reach.
 */
export async function serveMcpOverStdio(opts: McpServeOptions = {}): Promise<void> {
  const stdout = claimStdout();

  if (opts.cwd) process.chdir(opts.cwd);

  // Everything the delegated work depends on — skills, MCP clients of our own,
  // the cron scheduler, and the work ledger — comes up before the first request
  // is answered. `initializeFeatures` warns through `console`, which is already
  // pointed at stderr, so none of it can corrupt the protocol stream.
  const settings = await loadSettings();
  const model = settings.model
    ?? PROVIDER_DEFAULT_MODELS[settings.provider ?? 'openrouter']
    ?? 'deepseek-v4-flash';
  await initializeFeatures({
    settings,
    model,
    autoApprove: settings.autoApprove ?? false,
    warn: (message: string) => process.stderr.write(`${message}\n`),
  }).catch((err: unknown) => {
    process.stderr.write(`aico mcp-serve: startup warning: ${String(err)}\n`);
  });

  const rpc = attachMcpHandlers(new Rpc(stdout.write), buildMcpTools());

  process.stderr.write('aico mcp-serve: ready on stdio\n');

  await new Promise<void>(resolve => {
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk: string) => { void rpc.feed(chunk); });
    process.stdin.on('end', () => resolve());
    process.stdin.on('close', () => resolve());
    process.stdin.resume();
  });

  stdout.restore();
}
