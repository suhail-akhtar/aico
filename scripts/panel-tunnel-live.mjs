/**
 * The VS Code panel's transport, against a real server.
 *
 * The panel does not talk to aico. It posts messages to the extension host,
 * which talks to aico and posts the answers back — and the client code on the
 * panel side is the browser client, unchanged, reassembling those messages into
 * `Response` objects it believes came off a socket.
 *
 * Everything risky about that is invisible to a typechecker:
 *
 * - a streamed reply is taken apart into frames and put back together as a
 *   `ReadableStream`, and `streamSession` reads it with a byte reader;
 * - a multi-byte character can land across two frames;
 * - a 401 has to survive the round trip as a 401, or the client never learns
 *   that the token it is not even holding has gone stale;
 * - an abort has to arrive named `AbortError`, or every session switch triggers
 *   a reconnect to the session just left.
 *
 * So this runs a real `aico serve`, wires the two halves together in one
 * process, and drives the actual client through them.
 *
 * Run: node scripts/panel-tunnel-live.mjs
 * Needs: the entry bundled to dist-test/panel-tunnel.mjs — `npm run test:panel`
 *        does both.
 */

import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { fileURLToPath } from 'url';

import {
  wire, api, streamSession, supportsSecondarySidebar, sameFolder,
  buildContextBlock, chipKey, EMPTY, NO_ATTACHMENTS, changedSpan,
} from '../dist-test/panel-tunnel.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');

let passed = 0, failed = 0;
const fails = [];
function check(cond, label) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; fails.push(label); console.log(`  ✗ ${label}`); }
}

async function until(fn, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await new Promise(r => setTimeout(r, 100));
  }
  return false;
}

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'aico-panel-live-'));
fs.writeFileSync(path.join(workspace, 'README.md'), '# probe workspace\n');

let child;
let wiring;

try {
  console.log('\nPANEL TUNNEL — against a real server\n');

  /*
    ── which side bar the panel claims ───────────────────────────────────

    Checked first because it costs nothing and because getting it wrong does
    not break our panel, it displaces *other* extensions' views. The rule is
    1.106 and later.
  */
  check(supportsSecondarySidebar('1.135.0') === true, 'a current VS Code gets the Secondary Side Bar');
  check(supportsSecondarySidebar('1.106.0') === true, '1.106 is the first that does');
  check(supportsSecondarySidebar('1.105.2') === false, '1.105 does not, and must not declare it');
  check(supportsSecondarySidebar('1.94.0') === false, 'an old but supported VS Code falls back');
  check(supportsSecondarySidebar('2.0.0') === true, 'a future major is not treated as ancient');
  check(
    supportsSecondarySidebar('1.136.0-insider') === true,
    'an insider build parses rather than falling back',
  );
  check(
    supportsSecondarySidebar('unknown') === true,
    'an unparseable version assumes current — a fork is not an old build',
  );

  /*
    ── which folder is which ─────────────────────────────────────────────

    A real bug, found by a person using the panel rather than by any of this.
    VS Code reports Windows paths with a lowercase drive letter; everything
    else on Windows uses an uppercase one. aico's project registry compares
    paths as strings, so the same directory became two projects — a duplicate
    row, and a session list that hid every conversation started in a terminal.

    It was visible in a running server's project list: `E:\\github_repos\\...`
    from a shell sitting directly above `e:\\tmp\\vsdiag3\\ws` from the editor.
  */
  check(sameFolder('e:\\tmp\\ws', 'E:\\tmp\\ws'), 'a lowercase drive letter is the same folder');
  check(sameFolder('E:\\work', 'E:\\work\\'), 'a trailing separator is the same folder');
  check(sameFolder('E:/work', 'E:\\work'), 'mixed separators are the same folder');
  check(!sameFolder('E:\\work', 'E:\\other'), 'different folders stay different');
  check(
    !sameFolder('/home/me/Work', '/home/me/work'),
    'POSIX stays case-sensitive — folding those together would be the worse bug',
  );
  check(sameFolder('/home/me/work', '/home/me/work/'), 'POSIX ignores a trailing separator');
  check(!sameFolder(undefined, 'E:\\work'), 'a missing path matches nothing');

  /*
    ── the span an edit replaces ─────────────────────────────────────────

    The arithmetic behind applying a write as a `WorkspaceEdit` rather than a
    disk write. Getting it wrong does not fail loudly — it produces a range that
    ends before it starts, or one that quietly replaces more than it should, in
    the middle of editing somebody's file.

    Every case is checked two ways: the span is well-formed, and applying it to
    `before` actually produces `after`. The second is the one that matters; the
    first is what makes a failure readable.
  */
  const spanCases = [
    ['identical', 'same', 'same'],
    ['a change in the middle', 'const a = 1;\nconst b = 2;\n', 'const a = 9;\nconst b = 2;\n'],
    ['an insertion at the end', 'line one\n', 'line one\nline two\n'],
    ['an insertion at the start', 'b\n', 'a\nb\n'],
    ['a deletion', 'a\nb\nc\n', 'a\nc\n'],
    ['from empty', '', 'new content\n'],
    ['to empty', 'old content\n', ''],
    // The overlap case: an unguarded suffix scan claims characters the prefix
    // already claimed, and the range inverts.
    ['a repeated character grown', 'aa', 'aaa'],
    ['a repeated character shrunk', 'aaa', 'aa'],
    ['all repeats', 'aaaa', 'aa'],
    ['a whole-file rewrite', 'nothing in common\n', 'entirely different\n'],
    ['a multi-byte character', 'héllo wörld', 'héllo wide wörld'],
  ];

  let spanFailures = 0;
  for (const [name, before, after] of spanCases) {
    const span = changedSpan(before, after);
    const wellFormed = span.start >= 0 && span.end >= span.start && span.end <= before.length;
    const rebuilt = before.slice(0, span.start) + span.text + before.slice(span.end);
    if (!wellFormed || rebuilt !== after) {
      spanFailures += 1;
      check(false, `${name}: span ${JSON.stringify(span)} rebuilds to ${JSON.stringify(rebuilt)}`);
    }
  }
  check(spanFailures === 0, `every edit span is well-formed and rebuilds exactly (${spanCases.length} cases)`);

  check(
    changedSpan('const a = 1;\nconst b = 2;\n', 'const a = 9;\nconst b = 2;\n').text === '9',
    'a one-character change is a one-character edit, not a whole-file replacement',
  );

  /*
    ── what the editor context actually sends ────────────────────────────

    This is the part of Phase 2 with teeth. The chips are a claim about what
    will be attached, and this function is what makes the claim true — a
    disagreement between the two is not a cosmetic bug, it is the panel lying
    about what it sent.

    The governing rule under test: inline what nothing else can recover (a
    selection, a language server's diagnostics) and merely *name* what aico can
    fetch for itself (files). Getting it backwards is how an editor integration
    sends fifteen thousand tokens of open tabs with every "hello".
  */
  const file = { path: 'src/api.ts', uri: 'file:///w/src/api.ts', language: 'typescript' };
  const withSelection = {
    ...EMPTY,
    active: file,
    selection: {
      ...file, fromLine: 12, toLine: 14, text: 'const x = 1;', truncated: false,
    },
  };

  const selBlock = buildContextBlock(withSelection, NO_ATTACHMENTS);
  check(
    selBlock.includes('lines 12-14') && selBlock.includes('const x = 1;')
      && selBlock.includes('```typescript'),
    'a selection is inlined, fenced, with its language and line range',
  );
  check(
    !selBlock.includes('Open in the editor'),
    'the active file is not named twice when the selection is already in it',
  );

  check(
    buildContextBlock({ ...EMPTY, active: file }, NO_ATTACHMENTS)
      === 'Open in the editor: `src/api.ts`',
    'an open file with no selection is named, never pasted',
  );

  const dismissed = {
    ...NO_ATTACHMENTS,
    dismissed: new Set([chipKey('sel', file.uri, '12-14'), chipKey('file', file.uri)]),
  };
  check(
    buildContextBlock(withSelection, dismissed) === '',
    'dismissing every chip sends nothing — a removed chip is a decision, not a hint',
  );

  const truncated = {
    ...withSelection,
    selection: { ...withSelection.selection, truncated: true },
  };
  check(
    /read the file for the rest/i.test(buildContextBlock(truncated, NO_ATTACHMENTS)),
    'a cut-short selection says so, rather than letting the model reason about an ending it never saw',
  );

  const withProblems = {
    ...EMPTY,
    active: file,
    problemTotal: 3,
    problems: [
      { path: file.path, uri: file.uri, line: 4, severity: 'error', message: 'Cannot find name x', source: 'ts' },
      { path: file.path, uri: file.uri, line: 9, severity: 'warning', message: 'Unused', source: 'ts' },
    ],
  };
  check(
    !buildContextBlock(withProblems, NO_ATTACHMENTS).includes('Cannot find name x'),
    'Problems stay out until asked for — a half-typed file has an opinionated language server',
  );
  const attachedProblems = buildContextBlock(
    withProblems, { ...NO_ATTACHMENTS, problems: true },
  );
  check(
    attachedProblems.includes('error at line 4 [ts]: Cannot find name x'),
    'attached Problems are inlined with severity, line and source',
  );
  check(
    attachedProblems.includes('and 1 more'),
    'a truncated Problems list reports how many were left out',
  );

  check(
    buildContextBlock(EMPTY, NO_ATTACHMENTS) === '',
    'no context produces no block, not an empty heading',
  );

  const pinned = buildContextBlock(EMPTY, {
    ...NO_ATTACHMENTS,
    pinned: [{ path: 'src/server/runs.ts', uri: 'file:///w/src/server/runs.ts', line: 88, symbol: 'answer' }],
  });
  check(
    pinned.includes('`src/server/runs.ts`:88 — `answer`'),
    'a symbol pinned with # is named with its file and line, not pasted',
  );

  // ── start the server the extension would start ──────────────────────
  const server = await new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [
      path.join(repoRoot, 'dist', 'index.js'),
      'serve', '--no-open', '--project', workspace,
    ], { cwd: workspace, env: { ...process.env, FORCE_COLOR: '0' } });
    child = proc;

    const timer = setTimeout(() => reject(new Error('serve never printed a URL')), 90_000);
    let output = '';
    const read = (chunk) => {
      output += chunk.toString();
      const match = /http:\/\/127\.0\.0\.1:(\d+)\/\?token=([A-Za-z0-9_-]+)/.exec(output);
      if (match) {
        clearTimeout(timer);
        resolve({ port: Number(match[1]), token: match[2] });
      }
    };
    proc.stdout?.on('data', read);
    proc.stderr?.on('data', read);
    proc.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`serve exited early (${code}):\n${output.slice(-800)}`));
    });
  });

  check(true, `server up on port ${server.port}`);

  wiring = wire(server.port, server.token);

  // ── a plain JSON request ────────────────────────────────────────────
  const listing = await api.sessions();
  check(Array.isArray(listing.sessions), 'a JSON request round-trips through postMessage');
  check(Array.isArray(listing.projects), 'the response body is parsed, not a string');

  /*
    The token is the property worth asserting, not an implementation detail.
    The panel never receives it; if the host were not attaching it, this call
    would have come back 401 and `api.sessions()` would have thrown.
  */
  check(
    !JSON.stringify(wiring.frames).includes(server.token),
    'the token never appears in a frame sent to the panel',
  );

  // ── a streamed response ─────────────────────────────────────────────
  const sessionId = `panel-probe-${Date.now().toString(36)}`;
  const events = [];
  let status = 'none';

  const handle = streamSession(
    sessionId,
    (event) => events.push(event),
    (s) => { status = s; },
    0,
    workspace,
  );

  check(await until(() => status === 'live'), 'the SSE stream reaches "live" through the tunnel');

  const headFrames = wiring.frames.filter(f => f.t === 'http:head');
  check(
    headFrames.some(f => f.streaming === true),
    'the host recognises text/event-stream and announces it as streaming',
  );

  // ── a real turn, so there is something to stream ────────────────────
  await api.submit({
    sessionId,
    task: 'Reply with exactly the word: pong. Do not use any tools.',
    project: workspace,
  }).catch(err => {
    // A missing provider key is an environment problem, not a tunnel failure.
    console.log(`  … submit refused (${err.message}); streaming assertions limited`);
  });

  const sawEvents = await until(() => events.length > 0, 30_000);
  check(sawEvents, 'events arrive on the panel side of the tunnel');

  if (sawEvents) {
    check(
      events.every(e => typeof e === 'object' && typeof e.type === 'string'),
      'every frame reassembles into a parsed event, not a partial string',
    );
    const logged = events.filter(e => typeof e.seq === 'number');
    check(
      logged.length === 0 || logged.every((e, i, all) => i === 0 || e.seq >= all[i - 1].seq),
      'sequence numbers arrive in order, so resume has a valid point to resume from',
    );
  }

  /*
    ── a tool call that has to be allowed ────────────────────────────────

    The part of Phase 3 that cannot be checked any other way. A permission
    prompt is a *blocked turn*: the engine is holding a promise, the server is
    holding the resolver, and the client has to name the right call to release
    it. Every step of that is invisible to types.

    The trap this guards is specific and was live in the code before this
    feature: with `autoApprove: false` and no callback registered, the engine
    falls through to `checkPermission`, which reads stdin — in a server, a turn
    blocked for ever on input nobody can see.
  */
  const askSession = `perm-probe-${Date.now().toString(36)}`;
  const asked = [];
  const askStream = streamSession(
    askSession,
    (event) => { if (event.type === 'permission') asked.push(event.data); },
    undefined,
    0,
    workspace,
  );

  await api.submit({
    sessionId: askSession,
    task: 'Create a file called probe.txt containing the word ping. Use the Write tool.',
    project: workspace,
    approval: 'ask',
  }).catch(err => {
    console.log(`  … submit refused (${err.message}); approval assertions skipped`);
  });

  const prompted = await until(() => asked.some(a => a?.id), 60_000);
  check(prompted, 'a run submitted with approval:ask blocks and asks rather than hanging');

  if (prompted) {
    const request = asked.find(a => a?.id);
    check(
      typeof request.tool === 'string' && request.tool.length > 0,
      `the prompt names the tool it is about (${request.tool})`,
    );

    // A decision that names the wrong call must not release the right one.
    const wrong = await api.permit(askSession, 'not-the-id', true);
    check(wrong.ok === false, 'a decision for a different call id is refused');

    const stillWaiting = await until(() => asked.some(a => a?.id), 2_000);
    check(stillWaiting, 'and the run is still waiting after that refusal');

    const denied = await api.permit(askSession, request.id, false);
    check(denied.ok === true, 'denying the right call is accepted');

    const cleared = await until(
      () => asked.some(a => a && !a.id), 20_000,
    );
    check(cleared, 'the prompt clears once decided, so nothing stale stays on screen');

    /*
      Denial has to be a *tool failure the model can act on*, not a silent
      success. The file must not exist.
    */
    await until(async () => {
      try { return !(await api.session(askSession)).busy; } catch { return false; }
    }, 60_000);
    check(
      !fs.existsSync(path.join(workspace, 'probe.txt')),
      'a denied Write does not write the file',
    );
  }
  askStream.close();

  /*
    ── "ask, not for edits" has to actually let edits through ────────────

    The mode exists so that the common, expected action — writing a file in a
    project you opened — does not generate a dialog, while the genuinely
    different risk still does. If it prompted for a Write it would be `ask`
    wearing a different label, and people would turn it off.
  */
  const editsSession = `perm-edits-${Date.now().toString(36)}`;
  const editPrompts = [];
  const editStream = streamSession(
    editsSession,
    (event) => {
      if (event.type !== 'permission' || !event.data?.id) return;
      editPrompts.push(event.data);
      /*
        Allowed, so the run finishes either way.

        The first version of this asserted "no prompts at all" and failed the
        moment the model reached for `Terminal` instead of `Write` — which is
        correct behaviour being reported as a bug, and would have left the run
        blocked on a dialog nothing was going to answer. What matters is not
        that nothing was asked; it is that *edit tools* were not asked about.
      */
      void api.permit(editsSession, event.data.id, true);
    },
    undefined,
    0,
    workspace,
  );

  await api.submit({
    sessionId: editsSession,
    task: 'Create a file called allowed.txt containing the word ok. Use the Write tool.',
    project: workspace,
    approval: 'edits',
  }).catch(() => { /* reported above if the provider is unavailable */ });

  const wroteIt = await until(
    () => fs.existsSync(path.join(workspace, 'allowed.txt')), 90_000,
  );
  check(wroteIt, 'approval:edits gets the file written');

  const EDIT_TOOLS = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'];
  const promptedEdits = editPrompts.filter(p => EDIT_TOOLS.includes(p.tool));
  check(
    promptedEdits.length === 0,
    `and never asks about an edit tool (${editPrompts.length} prompt(s) seen`
    + `${editPrompts.length ? `, for ${[...new Set(editPrompts.map(p => p.tool))].join(', ')}` : ''})`,
  );
  editStream.close();

  /*
    ── writes handed to the client ───────────────────────────────────────

    The engine no longer assumes it writes to disk: a run can carry a writer,
    and the VS Code panel supplies one that applies a `WorkspaceEdit` so the
    change enters the editor's undo stack instead of arriving as an external
    change nobody asked for.

    What is checked here is the contract, not the editor: the run hands over the
    write and *waits*, an outcome releases it, and a refusal becomes a real tool
    failure with no file on disk. The `WorkspaceEdit` half is checked in the
    editor, where it can be.
  */
  const editSession = `edit-probe-${Date.now().toString(36)}`;
  const handed = [];
  const handedStream = streamSession(
    editSession,
    (event) => { if (event.type === 'edit' && event.data?.id) handed.push(event.data); },
    undefined,
    0,
    workspace,
  );

  await api.submit({
    sessionId: editSession,
    task: 'Create a file called handed.txt containing the word one. Use the Write tool.',
    project: workspace,
    applyEdits: true,
  }).catch(() => { /* reported earlier if the provider is unavailable */ });

  const gotEdit = await until(() => handed.length > 0, 90_000);
  check(gotEdit, 'a run with applyEdits hands the write to the client instead of writing it');

  if (gotEdit) {
    const request = handed[0];
    check(
      typeof request.path === 'string' && request.path.endsWith('handed.txt'),
      `the request names the file (${request.path?.split(/[\\/]/).pop()})`,
    );
    check(
      typeof request.after === 'string' && request.after.includes('one'),
      'and carries the intended contents',
    );
    check(
      !('before' in request),
      'but not the previous contents — the client has the file already',
    );
    check(
      !fs.existsSync(path.join(workspace, 'handed.txt')),
      'nothing was written while the client had not answered',
    );

    const wrongId = await api.edited(editSession, 'not-the-id', true);
    check(wrongId.ok === false, 'an outcome for a different write is refused');

    // Refuse it, as a reviewer pressing Undo would.
    const reported = await api.edited(editSession, request.id, false, 'refused by the probe');
    check(reported.ok === true, 'reporting a refusal is accepted');

    await until(async () => {
      try { return !(await api.session(editSession)).busy; } catch { return false; }
    }, 120_000);

    /*
      The refusal has to reach the *model*, and that is what is asserted.

      An earlier version checked that the file did not exist afterwards and
      failed intermittently — because a capable agent told "the write was not
      applied" does the sensible thing and tries another route, which is the
      behaviour this feature is for. Absence of the file was never the contract;
      the contract is that the tool call failed and said why.
    */
    const transcript = JSON.stringify(await api.session(editSession).catch(() => ({})));
    check(
      /was not applied/i.test(transcript),
      'the refusal reaches the model as a failed tool call, with the reason',
    );
    check(
      transcript.includes('refused by the probe'),
      'and carries the reason the client gave, not a generic error',
    );
  }
  handedStream.close();

  // ── closing a stream must not look like a failure ───────────────────
  const before = wiring.frames.length;
  handle.close();
  await new Promise(r => setTimeout(r, 400));
  const afterClose = wiring.frames.slice(before);
  check(
    !afterClose.some(f => f.t === 'http:error'),
    'closing a stream reports no error — an AbortError is a choice, not a fault',
  );

  /*
    ── a 401 has to survive as a 401 ─────────────────────────────────────

    The good wiring is torn down *first*, and that ordering is the whole
    correctness of this check. Both wirings drain the same outbound queue, so
    leaving the first pump running meant the good-token tunnel answered the
    bad-token request and the assertion passed for the wrong reason — which is
    exactly what happened the first time this ran, and is why the check reports
    the status it saw rather than a bare pass or fail.
  */
  wiring.stop();
  const wrong = wire(server.port, 'not-the-token');
  let rejectedStatus = 0;
  try {
    await api.sessions();
  } catch (err) {
    rejectedStatus = err?.status ?? 0;
  }
  wrong.stop();
  check(
    rejectedStatus === 401,
    `a bad token surfaces as 401 on the panel side (got ${rejectedStatus || 'no error'})`,
  );

  wiring = wire(server.port, server.token);
  check(Array.isArray((await api.sessions()).sessions), 'the transport recovers after a bad token');
} catch (err) {
  failed += 1;
  fails.push(`threw: ${err?.stack ?? err}`);
  console.log(`\n  ✗ ${err?.stack ?? err}`);
} finally {
  wiring?.stop();
  if (child?.pid) {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
        .on('error', () => { /* already gone */ });
    } else {
      try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* gone */ } }
    }
  }
  try { fs.rmSync(workspace, { recursive: true, force: true }); } catch { /* windows holds handles */ }
}

console.log(`\nPANEL TUNNEL: ${passed} passed, ${failed} failed`);
if (fails.length) {
  console.log('\nFailures:');
  for (const f of fails) console.log(`  - ${f}`);
}
process.exit(failed > 0 ? 1 : 0);
