/**
 * Policy documents and budgets as the control server serves them.
 *
 * **Validation is the engine's, not a copy.** `validatePolicy` is imported from
 * the engine's own module (`src/policy/managed.ts`, bundled by tsup), so the
 * server cannot accept a document that the engine would read differently, and a
 * new key added to the engine's schema is understood here with no second edit.
 * A save with any `error`-level problem is refused; warnings (an unknown key
 * from a newer engine) are shown and allowed, like the engine does.
 *
 * **Layers, not a merged blob** (ADR 0035, 0040). An engine is served the
 * ordered list of documents that apply to its user — tenant, then role, then
 * team — plus up to two documents the server writes itself (a per-day budget
 * cap, and a deny layer when the fleet-wide budget is spent). The engine asks
 * every layer on every check, so a layer can only take away: no team or role
 * document can loosen the tenant's, and nothing here can loosen the system
 * policy file on the person's machine.
 *
 * Budgets are estimates built from the usage events engines report (the same
 * estimates the audit export uses, 0035). Day and month are UTC.
 *
 * @module policy
 */

import { validatePolicy, type LoadedPolicy, type PolicyProblem } from '../../src/policy/managed.js';
import { describeRules } from '../../src/policy/enforce.js';
import { canonicalJson, sha256hex } from './crypto.js';
import type { BudgetRow, Store, Tenant, User } from './store.js';

const MAX_DOC_BYTES = 64 * 1024;

export interface ValidationResult { ok: boolean; problems: PolicyProblem[]; summary?: Record<string, unknown>; /** Plain-English lines the engine itself would show for this document. */ rules?: string[] }

export function validateDoc(doc: unknown): ValidationResult {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return { ok: false, problems: [{ level: 'error', message: 'A policy must be a JSON object.' }] };
  if (Buffer.byteLength(JSON.stringify(doc)) > MAX_DOC_BYTES) return { ok: false, problems: [{ level: 'error', message: 'The policy is larger than 64 KB.' }] };
  const { policy, problems } = validatePolicy(doc as Record<string, unknown>);
  // describeRules only reads `layers[].policy`, so a one-layer stand-in gives the engine's own wording.
  const rules = describeRules({ layers: [{ origin: 'system', path: '', policy, lockdown: false }] } as unknown as LoadedPolicy);
  return { ok: !problems.some(p => p.level === 'error'), problems, summary: policy as Record<string, unknown>, rules };
}

export interface PolicyLayerOut { scope: 'tenant' | 'role' | 'team' | 'budget' | 'lease'; scopeId: string; name: string; policy: Record<string, unknown> }

export interface Limit { scope: BudgetRow['scope']; period: BudgetRow['period']; limitUsd: number; spentUsd: number }
export interface Lease { blocked: boolean; reason?: string; resetsAt?: string; limits: Limit[] }

const startOfDay = (ms: number): number => { const d = new Date(ms); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()); };
const startOfMonth = (ms: number): number => { const d = new Date(ms); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1); };
const nextBoundary = (ms: number, period: 'day' | 'month'): number => {
  const d = new Date(ms);
  return period === 'day' ? Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1) : Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
};

/** Budgets that apply to this user, with what has been spent so far in the current period. */
export function leaseFor(store: Store, tenant: Tenant, user: User, nowMs: number): Lease {
  const limits: Limit[] = [];
  let reason: string | undefined;
  let resetsAt: number | undefined;
  for (const b of store.listBudgets(tenant.id)) {
    const applies = (b.scope === 'tenant' && b.scopeId === '*') || (b.scope === 'team' && b.scopeId === user.teamId) || (b.scope === 'user' && b.scopeId === user.id);
    if (!applies) continue;
    const since = b.period === 'day' ? startOfDay(nowMs) : startOfMonth(nowMs);
    const spentUsd = Math.round(store.spend(tenant.id, b.scope, b.scope === 'tenant' ? '*' : b.scopeId, since) * 1e6) / 1e6;
    limits.push({ scope: b.scope, period: b.period, limitUsd: b.limitUsd, spentUsd });
    if (spentUsd >= b.limitUsd && !reason) {
      const who = b.scope === 'tenant' ? 'The organisation' : b.scope === 'team' ? 'Your team' : 'You';
      reason = `${who} reached the ${b.period === 'day' ? 'daily' : 'monthly'} AICO budget ($${b.limitUsd} estimated). It resets at ${new Date(nextBoundary(nowMs, b.period)).toISOString().slice(0, 16).replace('T', ' ')} UTC.`;
      resetsAt = nextBoundary(nowMs, b.period);
    }
  }
  return { blocked: Boolean(reason), ...(reason ? { reason, resetsAt: new Date(resetsAt!).toISOString() } : {}), limits };
}

/** The ordered documents for this user, including the two the server writes itself. */
export function layersFor(store: Store, tenant: Tenant, user: User, lease: Lease): PolicyLayerOut[] {
  const out: PolicyLayerOut[] = [];
  const docs = store.listPolicies(tenant.id);
  const find = (scope: string, scopeId: string) => docs.find(p => p.scope === scope && p.scopeId === scopeId);
  const t = find('tenant', '*');
  if (t) out.push({ scope: 'tenant', scopeId: '*', name: t.name, policy: t.doc });
  const r = find('role', user.role);
  if (r) out.push({ scope: 'role', scopeId: user.role, name: r.name, policy: r.doc });
  const tm = user.teamId ? find('team', user.teamId) : undefined;
  if (tm) out.push({ scope: 'team', scopeId: tm.scopeId, name: tm.name, policy: tm.doc });
  const dayCaps = lease.limits.filter(l => l.period === 'day').map(l => l.limitUsd);
  if (dayCaps.length) out.push({ scope: 'budget', scopeId: '*', name: 'Daily budget', policy: { budget: { perDayUsd: Math.min(...dayCaps) } } });
  if (lease.blocked) {
    // Deny-only like every layer: nothing is allowed, so no model call can start until the period resets.
    out.push({ scope: 'lease', scopeId: '*', name: 'Budget reached', policy: { allowedModels: [], allowedProviders: [], message: lease.reason } });
  }
  return out;
}

export const layersHash = (layers: PolicyLayerOut[]): string => sha256hex(canonicalJson(layers)).slice(0, 16);
