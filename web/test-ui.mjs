/**
 * Tests for the pure client logic that the redesign introduced.
 *
 * Two areas, both chosen because they were wrong in ways nobody would notice
 * for a while: the reasoning composition (which garbled every thought), and the
 * date bucketing (which is quietly off-by-one until someone works late).
 */

import assert from 'node:assert/strict';
import { composeMessages, emptyDraft, applyLogEvent } from './dist-test/reduce.mjs';
import { groupByAge, groupByProject, recentSessions, relativeAge, promote, merge } from './dist-test/grouping.mjs';
import {
  PANES, SECRET_ROOTS, allFields, assertNoSecrets, changedPaths,
  patchFor, readPath, searchFields,
} from './dist-test/settings-schema.mjs';
import {
  initialSessionId, rememberSession, forgetSession, isValidSessionId, freshSessionId,
} from './dist-test/session-memory.mjs';
import { formatResult, outcomeOf } from './dist-test/tool-result.mjs';
import { todosFrom, TASK_REPLY } from './dist-test/todos.mjs';
import { planFrom, PLAN_REPLY } from './dist-test/plans.mjs';
import { loadDismissals, saveDismissals } from './dist-test/panel-memory.mjs';
import {
  parseChartSpec, parseTableSpec, numericValue, summarise,
} from './dist-test/widget-specs.mjs';
import { checksFrom } from './dist-test/checks.mjs';
import { shouldClearBusy } from './dist-test/turn-state.mjs';
import { searchAgents, splitAgents, mentionAt } from './dist-test/agents.mjs';

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

// ── grouping by project ──────────────────────────────────────────────
section('With more than one folder open, where beats when');

const P1 = 'E:/work/api';
const P2 = 'E:/work/web';
const proj = [{ path: P1, name: 'api' }, { path: P2, name: 'web' }];
const inProj = (id, project, updatedAt) => ({ id, project, updatedAt, turns: 1 });

test('sessions land under the folder they belong to', () => {
  const groups = groupByProject(
    [inProj('a', P1, 3000), inProj('b', P2, 2000), inProj('c', P1, 1000)], proj);
  const api = groups.find(g => g.path === P1);
  assert.deepEqual(api.items.map(s => s.id), ['a', 'c']);
  assert.deepEqual(groups.find(g => g.path === P2).items.map(s => s.id), ['b']);
});

test('the folder you touched last is first, and so is the session', () => {
  const groups = groupByProject(
    [inProj('old', P1, 1000), inProj('new', P2, 9000), inProj('mid', P2, 5000)], proj);
  assert.equal(groups[0].path, P2, 'most recently active project leads');
  assert.deepEqual(groups[0].items.map(s => s.id), ['new', 'mid'], 'newest session leads within it');
});

test('a folder with no sessions still appears', () => {
  // A folder you just opened and cannot see is indistinguishable from one that
  // failed to open.
  const groups = groupByProject([inProj('a', P1, 1000)], proj);
  assert.equal(groups.length, 2);
  assert.equal(groups.find(g => g.path === P2).items.length, 0);
});

test('a session whose folder is no longer listed is kept, not hidden', () => {
  const groups = groupByProject([inProj('orphan', 'E:/gone/elsewhere', 5000)], proj);
  const orphans = groups.find(g => g.path === 'E:/gone/elsewhere');
  assert.ok(orphans, 'it gets a group of its own');
  assert.equal(orphans.label, 'elsewhere', 'labelled by its folder name');
  assert.deepEqual(orphans.items.map(s => s.id), ['orphan']);
});

test('filtering works the same way it does on the date axis', () => {
  const sessions = [
    { id: 'a', project: P1, title: 'Fix the auth bug', updatedAt: 3000, turns: 1 },
    { id: 'b', project: P1, title: 'Write the docs', updatedAt: 2000, turns: 1 },
  ];
  const groups = groupByProject(sessions, proj, 'AUTH');
  assert.deepEqual(groups.find(g => g.path === P1).items.map(s => s.id), ['a']);
});

test('a session with no recorded folder is not dropped on the floor', () => {
  const groups = groupByProject([{ id: 'x', updatedAt: 1000, turns: 1 }], proj);
  const other = groups.find(g => g.label === 'Other');
  assert.ok(other && other.items.length === 1);
});

// ── groups ───────────────────────────────────────────────────────────
section('A group is a label, not a location');

const G = [{ id: 'migration', name: 'Payments migration' }];

test('a session in a group appears under it, not its folder', () => {
  const rows = [{ id: 'a', project: P1, group: 'migration', updatedAt: 3000, turns: 1 }];
  const secs = groupByProject(rows, proj, '', G);
  assert.deepEqual(secs.find(s => s.path === 'migration').items.map(s => s.id), ['a']);
  assert.equal(secs.find(s => s.path === P1).items.length, 0, 'and not in both at once');
});

test('a group can hold sessions from several folders', () => {
  // The whole point. If a group could not span projects, the folders would
  // already be doing this job.
  const rows = [
    { id: 'a', project: P1, group: 'migration', updatedAt: 3000, turns: 1 },
    { id: 'b', project: P2, group: 'migration', updatedAt: 2000, turns: 1 },
  ];
  const secs = groupByProject(rows, proj, '', G);
  assert.deepEqual(secs.find(s => s.path === 'migration').items.map(s => s.id), ['a', 'b']);
});

test('a deleted group returns its sessions to their folders', () => {
  // The membership event stays in the log; with no group to match it, the
  // session falls back to the directory it has been running in all along.
  const rows = [{ id: 'a', project: P1, group: 'gone', updatedAt: 3000, turns: 1 }];
  const secs = groupByProject(rows, proj, '', G);
  assert.deepEqual(secs.find(s => s.path === P1).items.map(s => s.id), ['a']);
});

test('groups and folders are distinguishable in the result', () => {
  const secs = groupByProject([], proj, '', G);
  assert.equal(secs.find(s => s.path === 'migration').kind, 'group');
  assert.equal(secs.find(s => s.path === P1).kind, 'project');
});

test('an empty group still appears', () => {
  const secs = groupByProject([], proj, '', G);
  assert.ok(secs.some(s => s.path === 'migration'));
});

test('pinning wins over activity, for groups too', () => {
  const rows = [{ id: 'busy', project: P1, updatedAt: 9000, turns: 1 }];
  const secs = groupByProject(rows, proj, '', [{ id: 'q', name: 'Quiet', pinned: true }]);
  assert.equal(secs[0].path, 'q', 'a pinned empty group outranks a busy folder');
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


// ── The headline of a tool call ────────────────────────────────────────────
//
// The generic fallback is a line count, which is honest and nearly useless: a
// browser check that found three broken controls and one that passed cleanly
// both rendered as "7 lines".

test('a passing browser check says so', () => {
  const passed = outcomeOf('VerifyApp', 'PASSED — file:///x/index.html loads and works.\n\nWhat rendered:\n  12 elements');
  assert.equal(passed.label, 'works');
  assert.equal(passed.tone, 'good');
  assert.equal(passed.detail, undefined, 'with nothing more to say');
});

test('a failing browser check counts the problems and names the worst', () => {
  const failed = outcomeOf('VerifyApp',
    'FAILED — file:///x/index.html has 3 problem(s). This artifact is not finished.\n'
    + '\nProblems, worst first:\n'
    + '  - uncaught: THREE is not defined\n'
    + '  - 1 of 1 canvas element(s) were never drawn to\n');
  assert.equal(failed.label, '3 problems');
  assert.equal(failed.tone, 'bad', 'impossible to mistake for success');
  // The reason a page does not work is the point of running the check; putting
  // it one interaction away is how it gets skipped.
  assert.equal(failed.detail, 'uncaught: THREE is not defined');
});

test('one problem is not "1 problems"', () => {
  const one = outcomeOf('VerifyApp', 'FAILED — x has 1 problem(s).\n\n  - the page did not load\n');
  assert.equal(one.label, '1 problem');
});

test('a persistent shell reports where it left you', () => {
  // A cd that did not take looks exactly like one that did, until something
  // writes a file into the wrong place.
  const moved = outcomeOf('Terminal', { output: '', stderr: '', exit_code: 0, cwd: 'E:\\work\\ui-probe' });
  assert.ok(/ui-probe/.test(moved.label), `working directory is the summary (${moved.label})`);
  assert.equal(moved.tone, 'neutral', 'a successful command is not shouted about');
});

test('a failed shell command is not quiet', () => {
  const failedCmd = outcomeOf('Terminal', { output: '', stderr: 'nope', exit_code: 1, cwd: 'E:\\work' });
  assert.equal(failedCmd.tone, 'bad');
});

test('a long path is shortened to its identifying end', () => {
  // The separator class needs both slashes. With one backslash too few it
  // became [\/] — forward slash only — so no Windows path split and every
  // chip showed the full path. The two-segment test below is returned whole
  // either way, so it could not catch this.
  const deep = outcomeOf('Terminal', JSON.stringify({
    output: '', stderr: '', exit_code: 0, cwd: 'E:\\github_repos\\AI-Projects\\aico\\ui-probe',
  }));
  assert.equal(deep.label, '…/aico/ui-probe');

  const posix = outcomeOf('Terminal', JSON.stringify({
    output: '', stderr: '', exit_code: 0, cwd: '/home/me/work/thing',
  }));
  assert.equal(posix.label, '…/work/thing', 'and posix paths shorten the same way');
});

test('a short path is shown whole rather than elided to nothing', () => {
  const shortCwd = outcomeOf('Terminal', { output: '', stderr: '', exit_code: 0, cwd: 'E:\\x' });
  assert.equal(shortCwd.label, 'E:\\x');
});

test('a backgrounded command reads as still running, with its pid', () => {
  // Calling it "exit 0" would be actively wrong about what happened.
  const bg = outcomeOf('Bash', JSON.stringify({ stdout: 'listening', stderr: '', exit_code: 0, background: { pid: 4321 } }));
  assert.ok(/running/.test(bg.label));
  assert.ok(/4321/.test(bg.label), 'carries the pid needed to stop it');
});

test('no tool is given a headline it does not have', () => {
  assert.equal(outcomeOf('Read', 'file contents here'), undefined);
  assert.equal(outcomeOf('Bash', JSON.stringify({ stdout: 'ok', exit_code: 0 })), undefined,
    'an ordinary command falls back to the line count');
  assert.equal(outcomeOf('Terminal', 'not json at all'), undefined,
    'a result that is not JSON is not guessed at');
  assert.equal(outcomeOf('VerifyApp', undefined), undefined);
  assert.equal(outcomeOf('VerifyApp', 'something unexpected'), undefined,
    'an unrecognised verdict is not guessed at');
});


// ── The task list, derived from the transcript ─────────────────────────────

const todoCall = (todos) => ({
  id: 'x', type: 'tool', content: '', toolName: 'TodoWrite',
  toolArgs: { todos }, toolCallId: 'c', toolRunning: false, timestamp: 0,
});

test('a transcript with no task list yields nothing to show', () => {
  const empty = todosFrom([]);
  assert.equal(empty.total, 0);
  assert.equal(empty.allSettled, false, 'an empty list is not a finished one');
});

test('the newest TodoWrite is the whole answer', () => {
  // TodoWrite replaces the list wholesale, so merging earlier calls would
  // resurrect items the agent has since dropped.
  const summary = todosFrom([
    todoCall([
      { id: '1', title: 'old idea', status: 'pending', priority: 'high' },
      { id: '2', title: 'another old idea', status: 'pending', priority: 'low' },
    ]),
    todoCall([{ id: '1', title: 'the current plan', status: 'in_progress', priority: 'high' }]),
  ]);
  assert.equal(summary.total, 1);
  assert.equal(summary.todos[0].title, 'the current plan');
  assert.equal(summary.inProgress, 1);
});

test('progress counts what is closed, however it closed', () => {
  const summary = todosFrom([todoCall([
    { id: '1', title: 'built it', status: 'done', priority: 'high' },
    { id: '2', title: 'dropped it', status: 'cancelled', priority: 'low' },
    { id: '3', title: 'still going', status: 'in_progress', priority: 'medium' },
    { id: '4', title: 'not started', status: 'pending', priority: 'medium' },
  ])]);
  assert.equal(summary.closed, 2, 'done and cancelled are both closed');
  assert.equal(summary.total, 4);
  assert.equal(summary.allSettled, false, 'with work outstanding, nothing is settled');
});

test('a list finished by cancelling is settled, and distinguishable', () => {
  // The distinction a green tick hides. A list finished by cancelling half of
  // it is not a list that was done, and conflating them is how a task list
  // becomes a formality.
  const summary = todosFrom([todoCall([
    { id: '1', title: 'built it', status: 'done', priority: 'high' },
    { id: '2', title: 'gave up on it', status: 'cancelled', priority: 'low' },
  ])]);
  assert.equal(summary.allSettled, true);
  assert.equal(summary.done, 1);
  assert.equal(summary.cancelled, 1, 'so the panel can say "1 done · 1 cancelled"');
});

test('an unknown status keeps the item open rather than counting it done', () => {
  // A model can emit a status nobody defined. Treating it as pending keeps the
  // item visible and the list honestly unfinished — the safe direction.
  const summary = todosFrom([todoCall([
    { id: '1', title: 'mystery', status: 'almost-done', priority: 'high' },
  ])]);
  assert.equal(summary.pending, 1);
  assert.equal(summary.allSettled, false);
});

test('malformed entries are skipped, not rendered as blanks', () => {
  const summary = todosFrom([todoCall([
    { id: '1', title: 'a real one', status: 'pending', priority: 'high' },
    null,
    { id: '2' },
    'not an object',
  ])]);
  assert.equal(summary.total, 1, 'only the entry that has a title survives');
});

test('an item titled with content rather than title still reads', () => {
  // Different models spell this field differently; the list is more useful than
  // the naming convention.
  const summary = todosFrom([todoCall([{ id: '1', content: 'from a content field', status: 'done' }])]);
  assert.equal(summary.todos[0].title, 'from a content field');
});

test('non-TodoWrite tool calls are ignored', () => {
  const summary = todosFrom([
    { id: 'a', type: 'tool', toolName: 'Bash', toolArgs: { todos: [{ title: 'nope' }] },
      content: '', toolCallId: 'z', toolRunning: false, timestamp: 0 },
  ]);
  assert.equal(summary.total, 0, 'a stray todos argument on another tool is not the task list');
});


// ── A plan you can answer ──────────────────────────────────────────────────

const planCall = (args) => ({
  id: 'p', type: 'tool', content: '', toolName: 'ProposePlan',
  toolArgs: args, toolCallId: 'pc', toolRunning: false, timestamp: 0,
});
const userSays = (content) => ({ id: 'u', type: 'user', content, timestamp: 0 });

test('a transcript with no plan shows nothing', () => {
  assert.equal(planFrom([]).plan, undefined);
  assert.equal(planFrom([userSays('hello')]).plan, undefined);
});

test('a proposed plan is read whole', () => {
  const { plan } = planFrom([planCall({
    title: 'Add rate limiting',
    steps: [
      { title: 'Add a token bucket', detail: 'per API key', touches: ['src/limit.ts'] },
      { title: 'Wire it into the router' },
    ],
    risks: ['existing clients may start seeing 429s'],
    open_questions: ['what limit did you have in mind?'],
  })]);
  assert.equal(plan.title, 'Add rate limiting');
  assert.equal(plan.steps.length, 2);
  assert.equal(plan.steps[0].touches[0], 'src/limit.ts');
  assert.equal(plan.risks.length, 1);
  assert.equal(plan.openQuestions.length, 1, 'the cheapest bug in the plan is kept');
});

test('an answer after the plan is the decision', () => {
  const base = planCall({ title: 'x', steps: [{ title: 'do a thing' }] });
  assert.equal(planFrom([base]).decision, undefined, 'an unanswered plan is undecided');
  assert.equal(planFrom([base, userSays(PLAN_REPLY.approved)]).decision, 'approved');
  assert.equal(planFrom([base, userSays(PLAN_REPLY.deferred)]).decision, 'deferred');
  assert.equal(planFrom([base, userSays(PLAN_REPLY.declined)]).decision, 'declined');
});

test('a revised plan does not arrive pre-approved', () => {
  // A decision recorded before the newest proposal belongs to an older plan.
  // Carrying it forward would show a freshly revised plan as already agreed —
  // the one mistake here that could actually run unwanted work.
  const { plan, decision } = planFrom([
    planCall({ title: 'first attempt', steps: [{ title: 'a' }] }),
    userSays(PLAN_REPLY.approved),
    planCall({ title: 'revised after feedback', steps: [{ title: 'b' }] }),
  ]);
  assert.equal(plan.title, 'revised after feedback');
  assert.equal(decision, undefined, 'the new plan is unanswered');
});

test('the last answer wins', () => {
  const { decision } = planFrom([
    planCall({ title: 'x', steps: [{ title: 'a' }] }),
    userSays(PLAN_REPLY.deferred),
    userSays(PLAN_REPLY.approved),
  ]);
  assert.equal(decision, 'approved', 'changing your mind is allowed');
});

test('an ordinary message is not mistaken for a decision', () => {
  const { decision } = planFrom([
    planCall({ title: 'x', steps: [{ title: 'a' }] }),
    userSays('what does step one actually touch?'),
  ]);
  assert.equal(decision, undefined, 'a question about the plan is not an answer to it');
});

test('a plan with no usable steps is not a plan', () => {
  assert.equal(planFrom([planCall({ title: 'empty', steps: [] })]).plan, undefined);
  assert.equal(planFrom([planCall({ title: 'junk', steps: [null, { detail: 'no title' }] })]).plan,
    undefined, 'steps without a title carry no information to act on');
});

test('missing optional fields become empty rather than undefined', () => {
  // The panel maps over these; undefined would be a crash on the one path that
  // matters most — a plan with nothing risky about it.
  const { plan } = planFrom([planCall({ title: 'simple', steps: [{ title: 'just do it' }] })]);
  assert.deepEqual(plan.risks, []);
  assert.deepEqual(plan.openQuestions, []);
});


// ── Closing a panel means "I have seen this one" ───────────────────────────

test('a task list has an identity that changes when the work does', () => {
  // A plain "dismissed" boolean would make the first close permanent, hiding
  // the next real thing behind a decision made about something else.
  const first = todosFrom([todoCall([
    { id: '1', title: 'write it', status: 'pending', priority: 'high' },
  ])]);
  const sameAgain = todosFrom([todoCall([
    { id: '1', title: 'write it', status: 'pending', priority: 'high' },
  ])]);
  assert.equal(first.signature, sameAgain.signature,
    'the same list re-rendered stays dismissed');

  const progressed = todosFrom([todoCall([
    { id: '1', title: 'write it', status: 'done', priority: 'high' },
  ])]);
  assert.notEqual(first.signature, progressed.signature,
    'an item changing state is new information, so the panel returns');

  const extended = todosFrom([todoCall([
    { id: '1', title: 'write it', status: 'pending', priority: 'high' },
    { id: '2', title: 'and test it', status: 'pending', priority: 'high' },
  ])]);
  assert.notEqual(first.signature, extended.signature, 'a new item likewise');
});

test('an empty list has an identity too, and it is not undefined', () => {
  // The dock compares against this before rendering; undefined would compare
  // equal to a missing dismissal and hide a list that was never closed.
  assert.equal(typeof todosFrom([]).signature, 'string');
});

test('a plan re-proposed unchanged keeps its place in the log', () => {
  // Plan identity is its position plus its title: a revision arrives at a new
  // seq, so a dismissal cannot silence the plan that replaced it.
  const messages = [
    planCall({ title: 'first', steps: [{ title: 'a' }] }),
    planCall({ title: 'second', steps: [{ title: 'b' }] }),
  ];
  const { plan } = planFrom(messages);
  assert.equal(plan.seq, 1, 'the newest proposal is the one on the table');
  assert.equal(plan.title, 'second');
});


// ── Answering a plan has consequences ──────────────────────────────────────

test('starting a deferred plan reads as approved, not as a new question', () => {
  // A plan picked up later is a plan that was agreed to. Left unmapped, the
  // panel would go on offering "Start it now" for something already running.
  const { decision } = planFrom([
    planCall({ title: 'x', steps: [{ title: 'a' }] }),
    userSays(PLAN_REPLY.deferred),
    userSays(PLAN_REPLY.startNow),
  ]);
  assert.equal(decision, 'approved');
});

test('an amendment un-decides the plan', () => {
  // The agent is rewriting it, so showing yesterday's answer against a plan
  // being revised would be worse than showing none.
  const { decision } = planFrom([
    planCall({ title: 'x', steps: [{ title: 'a' }] }),
    userSays(PLAN_REPLY.deferred),
    userSays(`${PLAN_REPLY.amendPrefix}drop the third step`),
  ]);
  assert.equal(decision, undefined);
});

test('the amend frame says it is an amendment', () => {
  // "About that plan — " left the agent to infer whether it was being
  // corrected, questioned or chatted with, and those call for different moves.
  assert.match(PLAN_REPLY.amendPrefix, /amend/i);
  assert.match(PLAN_REPLY.amendPrefix, /before we start/i,
    'and that nothing should be built yet');
});

test('every answer is a distinct phrase', () => {
  // These are matched by prefix on replay. Two that share a prefix would make
  // one answer read as another for the life of the log.
  const replies = [PLAN_REPLY.approved, PLAN_REPLY.deferred, PLAN_REPLY.declined,
                   PLAN_REPLY.startNow, PLAN_REPLY.amendPrefix];
  for (const a of replies) {
    for (const b of replies) {
      if (a === b) continue;
      assert.ok(!a.startsWith(b), `"${a}" must not begin with "${b}"`);
    }
  }
});


// ── A failed call must look failed ─────────────────────────────────────────

test('a structured error survives being stringified', () => {
  // The result reaches the client as the JSON string the log stored. A string
  // cannot be inspected for an `error` field, so every structured failure was
  // rendering as a green tick — watched live, six writes refused by plan mode
  // all displayed as "Wrote VERSION.txt" with a diff of a file that was never
  // created.
  const asObject = formatResult({ error: 'Unknown tool: Write' });
  assert.equal(asObject.isError, true);
  assert.equal(asObject.text, 'Unknown tool: Write');

  const asString = formatResult(JSON.stringify({ error: 'Unknown tool: Write' }));
  assert.equal(asString.isError, true, 'the string form is an error too');
  assert.equal(asString.text, 'Unknown tool: Write',
    'and reads as the message, not as raw JSON');
});

test('a stringified shell failure keeps its exit code', () => {
  const failed = formatResult(JSON.stringify({ stdout: '', stderr: 'nope', exit_code: 1 }));
  assert.equal(failed.isError, true);
  assert.ok(/exited 1/.test(failed.text));
});

test('ordinary text is still just text', () => {
  // The parse must not turn every result into a guess.
  assert.equal(formatResult('all good').isError, false);
  assert.equal(formatResult('all good').text, 'all good');
  assert.equal(formatResult('{not json').text, '{not json', 'a broken brace is not a shape');
});


test('the task list is visible while the turn is still running', () => {
  // A tool call is ephemeral until the turn ends: it lands in the draft and
  // reaches the durable log later. Panels that read only the log stayed empty
  // for the whole run and appeared at the end, having missed the part they
  // exist for — watched live, three TodoWrite calls went past with no task list
  // on screen. They read the same merged view the conversation renders.
  const draft = emptyDraft();
  draft.tools.set('c1', {
    id: 'tool-c1', type: 'tool', content: '', toolName: 'TodoWrite',
    toolArgs: { todos: [
      { id: '1', title: 'read it', status: 'in_progress', priority: 'high' },
      { id: '2', title: 'report', status: 'pending', priority: 'high' },
    ] },
    toolCallId: 'c1', toolRunning: false, timestamp: 0,
  });
  draft.order.push({ kind: 'tool', key: 'c1' });

  const live = todosFrom(composeMessages(new Map(), draft, true));
  assert.equal(live.total, 2, 'the in-flight list is found');
  assert.equal(live.inProgress, 1);
  assert.equal(live.allSettled, false, 'and is not mistaken for finished');
});


// ── Whether the project still builds ───────────────────────────────────────

const checksCall = (report) => ({
  id: 'rc', type: 'tool', content: '', toolName: 'RunChecks',
  toolResult: report, toolCallId: 'rc1', toolRunning: false, timestamp: 0,
});

const GREEN = [
  'PASSED — 2 checks, all green.',
  '',
  'PASS  typecheck  npm run typecheck  (2.1s)',
  'PASS  test       npm test  (18.4s)',
].join('\n');

const RED = [
  'FAILED — test did not pass. The project is not in a working state.',
  '',
  'PASS  typecheck  npm run typecheck  (2.1s)',
  'PASS  build      npm run build  (0.9s)',
  'FAIL  test       npm test  (12.0s)',
  '',
  'Output from test:',
  'AssertionError: expected 3 to equal 4',
  '  at Object.<anonymous> (t.mjs:4:1)',
  '',
  'Not run: lint — stopped at the first failure, because the later ones usually fail for the same reason.',
  '',
  'Fix this and run RunChecks again.',
].join('\n');

test('a green suite is read whole', () => {
  const c = checksFrom([checksCall(GREEN)]);
  assert.equal(c.lines.length, 2);
  assert.equal(c.passed, 2);
  assert.equal(c.failed, 0);
  assert.equal(c.allGreen, true);
  assert.equal(c.lines[0].name, 'typecheck');
  assert.equal(c.lines[1].seconds, 18.4, 'durations survive, so a slow check is visible as one');
});

test('a failure carries its output and what was skipped', () => {
  const c = checksFrom([checksCall(RED)]);
  assert.equal(c.allGreen, false);
  assert.equal(c.failed, 1);
  assert.equal(c.passed, 2, 'the ones that did pass still count');
  assert.ok(/expected 3 to equal 4/.test(c.failureOutput), 'the assertion is kept verbatim');
  assert.deepEqual(c.notRun, ['lint'],
    'and a check that never ran is named rather than left looking green');
});

test('the newest run is the whole answer', () => {
  // Each run reports the entire suite, so merging older ones would resurrect
  // results the code has already moved past.
  const c = checksFrom([checksCall(RED), checksCall(GREEN)]);
  assert.equal(c.allGreen, true);
  assert.equal(c.lines.length, 2);
});

test('a transcript with no run shows nothing', () => {
  assert.equal(checksFrom([]).lines.length, 0);
  assert.equal(checksFrom([checksCall('This project defines no checks — nothing to run.')]).lines.length, 0,
    'and a project with no checks is not rendered as an empty suite');
});

test('the identity changes when the result does', () => {
  // Dismissing means "I have seen this one". A red run that goes green must
  // come back rather than staying hidden behind a decision about the failure.
  assert.notEqual(checksFrom([checksCall(RED)]).signature, checksFrom([checksCall(GREEN)]).signature);
  assert.equal(checksFrom([checksCall(GREEN)]).signature, checksFrom([checksCall(GREEN)]).signature);
});

test('the tool row says green or names what failed', () => {
  assert.equal(outcomeOf('RunChecks', GREEN).label, '2/2 green');
  assert.equal(outcomeOf('RunChecks', GREEN).tone, 'good');

  const bad = outcomeOf('RunChecks', RED);
  assert.equal(bad.label, 'test failing');
  assert.equal(bad.tone, 'bad');
  assert.ok(/FAIL\s+test/.test(bad.detail), 'with the failing line inline');
});


section('The chat you were just in, without hunting for it');

const CHATS = [
  { id: 'a', title: 'oldest',  updatedAt: 1000, project: 'E:/one' },
  { id: 'b', title: 'middle',  updatedAt: 3000, project: 'E:/two' },
  { id: 'c', title: 'newest',  updatedAt: 5000, project: 'E:/one' },
  { id: 'd', title: 'fourth',  updatedAt: 2000 },
];

test('newest first, whatever folder it lives in', () => {
  const { items } = recentSessions(CHATS, '', 10);
  assert.deepEqual(items.map(s => s.id), ['c', 'b', 'd', 'a']);
});

test('a session with no folder at all still appears', () => {
  // The case the folder list cannot show: nothing to file it under.
  assert.ok(recentSessions(CHATS, '', 10).items.some(s => s.id === 'd'));
});

test('the limit caps the list but the total counts everything', () => {
  const { items, total } = recentSessions(CHATS, '', 2);
  assert.equal(items.length, 2, 'only two rows');
  assert.equal(total, 4, 'but the header knows there are four');
});

test('view-more arithmetic is right', () => {
  const { items, total } = recentSessions(CHATS, '', 3);
  assert.equal(total - items.length, 1, 'one older, which is what the button offers');
});

test('the filter applies here too', () => {
  assert.deepEqual(recentSessions(CHATS, 'newest', 10).items.map(s => s.id), ['c']);
  assert.equal(recentSessions(CHATS, 'zzz', 10).total, 0, 'and nothing matching is empty');
});

section('Finding an agent by typing');

const ROSTER = [
  { name: 'security', description: 'Defensive security review.', role: 'Application Security Reviewer', source: 'builtin' },
  { name: 'backend', description: 'Production backend implementation.', role: 'Senior Backend Engineer', source: 'builtin' },
  { name: 'my-reviewer', description: 'Checks tests for security holes.', role: 'reviewer', source: 'user' },
];

test('an exact name wins, then a prefix, then a substring', () => {
  const hits = searchAgents(ROSTER, 'sec');
  // "security" starts with it; "my-reviewer" only mentions security in prose.
  assert.equal(hits[0].name, 'security', 'the agent being typed comes first');
  assert.ok(hits.some(a => a.name === 'my-reviewer'), 'and a description match still appears');
});

test('the role is searchable, not just the name', () => {
  assert.equal(searchAgents(ROSTER, 'engineer')[0].name, 'backend',
    'a word from the role finds the agent');
  assert.equal(searchAgents(ROSTER, 'backend engineer')[0].name, 'backend',
    'and so does a phrase from it — "Senior Backend Engineer" contains it');
});

test('an empty query is everyone, in the order given', () => {
  assert.equal(searchAgents(ROSTER, '   ').length, 3);
});

test('nothing matching is empty rather than everything', () => {
  assert.equal(searchAgents(ROSTER, 'zzzz').length, 0);
});

test('yours are separated from the ones that shipped', () => {
  const { mine, builtin } = splitAgents(ROSTER);
  assert.deepEqual(mine.map(a => a.name), ['my-reviewer']);
  assert.equal(builtin.length, 2);
});

section('@ opens the menu, and only where it should');

test('a bare @ at the start opens it', () => {
  assert.deepEqual(mentionAt('@', 1), { query: '', from: 0 });
});

test('and captures what follows', () => {
  assert.deepEqual(mentionAt('look at @sec', 12), { query: 'sec', from: 8 });
});

test('an email address does not open an agent menu', () => {
  // The @ has a word character before it, so it is not a mention.
  assert.equal(mentionAt('mail me at bob@example.com', 26), null);
});

test('nor does a completed mention followed by more words', () => {
  assert.equal(mentionAt('@security please review this', 28), null,
    'once you type past the name, the menu is done');
});

test('the caret position decides, not the whole string', () => {
  const text = '@security review';
  assert.deepEqual(mentionAt(text, 4), { query: 'sec', from: 0 },
    'a caret inside the token still opens it');
  assert.equal(mentionAt(text, 16), null, 'a caret past it does not');
});

test('no @ at all is no menu', () => {
  assert.equal(mentionAt('just a normal message', 21), null);
});

section('Who you were talking to is in the transcript');

// The composer only ever shows the *current* answer. Reading a session back is
// the case that needs the mark in the log: without it there is no way to tell
// which replies came from the architect and which from the orchestrator.
test('switching to an agent leaves a mark in the transcript', () => {
  const out = applyLogEvent(new Map(), 4, { type: 'session/agent', name: 'architect' }, 0);
  const entry = out.get(4);
  assert.equal(entry.type, 'system');
  assert.match(entry.content, /Talking to architect from here/);
});

test('and switching back says so too', () => {
  const out = applyLogEvent(new Map(), 5, { type: 'session/agent', name: null }, 0);
  assert.match(out.get(5).content, /Back to the orchestrator/);
});

test('it is keyed by seq, so replaying the log is idempotent', () => {
  let out = applyLogEvent(new Map(), 7, { type: 'session/agent', name: 'qa' }, 0);
  out = applyLogEvent(out, 7, { type: 'session/agent', name: 'qa' }, 0);
  assert.equal(out.size, 1, 'the same event twice is still one entry');
});

section('Stop can always unstick the page');

// Found live: a submit whose request never settled left the client certain a
// turn was running while the server had no record of one. `busy` is cleared by
// a turn-end event, so when no turn exists the event never comes, Stop does
// nothing, and only a reload escapes.
test('Stop clears busy when the server says nothing is running', () => {
  assert.equal(shouldClearBusy(true, { running: false }), true);
});

test('but leaves a real turn alone — Stop asks the server, it does not overrule it', () => {
  assert.equal(shouldClearBusy(true, { running: true }), false,
    'a turn that is genuinely running ends via turn-end, not by the page deciding');
});

test('an unreachable server clears it too, since it cannot be running our turn', () => {
  // Of the two ways to be wrong, a page that stops claiming to be busy is
  // recoverable and a page that never stops is not.
  assert.equal(shouldClearBusy(true, 'unreachable'), true);
});

test('and a page that was not busy is left exactly as it was', () => {
  assert.equal(shouldClearBusy(false, { running: false }), false);
  assert.equal(shouldClearBusy(false, { running: true }), false);
  assert.equal(shouldClearBusy(false, 'unreachable'), false);
});


// ── Retiring a plan or a task list ─────────────────────────────────────────

const shipIt = () => planCall({ title: 'Ship it', steps: [{ title: 'do the thing' }] });

test('a plan can be called off after it was approved, which is not declining it', () => {
  const messages = [shipIt(), userSays(PLAN_REPLY.approved), userSays(PLAN_REPLY.cancelled)];
  assert.equal(planFrom(messages).decision, 'cancelled',
    'the later word wins — approval is not permanent');
});

test('and it can be declared finished, which the agent is told in so many words', () => {
  const messages = [shipIt(), userSays(PLAN_REPLY.approved), userSays(PLAN_REPLY.completed)];
  assert.equal(planFrom(messages).decision, 'completed');
  // The point of routing this through a real message: the agent reads the same
  // sentence the panel acted on, so hiding the panel and stopping the work are
  // one event rather than two that can disagree.
  assert.match(PLAN_REPLY.completed, /finished/i);
  assert.match(PLAN_REPLY.cancelled, /no longer applies/i);
});

test('a task list the reader retired stops following the conversation around', () => {
  const live = [todoCall([
    { id: '1', title: 'write it', status: 'pending', priority: 'high' },
  ])];
  assert.equal(todosFrom(live).retired, false, 'an untouched list is not retired');

  assert.equal(todosFrom([...live, userSays(TASK_REPLY.completed)]).retired, true);
  assert.equal(todosFrom([...live, userSays(TASK_REPLY.dropped)]).retired, true);
});

test('it stays retired once the agent closes the list out, rather than bouncing back', () => {
  // Without this the panel returns one turn later to announce "all done",
  // which is exactly the thing the reader just dismissed.
  const summary = todosFrom([
    todoCall([{ id: '1', title: 'write it', status: 'pending', priority: 'high' }]),
    userSays(TASK_REPLY.completed),
    todoCall([{ id: '1', title: 'write it', status: 'done', priority: 'high' }]),
  ]);
  assert.equal(summary.allSettled, true);
  assert.equal(summary.retired, true, 'the agent complied, so there is nothing left to show');
});

test('but genuinely new work brings it back, because new work is not settled', () => {
  const messages = [
    todoCall([{ id: '1', title: 'write it', status: 'pending', priority: 'high' }]),
    userSays(TASK_REPLY.completed),
    todoCall([
      { id: '1', title: 'write it', status: 'done', priority: 'high' },
      { id: '2', title: 'something else entirely', status: 'pending', priority: 'high' },
    ]),
  ];
  assert.equal(todosFrom(messages).retired, false,
    'retiring one list does not silence the panel for the rest of the session');
});

test('an ordinary message that merely mentions the tasks does not retire them', () => {
  const messages = [
    todoCall([{ id: '1', title: 'write it', status: 'pending', priority: 'high' }]),
    userSays('are all of those tasks complete?'),
  ];
  assert.equal(todosFrom(messages).retired, false);
});

// ── Dismissals that survive a reload ───────────────────────────────────────

function fakeStorage() {
  const data = new Map();
  return {
    getItem: (k) => (data.has(k) ? data.get(k) : null),
    setItem: (k, v) => { data.set(k, String(v)); },
    removeItem: (k) => { data.delete(k); },
  };
}

test('a closed panel is still closed after a reload', () => {
  const store = fakeStorage();
  saveDismissals('s1', { plan: '4:Ship it' }, store);
  assert.deepEqual(loadDismissals('s1', store), { plan: '4:Ship it' });
});

test('but only in the session it was closed in', () => {
  const store = fakeStorage();
  saveDismissals('s1', { plan: '4:Ship it' }, store);
  assert.deepEqual(loadDismissals('s2', store), {},
    'closing a panel says nothing about the next conversation');
});

test('clearing a session removes it rather than storing an empty shell', () => {
  const store = fakeStorage();
  saveDismissals('s1', { plan: 'x' }, store);
  saveDismissals('s1', {}, store);
  assert.deepEqual(loadDismissals('s1', store), {});
});

test('old sessions are evicted, so this does not grow for ever', () => {
  const store = fakeStorage();
  for (let i = 0; i < 45; i++) saveDismissals(`s${i}`, { plan: String(i) }, store);
  assert.deepEqual(loadDismissals('s0', store), {}, 'the oldest is gone');
  assert.deepEqual(loadDismissals('s44', store), { plan: '44' }, 'the newest is kept');
});

test('a session written again is kept, being the most recently used', () => {
  const store = fakeStorage();
  saveDismissals('keep', { plan: 'a' }, store);
  for (let i = 0; i < 20; i++) saveDismissals(`s${i}`, { plan: String(i) }, store);
  saveDismissals('keep', { plan: 'b' }, store);
  for (let i = 20; i < 39; i++) saveDismissals(`s${i}`, { plan: String(i) }, store);
  assert.deepEqual(loadDismissals('keep', store), { plan: 'b' },
    'eviction drops the least recently used, not the first ever created');
});

test('nonsense in storage is discarded rather than half-trusted', () => {
  const store = fakeStorage();
  for (const junk of ['not json', '[]', 'null', '{"s1":"a string"}', '{"s1":{"plan":7}}']) {
    store.setItem('aico.dismissed', junk);
    assert.deepEqual(loadDismissals('s1', store), {}, `survives ${junk}`);
  }
});

test('and storage that throws is survivable, because a panel is not worth a crash', () => {
  const hostile = {
    getItem: () => { throw new Error('blocked'); },
    setItem: () => { throw new Error('blocked'); },
    removeItem: () => { throw new Error('blocked'); },
  };
  assert.deepEqual(loadDismissals('s1', hostile), {});
  saveDismissals('s1', { plan: 'x' }, hostile);
});

// ── Rendered widgets ───────────────────────────────────────────────────────

test('a chart spec is accepted when it can actually draw something', () => {
  const ok = parseChartSpec('{"series":[{"type":"bar","data":[1,2,3]}]}');
  assert.equal(ok.error, undefined, 'a spec with series parses');
  assert.equal(ok.option.series.length, 1, 'and the option survives');

  // `dataset` is the other legitimate way to supply data, and refusing it would
  // reject a whole documented ECharts idiom.
  assert.equal(parseChartSpec('{"dataset":{"source":[[1,2]]},"xAxis":{}}').error, undefined,
    'a dataset-driven spec is accepted too');
});

test('and refused, with a reason, when it cannot', () => {
  assert.match(parseChartSpec('').error, /empty/, 'an empty block says so');
  assert.match(parseChartSpec('{"xAxis":{}}').error, /nothing to draw/,
    'no series means there is nothing to draw, which is more useful than "invalid"');
  assert.match(parseChartSpec('[1,2,3]').error, /JSON object/,
    'an array is not an option object');
  assert.match(parseChartSpec('{"series":[},}').error, /not valid JSON/,
    'and malformed JSON is named as such rather than thrown');
});

test('a table takes the shape a renderer can read, and says so when it does not', () => {
  const ok = parseTableSpec('{"columns":["a","b"],"rows":[[1,2],[3,4]]}');
  assert.equal(ok.error, undefined);
  assert.equal(ok.spec.rows.length, 2);

  // The exact mistake the sibling console documented: a perfectly reasonable
  // array-of-objects, and not the shape this reads. The error has to name the
  // difference or the next attempt is the same guess.
  const objects = parseTableSpec('{"columns":["a"],"rows":[{"a":1}]}');
  assert.match(objects.error, /array of arrays/, 'objects-as-rows is caught');
  assert.match(objects.error, /not an array of objects/, 'and the wrong shape is named');

  const ragged = parseTableSpec('{"columns":["a","b"],"rows":[[1,2],[3]]}');
  assert.match(ragged.error, /row 2 has 1 cells but there are 2 columns/,
    'a ragged row is located, not just reported');
});

test('numbers are recognised in the forms a model actually writes them', () => {
  assert.equal(numericValue(42), 42, 'a number');
  assert.equal(numericValue('42'), 42, 'a numeric string');
  assert.equal(numericValue('1,024'), 1024, 'thousands separators — a column of these summing to nothing looks broken');
  assert.equal(numericValue('$1200'), 1200, 'currency');
  assert.equal(numericValue('92%'), 92, 'percentages');
  assert.equal(numericValue('-3.5'), -3.5, 'negatives and decimals');
  assert.equal(numericValue('n/a'), undefined, 'and a non-number is not coerced to zero');
  assert.equal(numericValue(''), undefined, 'nor is an empty cell');
  assert.equal(numericValue(null), undefined, 'nor a null');
});

test('the stats row computes what a reader would otherwise ask the model for', () => {
  const spec = {
    columns: ['region', 'spend'],
    rows: [['EU', 1200], ['US', 980], ['APAC', 400]],
  };
  const stats = summarise(spec, 1);
  assert.equal(stats.sum, 2580, 'sum');
  assert.equal(stats.min, 400, 'min');
  assert.equal(stats.max, 1200, 'max');
  assert.equal(stats.count, 3, 'count');
  assert.equal(Math.round(stats.mean), 860, 'mean');

  // A text column has no arithmetic, and inventing some would be worse than
  // leaving the row out.
  assert.equal(summarise(spec, 0), undefined, 'a text column is not summarised');
});

console.log(`\n  WEB UI: ${pass} passed, ${fail} failed\n`);
process.exit(fail > 0 ? 1 : 0);
