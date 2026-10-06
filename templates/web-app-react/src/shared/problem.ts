/**
 * Turns whatever a failed request returned into one `ApiError` the UI can use.
 *
 * Why: the backends all answer RFC 9457 problem details, but not identically
 * (FastAPI and Go list field errors as `[{loc|field, message}]`, ASP.NET as
 * `{field: [messages]}`), and the gateway in front can answer with plain text
 * (an oauth2-proxy 401) or nothing (a network failure). Screens should not
 * care: they get a status, a human title, an optional detail, and a map from
 * form field to message.
 *
 * What it does not do: translate server text. `title` and `detail` are shown
 * as the server wrote them; the app's own messages come from the catalogue.
 */

export class ApiError extends Error {
  readonly status: number;
  readonly title: string;
  readonly detail: string | undefined;
  readonly requestId: string | undefined;
  /** Lower-cased field name (the last path segment) to its first message. */
  readonly fieldErrors: Readonly<Record<string, string>>;

  constructor(init: {
    status: number;
    title: string;
    detail?: string | undefined;
    requestId?: string | undefined;
    fieldErrors?: Record<string, string>;
  }) {
    super(init.detail ?? init.title);
    this.name = 'ApiError';
    this.status = init.status;
    this.title = init.title;
    this.detail = init.detail;
    this.requestId = init.requestId;
    this.fieldErrors = init.fieldErrors ?? {};
  }

  get isUnauthorized(): boolean {
    return this.status === 401;
  }

  /** Status 0 means the request never got an answer (offline, DNS, CORS, refused). */
  get isNetwork(): boolean {
    return this.status === 0;
  }
}

const LOCATION_PREFIXES = new Set(['body', 'query', 'path', 'header']);

function fieldKey(entry: Record<string, unknown>): string | undefined {
  if (typeof entry.field === 'string' && entry.field) {
    return entry.field.split('.').at(-1)?.toLowerCase();
  }
  if (Array.isArray(entry.loc)) {
    const parts = entry.loc.map(String).filter((p, i) => !(i === 0 && LOCATION_PREFIXES.has(p)));
    return parts.at(-1)?.toLowerCase();
  }
  return undefined;
}

/** Accepts the array shape and the `{field: [messages]}` shape; ignores anything else. */
export function normalizeFieldErrors(errors: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (Array.isArray(errors)) {
    for (const entry of errors) {
      if (!entry || typeof entry !== 'object') continue;
      const key = fieldKey(entry as Record<string, unknown>);
      const message = (entry as Record<string, unknown>).message;
      if (key && typeof message === 'string' && !(key in out)) out[key] = message;
    }
  } else if (errors && typeof errors === 'object') {
    for (const [name, messages] of Object.entries(errors)) {
      const first = Array.isArray(messages) ? messages[0] : messages;
      const key = name.split('.').at(-1)?.toLowerCase();
      if (key && typeof first === 'string' && !(key in out)) out[key] = first;
    }
  }
  return out;
}

const text = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

/** A short plain-text body (a proxy's "Unauthorized"); never markup. */
function plainText(body: unknown): string | undefined {
  return typeof body === 'string' && body && !body.trimStart().startsWith('<')
    ? body.slice(0, 200)
    : undefined;
}

export function parseProblem(status: number, body: unknown, requestId?: string | null): ApiError {
  const obj = body && typeof body === 'object' ? (body as Record<string, unknown>) : undefined;
  const title = text(obj?.title) ?? (status === 0 ? 'Network error' : `HTTP ${status}`);
  return new ApiError({
    status,
    title,
    detail: text(obj?.detail) ?? plainText(body),
    requestId: text(obj?.request_id) ?? text(requestId ?? undefined),
    fieldErrors: normalizeFieldErrors(obj?.errors),
  });
}
