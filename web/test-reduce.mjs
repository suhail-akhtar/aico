/**
 * Tests for the log→messages reduction.
 *
 * These cover the failure modes that are invisible until they happen in front
 * of a user: a reconnect duplicating a whole turn, a tool result landing on the
 * wrong card, an Anthropic thinking trace rendered as raw JSON.
 *
 * Offline by design — no server, no DOM, no network.
 */

import assert from 'node:assert/strict';
import { suggestKnowledge } from './dist-test/knowledge-suggest.mjs';
import {
  applyLogEvent, readReasoning, parseArgs, orderMessages,
  withPending, dropPending, PENDING_KEY,
} from './dist-test/reduce.mjs';

let pass = 0, fail = 0;
const test = (name, fn) => {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (err) { fail++; console.log(`  ✗ ${name}\n      ${err.message}`); }
};
const section = (name) => console.log(`\n  -- ${name} --`);

const fold = (events, start = new Map()) =>
  events.reduce((acc, [seq, data]) => applyLogEvent(acc, seq, data, 1), start);

// ── replay idempotency ───────────────────────────────────────────────
section('Replaying a turn twice does not duplicate it');

const TURN = [
  [1, { type: 'turn/start', turn: 1 }],
  [2, { type: 'user/message', content: 'list the files' }],
  [3, { type: 'tool/call', callId: 'call_a', name: 'bash', arguments: '{"command":"ls"}' }],
  [4, { type: 'tool/result', callId: 'call_a', name: 'bash', content: 'README.md' }],
  [5, { type: 'assistant/message', content: 'There is one file.' }],
  [6, { type: 'turn/end', turn: 1 }],
];

test('a single pass yields user + tool + assistant', () => {
  const messages = orderMessages(fold(TURN));
  assert.deepEqual(messages.map(m => m.type), ['user', 'tool', 'assistant']);
});

test('replaying the identical events changes nothing', () => {
  const once = orderMessages(fold(TURN));
  const twice = orderMessages(fold(TURN, fold(TURN)));
  assert.deepEqual(twice, once, 'a reconnect must not double the transcript');
});

test('replaying from a mid-turn seq converges on the same transcript', () => {
  // What a client that dropped after seq 3 actually does: it keeps what it had
  // and asks the server for everything after.
  const partial = fold(TURN.slice(0, 3));
  const resumed = fold(TURN.slice(3), partial);
  assert.deepEqual(orderMessages(resumed), orderMessages(fold(TURN)));
});

test('bookkeeping events produce no messages at all', () => {
  const noise = fold([
    [1, { type: 'turn/start', turn: 1 }],
    [2, { type: 'step/start', turn: 1, step: 0 }],
    [3, { type: 'request/header', reason: 'initial' }],
    [4, { type: 'assistant/chunk', text: 'partial' }],
    [5, { type: 'step/end', turn: 1, step: 0 }],
  ]);
  assert.equal(orderMessages(noise).length, 0);
});

test('an ignored event returns the same map instance', () => {
  const before = fold(TURN);
  const after = applyLogEvent(before, 99, { type: 'step/end' }, 1);
  assert.equal(after, before, 'identity is what lets the UI skip a re-render');
});

// ── tool call / result pairing ───────────────────────────────────────
section('Parallel tool calls pair with their own results');

test('a result attaches to the call that cites it, not the latest one', () => {
  const state = fold([
    [1, { type: 'tool/call', callId: 'a', name: 'read', arguments: '{"path":"one"}' }],
    [2, { type: 'tool/call', callId: 'b', name: 'read', arguments: '{"path":"two"}' }],
    [3, { type: 'tool/call', callId: 'c', name: 'read', arguments: '{"path":"three"}' }],
    // Out of order on purpose: this is the normal case, not an edge case.
    [4, { type: 'tool/result', callId: 'b', name: 'read', content: 'TWO' }],
  ]);
  const cards = orderMessages(state);
  assert.equal(cards.length, 3, 'a result must not create a fourth card');
  assert.equal(cards[0].toolResult, undefined, 'call a is still running');
  assert.equal(cards[1].toolResult, 'TWO', 'call b got its own result');
  assert.equal(cards[1].toolRunning, false);
  assert.equal(cards[2].toolResult, undefined, 'call c is still running');
});

test('every call is eventually resolved, none left stranded on running', () => {
  const state = fold([
    [1, { type: 'tool/call', callId: 'a', name: 'read', arguments: '{}' }],
    [2, { type: 'tool/call', callId: 'b', name: 'read', arguments: '{}' }],
    [3, { type: 'tool/result', callId: 'b', content: 'B' }],
    [4, { type: 'tool/result', callId: 'a', content: 'A' }],
  ]);
  const cards = orderMessages(state);
  assert.equal(cards.length, 2);
  assert.ok(cards.every(c => c.toolRunning === false));
  assert.deepEqual(cards.map(c => c.toolResult), ['A', 'B']);
});

test('an orphan result is still shown rather than silently dropped', () => {
  const state = fold([[1, { type: 'tool/result', callId: 'ghost', name: 'bash', content: 'output' }]]);
  const cards = orderMessages(state);
  assert.equal(cards.length, 1);
  assert.equal(cards[0].toolResult, 'output');
  assert.equal(cards[0].toolRunning, false);
});

// ── assistant messages ───────────────────────────────────────────────
section('Assistant messages');

test('a tool-only step produces no empty bubble', () => {
  const state = fold([[1, { type: 'assistant/message', content: '', toolCalls: [{ id: 'a' }] }]]);
  assert.equal(orderMessages(state).length, 0);
});

test('a step with text produces exactly one bubble', () => {
  const state = fold([[1, { type: 'assistant/message', content: 'Done.' }]]);
  const messages = orderMessages(state);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].content, 'Done.');
});

// ── reasoning traces ─────────────────────────────────────────────────
section('Reasoning traces are provider-opaque');

test("DeepSeek's prose trace passes through unchanged", () => {
  assert.equal(
    readReasoning({ provider: 'deepseek', content: 'Let me check the file first.' }),
    'Let me check the file first.',
  );
});

test("Anthropic's thinking blocks are unwrapped, never shown as JSON", () => {
  const blocks = JSON.stringify([
    { type: 'thinking', thinking: 'First I should read it.', signature: 'sig-abc' },
    { type: 'thinking', thinking: 'Then edit it.', signature: 'sig-def' },
  ]);
  const text = readReasoning({ provider: 'anthropic', content: blocks });
  assert.equal(text, 'First I should read it.\n\nThen edit it.');
  assert.ok(!text.includes('signature'), 'signatures are protocol, not prose');
  assert.ok(!text.includes('{'), 'no JSON may reach the screen');
});

test('an unparseable trace is shown verbatim rather than discarded', () => {
  assert.equal(readReasoning({ provider: 'x', content: '[not valid json' }), '[not valid json');
});

test('an empty or absent trace yields nothing', () => {
  assert.equal(readReasoning(undefined), '');
  assert.equal(readReasoning(null), '');
  assert.equal(readReasoning({ provider: 'x' }), '');
  assert.equal(readReasoning({ provider: 'x', content: '' }), '');
});

test('a JSON array with no thinking text falls back to the raw payload', () => {
  const raw = '[{"type":"redacted_thinking","data":"opaque"}]';
  assert.equal(readReasoning({ provider: 'anthropic', content: raw }), raw);
});

// ── tool arguments ───────────────────────────────────────────────────
section('Tool arguments');

test('a JSON object is parsed into props', () => {
  assert.deepEqual(parseArgs('{"path":"a.ts","content":"x"}'), { path: 'a.ts', content: 'x' });
});

test('an already-parsed object passes through', () => {
  assert.deepEqual(parseArgs({ path: 'a.ts' }), { path: 'a.ts' });
});

test('malformed JSON becomes visible input rather than an exception', () => {
  assert.deepEqual(parseArgs('{"path": '), { input: '{"path": ' });
});

test('a bare array is not spread as props', () => {
  assert.deepEqual(parseArgs('[1,2,3]'), { input: [1, 2, 3] });
});

test('missing arguments yield an empty object', () => {
  assert.deepEqual(parseArgs(undefined), {});
  assert.deepEqual(parseArgs(null), {});
});

// ── the optimistic user echo ─────────────────────────────────────────
section('The optimistic echo yields to the log');

test('a pending message renders last, after every real seq', () => {
  const state = withPending(fold(TURN), 'my new question', 1);
  const messages = orderMessages(state);
  assert.equal(messages[messages.length - 1].content, 'my new question');
});

test('the echo is dropped once the log replays the real message', () => {
  const withEcho = withPending(fold(TURN), 'my new question', 1);
  const settled = dropPending(withEcho);
  assert.equal(settled.has(PENDING_KEY), false);
  assert.deepEqual(orderMessages(settled), orderMessages(fold(TURN)));
});

test('dropping when there is no echo returns the same instance', () => {
  const state = fold(TURN);
  assert.equal(dropPending(state), state);
});

test('a second submit replaces the echo rather than stacking echoes', () => {
  let state = withPending(new Map(), 'first', 1);
  state = withPending(state, 'second', 1);
  const users = orderMessages(state).filter(m => m.type === 'user');
  assert.equal(users.length, 1);
  assert.equal(users[0].content, 'second');
});

section('A reply that said nothing is reported, not hidden');

test('a tool-only step still renders no bubble', () => {
  const state = fold([[1, { type: 'assistant/message', content: '', toolCalls: [{ id: 'a' }] }]]);
  assert.equal(orderMessages(state).length, 0, 'the tool cards below it are the content');
});

test('an empty reply with no tool calls is reported', () => {
  // Rendering nothing made the turn look like it never happened, which reads
  // as a dropped message — and is how one session ended up with the same
  // question asked twice.
  const state = fold([[1, { type: 'assistant/message', content: '' }]]);
  const [entry] = orderMessages(state);
  assert.equal(entry.type, 'system');
  assert.match(entry.content, /empty reply/i);
});

test('an empty reply that still reasoned shows the reasoning', () => {
  const state = fold([[1, {
    type: 'assistant/message', content: '',
    reasoning: { provider: 'deepseek', content: 'I considered it and had nothing to add.' },
  }]]);
  assert.deepEqual(orderMessages(state).map(m => m.type), ['reasoning'],
    'the thought is the content');
});

console.log(`\n  ${'='.repeat(46)}`);
// ── who actually said it ────────────────────────────────────────
section('The harness speaks on the user channel, and must not be mistaken for the user');

test('a message with no source is the user', () => {
  const messages = orderMessages(fold([[1, { type: 'user/message', content: 'build a CRM' }]]));
  assert.deepEqual(messages.map(m => m.type), ['user']);
});

test('a plugin nudge is a system note, not something you said', () => {
  // The bug this pins: a step cut off at the output ceiling produced an empty
  // reply, then the recovery nudge appeared in a user bubble — three times
  // over. Reading that back, the session looks stuck in a loop arguing with
  // itself, and none of it was typed by a person.
  const messages = orderMessages(fold([[1, {
    type: 'user/message',
    content: 'Your previous step was cut off at the output-token ceiling.',
    source: { kind: 'plugin', plugin: 'truncation-recovery' },
  }]]));
  assert.deepEqual(messages.map(m => m.type), ['system']);
  assert.equal(messages[0].systemLabel, 'truncation-recovery',
    'and it says which part of the harness said it');
});

test('a compaction summary says that is what it is', () => {
  const messages = orderMessages(fold([[1, {
    type: 'user/message', content: 'You were working on the parser.',
    source: { kind: 'compaction' },
  }]]));
  assert.equal(messages[0].type, 'system');
  assert.match(messages[0].content, /summarised/,
    'a summary presented as a user instruction is how a transcript starts lying');
});

test('a tool-sourced message is attributed to the tool', () => {
  const messages = orderMessages(fold([[1, {
    type: 'user/message', content: 'The check failed.',
    source: { kind: 'tool', tool: 'VerifyApp' },
  }]]));
  assert.equal(messages[0].systemLabel, 'VerifyApp');
});

// ── a correction becomes a knowledge entry ─────────────────────────────
//
// The trigger comes from what was *asked*, because knowledge is matched against
// the next request's wording — and the next request that goes wrong will
// resemble this one, not its answer.
test('the trigger is built from the request, without filler words', () => {
  const s = suggestKnowledge(
    'Please can you make the settings page use our shared Field component for the toggles',
    'You rewrote the toggle from scratch instead of using Field',
  );
  assert.equal(s.trigger, 'settings page use shared Field component toggles');
  assert.equal(s.content, 'You rewrote the toggle from scratch instead of using Field');
});

test('a long request is cut to eight words, because overlap matching gets looser with length', () => {
  const s = suggestKnowledge(
    'refactor auth module session cookie name header parser login logout token refresh middleware',
    'note',
  );
  assert.equal(s.trigger.split(' ').length, 8);
});

test('code blocks and punctuation do not leak into the trigger', () => {
  const s = suggestKnowledge('Fix this: ```js\nfoo()\n``` (urgent!!)', 'n');
  // "this" is filler and the code is dropped; "urgent" is a real word and stays.
  assert.equal(s.trigger, 'Fix urgent');
});

test('with nothing asked, the trigger still says something a reader can edit', () => {
  const s = suggestKnowledge(undefined, '  keep it  ');
  assert.equal(s.trigger, 'when doing this kind of task');
  assert.equal(s.content, 'keep it');
});

console.log(`  WEB REDUCER: ${pass} passed, ${fail} failed`);
console.log(`  ${'='.repeat(46)}\n`);
process.exit(fail > 0 ? 1 : 0);
