/**
 * The MCP wire rules that do not depend on a transport: which protocol
 * revisions AICO speaks, how a modern request is labelled, what a modern error
 * looks like, and the Streamable HTTP header encodings.
 *
 * Two eras have to be spoken at once. Revision 2026-07-28 is stateless: no
 * `initialize`, the version and the client's capabilities ride in every
 * request's `_meta`, `server/discover` is mandatory, and results carry a
 * `resultType`. Almost every server in the wild still speaks the
 * handshake-based revisions (2025-11-25 and earlier), so the client probes
 * with `server/discover` and falls back to `initialize` on any error that is
 * not a recognised modern one — never on one particular code, because legacy
 * servers answer unknown pre-initialize requests however they like (the spec's
 * own rule, transports/stdio "Backward Compatibility").
 *
 * Kept free of I/O so the negotiation rules can be tested without a server.
 *
 * @module mcp/protocol
 */

/** The modern revision AICO speaks. */
export const MODERN_PROTOCOL = '2026-07-28';
/** The newest handshake revision, offered in `initialize`; the server may answer with an older one. */
export const LEGACY_PROTOCOL = '2025-11-25';

/**
 * Error codes that only a modern server sends (HeaderMismatch,
 * MissingRequiredClientCapability, UnsupportedProtocolVersion). Seeing one
 * means "this server is modern — correct the request", never "fall back".
 */
export const MODERN_ERROR_CODES: ReadonlySet<number> = new Set([-32020, -32021, -32022]);
export const UNSUPPORTED_PROTOCOL_VERSION = -32022;

/** How long the era probe waits before deciding a silent server is legacy. */
export const PROBE_TIMEOUT_MS = 5_000;

export const CLIENT_INFO = { name: 'aico', version: '1.0.0' } as const;

/** A JSON-RPC error a server returned, with its code and data kept. */
export class McpRpcError extends Error {
  constructor(
    message: string,
    readonly code?: number,
    readonly data?: unknown,
    /** The HTTP status, when the error came back over HTTP. */
    readonly httpStatus?: number,
  ) {
    super(message);
    this.name = 'McpRpcError';
  }
}

/** A request that got no answer in time. Separate so the era probe can tell silence from a crash. */
export class McpTimeoutError extends Error {
  constructor(method: string) {
    super(`MCP timeout: ${method}`);
    this.name = 'McpTimeoutError';
  }
}

/** Whether an error is one a modern server sends (see {@link MODERN_ERROR_CODES}). */
export function isModernError(err: unknown): err is McpRpcError {
  return err instanceof McpRpcError && err.code !== undefined && MODERN_ERROR_CODES.has(err.code);
}

/**
 * What an answer to the `server/discover` probe means.
 *
 * - `modern`: the server speaks 2026-07-28 — use it.
 * - `legacy`: fall back to `initialize`. Any non-modern error or silence; also
 *   a dual-era server that rejected the modern version but lists a handshake one.
 * - `incompatible`: a modern server with no version AICO speaks — an
 *   actionable error, not a fallback that would fail more confusingly.
 * - `rethrow`: the transport itself failed (process died, connection refused).
 */
export type ProbeVerdict =
  | { kind: 'modern'; version: string }
  | { kind: 'legacy' }
  | { kind: 'incompatible'; supported: string[] }
  | { kind: 'rethrow' };

export function classifyProbe(outcome: { result: unknown } | { error: unknown }): ProbeVerdict {
  if ('result' in outcome) {
    const r = outcome.result as { supportedVersions?: unknown } | undefined;
    const supported = Array.isArray(r?.supportedVersions) ? r!.supportedVersions.map(String) : [];
    // An answer that is not a DiscoverResult came from a legacy server that
    // happened to reply to an unknown method with something; treat it as one.
    if (supported.length === 0) return { kind: 'legacy' };
    if (supported.includes(MODERN_PROTOCOL)) return { kind: 'modern', version: MODERN_PROTOCOL };
    return supported.some(isLegacyVersion) ? { kind: 'legacy' } : { kind: 'incompatible', supported };
  }
  const err = outcome.error;
  if (isModernError(err)) {
    const data = err.data as { supported?: unknown } | undefined;
    const supported = Array.isArray(data?.supported) ? data!.supported.map(String) : [];
    if (supported.includes(MODERN_PROTOCOL)) return { kind: 'modern', version: MODERN_PROTOCOL };
    return supported.some(isLegacyVersion) ? { kind: 'legacy' } : { kind: 'incompatible', supported };
  }
  if (err instanceof McpRpcError || err instanceof McpTimeoutError) return { kind: 'legacy' };
  return { kind: 'rethrow' };
}

/** A handshake-era revision (anything dated up to 2025-11-25). */
export function isLegacyVersion(version: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(version) && version <= LEGACY_PROTOCOL;
}

/** The `_meta` every modern request carries. */
export function modernMeta(version: string, capabilities: Record<string, unknown>): Record<string, unknown> {
  return {
    'io.modelcontextprotocol/protocolVersion': version,
    'io.modelcontextprotocol/clientInfo': CLIENT_INFO,
    'io.modelcontextprotocol/clientCapabilities': capabilities,
  };
}

/** The protocol version a request declares in its `_meta`, if it is a modern request. */
export function declaredVersion(params: unknown): string | undefined {
  const meta = (params as { _meta?: Record<string, unknown> } | undefined)?._meta;
  const v = meta?.['io.modelcontextprotocol/protocolVersion'];
  return typeof v === 'string' ? v : undefined;
}

// ── Streamable HTTP header encoding ───────────────────────────────────

/**
 * A header value as the transport requires: plain when it is printable ASCII
 * with no edge whitespace, otherwise the `=?base64?…?=` sentinel. A plain value
 * that already looks like the sentinel is encoded too, so it cannot be misread.
 */
export function encodeHeaderValue(value: string): string {
  const plain = /^[\x21-\x7e]([\x20-\x7e\t]*[\x21-\x7e])?$/.test(value)
    && !(value.startsWith('=?base64?') && value.endsWith('?='));
  return plain ? value : `=?base64?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}

/** Methods whose `Mcp-Name` header is required, and where it comes from. */
const NAME_FROM: Record<string, 'name' | 'uri'> = { 'tools/call': 'name', 'prompts/get': 'name', 'resources/read': 'uri' };

/** The standard headers for one modern POST. Empty for a legacy request. */
export function standardHeaders(method: string, params: unknown): Record<string, string> {
  const version = declaredVersion(params);
  if (!version) return {};
  const headers: Record<string, string> = { 'MCP-Protocol-Version': version, 'Mcp-Method': method };
  const field = NAME_FROM[method];
  const value = field ? (params as Record<string, unknown>)[field] : undefined;
  if (typeof value === 'string') headers['Mcp-Name'] = encodeHeaderValue(value);
  return headers;
}

const TOKEN_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

interface HeaderParam { header: string; path: string[] }

/**
 * The `x-mcp-header` parameters of a tool's input schema, or a reason the
 * definition is invalid. Only chains of `properties` count; an annotation
 * anywhere else, on a non-primitive or `number` type, with a non-token name or
 * a duplicate name makes the whole tool invalid (and a Streamable HTTP client
 * must then leave it out of the list).
 */
export function headerParams(schema: unknown): { params: HeaderParam[] } | { invalid: string } {
  const params: HeaderParam[] = [];
  const seen = new Set<string>();
  let invalid: string | undefined;
  const visit = (node: unknown, trail: string[], reachable: boolean): void => {
    if (invalid || !node || typeof node !== 'object') return;
    const obj = node as Record<string, unknown>;
    if ('x-mcp-header' in obj) {
      const name = obj['x-mcp-header'];
      const type = obj['type'];
      if (!reachable || trail.length === 0) { invalid = 'x-mcp-header outside a chain of properties'; return; }
      if (typeof name !== 'string' || !TOKEN_RE.test(name)) { invalid = `x-mcp-header "${String(name)}" is not a header token`; return; }
      if (!['string', 'integer', 'boolean'].includes(String(type))) { invalid = `x-mcp-header "${name}" is on a ${String(type)} parameter`; return; }
      if (seen.has(name.toLowerCase())) { invalid = `x-mcp-header "${name}" is used twice`; return; }
      seen.add(name.toLowerCase());
      params.push({ header: name, path: trail });
    }
    for (const [key, value] of Object.entries(obj)) {
      if (key === 'properties' && value && typeof value === 'object') {
        for (const [prop, sub] of Object.entries(value as Record<string, unknown>)) visit(sub, [...trail, prop], reachable);
      } else if (value && typeof value === 'object') {
        // Anything reached through items, oneOf, $defs, … is not statically reachable.
        if (Array.isArray(value)) value.forEach(v => visit(v, trail, false));
        else visit(value, trail, false);
      }
    }
  };
  visit(schema, [], true);
  return invalid ? { invalid } : { params };
}

/** The `Mcp-Param-*` headers for one call's arguments. */
export function paramHeaders(params: readonly HeaderParam[], args: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of params) {
    let value: unknown = args;
    for (const key of p.path) value = value && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined;
    if (value === undefined || value === null) continue;
    if (typeof value === 'string') out[`Mcp-Param-${p.header}`] = encodeHeaderValue(value);
    else if (typeof value === 'boolean' || (typeof value === 'number' && Number.isSafeInteger(value))) out[`Mcp-Param-${p.header}`] = String(value);
  }
  return out;
}
