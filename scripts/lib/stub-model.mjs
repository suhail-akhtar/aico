/**
 * A scripted OpenAI-compatible model server, for offline suites and cheap
 * live checks that need the real agent loop without paying for a model.
 *
 * Why a server and not the loop's `provider` test seam: the seam reaches only
 * the run it is passed to. A sub-agent, a background agent, a turn the server
 * starts by itself — every child run resolves its provider from settings, so
 * the only way to script all of them is to be the provider they resolve to.
 * Point `providerInstances` at {@link startStubModel}'s URL and every run in the
 * process (and every process sharing the store) talks to this.
 *
 * The route decides each reply from the request: `{ text }`, `{ tools: [{ name,
 * args }] }`, `{ status, error }`, or a promise of one — which is how a test
 * holds a reply until something else has happened.
 */
import http from 'http';

/** The text of a chat message, whatever shape its content came in. */
export function textOf(message) {
  const c = message?.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map(p => (typeof p === 'string' ? p : p?.text ?? '')).join('');
  return '';
}

/**
 * Start the stub. `route(body)` returns (or resolves to) the reply.
 * Returns `{ url, port, requests, close }`; `url` ends in `/v1`.
 */
export async function startStubModel(route) {
  const requests = [];
  let seq = 0;
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', c => { raw += c; });
    req.on('end', async () => {
      if (req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ object: 'list', data: [{ id: 'stub/model', object: 'model' }] }));
        return;
      }
      let body = {};
      try { body = JSON.parse(raw || '{}'); } catch { /* answered as an empty request */ }
      requests.push(body);
      let reply;
      try { reply = await route(body); } catch (err) { reply = { status: 500, error: String(err) }; }
      reply = reply ?? { text: 'ok' };
      if (reply.status) {
        res.writeHead(reply.status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: reply.error ?? 'stub error', type: 'invalid_request_error' } }));
        return;
      }
      const id = `stub-${++seq}`;
      const usage = { prompt_tokens: reply.promptTokens ?? 100, completion_tokens: reply.completionTokens ?? 10 };
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const send = (choice) => res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', model: 'stub/model', choices: [{ index: 0, ...choice }] })}\n\n`);
      if (reply.tools?.length) {
        reply.tools.forEach((t, i) => send({
          delta: { tool_calls: [{ index: i, id: `call_${seq}_${i}`, type: 'function', function: { name: t.name, arguments: JSON.stringify(t.args ?? {}) } }] },
        }));
        if (reply.text) send({ delta: { content: reply.text } });
        send({ delta: {}, finish_reason: 'tool_calls' });
      } else {
        send({ delta: { content: reply.text ?? 'ok' } });
        send({ delta: {}, finish_reason: 'stop' });
      }
      res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', model: 'stub/model', choices: [], usage })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  return {
    url: `http://127.0.0.1:${port}/v1`,
    port,
    requests,
    close: () => new Promise(r => { server.closeAllConnections?.(); server.close(() => r()); }),
  };
}

/** Settings that make the stub the only provider. */
export function stubSettings(url, extra = {}) {
  return {
    providerInstances: [{ id: 'stub', name: 'Stub model', type: 'openai-compatible', baseUrl: url, apiKey: 'stub-key', defaultModel: 'stub/model' }], // standards-allow: secret
    activeProvider: 'stub',
    model: 'stub/model',
    autoApprove: true,
    sentinel: { mode: 'off' },
    ...extra,
  };
}
