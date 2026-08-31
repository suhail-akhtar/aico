/**
 * JSON-RPC over stdin/stdout, the server half.
 *
 * Hand-rolled rather than taken from the MCP SDK, for the same reason
 * `server/index.ts` is built on Node's `http` module rather than a framework:
 * the whole transport is newline-delimited JSON on two pipes, and a dependency
 * bought to save forty lines is a supply-chain surface bought to save forty
 * lines. aico's MCP *client* is already hand-rolled in `mcp/stdio.ts`; this is
 * the other end of the same wire, and having both means the framing is
 * verified against itself.
 *
 * ## stdout belongs to the protocol
 *
 * This is the one rule that breaks everything if it is broken. A single
 * `console.log` anywhere in the process — a startup banner, a deprecation
 * notice, a stray debug line — lands in the middle of the JSON stream and the
 * client sees a parse error rather than a message. So {@link claimStdout}
 * redirects `console` to stderr for the life of the server, and nothing here
 * writes to stdout except {@link Rpc.send}.
 *
 * @module mcp-server/protocol
 */

/** A request has an id and expects an answer; a notification has neither. */
export interface JsonRpcMessage {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

/** The subset of JSON-RPC error codes this server actually raises. */
export const RPC = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
} as const;

export type Handler = (params: Record<string, unknown>) => Promise<unknown> | unknown;

/**
 * Point `console` at stderr and hand back the real stdout writer.
 *
 * Returns a restore function, so a test can drive the server in-process
 * without permanently silencing the harness it is running inside.
 */
export function claimStdout(): { write: (line: string) => void; restore: () => void } {
  const original = {
    log: console.log, info: console.info, warn: console.warn,
    error: console.error, debug: console.debug,
  };
  const toStderr = (...args: unknown[]): void => {
    process.stderr.write(args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ') + '\n');
  };
  console.log = toStderr;
  console.info = toStderr;
  console.warn = toStderr;
  console.error = toStderr;
  console.debug = toStderr;

  return {
    write: (line: string) => { process.stdout.write(line + '\n'); },
    restore: () => { Object.assign(console, original); },
  };
}

/**
 * A JSON-RPC endpoint over a line-oriented stream.
 *
 * Transport-agnostic on purpose: the live probe drives it over a pair of
 * in-memory callbacks, which is how the dispatch logic gets tested without
 * spawning a process, while the real server hands it stdin and stdout.
 */
export class Rpc {
  private handlers = new Map<string, Handler>();
  private buffer = '';

  constructor(private readonly write: (line: string) => void) {}

  on(method: string, handler: Handler): this {
    this.handlers.set(method, handler);
    return this;
  }

  /** Feed raw bytes. Complete lines are dispatched; a partial tail is kept. */
  async feed(chunk: string): Promise<void> {
    this.buffer += chunk;
    const lines = this.buffer.split('\n');
    // The last element is whatever came after the final newline — an empty
    // string if the chunk ended cleanly, a partial message if it did not.
    // Dispatching it would parse half a message as a whole one.
    this.buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (line.trim()) await this.dispatch(line);
    }
  }

  private async dispatch(line: string): Promise<void> {
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(line) as JsonRpcMessage;
    } catch {
      // No id is recoverable from an unparseable line, so this is the one error
      // that must be reported against a null id.
      this.fail(null, RPC.PARSE_ERROR, 'Invalid JSON');
      return;
    }

    const { id, method } = message;
    // A notification carries no id and must never be answered — a response to
    // one is an unsolicited message, and strict clients treat that as a
    // protocol violation. aico's own client sends `notifications/initialized`
    // *with* an id, so this is decided per message rather than per method.
    const wantsReply = id !== undefined && id !== null;

    if (!method) {
      if (wantsReply) this.fail(id, RPC.INVALID_REQUEST, 'No method');
      return;
    }

    const handler = this.handlers.get(method);
    if (!handler) {
      // Unknown notifications are dropped in silence, which is what the spec
      // asks for and also what keeps a chatty client from filling the log.
      if (wantsReply) this.fail(id, RPC.METHOD_NOT_FOUND, `Unknown method: ${method}`);
      return;
    }

    try {
      const result = await handler(message.params ?? {});
      if (wantsReply) this.send({ jsonrpc: '2.0', id, result });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      if (wantsReply) {
        // An invalid-argument message is the caller's fault and should say so;
        // anything else is ours. Distinguished because a client that cannot
        // tell them apart will retry a request that can never succeed.
        const code = /required|must be|unknown|invalid/i.test(detail)
          ? RPC.INVALID_PARAMS
          : RPC.INTERNAL_ERROR;
        this.fail(id, code, detail);
      }
    }
  }

  private fail(id: number | string | null, code: number, message: string): void {
    this.send({ jsonrpc: '2.0', id, error: { code, message } satisfies JsonRpcError });
  }

  private send(payload: unknown): void {
    this.write(JSON.stringify(payload));
  }
}

/** MCP tool results are content arrays. Text is the only kind aico returns. */
export function textResult(text: string, isError = false): {
  content: Array<{ type: 'text'; text: string }>; isError?: boolean;
} {
  return { content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) };
}
