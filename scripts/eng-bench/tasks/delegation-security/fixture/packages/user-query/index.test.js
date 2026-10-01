import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { findUsers } from './index.js';

function db() {
  const d = new DatabaseSync(':memory:');
  d.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT, email TEXT, role TEXT, created_at TEXT);
    INSERT INTO users (name, email, role, created_at) VALUES
      ('Ana Lima', 'ana@example.com', 'admin', '2024-01-03'),
      ('Bo Chen', 'bo@example.com', 'member', '2024-02-01'),
      ('Cara Diaz', 'cara@example.com', 'member', '2023-12-11');`);
  return d;
}

test('filters by name substring', () => {
  assert.deepEqual(findUsers(db(), { name: 'Chen' }).map((u) => u.name), ['Bo Chen']);
});

test('sorts by a column', () => {
  assert.deepEqual(findUsers(db(), { sortBy: 'created_at' }).map((u) => u.name), ['Cara Diaz', 'Ana Lima', 'Bo Chen']);
});

test('defaults to name order', () => {
  assert.deepEqual(findUsers(db()).map((u) => u.name), ['Ana Lima', 'Bo Chen', 'Cara Diaz']);
});
