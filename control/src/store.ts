/**
 * The repository: every read and write of the control database.
 *
 * The one rule (ADR 0040, tested in tenancy.test.mjs): **the tenant id is the
 * first argument of every function that touches tenant data, and `tenant_id = ?`
 * is in its SQL.** There is no "get row by id" without it, so a bug in a route
 * (an id taken from a URL, a body or a token) can never reach another tenant's
 * row — the worst it can do is miss in its own. The few functions that cannot
 * take a tenant first (look up a tenant by slug; look up a session, refresh
 * token or device grant by the hash of a secret only its owner holds) return
 * the row *with* its tenant, and the caller then works within it.
 *
 * Storage details that matter elsewhere: timestamps are epoch ms; secrets
 * (session ids, refresh tokens, device codes) arrive here already hashed;
 * `audit` rows are append-only (db.ts triggers) and hash-chained per tenant.
 *
 * Deliberately not here: any decision about who may do what (rbac.ts, routes)
 * or any HTTP concern.
 *
 * @module store
 */

import crypto from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { canonicalJson, sha256hex } from './crypto.js';

export type Row = Record<string, unknown>;

export interface TenantSettings {
  /** Hours an engine may run on its last policy without contacting the server. 0 = no limit. */
  graceHours: number;
  /** Create a `developer` on first OIDC sign-in when no user exists. */
  jit: boolean;
  /** Seconds between engine policy refreshes. */
  pollSeconds: number;
  idp?: { issuer: string; clientId: string; clientSecretSealed?: string; scopes?: string };
}
export const DEFAULT_SETTINGS: TenantSettings = { graceHours: 168, jit: false, pollSeconds: 300 };

export interface Tenant { id: string; slug: string; name: string; settings: TenantSettings; createdAt: number }
export interface Team { id: string; tenantId: string; name: string; createdAt: number }
export interface User {
  id: string; tenantId: string; email: string; name: string; role: string; teamId: string | null;
  status: 'active' | 'disabled'; externalId: string | null; source: string; createdAt: number; lastLoginAt: number | null;
}
export interface PolicyRow {
  id: string; tenantId: string; scope: 'tenant' | 'team' | 'role'; scopeId: string; name: string;
  doc: Record<string, unknown>; updatedAt: number; updatedBy: string | null;
}
export interface BudgetRow {
  id: string; tenantId: string; scope: 'tenant' | 'team' | 'user'; scopeId: string; period: 'day' | 'month';
  limitUsd: number; updatedAt: number;
}
export interface Session { idHash: string; tenantId: string; userId: string; csrf: string; createdAt: number; lastSeenAt: number; expiresAt: number; approvalsFailed: number }
export interface Grant {
  id: string; tenantId: string; deviceCodeHash: string; userCode: string; status: 'pending' | 'approved' | 'denied' | 'consumed';
  userId: string | null; intervalS: number; lastPollAt: number | null; expiresAt: number;
  deviceName: string; platform: string; aicoVersion: string; createdAt: number;
}
export interface Device {
  id: string; tenantId: string; userId: string; name: string; platform: string; aicoVersion: string;
  createdAt: number; lastSeenAt: number | null; revokedAt: number | null; revokedReason: string | null;
}
export interface RefreshToken { id: string; tenantId: string; deviceId: string; tokenHash: string; createdAt: number; expiresAt: number; usedAt: number | null }

export interface AuditInput {
  recordId: string; tsMs: number; source: 'engine' | 'control'; userId?: string | null; userEmail?: string | null;
  deviceId?: string | null; kind: string; action: string; outcome: string; body: Record<string, unknown>;
}
export interface AuditRow extends AuditInput { tenantId: string; seq: number; prevHash: string; hash: string }

export interface AuditQuery {
  q?: string; kind?: string; user?: string; outcome?: string; source?: string;
  since?: number; until?: number; limit?: number; beforeSeq?: number;
}

export const GENESIS = '0'.repeat(64);
export const newId = (prefix: string): string => `${prefix}_${crypto.randomBytes(9).toString('base64url')}`;
export const dayOf = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

const json = (v: unknown): string => JSON.stringify(v);
const parse = <T>(s: unknown, fallback: T): T => { try { return JSON.parse(String(s)) as T; } catch { return fallback; } };

/** What goes into a row's hash. Every field a reader sees is covered, so changing any of them breaks the chain. */
function chainPayload(tenantId: string, seq: number, a: AuditInput): string {
  return canonicalJson({
    tenantId, seq, recordId: a.recordId, tsMs: a.tsMs, source: a.source, userId: a.userId ?? null,
    userEmail: a.userEmail ?? null, deviceId: a.deviceId ?? null, kind: a.kind, action: a.action, outcome: a.outcome, body: a.body,
  });
}
export const chainHash = (prev: string, tenantId: string, seq: number, a: AuditInput): string => sha256hex(`${prev}\n${chainPayload(tenantId, seq, a)}`);

const userOf = (r: Row): User => ({
  id: r.id as string, tenantId: r.tenant_id as string, email: r.email as string, name: r.name as string, role: r.role as string,
  teamId: (r.team_id as string | null) ?? null, status: r.status as 'active' | 'disabled', externalId: (r.external_id as string | null) ?? null,
  source: r.source as string, createdAt: r.created_at as number, lastLoginAt: (r.last_login_at as number | null) ?? null,
});
const tenantOf = (r: Row): Tenant => ({
  id: r.id as string, slug: r.slug as string, name: r.name as string,
  settings: { ...DEFAULT_SETTINGS, ...parse<Partial<TenantSettings>>(r.settings, {}) }, createdAt: r.created_at as number,
});
const policyOf = (r: Row): PolicyRow => ({
  id: r.id as string, tenantId: r.tenant_id as string, scope: r.scope as PolicyRow['scope'], scopeId: r.scope_id as string,
  name: r.name as string, doc: parse<Record<string, unknown>>(r.doc, {}), updatedAt: r.updated_at as number, updatedBy: (r.updated_by as string | null) ?? null,
});
const budgetOf = (r: Row): BudgetRow => ({
  id: r.id as string, tenantId: r.tenant_id as string, scope: r.scope as BudgetRow['scope'], scopeId: r.scope_id as string,
  period: r.period as BudgetRow['period'], limitUsd: r.limit_usd as number, updatedAt: r.updated_at as number,
});
const deviceOf = (r: Row): Device => ({
  id: r.id as string, tenantId: r.tenant_id as string, userId: r.user_id as string, name: r.name as string, platform: r.platform as string,
  aicoVersion: r.aico_version as string, createdAt: r.created_at as number, lastSeenAt: (r.last_seen_at as number | null) ?? null,
  revokedAt: (r.revoked_at as number | null) ?? null, revokedReason: (r.revoked_reason as string | null) ?? null,
});
const grantOf = (r: Row): Grant => ({
  id: r.id as string, tenantId: r.tenant_id as string, deviceCodeHash: r.device_code_hash as string, userCode: r.user_code as string,
  status: r.status as Grant['status'], userId: (r.user_id as string | null) ?? null, intervalS: r.interval_s as number,
  lastPollAt: (r.last_poll_at as number | null) ?? null, expiresAt: r.expires_at as number, deviceName: r.device_name as string,
  platform: r.platform as string, aicoVersion: r.aico_version as string, createdAt: r.created_at as number,
});
const auditOf = (r: Row): AuditRow => ({
  tenantId: r.tenant_id as string, seq: r.seq as number, recordId: r.record_id as string, tsMs: r.ts_ms as number,
  source: r.source as 'engine' | 'control', userId: (r.user_id as string | null) ?? null, userEmail: (r.user_email as string | null) ?? null,
  deviceId: (r.device_id as string | null) ?? null, kind: r.kind as string, action: r.action as string, outcome: r.outcome as string,
  body: parse<Record<string, unknown>>(r.body, {}), prevHash: r.prev_hash as string, hash: r.hash as string,
});

export class Store {
  constructor(readonly db: DatabaseSync, private readonly now: () => number = Date.now) {}

  private all(sql: string, ...p: unknown[]): Row[] { return this.db.prepare(sql).all(...(p as never[])) as Row[]; }
  private one(sql: string, ...p: unknown[]): Row | undefined { return this.db.prepare(sql).get(...(p as never[])) as Row | undefined; }
  private run(sql: string, ...p: unknown[]): number { return Number(this.db.prepare(sql).run(...(p as never[])).changes); }

  tx<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const out = fn(); this.db.exec('COMMIT'); return out; } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }

  // ── meta ──────────────────────────────────────────────────────────
  getMeta(key: string): string | undefined { return this.one('SELECT value FROM meta WHERE key = ?', key)?.value as string | undefined; }
  setMeta(key: string, value: string): void { this.run('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, value); }

  // ── tenants ───────────────────────────────────────────────────────
  createTenant(slug: string, name: string, settings: Partial<TenantSettings> = {}): Tenant {
    const id = newId('ten');
    this.run('INSERT INTO tenants (id, slug, name, settings, created_at) VALUES (?, ?, ?, ?, ?)', id, slug, name, json({ ...DEFAULT_SETTINGS, ...settings }), this.now());
    return this.getTenant(id)!;
  }
  getTenant(id: string): Tenant | undefined { const r = this.one('SELECT * FROM tenants WHERE id = ?', id); return r && tenantOf(r); }
  getTenantBySlug(slug: string): Tenant | undefined { const r = this.one('SELECT * FROM tenants WHERE slug = ?', slug); return r && tenantOf(r); }
  listTenants(): Tenant[] { return this.all('SELECT * FROM tenants ORDER BY created_at').map(tenantOf); }
  updateTenant(id: string, patch: { name?: string; settings?: Partial<TenantSettings> }): Tenant | undefined {
    const t = this.getTenant(id);
    if (!t) return undefined;
    this.run('UPDATE tenants SET name = ?, settings = ? WHERE id = ?', patch.name ?? t.name, json({ ...t.settings, ...(patch.settings ?? {}) }), id);
    return this.getTenant(id);
  }

  // ── teams ─────────────────────────────────────────────────────────
  createTeam(tenantId: string, name: string): Team {
    const id = newId('team');
    this.run('INSERT INTO teams (id, tenant_id, name, created_at) VALUES (?, ?, ?, ?)', id, tenantId, name, this.now());
    return this.getTeam(tenantId, id)!;
  }
  getTeam(tenantId: string, id: string): Team | undefined {
    const r = this.one('SELECT * FROM teams WHERE tenant_id = ? AND id = ?', tenantId, id);
    return r && { id: r.id as string, tenantId: r.tenant_id as string, name: r.name as string, createdAt: r.created_at as number };
  }
  listTeams(tenantId: string): Array<Team & { members: number }> {
    return this.all(
      'SELECT t.*, (SELECT COUNT(*) FROM users u WHERE u.tenant_id = t.tenant_id AND u.team_id = t.id) AS members FROM teams t WHERE t.tenant_id = ? ORDER BY t.name', tenantId,
    ).map(r => ({ id: r.id as string, tenantId: r.tenant_id as string, name: r.name as string, createdAt: r.created_at as number, members: Number(r.members) }));
  }
  renameTeam(tenantId: string, id: string, name: string): boolean { return this.run('UPDATE teams SET name = ? WHERE tenant_id = ? AND id = ?', name, tenantId, id) > 0; }
  deleteTeam(tenantId: string, id: string): boolean {
    this.run('DELETE FROM policies WHERE tenant_id = ? AND scope = ? AND scope_id = ?', tenantId, 'team', id);
    this.run('DELETE FROM budgets WHERE tenant_id = ? AND scope = ? AND scope_id = ?', tenantId, 'team', id);
    return this.run('DELETE FROM teams WHERE tenant_id = ? AND id = ?', tenantId, id) > 0;
  }

  // ── users ─────────────────────────────────────────────────────────
  createUser(tenantId: string, u: { email: string; name?: string; role: string; teamId?: string | null; source?: string; externalId?: string | null }): User {
    const id = newId('usr');
    this.run(
      'INSERT INTO users (id, tenant_id, email, name, role, team_id, source, external_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      id, tenantId, u.email.toLowerCase(), u.name ?? '', u.role, u.teamId ?? null, u.source ?? 'manual', u.externalId ?? null, this.now(),
    );
    return this.getUser(tenantId, id)!;
  }
  getUser(tenantId: string, id: string): User | undefined { const r = this.one('SELECT * FROM users WHERE tenant_id = ? AND id = ?', tenantId, id); return r && userOf(r); }
  findUserByEmail(tenantId: string, email: string): User | undefined { const r = this.one('SELECT * FROM users WHERE tenant_id = ? AND email = ?', tenantId, email.toLowerCase()); return r && userOf(r); }
  findUserByExternal(tenantId: string, externalId: string): User | undefined { const r = this.one('SELECT * FROM users WHERE tenant_id = ? AND external_id = ?', tenantId, externalId); return r && userOf(r); }
  listUsers(tenantId: string, filter: { teamId?: string } = {}): User[] {
    return (filter.teamId
      ? this.all('SELECT * FROM users WHERE tenant_id = ? AND team_id = ? ORDER BY email', tenantId, filter.teamId)
      : this.all('SELECT * FROM users WHERE tenant_id = ? ORDER BY email', tenantId)).map(userOf);
  }
  updateUser(tenantId: string, id: string, patch: { name?: string; role?: string; teamId?: string | null; status?: 'active' | 'disabled'; externalId?: string | null }): User | undefined {
    const u = this.getUser(tenantId, id);
    if (!u) return undefined;
    this.run(
      'UPDATE users SET name = ?, role = ?, team_id = ?, status = ?, external_id = ? WHERE tenant_id = ? AND id = ?',
      patch.name ?? u.name, patch.role ?? u.role, patch.teamId === undefined ? u.teamId : patch.teamId, patch.status ?? u.status,
      patch.externalId === undefined ? u.externalId : patch.externalId, tenantId, id,
    );
    return this.getUser(tenantId, id);
  }
  touchLogin(tenantId: string, id: string): void { this.run('UPDATE users SET last_login_at = ? WHERE tenant_id = ? AND id = ?', this.now(), tenantId, id); }
  countActiveOwners(tenantId: string): number { return Number(this.one("SELECT COUNT(*) AS n FROM users WHERE tenant_id = ? AND role = 'owner' AND status = 'active'", tenantId)?.n ?? 0); }

  // ── policies ──────────────────────────────────────────────────────
  upsertPolicy(tenantId: string, p: { scope: PolicyRow['scope']; scopeId: string; name: string; doc: Record<string, unknown>; by: string | null }): PolicyRow {
    const existing = this.one('SELECT id FROM policies WHERE tenant_id = ? AND scope = ? AND scope_id = ?', tenantId, p.scope, p.scopeId);
    const id = (existing?.id as string | undefined) ?? newId('pol');
    this.run(
      `INSERT INTO policies (id, tenant_id, scope, scope_id, name, doc, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(tenant_id, scope, scope_id) DO UPDATE SET name = excluded.name, doc = excluded.doc, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
      id, tenantId, p.scope, p.scopeId, p.name, json(p.doc), this.now(), p.by,
    );
    return policyOf(this.one('SELECT * FROM policies WHERE tenant_id = ? AND id = ?', tenantId, id)!);
  }
  getPolicy(tenantId: string, id: string): PolicyRow | undefined { const r = this.one('SELECT * FROM policies WHERE tenant_id = ? AND id = ?', tenantId, id); return r && policyOf(r); }
  listPolicies(tenantId: string): PolicyRow[] { return this.all('SELECT * FROM policies WHERE tenant_id = ? ORDER BY scope, scope_id', tenantId).map(policyOf); }
  deletePolicy(tenantId: string, id: string): boolean { return this.run('DELETE FROM policies WHERE tenant_id = ? AND id = ?', tenantId, id) > 0; }

  // ── budgets ───────────────────────────────────────────────────────
  upsertBudget(tenantId: string, b: { scope: BudgetRow['scope']; scopeId: string; period: BudgetRow['period']; limitUsd: number }): BudgetRow {
    const existing = this.one('SELECT id FROM budgets WHERE tenant_id = ? AND scope = ? AND scope_id = ? AND period = ?', tenantId, b.scope, b.scopeId, b.period);
    const id = (existing?.id as string | undefined) ?? newId('bud');
    this.run(
      `INSERT INTO budgets (id, tenant_id, scope, scope_id, period, limit_usd, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(tenant_id, scope, scope_id, period) DO UPDATE SET limit_usd = excluded.limit_usd, updated_at = excluded.updated_at`,
      id, tenantId, b.scope, b.scopeId, b.period, b.limitUsd, this.now(),
    );
    return budgetOf(this.one('SELECT * FROM budgets WHERE tenant_id = ? AND id = ?', tenantId, id)!);
  }
  listBudgets(tenantId: string): BudgetRow[] { return this.all('SELECT * FROM budgets WHERE tenant_id = ? ORDER BY scope, scope_id, period', tenantId).map(budgetOf); }
  deleteBudget(tenantId: string, id: string): boolean { return this.run('DELETE FROM budgets WHERE tenant_id = ? AND id = ?', tenantId, id) > 0; }

  // ── sessions and sign-in flows ────────────────────────────────────
  createSession(tenantId: string, userId: string, idHash: string, csrf: string, ttlMs: number): void {
    const now = this.now();
    this.run('INSERT INTO sessions (id_hash, tenant_id, user_id, csrf, created_at, last_seen_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)', idHash, tenantId, userId, csrf, now, now, now + ttlMs);
  }
  /** By the hash of the cookie value; the row names its tenant. */
  getSession(idHash: string): Session | undefined {
    const r = this.one('SELECT * FROM sessions WHERE id_hash = ?', idHash);
    return r && {
      idHash: r.id_hash as string, tenantId: r.tenant_id as string, userId: r.user_id as string, csrf: r.csrf as string, createdAt: r.created_at as number,
      lastSeenAt: r.last_seen_at as number, expiresAt: r.expires_at as number, approvalsFailed: r.approvals_failed as number,
    };
  }
  touchSession(tenantId: string, idHash: string): void { this.run('UPDATE sessions SET last_seen_at = ? WHERE tenant_id = ? AND id_hash = ?', this.now(), tenantId, idHash); }
  failApproval(tenantId: string, idHash: string): number {
    this.run('UPDATE sessions SET approvals_failed = approvals_failed + 1 WHERE tenant_id = ? AND id_hash = ?', tenantId, idHash);
    return Number(this.one('SELECT approvals_failed AS n FROM sessions WHERE tenant_id = ? AND id_hash = ?', tenantId, idHash)?.n ?? 0);
  }
  deleteSession(tenantId: string, idHash: string): void { this.run('DELETE FROM sessions WHERE tenant_id = ? AND id_hash = ?', tenantId, idHash); }
  deleteSessionsOf(tenantId: string, userId: string): void { this.run('DELETE FROM sessions WHERE tenant_id = ? AND user_id = ?', tenantId, userId); }

  createFlow(tenantId: string, stateHash: string, f: { verifier: string; nonce: string; next: string }): void {
    this.run('DELETE FROM oidc_flows WHERE created_at < ?', this.now() - 3_600_000);
    this.run('INSERT INTO oidc_flows (state_hash, tenant_id, verifier, nonce, next, created_at) VALUES (?, ?, ?, ?, ?, ?)', stateHash, tenantId, f.verifier, f.nonce, f.next, this.now());
  }
  /** Single use: the row is gone after this call, valid or not. */
  takeFlow(stateHash: string): { tenantId: string; verifier: string; nonce: string; next: string; createdAt: number } | undefined {
    const r = this.one('SELECT * FROM oidc_flows WHERE state_hash = ?', stateHash);
    if (!r) return undefined;
    this.run('DELETE FROM oidc_flows WHERE state_hash = ?', stateHash);
    return { tenantId: r.tenant_id as string, verifier: r.verifier as string, nonce: r.nonce as string, next: r.next as string, createdAt: r.created_at as number };
  }

  // ── device grants, devices, refresh tokens ────────────────────────
  createGrant(tenantId: string, g: { deviceCodeHash: string; userCode: string; intervalS: number; ttlMs: number; deviceName: string; platform: string; aicoVersion: string }): Grant {
    const id = newId('dg');
    const now = this.now();
    this.run('DELETE FROM device_grants WHERE expires_at < ?', now - 3_600_000);
    this.run(
      'INSERT INTO device_grants (id, tenant_id, device_code_hash, user_code, interval_s, expires_at, device_name, platform, aico_version, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      id, tenantId, g.deviceCodeHash, g.userCode, g.intervalS, now + g.ttlMs, g.deviceName, g.platform, g.aicoVersion, now,
    );
    return grantOf(this.one('SELECT * FROM device_grants WHERE tenant_id = ? AND id = ?', tenantId, id)!);
  }
  grantByDeviceCode(deviceCodeHash: string): Grant | undefined { const r = this.one('SELECT * FROM device_grants WHERE device_code_hash = ?', deviceCodeHash); return r && grantOf(r); }
  grantByUserCode(tenantId: string, userCode: string): Grant | undefined { const r = this.one('SELECT * FROM device_grants WHERE tenant_id = ? AND user_code = ?', tenantId, userCode); return r && grantOf(r); }
  userCodeTaken(tenantId: string, userCode: string): boolean { return Boolean(this.one('SELECT 1 AS x FROM device_grants WHERE tenant_id = ? AND user_code = ? AND expires_at > ?', tenantId, userCode, this.now())); }
  setGrant(tenantId: string, id: string, patch: { status?: Grant['status']; userId?: string | null; lastPollAt?: number; intervalS?: number }): void {
    const g = this.one('SELECT * FROM device_grants WHERE tenant_id = ? AND id = ?', tenantId, id);
    if (!g) return;
    this.run(
      'UPDATE device_grants SET status = ?, user_id = ?, last_poll_at = ?, interval_s = ? WHERE tenant_id = ? AND id = ?',
      patch.status ?? g.status, patch.userId === undefined ? (g.user_id ?? null) : patch.userId, patch.lastPollAt ?? g.last_poll_at ?? null, patch.intervalS ?? g.interval_s, tenantId, id,
    );
  }
  deleteGrant(tenantId: string, id: string): void { this.run('DELETE FROM device_grants WHERE tenant_id = ? AND id = ?', tenantId, id); }

  createDevice(tenantId: string, d: { userId: string; name: string; platform: string; aicoVersion: string }): Device {
    const id = newId('dev');
    this.run('INSERT INTO devices (id, tenant_id, user_id, name, platform, aico_version, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', id, tenantId, d.userId, d.name, d.platform, d.aicoVersion, this.now());
    return this.getDevice(tenantId, id)!;
  }
  getDevice(tenantId: string, id: string): Device | undefined { const r = this.one('SELECT * FROM devices WHERE tenant_id = ? AND id = ?', tenantId, id); return r && deviceOf(r); }
  listDevices(tenantId: string, filter: { teamId?: string; userId?: string } = {}): Array<Device & { userEmail: string }> {
    const rows = this.all(
      `SELECT d.*, u.email AS user_email FROM devices d JOIN users u ON u.tenant_id = d.tenant_id AND u.id = d.user_id
       WHERE d.tenant_id = ? ${filter.teamId ? 'AND u.team_id = ?' : ''} ${filter.userId ? 'AND d.user_id = ?' : ''} ORDER BY d.created_at DESC`,
      ...[tenantId, filter.teamId, filter.userId].filter(v => v !== undefined),
    );
    return rows.map(r => ({ ...deviceOf(r), userEmail: r.user_email as string }));
  }
  touchDevice(tenantId: string, id: string, aicoVersion?: string): void {
    this.run('UPDATE devices SET last_seen_at = ?, aico_version = COALESCE(?, aico_version) WHERE tenant_id = ? AND id = ?', this.now(), aicoVersion ?? null, tenantId, id);
  }
  revokeDevice(tenantId: string, id: string, reason: string): boolean {
    return this.run('UPDATE devices SET revoked_at = ?, revoked_reason = ? WHERE tenant_id = ? AND id = ? AND revoked_at IS NULL', this.now(), reason, tenantId, id) > 0;
  }
  revokeDevicesOf(tenantId: string, userId: string, reason: string): void {
    this.run('UPDATE devices SET revoked_at = ?, revoked_reason = ? WHERE tenant_id = ? AND user_id = ? AND revoked_at IS NULL', this.now(), reason, tenantId, userId);
  }

  addRefreshToken(tenantId: string, deviceId: string, tokenHash: string, ttlMs: number): void {
    const now = this.now();
    this.run('INSERT INTO refresh_tokens (id, tenant_id, device_id, token_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)', newId('rt'), tenantId, deviceId, tokenHash, now, now + ttlMs);
    // Old, spent tokens only matter for reuse detection; keep a month of them.
    this.run('DELETE FROM refresh_tokens WHERE tenant_id = ? AND device_id = ? AND expires_at < ?', tenantId, deviceId, now - 30 * 86_400_000);
  }
  refreshByHash(tokenHash: string): RefreshToken | undefined {
    const r = this.one('SELECT * FROM refresh_tokens WHERE token_hash = ?', tokenHash);
    return r && {
      id: r.id as string, tenantId: r.tenant_id as string, deviceId: r.device_id as string, tokenHash: r.token_hash as string,
      createdAt: r.created_at as number, expiresAt: r.expires_at as number, usedAt: (r.used_at as number | null) ?? null,
    };
  }
  markRefreshUsed(tenantId: string, id: string): boolean { return this.run('UPDATE refresh_tokens SET used_at = ? WHERE tenant_id = ? AND id = ? AND used_at IS NULL', this.now(), tenantId, id) > 0; }

  // ── audit (append-only, hash-chained) ─────────────────────────────
  /** Append in one transaction. Returns how many were new and the head of the chain. */
  appendAudit(tenantId: string, inputs: AuditInput[]): { appended: number; duplicates: number; head: { seq: number; hash: string } } {
    return this.tx(() => {
      const last = this.one('SELECT seq, hash FROM audit WHERE tenant_id = ? ORDER BY seq DESC LIMIT 1', tenantId);
      let seq = Number(last?.seq ?? 0);
      let prev = (last?.hash as string | undefined) ?? GENESIS;
      let appended = 0;
      let duplicates = 0;
      for (const a of inputs) {
        if (this.one('SELECT 1 AS x FROM audit WHERE tenant_id = ? AND record_id = ?', tenantId, a.recordId)) { duplicates++; continue; }
        seq++;
        const hash = chainHash(prev, tenantId, seq, a);
        this.run(
          'INSERT INTO audit (tenant_id, seq, record_id, ts_ms, source, user_id, user_email, device_id, kind, action, outcome, body, prev_hash, hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          tenantId, seq, a.recordId, a.tsMs, a.source, a.userId ?? null, a.userEmail ?? null, a.deviceId ?? null, a.kind, a.action, a.outcome, json(a.body), prev, hash,
        );
        prev = hash;
        appended++;
      }
      return { appended, duplicates, head: { seq, hash: prev } };
    });
  }
  queryAudit(tenantId: string, q: AuditQuery & { userId?: string; teamId?: string }): AuditRow[] {
    const where = ['a.tenant_id = ?'];
    const args: unknown[] = [tenantId];
    const add = (cond: string, ...v: unknown[]): void => { where.push(cond); args.push(...v); };
    if (q.kind) add('a.kind = ?', q.kind);
    if (q.outcome) add('a.outcome = ?', q.outcome);
    if (q.source) add('a.source = ?', q.source);
    if (q.user) add('a.user_email LIKE ?', `%${q.user.replace(/[%_]/g, '')}%`);
    if (q.since !== undefined) add('a.ts_ms >= ?', q.since);
    if (q.until !== undefined) add('a.ts_ms < ?', q.until);
    if (q.beforeSeq !== undefined) add('a.seq < ?', q.beforeSeq);
    if (q.q) {
      const like = `%${q.q.replace(/[%_]/g, '')}%`;
      add('(a.action LIKE ? OR a.kind LIKE ? OR a.user_email LIKE ? OR a.body LIKE ?)', like, like, like, like);
    }
    const limit = Math.min(Math.max(Math.trunc(q.limit ?? 100), 1), 5000);
    return this.all(`SELECT a.* FROM audit a WHERE ${where.join(' AND ')} ORDER BY a.seq DESC LIMIT ${limit}`, ...args).map(auditOf);
  }
  /** Recompute the chain. `ok: false` names the first sequence number that does not match. */
  verifyAudit(tenantId: string): { ok: boolean; count: number; head: { seq: number; hash: string } | null; brokenAt?: number; reason?: string } {
    let prev = GENESIS;
    let expectSeq = 1;
    let count = 0;
    let head: { seq: number; hash: string } | null = null;
    const stmt = this.db.prepare('SELECT * FROM audit WHERE tenant_id = ? ORDER BY seq');
    for (const row of stmt.iterate(tenantId) as Iterable<Row>) {
      const a = auditOf(row);
      if (a.seq !== expectSeq) return { ok: false, count, head, brokenAt: expectSeq, reason: `sequence gap: expected ${expectSeq}, found ${a.seq}` };
      if (a.prevHash !== prev) return { ok: false, count, head, brokenAt: a.seq, reason: 'previous-hash link does not match' };
      if (chainHash(prev, tenantId, a.seq, a) !== a.hash) return { ok: false, count, head, brokenAt: a.seq, reason: 'record content does not match its hash' };
      prev = a.hash;
      head = { seq: a.seq, hash: a.hash };
      count++;
      expectSeq++;
    }
    return { ok: true, count, head };
  }

  // ── usage ─────────────────────────────────────────────────────────
  insertUsage(tenantId: string, e: { eventId: string; userId: string; teamId: string | null; deviceId: string | null; atMs: number; model: string; provider: string; inputTokens: number; outputTokens: number; costUsd: number; project: string }): boolean {
    return this.run(
      `INSERT OR IGNORE INTO usage_events (tenant_id, event_id, user_id, team_id, device_id, at_ms, day, model, provider, input_tokens, output_tokens, cost_usd, project)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      tenantId, e.eventId, e.userId, e.teamId, e.deviceId, e.atMs, dayOf(e.atMs), e.model, e.provider, e.inputTokens, e.outputTokens, e.costUsd, e.project,
    ) > 0;
  }
  spend(tenantId: string, scope: 'tenant' | 'team' | 'user', scopeId: string, sinceMs: number): number {
    const col = scope === 'user' ? 'AND user_id = ?' : scope === 'team' ? 'AND team_id = ?' : '';
    const args = scope === 'tenant' ? [tenantId, sinceMs] : [tenantId, sinceMs, scopeId];
    return Number(this.one(`SELECT COALESCE(SUM(cost_usd), 0) AS s FROM usage_events WHERE tenant_id = ? AND at_ms >= ? ${col}`, ...args)?.s ?? 0);
  }
  usageSummary(tenantId: string, by: 'user' | 'team' | 'model' | 'day', f: { sinceMs?: number; untilMs?: number; teamId?: string }): Array<{ key: string; label: string; events: number; inputTokens: number; outputTokens: number; costUsd: number }> {
    const keyExpr = by === 'user' ? 'e.user_id' : by === 'team' ? "COALESCE(e.team_id, '')" : by === 'model' ? 'e.model' : 'e.day';
    const labelExpr = by === 'user' ? 'COALESCE(u.email, e.user_id)' : by === 'team' ? "COALESCE(t.name, '(no team)')" : keyExpr;
    const where = ['e.tenant_id = ?'];
    const args: unknown[] = [tenantId];
    if (f.sinceMs !== undefined) { where.push('e.at_ms >= ?'); args.push(f.sinceMs); }
    if (f.untilMs !== undefined) { where.push('e.at_ms < ?'); args.push(f.untilMs); }
    if (f.teamId) { where.push('e.team_id = ?'); args.push(f.teamId); }
    const rows = this.all(
      `SELECT ${keyExpr} AS k, ${labelExpr} AS label, COUNT(*) AS events, SUM(e.input_tokens) AS i, SUM(e.output_tokens) AS o, SUM(e.cost_usd) AS c
       FROM usage_events e LEFT JOIN users u ON u.tenant_id = e.tenant_id AND u.id = e.user_id LEFT JOIN teams t ON t.tenant_id = e.tenant_id AND t.id = e.team_id
       WHERE ${where.join(' AND ')} GROUP BY k ORDER BY ${by === 'day' ? 'k' : 'c DESC'}`,
      ...args,
    );
    return rows.map(r => ({ key: String(r.k), label: String(r.label), events: Number(r.events), inputTokens: Number(r.i), outputTokens: Number(r.o), costUsd: Math.round(Number(r.c) * 1e6) / 1e6 }));
  }
}
