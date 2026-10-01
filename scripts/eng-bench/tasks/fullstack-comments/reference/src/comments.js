// Reference implementation (grader self-test only).
import { badRequest } from './http.js';
import { getTicket } from './tickets.js';

export function listComments(db, ticketId) {
  getTicket(db, ticketId);
  return db.prepare('SELECT * FROM comments WHERE ticket_id = ? ORDER BY id').all(ticketId);
}

export function addComment(db, ticketId, input) {
  getTicket(db, ticketId);
  const author = typeof input.author === 'string' ? input.author.trim() : '';
  const body = typeof input.body === 'string' ? input.body.trim() : '';
  if (!author || author.length > 100) throw badRequest('author is required (1-100 characters)');
  if (!body || body.length > 2000) throw badRequest('body is required (1-2000 characters)');
  const { lastInsertRowid } = db.prepare('INSERT INTO comments (ticket_id, author, body) VALUES (?, ?, ?)').run(ticketId, author, body);
  return db.prepare('SELECT * FROM comments WHERE id = ?').get(Number(lastInsertRowid));
}
