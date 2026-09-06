/**
 * The worked resource. Every other resource in this service copies this file:
 * a row type, a parsed input type with a `parse` function that returns field
 * errors, a repository over the database, and the routes.
 *
 * Validation returns `{ errors }` rather than throwing, so the route can answer
 * 400 with the field names — the shape a client can show beside the field.
 */
import { Hono } from 'hono';
import type { DatabaseSync } from 'node:sqlite';

export interface Item {
  id: number;
  name: string;
  quantity: number;
  created_at: string;
  updated_at: string;
}

export interface ItemInput {
  name: string;
  quantity: number;
}

export type FieldErrors = Record<string, string>;

/** Parse an unknown body into an ItemInput, or say what is wrong with it. */
export function parseItem(body: unknown): { value: ItemInput } | { errors: FieldErrors } {
  const errors: FieldErrors = {};
  const b = (body ?? {}) as Record<string, unknown>;
  const name = typeof b.name === 'string' ? b.name.trim() : '';
  if (!name) errors.name = 'Name is required.';
  else if (name.length > 120) errors.name = 'Name must be 120 characters or fewer.';
  const quantity = b.quantity === undefined ? 0 : Number(b.quantity);
  if (!Number.isInteger(quantity) || quantity < 0) errors.quantity = 'Quantity must be a whole number, zero or more.';
  if (Object.keys(errors).length) return { errors };
  return { value: { name, quantity } };
}

export function itemsRepo(db: DatabaseSync) {
  const list = db.prepare('SELECT * FROM items ORDER BY created_at DESC, id DESC LIMIT ?');
  const get = db.prepare('SELECT * FROM items WHERE id = ?');
  const insert = db.prepare('INSERT INTO items (name, quantity) VALUES (?, ?)');
  const update = db.prepare("UPDATE items SET name = ?, quantity = ?, updated_at = datetime('now') WHERE id = ?");
  const remove = db.prepare('DELETE FROM items WHERE id = ?');
  return {
    list: (limit = 100): Item[] => list.all(limit) as unknown as Item[],
    get: (id: number): Item | undefined => get.get(id) as unknown as Item | undefined,
    create(input: ItemInput): Item {
      const { lastInsertRowid } = insert.run(input.name, input.quantity);
      return get.get(Number(lastInsertRowid)) as unknown as Item;
    },
    update(id: number, input: ItemInput): Item | undefined {
      const { changes } = update.run(input.name, input.quantity, id);
      return changes ? (get.get(id) as unknown as Item) : undefined;
    },
    remove: (id: number): boolean => remove.run(id).changes > 0,
  };
}

function idParam(raw: string): number | undefined {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

export function itemRoutes(db: DatabaseSync): Hono {
  const repo = itemsRepo(db);
  const r = new Hono();

  r.get('/', c => {
    const limit = Math.min(Number(c.req.query('limit') ?? 100) || 100, 1000);
    return c.json({ items: repo.list(limit) });
  });

  r.post('/', async c => {
    const parsed = parseItem(await c.req.json().catch(() => null));
    if ('errors' in parsed) return c.json({ error: 'invalid', fields: parsed.errors }, 400);
    return c.json(repo.create(parsed.value), 201);
  });

  r.get('/:id', c => {
    const id = idParam(c.req.param('id'));
    const item = id && repo.get(id);
    return item ? c.json(item) : c.json({ error: 'not_found' }, 404);
  });

  r.put('/:id', async c => {
    const id = idParam(c.req.param('id'));
    if (!id) return c.json({ error: 'not_found' }, 404);
    const parsed = parseItem(await c.req.json().catch(() => null));
    if ('errors' in parsed) return c.json({ error: 'invalid', fields: parsed.errors }, 400);
    const item = repo.update(id, parsed.value);
    return item ? c.json(item) : c.json({ error: 'not_found' }, 404);
  });

  r.delete('/:id', c => {
    const id = idParam(c.req.param('id'));
    return id && repo.remove(id) ? c.body(null, 204) : c.json({ error: 'not_found' }, 404);
  });

  return r;
}
