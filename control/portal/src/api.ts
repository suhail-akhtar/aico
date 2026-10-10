/**
 * The portal's one door to the server. Same origin, cookie session; every
 * state-changing call carries the CSRF token the server gave `/v1/me`.
 */

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly data: Record<string, unknown> = {}) { super(message); }
}

let csrf = '';
export const setCsrf = (t: string): void => { csrf = t; };

export async function api<T = Record<string, unknown>>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const method = init.method ?? 'GET';
  const res = await fetch(path, {
    method,
    headers: { accept: 'application/json', ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}), ...(method !== 'GET' ? { 'x-csrf-token': csrf } : {}) },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    credentials: 'same-origin',
  });
  const text = await res.text();
  let data: Record<string, unknown> = {};
  try { data = JSON.parse(text) as Record<string, unknown>; } catch { /* not json */ }
  if (!res.ok) throw new ApiError(res.status, String(data.error ?? 'error'), String(data.message ?? `Request failed (${res.status})`), data);
  return data as T;
}

export interface Me {
  user: { id: string; email: string; name: string; role: string; teamId: string | null };
  tenant: { slug: string; name: string };
  permissions: string[];
  portal: boolean;
  csrf: string;
}

export const can = (me: Me, perm: string): boolean => me.permissions.includes(perm);

export const fmtTime = (ms: number | null | undefined): string => (ms ? new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '-');
export const fmtUsd = (n: number): string => `$${n < 10 ? n.toFixed(2) : n.toFixed(0)}`;
export const ago = (ms: number | null | undefined): string => {
  if (!ms) return 'never';
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 90) return 'just now';
  if (s < 5400) return `${Math.round(s / 60)} min ago`;
  if (s < 129600) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
};
