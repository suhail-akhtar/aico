/**
 * Process entry: open the database, build the app, listen, and stop cleanly.
 *
 * Config is environment only (`PORT`, `DATABASE_PATH`), which is what lets the
 * same image run under Docker, Fly, Render, Railway, ECS or a VPS unchanged.
 * SIGTERM closes the server and the database so a rolling deploy loses nothing.
 */
import { serve } from '@hono/node-server';
import { createApp } from './app.js';
import { openDatabase } from './db.js';

const port = Number(process.env.PORT ?? 3000);
const db = openDatabase();
const app = createApp(db);

const server = serve({ fetch: app.fetch, port, hostname: process.env.HOST ?? '0.0.0.0' }, info => {
  // The word "listening" is what aico's runner waits for before it opens the URL.
  console.log(`listening on http://localhost:${info.port}`);
});

function shutdown(signal: string): void {
  console.log(`${signal}: shutting down`);
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
