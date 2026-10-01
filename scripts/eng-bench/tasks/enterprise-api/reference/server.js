// Reference implementation (grader self-test only): the orders API contract
// from the task prompt, zero dependencies, node:sqlite.
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';

const MIGRATIONS = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');
const ROLES = { viewer: ['read'], manager: ['read', 'write'], admin: ['read', 'write', 'delete'] };
const STATUSES = ['pending', 'paid', 'shipped', 'cancelled'];

class ApiError extends Error { constructor(status, code, message, details) { super(message); Object.assign(this, { status, code, details }); } }
const fail = (status, code, message, details) => { throw new ApiError(status, code, message, details); };

export function migrate(db) {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
  const done = new Set(db.prepare('SELECT version FROM schema_migrations').all().map((r) => r.version));
  for (const f of fs.readdirSync(MIGRATIONS).filter((x) => x.endsWith('.sql')).sort()) {
    if (done.has(f)) continue;
    db.exec('BEGIN');
    db.exec(fs.readFileSync(path.join(MIGRATIONS, f), 'utf8'));
    db.prepare('INSERT INTO schema_migrations VALUES (?, ?)').run(f, new Date().toISOString());
    db.exec('COMMIT');
  }
}

function verify(header, secret) {
  const m = /^Bearer (.+)$/.exec(header ?? '');
  if (!m) fail(401, 'unauthorized', 'missing bearer token');
  const parts = m[1].split('.');
  if (parts.length !== 3) fail(401, 'unauthorized', 'malformed token');
  let head, claims;
  try { head = JSON.parse(Buffer.from(parts[0], 'base64url')); claims = JSON.parse(Buffer.from(parts[1], 'base64url')); } catch { fail(401, 'unauthorized', 'malformed token'); }
  if (head.alg !== 'HS256') fail(401, 'unauthorized', 'unsupported algorithm');
  const expected = crypto.createHmac('sha256', secret).update(`${parts[0]}.${parts[1]}`).digest();
  const given = Buffer.from(parts[2], 'base64url');
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) fail(401, 'unauthorized', 'bad signature');
  if (typeof claims.exp !== 'number' || claims.exp * 1000 <= Date.now()) fail(401, 'unauthorized', 'token expired');
  if (typeof claims.tenant_id !== 'string' || !claims.tenant_id) fail(401, 'unauthorized', 'no tenant');
  return claims;
}

const can = (claims, perm) => { if (!(ROLES[claims.role] ?? []).includes(perm)) fail(403, 'forbidden', 'not allowed'); };

async function body(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  try { const v = JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null'); if (!v || typeof v !== 'object' || Array.isArray(v)) throw 0; return v; } catch { fail(400, 'validation_error', 'body must be a JSON object'); }
}

function validateOrder(b) {
  const errs = [];
  if (typeof b.customer !== 'string' || !b.customer.trim() || b.customer.length > 200) errs.push('customer');
  if (!Array.isArray(b.items) || b.items.length < 1 || b.items.length > 100) errs.push('items');
  else b.items.forEach((it, i) => {
    if (!it || typeof it.sku !== 'string' || !it.sku || it.sku.length > 64) errs.push(`items[${i}].sku`);
    if (!Number.isInteger(it?.quantity) || it.quantity < 1) errs.push(`items[${i}].quantity`);
    if (typeof it?.unit_price !== 'number' || !Number.isFinite(it.unit_price) || it.unit_price < 0) errs.push(`items[${i}].unit_price`);
  });
  if (b.notes !== undefined && (typeof b.notes !== 'string' || b.notes.length > 1000)) errs.push('notes');
  if (errs.length) fail(400, 'validation_error', 'invalid order', errs);
}

const row = (r) => r && ({ ...r, items: JSON.parse(r.items) });
const int = (v, def, min, max, name) => {
  if (v === null) return def;
  if (!/^\d+$/.test(v)) fail(400, 'validation_error', `${name} must be an integer`);
  const n = Number(v);
  if (n < min || n > max) fail(400, 'validation_error', `${name} out of range`);
  return n;
};

export function createServer({ dbPath, secret }) {
  const db = new DatabaseSync(dbPath);
  migrate(db);
  return http.createServer(async (req, res) => {
    const send = (status, data) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(data === undefined ? '' : JSON.stringify(data)); };
    try {
      const url = new URL(req.url, 'http://x');
      if (url.pathname === '/health' && req.method === 'GET') return send(200, { status: 'ok' });
      const claims = verify(req.headers.authorization, secret);
      const tenant = claims.tenant_id;
      if (url.pathname === '/orders' && req.method === 'POST') {
        can(claims, 'write');
        const b = await body(req);
        validateOrder(b);
        const total = Math.round(b.items.reduce((s, it) => s + it.quantity * it.unit_price, 0) * 100) / 100;
        const now = new Date().toISOString();
        const id = crypto.randomUUID();
        db.prepare('INSERT INTO orders (id, tenant_id, customer, items, total, status, notes, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)')
          .run(id, tenant, b.customer, JSON.stringify(b.items), total, 'pending', b.notes ?? null, now, now);
        return send(201, row(db.prepare('SELECT * FROM orders WHERE id = ?').get(id)));
      }
      if (url.pathname === '/orders' && req.method === 'GET') {
        can(claims, 'read');
        const page = int(url.searchParams.get('page'), 1, 1, 1e9, 'page');
        const size = int(url.searchParams.get('page_size'), 20, 1, 100, 'page_size');
        const total = db.prepare('SELECT count(*) AS n FROM orders WHERE tenant_id = ?').get(tenant).n;
        const data = db.prepare('SELECT * FROM orders WHERE tenant_id = ? ORDER BY seq LIMIT ? OFFSET ?').all(tenant, size, (page - 1) * size).map(row);
        return send(200, { data, page, page_size: size, total });
      }
      const m = /^\/orders\/([^/]+)$/.exec(url.pathname);
      if (m) {
        const find = () => row(db.prepare('SELECT * FROM orders WHERE id = ? AND tenant_id = ?').get(m[1], tenant)) ?? fail(404, 'not_found', 'order not found');
        if (req.method === 'GET') { can(claims, 'read'); return send(200, find()); }
        if (req.method === 'PATCH') {
          can(claims, 'write');
          const b = await body(req);
          find();
          if (!STATUSES.includes(b.status)) fail(400, 'validation_error', 'invalid status');
          db.prepare('UPDATE orders SET status = ?, updated_at = ? WHERE id = ? AND tenant_id = ?').run(b.status, new Date().toISOString(), m[1], tenant);
          return send(200, find());
        }
        if (req.method === 'DELETE') {
          can(claims, 'delete');
          find();
          db.prepare('DELETE FROM orders WHERE id = ? AND tenant_id = ?').run(m[1], tenant);
          return send(204);
        }
      }
      fail(404, 'not_found', 'no such route');
    } catch (e) {
      if (e instanceof ApiError) return send(e.status, { error: { code: e.code, message: e.message, ...(e.details ? { details: e.details } : {}) } });
      return send(500, { error: { code: 'internal', message: 'internal error' } });
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  createServer({ dbPath: process.env.DATABASE_PATH ?? 'orders.db', secret: process.env.JWT_SECRET ?? '' }).listen(Number(process.env.PORT ?? 3000));
}
