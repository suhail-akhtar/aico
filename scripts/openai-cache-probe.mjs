/**
 * Why does OpenAI's Responses API serve so little from cache?
 *
 * Runs a short real turn through AICO's own Responses provider, via a local
 * proxy that records every request body and the usage OpenAI reports, then
 * says where consecutive requests first differ. An append-only conversation
 * should differ only at its end; anything earlier is a cache break.
 *
 * Run: node scripts/openai-cache-probe.mjs [model]   (after the test bundle is built)
 *
 * @module scripts/openai-cache-probe
 */
import './lib/test-home.mjs';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';

const MODEL = process.argv[2] ?? 'gpt-6-luna';
const settings = JSON.parse(fs.readFileSync(path.join(process.env.AICO_HOME, 'settings.json'), 'utf8'));
const openai = (settings.providerInstances ?? []).find(i => i.type === 'openai');
if (!openai?.apiKey) { console.error('no OpenAI instance with a key'); process.exit(1); }

const T = await import('../dist-test/test-exports.js');

const requests = [];
const server = http.createServer(async (req, res) => {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw);
  const record = { body, cached: undefined, input: undefined };
  requests.push(record);
  const upstream = await fetch(`https://api.openai.com${req.url}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${openai.apiKey}` },
    body: raw,
  });
  res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') ?? 'text/event-stream' });
  let tail = '';
  for await (const chunk of upstream.body) {
    const text = Buffer.from(chunk).toString('utf8');
    tail = (tail + text).slice(-20_000);
    res.write(chunk);
  }
  res.end();
  const done = /"type":"response\.completed".*$/m.exec(tail);
  if (done) {
    try {
      const usage = JSON.parse(done[0].replace(/^data: /, '').slice(done[0].indexOf('{'))).response?.usage;
      record.input = usage?.input_tokens;
      record.cached = usage?.input_tokens_details?.cached_tokens;
    } catch { /* usage unreadable */ }
  }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const baseURL = `http://127.0.0.1:${server.address().port}/v1`;

const dir = fs.mkdtempSync(path.join(process.cwd(), 'dist-test', 'cache-probe-'));
for (let i = 1; i <= 4; i++) fs.writeFileSync(path.join(dir, `part${i}.txt`), `PART ${i}\n${'some text here\n'.repeat(400)}`);

const real = new T.OpenAIResponsesProvider({
  id: 'openai', displayName: 'OpenAI', apiKey: openai.apiKey, baseURL, promptCacheKey: `aico-cache-probe-${Date.now()}`,
});
// PROBE_NO_TAIL=1: drop the volatile tail, to test whether it is what stops the cache growing.
// PROBE_STICKY=1: keep every earlier tail where it was sent, so each request
// contains the previous one whole (append-only), with the new tail last.
const kept = [];
const sticky = (opts) => {
  const messages = [...opts.messages];
  let shift = 0;
  for (const t of kept) { messages.splice(t.at + shift, 0, { role: 'user', content: t.text }); shift++; }
  if (opts.volatileContext) kept.push({ at: opts.messages.length, text: opts.volatileContext });
  return real.chat({ ...opts, messages: opts.volatileContext ? [...messages, { role: 'user', content: opts.volatileContext }] : messages, volatileContext: undefined });
};
const provider = process.env.PROBE_NO_TAIL
  ? { id: real.id, displayName: real.displayName, promptDialect: real.promptDialect,
    chat: (opts) => real.chat({ ...opts, volatileContext: undefined }) }
  : process.env.PROBE_STICKY
    ? { id: real.id, displayName: real.displayName, promptDialect: real.promptDialect, chat: sticky }
    : real;
const session = new T.Session({ id: `cache-probe-${Date.now()}`, cwd: process.cwd(), startedAt: Date.now() });
await T.runAgent({
  task: `Read ${dir}${path.sep}part1.txt, then part2.txt, then part3.txt, then part4.txt in that folder — one Read call per step, in order — then reply "done".`,
  model: MODEL, showPlan: false, autoApprove: true, verbose: false, silent: true,
  conversationHistory: [], sessionId: session.header.id, provider, session,
  settings: { ...settings, completionGate: { enabled: false }, cron: { enabled: false } },
}).catch(e => console.error('run error:', e.message));

const firstDiff = (a, b) => { let i = 0; while (i < a.length && a[i] === b[i]) i++; return i; };
for (let i = 0; i < requests.length; i++) {
  const r = requests[i];
  const line = `#${i + 1} input=${r.input} cached=${r.cached} items=${r.body.input?.length}`;
  if (i === 0) { console.log(line); continue; }
  const p = requests[i - 1].body;
  const same = (k) => JSON.stringify(p[k]) === JSON.stringify(r.body[k]);
  const prevInput = JSON.stringify(p.input);
  const curInput = JSON.stringify(r.body.input);
  const at = firstDiff(prevInput, curInput);
  console.log(`${line} | instructions ${same('instructions') ? 'same' : 'CHANGED'} | tools ${same('tools') ? 'same' : 'CHANGED'}`
    + ` | other keys ${Object.keys(r.body).filter(k => !['input', 'instructions', 'tools'].includes(k) && !same(k)).join(',') || 'same'}`
    + ` | input first differs at char ${at} of ${prevInput.length}: ${JSON.stringify(prevInput.slice(Math.max(0, at - 80), at + 80))}`);
}
const steps = session.events.filter(e => e.type === 'assistant/message' && e.data.usage).map(e => e.data.usage);
console.log('usage per step (input / cached):', steps.map(u => `${u.inputTokens}/${u.cachedTokens ?? 0}`).join('  '));
fs.writeFileSync(path.join(os.tmpdir(), 'openai-cache-probe.json'), JSON.stringify(requests.map(r => r.body), null, 2));
fs.rmSync(dir, { recursive: true, force: true });
server.close();
