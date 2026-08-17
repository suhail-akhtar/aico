/**
 * End-to-end probe of `aico serve` — every route the web client uses, against
 * a real server, with real providers.
 *
 * Drives the API exactly the way the browser does: opens the SSE stream first,
 * POSTs, reads frames, reconnects with `?since=`. Anything that only works
 * because a test called things in a convenient order is not tested here.
 *
 * Run with `npm run test:web`.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';

// Load .env the way the CLI does, so live provider tests have keys.
for (const line of fs.readFileSync('.env', 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)$/);
  if (m && m[2].trim()) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
}

/**
 * The provider tests write real settings, so the file is snapshotted first and
 * restored on the way out — including on failure. A test suite that leaves the
 * user's configuration pointing at a provider it invented and deleted is a
 * worse bug than anything it was checking for. (It did exactly that once.)
 */
const SETTINGS_PATH = path.join(os.homedir(), '.aico', 'settings.json');
const settingsBackup = (() => {
  try { return fs.readFileSync(SETTINGS_PATH, 'utf8'); } catch { return null; }
})();
const restoreSettings = () => {
  if (settingsBackup === null) return;
  try { fs.writeFileSync(SETTINGS_PATH, settingsBackup); } catch { /* nothing better to do */ }
};
process.on('exit', restoreSettings);
process.on('SIGINT', () => { restoreSettings(); process.exit(130); });

const { serve } = await import('./dist-test/server/index.js');

let pass = 0, fail = 0;
const check = (cond, name, detail) => {
  if (cond) { pass++; console.log(`   ✓ ${name}`); }
  else { fail++; console.log(`   ✗ ${name}${detail ? `\n       ${detail}` : ''}`); }
};
const section = (name) => console.log(`\n── ${name}`);

const MODEL = 'deepseek-v4-flash';
// Port 0: the OS assigns a free one. A fixed port made the suite fail whenever
// a development server happened to be running, which is exactly when someone
// is most likely to want to run it.
const { url, close } = await serve({ port: 0 });
const token = new URL(url).searchParams.get('token');
const origin = new URL(url).origin;
console.log(`serving on ${origin} (token ${token.slice(0, 6)}…)`);

const api = (path, init = {}) => fetch(`${origin}/api/${path}`, {
  ...init,
  headers: { 'Content-Type': 'application/json', 'x-aico-token': token, ...(init.headers ?? {}) },
});
const json = async (path, init) => (await api(path, init)).json();
const post = (path, body) => api(path, { method: 'POST', body: JSON.stringify(body) });

/**
 * Read an SSE stream until `stopOn` says to stop or the budget expires.
 * Mirrors the client's frame parser, including partial-frame buffering.
 */
async function readStream(sessionId, since, stopOn, budgetMs = 120_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), budgetMs);
  const frames = [];
  try {
    const res = await fetch(
      `${origin}/api/events?session=${sessionId}&since=${since}&token=${token}`,
      { signal: controller.signal, headers: { Accept: 'text/event-stream' } },
    );
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let i;
      while ((i = buffer.indexOf('\n\n')) >= 0) {
        const raw = buffer.slice(0, i);
        buffer = buffer.slice(i + 2);
        const line = raw.split('\n').find(l => l.startsWith('data: '));
        if (!line) continue;
        const event = JSON.parse(line.slice(6));
        frames.push(event);
        if (stopOn(event, frames)) { await reader.cancel().catch(() => {}); return frames; }
      }
    }
  } catch { /* aborted or closed — return what we got */ }
  finally { clearTimeout(timer); }
  return frames;
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ─────────────────────────────────────────────────────────────────────
section('Security');
{
  const noToken = await fetch(`${origin}/api/sessions`);
  check(noToken.status === 401, `no token is rejected (${noToken.status})`);

  const badToken = await api('sessions', { headers: { 'x-aico-token': 'nope' } });
  check(badToken.status === 401, `a wrong token is rejected (${badToken.status})`);

  const foreign = await api('sessions', { headers: { Origin: 'http://evil.example' } });
  check(foreign.status === 403, `a foreign Origin is refused (${foreign.status})`);

  const sameOrigin = await api('sessions', { headers: { Origin: origin } });
  check(sameOrigin.status === 200, 'the page\'s own Origin is accepted');

  const queryToken = await fetch(`${origin}/api/sessions?token=${token}`);
  check(queryToken.status === 200, 'a query-string token works (EventSource cannot set headers)');

  const traversal = await fetch(`${origin}/../../package.json`);
  const body = await traversal.text();
  check(!body.includes('"dependencies"'), 'path traversal cannot read outside the web root');
}

// ─────────────────────────────────────────────────────────────────────
section('Static client');
{
  const page = await fetch(`${origin}/`);
  const html = await page.text();
  check(page.status === 200, `the built client is served (${page.status})`);
  check(html.includes('<div id="root">'), 'index.html reaches the browser');
  check(!html.includes(token), 'the page body does not embed the token');

  const spa = await fetch(`${origin}/some/deep/route`);
  check(spa.status === 200, 'unknown paths fall back to index.html for client routing');
}

// ─────────────────────────────────────────────────────────────────────
section('Provider instances');
{
  const listing = await json('providers');
  check(Array.isArray(listing.instances), 'providers are returned as instances');
  check(Array.isArray(listing.types) && listing.types.length >= 8,
    `the family catalogue is offered for the add dialog (${listing.types?.length})`);
  check(listing.types.some(t => t.type === 'openai-compatible'),
    'including an OpenAI-compatible family for any other endpoint');
  check(listing.types.every(t => t.label && t.hint && typeof t.requiresKey === 'boolean'),
    'each family carries a label, a hint and whether it needs a key');

  const serialized = JSON.stringify(listing);
  check(!/"apiKey"/.test(serialized), 'no instance carries an apiKey field');
  for (const [name, value] of Object.entries(process.env)) {
    if (!/_API_KEY$/.test(name) || !value || value.length < 12) continue;
    check(!serialized.includes(value), `the real ${name} never appears in the providers response`);
  }
  check(listing.instances.every(i => i.keySource),
    'but provenance is reported, so the screen can say what is configured');
  check(listing.instances.some(i => i.derived), 'environment keys appear as detected instances');

  // ── create ──
  const created = await json('providers/save', { method: 'POST', body: JSON.stringify({
    instance: {
      id: 'e2e-gateway', type: 'openai-compatible', name: 'E2E Gateway',
      apiKey: 'sk-e2e-secret-value', baseUrl: 'https://gateway.example/v1',
      models: ['model-a', 'model-b'], defaultModel: 'model-b',
    },
  }) });
  check(created.instance?.id === 'e2e-gateway', 'a custom provider is created');
  check(!('apiKey' in (created.instance ?? {})), 'and the response does not echo the key back');

  const after = await json('providers');
  const mine = after.instances.find(i => i.id === 'e2e-gateway');
  check(Boolean(mine), 'it appears in the listing');
  check(mine.name === 'E2E Gateway', 'with the display name chosen for it');
  check(mine.baseUrl === 'https://gateway.example/v1', 'and the endpoint chosen for it');
  check(mine.defaultModel === 'model-b', 'and the chosen default model, not a hardcoded one');
  check(mine.keySource === 'settings', 'its key is recorded as saved');
  check(!JSON.stringify(after).includes('sk-e2e-secret-value'),
    'the saved key never comes back over the wire');

  // ── two of the same vendor ──
  await post('providers/save', { instance: { id: 'e2e-openai-a', type: 'openai', name: 'Work', apiKey: 'sk-a' } });
  await post('providers/save', { instance: { id: 'e2e-openai-b', type: 'openai', name: 'Personal', apiKey: 'sk-b' } });
  const both = (await json('providers')).instances.filter(i => i.id.startsWith('e2e-openai-'));
  check(both.length === 2, 'two instances of the same vendor coexist');
  check(both[0].name !== both[1].name, 'distinguished by their display names');

  // ── edit, and the blank-key rule ──
  await post('providers/save', { instance: {
    id: 'e2e-gateway', type: 'openai-compatible', name: 'Renamed Gateway',
    baseUrl: 'https://gateway.example/v1',
  } });
  const edited = (await json('providers')).instances.find(i => i.id === 'e2e-gateway');
  check(edited.name === 'Renamed Gateway', 'an edit applies');
  check(edited.keySource === 'settings',
    'and a blank key field keeps the stored key rather than deleting it');

  // ── validation ──
  const dupe = await api('providers/save', { method: 'POST', body: JSON.stringify({
    instance: { id: 'e2e-gateway', type: 'openai', name: 'Clash' },
  }) });
  check(dupe.status === 200, 'saving an existing id is an edit, not a collision');

  const noEndpoint = await api('providers/save', { method: 'POST', body: JSON.stringify({
    instance: { id: 'e2e-bad', type: 'openai-compatible', name: 'No endpoint' },
  }) });
  check(noEndpoint.status === 400, `a compatible provider with no endpoint is refused (${noEndpoint.status})`);
  const badBody = await noEndpoint.json();
  check(/endpoint/i.test(badBody.error ?? ''), `and the failure names the field: ${JSON.stringify(badBody.error)}`);

  const badUrl = await api('providers/save', { method: 'POST', body: JSON.stringify({
    instance: { id: 'e2e-bad2', type: 'openai', name: 'Bad', baseUrl: 'not a url' },
  }) });
  check(badUrl.status === 400, 'a malformed endpoint is refused');

  // ── activate ──
  await post('providers/activate', { id: 'e2e-openai-a', model: 'gpt-4o-mini' });
  const activated = await json('providers');
  check(activated.active === 'e2e-openai-a', 'a provider can be made active');
  check(activated.model === 'gpt-4o-mini', 'with a model the user chose, not a hardcoded default');

  // ── testing a draft, before saving ──
  const draftTest = await json('providers/test', { method: 'POST', body: JSON.stringify({
    type: 'deepseek', apiKey: process.env.DEEPSEEK_API_KEY,
  }) });
  check(draftTest.ok === true, `a draft can be tested before it is saved (${draftTest.error ?? 'ok'})`);
  check(Array.isArray(draftTest.models), 'and returns the catalogue to choose a default from');

  const draftBad = await json('providers/test', { method: 'POST', body: JSON.stringify({
    type: 'deepseek', apiKey: 'sk-not-a-real-key',
  }) });
  check(draftBad.ok === false, 'a bad draft key is reported as a failure');

  const noEndpointTest = await json('providers/test', { method: 'POST', body: JSON.stringify({
    type: 'openai-compatible', apiKey: 'k',
  }) });
  check(noEndpointTest.ok === false && /endpoint/i.test(noEndpointTest.error ?? ''),
    'testing a compatible provider with no endpoint says so rather than probing nothing');

  // ── delete ──
  for (const id of ['e2e-gateway', 'e2e-openai-a', 'e2e-openai-b']) {
    await post('providers/delete', { id });
  }
  const cleaned = (await json('providers')).instances.filter(i => i.id.startsWith('e2e-'));
  check(cleaned.length === 0, 'providers can be removed');
}

// ─────────────────────────────────────────────────────────────────────
section('System routes');
{
  const settings = await json('settings');
  const settingsJson = JSON.stringify(settings);
  check(!/"apiKey"/.test(settingsJson), 'GET /settings never returns an apiKey field');
  for (const [name, value] of Object.entries(process.env)) {
    if (!/_API_KEY$/.test(name) || !value || value.length < 12) continue;
    check(!settingsJson.includes(value), `the real ${name} does not appear in the settings response`);
  }

  const system = await json('system');
  check(Array.isArray(system.backgroundAgents), 'system reports background agents');
  check(Array.isArray(system.cron), 'system reports scheduled jobs');
  check(Array.isArray(system.worktrees), 'system reports worktrees');
  check(Array.isArray(system.skills) && system.skills.length > 0,
    `system reports loaded skills (${system.skills?.length})`);
  check(Array.isArray(system.mcpServers), 'system reports MCP servers');

  const badMethod = await post('system', {});
  check(badMethod.status === 405, `GET-only routes reject POST (${badMethod.status})`);
}

// ─────────────────────────────────────────────────────────────────────
section('A streamed turn, end to end');
const chatSession = `web-e2e-${Date.now()}`;
let turnSeq = 0;
{
  // A generous budget on purpose. This case asserts that turn-end reaches the
  // client, not that the model obeys "use no tools" — and it sometimes does
  // not, taking a tool-calling detour that outlasts a tight deadline. Failing
  // here for that reason tests the model, not the transport.
  const streaming = readStream(chatSession, 0, ev => ev.type === 'turn-end', 240_000);
  await sleep(500);

  const submitted = await post('submit', {
    sessionId: chatSession,
    task: 'Reply with exactly: hello. Use no tools.',
    model: MODEL,
  });
  check(submitted.status === 202, `submit returns immediately (${submitted.status}), not held open`);

  const frames = await streaming;
  const types = frames.map(f => f.type);
  console.log(`   frames: ${[...new Set(types)].join(', ')}`);

  check(types[0] === 'caught-up', 'the stream opens by declaring a resume point');
  check(types.includes('turn-start'), 'turn-start reaches the client');
  check(types.includes('chunk'), 'text streams as it is produced');
  check(types.includes('tokens'), 'token usage is reported during the turn');
  check(types.includes('turn-end'), 'turn-end closes the turn');

  const tokens = frames.filter(f => f.type === 'tokens').pop();
  check(tokens?.data.input > 0, `input tokens are non-zero (${tokens?.data.input})`);
  check(typeof tokens?.data.costUsd === 'number', `cost is estimated (${tokens?.data.costUsd})`);
  check(tokens?.data.cached >= 0, 'cached tokens are reported as their own figure');

  const end = frames.find(f => f.type === 'turn-end');
  check(!end.data.error, `the turn succeeded${end.data.error ? `: ${end.data.error}` : ''}`);
  check(/hello/i.test(String(end.data.result ?? '')), `the model answered: ${JSON.stringify(end.data.result)}`);
  turnSeq = end.data.seq;
  check(turnSeq > 0, `turn-end carries the resume seq (${turnSeq})`);

  const streamed = frames.filter(f => f.type === 'chunk').map(f => f.data.text).join('');
  const final = String(end.data.result ?? '');
  // A multi-step turn streams every step, while the result is the last message,
  // so containment — not equality — is the honest invariant. What must never
  // happen is text appearing in the answer that was never streamed.
  check(streamed.includes(final.trim()) || final.trim() === streamed.trim(),
    'every character of the answer was streamed first',
    `streamed=${JSON.stringify(streamed)} final=${JSON.stringify(final)}`);
}

// ─────────────────────────────────────────────────────────────────────
section('Reconnect and replay');
{
  const replay = await readStream(chatSession, 0, ev => ev.type === 'caught-up');
  const logs = replay.filter(f => f.type === 'log');
  check(logs.length > 0, `a fresh connection replays the log (${logs.length} events)`);
  check(logs.every(f => typeof f.seq === 'number'), 'every replayed event carries its seq');
  check(logs.some(f => f.data.type === 'user/message'), 'the replay includes the user message');
  check(logs.some(f => f.data.type === 'assistant/message'), 'the replay includes the assistant message');

  const seqs = logs.map(f => f.seq);
  check(seqs.every((s, i) => i === 0 || s > seqs[i - 1]), 'replayed seqs are strictly increasing');

  const caughtUp = replay.find(f => f.type === 'caught-up');
  check(caughtUp.seq >= turnSeq, `caught-up reports the current head (${caughtUp.seq})`);
  check(caughtUp.data.busy === false, 'a finished session reports itself idle');

  const tail = await readStream(chatSession, caughtUp.seq, ev => ev.type === 'caught-up');
  check(tail.filter(f => f.type === 'log').length === 0,
    'a client already at the head receives no duplicate events');

  // The gap replay is the mechanism the client relies on after every turn.
  const midpoint = Math.floor(seqs[seqs.length - 1] / 2);
  const gap = await readStream(chatSession, midpoint, ev => ev.type === 'caught-up');
  const gapSeqs = gap.filter(f => f.type === 'log').map(f => f.seq);
  check(gapSeqs.every(s => s > midpoint), `?since= replays only the gap (${gapSeqs.length} events after ${midpoint})`);
}

// ─────────────────────────────────────────────────────────────────────
section('Session state');
{
  const snapshot = await json(`session?id=${chatSession}`);
  check(snapshot.messages.length >= 2, `derived messages are available (${snapshot.messages.length})`);
  check(snapshot.usage.inputTokens > 0, `usage is retained (${snapshot.usage.inputTokens} in)`);
  check(snapshot.busy === false, 'the session is not busy after the turn');

  const list = await json('sessions');
  check(list.sessions.some(s => s.id === chatSession), 'the session appears in the session list');
  check(list.active.includes(chatSession), 'it is also listed as an open run');

  const missing = await api('session');
  check(missing.status === 400, `session without an id is a 400 (${missing.status})`);
}

// ─────────────────────────────────────────────────────────────────────
section('Tool use reaches the client');
const toolSession = `web-tool-${Date.now()}`;
{
  const streaming = readStream(toolSession, 0, ev => ev.type === 'turn-end', 180_000);
  await sleep(500);
  await post('submit', {
    sessionId: toolSession,
    task: 'Use the bash tool once to run: echo AICO_TOOL_OK. Then reply with the output.',
    model: MODEL,
  });

  const frames = await streaming;
  const starts = frames.filter(f => f.type === 'tool-start');
  const dones = frames.filter(f => f.type === 'tool-done');

  check(starts.length > 0, `a tool call was dispatched (${starts.length})`);
  check(dones.length > 0, `a tool result came back (${dones.length})`);
  check(starts.every(f => f.data.callId), 'every tool-start carries the provider call id');
  check(dones.every(f => f.data.callId), 'every tool-done carries the provider call id');

  const startIds = new Set(starts.map(f => f.data.callId));
  const doneIds = new Set(dones.map(f => f.data.callId));
  check([...startIds].every(id => doneIds.has(id)),
    'every started call also completed — no card can be stranded on "running"');
  check(startIds.size === starts.length, 'call ids are distinct, so parallel calls cannot collide');

  const end = frames.find(f => f.type === 'turn-end');
  check(/AICO_TOOL_OK/.test(String(end?.data.result ?? '')),
    'the tool actually ran and its output reached the answer');

  // The durable form must carry the same pairing, since that is what a
  // reconnecting client renders from.
  const replay = await readStream(toolSession, 0, ev => ev.type === 'caught-up');
  const calls = replay.filter(f => f.data?.type === 'tool/call');
  const results = replay.filter(f => f.data?.type === 'tool/result');
  check(calls.length > 0, `the log records the tool call (${calls.length})`);
  check(results.length > 0, `the log records the tool result (${results.length})`);
  check(calls.every(c => results.some(r => r.data.callId === c.data.callId)),
    'each logged call has a logged result citing the same id');
}

// ─────────────────────────────────────────────────────────────────────
section('Steering, follow-ups, and cancellation');
{
  const busySession = `web-steer-${Date.now()}`;

  // Start something long enough to interrupt.
  const streaming = readStream(busySession, 0, ev => ev.type === 'turn-end', 180_000);
  await sleep(400);
  await post('submit', {
    sessionId: busySession,
    task: 'Count slowly from 1 to 40, one number per line, with a short sentence about each.',
    model: MODEL,
  });
  await sleep(2500);

  const steered = await json('steer', { method: 'POST', body: JSON.stringify({ sessionId: busySession, content: 'Stop counting and say DONE.' }) });
  check(steered.ok === true, 'steer is accepted while a turn runs');

  const queued = await json('followup', { method: 'POST', body: JSON.stringify({ sessionId: busySession, content: 'Then say NEXT.' }) });
  check(queued.ok === true, 'a follow-up is accepted without disturbing the running turn');

  const rejected = await post('submit', { sessionId: busySession, task: 'another', model: MODEL });
  check(rejected.status === 202, 'a second submit is still answered 202 (it fails on the stream)');

  const cancelled = await json('cancel', { method: 'POST', body: JSON.stringify({ sessionId: busySession }) });
  check(cancelled.cancelled === true, 'cancel reports that it stopped a running turn');

  const frames = await streaming;
  const end = frames.filter(f => f.type === 'turn-end').pop();
  check(Boolean(end), 'the cancelled turn still produced a turn-end');
  check(end?.data.cancelled === true || !end?.data.error,
    `cancellation is reported as an outcome, not a crash (${JSON.stringify(end?.data).slice(0, 90)})`);

  const noRun = await json('cancel', { method: 'POST', body: JSON.stringify({ sessionId: 'nothing-here' }) });
  check(noRun.cancelled === false, 'cancelling an idle session is false, not an error');

  const badSteer = await api('steer', { method: 'POST', body: JSON.stringify({ sessionId: busySession }) });
  check(badSteer.status === 400, `steer without content is a 400 (${badSteer.status})`);
}

// ─────────────────────────────────────────────────────────────────────
section('Session naming');
{
  const titleSession = `web-title-${Date.now()}`;
  const frames = [];
  const streaming = readStream(titleSession, 0, ev => {
    frames.push(ev);
    return ev.type === 'turn-end';
  }, 180_000);
  await sleep(400);

  const ask = 'Explain in one short sentence what a monotonic sequence number is for.';
  await post('submit', { sessionId: titleSession, task: ask, model: MODEL });
  await streaming;

  const titleEvents = frames.filter(f => f.type === 'title');
  check(titleEvents.length > 0, `a title is pushed over the stream (${titleEvents.length})`);
  const fallback = titleEvents.find(f => f.data.source === 'fallback');
  check(Boolean(fallback), 'a deterministic fallback arrives first');
  check(fallback && frames.indexOf(fallback) < frames.findIndex(f => f.type === 'turn-start'),
    'and arrives BEFORE the turn starts, so the sidebar is never nameless while it runs');
  check(fallback?.data.title.startsWith('Explain in one short'),
    `the fallback comes from the first message (${JSON.stringify(fallback?.data.title)})`);

  // The model title is produced after turn-end and is not awaited, so it is
  // polled for rather than expected on the stream that already closed.
  let modelTitle;
  for (let attempt = 0; attempt < 25 && !modelTitle; attempt++) {
    await sleep(1000);
    const listed = await json('sessions');
    const row = listed.sessions.find(s => s.id === titleSession);
    if (row?.titleSource === 'model') modelTitle = row;
  }
  check(Boolean(modelTitle), 'a model-written title replaces the fallback');
  if (modelTitle) {
    console.log(`   title: ${JSON.stringify(modelTitle.title)}`);
    check(modelTitle.title.length > 0 && modelTitle.title.length < 100,
      `it is short enough for a sidebar (${modelTitle.title.length} chars)`);
    check(!/^["']|["']$/.test(modelTitle.title), 'and is unquoted');
    check(!modelTitle.title.includes('\n'), 'and is one line');
  }

  // ── rename pins it ──
  const renamed = await json('session/rename', { method: 'POST', body: JSON.stringify({
    sessionId: titleSession, title: 'My own name for this',
  }) });
  check(renamed.renamed === true, 'a session can be renamed');

  const afterRename = (await json('sessions')).sessions.find(s => s.id === titleSession);
  check(afterRename.title === 'My own name for this', 'the rename is reflected in the listing');
  check(afterRename.titleSource === 'user', 'and is recorded as the user’s decision');

  const blank = await api('session/rename', { method: 'POST', body: JSON.stringify({
    sessionId: titleSession, title: '',
  }) });
  check(blank.status === 400, `a blank rename is refused (${blank.status})`);

  // ── the listing itself ──
  const listing = await json('sessions');
  check(Array.isArray(listing.sessions), 'sessions are returned as summaries, not bare ids');
  check(listing.sessions.every(s => typeof s.id === 'string' && typeof s.updatedAt === 'number'),
    'each carries an id and a last-touched time');
  const times = listing.sessions.map(s => s.updatedAt);
  check(times.every((t, i) => i === 0 || t <= times[i - 1]),
    'most recently touched first, so the sidebar opens on what you were doing');
  check(listing.sessions.some(s => s.title), 'named sessions report their names');
}

// ─────────────────────────────────────────────────────────────────────
section('Goals');
{
  const goalSession = `web-goal-${Date.now()}`;

  const set = await json('goal', { method: 'POST', body: JSON.stringify({
    sessionId: goalSession, text: 'Ship the trajectory view', status: 'active',
  }) });
  check(set.ok === true, 'a goal can be set');

  const view = await json(`trajectory?id=${goalSession}`);
  check(view.goal?.text === 'Ship the trajectory view', 'and read back');
  check(view.goal?.status === 'active', 'as active');

  await post('goal', { sessionId: goalSession, text: 'Ship the trajectory view', status: 'paused' });
  const paused = await json(`trajectory?id=${goalSession}`);
  check(paused.goal?.status === 'paused', 'pausing works');

  await post('goal', { sessionId: goalSession, text: 'Ship the trajectory view', status: 'active' });
  check((await json(`trajectory?id=${goalSession}`)).goal?.status === 'active', 'resuming works');

  await post('goal', { sessionId: goalSession, text: '', status: 'cleared' });
  const cleared = await json(`trajectory?id=${goalSession}`);
  check(cleared.goal === null, 'clearing leaves no goal to render');

  const goalEvents = cleared.events.filter(e => e.type === 'goal/set');
  check(goalEvents.length === 4,
    `every decision is retained, not overwritten (${goalEvents.length} events)`);

  const noText = await api('goal', { method: 'POST', body: JSON.stringify({ sessionId: goalSession, status: 'active' }) });
  check(noText.status === 400, `setting a goal with no text is refused (${noText.status})`);
  const clearNoText = await api('goal', { method: 'POST', body: JSON.stringify({ sessionId: goalSession, status: 'cleared' }) });
  check(clearNoText.status === 200, 'but clearing needs no text');
}

// ─────────────────────────────────────────────────────────────────────
section('Message feedback');
{
  const rateSession = `web-rate-${Date.now()}`;
  await post('goal', { sessionId: rateSession, text: 'seed the session', status: 'active' });

  const up = await json('feedback', { method: 'POST', body: JSON.stringify({
    sessionId: rateSession, targetSeq: 3, rating: 'up',
  }) });
  check(up.ok === true, 'a message can be rated');

  await post('feedback', { sessionId: rateSession, targetSeq: 7, rating: 'down', note: 'missed the constraint' });
  const rated = await json(`trajectory?id=${rateSession}`);
  check(rated.feedback['3']?.rating === 'up', 'ratings are keyed by the seq they judge');
  check(rated.feedback['7']?.rating === 'down', 'both ratings are kept');
  check(rated.feedback['7']?.note === 'missed the constraint', 'with the note');

  await post('feedback', { sessionId: rateSession, targetSeq: 3, rating: 'down' });
  check((await json(`trajectory?id=${rateSession}`)).feedback['3'].rating === 'down',
    'a later rating supersedes an earlier one');

  await post('feedback', { sessionId: rateSession, targetSeq: 3, rating: 'none' });
  const withdrawn = await json(`trajectory?id=${rateSession}`);
  check(withdrawn.feedback['3'] === undefined, 'withdrawing removes the rating entirely');
  check(withdrawn.feedback['7'] !== undefined, 'leaving other ratings alone');

  const badRating = await api('feedback', { method: 'POST', body: JSON.stringify({
    sessionId: rateSession, targetSeq: 1, rating: 'sideways',
  }) });
  check(badRating.status === 400, `an invalid rating is refused (${badRating.status})`);
  const noTarget = await api('feedback', { method: 'POST', body: JSON.stringify({
    sessionId: rateSession, rating: 'up',
  }) });
  check(noTarget.status === 400, `a rating with no target is refused (${noTarget.status})`);
}

// ─────────────────────────────────────────────────────────────────────
section('Subagent catalogue');
{
  const { agents } = await json('agents');
  check(Array.isArray(agents) && agents.length > 0, `agents are enumerated (${agents?.length})`);
  check(agents.every(a => a.name && a.description && a.role), 'each carries name, description and role');
  check(agents.every(a => Array.isArray(a.tools)), 'and its allowed tools');
  check(agents.some(a => a.canDelegate === true), 'delegation capability is reported');
  const serialized = JSON.stringify(agents);
  check(!/systemPromptXml/.test(serialized),
    'the full system prompt is not shipped — thousands of tokens the panel never reads');
  check(serialized.length < 100_000, `the payload stays small (${serialized.length} bytes)`);

  const wrongMethod = await post('agents', {});
  check(wrongMethod.status === 405, `agents is GET-only (${wrongMethod.status})`);
}

// ─────────────────────────────────────────────────────────────────────
section('Trajectory and deliverables');
{
  const trajSession = `web-traj-${Date.now()}`;
  const frames = [];
  const streaming = readStream(trajSession, 0, ev => {
    frames.push(ev);
    return ev.type === 'turn-end';
  }, 240_000);
  await sleep(400);

  await post('submit', {
    sessionId: trajSession,
    task: 'Use the Write tool to create a file at .aico/tmp/e2e-deliverable.md containing the single word: done. Then reply OK.',
    model: MODEL,
  });
  await streaming;

  const end = frames.find(f => f.type === 'turn-end');
  check(Boolean(end), 'the turn finished');
  check(Array.isArray(end?.data.deliverables),
    'turn-end carries the deliverables, so the client needs no second request');
  const produced = end?.data.deliverables ?? [];
  check(produced.length > 0, `the written file is reported (${produced.length})`);
  if (produced.length > 0) {
    console.log(`   produced: ${produced.map(d => `${d.action} ${d.path}`).join(', ')}`);
    check(produced.some(d => d.path.includes('e2e-deliverable')), 'by path');
    check(produced.every(d => d.action === 'created' || d.action === 'modified'),
      'each labelled created or modified');
    check(produced.every(d => d.touches >= 1), 'with a touch count');
  }

  const view = await json(`trajectory?id=${trajSession}`);
  check(view.total > 0, `the ledger holds the session's events (${view.total})`);
  check(view.events.every(e => typeof e.seq === 'number' && typeof e.timestamp === 'number'),
    'each event carries its seq and clock');
  check(view.events.some(e => e.type === 'turn/start'),
    'including the bookkeeping the transcript hides');
  check(view.events.some(e => e.type === 'step/start'), 'and step boundaries');

  check(view.steps.length > 0, `step timings are computed (${view.steps.length})`);
  const timed = view.steps.filter(s => s.ttftMs !== undefined);
  check(timed.length > 0, `at least one step reports time to first token (${timed.length})`);
  if (timed.length > 0) {
    const s = timed[0];
    console.log(`   step ${s.turn}.${s.step}: ttft ${Math.round(s.ttftMs)}ms, decode ${Math.round(s.decodeMs ?? 0)}ms`);
    check(s.ttftMs > 0, 'TTFT is a real measurement, not zero');
    check(s.ttftMs + (s.decodeMs ?? 0) <= (s.endedAt - s.startedAt) + 5,
      'waiting plus streaming does not exceed the step duration');
    check(s.firstTokenAt >= s.startedAt, 'the first token cannot precede the step');
  }
  check(view.steps.every(s => s.endedAt === undefined || s.endedAt >= s.startedAt),
    'no step ends before it starts');

  // Paging walks backwards from the tail.
  const paged = await json(`trajectory?id=${trajSession}&limit=3`);
  check(paged.events.length <= 3, `limit is honoured (${paged.events.length})`);
  check(paged.total === view.total, 'while total still reports the whole ledger');
  const oldest = paged.events[0]?.seq ?? 0;
  const earlier = await json(`trajectory?id=${trajSession}&limit=3&before=${oldest}`);
  check(earlier.events.every(e => e.seq < oldest), 'before= returns strictly older events');
  check(paged.hasMore === true, 'a partial page reports that more exists');

  const missing = await api('trajectory');
  check(missing.status === 400, `trajectory without an id is a 400 (${missing.status})`);
}

// ─────────────────────────────────────────────────────────────────────
section('A reopened session shows everything that happened');
{
  const memory = `web-memory-${Date.now()}`;
  const TASKS = [
    'Use the LS tool on shared/ui, then say how many files there are.',
    'Now reply with one short sentence. No tools.',
  ];

  const liveTypes = new Set();
  for (const task of TASKS) {
    const streaming = readStream(memory, 0, ev => { liveTypes.add(ev.type); return ev.type === 'turn-end'; }, 240_000);
    await sleep(300);
    await post('submit', { sessionId: memory, task, model: MODEL });
    await streaming;
    await sleep(1500);
  }

  // What a browser refresh does: a fresh stream from the beginning.
  const replay = await readStream(memory, 0, ev => ev.type === 'caught-up');
  const logged = replay.filter(f => f.type === 'log').map(f => f.data.type);
  const count = (type) => logged.filter(t => t === type).length;

  check(count('user/message') === TASKS.length,
    `every turn's question survives a reload (${count('user/message')}/${TASKS.length})`);
  check(count('assistant/message') >= TASKS.length,
    `every reply survives (${count('assistant/message')})`);
  check(count('tool/call') > 0, `tool calls survive (${count('tool/call')})`);
  check(count('tool/call') === count('tool/result'),
    'and every call still has its result');
  check(logged.includes('turn/start') && logged.includes('turn/end'),
    'turn boundaries survive, so the trajectory is complete too');

  // Ordering is the part that is easy to get wrong and impossible to notice
  // in a one-turn test.
  const seqs = replay.filter(f => f.type === 'log').map(f => f.seq);
  check(seqs.every((s, i) => i === 0 || s > seqs[i - 1]),
    'events replay in strictly increasing order');

  const traj = await json(`trajectory?id=${memory}`);
  check(traj.total === logged.length,
    `the replay delivers the whole log, nothing skipped (${logged.length}/${traj.total})`);

  // Usage is server state rather than log state, so it needs its own path.
  const snapshot = await json(`session?id=${memory}`);
  check(snapshot.usage?.inputTokens > 0,
    `a reopened session reports its token usage (${snapshot.usage?.inputTokens})`);
  check(typeof snapshot.usage?.costUsd === 'number',
    `and its cost (${snapshot.usage?.costUsd}), rather than starting from zero`);

  check(snapshot.messages.length >= TASKS.length * 2,
    `the derived transcript holds both turns (${snapshot.messages.length} messages)`);
}

// ─────────────────────────────────────────────────────────────────────
section('Reloading mid-run does not disturb the run');
{
  const runId = `web-reconnect-${Date.now()}`;

  // A turn long enough to still be going when the "browser" goes away.
  const firstView = [];
  const firstStream = readStream(runId, 0, ev => {
    firstView.push(ev);
    // Stop reading once the turn is properly under way — this is the tab
    // closing, not the turn ending.
    return firstView.filter(f => f.type === 'chunk').length >= 3;
  }, 120_000);

  await sleep(300);
  await post('submit', {
    sessionId: runId,
    task: 'Count from 1 to 30, one number per line, with a short clause about each number.',
    model: MODEL,
  });

  await firstStream;
  const sawStart = firstView.some(f => f.type === 'turn-start');
  check(sawStart, 'the turn started before the client went away');
  check(!firstView.some(f => f.type === 'turn-end'),
    'and had not finished — otherwise this proves nothing');

  // The tab is gone. Nothing should be cancelled by that.
  await sleep(1200);

  const stillBusy = await json(`session?id=${runId}`);
  check(stillBusy.busy === true,
    'the run is still going after the only client disconnected');

  // What a reload does: a brand-new stream from the beginning.
  const second = [];
  const secondStream = readStream(runId, 0, ev => {
    second.push(ev);
    return ev.type === 'turn-end';
  }, 180_000);

  const frames = await secondStream;

  const caughtUp = frames.find(f => f.type === 'caught-up');
  check(caughtUp?.data.busy === true,
    'the reconnecting client is told the turn is still running');
  check(frames.some(f => f.type === 'log' && f.data.type === 'user/message'),
    'it replays the question that started the turn');

  const laterChunks = frames.filter(f => f.type === 'chunk');
  check(laterChunks.length > 0,
    `and keeps receiving live text (${laterChunks.length} chunks after reconnecting)`);

  const end = frames.find(f => f.type === 'turn-end');
  check(Boolean(end), 'the turn reaches its end on the reconnected stream');
  check(!end?.data.error,
    `and finished normally, not cancelled by the disconnect (${end?.data.error ?? 'no error'})`);
  check(String(end?.data.result ?? '').length > 0, 'with a real answer');

  // The accumulated-not-delta contract is what makes a mid-stream reconnect
  // self-heal: the first chunk after reconnecting carries everything so far,
  // so the text the client missed while away is not lost.
  if (laterChunks.length > 0) {
    const firstAfter = String(laterChunks[0].data.text ?? '');
    const finalText = String(end?.data.result ?? '');
    check(finalText.startsWith(firstAfter.slice(0, 20)) || finalText.includes(firstAfter.slice(0, 20)),
      'the first chunk after reconnecting continues the same reply, not a new one');
    check(firstAfter.length > 0, 'and carries the text accumulated while the client was away');
  }

  // The durable record must show one turn, not two.
  const traj = await json(`trajectory?id=${runId}`);
  const starts = traj.events.filter(e => e.type === 'turn/start').length;
  const users = traj.events.filter(e => e.type === 'user/message').length;
  check(starts === 1, `the disconnect started no second turn (${starts} turn/start)`);
  check(users === 1, `and asked nothing twice (${users} user/message)`);

  const finished = await json(`session?id=${runId}`);
  check(finished.busy === false, 'the run is idle once it is genuinely done');
}

// ─────────────────────────────────────────────────────────────────────
section('Malformed input');
{
  const noTask = await api('submit', { method: 'POST', body: JSON.stringify({ sessionId: 'x' }) });
  check(noTask.status === 400, `submit without a task is a 400 (${noTask.status})`);

  const badJson = await api('submit', { method: 'POST', body: '{not json' });
  check(badJson.status === 500 || badJson.status === 400,
    `a malformed body is refused, not crashed on (${badJson.status})`);

  const unknown = await api('does-not-exist', { method: 'POST', body: '{}' });
  check(unknown.status === 404, `an unknown route is a 404 (${unknown.status})`);

  const noSession = await fetch(`${origin}/api/events?token=${token}`);
  check(noSession.status === 400, `the stream requires a session id (${noSession.status})`);

  // The server must still be alive after all of that.
  const alive = await api('sessions');
  check(alive.status === 200, 'the server survived every malformed request');
}

await close();
console.log(`\n${'═'.repeat(50)}`);
console.log(`  WEB E2E: ${pass} passed, ${fail} failed`);
console.log(`${'═'.repeat(50)}\n`);
process.exit(fail > 0 ? 1 : 0);
