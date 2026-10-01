// Reference fix (grader self-test only).
const SORTABLE = new Set(['name', 'email', 'role', 'created_at', 'id']);

export function findUsers(db, { name = '', sortBy = 'name', limit = 50 } = {}) {
  const n = Math.min(Math.max(Number.parseInt(limit, 10) || 50, 1), 200);
  const column = SORTABLE.has(sortBy) ? sortBy : 'name';
  const escaped = String(name).replace(/[\\%_]/g, (c) => `\\${c}`);
  return db.prepare(`SELECT id, name, email, role FROM users WHERE name LIKE ? ESCAPE '\\' ORDER BY ${column} LIMIT ?`)
    .all(`%${escaped}%`, n);
}
