/**
 * Recall (src/recall, ADR 0018), offline: the index, the hybrid search, the
 * episodes, the memory write hygiene, the ranked injection, the tool, upkeep
 * and the embeddings wire shapes — with a stub embedder and a loopback HTTP
 * stub standing in for any model, so every path is deterministic and free.
 *
 * What each block proves:
 *   - the index builds from memory files, knowledge files and session logs,
 *     syncs incrementally, and rebuilds itself from a corrupt file;
 *   - no user text can break FTS5's MATCH (quotes, operators, column filters);
 *   - words and meaning are fused by rank (RRF), episodes decay with age,
 *     scope is a filter (another project's memory never appears);
 *   - remembering the same thing twice updates one entry; the same subject
 *     with a new value supersedes the old one (kept on disk, restorable);
 *   - at or below 30 memories the cached prefix is exactly what it was; above,
 *     pinned and global ones stay and the rest are recalled per turn into the
 *     tail (checked through runAgent with a mock provider);
 *   - the Recall tool's output, the deferred group and its request rule;
 *   - upkeep marks duplicates and archives old episodes but never deletes a
 *     memory or archives one;
 *   - with the embed role off (the default) everything is words-only, and a
 *     local-only setting refuses a cloud embedder;
 *   - a small benchmark: hit@3 words-only vs with stub embeddings.
 *
 * Offline and free; nothing touches ~/.aico.
 */

// A store of this process's own — nothing below may touch ~/.aico. Must stay first.
import './lib/test-home.mjs';
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';

const T = await import('../dist-test/test-exports.js');

let passed = 0;
let failed = 0;
const failures = [];
function assert(cond, name) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; failures.push(name); console.log(`  ✗ ${name}`); }
}
async function block(title, fn) {
  console.log(`\n══ ${title} ══`);
  try { await fn(); } catch (err) { assert(false, `${title}: threw ${err?.stack ?? err}`); }
}

const HOME = process.env.AICO_HOME;
fs.writeFileSync(path.join(HOME, 'settings.json'), '{}');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aico recall '));   // a space on purpose
process.on('exit', () => { try { T.closeRecall(); fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } });
const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.now();

/** A fresh store: no memories, no logs, no index. */
function resetStore() {
  T.closeRecall();
  for (const d of ['recall', 'memories', 'projects', 'knowledge']) fs.rmSync(path.join(HOME, d), { recursive: true, force: true });
}
let projN = 0;
const project = () => { const d = path.join(tmp, `proj ${++projN}`); fs.mkdirSync(d, { recursive: true }); return d; };

/** A session event log as the engine writes it. */
function writeLog(id, cwd, { title, requests = [], outcome = '', files = [], tools = [], at = NOW, open = false, extra = [] }) {
  const dir = T.getSessionDir(cwd);
  fs.mkdirSync(dir, { recursive: true });
  let seq = 0;
  const ev = (type, data, ts = at) => JSON.stringify({ seq: ++seq, type, timestamp: ts, data });
  const lines = [JSON.stringify({ type: '__header__', version: 1, id, cwd, startedAt: at - 60_000 })];
  requests.forEach((r, i) => {
    lines.push(ev('turn/start', { turn: i + 1 }));
    lines.push(ev('user/message', { turn: i + 1, content: r, source: { kind: 'human' } }));
    if (i === 0) for (const e of extra) lines.push(ev(e.type, e.data));
    for (const f of (i === 0 ? files : [])) lines.push(ev('tool/call', { turn: 1, step: 1, callId: `c${seq}`, name: 'Edit', arguments: JSON.stringify({ file_path: path.join(cwd, f), old_string: 'a', new_string: 'b' }) }));
    for (const t of (i === 0 ? tools : [])) lines.push(ev('tool/call', { turn: 1, step: 1, callId: `t${seq}`, name: t, arguments: '{}' }));
    if (!open || i < requests.length - 1) {
      lines.push(ev('assistant/message', { turn: i + 1, step: 1, content: i === requests.length - 1 ? outcome : 'working on it' }));
      lines.push(ev('turn/end', { turn: i + 1, reason: { kind: 'completed' } }));
    }
  });
  if (title) lines.push(ev('session/title', { title, source: 'model' }));
  fs.writeFileSync(path.join(dir, `${id}.events.jsonl`), lines.join('\n') + '\n');
}

/**
 * A stub embedder that knows a few concepts and their synonyms (with a
 * four-letter prefix match standing in for a real model's sub-word
 * robustness), plus a hashed bag of words. It shows what the fusion does with
 * a vector signal; it is not a measurement of any real embedding model.
 */
const CONCEPTS = [
  ['bill', 'billing', 'invoice', 'invoices', 'charge', 'payment', 'stripe', 'customer', 'customers', 'receipt'],
  ['deploy', 'deployment', 'deployments', 'release', 'ship', 'rollout', 'friday', 'fridays'],
  ['postgres', 'database', 'sql', 'migration', 'migrations', 'schema'],
  ['review', 'reviews', 'reviewer', 'merge', 'pull', 'request', 'requests', 'approve'],
  ['speed', 'slow', 'fast', 'faster', 'performance', 'caching', 'cache', 'time', 'minutes'],
  ['secret', 'secrets', 'key', 'keys', 'credential', 'vault', 'token', 'rotate', 'rotated'],
  ['theme', 'dark', 'colour', 'colours', 'color', 'colors', 'tokens.css'],
  ['test', 'tests', 'flaky', 'e2e', 'retry'],
];
function stubVector(text) {
  const v = new Float32Array(CONCEPTS.length + 32);
  for (const w of (text.toLowerCase().match(/[\p{L}\p{N}.]+/gu) ?? [])) {
    CONCEPTS.forEach((c, i) => { if (c.includes(w) || (w.length >= 5 && c.some(x => x.length >= 5 && x.slice(0, 4) === w.slice(0, 4)))) v[i] += 1; });
    let h = 0; for (const ch of w) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    v[CONCEPTS.length + (h % 32)] += 0.15;
  }
  return v;
}
const stub = { model: 'stub-embed', calls: 0, async embed(texts) { this.calls++; return texts.map(stubVector); } };

// ═══════════════════════════════════════════════════════════════════════
await block('Index: built from files and logs, incremental, rebuilt when corrupt', async () => {
  resetStore();
  const dir = project();
  T.remember('Use pnpm for installs in this repo', 'project', { belongsTo: dir });
  T.remember('I prefer tabs over spaces', 'global');
  fs.mkdirSync(path.join(dir, '.aico', 'knowledge'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.aico', 'knowledge', 'sql.md'), `---\ntrigger: writing database queries\nscope: ${dir}\n---\nAlways use parameterised queries.\n`);
  writeLog('s-one', dir, { title: 'Fix Postgres migration ordering', requests: ['the migrations run out of order on postgres'], outcome: 'Sorted migrations by timestamp prefix.', files: ['db/migrate.ts'], tools: ['Edit', 'Bash'], at: NOW - DAY });
  const first = T.syncAll({ projectRoots: [dir] });
  const counts = T.countItems();
  assert(counts.memory === 2 && counts.knowledge === 1 && counts.episode === 1, `memories, knowledge and episodes indexed (${JSON.stringify(counts)})`);
  assert(first.memories === 2 && first.episodes === 1, 'the first sync writes every row');
  const again = T.syncAll({ projectRoots: [dir] });
  assert(again.memories === 0 && again.knowledge === 0 && again.episodes === 0, 'a second sync with nothing changed writes nothing (incremental by signature)');
  fs.rmSync(path.join(dir, '.aico', 'knowledge', 'sql.md'));
  T.syncAll({ projectRoots: [dir] });
  assert(T.countItems().knowledge === 0, 'a deleted source file drops its row');
  assert(fs.existsSync(T.recallDbPath()) && T.recallDbPath().startsWith(HOME), 'the database lives under aicoHome()/recall');

  // Corrupt the file: the next open moves it aside and starts again.
  T.closeRecall();
  for (const s of ['-wal', '-shm']) fs.rmSync(T.recallDbPath() + s, { force: true });
  fs.writeFileSync(T.recallDbPath(), 'this is not a sqlite database at all, just garbage bytes'.repeat(200));
  T.recallDb();
  assert(fs.existsSync(`${T.recallDbPath()}.corrupt`), 'a corrupt index is moved aside, not deleted');
  assert(T.countItems().memory === 0, 'and the new one starts empty');
  T.syncAll({ projectRoots: [dir] });
  assert(T.countItems().memory === 2 && T.countItems().episode === 1, 'one sync rebuilds it from the files and logs');
  const rebuilt = T.rebuildRecall({ projectRoots: [dir] });
  assert(rebuilt.counts.memory === 2 && rebuilt.counts.episode === 1, `rebuildRecall gives the same counts (${JSON.stringify(rebuilt.counts)})`);
});

await block('FTS5: no user text can break MATCH', async () => {
  const dir = project();
  assert(T.ftsQuery('title:secret') === '"title" OR "secret" OR "secr"*', `a column filter becomes plain quoted words (${T.ftsQuery('title:secret')})`);
  assert(T.ftsQuery('the and or') === '', 'only stopwords: no query at all');
  assert(T.ftsQuery('postgress') === '"postgress" OR "postgre"*', `a long word also matches by prefix, forgiving a typo in its ending (${T.ftsQuery('postgress')})`);
  const nasty = ['"', '""', '"unbalanced', 'AND', 'OR NOT', 'NEAR(a b)', '*', '^start', 'col:', '(((', ')',
    "'; DROP TABLE items; --", 'C++?', 'a-b-c', '{x}', 'tabs " OR 1=1', '\u0000\u0001', '🙂 emoji', 'naïve café', 'x'.repeat(5000), '- * ^ : ( )'];
  let threw = 0;
  for (const q of nasty) {
    try { await T.searchRecall({ query: q, cwd: dir }); } catch (err) { threw++; console.log(`    threw on ${JSON.stringify(q.slice(0, 20))}: ${err.message}`); }
  }
  assert(threw === 0, `${nasty.length} hostile queries, none throws`);
  assert(T.countItems().memory >= 0 && T.listItems().length >= 0, 'and the items table is still there');
  const hit = await T.searchRecall({ query: 'tabs " OR 1=1', cwd: dir });
  assert(hit.hits.some(h => /tabs over spaces/.test(h.item.text)), 'a quote in the query does not stop the real words from matching');
});

await block('Scope is a filter: another project, another chat, a silenced memory', async () => {
  resetStore();
  const a = project(); const b = project();
  T.remember('Billing webhooks verify the Stripe signature', 'project', { belongsTo: a });
  T.remember('Billing is handled by Paddle here', 'project', { belongsTo: b });
  T.remember('Billing chat detail for one conversation', 'session', { belongsTo: 'chat-1' });
  T.syncAll();
  const inA = await T.searchRecall({ query: 'billing', cwd: a, kinds: ['memory'] });
  assert(inA.hits.length === 1 && /Stripe/.test(inA.hits[0].item.text), 'project A sees its own memory only');
  const inChat = await T.searchRecall({ query: 'billing', cwd: a, sessionId: 'chat-1', kinds: ['memory'] });
  assert(inChat.hits.some(h => /one conversation/.test(h.item.text)), 'a session memory shows in its own chat');
  assert(!(await T.searchRecall({ query: 'billing', cwd: a, sessionId: 'chat-2', kinds: ['memory'] })).hits.some(h => /one conversation/.test(h.item.text)), '…and not in another');
  const m = T.listScope('project', a)[0];
  T.setMemoryEnabled(m, false);
  assert((await T.searchRecall({ query: 'billing', cwd: a, kinds: ['memory'] })).hits.length === 0, 'a silenced memory is not recalled');
  T.setMemoryEnabled(m, true);
});

await block('Hybrid: words and meaning fused by rank; recency decays episodes only', async () => {
  resetStore();
  const dir = project();
  T.remember('Invoices are generated by Stripe at month end', 'project', { belongsTo: dir });
  T.remember('The month end report is emailed to finance', 'project', { belongsTo: dir });
  T.remember('Lint runs before every commit', 'project', { belongsTo: dir });
  T.syncAll();
  const words = await T.searchRecall({ query: 'how do we bill customers', cwd: dir });
  assert(words.mode === 'words' && words.hits.length === 0, 'words-only: a paraphrase that shares no words finds nothing (honestly)');
  const e = await T.embedPending(stub, { budgetMs: 5000 });
  assert(e.embedded === 3 && !e.error, `pending rows embedded (${e.embedded})`);
  const both = await T.searchRecall({ query: 'how do we bill customers', cwd: dir, embedder: stub });
  assert(both.mode === 'hybrid' && /Stripe/.test(both.hits[0]?.item.text ?? ''), 'with meaning, the paraphrase finds the Stripe memory');
  assert(both.hits[0]?.semantic > 0.35 && both.hits[0]?.lexicalRank === undefined, 'found by the meaning list alone');
  const fused = await T.searchRecall({ query: 'month end invoices', cwd: dir, embedder: stub });
  assert(/Stripe/.test(fused.hits[0]?.item.text ?? '') && fused.hits[0].lexicalRank && fused.hits[0].semantic !== undefined,
    'an item high in both lists ranks first (RRF)');
  assert(!fused.hits.some(h => /Lint/.test(h.item.text)), 'an unrelated memory is below the threshold and not returned');
  // A changed memory loses its stale vector.
  const inv = T.listScope('project', dir).find(x => /Stripe/.test(x.text));
  fs.writeFileSync(inv.file, fs.readFileSync(inv.file, 'utf8').replace('Stripe', 'Stripe Billing'));
  const t = new Date(Date.now() + 5000); fs.utimesSync(inv.file, t, t);
  T.syncAll();
  assert(T.listItems({ kind: 'memory' }).find(i => /Stripe Billing/.test(i.text)).embedModel === null, 'when the words change, the old vector is dropped');

  assert(Math.abs(T.recencyWeight('episode', 30) - 0.5) < 1e-9 && T.recencyWeight('episode', 0) === 1, 'episodes halve every 30 days');
  assert(T.recencyWeight('episode', 1000) === 0.1, 'and never fall below 0.1, so an old only-match still shows');
  assert(T.recencyWeight('memory', 1000) === 1 && T.recencyWeight('knowledge', 400) === 1, 'memories and knowledge do not decay');
  writeLog('old-ep', dir, { title: 'Rotate the signing keys', requests: ['rotate the signing keys'], outcome: 'Rotated signing keys.', at: NOW - 90 * DAY });
  writeLog('new-ep', dir, { title: 'Rotate the signing keys again', requests: ['rotate the signing keys'], outcome: 'Rotated signing keys again.', at: NOW - 2 * DAY });
  T.syncAll();
  const eps = await T.searchRecall({ query: 'rotate signing keys', cwd: dir, kinds: ['episode'] });
  assert(eps.hits[0]?.item.id === 'episode:new-ep' && eps.hits[1]?.item.id === 'episode:old-ep', 'the same match two days old outranks it ninety days old');
});

await block('Episodes: built from the log, no model', async () => {
  const dir = project();
  const lines = (open, at) => {
    const out = [JSON.stringify({ type: '__header__', version: 1, id: 'x', cwd: dir, startedAt: at })];
    let seq = 0; const ev = (type, data) => out.push(JSON.stringify({ seq: ++seq, type, timestamp: at, data }));
    ev('turn/start', { turn: 1 });
    ev('user/message', { turn: 1, content: 'Reminder from a guard', source: { kind: 'tool', tool: 'x' } });
    ev('user/message', { turn: 1, content: 'Add CSV export to the invoices page', source: { kind: 'human' } });
    ev('tool/call', { turn: 1, step: 1, callId: 'a', name: 'Write', arguments: JSON.stringify({ file_path: path.join(dir, 'src', 'export.ts') }) });
    ev('tool/call', { turn: 1, step: 1, callId: 'b', name: 'Bash', arguments: '{"command":"npm test"}' });
    ev('tool/call', { turn: 1, step: 1, callId: 'c', name: 'Edit', arguments: '{not json' });
    if (!open) {
      ev('assistant/message', { turn: 1, step: 2, content: 'Added CSV export; tests pass.' });
      ev('turn/end', { turn: 1, reason: { kind: 'completed' } });
    }
    ev('session/title', { title: 'Invoice CSV export', source: 'model' });
    return out.join('\n');
  };
  const ep = T.episodeFromLog(lines(false, NOW - DAY), { sessionId: 'x', now: NOW });
  assert(ep && ep.title === 'Invoice CSV export' && ep.request === 'Add CSV export to the invoices page', 'title and the human request (a guard reminder is not a request)');
  assert(ep.outcome === 'Added CSV export; tests pass.' && ep.files.join() === 'src/export.ts', `the outcome, and files relative to the project (${ep?.files})`);
  assert(ep.tools.includes('Write') && ep.tools.includes('Bash') && ep.tools.includes('Edit'), 'tools used, a mangled argument still counted by name');
  assert(ep.cwd === dir && ep.turns === 1, 'project and turn count');
  assert(T.episodeFromLog(lines(true, NOW - 60_000), { sessionId: 'x', now: NOW }) === undefined, 'a session mid-turn is not an episode yet');
  assert(T.episodeFromLog(lines(true, NOW - 2 * 60 * 60 * 1000), { sessionId: 'x', now: NOW }) !== undefined, 'one left mid-turn for hours is (it was abandoned)');
  assert(T.episodeFromLog('{"type":"__header__","id":"y"}\n', { sessionId: 'y' }) === undefined, 'a session nobody spoke in is not one');
  assert(T.episodeFromLog(`${lines(false, NOW - DAY)}\n{torn json`, { sessionId: 'x', now: NOW })?.title === 'Invoice CSV export', 'a torn last line costs nothing');
});

await block('Write hygiene: duplicates update, contradictions supersede, nothing is lost', async () => {
  resetStore();
  const dir = project();
  await T.runInContext({ cwd: dir, sessionId: 'hyg' }, async () => {
    const one = await T.executeMemoryManage({ action: 'remember', text: 'Always run the linter before committing changes' });
    const two = await T.executeMemoryManage({ action: 'remember', text: 'always run the linter before committing the changes.' });
    assert(/Remembered as "always-run-the-linter/.test(one), 'the first is remembered');
    assert(/Already remembered as "always-run-the-linter-before-committing"/.test(two), `the near-duplicate updates it (${two.slice(0, 90)})`);
    assert(T.listScope('project', dir).length === 1, 'one entry on disk, not "-2"');
    assert(T.listScope('project', dir)[0].text === 'always run the linter before committing the changes.', 'with the newer wording');
    const exact = T.remember('ALWAYS run the linter before committing the changes', 'project', { belongsTo: dir });
    assert(exact.outcome === 'merged', 'case and punctuation do not make a new memory');

    await T.executeMemoryManage({ action: 'remember', text: 'Package manager: pnpm' });
    const swap = await T.executeMemoryManage({ action: 'remember', text: 'Package manager: npm' });
    assert(/now marked superseded/.test(swap) && /package-manager-pnpm/.test(swap), `the contradiction is surfaced in the result (${swap.split('\n').pop().slice(0, 80)})`);
    const old = T.listScope('project', dir).find(m => m.id === 'package-manager-pnpm');
    assert(old && old.status === 'superseded' && old.supersededBy === 'package-manager-npm' && fs.existsSync(old.file), 'the old one is kept on disk, marked superseded by the new');
    assert(!T.activeMemories(dir).some(m => m.id === 'package-manager-pnpm'), 'and is withheld from the prompt');
    assert(/\[superseded by package-manager-npm\]/.test(await T.executeMemoryManage({ action: 'list' })), 'list shows why');
    const back = await T.executeMemoryManage({ action: 'enable', id: 'package-manager-pnpm' });
    assert(/current again/.test(back) && T.activeMemories(dir).some(m => m.id === 'package-manager-pnpm'), 'enable restores a superseded memory');

    const a = T.remember('The API server is slow', 'project', { belongsTo: dir });
    const b = T.remember('The API server is written in Go and deployed on Fly', 'project', { belongsTo: dir });
    assert(a.superseded.length === 0 && b.superseded.length === 0, 'two different facts about one thing are not read as a contradiction');
    const pin = await T.executeMemoryManage({ action: 'pin', id: a.id });
    assert(/is pinned/.test(pin) && T.listScope('project', dir).find(m => m.id === a.id).pinned === true, 'a memory can be pinned (frontmatter)');
    assert(/pinned: true/.test(fs.readFileSync(a.file, 'utf8')), 'and the flag is in its file');
  });
});

await block('Injection: ≤30 memories unchanged; above, ranked into the tail', async () => {
  resetStore();
  const dir = project();
  const few = ['Deploys happen on Fridays', 'Use pnpm for installs', 'The staging URL lives in .env.staging'].map(t => T.remember(t, 'project', { belongsTo: dir }));
  const small = T.activeMemories(dir);
  const split = T.splitMemories(small);
  assert(split.ranked.length === 0 && split.prefix.length === small.length && split.prefix.every((m, i) => m === small[i]), 'a small store: every memory in the prefix, same order, same objects');
  const blocks = (mems) => T.buildRuntimeBlocks({ tools: [], mcpServers: [], workspace: { root: '/w' }, agents: [], skills: [], cronJobs: [], backgroundAgents: [], subAgents: [],
    memories: mems.map(m => ({ id: m.id, scope: m.scope, text: m.text })) }).remembered;
  assert(blocks(split.prefix) === blocks(small), 'so the cached prefix text is byte-identical to before');
  assert(few.length === 3, 'three written');

  // Over the threshold: 34 project memories, 2 global, 1 pinned.
  const topics = ['Stripe invoices are reconciled nightly by the billing worker', 'Feature flags live in LaunchDarkly'];
  for (let i = 0; i < 32; i++) T.remember(`Service ${i} owns queue q${i} and logs to bucket b${i}`, 'project', { belongsTo: dir });
  for (const t of topics) T.remember(t, 'project', { belongsTo: dir });
  T.remember('I prefer concise answers', 'global');
  T.remember('Write commit messages in the imperative', 'global');
  const pinned = T.remember('Never push to main directly', 'project', { belongsTo: dir });
  T.setMemoryPinned(pinned, true);
  const big = T.activeMemories(dir);
  const s2 = T.splitMemories(big);
  assert(big.length > 30, `${big.length} memories`);
  assert(s2.prefix.length === 3 && s2.prefix.every(m => m.scope === 'global' || m.pinned), 'above 30: only global and pinned stay in the prefix');
  const tail = await T.recalledMemoryBlock(s2.ranked, 'The Stripe invoices did not reconcile last night, check the billing worker', { cwd: dir });
  assert(/Stripe invoices are reconciled nightly/.test(tail) && !/LaunchDarkly/.test(tail), 'the relevant memory is recalled, the unrelated ones are not');
  assert(Math.ceil(tail.length / 4) <= 600 + 60, `within about 600 tokens (${Math.ceil(tail.length / 4)})`);
  assert(await T.recalledMemoryBlock(s2.ranked, 'What is the capital of Peru?', { cwd: dir }) === '', 'an unrelated request recalls nothing at all');
  const used = T.listItems({ kind: 'memory' }).find(i => /reconciled nightly/.test(i.text));
  assert(used.uses === 1 && used.lastUsed > 0, 'a recalled memory has its use recorded');

  // Through the real loop with a mock model: where each memory lands.
  const seen = [];
  const provider = { id: 'mock', displayName: 'Mock', async *chat(opts) { seen.push({ system: opts.systemPrompt, tail: opts.volatileContext ?? '' }); yield { type: 'text', content: 'ok' }; yield { type: 'finish', reason: 'stop' }; } };
  const run = (id, task, cwd) => T.runAgent({
    task, model: 'mock-model', showPlan: false, autoApprove: true, verbose: false, silent: true, conversationHistory: [], sessionId: id, cwd,
    settings: { completionGate: { enabled: false }, cron: { enabled: false } }, provider, session: new T.Session({ id, cwd, startedAt: Date.now() }),
  });
  await run('inj-big', 'Why did the Stripe invoices not reconcile in the billing worker?', dir);
  const big1 = seen.pop();
  assert(/reconciled nightly/.test(big1.tail) && /recalled_memory|Recalled Memory/i.test(big1.tail), 'runAgent: the relevant memory rides in the request tail');
  assert(!/reconciled nightly/.test(big1.system) && !/Service 7 owns/.test(big1.system), 'and the ranked memories are not in the cached system prompt');
  assert(/prefer concise answers/.test(big1.system) && /Never push to main/.test(big1.system), 'global and pinned memories still are');
  const small2 = project();
  T.remember('Deploys happen on Tuesdays here', 'project', { belongsTo: small2 });
  await run('inj-small', 'Why did the Stripe invoices not reconcile?', small2);
  const sm = seen.pop();
  assert(/Deploys happen on Tuesdays/.test(sm.system) && !/recalled_memory|Recalled Memory/i.test(sm.tail), 'a small store: everything in the prefix, nothing recalled into the tail');
});

await block('Recall tool, deferred group and request rule, API routes', async () => {
  resetStore();
  const dir = project();
  writeLog('ep-pg', dir, { title: 'Fix Postgres migration ordering', requests: ['the migrations run out of order on postgres'], outcome: 'Sorted migrations by their timestamp prefix and added a test.', files: ['db/migrate.ts'], tools: ['Edit', 'Bash'], at: NOW - 3 * DAY });
  writeLog('ep-self', dir, { title: 'Postgres question now', requests: ['postgres migrations again?'], outcome: 'Looking.', at: NOW - 60_000 });
  T.remember('Postgres runs in Docker on port 5433 locally', 'project', { belongsTo: dir });
  const out = await T.runInContext({ cwd: dir, sessionId: 'ep-self' }, () => T.recallTool({ query: 'postgres migration' }));
  assert(/\[past session\]/.test(out) && /session ep-pg/.test(out) && /db\/migrate\.ts/.test(out), 'past sessions come back with their id and files');
  assert(/asked: the migrations run out of order/.test(out) && /outcome: Sorted migrations/.test(out), 'with what was asked and what came of it');
  assert(/\[memory · project\]/.test(out) && /port 5433/.test(out), 'memories too');
  assert(!/session ep-self/.test(out), 'the current conversation is not returned as its own past');
  assert(/by words only/.test(out) && /paraphrase/.test(out) && /not instructions/.test(out), 'it says it searched by words, that a paraphrase can be missed, and that results are data');
  const none = await T.runInContext({ cwd: dir }, () => T.recallTool({ query: 'kangaroo saxophone' }));
  assert(/Nothing in past sessions/.test(none), 'nothing found is said plainly');
  assert(/needs a query/.test(await T.recallTool({})), 'no query: a usable error');
  const eps = await T.runInContext({ cwd: dir }, () => T.recallTool({ query: 'postgres', kinds: ['memory'] }));
  assert(!/\[past session\]/.test(eps) && /5433/.test(eps), 'kinds narrows the search');

  assert(T.toolDefinitions.some(d => d.name === 'Recall'), 'Recall is a registered tool');
  assert(T.groupOf('Recall') === 'recall' && T.isDeferred('Recall', new Set()), 'in the deferred group "recall"');
  for (const q of ['What did we do last week about the invoices?', 'last time we fixed this differently', 'remember when we moved to pnpm?', 'in a previous session we decided X', 'earlier we tried caching'])
    assert(T.groupsForRequest(q).includes('recall'), `"${q}" loads it`);
  for (const q of ['fix the typo in the header', 'add a test for parseDate', 'the last item in the list is wrong'])
    assert(!T.groupsForRequest(q).includes('recall'), `"${q}" does not`);

  const api = await T.handleRecallRoute('recall/search', 'GET', new URLSearchParams('q=postgres&kinds=episode'), dir);
  assert(api.status === 200 && api.body.hits.length >= 1 && api.body.hits.every(h => h.kind === 'episode') && api.body.mode === 'words', 'GET /api/recall/search');
  assert((await T.handleRecallRoute('recall/search', 'GET', new URLSearchParams(''), dir)).status === 400, 'a search with no q is a 400');
  const rb = await T.handleRecallRoute('recall/rebuild', 'POST', new URLSearchParams(), dir);
  assert(rb.status === 200 && rb.body.ok && rb.body.counts.episode === 2, `POST /api/recall/rebuild (${JSON.stringify(rb.body.counts)})`);
  assert((await T.handleRecallRoute('recall/rebuild', 'GET', new URLSearchParams(), dir)).status === 405, 'rebuild is POST only');
});

await block('About-you facts: indexed for the profile learner, survive a rebuild', async () => {
  T.upsertProfileItems([{ id: 'stack-ts', text: 'Works mostly in TypeScript and Node', title: 'Stack', importance: 0.9 }]);
  assert((await T.searchRecall({ query: 'typescript', kinds: ['profile'] })).hits.length === 1, 'a profile fact is searchable');
  let supplied = 0;
  T.registerProfileSource(() => { supplied++; return [{ id: 'stack-ts', text: 'Works mostly in TypeScript and Node' }]; });
  T.rebuildRecall();
  assert(supplied === 1 && T.countItems().profile === 1, 'a rebuild keeps profile rows and asks the learner for them again');
  assert(T.removeProfileItem('stack-ts') && T.countItems().profile === 0, 'and one can be removed');
  T.registerProfileSource(undefined);
});

await block('Upkeep: merges, archives old episodes, never deletes or archives a memory', async () => {
  resetStore();
  const dir = project();
  // Two near-identical memories written by hand (past the write-time check).
  const mdir = T.scopeDir('project', dir);
  fs.mkdirSync(mdir, { recursive: true });
  const md = (id, text, t) => fs.writeFileSync(path.join(mdir, `${id}.md`), `---\nid: ${id}\nscope: project\nbelongsTo: ${dir}\ncreatedAt: ${t}\nupdatedAt: ${t}\n---\n${text}\n`);
  md('a', 'Run the integration tests before merging', NOW - 10 * DAY);
  md('b', 'run the integration tests before merging.', NOW - DAY);
  md('c', 'A very old memory nobody has used in a year', NOW - 400 * DAY);
  writeLog('ancient', dir, { title: 'An old investigation', requests: ['look into the old cache'], outcome: 'Done.', at: NOW - 200 * DAY });
  writeLog('fork-a', dir, { title: 'Same work', requests: ['same request text here'], outcome: 'Same outcome.', at: NOW - 3 * DAY });
  writeLog('fork-b', dir, { title: 'Same work', requests: ['same request text here'], outcome: 'Same outcome.', at: NOW - 2 * DAY });
  T.upsertProfileItems([{ id: 'old-fact', text: 'Likes dark themes', updated: NOW - 400 * DAY }]);
  const before = fs.readdirSync(mdir).length;
  const r = await T.runRecallUpkeep({ now: NOW, embedder: stub });
  assert(r.mergedMemories === 1 && T.listScope('project', dir).find(m => m.id === 'a').status === 'superseded', `the older duplicate memory is marked superseded (${r.mergedMemories})`);
  assert(fs.readdirSync(mdir).length === before, 'no memory file is deleted');
  assert(r.mergedEpisodes === 1 && T.getItem('episode:fork-a').status === 'superseded', 'a fork\'s identical episode is merged onto the newer');
  assert(r.archived === 1 && T.getItem('episode:ancient').status === 'archived', 'an episode untouched for 120+ days is archived');
  assert(T.listItems({ kind: 'memory' }).every(i => i.status !== 'archived') && T.getItem('profile:old-fact').status === 'active', 'memories and profile facts are never archived, however old');
  assert(r.embedded > 0 && !r.embedError, `pending embeddings caught up (${r.embedded})`);
  const archivedHit = await T.searchRecall({ query: 'old cache investigation', includeArchived: true });
  assert(archivedHit.hits.some(h => h.item.id === 'episode:ancient'), 'an archived episode is still found by the Recall tool');
  assert(!(await T.searchRecall({ query: 'old cache investigation' })).hits.some(h => h.item.id === 'episode:ancient'), '…but not by the per-turn recall');
  assert(T.upkeepDue(new Date(2026, 9, 3, 3, 0).getTime(), new Date(2026, 9, 2, 3, 0).getTime()), 'due at 03:00 a day later');
  assert(!T.upkeepDue(new Date(2026, 9, 3, 14, 0).getTime(), new Date(2026, 9, 3, 3, 0).getTime()), 'not in the afternoon after a night run');
  assert(T.upkeepDue(new Date(2026, 9, 5, 14, 0).getTime(), new Date(2026, 9, 3, 3, 0).getTime()), 'but any time once two days have passed');
});

await block('Embeddings: off by default, local-only respected, real wire shapes against a loopback stub', async () => {
  const off = T.embedRole({}, 'deepseek-v4-flash');
  assert(!off.ok && off.source === 'off' && T.embedderFromSettings({}, 'deepseek-v4-flash') === undefined, 'no embed role set: words-only, nothing sent anywhere');
  // Obviously fake key. standards-allow: secret
  const cloud = { providerInstances: [{ id: 'openai', type: 'openai', name: 'OpenAI', apiKey: 'fake-key-for-tests-only' }], models: { roles: { embed: 'text-embedding-3-small' } } };   // standards-allow: secret
  assert(T.embedRole(cloud, 'gpt-4o-mini').ok && T.embedderFromSettings(cloud, 'gpt-4o-mini')?.model === 'text-embedding-3-small', 'an explicit embed role makes an embedder');
  const localOnly = { ...cloud, models: { ...cloud.models, localOnlyPersonal: true } };
  assert(!T.embedRole(localOnly, 'gpt-4o-mini').ok && T.embedderFromSettings(localOnly, 'gpt-4o-mini') === undefined, 'personal data set to stay local: a cloud embedder is refused, words-only');

  const got = [];
  const server = http.createServer((req, res) => {
    let body = ''; req.on('data', c => { body += c; }); req.on('end', () => {
      const j = JSON.parse(body); got.push({ url: req.url, auth: req.headers.authorization ?? '', body: j });
      res.setHeader('content-type', 'application/json');
      if (req.url === '/v1/embeddings') res.end(JSON.stringify({ data: j.input.map((t, i) => ({ index: i, embedding: Array.from(stubVector(t)) })).reverse() }));
      else if (req.url === '/api/embed') res.end(JSON.stringify({ embeddings: j.input.map(t => Array.from(stubVector(t))) }));
      else { res.statusCode = 404; res.end('{"error":"no"}'); }
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  try {
    const compat = { providerInstances: [{ id: 'lm', type: 'openai-compatible', name: 'LM Studio', baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'local-fake' }], models: { roles: { embed: 'nomic-embed-text' }, localOnlyPersonal: true } };   // standards-allow: secret
    const e1 = T.embedderFromSettings(compat, 'x');
    assert(e1 && T.embedRole(compat, 'x').local, 'a loopback OpenAI-compatible endpoint counts as local');
    const v = await e1.embed(['invoices', 'deploy on friday']);
    assert(v.length === 2 && T.cosine(v[0], stubVector('invoices')) > 0.99, 'OpenAI-compatible /v1/embeddings: vectors come back in input order (even when the server shuffles them)');
    assert(got[0].url === '/v1/embeddings' && got[0].body.model === 'nomic-embed-text' && got[0].auth === 'Bearer local-fake', 'model in the body, key only in the header');
    const ollama = { providerInstances: [{ id: 'ollama', type: 'ollama', name: 'Ollama', baseUrl: `http://127.0.0.1:${port}` }], models: { roles: { embed: 'nomic-embed-text' }, localOnlyPersonal: true } };
    const e2 = T.embedderFromSettings(ollama, 'x');
    const v2 = await e2.embed(['billing']);
    assert(v2.length === 1 && got.at(-1).url === '/api/embed', 'Ollama /api/embed');
    const bad = { providerInstances: [{ id: 'lm', type: 'openai-compatible', name: 'LM', baseUrl: `http://127.0.0.1:${port}/nope`, apiKey: 'local-fake' }], models: { roles: { embed: 'nomic-embed-text' } } };   // standards-allow: secret
    let msg = '';
    try { await T.embedderFromSettings(bad, 'x').embed(['x']); } catch (err) { msg = err.message; }
    assert(/HTTP 404/.test(msg) && !/local-fake/.test(msg), `a failed request names the status and never the key (${msg.slice(0, 60)})`);
  } finally {
    server.close();
  }
});

await block('Benchmark: hit@3, words only vs with stub embeddings (40 memories, 20 episodes, 10 queries)', async () => {
  resetStore();
  const dir = project();
  const answers = {
    pnpm: 'Use pnpm, never npm or yarn, for installing packages in this repo',
    staging: 'Staging lives at staging.example.test behind the VPN',
    deploy: 'Deployments happen on Fridays after 2pm',
    billing: 'Invoices are generated by Stripe at month end',
    review: 'Code review is required from Aisha before merge',
    theme: 'The UI theme supports dark mode; colors come from tokens.css',
    secrets: 'Secrets are rotated quarterly through the vault',
  };
  const filler = [
    'The API uses Hono on node:sqlite', 'Logs go to stdout in JSON', 'Dates are stored as UTC milliseconds',
    'Feature flags live in LaunchDarkly', 'The mobile app is React Native', 'Use zod for request validation',
    'Background jobs use a SQLite-backed queue', 'Emails are sent through Postmark', 'Images are resized on upload',
    'Search is powered by Meilisearch', 'Error tracking goes to Sentry', 'The admin panel is behind SSO',
    'Prefer named exports over default exports', 'Tests use vitest with in-memory databases', 'The monorepo uses turborepo',
    'Docs are written in MDX', 'Avoid lodash in new code', 'API responses use camelCase keys',
    'The CLI is built with commander', 'Rate limits are 100 requests per minute per user', 'Websocket events are namespaced by team',
    'The CSV importer accepts up to 50k rows', 'Analytics events go to PostHog', 'Uploads are stored in S3 compatible storage',
    'Timezones are shown in the user locale', 'Passwords are hashed with argon2', 'The build target is ES2022',
    'Translations live in locales folder', 'Health checks are at /healthz', 'Cron jobs are defined in cron.yaml',
    'Pagination is cursor based', 'The design system is in packages/ui', 'Feature work happens on short-lived branches',
  ];
  for (const t of [...Object.values(answers), ...filler]) T.remember(t, 'project', { belongsTo: dir });
  const episodes = {
    pg: ['Fix Postgres migration ordering', 'the migrations run out of order on postgres', 'Sorted migrations by timestamp prefix in db/migrate.ts'],
    flaky: ['Stabilise flaky login e2e test', 'the login e2e test fails randomly in CI', 'Added a retry on network idle; the login test is stable'],
    ci: ['Cut CI build time from 9 to 4 minutes', 'CI takes forever, make it quicker', 'Enabled dependency caching and split jobs; build now 4 minutes'],
  };
  const fillerEp = ['Add CSV export', 'Rename the settings page', 'Upgrade React to 19', 'Write onboarding docs', 'Fix date parsing bug', 'Add dark launch flag',
    'Refactor the auth middleware', 'Investigate memory leak in worker', 'Add pagination to orders', 'Translate checkout to German', 'Set up Sentry alerts',
    'Clean up unused env vars', 'Improve error messages in importer', 'Add health check endpoint', 'Tune rate limits', 'Document the release process', 'Fix broken image upload'];
  Object.entries(episodes).forEach(([k, [title, req, out]], i) => writeLog(`b-${k}`, dir, { title, requests: [req], outcome: out, at: NOW - (i + 1) * 5 * DAY }));
  fillerEp.forEach((t, i) => writeLog(`f-${i}`, dir, { title: t, requests: [t.toLowerCase()], outcome: `${t} done.`, at: NOW - (i + 2) * 3 * DAY }));
  T.syncAll({ projectRoots: [dir] });
  assert(T.countItems().memory === 40 && T.countItems().episode === 20, `40 memories and 20 episodes indexed (${JSON.stringify(T.countItems())})`);

  const memId = (text) => `memory:${T.listScope('project', dir).find(m => m.text === text).file}`;
  const queries = [
    { q: 'pnpm install', want: memId(answers.pnpm), kind: 'exact words' },
    { q: 'where is the staging server', want: memId(answers.staging), kind: 'shared word' },
    { q: 'postgress migration ordering', want: 'episode:b-pg', kind: 'typo' },
    { q: 'deplyment schedule', want: memId(answers.deploy), kind: 'typo, no other shared word' },
    { q: 'how do we bill customers', want: memId(answers.billing), kind: 'paraphrase, no shared words' },
    { q: 'who reviews pull requests', want: memId(answers.review), kind: 'paraphrase, one shared stem' },
    { q: 'what did we do about the flaky login test', want: 'episode:b-flaky', kind: 'shared words' },
    { q: 'dark mode colours', want: memId(answers.theme), kind: 'British spelling' },
    { q: 'speed up the slow build', want: 'episode:b-ci', kind: 'paraphrase, one shared word' },
    { q: 'rotate api keys', want: memId(answers.secrets), kind: 'paraphrase, inflection' },
  ];
  const run = async (embedder) => {
    const rows = [];
    for (const { q, want, kind } of queries) {
      const r = await T.searchRecall({ query: q, cwd: dir, limit: 3, ...(embedder ? { embedder } : {}) });
      rows.push({ q, kind, hit: r.hits.slice(0, 3).some(h => h.item.id === want) });
    }
    return rows;
  };
  const words = await run(undefined);
  await T.embedPending(stub, { budgetMs: 20_000, max: 1000 });
  const hybrid = await run(stub);
  const w = words.filter(r => r.hit).length; const h = hybrid.filter(r => r.hit).length;
  console.log('\n    query                                         kind                          words  +stub');
  queries.forEach((x, i) => console.log(`    ${x.q.padEnd(45)} ${x.kind.padEnd(29)} ${words[i].hit ? 'hit ' : 'miss'}   ${hybrid[i].hit ? 'hit' : 'miss'}`));
  console.log(`    hit@3: words only ${w}/10, with stub embeddings ${h}/10`);
  console.log('    (the stub knows the synonyms these queries use; it shows the fusion working, not how good a real model is)');
  assert(w >= 4, `words-only finds the queries that share words (hit@3 ${w}/10)`);
  assert(h > w, `adding a meaning signal finds more (hit@3 ${h}/10 vs ${w}/10)`);
  assert(words.find(r => r.kind === 'paraphrase, no shared words').hit === false, 'and words-only honestly misses a paraphrase with no shared words');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { for (const f of failures) console.log(`  ✗ ${f}`); process.exit(1); }
process.exit(0);
