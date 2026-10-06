import { vi } from 'vitest';
import type { Attachment, AuditLine, Features, Page, Task, User } from '../api';

/**
 * A scriptable stand-in for the API, installed as the global `fetch`. A test registers handlers by
 * "METHOD /path" (query string ignored unless the key includes it) and can read every call made, so
 * it can assert on what the screen sent as well as on what it showed.
 */
export interface Call {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

type Handler = (call: Call) => Response | Promise<Response>;

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': status >= 400 ? 'application/problem+json' : 'application/json' },
  });
}

export function problem(status: number, code: string, detail: string, errors: unknown[] = []) {
  return json(
    { type: `urn:problem-type:${code}`, title: 'Error', status, detail, code, errors },
    status,
  );
}

export function installFakeApi(handlers: Record<string, Handler>) {
  const calls: Call[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const raw = init?.body;
    const body = typeof raw === 'string' ? JSON.parse(raw) : raw;
    const call: Call = { method, url, headers, body };
    calls.push(call);
    const path = url.split('?')[0];
    const handler = handlers[`${method} ${url}`] ?? handlers[`${method} ${path}`];
    if (!handler) return problem(599, 'unhandled', `No fake for ${method} ${url}`);
    return handler(call);
  });
  vi.stubGlobal('fetch', fetchMock);
  return { calls, fetchMock };
}

export const member: User = {
  id: '11111111-1111-4111-8111-111111111111',
  email: 'bob@example.com',
  name: 'Bob Member',
  roles: ['MEMBER'],
};

export const admin: User = {
  id: '22222222-2222-4222-8222-222222222222',
  email: 'alice@example.com',
  name: 'Alice Admin',
  roles: ['MEMBER', 'ADMIN'],
};

export const features: Features = {
  attachmentsEnabled: true,
  maxOpenTasksPerUser: 25,
  emailNotificationsEnabled: true,
};

export function signedIn(user: User, overrides: Partial<Features> = {}) {
  return json({ authenticated: true, user, features: { ...features, ...overrides } });
}

export const anonymous = () => json({ authenticated: false, user: null, features: null });

export function task(overrides: Partial<Task> = {}): Task {
  return {
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    title: 'Write the report',
    description: null,
    status: 'OPEN',
    assigneeEmail: null,
    createdAt: '2026-10-06T10:00:00Z',
    updatedAt: '2026-10-06T10:00:00Z',
    version: 0,
    ...overrides,
  };
}

export function page<T>(items: T[], extra: Partial<Page<T>> = {}): Page<T> {
  return {
    items,
    page: 0,
    size: 10,
    totalElements: items.length,
    totalPages: items.length === 0 ? 0 : 1,
    ...extra,
  };
}

export function attachment(overrides: Partial<Attachment> = {}): Attachment {
  return {
    id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    fileName: 'notes.txt',
    contentType: 'text/plain',
    sizeBytes: 2048,
    createdAt: '2026-10-06T10:00:00Z',
    ...overrides,
  };
}

export function auditLine(overrides: Partial<AuditLine> = {}): AuditLine {
  return {
    id: 1,
    occurredAt: '2026-10-06T10:00:00Z',
    actorLabel: 'bob@example.com',
    action: 'task.created',
    targetId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    detail: { title: 'Write the report' },
    requestId: null,
    ...overrides,
  };
}
