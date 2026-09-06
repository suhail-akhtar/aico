/**
 * The worked feature's data layer. Every feature in this app has a file like
 * this: a row type, a parse function returning field errors, and functions
 * that take the database and the acting user's id — never trusting an id from
 * the client without scoping it to that user.
 */
import type { DatabaseSync } from 'node:sqlite';

export interface Item {
  id: number;
  user_id: number;
  name: string;
  done: 0 | 1;
  created_at: string;
  updated_at: string;
}

export function parseItemName(raw: unknown): { value: string } | { error: string } {
  const name = typeof raw === 'string' ? raw.trim() : '';
  if (!name) return { error: 'Give it a name.' };
  if (name.length > 200) return { error: 'Keep it under 200 characters.' };
  return { value: name };
}

export function itemsFor(database: DatabaseSync, userId: number): Item[] {
  return database
    .prepare('SELECT * FROM items WHERE user_id = ? ORDER BY done ASC, created_at DESC, id DESC')
    .all(userId) as unknown as Item[];
}

export function createItem(database: DatabaseSync, userId: number, name: string): Item {
  const { lastInsertRowid } = database.prepare('INSERT INTO items (user_id, name) VALUES (?, ?)').run(userId, name);
  return database.prepare('SELECT * FROM items WHERE id = ?').get(Number(lastInsertRowid)) as unknown as Item;
}

/** Flip done. Scoped to the user: another user's id changes nothing and returns false. */
export function toggleItem(database: DatabaseSync, userId: number, id: number): boolean {
  return database
    .prepare("UPDATE items SET done = 1 - done, updated_at = datetime('now') WHERE id = ? AND user_id = ?")
    .run(id, userId).changes > 0;
}

export function deleteItem(database: DatabaseSync, userId: number, id: number): boolean {
  return database.prepare('DELETE FROM items WHERE id = ? AND user_id = ?').run(id, userId).changes > 0;
}
