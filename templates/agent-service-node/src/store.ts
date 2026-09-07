/**
 * Conversations, kept: one row per conversation with its transcript as JSON.
 * node:sqlite, in-process, migrated on open, `:memory:` in tests.
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ChatMessage } from './model.js';

const MIGRATIONS: string[] = [
  `CREATE TABLE IF NOT EXISTS conversations (
     id          TEXT PRIMARY KEY,
     messages    TEXT NOT NULL DEFAULT '[]',
     created_at  TEXT NOT NULL DEFAULT (datetime('now')),
     updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
   )`,
];

export function openDatabase(file = process.env.DATABASE_PATH ?? './data/app.sqlite'): DatabaseSync {
  if (file !== ':memory:') mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('CREATE TABLE IF NOT EXISTS _migrations (n INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
  const done = new Set((db.prepare('SELECT n FROM _migrations').all() as Array<{ n: number }>).map(r => r.n));
  MIGRATIONS.forEach((sql, i) => {
    if (done.has(i + 1)) return;
    db.exec(sql);
    db.prepare('INSERT INTO _migrations (n, applied_at) VALUES (?, ?)').run(i + 1, new Date().toISOString());
  });
  return db;
}

export interface Conversation { id: string; messages: ChatMessage[]; created_at: string; updated_at: string }

export function conversations(db: DatabaseSync) {
  const get = db.prepare('SELECT * FROM conversations WHERE id = ?');
  const insert = db.prepare('INSERT INTO conversations (id, messages) VALUES (?, ?)');
  const update = db.prepare("UPDATE conversations SET messages = ?, updated_at = datetime('now') WHERE id = ?");
  const list = db.prepare('SELECT id, created_at, updated_at FROM conversations ORDER BY updated_at DESC LIMIT 100');
  const parse = (row: Record<string, unknown> | undefined): Conversation | undefined =>
    row ? { ...(row as Omit<Conversation, 'messages'>), messages: JSON.parse(String(row.messages)) as ChatMessage[] } : undefined;
  return {
    get: (id: string) => parse(get.get(id) as Record<string, unknown> | undefined),
    create(): Conversation {
      const id = randomUUID();
      insert.run(id, '[]');
      return parse(get.get(id) as Record<string, unknown>)!;
    },
    save(id: string, messages: ChatMessage[]): void { update.run(JSON.stringify(messages), id); },
    list: () => list.all() as Array<Omit<Conversation, 'messages'>>,
  };
}
