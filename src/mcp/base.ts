import { offerToolImage } from '../tools/tool-images.js';
import {
  CLIENT_INFO, LEGACY_PROTOCOL, MODERN_PROTOCOL, McpRpcError, PROBE_TIMEOUT_MS, classifyProbe, headerParams, modernMeta, paramHeaders,
} from './protocol.js';

/** What a transport's `send` may be told beyond the method and params. */
export interface SendOptions {
  /** Milliseconds before giving up; 0 means wait as long as the transport lives. Default 30 s. */
  timeoutMs?: number;
  /** Extra HTTP headers for this one request (`Mcp-Param-*`). Ignored by stdio. */
  headers?: Record<string, string>;
}

/** One per-tool rule in a server's settings entry (design §5.3). Only `effect: "read"` relaxes anything. */
export interface McpToolPolicy {
  effect?: 'read' | 'write' | 'external' | 'destructive';
}

/** Backward-compatible MCP server config (V2 adds http/sse support) */
export interface McpServerConfigV2 {
  /** Process command — required for stdio */
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  type: 'stdio' | 'http' | 'sse';
  /** HTTP/SSE endpoint URL */
  url?: string;
  /** Extra HTTP headers (e.g. Authorization) */
  headers?: Record<string, string>;
  /**
   * The person says this server's tools only read. Plan mode and read-only
   * agents may then use them, and the terminal does not ask before each one.
   *
   * Only settings can say it. A server's own `readOnlyHint` annotations are
   * untrusted by the MCP spec and ignored for policy, so a server that sets no
   * flag here is treated as one that may write (see `mcp/policy`).
   */
  readOnly?: boolean;
  /**
   * Per-tool policy, keyed by tool name or `*`. `{ "effect": "read" }` lets
   * plan mode and read-only agents use that tool, the way `readOnly` does for
   * the whole server. Like `readOnly`, only the person's settings say it.
   */
  tools?: Record<string, McpToolPolicy>;
  /**
   * `trusted`: tools this server adds later are approved on arrival. Without
   * it a new tool waits for a person, like a changed one (see `mcp/pins`).
   */
  trust?: 'trusted';
  /**
   * Offer this server's tool schemas on every request instead of on demand
   * behind `LoadTools` (see `tools/deferred`).
   */
  alwaysLoad?: boolean;
}

/** Backward-compat alias — existing configs only need command + type:'stdio' */
export type McpServerConfig = McpServerConfigV2;

/**
 * A tool's MCP `annotations`. Hints only: the spec says a client must treat
 * them as untrusted, so nothing in AICO's policy reads them (see `mcp/policy`).
 * They are shown in `McpManage test` beside the effect a person would set.
 */
export interface McpToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  execute: (args: Record<string, unknown>) => Promise<unknown>;
  title?: string;
  annotations?: McpToolAnnotations;
  outputSchema?: Record<string, unknown>;
}

/** An elicitation a server asked for during a call (MRTR `inputRequests`). */
export interface McpElicitation {
  mode: 'form' | 'url';
  message: string;
  url?: string;
  requestedSchema?: Record<string, unknown>;
}
export interface McpElicitationAnswer {
  action: 'accept' | 'decline' | 'cancel';
  content?: Record<string, unknown>;
}
/** Who answers an elicitation. Absent means AICO does not offer the capability. */
export type McpElicitationHandler = (request: McpElicitation, ctx: { tool: string }) => Promise<McpElicitationAnswer>;

/** How many `input_required` rounds one call may take before AICO stops it. */
const MAX_INPUT_ROUNDS = 3;

export interface McpResource {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
}

export interface McpResourceContent {
  uri: string;
  mimeType?: string;
  text?: string;
  blob?: string;
}

export type McpHealthStatus = 'healthy' | 'degraded' | 'disconnected';

/** One item of an MCP tool result's `content`. Only the fields AICO reads. */
export interface McpContentItem {
  type: string;
  text?: string;
  /** Base64, for `image`. */
  data?: string;
  mimeType?: string;
  /** For `resource`: an embedded resource, which may itself be an image blob. */
  resource?: { uri?: string; mimeType?: string; blob?: string; text?: string };
}

/**
 * The pictures in an MCP result, as bytes.
 *
 * Two places an image can be: an `image` item, and an embedded `resource`
 * whose blob is an image. The declared MIME type only chooses what to look at —
 * the format itself is read from the bytes later, because a server's label is
 * not something a provider should be told on trust.
 */
export function mcpImages(content: readonly McpContentItem[]): Array<{ bytes: Buffer }> {
  const out: Array<{ bytes: Buffer }> = [];
  for (const item of content) {
    const data = item.type === 'image'
      ? item.data
      : item.type === 'resource' && /^image\//i.test(item.resource?.mimeType ?? '') ? item.resource?.blob : undefined;
    if (typeof data !== 'string' || !data) continue;
    const bytes = Buffer.from(data, 'base64');
    if (bytes.length > 0) out.push({ bytes });
  }
  return out;
}

/** A server's instructions are capped: they ride in every request's prompt. */
const MAX_INSTRUCTIONS = 6000;

/** What a legacy `initialize` or a modern `server/discover` told us about the server. */
interface ServerHello {
  protocolVersion?: unknown;
  supportedVersions?: unknown;
  capabilities?: unknown;
  instructions?: unknown;
  serverInfo?: { name?: unknown; title?: unknown };
  _meta?: Record<string, unknown>;
}

/** A `tools/call` result in either era. */
interface ToolCallResult {
  resultType?: string;
  content?: McpContentItem[];
  structuredContent?: unknown;
  isError?: boolean;
  inputRequests?: Record<string, { method?: string; params?: Record<string, unknown> }>;
  requestState?: string;
}

/**
 * Abstract base class for all MCP transport implementations.
 * Concrete subclasses implement `send()`, `notify()`, `isAlive()`, `stop()`, and `getHealth()`.
 *
 * ## Two eras
 *
 * `initialize()` probes with `server/discover` (revision 2026-07-28) and falls
 * back to the `initialize` handshake on any non-modern error or silence (see
 * `mcp/protocol`). Afterwards every request goes through `request()`, which
 * adds the modern `_meta` when the server is modern and nothing when it is not,
 * so the rest of AICO never asks which era it is talking to.
 *
 * The probe used to be absent: the client sent `initialize` with 2024-11-05
 * and nothing else, and its "notification" carried an id and waited for an
 * answer, so a server that (correctly) did not answer one held startup for 30 s.
 */
export abstract class McpBaseClient {
  protected initialized = false;
  /**
   * What the server said about how to use it (`instructions` in the MCP
   * initialize result). Kept so it can reach the agent — a server that ships a
   * manual for its tools is telling the model something the tool schemas cannot.
   */
  instructions?: string;
  /**
   * MCP `_meta` to send with each `tools/call`, read at call time. Set only
   * for the host's own servers (see `registry.setHostServers`): the desktop's
   * browser tools must know which chat is calling so two chats — or a chat
   * and the browser copilot — each drive their own tab. A third-party server
   * is never told the session id.
   */
  callMeta?: () => Record<string, unknown> | undefined;
  /** `modern` (2026-07-28, per-request `_meta`) or `legacy` (initialize handshake). Set by `initialize()`. */
  era?: 'modern' | 'legacy';
  /** The revision in use: the modern one, or what the server answered to `initialize`. */
  protocolVersion?: string;
  /** The server's declared capabilities. Self-reported; used only to decide what to ask for. */
  serverCapabilities: Record<string, unknown> = {};
  /** Called when the server says its tool list changed (`notifications/tools/list_changed`). */
  onToolsChanged?: () => void;
  /**
   * Who answers an elicitation. Unset means the capability is not declared,
   * so a conforming server never asks, and one that asks anyway is declined.
   */
  elicit?: McpElicitationHandler;
  /** The deprecated HTTP+SSE transport is legacy by definition; it skips the probe. */
  protected legacyOnly = false;
  /** Tool input schemas from the last listing, for `x-mcp-header` mirroring on HTTP. */
  private headerSchemas = new Map<string, ReturnType<typeof headerParams>>();

  /** Send a JSON-RPC request and return the result. Throws `McpRpcError` for an error reply. */
  abstract send(method: string, params?: unknown, opts?: SendOptions): Promise<unknown>;

  /** Send a JSON-RPC notification: no id, no answer awaited. */
  abstract notify(method: string, params?: unknown): Promise<void>;

  /** Return true if the transport connection is usable */
  abstract isAlive(): boolean;

  /** Gracefully shut down the transport */
  abstract stop(): void;

  /** Current health status for the registry status bar */
  abstract getHealth(): McpHealthStatus;

  /** Whether `x-mcp-header` must be mirrored into HTTP headers (Streamable HTTP only). */
  protected mirrorsHeaders(): boolean {
    return false;
  }

  /** The capabilities this client declares. Elicitation only when someone can answer it. */
  protected clientCapabilities(): Record<string, unknown> {
    return this.elicit ? { elicitation: { form: {}, url: {} } } : {};
  }

  /** A request in whichever era this server speaks. */
  protected request(method: string, params: Record<string, unknown> = {}, opts?: SendOptions): Promise<unknown> {
    if (this.era !== 'modern') return this.send(method, params, opts);
    const own = (params._meta && typeof params._meta === 'object') ? params._meta as Record<string, unknown> : {};
    return this.send(method, { ...params, _meta: { ...own, ...modernMeta(this.protocolVersion!, this.clientCapabilities()) } }, opts);
  }

  async initialize(): Promise<void> {
    if (!this.legacyOnly && await this.probeModern()) {
      this.initialized = true;
      this.listenForChanges();
      return;
    }
    const result = await this.send('initialize', {
      protocolVersion: LEGACY_PROTOCOL,
      capabilities: this.clientCapabilities(),
      clientInfo: CLIENT_INFO,
    }) as ServerHello | undefined;
    this.era = 'legacy';
    this.protocolVersion = typeof result?.protocolVersion === 'string' ? result.protocolVersion : LEGACY_PROTOCOL;
    this.adopt(result);
    await this.sendNotification('notifications/initialized', {});
    this.initialized = true;
  }

  /** Probe for the modern revision. True when the server speaks it; false to fall back. */
  private async probeModern(): Promise<boolean> {
    let outcome: { result: unknown } | { error: unknown };
    try {
      outcome = {
        result: await this.send('server/discover', { _meta: modernMeta(MODERN_PROTOCOL, this.clientCapabilities()) }, { timeoutMs: PROBE_TIMEOUT_MS }),
      };
    } catch (error) {
      outcome = { error };
    }
    const verdict = classifyProbe(outcome);
    switch (verdict.kind) {
      case 'modern':
        this.era = 'modern';
        this.protocolVersion = verdict.version;
        if ('result' in outcome) this.adopt(outcome.result as ServerHello);
        else {
          // A modern error naming our version as supported is a transient
          // mismatch; ask once more so instructions and capabilities arrive.
          try { this.adopt(await this.request('server/discover') as ServerHello); } catch { /* the probe already proved the era */ }
        }
        return true;
      case 'legacy':
        return false;
      case 'incompatible':
        throw new Error(`The MCP server supports protocol revisions ${verdict.supported.join(', ')}; `
          + 'AICO speaks 2026-07-28 and the initialize-based revisions up to 2025-11-25, so they have none in common.');
      case 'rethrow':
        throw (outcome as { error: unknown }).error;
    }
  }

  private adopt(hello: ServerHello | undefined): void {
    if (typeof hello?.instructions === 'string' && hello.instructions.trim()) {
      this.instructions = hello.instructions.trim().slice(0, MAX_INSTRUCTIONS);
    }
    if (hello?.capabilities && typeof hello.capabilities === 'object') {
      this.serverCapabilities = hello.capabilities as Record<string, unknown>;
    }
  }

  /**
   * Modern servers announce list changes only on a `subscriptions/listen`
   * stream the client opened. On stdio that is one request left pending for
   * the life of the process; its notifications arrive like any other and go
   * through {@link handleServerMessage}. Over HTTP it would be a held-open
   * response this transport does not keep, so there the 30-second refresh
   * (registry health check) is what notices a change.
   */
  protected listenForChanges(): void {
    const tools = this.serverCapabilities.tools as { listChanged?: unknown } | undefined;
    if (this.era !== 'modern' || !tools?.listChanged || this.mirrorsHeaders()) return;
    this.request('subscriptions/listen', { notifications: { toolsListChanged: true } }, { timeoutMs: 0 })
      .catch(() => { /* ends with the process; the periodic refresh still runs */ });
  }

  /** Send a JSON-RPC notification (fire-and-forget) */
  protected async sendNotification(method: string, params: unknown): Promise<void> {
    try {
      await this.notify(method, params);
    } catch {
      // Notifications are fire-and-forget — ignore errors
    }
  }

  /**
   * A message the server started: a notification, or (legacy only) a request.
   * Transports call this for anything carrying a `method`. Returns the reply
   * for a request; undefined for a notification.
   *
   * Before this existed a server request was matched against the client's own
   * pending ids — a server's request number 1 could "answer" the client's
   * request number 1 with garbage.
   */
  protected handleServerMessage(msg: { id?: unknown; method: string; params?: unknown }):
    { result: unknown } | { error: { code: number; message: string } } | undefined {
    if (msg.id === undefined || msg.id === null) {
      if (msg.method === 'notifications/tools/list_changed') this.onToolsChanged?.();
      return undefined;
    }
    if (msg.method === 'ping') return { result: {} };
    // No sampling, roots or legacy elicitation is declared, so a conforming
    // server never sends these; one that does is told so rather than left hanging.
    return { error: { code: -32601, message: `AICO does not offer ${msg.method}` } };
  }

  async listTools(): Promise<McpTool[]> {
    type RawTool = {
      name: string; description?: string; inputSchema?: Record<string, unknown>; title?: string;
      annotations?: McpToolAnnotations; outputSchema?: Record<string, unknown>;
    };
    const raw: RawTool[] = [];
    let cursor: string | undefined;
    // Paginated listings were read as their first page only. Bounded, so a
    // server that keeps handing back a cursor cannot hold startup.
    for (let page = 0; page < 50; page++) {
      const result = (await this.request('tools/list', cursor ? { cursor } : {})) as { tools?: RawTool[]; nextCursor?: unknown };
      raw.push(...(result?.tools ?? []));
      cursor = typeof result?.nextCursor === 'string' && result.nextCursor ? result.nextCursor : undefined;
      if (!cursor) break;
    }
    this.headerSchemas.clear();
    const out: McpTool[] = [];
    for (const t of raw) {
      if (!t || typeof t.name !== 'string' || !t.name) continue;
      if (this.mirrorsHeaders() && this.era === 'modern') {
        // Streamable HTTP: a tool whose x-mcp-header annotations are invalid
        // must be left out of the list (transports/streamable-http).
        const params = headerParams(t.inputSchema ?? {});
        if ('invalid' in params) {
          process.stderr.write(`  ⚠ MCP tool "${t.name}" left out: ${params.invalid}\n`);
          continue;
        }
        if (params.params.length) this.headerSchemas.set(t.name, params);
      }
      out.push({
        name: t.name,
        description: t.description ?? '',
        inputSchema: t.inputSchema ?? {},
        execute: (args: Record<string, unknown>) => this.callTool(t.name, args),
        ...(typeof t.title === 'string' ? { title: t.title } : {}),
        ...(t.annotations && typeof t.annotations === 'object' ? { annotations: t.annotations } : {}),
        ...(t.outputSchema && typeof t.outputSchema === 'object' ? { outputSchema: t.outputSchema } : {}),
      });
    }
    return out;
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    const meta = this.callMeta?.();
    const base: Record<string, unknown> = { name, arguments: args, ...(meta ? { _meta: meta } : {}) };
    const header = this.headerSchemas.get(name);
    const opts: SendOptions | undefined = header && 'params' in header ? { headers: paramHeaders(header.params, args) } : undefined;
    let params = base;
    let result: ToolCallResult | undefined;
    /*
      Multi round-trip requests (2026-07-28): a server that needs input answers
      `input_required` with `inputRequests` and an opaque `requestState`, and
      the client retries the same call with `inputResponses` and that state
      echoed back untouched. Bounded, because a server may ask again forever.
    */
    for (let round = 0; ; round++) {
      result = (await this.request('tools/call', params, opts)) as ToolCallResult | undefined;
      if (result?.resultType !== 'input_required') break;
      if (round >= MAX_INPUT_ROUNDS) {
        throw new Error(`MCP tool ${name} still wanted more input after ${MAX_INPUT_ROUNDS} rounds; stopped.`);
      }
      const inputResponses = await this.answerInputRequests(name, result.inputRequests ?? {});
      params = {
        ...base,
        ...(Object.keys(inputResponses).length ? { inputResponses } : {}),
        ...(typeof result.requestState === 'string' ? { requestState: result.requestState } : {}),
      };
    }
    return this.renderResult(name, result);
  }

  private async answerInputRequests(
    tool: string,
    requests: NonNullable<ToolCallResult['inputRequests']>,
  ): Promise<Record<string, unknown>> {
    const out: Record<string, unknown> = {};
    for (const [key, req] of Object.entries(requests)) {
      if (req?.method !== 'elicitation/create') {
        throw new Error(`MCP tool ${tool} asked for ${String(req?.method)}, which AICO does not offer; the call was stopped.`);
      }
      const p = req.params ?? {};
      const ask: McpElicitation = {
        mode: p.mode === 'url' ? 'url' : 'form',
        message: String(p.message ?? '').slice(0, 2000),
        ...(typeof p.url === 'string' ? { url: p.url } : {}),
        ...(p.requestedSchema && typeof p.requestedSchema === 'object' ? { requestedSchema: p.requestedSchema as Record<string, unknown> } : {}),
      };
      let answer: McpElicitationAnswer = { action: 'decline' };
      if (this.elicit) {
        try { answer = await this.elicit(ask, { tool }); } catch { answer = { action: 'cancel' }; }
      }
      out[key] = answer;
    }
    return out;
  }

  private async renderResult(name: string, result: ToolCallResult | undefined): Promise<unknown> {
    const content = result?.content ?? [];
    const text = content.filter((c) => c.type === 'text').map((c) => c.text ?? '').join('\n');
    /*
      Structured output (`structuredContent`, with an `outputSchema`) is shown
      compactly in place of its text block, which by the spec is only a
      serialisation of the same thing for clients that cannot read it. A
      result without it reads as before.
    */
    let body = text;
    if (result?.structuredContent !== undefined && result.structuredContent !== null) {
      try { body = JSON.stringify(result.structuredContent); } catch { body = text; }
    }
    // A tool's own failure (`isError`) used to come back as an ordinary
    // result; thrown, it reaches the model as the error it is.
    if (result?.isError) throw new Error(body || `MCP tool ${name} reported an error with no message.`);

    /*
      Image content, which used to vanish.

      A browser tool's screenshot came back as `{ type: 'image', data }` beside
      a line of text; only the text survived, so the model was told a
      screenshot was taken and never shown it. Worse, a result that was *only*
      an image fell through to the raw object, and the model was handed the
      base64 as a wall of characters. Each image is now offered to the model
      the way a Read of a PNG is (see `tools/tool-images`), and the result says
      what became of it.
    */
    const images = mcpImages(content);
    if (images.length > 0) {
      const notes: string[] = [];
      for (const [index, image] of images.entries()) {
        const note = await offerToolImage({
          bytes: image.bytes,
          name: `${name}${images.length > 1 ? `-${index + 1}` : ''}`,
          origin: `MCP tool ${name}`,
        });
        notes.push(`[Image ${images.length > 1 ? `${index + 1} ` : ''}from ${name}] ${note}`);
      }
      return [body, ...notes].filter(Boolean).join('\n');
    }
    if (body) return body;
    // Nothing readable: hand back the result without the protocol bookkeeping.
    if (!result) return result;
    const rest: Record<string, unknown> = { ...result };
    delete rest.resultType;
    return rest;
  }

  async listResources(): Promise<McpResource[]> {
    try {
      const result = (await this.request('resources/list', {})) as {
        resources?: McpResource[];
      };
      return result?.resources ?? [];
    } catch {
      return [];
    }
  }

  async readResource(uri: string): Promise<McpResourceContent> {
    const result = (await this.request('resources/read', { uri })) as {
      contents?: Array<McpResourceContent>;
    };
    const contents = result?.contents ?? [];
    return contents[0] ?? { uri };
  }
}

export { McpRpcError };
