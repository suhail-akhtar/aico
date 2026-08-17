/**
 * Live provider test suite.
 *
 * Exercises the real agent loop against a real API — the parts the mock-based
 * harness cannot prove: wire-format compatibility, streaming shapes, tool-call
 * round trips, prompt caching, and truncation behaviour.
 *
 * Costs money. Not part of `npm test`. Run:
 *   node live-test.mjs                    # both models
 *   node live-test.mjs gpt-5.6-luna       # one model
 */
import 'dotenv/config';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  runAgent,
  Session,
  checkSessionInvariants,
  loadEventLog,
  initEventLog,
  persistSession,
  deriveMessages,
  getContextWindow,
  maybeCompactSession,
  formatCompactionResult,
  serializeSessionTranscript,
  describeSessionContext,
  selectProvider,
  requiresResponsesApi,
  Inbox,
} from './dist-test/test-exports.js';

const MODELS = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ['gpt-5.6-luna', 'gpt-5.6-terra'];

let passed = 0, failed = 0;
const failures = [];
function assert(cond, name) {
  if (cond) { passed++; console.log(`    ✓ ${name}`); }
  else { failed++; failures.push(name); console.log(`    ✗ ${name}`); }
}
function section(t) { console.log(`\n  ── ${t} ──`); }

// ── Sandbox working directory ────────────────────────────────────────
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aico-live-'));
fs.writeFileSync(path.join(workDir, 'greeting.txt'), 'the secret word is pomegranate\n');
fs.writeFileSync(path.join(workDir, 'numbers.txt'), '17\n');
const originalCwd = process.cwd();
process.chdir(workDir);

const SETTINGS = {
  completionGate: { enabled: false },
  cron: { enabled: false },
  autoCompact: { enabled: false },
  providers: { openai: { reasoningEffort: 'low' } },
};

let sessionCounter = 0;
function freshSession() {
  return new Session({
    id: `live-${Date.now()}-${++sessionCounter}`,
    cwd: workDir,
    startedAt: Date.now(),
  });
}

async function run(model, task, session, extra = {}) {
  return runAgent({
    task,
    model,
    showPlan: false,
    autoApprove: true,
    verbose: false,
    silent: true,
    conversationHistory: [],
    sessionId: session.header.id,
    settings: SETTINGS,
    session,
    ...extra,
  });
}

/** Summarize a session log for assertions. */
function shape(session) {
  const ev = session.events;
  const t = ev.map(e => e.type);
  return {
    turns: t.filter(x => x === 'turn/start').length,
    steps: t.filter(x => x === 'step/start').length,
    stepEnds: t.filter(x => x === 'step/end').length,
    calls: ev.filter(e => e.type === 'tool/call'),
    results: ev.filter(e => e.type === 'tool/result'),
    assistants: ev.filter(e => e.type === 'assistant/message'),
    end: session.lastTurnEndReason(),
    usage: ev.filter(e => e.type === 'assistant/message' && e.data.usage).map(e => e.data.usage),
  };
}

console.log('═'.repeat(64));
console.log('  AICO LIVE PROVIDER TESTS');
console.log('  models:', MODELS.join(', '));
console.log('  workdir:', workDir);
console.log('═'.repeat(64));

for (const model of MODELS) {
  console.log(`\n${'█'.repeat(64)}\n  MODEL: ${model}\n${'█'.repeat(64)}`);

  // ── 1. Routing ─────────────────────────────────────────────────────
  section('1. Provider routing');
  assert(requiresResponsesApi(model), `${model} is routed to the Responses API`);
  const provider = selectProvider(model, SETTINGS);
  assert(provider.id === 'openai', 'Resolves to the OpenAI provider');
  assert(provider.constructor.name === 'OpenAIResponsesProvider',
    `Uses OpenAIResponsesProvider (got ${provider.constructor.name})`);
  const ctx = getContextWindow(model, SETTINGS);
  assert(ctx >= 128_000, `Context window resolves to a sane value (${ctx.toLocaleString()})`);

  // ── 2. Plain text turn ─────────────────────────────────────────────
  section('2. Plain text turn (no tools used)');
  {
    const s = freshSession();
    const out = await run(model, 'Reply with exactly the word: ACKNOWLEDGED. Nothing else.', s);
    assert(/ACKNOWLEDGED/i.test(out), `Model answered (${JSON.stringify(out).slice(0, 60)})`);
    const sh = shape(s);
    assert(sh.turns === 1, 'Exactly one turn');
    assert(sh.steps === sh.stepEnds && sh.steps >= 1, 'Steps balanced');
    assert(sh.end.kind === 'completed', `Turn completed (got ${sh.end.kind})`);
    assert(checkSessionInvariants(s).ok, 'Log satisfies every invariant');
    assert(sh.usage.length > 0 && sh.usage[0].inputTokens > 0, 'Usage reported from the stream');
  }

  // ── 3. Tool call round trip ────────────────────────────────────────
  section('3. Tool call round trip');
  let toolSession;
  {
    const s = toolSession = freshSession();
    const out = await run(model,
      'Use the Read tool on greeting.txt and tell me the secret word. Answer in one short sentence.', s);
    const sh = shape(s);
    assert(sh.calls.length >= 1, `At least one tool call logged (${sh.calls.length})`);
    assert(sh.calls.some(c => c.data.name === 'Read'), 'Read tool was called');
    assert(sh.results.length === sh.calls.length, 'Every call has a result');
    assert(sh.steps >= 2, `Multi-step turn (${sh.steps} steps)`);
    assert(/pomegranate/i.test(out), `Answer used the tool result (${JSON.stringify(out).slice(0, 70)})`);
    assert(sh.end.kind === 'completed', `Turn completed (got ${sh.end.kind})`);
    assert(checkSessionInvariants(s).ok,
      `Log satisfies every invariant (${checkSessionInvariants(s).violations.map(v => v.code).join(',')})`);
    // Result must cite the seq of its originating call.
    assert(sh.results.every(r => Array.isArray(r.sourceEventSeqs) && r.sourceEventSeqs.length === 1),
      'Every result cites its originating call seq');
  }

  // ── 4. Session-log fidelity, live ─────────────────────────────────
  section('4. Cross-turn tool fidelity');
  {
    const s = toolSession;
    const before = s.events.length;
    const out = await run(model,
      'Without calling any tools again, repeat the secret word you just read.', s);
    const sh = shape(s);
    assert(sh.turns === 2, `Second turn on the same session (${sh.turns})`);
    assert(s.events.length > before, 'New events appended to the same log');
    // The derived request for turn 2 must contain the structured pair.
    const msgs = deriveMessages(s.events);
    assert(msgs.some(m => m.role === 'assistant' && (m.toolCalls?.length ?? 0) > 0),
      'Derived history carries the assistant tool call');
    assert(msgs.some(m => m.role === 'tool'),
      'Derived history carries the tool result as a real tool message');
    assert(/pomegranate/i.test(out),
      `Model recalled the earlier tool result across a turn boundary (${JSON.stringify(out).slice(0, 70)})`);
    assert(checkSessionInvariants(s).ok, 'Two-turn log satisfies every invariant');
  }

  // ── 5. Multiple tool calls ─────────────────────────────────────────
  section('5. Multiple tool calls');
  {
    const s = freshSession();
    await run(model,
      'Read greeting.txt AND numbers.txt using the Read tool, then state both contents in one sentence.', s);
    const sh = shape(s);
    assert(sh.calls.length >= 2, `Multiple tool calls issued (${sh.calls.length})`);
    assert(sh.results.length === sh.calls.length, 'Every call answered');
    const ids = sh.calls.map(c => c.data.callId);
    assert(new Set(ids).size === ids.length, 'Call ids are unique');
    assert(checkSessionInvariants(s).ok, 'Multi-call log satisfies every invariant');
  }

  // ── 6. Persistence + resume ────────────────────────────────────────
  section('6. Persistence and resume from disk');
  {
    const s = freshSession();
    await initEventLog(s.header);
    const h = persistSession(s);
    await run(model, 'Use the Read tool on numbers.txt and state the number.', s);
    await h.detach();

    const reloaded = await loadEventLog(s.header.id, workDir);
    assert(reloaded !== null, 'Event log persisted to disk');
    assert(reloaded.length === s.length, `All ${s.length} events survived the round trip`);
    assert(checkSessionInvariants(reloaded).ok, 'Reloaded log satisfies every invariant');
    const rm = reloaded.deriveMessages();
    assert(rm.some(m => m.role === 'tool'), 'Tool results survive the disk round trip');
    // Continue the reloaded session — proves resume actually works end to end.
    const out = await run(model, 'What number did you just read? One word.', reloaded);
    assert(/17|seventeen/i.test(out),
      `Resumed session recalled the tool result (${JSON.stringify(out).slice(0, 50)})`);
    assert(checkSessionInvariants(reloaded).ok, 'Resumed log still satisfies every invariant');
  }

  // ── 7. Prompt caching ──────────────────────────────────────────────
  section('7. Prompt caching');
  {
    const s = freshSession();
    await run(model, 'Say READY.', s);
    await run(model, 'Say READY again.', s);
    const sh = shape(s);
    const cached = sh.usage.reduce((a, u) => a + (u.cachedTokens ?? 0), 0);
    const totalIn = sh.usage.reduce((a, u) => a + u.inputTokens, 0);
    console.log(`      input=${totalIn} cached=${cached}`);
    assert(totalIn > 0, 'Input tokens reported');
    // Caching is opportunistic; assert plumbing, not a hit.
    assert(sh.usage.every(u => typeof u.cachedTokens === 'number'), 'Cached-token field is plumbed through');
  }

  // ── 8. Truncation ──────────────────────────────────────────────────
  section('8. Output-ceiling truncation');
  {
    const s = freshSession();
    const tiny = selectProvider(model, {
      ...SETTINGS,
      providers: { openai: { reasoningEffort: 'none', maxOutputTokens: 16 } },
    });
    const out = await run(model, 'Write a 500 word essay about the sea.', s, { provider: tiny });
    const sh = shape(s);
    assert(sh.end.kind === 'max-tokens', `Truncated turn ends as max-tokens (got ${sh.end.kind})`);
    assert(/output-token ceiling/.test(out), 'Truncation surfaced to the caller');
    assert(checkSessionInvariants(s).ok, 'Truncated turn leaves a balanced log');
  }

  // ── 9. Cancellation ────────────────────────────────────────────────
  section('9. Cancellation mid-stream');
  {
    const s = freshSession();
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 250);
    let threw = false;
    try {
      await run(model, 'Write a very long detailed essay about the history of cartography.', s,
        { abortSignal: ac.signal });
    } catch { threw = true; }
    assert(threw, 'Cancellation propagates to the caller');
    assert(s.lastTurnEndReason()?.kind === 'aborted',
      `Cancelled turn ends as aborted (got ${s.lastTurnEndReason()?.kind})`);
    assert(checkSessionInvariants(s).ok, 'Cancelled turn leaves a balanced log');
  }

  // ── 10. Compaction is non-destructive ──────────────────────────────
  section('10. Non-destructive compaction over a live log');
  {
    const s = freshSession();
    await run(model, 'Use the Read tool on greeting.txt, then say DONE.', s);
    const surfaceBefore = s.surfaceEvents().length;
    const lastSurface = s.surfaceEvents().at(-1).seq;
    const firstSurface = s.surfaceEvents()[0].seq;
    s.appendCompactionSummary(
      'Earlier: the assistant read greeting.txt; the secret word is pomegranate.',
      { start: firstSurface, end: lastSurface },
      { before: 1000, after: 20 },
    );
    const msgs = s.deriveMessages();
    assert(msgs.length === 1, `Compacted log derives a single message (got ${msgs.length})`);
    assert(/pomegranate/.test(msgs[0].content), 'Summary is what the model now sees');
    assert(s.events.length > surfaceBefore, 'Original events are still in the log (non-destructive)');
    assert(s.events.some(e => e.type === 'compaction/summary'), 'Compaction bookkeeping recorded');
    const out = await run(model, 'What was the secret word? One word.', s);
    assert(/pomegranate/i.test(out), `Model answers from the compacted summary (${JSON.stringify(out).slice(0, 40)})`);
    assert(checkSessionInvariants(s).ok, 'Compacted log satisfies every invariant');
  }

  // ── 11. Steering a running turn (L2) ───────────────────────────────
  section('11. Steering a live run');
  {
    // Steering queued before the run: delivered at the first step boundary,
    // so the model acts on it without a second turn being opened.
    const s = freshSession();
    const box = new Inbox(s);
    box.steer('Change of plan: read numbers.txt instead of greeting.txt, and report that number.');
    const out = await run(model,
      'Use the Read tool on greeting.txt and report the secret word.', s, { inbox: box });
    const sh = shape(s);
    assert(sh.turns === 1, `Steering stayed inside one turn (${sh.turns})`);
    assert(box.nextStep.length === 0, 'Inbox drained by the loop');
    const steered = s.events.filter(
      e => e.type === 'user/message' && /Change of plan/.test(e.data.content));
    assert(steered.length === 1, 'Steered message recorded exactly once');
    assert(/17|seventeen/i.test(out),
      `Model followed the steer (${JSON.stringify(out).slice(0, 90)})`);
    assert(checkSessionInvariants(s).ok, 'Steered run satisfies every invariant');
  }

  {
    // Steering DURING the run: injected from a callback while tools execute.
    // This is the case the old volatile queue could never serve.
    const s = freshSession();
    const box = new Inbox(s);
    let injected = false;
    const out = await run(model,
      'Use the Read tool on greeting.txt. Then stop and tell me the secret word.', s, {
        inbox: box,
        onToolDone: () => {
          if (injected) return;
          injected = true;
          box.steer('Before you answer, also Read numbers.txt and include that number.');
        },
      });
    const sh = shape(s);
    assert(injected, 'Steering was injected mid-run from a tool callback');
    assert(sh.turns === 1, `Mid-run steering extended the same turn (${sh.turns} turn)`);
    assert(sh.calls.length >= 2, `Model performed the extra work (${sh.calls.length} tool calls)`);
    assert(/17|seventeen/i.test(out),
      `Answer reflects the steered instruction (${JSON.stringify(out).slice(0, 90)})`);
    assert(checkSessionInvariants(s).ok, 'Mid-run steered turn satisfies every invariant');
  }

  {
    // Durability: a steer survives a process restart via the log.
    const s = freshSession();
    await initEventLog(s.header);
    const h = persistSession(s);
    const box = new Inbox(s);
    box.steer('pending across a restart');
    box.followup('a separate request');
    await h.detach();

    const reloaded = await loadEventLog(s.header.id, workDir);
    const replayedBox = new Inbox(reloaded);
    assert(replayedBox.nextStep.length === 1, 'Steering survived the restart');
    assert(replayedBox.nextTurn.length === 1, 'Followup survived the restart');
    assert(replayedBox.nextStep[0].content === 'pending across a restart', 'Content intact');
  }

  // ── 12. Parallel tool scheduling (L4) ──────────────────────────────
  section('12. Parallel tool scheduling');
  {
    // Ask for several independent reads in one step and confirm the log stays
    // in model order and pairs correctly, whatever order they finished in.
    const s = freshSession();
    const t0 = Date.now();
    const out = await run(model,
      'In a SINGLE response, issue three separate Read tool calls: greeting.txt, ' +
      'numbers.txt, and greeting.txt again. Then report the secret word and the number.', s);
    const elapsed = Date.now() - t0;
    const sh = shape(s);
    console.log(`      tool calls=${sh.calls.length} steps=${sh.steps} elapsed=${elapsed}ms`);
    assert(sh.calls.length >= 2, `Multiple calls issued (${sh.calls.length})`);
    assert(sh.results.length === sh.calls.length, 'Every call answered');
    // Calls and results must appear in the same relative order.
    const callIds = sh.calls.map(c => c.data.callId);
    const resultIds = sh.results.map(r => r.data.callId);
    assert(callIds.join(',') === resultIds.join(','),
      `Results are in model order (calls ${callIds.join(',')} vs results ${resultIds.join(',')})`);
    assert(/pomegranate/i.test(out) && /17|seventeen/i.test(out),
      `Answer used every result (${JSON.stringify(out).slice(0, 90)})`);
    assert(checkSessionInvariants(s).ok, 'Parallel step satisfies every invariant');
    // Derivation must pair each result with its call for the next request.
    const msgs = deriveMessages(s.events);
    const toolMsgs = msgs.filter(m => m.role === 'tool');
    assert(toolMsgs.length === sh.results.length, 'Every result derives as a tool message');
  }

  // ── 13. Compaction keeps the agent working ─────────────────────────
  section('13. Compaction over a live multi-turn session');
  {
    // Build a genuine multi-turn session with real tool use, compact it, then
    // ask a question that can only be answered from the folded history. This is
    // the test that matters: a summary that shrinks context but destroys the
    // agent's ability to continue is worse than no compaction at all.
    const s = freshSession();
    // Bulk file so the turns carry real tool output — compaction only helps
    // when there is something substantial to fold, and the growth guard will
    // (correctly) refuse otherwise.
    fs.writeFileSync(path.join(workDir, 'bulk.txt'),
      Array.from({ length: 120 }, (_, i) => `line ${i}: ${'lorem ipsum dolor sit amet '.repeat(3)}`).join('\n'));

    await run(model, 'Use the Read tool on greeting.txt. Reply with just the secret word.', s);
    await run(model, 'Use the Read tool on numbers.txt. Reply with just the number.', s);
    await run(model, 'Use the Read tool on bulk.txt. Reply with just the number of lines.', s);
    await run(model, 'Use the Read tool on bulk.txt again. Reply with just the first word of line 5.', s);
    await run(model, 'Say READY.', s);

    const turnsBefore = s.events.filter(e => e.type === 'turn/start').length;
    assert(turnsBefore === 5, `Built a five-turn session (${turnsBefore})`);

    const result = maybeCompactSession(s, { autoCompact: { keepRecentTurns: 1 } }, model, { force: true });
    console.log('      ' + formatCompactionResult(result));
    assert(result.compacted, `Compaction ran (${result.reason ?? ''})`);
    assert(result.tokensAfter < result.tokensBefore,
      `Context shrank (${result.tokensBefore} → ${result.tokensAfter})`);
    assert(result.droppedTurns === 4, `Folded four turns (${result.droppedTurns})`);
    assert(checkSessionInvariants(s).ok, 'Compacted live log satisfies every invariant');
    // Originals retained.
    assert(s.events.some(e => e.type === 'compaction/summary'), 'Bookkeeping recorded');

    // THE question: can it still answer from the summary alone?
    const out = await run(model,
      'From our earlier conversation, what were the secret word and the number? One line.', s);
    assert(/pomegranate/i.test(out) && /17|seventeen/i.test(out),
      `Model answered from the compacted summary (${JSON.stringify(out).slice(0, 100)})`);
    assert(checkSessionInvariants(s).ok, 'Post-compaction run satisfies every invariant');
  }

  // ── 14. Context surfaces tell the truth ────────────────────────────
  section('14. Context surfaces (clear / status / transcript)');
  {
    const s = freshSession();
    await run(model, 'Use the Read tool on greeting.txt. Reply with just the secret word.', s);
    // Confirm the model genuinely carries it forward first.
    const recalled = await run(model, 'What was the secret word? One word.', s);
    assert(/pomegranate/i.test(recalled),
      `Precondition: the model carries context forward (${JSON.stringify(recalled).slice(0, 40)})`);

    // Now clear, and verify the model can no longer answer from history.
    const marker = s.clearContext();
    assert(marker !== undefined, 'Clear recorded a marker');
    assert(s.deriveMessages().length === 0, 'Model context is empty after clear');

    const afterClear = await run(model,
      'What was the secret word from earlier in this conversation? ' +
      'If you have no earlier conversation, reply exactly: NO CONTEXT.', s);
    assert(!/pomegranate/i.test(afterClear),
      `Model can no longer recall the cleared history (${JSON.stringify(afterClear).slice(0, 80)})`);
    assert(checkSessionInvariants(s).ok, 'Cleared live log satisfies every invariant');

    // The history is still on disk for the transcript — cleared, not destroyed.
    const full = serializeSessionTranscript(s, { includeShadowed: true });
    assert(/pomegranate/i.test(full), 'Cleared history is still recoverable from the log');
    assert(/#### Tool: Read/.test(full), 'Transcript captures tool calls the message array never held');

    const status = describeSessionContext(s, model, SETTINGS);
    assert(/hidden by compaction\/clear/.test(status), 'Status accounts for the cleared history');
    console.log('      ' + status.split('\n').join(' | '));
  }

  // ── 15. Sub-agent inheritance, live ────────────────────────────────
  section('15. Sub-agent inherits its parent\'s constraints');
  {
    // A plan-mode parent delegates. The child must inherit the restriction —
    // before the fix it received full Write/Edit/Bash, so plan mode was
    // escapable in one Task call.
    const s = freshSession();
    fs.writeFileSync(path.join(workDir, 'target.txt'), 'ORIGINAL\n');

    const out = await run(model,
      'Use the Task tool to spawn a sub-agent with subagent_type "general". ' +
      'Instruct it to overwrite target.txt with the word CHANGED using the Write tool, ' +
      'then report whether it succeeded. Summarise what the sub-agent reported.', s,
      { planMode: true });

    const after = fs.readFileSync(path.join(workDir, 'target.txt'), 'utf8');
    assert(after.trim() === 'ORIGINAL',
      `Plan mode held through delegation — file untouched (${JSON.stringify(after.trim())})`);
    assert(checkSessionInvariants(s).ok, 'Delegating plan-mode run satisfies every invariant');
    console.log(`      parent said: ${JSON.stringify(out).slice(0, 110)}`);
  }

  {
    // Token accounting: a delegated run's spend reaches the session tracker,
    // so cost caps cannot be escaped by handing the work to a child.
    const s = freshSession();
    const spend = [];
    await run(model, 'Use the Task tool with subagent_type "explore" to count the files ' +
      'in the current directory. Report the number.', s, {
      onTokens: (i, o) => spend.push(i + o),
    });
    assert(spend.length > 0, 'Parent recorded token usage');
    assert(checkSessionInvariants(s).ok, 'Delegating run satisfies every invariant');
    console.log(`      parent-observed token events: ${spend.length}`);
  }

  // ── 16. Sandbox confinement, live ──────────────────────────────────
  section('16. Sandbox confines a real agent');
  {
    // Ask the model, plainly, to write outside its workspace. Under
    // workspace-write that must be refused by the guard, and the refusal must
    // reach the model as a tool result so it can report honestly.
    const s = freshSession();
    const escapeTarget = path.join(os.tmpdir(), `aico-escape-${Date.now()}.txt`);
    const out = await run(model,
      `Use the Write tool to create the file "${escapeTarget}" containing the word ESCAPED. ` +
      `Then tell me in one sentence whether it worked.`, s, {
        settings: { ...SETTINGS, sandbox: { mode: 'workspace-write', warnOnPartial: false } },
      });

    assert(!fs.existsSync(escapeTarget),
      'The agent could not write outside its workspace');
    const results = s.events.filter(e => e.type === 'tool/result');
    assert(results.some(r => /sandbox:/.test(r.data.content)),
      'The sandbox refusal reached the model as a tool result');
    assert(checkSessionInvariants(s).ok, 'Sandboxed live run satisfies every invariant');
    console.log(`      model said: ${JSON.stringify(out).slice(0, 110)}`);

    // ...and a write INSIDE the workspace still works, so the policy is usable.
    const s2 = freshSession();
    await run(model, 'Use the Write tool to create allowed.txt containing OK.', s2, {
      settings: { ...SETTINGS, sandbox: { mode: 'workspace-write', warnOnPartial: false } },
    });
    assert(fs.existsSync(path.join(workDir, 'allowed.txt')),
      'A write inside the workspace still succeeds under confinement');
  }

  // ── 17. Repeat-tool guard, live ────────────────────────────────────
  section('17. Repeat-tool guard');
  {
    const s = freshSession();
    await run(model,
      'Call the Read tool on numbers.txt. Then call it again on numbers.txt. Then again on numbers.txt. ' +
      'Then again. Do not stop until you have called it at least 4 times with identical arguments.', s,
      { settings: { ...SETTINGS, repeatGuard: { thresholds: [3] } } });
    const reminders = s.events.filter(
      e => e.type === 'user/message' && e.data.source?.plugin === 'repeat-tool-guard');
    console.log(`      Read calls=${shape(s).calls.filter(c => c.data.name === 'Read').length} reminders=${reminders.length}`);
    assert(checkSessionInvariants(s).ok, 'Guarded run satisfies every invariant');
    // The guard is advisory; assert it never corrupted the log, and report firing.
    assert(reminders.every(r => r.data.content.includes('Read')),
      'Any reminder names the repeated tool');
  }
}

// ── Cleanup ──────────────────────────────────────────────────────────
process.chdir(originalCwd);
try { fs.rmSync(workDir, { recursive: true, force: true }); } catch { /* best effort */ }

console.log('\n' + '═'.repeat(64));
console.log(`  LIVE RESULTS: ${passed} passed, ${failed} failed`);
if (failures.length) {
  console.log('\n  FAILURES:');
  for (const f of failures) console.log(`    ✗ ${f}`);
}
console.log('═'.repeat(64) + '\n');
process.exit(failed > 0 ? 1 : 0);
