/**
 * The application, separate from the server so tests can call it in memory
 * with `app.request('/items')` and never open a port.
 */
import { Hono } from 'hono';
import { logger } from 'hono/logger';
import { HTTPException } from 'hono/http-exception';
import type { DatabaseSync } from 'node:sqlite';
import { itemRoutes } from './items.js';
import { openapi } from './openapi.js';

export function createApp(db: DatabaseSync): Hono {
  const app = new Hono();

  if (process.env.NODE_ENV !== 'test') app.use(logger());

  // Health: liveness only. Say "ok" fast; anything slow belongs in /readyz.
  app.get('/healthz', c => c.json({ ok: true }));
  // Readiness: the database answers.
  app.get('/readyz', c => {
    try {
      db.prepare('SELECT 1').get();
      return c.json({ ok: true, db: 'ok' });
    } catch (err) {
      return c.json({ ok: false, db: err instanceof Error ? err.message : String(err) }, 503);
    }
  });

  app.get('/openapi.json', c => c.json(openapi));
  app.route('/items', itemRoutes(db));

  app.notFound(c => c.json({ error: 'not_found' }, 404));
  app.onError((err, c) => {
    if (err instanceof HTTPException) return err.getResponse();
    console.error(err);
    return c.json({ error: 'internal' }, 500);
  });

  return app;
}
