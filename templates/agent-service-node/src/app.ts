/**
 * The HTTP surface: start a conversation, send a message (streamed or not),
 * read one back. Built as a function of its dependencies so tests run it in
 * memory with a scripted model.
 */
import { Hono } from 'hono';
import { logger } from 'hono/logger';
import { streamSSE } from 'hono/streaming';
import type { DatabaseSync } from 'node:sqlite';
import { runAgent, type AgentEvent } from './agent.js';
import type { ModelConfig } from './model.js';
import { conversations } from './store.js';
import { TOOLS, type Tool } from './tools.js';

export interface AppDeps {
  db: DatabaseSync;
  model: ModelConfig;
  tools?: Tool[];
}

export function createApp({ db, model, tools = TOOLS }: AppDeps): Hono {
  const app = new Hono();
  const store = conversations(db);
  if (process.env.NODE_ENV !== 'test') app.use(logger());

  app.get('/healthz', c => c.json({ ok: true }));
  app.get('/readyz', c => {
    try { db.prepare('SELECT 1').get(); return c.json({ ok: true, db: 'ok', model: model.model }); }
    catch (err) { return c.json({ ok: false, db: err instanceof Error ? err.message : String(err) }, 503); }
  });

  app.get('/conversations', c => c.json({ conversations: store.list() }));
  app.post('/conversations', c => c.json(store.create(), 201));
  app.get('/conversations/:id', c => {
    const found = store.get(c.req.param('id'));
    return found ? c.json(found) : c.json({ error: 'not_found' }, 404);
  });

  /**
   * Send a message. `Accept: text/event-stream` streams the loop's events —
   * step, tool_call, tool_result, answer — as they happen; otherwise the
   * answer comes back as one JSON body when the loop finishes.
   */
  app.post('/conversations/:id/messages', async c => {
    const found = store.get(c.req.param('id'));
    if (!found) return c.json({ error: 'not_found' }, 404);
    const body = await c.req.json().catch(() => ({})) as { text?: unknown };
    const text = typeof body.text === 'string' ? body.text.trim() : '';
    if (!text) return c.json({ error: 'invalid', fields: { text: 'Say something.' } }, 400);

    if (c.req.header('accept')?.includes('text/event-stream')) {
      return streamSSE(c, async stream => {
        const send = (event: AgentEvent) => stream.writeSSE({ event: event.type, data: JSON.stringify(event) });
        try {
          const result = await runAgent(found.messages, text, { model, tools, onEvent: e => { void send(e); } });
          store.save(found.id, result.messages);
          await stream.writeSSE({ event: 'done', data: JSON.stringify({ steps: result.steps }) });
        } catch (err) {
          await send({ type: 'error', message: err instanceof Error ? err.message : String(err) });
        }
      });
    }

    try {
      const result = await runAgent(found.messages, text, { model, tools });
      store.save(found.id, result.messages);
      return c.json({ answer: result.answer, steps: result.steps });
    } catch (err) {
      return c.json({ error: 'model', message: err instanceof Error ? err.message : String(err) }, 502);
    }
  });

  app.notFound(c => c.json({ error: 'not_found' }, 404));
  return app;
}
