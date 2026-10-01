import { badRequest, notFound } from './http.js';

const PRIORITIES = ['low', 'normal', 'high'];
const STATUSES = ['open', 'pending', 'closed'];

export function listTickets(db) {
  return db.prepare('SELECT t.*, (SELECT count(*) FROM comments c WHERE c.ticket_id = t.id) AS comment_count FROM tickets t ORDER BY t.created_at DESC, t.id DESC').all();
}

export function getTicket(db, id) {
  const row = db.prepare('SELECT t.*, (SELECT count(*) FROM comments c WHERE c.ticket_id = t.id) AS comment_count FROM tickets t WHERE t.id = ?').get(id);
  if (!row) throw notFound(`ticket ${id} not found`);
  return row;
}

export function createTicket(db, input) {
  const title = typeof input.title === 'string' ? input.title.trim() : '';
  if (!title || title.length > 200) throw badRequest('title is required (1-200 characters)');
  const description = input.description === undefined ? '' : String(input.description);
  if (description.length > 5000) throw badRequest('description is too long');
  const priority = input.priority ?? 'normal';
  if (!PRIORITIES.includes(priority)) throw badRequest(`priority must be one of ${PRIORITIES.join(', ')}`);
  const { lastInsertRowid } = db.prepare('INSERT INTO tickets (title, description, priority) VALUES (?, ?, ?)')
    .run(title, description, priority);
  return getTicket(db, Number(lastInsertRowid));
}

export function updateStatus(db, id, input) {
  if (!STATUSES.includes(input.status)) throw badRequest(`status must be one of ${STATUSES.join(', ')}`);
  getTicket(db, id);
  db.prepare("UPDATE tickets SET status = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?").run(input.status, id);
  return getTicket(db, id);
}
