/**
 * HTTP routes the desktop, web and VS Code settings use to show and manage the
 * organisation sign-in (ADR 0040).
 *
 *   GET  /api/control          token         is this engine managed, by whom, as what role, how fresh
 *   POST /api/control/login    token+human   start the device flow; returns the code and where to type it
 *   GET  /api/control/login    token         poll that sign-in (pending | done | error)
 *   POST /api/control/sync     token         fetch policy / push audit now (can only tighten)
 *   POST /api/control/logout   token+human   sign out here
 *
 * Why sign-in and sign-out need a person: signing OUT removes the organisation's
 * restrictions from this engine, and signing IN to an address of the caller's
 * choosing would let that address dictate policy. Both are things the API token
 * alone (which a model can hold and `curl`) must not be able to do
 * (decision-gate.ts). The status read and a sync are harmless.
 *
 * Nothing returned here contains a token: only what `state.json` holds.
 *
 * @module control/routes
 */

import { ControlError, completeLogin, logout, startLogin, type DeviceStart } from './client.js';
import { graceExpired, readControlState } from './state.js';
import { syncOnce } from './sync.js';
import { describeRules } from '../policy/enforce.js';
import { managedPolicy } from '../policy/managed.js';

type Human = () => Promise<{ ok: boolean; reason?: string }>;
type Reply = { status: number; body: unknown };

let pending: { start: DeviceStart; state: 'pending' | 'done' | 'error'; error?: string; abort: AbortController } | undefined;

export function controlView(): Record<string, unknown> {
  const s = readControlState();
  if (!s) return { enrolled: false };
  return {
    enrolled: true, url: s.url, organisation: s.tenant, user: s.user, role: s.role, ...(s.team ? { team: s.team } : {}),
    policy: s.policy ? { layers: s.policy.layers.map(l => ({ scope: l.scope, name: l.name })), hash: s.policy.hash, issuedAt: s.policy.issuedAt } : null,
    budget: s.policy?.lease ? { blocked: s.policy.lease.blocked, reason: s.policy.lease.reason ?? null, limits: s.policy.lease.limits } : null,
    lastContactAt: s.lastContactAt ?? null, lastError: s.lastError ?? null, offlineAllowanceUsedUp: graceExpired(s), graceHours: s.policy?.graceHours ?? null,
    rules: describeRules(managedPolicy()),
  };
}

export async function handleControlRoute(route: string, method: string, body: Record<string, unknown>, human: Human): Promise<Reply | undefined> {
  if (route === 'control') return method === 'GET' ? { status: 200, body: controlView() } : { status: 405, body: { error: 'GET only' } };
  if (!route.startsWith('control/')) return undefined;

  if (route === 'control/sync') {
    if (method !== 'POST') return { status: 405, body: { error: 'POST only' } };
    const r = await syncOnce();
    return { status: r.ok ? 200 : 502, body: { ...r, view: controlView() } };
  }

  if (route === 'control/login' && method === 'GET') {
    if (!pending) return { status: 200, body: { state: 'none' } };
    return { status: 200, body: { state: pending.state, ...(pending.error ? { error: pending.error } : {}), ...(pending.state === 'done' ? { view: controlView() } : {}) } };
  }

  if (route === 'control/login' || route === 'control/logout') {
    if (method !== 'POST') return { status: 405, body: { error: 'POST only' } };
    const person = await human();
    if (!person.ok) {
      return { status: 403, body: { ok: false, code: 'human-required', error: person.reason ?? 'Signing in or out of your organisation needs a person in the AICO window; the API token alone cannot do it.' } };
    }
    if (route === 'control/logout') {
      pending?.abort.abort();
      pending = undefined;
      const r = await logout();
      return { status: 200, body: { ok: true, wasEnrolled: r.wasEnrolled, view: controlView() } };
    }
    const url = typeof body.url === 'string' ? body.url : '';
    if (!url) return { status: 400, body: { ok: false, error: 'Give the address of your AICO Control server.' } };
    try {
      pending?.abort.abort();
      const start = await startLogin(url, typeof body.tenant === 'string' && body.tenant ? { tenant: body.tenant } : {});
      const abort = new AbortController();
      const mine = { start, state: 'pending' as const, abort } as NonNullable<typeof pending>;
      pending = mine;
      void completeLogin(start, { signal: abort.signal }).then(async () => { mine.state = 'done'; await syncOnce(); }).catch((e: unknown) => {
        mine.state = 'error';
        mine.error = e instanceof Error ? e.message : String(e);
      });
      return { status: 200, body: { ok: true, userCode: start.userCode, verificationUri: start.verificationUri, verificationUriComplete: start.verificationUriComplete, expiresInS: start.expiresInS } };
    } catch (e) {
      return { status: e instanceof ControlError && e.code === 'network' ? 502 : 400, body: { ok: false, error: e instanceof Error ? e.message : String(e) } };
    }
  }
  return undefined;
}
