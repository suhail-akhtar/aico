/**
 * The reported case, end to end, against the real server: an OpenAI-compatible
 * endpoint that reports no window and puts a running usage total on every
 * streamed chunk, serving a model nothing has heard of.
 *
 * What it proves, on the wire the browser and the VS Code panel actually read:
 *
 *   - usage is counted once per request, so the cost does not climb per chunk;
 *   - a prompt larger than the assumed window raises the window, the meter's
 *     next reading carries the corrected figure, and a notice says so once;
 *   - the corrected figure is persisted with its provenance — in this
 *     process's own store, not the reader's.
 *
 * Spends nothing: the endpoint is a stub on localhost.
 *
 *   npm run build && node scripts/window-floor-live.mjs
 */
// A store of this process's own — nothing below may touch ~/.aico. Must stay first.
import './lib/test-home.mjs';
import { spawn } from 'child_process';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const entry = path.join(root, 'dist', 'index.js');
if (!fs.existsSync(entry)) { console.error(`No build at ${entry}. Run: npm run build`); process.exit(1); }

let passed = 0, failed = 0;
const fails = [];
function check(cond, label) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; fails.push(label); console.log(`  ✗ ${label}`); }
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ── the endpoint ────────────────────────────────────────────────────────────
const PROMPT_TOKENS = 150_000;   // past the 128K that would be assumed
const CHUNKS = ['The ', 'answer ', 'is ', 'forty-', 'two.'];
const requests = [];
const stub = http.createServer((req, res) => {
  let raw = '';
  req.on('data', c => { raw += c; });
  req.on('end', () => {
    if (req.method === 'GET' && /\/models$/.test(req.url ?? '')) {
      // Lists the model and says nothing about its window: the case where
      // detection has nothing to find and 128K is assumed.
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'stub/model-x', object: 'model' }] }));
      return;
    }
    requests.push({ url: req.url, body: raw });
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    CHUNKS.forEach((content, i) => {
      res.write(`data: ${JSON.stringify({
        id: 'c', object: 'chat.completion.chunk', model: 'stub/model-x',
        choices: [{ index: 0, delta: { content } }],
        // A running total on every chunk — the shape that was being summed.
        usage: { prompt_tokens: PROMPT_TOKENS, completion_tokens: i + 1 },
      })}\n\n`);
    });
    res.write(`data: ${JSON.stringify({
      id: 'c', object: 'chat.completion.chunk', model: 'stub/model-x',
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: PROMPT_TOKENS, completion_tokens: CHUNKS.length },
    })}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
  });
});
await new Promise(r => stub.listen(0, '127.0.0.1', r));
const baseUrl = `http://127.0.0.1:${stub.address().port}/v1`;

// ── this process's own settings: the stub is the only provider ─────────────
const home = process.env.AICO_HOME;
fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify({
  providerInstances: [{ id: 'stub', name: 'Stub gateway', type: 'openai-compatible', baseUrl, apiKey: 'k', defaultModel: 'stub/model-x' }],
  activeProvider: 'stub',
  model: 'stub/model-x',
  autoApprove: true,
}, null, 2));

const realProjects = path.join(os.homedir(), '.aico', 'projects');
const realCountBefore = fs.existsSync(realProjects) ? fs.readdirSync(realProjects).length : 0;

const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'aico-floor-'));
fs.writeFileSync(path.join(ws, 'README.md'), '# floor\n');

// ── the server ──────────────────────────────────────────────────────────────
let child;
const server = await new Promise((resolve, reject) => {
  child = spawn(process.execPath, [entry, 'serve', '--no-open', '--project', ws], {
    cwd: ws, env: { ...process.env, FORCE_COLOR: '0' },
  });
  const timer = setTimeout(() => reject(new Error('serve never printed a URL')), 90_000);
  let out = '';
  const read = (d) => {
    out += d.toString();
    const m = /http:\/\/127\.0\.0\.1:(\d+)\/\?token=([A-Za-z0-9_-]+)/.exec(out);
    if (m) { clearTimeout(timer); resolve({ base: `http://127.0.0.1:${m[1]}`, token: m[2] }); }
  };
  child.stdout.on('data', read);
  child.stderr.on('data', read);
  child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`serve exited (${code}):\n${out.slice(-600)}`)); });
});

const H = { 'content-type': 'application/json', 'x-aico-token': server.token };
const post = (r, b) => fetch(`${server.base}/api/${r}`, { method: 'POST', headers: H, body: JSON.stringify(b) }).then(r => r.json());
const get = (r) => fetch(`${server.base}/api/${r}`, { headers: H }).then(r => r.json());

console.log('\nWINDOW FLOOR — the reported case, through the real server\n');
try {
  const sid = 'floor-' + Date.now().toString(36);

  // Subscribe before submitting so nothing is missed.
  const events = [];
  const controller = new AbortController();
  const streaming = fetch(`${server.base}/api/events?session=${sid}&since=0&project=${encodeURIComponent(ws)}`, {
    headers: { 'x-aico-token': server.token }, signal: controller.signal,
  }).then(async (res) => {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let at;
      while ((at = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, at); buffer = buffer.slice(at + 2);
        const line = frame.split('\n').find(l => l.startsWith('data: '));
        if (line) { try { events.push(JSON.parse(line.slice(6))); } catch { /* ping */ } }
      }
    }
  }).catch(() => undefined);
  await sleep(500);

  const before = await get(`context-window?model=${encodeURIComponent('stub/model-x')}`);
  check(before.source === 'assumed' && before.tokens === 128_000,
    `before the turn the window is assumed at 128K (${before.tokens} · ${before.source})`);

  await post('submit', { sessionId: sid, project: ws, task: 'Reply with exactly: ok.', model: 'stub/model-x' });
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline && !events.some(e => e.type === 'turn-end')) await sleep(200);
  controller.abort();
  await streaming;

  check(events.some(e => e.type === 'turn-end'), 'the turn completed');
  // Two requests reach the stub: the turn, and the one that names the session.
  const turns = requests.filter(r => { try { return (JSON.parse(r.body).tools?.length ?? 0) > 0; } catch { return false; } });
  check(turns.length === 1, `the stub served the turn once (${turns.length} of ${requests.length} requests; the other, without tools, names the session)`);

  const tokens = events.filter(e => e.type === 'tokens');
  check(tokens.length === 1, `six chunks carrying usage produced ONE tokens event (${tokens.length})`);
  const t = tokens[0]?.data ?? {};
  check(t.input === PROMPT_TOKENS, `and it carries the request's prompt size, not six times it (${t.input})`);
  check(t.output === CHUNKS.length, `and the final completion count, not a sum of running totals (${t.output})`);
  check(typeof t.costUsd === 'number' && t.costUsd < 0.2,
    `the cost is that of one 150K prompt at the fallback rate, not of six ($${t.costUsd})`);
  check(t.costEstimated === true, 'and is labelled an estimate, because a custom endpoint\'s prices are unknown');
  check(t.contextWindow === 200_000 && t.contextSource === 'observed',
    `the meter's reading already carries the corrected window (${t.contextWindow} · ${t.contextSource})`);

  const notice = events.find(e => e.type === 'notice' && /accepted a prompt/.test(e.data?.text ?? ''));
  check(Boolean(notice), 'a notice says the window grew');
  check(/150,000/.test(notice?.data?.text ?? '') && /128,000/.test(notice?.data?.text ?? '') && /200,000/.test(notice?.data?.text ?? ''),
    `and names the prompt, the assumption and the new figure (${JSON.stringify(notice?.data?.text ?? '').slice(0, 120)}…)`);
  check(events.filter(e => e.type === 'notice' && /accepted a prompt/.test(e.data?.text ?? '')).length === 1, 'said once');

  const after = await get(`context-window?model=${encodeURIComponent('stub/model-x')}`);
  check(after.tokens === 200_000 && after.source === 'observed', `the route reports it (${after.tokens} · ${after.source})`);
  await sleep(300);
  const stored = JSON.parse(fs.readFileSync(path.join(home, 'settings.json'), 'utf8')).contextWindows?.['stub/model-x'];
  check(stored?.tokens === 200_000 && stored?.source === 'observed', `persisted with its provenance (${JSON.stringify(stored)})`);

  // The model's own view of it.
  const shown = await post('submit', { sessionId: sid, project: ws, task: 'ignored by the stub', model: 'stub/model-x' });
  check(shown.accepted === true, 'a second turn is accepted (the stub answers the same way)');

  // ── the reader's store was never touched ──────────────────────────────
  const realCountAfter = fs.existsSync(realProjects) ? fs.readdirSync(realProjects).length : 0;
  check(realCountAfter === realCountBefore, `the real store has the same number of project folders as before (${realCountAfter})`);
  let realWindows = {};
  try { realWindows = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.aico', 'settings.json'), 'utf8')).contextWindows ?? {}; } catch { /* none */ }
  check(!('stub/model-x' in realWindows), 'and the real settings do not know the stub model');
  check(fs.existsSync(path.join(home, 'projects')), `this run's sessions went to its own store (${home})`);
} finally {
  try { child.kill(); } catch { /* gone */ }
  if (process.platform === 'win32' && child?.pid) {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  }
  stub.close();
  await sleep(300);
  try { fs.rmSync(ws, { recursive: true, force: true }); } catch { /* best effort */ }
}

console.log(`\nWINDOW FLOOR: ${passed} passed, ${failed} failed`);
for (const f of fails) console.log(`  ✗ ${f}`);
process.exit(failed ? 1 : 0);
