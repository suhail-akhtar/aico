/**
 * An executable copy of the gateway-plus-API contract, small enough to read.
 *
 * Why it exists: the app talks to a BFF gateway (session cookie, CSRF header,
 * `/api/auth/*`) in front of an API (`openapi/openapi.json`). Two things need
 * that to be real without a stack: `npm run dev` (so the first run shows a
 * working app) and the end-to-end suite in this repository's CI. The same
 * implementation also backs the unit tests (MSW forwards every request to it),
 * so one file defines "what the backend does" for all three. Its output is
 * validated against the zod schemas generated from the contract by a unit
 * test, so it cannot drift quietly from `openapi.json`.
 *
 * It is written against the Fetch API (`Request` in, `Response` out) so it runs
 * unchanged in Vitest, behind MSW, and in the Vite dev/preview server (the Node
 * adapter lives in `vite-plugin.ts`).
 *
 * What it deliberately is not: a security reference. The session store is a
 * Map, passwords are compared directly, and the "identity provider" is a form.
 * In the real stack Keycloak, oauth2-proxy and the API do those jobs.
 */

import { securityHeaders } from './security-headers.ts';

export interface MockUser {
  email: string;
  /** Test-only credential for the mock sign-in page. */
  password: string;
}

export interface MockOptions {
  now?: () => Date;
  newId?: () => string;
  users?: MockUser[];
}

interface StoredItem {
  id: string;
  seq: number;
  ownerId: string;
  name: string;
  description: string | null;
  quantity: number;
  created_at: string;
  updated_at: string;
}

interface FieldError {
  field: string;
  message: string;
}

export const MOCK_CSRF_HEADER = 'x-requested-with';
export const MOCK_CSRF_VALUE = 'fetch';
export const SESSION_COOKIE = 'mock_session';
// A mock credential for a form on a mock page; not a secret. standards-allow: secret
export const DEFAULT_USERS: MockUser[] = [
  { email: 'dev@example.com', password: 'dev-password' }, // standards-allow: secret
  { email: 'other@example.com', password: 'other-password' }, // standards-allow: secret
];

const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function headers(extra: Record<string, string> = {}): Headers {
  const h = new Headers({ ...securityHeaders, 'Cache-Control': 'no-store' });
  for (const [k, v] of Object.entries(extra)) h.set(k, v);
  return h;
}

export function problem(
  status: number,
  title: string,
  detail?: string,
  errors?: FieldError[],
): Response {
  const body = {
    type: `urn:problem:${title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
    title,
    status,
    ...(detail ? { detail } : {}),
    ...(errors ? { errors } : {}),
  };
  return new Response(JSON.stringify(body), {
    status,
    headers: headers({ 'Content-Type': 'application/problem+json' }),
  });
}

function json(status: number, body: unknown, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: headers({ 'Content-Type': 'application/json', ...extra }),
  });
}

/** Only a same-site absolute path may be a redirect target: no scheme, no `//host`. */
export function safePath(value: string | null | undefined, fallback = '/'): string {
  if (!value?.startsWith('/') || value.startsWith('//') || value.includes('\\')) return fallback;
  for (const char of value) if (char.charCodeAt(0) < 0x20) return fallback;
  return value;
}

function redirect(location: string, extra: Record<string, string> = {}): Response {
  return new Response(null, { status: 302, headers: headers({ Location: location, ...extra }) });
}

function cookies(request: Request): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of (request.headers.get('cookie') ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out.set(part.slice(0, i).trim(), part.slice(i + 1).trim());
  }
  return out;
}

const escapeHtml = (s: string): string => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function loginPage(rd: string, error?: string): Response {
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sign in (mock identity provider)</title><link rel="stylesheet" href="/mock-idp/style.css"></head>
<body><main><h1>Sign in</h1>
<p class="note">Mock identity provider for local development. The real stack uses Keycloak.</p>
${error ? `<p id="input-error" role="alert">${escapeHtml(error)}</p>` : ''}
<form method="post" action="/mock-idp/login">
<input type="hidden" name="rd" value="${escapeHtml(rd)}">
<label for="username">Email</label><input id="username" name="username" type="email" autocomplete="username" required>
<label for="password">Password</label><input id="password" name="password" type="password" autocomplete="current-password" required>
<button id="kc-login" type="submit">Sign in</button></form></main></body></html>`;
  return new Response(html, {
    status: error ? 401 : 200,
    headers: headers({ 'Content-Type': 'text/html; charset=utf-8' }),
  });
}

const LOGIN_CSS = `body{font-family:system-ui,sans-serif;background:#f5f6f8;color:#111;margin:0}
main{max-width:22rem;margin:4rem auto;padding:1.5rem;background:#fff;border:1px solid #d4d7dd;border-radius:.5rem}
label{display:block;margin-top:1rem;font-weight:600}input{width:100%;box-sizing:border-box;padding:.5rem;margin-top:.25rem}
button{margin-top:1.5rem;padding:.6rem 1rem;background:#1d4ed8;color:#fff;border:0;border-radius:.375rem;font-size:1rem}
.note{color:#4b5563;font-size:.9rem}#input-error{color:#b91c1c;font-weight:600}`;

function validateItemBody(raw: unknown): {
  value?: Pick<StoredItem, 'name' | 'description' | 'quantity'>;
  errors: FieldError[];
} {
  const errors: FieldError[] = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { errors: [{ field: 'body', message: 'Expected a JSON object.' }] };
  }
  const body = raw as Record<string, unknown>;
  for (const key of Object.keys(body)) {
    if (!['name', 'description', 'quantity'].includes(key)) {
      errors.push({ field: key, message: 'Unknown field.' });
    }
  }
  const name = typeof body.name === 'string' ? body.name.trim() : undefined;
  if (name === undefined || name.length < 1)
    errors.push({ field: 'name', message: 'Name is required.' });
  else if (name.length > 120)
    errors.push({ field: 'name', message: 'Name must be at most 120 characters.' });
  let description: string | null = null;
  if (body.description !== undefined && body.description !== null) {
    if (typeof body.description !== 'string')
      errors.push({ field: 'description', message: 'Must be text.' });
    else if (body.description.trim().length > 1000)
      errors.push({
        field: 'description',
        message: 'Description must be at most 1000 characters.',
      });
    else description = body.description.trim() || null;
  }
  let quantity = 0;
  if (body.quantity !== undefined) {
    if (typeof body.quantity !== 'number' || !Number.isInteger(body.quantity))
      errors.push({ field: 'quantity', message: 'Must be a whole number.' });
    else if (body.quantity < 0 || body.quantity > 1_000_000)
      errors.push({ field: 'quantity', message: 'Must be between 0 and 1000000.' });
    else quantity = body.quantity;
  }
  if (errors.length > 0 || name === undefined) return { errors };
  return { value: { name, description, quantity }, errors };
}

export interface MockStack {
  /** Answers a request, or `undefined` when the path is not one this stack owns (a static file). */
  handle(request: Request): Promise<Response | undefined>;
  /** Forget every session and item (and any impersonation). */
  reset(): void;
  /**
   * Test hook: treat every request as this user (or as signed out with `undefined`). A
   * test runner's `fetch` carries no cookies, so a session cookie cannot be used there.
   */
  impersonate(email: string | undefined): void;
  /** The id the stack gave a user, for assertions. */
  idOf(email: string): string | undefined;
}

export function createMockStack(options: MockOptions = {}): MockStack {
  const now = options.now ?? (() => new Date());
  const newId = options.newId ?? (() => crypto.randomUUID());
  const users = (options.users ?? DEFAULT_USERS).map((u) => ({ ...u, id: newId() }));
  const sessions = new Map<string, string>();
  let items: StoredItem[] = [];
  let seq = 0;
  let impersonated: string | undefined;

  const userFor = (request: Request) => {
    if (impersonated) return users.find((u) => u.email === impersonated);
    const token = cookies(request).get(SESSION_COOKIE);
    const id = token ? sessions.get(token) : undefined;
    return users.find((u) => u.id === id);
  };

  async function api(request: Request, url: URL): Promise<Response> {
    const user = userFor(request);
    if (!user) return problem(401, 'Unauthorized', 'No valid session.');
    if (UNSAFE.has(request.method) && request.headers.get(MOCK_CSRF_HEADER) !== MOCK_CSRF_VALUE) {
      return problem(403, 'Forbidden', 'Missing the X-Requested-With: fetch header.');
    }
    const path = url.pathname.replace(/^\/api\/v1/, '');
    if (path === '/auth/me' && request.method === 'GET')
      return json(200, { id: user.id, email: user.email });

    const mine = items.filter((i) => i.ownerId === user.id);
    const expose = ({ seq: _s, ownerId: _o, ...rest }: StoredItem) => rest;

    if (path === '/items') {
      if (request.method === 'GET') {
        const limitParam = url.searchParams.get('limit');
        const limit = limitParam === null ? 50 : Number(limitParam);
        if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
          return problem(400, 'Bad Request', 'limit must be between 1 and 100.', [
            { field: 'limit', message: 'Must be between 1 and 100.' },
          ]);
        }
        const cursor = url.searchParams.get('cursor');
        let before = Number.POSITIVE_INFINITY;
        if (cursor) {
          before = decodeCursor(cursor);
          if (!Number.isFinite(before))
            return problem(400, 'Bad Request', 'Invalid cursor.', [
              { field: 'cursor', message: 'Invalid cursor.' },
            ]);
        }
        const sorted = mine.filter((i) => i.seq < before).sort((a, b) => b.seq - a.seq);
        const page = sorted.slice(0, limit);
        const more = sorted.length > limit;
        const last = page.at(-1);
        return json(200, {
          items: page.map(expose),
          next_cursor: more && last ? encodeCursor(last.seq) : null,
        });
      }
      if (request.method === 'POST') {
        const parsed = await readJson(request);
        if (!parsed.ok) return problem(400, 'Bad Request', 'The body is not valid JSON.');
        const { value, errors } = validateItemBody(parsed.value);
        if (!value) return problem(422, 'Unprocessable Content', 'The item is invalid.', errors);
        const at = now().toISOString();
        const item: StoredItem = {
          id: newId(),
          seq: ++seq,
          ownerId: user.id,
          ...value,
          created_at: at,
          updated_at: at,
        };
        items.push(item);
        return json(201, expose(item), { Location: `/api/v1/items/${item.id}` });
      }
      return problem(405, 'Method Not Allowed');
    }

    const m = /^\/items\/([^/]+)$/.exec(path);
    if (m) {
      const id = m[1] ?? '';
      const found = UUID.test(id) ? mine.find((i) => i.id === id) : undefined;
      if (!found) return problem(404, 'Not Found', 'No such item.');
      if (request.method === 'GET') return json(200, expose(found));
      if (request.method === 'PUT') {
        const parsed = await readJson(request);
        if (!parsed.ok) return problem(400, 'Bad Request', 'The body is not valid JSON.');
        const { value, errors } = validateItemBody(parsed.value);
        if (!value) return problem(422, 'Unprocessable Content', 'The item is invalid.', errors);
        Object.assign(found, value, { updated_at: now().toISOString() });
        return json(200, expose(found));
      }
      if (request.method === 'DELETE') {
        items = items.filter((i) => i.id !== found.id);
        return new Response(null, { status: 204, headers: headers() });
      }
      return problem(405, 'Method Not Allowed');
    }
    return problem(404, 'Not Found', 'No such operation.');
  }

  async function handle(request: Request): Promise<Response | undefined> {
    const url = new URL(request.url);
    const p = url.pathname;
    if (p === '/api/auth/start' && request.method === 'GET') {
      return redirect(
        `/mock-idp/login?rd=${encodeURIComponent(safePath(url.searchParams.get('rd')))}`,
      );
    }
    if (p === '/api/auth/sign_out' && request.method === 'GET') {
      const token = cookies(request).get(SESSION_COOKIE);
      if (token) sessions.delete(token);
      return redirect(safePath(url.searchParams.get('rd')), {
        'Set-Cookie': `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`,
      });
    }
    if (p === '/mock-idp/style.css') {
      return new Response(LOGIN_CSS, {
        headers: headers({ 'Content-Type': 'text/css; charset=utf-8' }),
      });
    }
    if (p === '/mock-idp/login' && request.method === 'GET') {
      return loginPage(safePath(url.searchParams.get('rd')));
    }
    if (p === '/mock-idp/login' && request.method === 'POST') {
      const form = new URLSearchParams(await request.text());
      const rd = safePath(form.get('rd'));
      const user = users.find(
        (u) => u.email === form.get('username') && u.password === form.get('password'),
      );
      if (!user) return loginPage(rd, 'Invalid username or password.');
      const token = newId();
      sessions.set(token, user.id);
      return redirect(rd, {
        'Set-Cookie': `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax`,
      });
    }
    if (p.startsWith('/api/v1/')) return api(request, url);
    if (p.startsWith('/api/')) return problem(404, 'Not Found', 'No such operation.');
    return undefined;
  }

  return {
    handle,
    reset() {
      sessions.clear();
      items = [];
      seq = 0;
      impersonated = undefined;
    },
    impersonate(email) {
      impersonated = email;
    },
    idOf: (email) => users.find((u) => u.email === email)?.id,
  };
}

const encodeCursor = (n: number): string =>
  btoa(String(n)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
function decodeCursor(value: string): number {
  try {
    return Number(atob(value.replace(/-/g, '+').replace(/_/g, '/')));
  } catch {
    return Number.NaN;
  }
}

async function readJson(request: Request): Promise<{ ok: true; value: unknown } | { ok: false }> {
  try {
    return { ok: true, value: await request.json() };
  } catch {
    return { ok: false };
  }
}
