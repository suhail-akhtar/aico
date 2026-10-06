/**
 * The browser's whole conversation with the API: one small typed client over `fetch`.
 *
 * The session is a cookie the browser keeps and the API owns (backend-for-frontend, RFC 10017): this
 * code never sees a token, so there is nothing for a script injected into the page to steal. Because
 * a cookie is sent automatically, every request that changes state also carries the CSRF token the
 * API handed out in the `XSRF-TOKEN` cookie, in the `X-XSRF-TOKEN` header; a page on another site
 * can send the cookie but cannot read it, so it cannot add the header.
 *
 * Errors are RFC 9457 problem documents; they become {@link ApiError} so a screen can show the
 * `detail` and the per-field `errors` without parsing anything.
 */

export interface FieldError {
  field: string;
  message: string;
}

export interface User {
  id: string;
  email: string | null;
  name: string;
  roles: string[];
}

export interface Features {
  attachmentsEnabled: boolean;
  maxOpenTasksPerUser: number;
  emailNotificationsEnabled: boolean;
}

export interface Session {
  authenticated: boolean;
  user: User | null;
  features: Features | null;
}

export type TaskStatus = 'OPEN' | 'DONE';

export interface Task {
  id: string;
  title: string;
  description: string | null;
  status: TaskStatus;
  assigneeEmail: string | null;
  createdAt: string;
  updatedAt: string;
  version: number;
}

export interface NewTask {
  title: string;
  description?: string | null;
  assigneeEmail?: string | null;
}

export interface Attachment {
  id: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  createdAt: string;
}

export interface Page<T> {
  items: T[];
  page: number;
  size: number;
  totalElements: number;
  totalPages: number;
}

export interface AuditLine {
  id: number;
  occurredAt: string;
  actorLabel: string;
  action: string;
  targetId: string;
  detail: Record<string, unknown>;
  requestId: string | null;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly errors: FieldError[];
  readonly requestId: string | null;

  constructor(
    status: number,
    code: string,
    detail: string,
    errors: FieldError[],
    requestId: string | null,
  ) {
    super(detail);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.errors = errors;
    this.requestId = requestId;
  }

  get isUnauthorized(): boolean {
    return this.status === 401;
  }
}

const CSRF_COOKIE = 'XSRF-TOKEN';
const CSRF_HEADER = 'X-XSRF-TOKEN';

function csrfToken(): string | null {
  for (const part of document.cookie.split(';')) {
    const [name, ...value] = part.trim().split('=');
    if (name === CSRF_COOKIE) return decodeURIComponent(value.join('='));
  }
  return null;
}

async function problemFrom(response: Response): Promise<ApiError> {
  let body: Record<string, unknown> = {};
  try {
    body = (await response.json()) as Record<string, unknown>;
  } catch {
    // Not JSON (a proxy error page, say): fall back to the status line.
  }
  const detail =
    typeof body.detail === 'string' ? body.detail : response.statusText || 'Request failed';
  const code = typeof body.code === 'string' ? body.code : 'error';
  const errors = Array.isArray(body.errors) ? (body.errors as FieldError[]) : [];
  const requestId = typeof body.requestId === 'string' ? body.requestId : null;
  return new ApiError(response.status, code, detail, errors, requestId);
}

interface RequestOptions {
  json?: unknown;
  raw?: { body: Blob; contentType: string };
}

async function request<T>(method: string, path: string, options: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  let body: BodyInit | undefined;
  if (options.json !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(options.json);
  } else if (options.raw) {
    headers['Content-Type'] = options.raw.contentType;
    body = options.raw.body;
  }
  if (method !== 'GET') {
    const token = csrfToken();
    if (token) headers[CSRF_HEADER] = token;
  }
  const response = await fetch(path, { method, headers, body, credentials: 'same-origin' });
  if (!response.ok) throw await problemFrom(response);
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

function query(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : '';
}

export const api = {
  session: () => request<Session>('GET', '/api/v1/session'),

  /** Ends the session; resolves to the identity provider URL the browser must visit next. */
  logout: async () =>
    (await request<{ redirect: string }>('POST', '/api/v1/session/logout')).redirect,

  listTasks: (params: { page?: number; size?: number; status?: TaskStatus | ''; q?: string }) =>
    request<Page<Task>>('GET', `/api/v1/tasks${query(params)}`),
  createTask: (task: NewTask) => request<Task>('POST', '/api/v1/tasks', { json: task }),
  completeTask: (id: string) => request<Task>('POST', `/api/v1/tasks/${id}/complete`),
  deleteTask: (id: string) => request<void>('DELETE', `/api/v1/tasks/${id}`),

  listAttachments: (taskId: string) =>
    request<Attachment[]>('GET', `/api/v1/tasks/${taskId}/attachments`),
  uploadAttachment: (taskId: string, file: File) =>
    request<Attachment>(
      'POST',
      `/api/v1/tasks/${taskId}/attachments${query({ name: file.name })}`,
      { raw: { body: file, contentType: file.type || 'application/octet-stream' } },
    ),
  deleteAttachment: (taskId: string, id: string) =>
    request<void>('DELETE', `/api/v1/tasks/${taskId}/attachments/${id}`),
  attachmentUrl: (taskId: string, id: string) => `/api/v1/tasks/${taskId}/attachments/${id}`,

  adminTasks: (page: number) =>
    request<Page<Task>>('GET', `/api/v1/admin/tasks${query({ page, size: 10 })}`),
  audit: (page: number) =>
    request<Page<AuditLine>>('GET', `/api/v1/admin/audit${query({ page, size: 10 })}`),
};

/** Where the browser goes to sign in: the API starts the OpenID Connect flow. */
export const SIGN_IN_URL = '/oauth2/authorization/keycloak';
