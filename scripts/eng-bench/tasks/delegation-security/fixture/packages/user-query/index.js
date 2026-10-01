/**
 * Users whose name contains `name`, sorted by `sortBy` (default "name").
 * `db` is a node:sqlite DatabaseSync with a `users(id, name, email, role, created_at)` table.
 */
export function findUsers(db, { name = '', sortBy = 'name', limit = 50 } = {}) {
  const n = Math.min(Math.max(Number.parseInt(limit, 10) || 50, 1), 200);
  const sql = `SELECT id, name, email, role FROM users WHERE name LIKE '%${name}%' ORDER BY ${sortBy} LIMIT ${n}`;
  return db.prepare(sql).all();
}
