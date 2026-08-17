/**
 * Tests for the pure client logic that the redesign introduced.
 *
 * Two areas, both chosen because they were wrong in ways nobody would notice
 * for a while: the reasoning composition (which garbled every thought), and the
 * date bucketing (which is quietly off-by-one until someone works late).
 */

import assert from 'node:assert/strict';
import { composeMessages, emptyDraft } from './dist-test/reduce.mjs';
import { groupByAge, relativeAge, promote, merge } from './dist-test/grouping.mjs';
import {
  PANES, SECRET_ROOTS, allFields, assertNoSecrets, changedPaths,
  patchFor, readPath, searchFields,
} from './dist-test/settings-schema.mjs';
import {
  initialSessionId, rememberSession, forgetSession, isValidSessionId, freshSessionId,
} from './dist-test/session-memory.mjs';
import { formatResult } from './dist-test/tool-result.mjs';

let pass = 0, fail = 0;
const test = (name, fn) => {
  try { fn(); pass++; console.log(`  ok    ${name}`); }
  catch (err) { fail++; console.log(`  FAIL  ${name}\n          ${err.message}`); }
};
const section = (name) => console.log(`\n-- ${name} --`);

// ── reasoning bursts ─────────────────────────────────────────────────
section('Reasoning is per-step and replaced, never appended');

/** Apply a sequence of reasoning/tool events the way the store does. */
function draftFrom(events) {
  let draft = emptyDraft();
  for (const event of events) {
    if (event.reasoning !== undefined) {
      const reasoning = new Map(draft.reasoning);
      const existing = reasoning.get(event.step);
      reasoning.set(event.step, existing
        ? { ...existing, text: event.reasoning }
        : { step: event.step, text: event.reasoning, startedAt: 1000 });
      const order = existing
        ? draft.order
        : [...draft.order, { kind: 'reasoning', key: event.step }];
      draft = { ...draft, reasoning, order };
    }
    if (event.tool !== undefined) {
      const tools = new Map(draft.tools);
      tools.set(event.tool, {
        id: `tool-${event.tool}`, type: 'tool', content: '',
        toolName: 'LS', toolCallId: event.tool, toolRunning: true, timestamp: 1000,
      });
      // A tool call ends every open burst, as the store does.
      const reasoning = new Map(draft.reasoning);
      for (const [step, burst] of reasoning) {
        if (burst.endedAt === undefined) reasoning.set(step, { ...burst, endedAt: 3000 });
      }
      draft = {
        ...draft, tools, reasoning,
        order: [...draft.order, { kind: 'tool', key: event.tool }],
      };
    }
    if (event.text !== undefined) draft = { ...draft, text: draft.text + event.text };
  }
  return draft;
}

test('an accumulated burst replaces rather than concatenating', () => {
  // The engine sends the text so far, not deltas. Appending produced
  // "I" + "I t" + "I th" = "II tI th".
  const draft = draftFrom([
    { step: 1, reasoning: 'I' },
    { step: 1, reasoning: 'I th' },
    { step: 1, reasoning: 'I think so' },
  ]);
  const [burst] = composeMessages(new Map(), draft, true);
  assert.equal(burst.content, 'I think so');
  assert.equal(burst.type, 'reasoning');
});

test('separate steps produce separate blocks', () => {
  const draft = draftFrom([
    { step: 1, reasoning: 'first thought' },
    { tool: 'a' },
    { step: 2, reasoning: 'second thought' },
  ]);
  const messages = composeMessages(new Map(), draft, true);
  const reasoning = messages.filter(m => m.type === 'reasoning');
  assert.equal(reasoning.length, 2, 'two thoughts, not one merged wall of text');
  assert.deepEqual(reasoning.map(r => r.content), ['first thought', 'second thought']);
});

test('live entries render in the order they happened', () => {
  const draft = draftFrom([
    { step: 1, reasoning: 'think' },
    { tool: 'a' },
    { step: 2, reasoning: 'think again' },
    { tool: 'b' },
    { text: 'the answer' },
  ]);
  const kinds = composeMessages(new Map(), draft, true).map(m => m.type);
  assert.deepEqual(kinds, ['reasoning', 'tool', 'reasoning', 'tool', 'assistant'],
    'think, act, think, act, answer — the story of the turn');
});

test('a burst is marked streaming until something ends it', () => {
  const open = draftFrom([{ step: 1, reasoning: 'still going' }]);
  assert.equal(composeMessages(new Map(), open, true)[0].streaming, true);

  const closed = draftFrom([{ step: 1, reasoning: 'done' }, { tool: 'a' }]);
  const burst = composeMessages(new Map(), closed, true)[0];
  assert.equal(burst.streaming, false, 'a tool call ends the thinking that chose it');
  assert.equal(typeof burst.durationMs, 'number', 'and its duration becomes known');
});

test('empty bursts are not rendered', () => {
  const draft = draftFrom([{ step: 1, reasoning: '   ' }]);
  assert.equal(composeMessages(new Map(), draft, true).length, 0);
});

test('nothing live is shown once the turn ends', () => {
  const draft = draftFrom([{ step: 1, reasoning: 'thought' }, { text: 'answer' }]);
  assert.equal(composeMessages(new Map(), draft, false).length, 0,
    'the durable log takes over the moment the turn is finished');
});

// ── session grouping ─────────────────────────────────────────────────
section('Sessions bucket by calendar day');

const AT_9AM = new Date(2026, 7, 17, 9, 0, 0).getTime();
const at = (ms) => ({ id: `s${ms}`, updatedAt: ms, turns: 1 });
const labelOf = (ms) =>
  groupByAge([at(ms)], '', AT_9AM).find(g => g.items.length > 0)?.label;

test('this morning is Today', () => {
  assert.equal(labelOf(new Date(2026, 7, 17, 8, 0).getTime()), 'Today');
});

test('11pm last night is Yesterday, not "ten hours ago"', () => {
  // The boundary is the calendar day, which is how people actually navigate.
  assert.equal(labelOf(new Date(2026, 7, 16, 23, 0).getTime()), 'Yesterday');
});

test('one minute after midnight is Today', () => {
  assert.equal(labelOf(new Date(2026, 7, 17, 0, 1).getTime()), 'Today');
});

test('one minute before midnight is Yesterday', () => {
  assert.equal(labelOf(new Date(2026, 7, 16, 23, 59).getTime()), 'Yesterday');
});

test('four days ago is in the week bucket', () => {
  assert.equal(labelOf(new Date(2026, 7, 13, 12, 0).getTime()), 'Previous 7 days');
});

test('a fortnight ago is in the month bucket', () => {
  assert.equal(labelOf(new Date(2026, 7, 3, 12, 0).getTime()), 'Previous 30 days');
});

test('last year is Older', () => {
  assert.equal(labelOf(new Date(2025, 7, 17, 12, 0).getTime()), 'Older');
});

test('every session lands in exactly one bucket', () => {
  const sessions = [
    at(AT_9AM - 1000), at(AT_9AM - 86_400_000), at(AT_9AM - 3 * 86_400_000),
    at(AT_9AM - 20 * 86_400_000), at(AT_9AM - 400 * 86_400_000),
  ];
  const groups = groupByAge(sessions, '', AT_9AM);
  assert.equal(groups.reduce((n, g) => n + g.items.length, 0), sessions.length);
  assert.equal(new Set(groups.flatMap(g => g.items.map(i => i.id))).size, sessions.length);
});

test('groups are ordered newest first whatever order they arrive in', () => {
  // Sorted here rather than trusted from the caller. Every path was *supposed*
  // to hand over a recency-ordered list, right up until one of them did not.
  const groups = groupByAge(
    [{ id: 'oldest', updatedAt: AT_9AM - 3000, turns: 1 },
     { id: 'newest', updatedAt: AT_9AM - 1000, turns: 1 },
     { id: 'middle', updatedAt: AT_9AM - 2000, turns: 1 }],
    '', AT_9AM);
  assert.deepEqual(groups[0].items.map(i => i.id), ['newest', 'middle', 'oldest']);
});

test('filtering does not disturb the ordering', () => {
  const groups = groupByAge(
    [{ id: 'b', title: 'keep me', updatedAt: AT_9AM - 3000, turns: 1 },
     { id: 'a', title: 'keep me too', updatedAt: AT_9AM - 1000, turns: 1 }],
    'keep', AT_9AM);
  assert.deepEqual(groups[0].items.map(i => i.id), ['a', 'b']);
});

test('filtering matches title and id, case-insensitively', () => {
  const sessions = [
    { id: 'abc', title: 'Fix the auth bug', updatedAt: AT_9AM, turns: 1 },
    { id: 'xyz', title: 'Write the docs', updatedAt: AT_9AM, turns: 1 },
  ];
  const byTitle = groupByAge(sessions, 'AUTH', AT_9AM).flatMap(g => g.items);
  assert.deepEqual(byTitle.map(s => s.id), ['abc']);
  const byId = groupByAge(sessions, 'xy', AT_9AM).flatMap(g => g.items);
  assert.deepEqual(byId.map(s => s.id), ['xyz']);
  assert.equal(groupByAge(sessions, 'nothing', AT_9AM).flatMap(g => g.items).length, 0);
});

section('Relative ages read like a person wrote them');

test('under a minute is "now"', () => assert.equal(relativeAge(AT_9AM - 30_000, AT_9AM), 'now'));
test('minutes', () => assert.equal(relativeAge(AT_9AM - 5 * 60_000, AT_9AM), '5m'));
test('hours', () => assert.equal(relativeAge(AT_9AM - 3 * 3_600_000, AT_9AM), '3h'));
test('days', () => assert.equal(relativeAge(AT_9AM - 3 * 86_400_000, AT_9AM), '3d'));
test('weeks', () => assert.equal(relativeAge(AT_9AM - 14 * 86_400_000, AT_9AM), '2w'));
test('months', () => assert.equal(relativeAge(AT_9AM - 90 * 86_400_000, AT_9AM), '3mo'));
test('a future timestamp does not read as negative', () => {
  assert.equal(relativeAge(AT_9AM + 60_000, AT_9AM), 'now');
});

// ── the session you are working in stays at the top ──────────────────
section('Activity promotes a session to the top of the list');

const listed = (ms, extra = {}) => ({ id: `s${ms}`, updatedAt: ms, turns: 1, ...extra });

test('a session with new activity moves to the front', () => {
  const before = [listed(AT_9AM), listed(AT_9AM - 60_000), listed(AT_9AM - 120_000)];
  const after = promote(before, `s${AT_9AM - 120_000}`, AT_9AM + 1000);
  assert.equal(after[0].id, `s${AT_9AM - 120_000}`);
  assert.equal(after[0].updatedAt, AT_9AM + 1000);
});

test('a stale timestamp never drags a session back down', () => {
  // The listing is read off disk, so a refetch issued the instant a message is
  // sent can legitimately report an older time than the stream already showed.
  const before = [listed(AT_9AM)];
  const after = promote(before, `s${AT_9AM}`, AT_9AM - 500_000);
  assert.equal(after, before, 'unchanged, and the same array so nothing re-renders');
});

test('a session with no log file yet is inserted rather than lost', () => {
  const after = promote([listed(AT_9AM)], 'brand-new', AT_9AM + 1000, { title: 'Untitled' });
  assert.equal(after[0].id, 'brand-new');
  assert.equal(after[0].title, 'Untitled');
  assert.equal(after[0].turns, 0);
});

test('promotion is stable when the session is already first', () => {
  const before = [listed(AT_9AM), listed(AT_9AM - 1000)];
  const after = promote(before, `s${AT_9AM}`, AT_9AM);
  assert.equal(after, before);
});

section('A refetched listing cannot undo what the stream already showed');

test('the newer of the two timestamps wins', () => {
  const local = [{ id: 'a', updatedAt: 5000, turns: 2 }];
  const server = [{ id: 'a', updatedAt: 4000, turns: 2, title: 'From the server' }];
  const merged = merge(local, server);
  assert.equal(merged[0].updatedAt, 5000, 'the client had seen a later event');
  assert.equal(merged[0].title, 'From the server', 'but everything else comes from the listing');
});

test('a locally-known session with no turns survives a listing that omits it', () => {
  const merged = merge([{ id: 'fresh', updatedAt: 9000, turns: 0 }], [{ id: 'a', updatedAt: 1000, turns: 1 }]);
  assert.deepEqual(merged.map(s => s.id), ['fresh', 'a']);
});

test('a session deleted on disk does disappear', () => {
  const merged = merge([{ id: 'gone', updatedAt: 9000, turns: 4 }], [{ id: 'a', updatedAt: 1000, turns: 1 }]);
  assert.deepEqual(merged.map(s => s.id), ['a']);
});

test('the merged list comes out newest first', () => {
  const merged = merge(
    [{ id: 'a', updatedAt: 1000, turns: 1 }],
    [{ id: 'b', updatedAt: 3000, turns: 1 },
     { id: 'a', updatedAt: 1000, turns: 1 },
     { id: 'c', updatedAt: 2000, turns: 1 }],
  );
  assert.deepEqual(merged.map(s => s.id), ['b', 'c', 'a']);
});

// ── settings schema ──────────────────────────────────────────────────
section('Settings are described as data');

test('no field is bound under a root that holds credentials', () => {
  // Enforced at module load, so importing the schema at all is the assertion.
  // Repeated here so the reason survives in the suite.
  assert.doesNotThrow(() => assertNoSecrets());
  for (const field of allFields()) {
    assert.ok(!SECRET_ROOTS.includes(field.path.split('.')[0]), field.path);
  }
});

test('writing a nested key sends the whole top-level object', () => {
  // saveUserSetting replaces settings[key] outright, so sending only the leaf
  // would blank every sibling — setting a threshold would turn compaction off.
  const settings = { autoCompact: { enabled: true, keepRecentTurns: 4 } };
  const patch = patchFor(settings, 'autoCompact.thresholdPercent', 60);
  assert.deepEqual(patch, {
    autoCompact: { enabled: true, keepRecentTurns: 4, thresholdPercent: 60 },
  });
});

test('writing a nested key does not mutate what it was given', () => {
  const settings = { autoCompact: { enabled: true } };
  patchFor(settings, 'autoCompact.enabled', false);
  assert.equal(settings.autoCompact.enabled, true);
});

test('a top-level key is written on its own', () => {
  assert.deepEqual(patchFor({}, 'theme', 'dark'), { theme: 'dark' });
});

test('undefined removes the leaf rather than storing a null', () => {
  const patch = patchFor({ safetyLimits: { maxCostPerSession: 5 } }, 'safetyLimits.maxCostPerSession', undefined);
  assert.deepEqual(patch, { safetyLimits: {} });
});

test('a missing branch is created rather than throwing', () => {
  assert.deepEqual(patchFor({}, 'sandbox.mode', 'read-only'), { sandbox: { mode: 'read-only' } });
});

test('a credential root is refused outright', () => {
  assert.throws(() => patchFor({}, 'providers.anthropic.apiKey', 'sk-leak'), /credential/);
});

test('reading a path that does not exist is undefined, not a crash', () => {
  assert.equal(readPath({}, 'a.b.c'), undefined);
  assert.equal(readPath({ a: 1 }, 'a.b'), undefined);
  assert.equal(readPath({ a: { b: 2 } }, 'a.b'), 2);
});

test('search matches the label, the explanation and the key itself', () => {
  assert.ok(searchFields('theme').some(h => h.field.path === 'theme'));
  assert.ok(searchFields('sandbox').some(h => h.field.path === 'sandbox.mode'), 'by key');
  assert.ok(searchFields('out of room').some(h => h.field.path.startsWith('autoCompact')),
    'by what the pane says it is for, not only by the field label');
  assert.equal(searchFields('').length, 0, 'an empty query matches nothing, not everything');
});

test('every term has to match, so two words narrow rather than widen', () => {
  const one = searchFields('timeout');
  const two = searchFields('timeout shell');
  assert.ok(two.length < one.length && two.length > 0);
});

test('a setting left alone is not counted as changed', () => {
  assert.deepEqual(changedPaths({}), []);
  assert.deepEqual(changedPaths({ theme: 'auto' }), [], 'set to exactly the default');
  assert.deepEqual(changedPaths({ theme: 'dark' }), ['theme']);
});

test('zero counts as a value, because zero means "no limit"', () => {
  assert.deepEqual(changedPaths({ bashTimeout: 0 }), ['bashTimeout']);
});

section('A reload resumes the session you were in');

/** A Storage stand-in, so these tests need no browser. */
const makeStore = (initial = {}) => {
  const data = { ...initial };
  return {
    getItem: (k) => (k in data ? data[k] : null),
    setItem: (k, v) => { data[k] = String(v); },
    removeItem: (k) => { delete data[k]; },
  };
};

test('with nothing remembered, a fresh session is created', () => {
  assert.equal(initialSessionId(makeStore(), () => 'brand-new'), 'brand-new');
});

test('a remembered session is resumed', () => {
  // The bug: a reload minted a new id and connected to it, so the transcript
  // looked lost when it was simply not the session being shown.
  const store = makeStore();
  rememberSession('web-abc123', store);
  assert.equal(initialSessionId(store, () => 'brand-new'), 'web-abc123');
});

test('opening another session changes what is resumed', () => {
  const store = makeStore();
  rememberSession('web-first', store);
  rememberSession('web-second', store);
  assert.equal(initialSessionId(store, () => 'x'), 'web-second');
});

test('a corrupt stored value is ignored, not sent to the server', () => {
  const store = makeStore({ 'aico.session': '../../etc/passwd' });
  assert.equal(initialSessionId(store, () => 'safe'), 'safe');
});

test('an empty stored value is ignored', () => {
  assert.equal(initialSessionId(makeStore({ 'aico.session': '' }), () => 'safe'), 'safe');
});

test('an invalid id is never written', () => {
  const store = makeStore();
  rememberSession('has spaces and /slashes', store);
  assert.equal(store.getItem('aico.session'), null);
});

test('forgetting starts the next load fresh', () => {
  const store = makeStore();
  rememberSession('web-abc', store);
  forgetSession(store);
  assert.equal(initialSessionId(store, () => 'fresh'), 'fresh');
});

test('unavailable storage falls back rather than throwing', () => {
  // Private browsing and blocked cookies both make these throw.
  const hostile = {
    getItem() { throw new Error('denied'); },
    setItem() { throw new Error('denied'); },
    removeItem() { throw new Error('denied'); },
  };
  assert.equal(initialSessionId(hostile, () => 'fallback'), 'fallback');
  assert.doesNotThrow(() => rememberSession('web-abc', hostile));
  assert.doesNotThrow(() => forgetSession(hostile));
  assert.equal(initialSessionId(null, () => 'fallback'), 'fallback');
});

test('generated ids are valid and unique', () => {
  const a = freshSessionId(1, () => 0.111);
  const b = freshSessionId(2, () => 0.222);
  assert.notEqual(a, b);
  assert.ok(isValidSessionId(a), `${a} is a usable id`);
});

test('ids that would escape a directory are rejected', () => {
  const backslash = String.fromCharCode(92);
  for (const bad of ['../x', 'a/b', `a${backslash}b`, '', '.hidden', 'x'.repeat(200)]) {
    assert.equal(isValidSessionId(bad), false, `${JSON.stringify(bad)} is refused`);
  }
  assert.equal(isValidSessionId('web-msw8duez-s25x2j'), true, 'a real id is accepted');
});

section('Tool output reads as output, not as JSON');

const CR = String.fromCharCode(13);
const NL = String.fromCharCode(10);
const BACKSLASH = String.fromCharCode(92);

test('a shell result renders its stdout as text', () => {
  // The reported bug: this reached the screen as
  // {"stdout":" Volume in drive E\r\n Directory of…","stderr":"","exit_code":0}
  const { text, isError } = formatResult({
    stdout: ` Volume in drive E is Extended${CR}${NL} Directory of E:${CR}${NL}`,
    stderr: '',
    exit_code: 0,
  });
  assert.ok(!text.startsWith('{'), 'not a JSON object');
  assert.ok(!text.includes(BACKSLASH + 'r'), 'no escape sequences on screen');
  assert.ok(!text.includes(CR), 'carriage returns are normalised away');
  assert.ok(text.includes('Volume in drive E is Extended'), 'the actual output is there');
  assert.ok(text.includes('Directory of E:'), 'all of it');
  assert.equal(text.split(NL).length, 2, 'as real lines');
  assert.equal(isError, false, 'exit 0 is not an error');
});

test('a failed command says so, with its stderr', () => {
  const { text, isError } = formatResult({ stdout: '', stderr: 'ENOENT: no such file', exit_code: 2 });
  assert.equal(isError, true, 'a non-zero exit is an error');
  assert.ok(text.includes('stderr:'), 'stderr is labelled, not merged into stdout');
  assert.ok(text.includes('ENOENT: no such file'), 'and shown');
  assert.ok(text.includes('exited 2'), 'the exit code is reported, not buried in a field name');
});

test('a command that printed nothing says so, rather than "{}"', () => {
  assert.equal(formatResult({ stdout: '', stderr: '', exit_code: 0 }).text, '(no output)');
});

test('trailing blank lines are trimmed', () => {
  assert.equal(formatResult({ stdout: `done${NL}${NL}${NL}`, exit_code: 0 }).text, 'done');
});

test('a plain string result passes straight through', () => {
  assert.equal(formatResult('12 files').text, '12 files');
});

test('an error object is reported as an error', () => {
  const { text, isError } = formatResult({ error: 'permission denied' });
  assert.equal(text, 'permission denied');
  assert.equal(isError, true);
});

test('search results become readable lines, not a JSON array', () => {
  const { text } = formatResult({
    results: [
      { title: 'DeepSeek Harness', url: 'https://example.com/a', snippet: 'A framework.' },
      { title: 'Another', url: 'https://example.com/b', snippet: 'Something else.' },
    ],
  });
  assert.ok(!text.includes('['), 'no array syntax');
  assert.ok(!text.includes('"url"'), 'no field names');
  assert.ok(text.includes('DeepSeek Harness'), 'titles are there');
  assert.ok(text.includes('https://example.com/a'), 'and links');
  assert.ok(text.includes('A framework.'), 'and snippets');
});

test('an unrecognised shape still renders, indented', () => {
  const { text } = formatResult({ some: 'unknown', shape: [1, 2] });
  assert.ok(text.includes('"some"'), 'rather than being dropped');
  assert.ok(text.includes(NL), 'and indented so it is at least readable');
});

test('null and undefined are empty, not the words', () => {
  assert.equal(formatResult(null).text, '');
  assert.equal(formatResult(undefined).text, '');
});

console.log(`\n  WEB UI: ${pass} passed, ${fail} failed\n`);
process.exit(fail > 0 ? 1 : 0);
