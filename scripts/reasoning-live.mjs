/**
 * What each provider actually puts on the wire when a reasoning level is set.
 *
 * The capability table is unit-tested and proves nothing about requests. The
 * risk this covers is the one that costs a turn: four vendors spell the same
 * idea four different ways — `reasoning_effort`, `reasoning: {effort}`,
 * `thinking: {type}`, `output_config.effort` — and sending the wrong shape is a
 * 400 on every request rather than a degraded answer.
 *
 * So a local server stands in for each endpoint and records exactly what
 * arrived. No network, no keys, no model: the request body is the whole subject.
 *
 * Shapes were read from each vendor's own documentation and are restated here
 * so a future edit has something to fail against:
 *
 *   OpenAI      two paths, because it has two APIs:
 *                 gpt-5.6 routes to Responses  → reasoning: { effort }
 *                 everything else to Chat      → reasoning_effort: '<level>'
 *   OpenRouter  reasoning: { effort: '<level>' }
 *   Z.AI GLM    thinking: { type: 'enabled' | 'disabled' }   (a switch)
 *   Gemini      nothing — its compat surface has not been verified
 *
 * Run: node scripts/reasoning-live.mjs
 * Needs: npx tsup src/test-exports.ts --format esm --outDir dist-test --target node22
 */

// A store of this process's own — nothing below may touch ~/.aico. Must stay first.
import './lib/test-home.mjs';
import http from 'http';

import { providerFromInstance, runInContext } from '../dist-test/test-exports.js';

let passed = 0, failed = 0;
const fails = [];
function check(cond, label) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; fails.push(label); console.log(`  ✗ ${label}`); }
}

/** A stand-in endpoint that records one request body and answers plausibly. */
async function endpoint() {
  const seen = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', c => { raw += c; });
    req.on('end', () => {
      try { seen.push(JSON.parse(raw)); } catch { seen.push({ unparsed: raw }); }
      // A minimal SSE completion: enough for the provider to finish cleanly
      // rather than throw, which would hide the body we came for.
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: {"choices":[{"delta":{"content":"ok"},"index":0}]}\n\n');
      res.write('data: {"choices":[{"delta":{},"finish_reason":"stop","index":0}]}\n\n');
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return { seen, port: server.address().port, close: () => server.close() };
}

/** Drive one provider once, at one effort, and hand back what it sent. */
async function capture(type, model, effort) {
  const where = await endpoint();
  try {
    const provider = providerFromInstance(
      {
        id: `probe-${type}`,
        name: `probe ${type}`,
        type,
        apiKey: 'probe-key',
        baseUrl: `http://127.0.0.1:${where.port}`,
      },
      model,
      {},
    );

    await runInContext({ cwd: process.cwd(), ...(effort ? { effort } : {}) }, async () => {
      const stream = provider.chat({
        model,
        messages: [{ role: 'user', content: 'hi' }],
        systemPrompt: 'be brief',
        tools: [],
      });
      // Drained, because the request is not sent until the generator is pulled.
      for await (const _ of stream) { /* the body is the subject, not the reply */ }
    });
  } catch {
    // A provider that dislikes the stand-in still sent its request first, which
    // is all this needs. Failing here would hide the body.
  } finally {
    where.close();
  }
  return where.seen[0] ?? {};
}

try {
  console.log('\nREASONING ON THE WIRE\n');

  /*
    ── OpenAI, which has two shapes because it has two APIs ──────────

    gpt-5.6 is routed to the Responses API — it refuses function tools
    alongside reasoning on Chat Completions — and Responses spells effort as
    `reasoning: { effort }`. Everything else takes `reasoning_effort`. Wiring
    only the second left the entire gpt-5.6 path ignoring the picker, which is
    what this probe found and nothing else could have.
  */
  const responses = await capture('openai', 'gpt-5.6', 'max');
  check(responses.reasoning?.effort === 'max',
    `OpenAI/Responses sends reasoning.effort (${JSON.stringify(responses.reasoning)})`);
  check(responses.reasoning_effort === undefined,
    'and not the Chat Completions spelling');

  const chat = await capture('openai', 'o3', 'max');
  check(chat.reasoning_effort === 'max',
    `OpenAI/Chat sends reasoning_effort (${JSON.stringify(chat.reasoning_effort)})`);
  check(chat.reasoning === undefined,
    'and not the Responses shape, which Chat Completions does not read');

  // ── OpenRouter: reasoning: { effort } ─────────────────────────────
  const router = await capture('openrouter', 'gpt-5.6', 'high');
  check(router.reasoning?.effort === 'high',
    `OpenRouter sends reasoning.effort (${JSON.stringify(router.reasoning)})`);
  check(router.reasoning_effort === undefined,
    'and not the bare reasoning_effort, which it does not read');

  // ── Z.AI: a switch, not a ladder ──────────────────────────────────
  const zaiOn = await capture('zai', 'glm-4.6', 'high');
  check(zaiOn.thinking?.type === 'enabled',
    `GLM turns thinking on for any level above off (${JSON.stringify(zaiOn.thinking)})`);
  const zaiOff = await capture('zai', 'glm-4.6', 'off');
  check(zaiOff.thinking?.type === 'disabled',
    'and off is a real request rather than the absence of one');

  /*
    ── auto imposes nothing ──────────────────────────────────────────

    `auto` means the *run* expresses no preference. What reaches the wire is
    then whatever the provider was configured with — which for a fresh install
    is nothing at all, and for someone who set a default in settings is their
    default. The assertion is therefore that auto does not carry the run's
    choice, not that the field is always absent: conflating those would make
    `auto` quietly override a configured preference.
  */
  for (const [type, model] of [['openai', 'gpt-5.6'], ['openrouter', 'gpt-5.6'], ['zai', 'glm-4.6']]) {
    const body = await capture(type, model, 'auto');
    const carried = body.reasoning_effort ?? body.reasoning?.effort;
    /*
      Compared against `max`, which is what the runs above asked for, rather
      than against "absent". OpenAI's Responses provider has always defaulted
      to `low` and still does — auto leaving that alone is the correct
      behaviour, and an assertion of "no field at all" would have called that
      a bug.
    */
    check(carried !== 'max',
      `${type}: auto imposes no level of its own (${JSON.stringify(carried)})`);
  }

  /*
    ── the deliberate silences ───────────────────────────────────────

    Gemini's OpenAI-compatible surface has not been read, so nothing is sent
    even though the table knows its levels. This asserts the abstention, so
    that wiring it later is a deliberate act with a failing test to update
    rather than something that quietly starts happening.
  */
  const gemini = await capture('gemini', 'gemini-3.7-flash', 'low');
  check(
    gemini.reasoning_effort === undefined && gemini.reasoning === undefined
    && gemini.thinking === undefined,
    'Gemini is sent no reasoning field — its compat shape is unverified',
  );

  // ── a model that does not reason is never sent a level ────────────
  const plain = await capture('openai', 'gpt-4o-mini', 'high');
  check(plain.reasoning_effort === undefined,
    'a non-reasoning model gets no reasoning_effort — it answers that with a 400',
  );
} catch (err) {
  failed += 1;
  fails.push(`threw: ${err?.stack ?? err}`);
  console.log(`\n  ✗ ${err?.stack ?? err}`);
}

console.log(`\nREASONING: ${passed} passed, ${failed} failed`);
if (fails.length) {
  console.log('\nFailures:');
  for (const f of fails) console.log(`  - ${f}`);
}
process.exit(failed > 0 ? 1 : 0);
