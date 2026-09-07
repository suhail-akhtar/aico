import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { runAgent } from '../src/agent.js';
import type { ModelConfig } from '../src/model.js';
import { openDatabase } from '../src/store.js';
import { calculator } from '../src/tools.js';

process.env.NODE_ENV = 'test';

/**
 * A scripted model: each call returns the next reply. Proves the loop, the
 * tool plumbing and the routes with no key and no network.
 */
function scriptedModel(replies: Array<{ content?: string; tool?: { name: string; args: unknown } }>): ModelConfig & { requests: unknown[] } {
  let i = 0;
  const requests: unknown[] = [];
  const fakeFetch: typeof fetch = async (_url, init) => {
    requests.push(JSON.parse(String(init?.body)));
    const r = replies[Math.min(i++, replies.length - 1)]!;
    const message = r.tool
      ? { content: null, tool_calls: [{ id: `call_${i}`, type: 'function', function: { name: r.tool.name, arguments: JSON.stringify(r.tool.args) } }] }
      : { content: r.content ?? '' };
    return new Response(JSON.stringify({ choices: [{ message }], usage: { prompt_tokens: 10, completion_tokens: 5 } }), { status: 200 });
  };
  return { baseUrl: 'http://fake', apiKey: 'x', model: 'fake', fetch: fakeFetch, requests };
}

describe('the agent loop', () => {
  it('calls a tool, feeds the result back, and answers', async () => {
    const model = scriptedModel([{ tool: { name: 'calculate', args: { expression: '12.5 * 4' } } }, { content: 'It is 50.' }]);
    const events: string[] = [];
    const result = await runAgent([], 'what is 12.5 times 4?', { model, onEvent: e => events.push(e.type) });
    expect(result.answer).toBe('It is 50.');
    expect(result.steps).toBe(2);
    expect(events).toEqual(['step', 'tool_call', 'tool_result', 'step', 'answer']);
    const second = model.requests[1] as { messages: Array<{ role: string; content: string | null }> };
    expect(second.messages.at(-1)?.role).toBe('tool');
    expect(second.messages.at(-1)?.content).toBe('50');
    expect(second.messages[0]?.role).toBe('system');
  });

  it('feeds a tool error back as text rather than throwing', async () => {
    const model = scriptedModel([{ tool: { name: 'calculate', args: { expression: 'rm -rf /' } } }, { content: 'I cannot compute that.' }]);
    const result = await runAgent([], 'x', { model });
    const second = model.requests[1] as { messages: Array<{ role: string; content: string | null }> };
    expect(second.messages.at(-1)?.content).toMatch(/^Error:/);
    expect(result.answer).toBe('I cannot compute that.');
  });

  it('answers about an unknown tool instead of looping', async () => {
    const model = scriptedModel([{ tool: { name: 'launch_missiles', args: {} } }, { content: 'ok' }]);
    const result = await runAgent([], 'x', { model });
    const second = model.requests[1] as { messages: Array<{ content: string | null }> };
    expect(second.messages.at(-1)?.content).toMatch(/no tool called "launch_missiles"/);
    expect(result.answer).toBe('ok');
  });

  it('stops at maxSteps', async () => {
    const model = scriptedModel([{ tool: { name: 'now', args: {} } }]);
    const result = await runAgent([], 'x', { model, maxSteps: 3 });
    expect(result.steps).toBe(3);
    expect(result.answer).toMatch(/Stopped after 3 steps/);
  });
});

describe('the calculator tool', () => {
  it('evaluates arithmetic and refuses everything else', async () => {
    expect(await calculator.run({ expression: '(1 + 2) * 3' })).toBe('9');
    expect(await calculator.run({ expression: 'process.exit()' })).toMatch(/^Error/);
    expect(await calculator.run({ expression: '1/0' })).toMatch(/^Error/);
  });
});

describe('the routes', () => {
  it('creates a conversation, answers a message, and keeps the transcript', async () => {
    const model = scriptedModel([{ content: 'Hello!' }]);
    const app = createApp({ db: openDatabase(':memory:'), model });
    const created = await (await app.request('/conversations', { method: 'POST' })).json() as { id: string };
    const bad = await app.request(`/conversations/${created.id}/messages`, { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } });
    expect(bad.status).toBe(400);
    const res = await app.request(`/conversations/${created.id}/messages`, { method: 'POST', body: JSON.stringify({ text: 'hi' }), headers: { 'content-type': 'application/json' } });
    expect(await res.json()).toEqual({ answer: 'Hello!', steps: 1 });
    const stored = await (await app.request(`/conversations/${created.id}`)).json() as { messages: Array<{ role: string }> };
    expect(stored.messages.map(m => m.role)).toEqual(['system', 'user', 'assistant']);
    expect((await app.request('/conversations/nope')).status).toBe(404);
    expect((await app.request('/healthz')).status).toBe(200);
  });

  it('streams events when asked', async () => {
    const model = scriptedModel([{ tool: { name: 'now', args: {} } }, { content: 'done' }]);
    const app = createApp({ db: openDatabase(':memory:'), model });
    const created = await (await app.request('/conversations', { method: 'POST' })).json() as { id: string };
    const res = await app.request(`/conversations/${created.id}/messages`, {
      method: 'POST', body: JSON.stringify({ text: 'time?' }),
      headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
    });
    const text = await res.text();
    expect(text).toMatch(/event: tool_call/);
    expect(text).toMatch(/event: answer/);
    expect(text).toMatch(/event: done/);
  });
});
