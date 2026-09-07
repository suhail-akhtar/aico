import { serve } from '@hono/node-server';
import { createApp } from './app.js';
import { modelConfigFromEnv } from './model.js';
import { openDatabase } from './store.js';

const port = Number(process.env.PORT ?? 3000);
const model = modelConfigFromEnv();
if (!model.apiKey && !/localhost|127\.0\.0\.1/.test(model.baseUrl)) {
  console.warn('MODEL_API_KEY is not set; requests to the model will be refused. See .env.example.');
}
const db = openDatabase();
const app = createApp({ db, model });

const server = serve({ fetch: app.fetch, port, hostname: process.env.HOST ?? '0.0.0.0' }, info => {
  console.log(`listening on http://localhost:${info.port} (model ${model.model} at ${model.baseUrl})`);
});

function shutdown(signal: string): void {
  console.log(`${signal}: shutting down`);
  server.close(() => { db.close(); process.exit(0); });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
