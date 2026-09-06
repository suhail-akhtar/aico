import { beforeEach, describe, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '@/lib/db';
import { createItem, deleteItem, itemsFor, parseItemName, toggleItem } from '@/lib/items';

describe('items', () => {
  let db: DatabaseSync;
  let alice: number;
  let bob: number;

  beforeEach(() => {
    db = openDatabase(':memory:');
    const insert = db.prepare('INSERT INTO users (email, password_hash) VALUES (?, ?)');
    alice = Number(insert.run('alice@example.com', 'x').lastInsertRowid);
    bob = Number(insert.run('bob@example.com', 'x').lastInsertRowid);
  });

  it('parses names', () => {
    expect(parseItemName('  milk ')).toEqual({ value: 'milk' });
    expect(parseItemName('')).toEqual({ error: 'Give it a name.' });
    expect(parseItemName(42)).toEqual({ error: 'Give it a name.' });
    expect('error' in parseItemName('x'.repeat(201))).toBe(true);
  });

  it('lists open before done, newest first, per user', () => {
    const a = createItem(db, alice, 'first');
    createItem(db, alice, 'second');
    createItem(db, bob, 'bobs');
    toggleItem(db, alice, a.id);
    expect(itemsFor(db, alice).map(i => i.name)).toEqual(['second', 'first']);
    expect(itemsFor(db, alice).map(i => i.done)).toEqual([0, 1]);
    expect(itemsFor(db, bob).map(i => i.name)).toEqual(['bobs']);
  });

  it('scopes toggle and delete to the owner', () => {
    const a = createItem(db, alice, 'mine');
    expect(toggleItem(db, bob, a.id)).toBe(false);
    expect(deleteItem(db, bob, a.id)).toBe(false);
    expect(itemsFor(db, alice)).toHaveLength(1);
    expect(deleteItem(db, alice, a.id)).toBe(true);
    expect(itemsFor(db, alice)).toHaveLength(0);
  });

  it('cascades when a user goes', () => {
    createItem(db, bob, 'gone with bob');
    db.prepare('DELETE FROM users WHERE id = ?').run(bob);
    expect(db.prepare('SELECT count(*) AS n FROM items').get()).toEqual({ n: 0 });
  });
});
