/**
 * The conformance suite every provider adapter must pass (ADR 0039, "Tests"): ONE standard
 * operation script, run through the real `ConnectionClient` against a loopback mock forge that
 * replays recorded-shape fixtures, with the normalised output compared to goldens checked in
 * beside the fixtures.
 *
 * WHY one script for every provider. The engine above the adapters (sync, landing, risk) only
 * ever sees the normalised shapes, so a provider is "supported" exactly when it produces those
 * shapes the same way as the others: a PR that is still computing mergeability is `unknown`,
 * never `mergeable`; "no checks" is `none`, never `passing`; a stale `ifRev` is a `conflict`,
 * never an overwrite. Testing each adapter with its own ad-hoc script lets those rules drift
 * apart; testing them all with this script makes drifting a failing test. GitLab, Azure
 * DevOps and the rest reuse `runConformance` with their own fixtures, subject and goldens.
 *
 * It checks, in order, per scenario profile:
 *   full        probe; repos.get/list; pulls.find (none) -> create (body clipped to the probed
 *               bodyMax with the overflow returned, no AI attribution on the wire) -> get across
 *               the sequenced states -> comments (author association preserved) -> comment,
 *               update, merge (stale head and unmergeable refused as `conflict`, no admin flags);
 *               items.query (PRs excluded; the second call is `notModified` and the mock saw
 *               If-None-Match) / get / update with the right ifRev / a stale ifRev is `conflict`
 *               and nothing is written / transition / comment / labels; iterations; checks;
 *               protection readable, unprotected;
 *   degraded    an older server: probe warnings and fallbacks, items, milestones, checks, protection;
 *   limited     a fine-grained token: no scopes reported, protection and checks unreadable;
 *   rate-limit  the provider says "wait": `rate-limited` and NO further request reaches the mock;
 *   hostile     text a stranger wrote: no HTML comments, invisible or tag characters survive,
 *               every field respects REMOTE_LIMITS, associations are preserved not trusted.
 * Invariants across every profile: the credential (a planted canary) is sent only in the
 * Authorization header, never in a URL, query or body, and appears in no adapter output or
 * error message; every request was matched by a fixture.
 *
 * Goldens: `<fixturesDir>/<scenario>/golden.json`, keyed by step. Volatile fields (`observedAt`,
 * the probe's `at`) and the mock's origin are scrubbed before comparing. Set
 * AICO_UPDATE_GOLDEN=1 to rewrite them from the current output, then READ the diff: a golden is
 * only as good as the review of it. Independent, hand-written expectations (`subject.pullExpect`)
 * are checked beside the goldens so a wrong golden cannot make a wrong adapter pass.
 *
 * What it does not do: exercise TLS or real redirects (the client's own tests do), or talk to any
 * real service. Output follows scripts/ops-test.mjs: check/cross lines and a summary the caller prints.
 */

import fs from 'node:fs';
import path from 'node:path';
import { startMockForge } from './lib/mock-forge.mjs';

/** A clock whose sleeps cost nothing, so the client's token bucket does not slow the suite. */
export function fastClock() {
  let offset = 0;
  return { now: () => Date.now() + offset, sleep: async (ms) => { offset += ms; } };
}

function stable(v) {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`;
  return JSON.stringify(v);
}

function scrub(value, forge, volatile) {
  const walk = (v, key) => {
    if (typeof v === 'string') return v.split(forge.url).join('<origin>');
    if (Array.isArray(v)) return v.map(x => walk(x));
    if (v && typeof v === 'object') {
      const o = {};
      for (const [k, x] of Object.entries(v)) o[k] = volatile.includes(k) ? '<time>' : walk(x, k);
      return o;
    }
    void key;
    return v;
  };
  return walk(JSON.parse(JSON.stringify(value ?? null)));
}

function firstDiff(a, b, at = '$') {
  if (typeof a !== typeof b || Array.isArray(a) !== Array.isArray(b) || a === null || b === null) return `${at}: expected ${JSON.stringify(a)?.slice(0, 120)} got ${JSON.stringify(b)?.slice(0, 120)}`;
  if (typeof a !== 'object') return a === b ? undefined : `${at}: expected ${JSON.stringify(a)?.slice(0, 120)} got ${JSON.stringify(b)?.slice(0, 120)}`;
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    if (!(k in a)) return `${at}.${k}: unexpected ${JSON.stringify(b[k])?.slice(0, 120)}`;
    if (!(k in b)) return `${at}.${k}: missing (expected ${JSON.stringify(a[k])?.slice(0, 120)})`;
    const d = firstDiff(a[k], b[k], `${at}.${k}`);
    if (d) return d;
  }
  return undefined;
}

const INVISIBLE = /[​-‏‪-‮⁠-⁤﻿]|[\u{e0000}-\u{e007f}]/u;

function encodingsOf(v) {
  const b = Buffer.from(v);
  return [v, b.toString('base64'), b.toString('base64').replace(/=+$/, ''), b.toString('base64url'), b.toString('hex'), encodeURIComponent(v), JSON.stringify(v).slice(1, -1)];
}

function walkStrings(value, fn, key = '') {
  if (typeof value === 'string') fn(value, key);
  else if (Array.isArray(value)) value.forEach(v => walkStrings(v, fn, key));
  else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) walkStrings(v, fn, k);
}

/**
 * @param {object} opts
 * @param {string} opts.name            provider name for the headings
 * @param {object} opts.T               the engine test bundle (ConnectionClient, ConnectionError, resetConnectionHttpForTest, rateLimitedUntil, REMOTE_LIMITS)
 * @param {object} opts.adapter         a ProviderAdapter
 * @param {(i: {forge: object, scenario: string, token: string, id: string}) => Promise<object>} opts.makeConnection  creates the vault credential and returns the StoredConnection for the mock
 * @param {string} opts.fixturesDir     contains one directory per scenario
 * @param {string} opts.token           a planted canary credential
 * @param {object} opts.subject         what the standard script operates on (see scripts/connections-github-test.mjs)
 * @param {Array<{scenario: string, profile: 'full'|'degraded'|'limited'|'rate-limit'|'hostile'}>} opts.scenarios
 * @param {Record<string, (env: object) => Promise<void>>} [opts.extra]  provider-specific checks per scenario
 * @param {(cond: boolean, name: string) => void} [opts.assert]  defaults to a counting printer
 */
export async function runConformance(opts) {
  const { name, T, adapter, makeConnection, fixturesDir, token, subject, scenarios, extra = {} } = opts;
  let passed = 0;
  let failed = 0;
  const failures = [];
  const assert = opts.assert ?? ((cond, label) => {
    if (cond) { passed++; console.log(`  ✓ ${label}`); } else { failed++; failures.push(label); console.log(`  ✗ ${label}`); }
  });
  const update = process.env.AICO_UPDATE_GOLDEN === '1';
  const L = T.REMOTE_LIMITS;
  const SLACK = 40; // sanitizeRemoteText appends "\n… (cut at N characters)" when it cuts

  for (const sc of scenarios) {
    console.log(`\n══ ${name}: ${sc.scenario} (${sc.profile}) ══`);
    T.resetConnectionHttpForTest();
    const forge = await startMockForge({ fixtures: fixturesDir, scenario: sc.scenario, requireAuth: true, token, ...(subject.basicUser !== undefined ? { basicUser: subject.basicUser } : {}) });
    const outputs = [];
    const errors = [];
    const goldenFile = path.join(fixturesDir, sc.scenario, 'golden.json');
    let goldens = {};
    try { goldens = JSON.parse(fs.readFileSync(goldenFile, 'utf8')); } catch { /* none yet */ }
    const written = {};

    const cmp = (step, value, label, volatile = ['observedAt']) => {
      const actual = scrub(value, forge, volatile);
      outputs.push(actual);
      if (update) { written[step] = actual; assert(true, `${label} (golden written)`); return; }
      const want = goldens[step];
      if (want === undefined) { assert(false, `${label}: no golden for "${step}" (run with AICO_UPDATE_GOLDEN=1, then review)`); return; }
      const d = stable(want) === stable(actual) ? undefined : firstDiff(want, actual);
      assert(!d, d ? `${label}: ${d}` : label);
    };
    const attempt = async (fn) => {
      try { return { value: await fn() }; } catch (e) {
        errors.push(String(e?.message ?? e));
        return { error: e };
      }
    };
    const reqs = (m, re) => forge.requests.filter(r => r.method === m && re.test(r.path));

    try {
      const conn = await makeConnection({ forge, scenario: sc.scenario, token, id: `${name}-${sc.scenario}`.replace(/[^a-z0-9_-]/gi, '-').toLowerCase().slice(0, 40) });
      const client = new T.ConnectionClient(conn, { ...adapter.clientOptions(conn), clock: fastClock(), retries: 0 });
      const ctx = { conn, client, repo: subject.repo };
      const env = { forge, conn, client, ctx, adapter, T, assert, cmp, attempt, reqs, outputs, errors };

      if (sc.profile === 'full') await full(env);
      else if (sc.profile === 'degraded') await degraded(env);
      else if (sc.profile === 'limited') await limited(env);
      else if (sc.profile === 'rate-limit') await rateLimit(env);
      else if (sc.profile === 'hostile') await hostile(env);
      else assert(false, `unknown profile ${sc.profile}`);
      if (extra[sc.scenario]) await extra[sc.scenario](env);

      // ── invariants, every profile ──
      const encs = encodingsOf(token);
      const leaked = (text) => encs.some(e => text.includes(e));
      const inUrl = forge.requests.filter(r => leaked(r.url) || leaked(r.rawBody));
      assert(inUrl.length === 0, 'the credential appears in no request URL, query or body');
      const inOtherHeader = forge.requests.filter(r => Object.entries(r.headers).some(([k, v]) => k !== 'authorization' && leaked(String(v))));
      assert(inOtherHeader.length === 0, 'the credential appears in no header except Authorization');
      const scheme = subject.wire?.authScheme ?? 'Bearer';
      const wantAuth = subject.basicUser !== undefined ? `Basic ${Buffer.from(`${subject.basicUser}:${token}`).toString('base64')}` : `${scheme} ${token}`;
      assert(forge.requests.length > 0 && forge.requests.every(r => r.headers.authorization === wantAuth), `every request carried "Authorization: ${subject.basicUser !== undefined ? 'Basic <user:token>' : `${scheme} <token>`}" (${forge.requests.length} requests)`);
      assert(!leaked(JSON.stringify(outputs)), 'no adapter output contains the credential');
      assert(!errors.some(leaked), `no error message contains the credential (${errors.length} errors seen)`);
      const unmatched = forge.requests.filter(r => !r.matched && r.status !== 401 && sc.profile !== 'rate-limit');
      assert(unmatched.length === 0, `every request was answered by a fixture (nothing unexpected was asked)${unmatched.length ? `: ${unmatched.map(r => `${r.method} ${r.path}`).join(', ')}` : ''}`);
    } finally {
      await forge.stop();
      if (update) {
        fs.writeFileSync(goldenFile, `${JSON.stringify(written, null, 2)}\n`, 'utf8');
        console.log(`  (goldens written to ${path.relative(process.cwd(), goldenFile)})`);
      }
    }
  }
  return { passed, failed, failures };

  // ═════════════════════════ profiles ═════════════════════════

  async function full(env) {
    const { ctx, forge, cmp, reqs } = env;
    const S = subject;
    const run = async (label, fn) => {
      const r = await env.attempt(fn);
      if (r.error) env.assert(false, `${label}: threw ${r.error.code ?? ''} ${String(r.error.message).slice(0, 200)}`);
      return r.value;
    };

    console.log('  — probe and repository');
    const probe = await run('probe', () => adapter.probe(ctx));
    if (probe) {
      cmp('probe', probe, 'probe: user, scopes, capabilities and warnings match the golden', ['at']);
      env.assert(typeof probe.capabilities.pulls.bodyMax === 'number' && probe.capabilities.pulls.bodyMax > 0, 'probe reports the PR body limit');
    }
    const bodyMax = probe?.capabilities.pulls.bodyMax ?? 4000;
    const info = await run('repos.get', () => adapter.repos.get(ctx, S.repo));
    if (info) {
      cmp('repo', info, 'repos.get: default branch, urls, permissions match the golden');
      env.assert(!/@/.test(info.cloneUrl), 'the clone URL carries no userinfo');
      env.assert(info.cloneUrl.startsWith(forge.url), 'the clone URL is built from the connection base, not copied from the response');
    }
    const list = await run('repos.list', () => adapter.repos.list(ctx));
    if (list) cmp('repos', list, 'repos.list matches the golden');

    console.log('  — pull request lifecycle');
    const none = await run('pulls.find', () => adapter.pulls.find(ctx, S.head));
    env.assert(none === undefined, 'pulls.find: no open PR for the branch yet');

    // Attribution lines first (so the arithmetic below is exact), then enough filler to need clipping.
    const attributionA = 'Co-Authored-By: Some Tool <noreply@example.test>';
    const attributionB = '🤖 Generated with Some Tool by Claude';
    const filler = 'evidence line: all checks green\n'.repeat(Math.ceil((bodyMax + 6000) / 32));
    const original = `${attributionA}\n${attributionB}\nEvidence packet for the task.\n${filler}`;
    const strippedLen = original.length - (attributionA.length + 1) - (attributionB.length + 1);
    const created = await run('pulls.create', () => adapter.pulls.create(ctx, { head: S.head, base: S.base, title: S.createTitle ?? 'Add widget cache', body: original }));
    if (created) {
      cmp('pull.created', created.pull, 'pulls.create: the new PR folds to the golden (mergeability still unknown)');
      const sent = reqs('POST', S.createPath).at(-1);
      const sentBody = String((S.prBodyOf ? S.prBodyOf(sent?.body) : sent?.body?.body) ?? '');
      env.assert(!!sent && sentBody.length > 0 && sentBody.length <= bodyMax, `the PR body sent was clipped to the probed limit (${sentBody.length} <= ${bodyMax})`);
      env.assert(typeof created.overflow === 'string' && created.overflow.length > 0, 'the overflow is returned for the caller to post as a first comment');
      env.assert(sentBody.length + (created.overflow?.length ?? 0) === strippedLen, 'nothing was lost: sent body + overflow = the body minus the attribution lines');
      env.assert(!/co-authored-by|generated with|🤖/i.test(sent?.rawBody ?? ''), 'no AI attribution crossed the wire in the PR create request');
    }

    for (let i = 1; i <= S.pullExpect.length; i++) {
      const pull = await run(`pulls.get #${i}`, () => adapter.pulls.get(ctx, S.pullId));
      if (!pull) continue;
      cmp(`pull.${i}`, pull, `pulls.get (state ${i}): matches the golden`);
      const want = S.pullExpect[i - 1];
      const got = { state: pull.state, mergeable: pull.mergeable, canMerge: pull.canMerge, checks: pull.checks.state, reviews: pull.reviews.state };
      const d = firstDiff(want, got);
      env.assert(!d, `pulls.get (state ${i}): hand-written expectation ${JSON.stringify(want)}${d ? ` — ${d}` : ''}`);
      if (!pull.canMerge && pull.state === 'open') env.assert(pull.mergeBlockers.length > 0, `pulls.get (state ${i}): a PR that cannot be merged says why`);
      if (pull.canMerge) env.assert(pull.mergeBlockers.length === 0 && pull.checks.state !== 'failing', `pulls.get (state ${i}): a mergeable PR has no blockers`);
    }

    const comments = await run('pulls.comments', () => adapter.pulls.comments(ctx, S.pullId));
    if (comments) {
      cmp('comments', comments, 'pulls.comments: authors, associations and review kinds match the golden');
      const assoc = new Set(comments.map(c => c.association));
      env.assert(S.associations.every(a => assoc.has(a)), `author association is preserved (${[...assoc].join(', ')})`);
      env.assert(comments.every((c, i) => i === 0 || Date.parse(c.at) >= Date.parse(comments[i - 1].at)), 'comments are ordered oldest first');
    }

    await run('pulls.comment', () => adapter.pulls.comment(ctx, S.pullId, `Progress update.\n${attributionA}\n${attributionB}\nDone.`));
    const sentComment = reqs('POST', S.pullCommentPath).at(-1);
    env.assert(!!sentComment && /Progress update/.test(sentComment.rawBody) && !/co-authored-by|generated with|🤖/i.test(sentComment.rawBody), 'pulls.comment: sent, with no AI attribution');
    const upd = await run('pulls.update', () => adapter.pulls.update(ctx, S.pullId, { title: 'Add widget cache (renamed)' }));
    env.assert(upd?.id === S.pullId, 'pulls.update returns the PR');

    console.log('  — merge');
    const stale = await env.attempt(() => adapter.pulls.merge(ctx, S.pullId, { method: S.mergeMethod, sha: S.staleSha }));
    env.assert(isCodeOf(stale, 'conflict'), 'merge with a head the PR no longer has is a `conflict`');
    const unmergeable = await env.attempt(() => adapter.pulls.merge(ctx, S.pullId, { method: S.mergeMethod, sha: S.unmergeableSha }));
    env.assert(isCodeOf(unmergeable, 'conflict'), 'merge the provider refuses (not mergeable) is a `conflict`');
    const merged = await run('pulls.merge', () => adapter.pulls.merge(ctx, S.pullId, { method: S.mergeMethod, sha: S.headSha }));
    env.assert(merged?.sha === S.mergeSha, 'merge returns the merge commit sha');
    const mreq = reqs(S.mergeHttpMethod ?? 'PUT', S.mergePath).at(-1);
    if (S.mergeRequestOk) {
      // A provider whose merge request is not GitHub-shaped says what a correct (and bypass-free) one looks like.
      const why = S.mergeRequestOk(mreq);
      env.assert(why === true, `merge request is correct and asks for no bypass${why === true ? '' : `: ${why}`}`);
    } else {
      const keys = Object.keys(mreq?.body ?? {});
      env.assert(mreq?.body?.sha === S.headSha && mreq?.body?.merge_method === S.mergeMethod, 'merge sends the expected head sha and the chosen method');
      env.assert(keys.every(k => ['merge_method', 'sha', 'commit_title', 'commit_message'].includes(k)), `merge asks for nothing else (no admin bypass): ${keys.join(', ')}`);
    }

    const has = (name) => (S.sections ?? ['items', 'iterations', 'checks', 'protection']).includes(name);
    if (has('items')) {
      console.log('  — work items');
      const q = { source: 'label', value: 'bug', state: 'open', since: '2026-09-01T00:00:00Z' };
      const first = await run('items.query', () => adapter.items.query(ctx, q));
      if (first) {
        cmp('items', first.items, 'items.query: normalised items match the golden');
        env.assert(first.notModified === false, 'the first query is a full fetch');
        env.assert(S.prNumbers.every(n => !first.items.some(i => i.number === n)), `pull requests are excluded from the import (${S.prNumbers.join(', ')})`);
        env.assert(S.pagedNumbers.every(n => first.items.some(i => i.number === n)), 'a second page was followed');
      }
      const before = forge.requests.length;
      const second = await run('items.query (again)', () => adapter.items.query(ctx, q));
      if (second && first && S.wire?.conditional === false) {
        // A platform with no ETag (Azure DevOps) is never `notModified`: the same query gives the same items, fetched again.
        env.assert(second.notModified === false && stable(second.items) === stable(first.items), 'a platform without ETags re-fetches and gets the same items');
      } else if (second && first) {
        env.assert(second.notModified === true, 'the second identical query is `notModified`');
        env.assert(stable(second.items) === stable(first.items), 'a 304 serves the same items from cache');
        const sent = forge.requests.slice(before).filter(r => r.method === 'GET' && S.issuesPath.test(r.path));
        env.assert(sent.length > 0 && sent.every(r => r.headers['if-none-match']) && sent.every(r => r.status === 304), `If-None-Match was sent and answered 304 (${sent.length} requests)`);
      }
      const itemsVerb = S.wire?.itemsMethod ?? 'GET';
      const firstReq = reqs(itemsVerb, S.issuesPath).find(r => r.query.labels === 'bug');
      env.assert(S.wire?.itemsQueryOk ? S.wire.itemsQueryOk(reqs(itemsVerb, S.issuesPath)) : !!firstReq && firstReq.query.state === 'open' && firstReq.query.since === '2026-09-01T00:00:00.000Z' && firstReq.query.per_page === '100', 'the query asked for labels, state, since and the page size');
      const mine = await run('items.query (assigned)', () => adapter.items.query(ctx, { source: 'assigned-to-me', me: S.me, state: 'open' }));
      env.assert(!!mine && (S.wire?.assignedOk ? S.wire.assignedOk(reqs(itemsVerb, S.issuesPath), mine.items) : reqs('GET', S.issuesPath).some(r => r.query.assignee === S.me)), 'assigned-to-me asks for the token owner\'s items');
      const search = await run('items.query (query)', () => adapter.items.query(ctx, { source: 'query', value: 'label:bug', state: 'open' }));
      if (search) {
        cmp('items.search', search.items, 'items.query (query text): only this repository\'s issues, no PRs');
        env.assert(search.items.every(i => !S.prNumbers.includes(i.number)), 'the search excludes pull requests too');
      }

      const item = await run('items.get', () => adapter.items.get(ctx, S.issueId));
      if (item) { cmp('item', item, 'items.get matches the golden'); env.assert(item.rev === S.issueRev, 'the item carries its revision (updated_at)'); }
      const writesBefore = forge.requests.filter(r => r.method !== 'GET').length;
      const updated = await run('items.update', () => adapter.items.update(ctx, S.issueId, { title: 'Cache invalidation on widget update (reworded)', labels: ['bug', 'sp:3', 'aico:running'], milestone: S.milestoneId }, S.issueRev));
      if (updated) cmp('item.updated', updated, 'items.update with the right ifRev: the result matches the golden');
      const patch = reqs(S.wire?.updateVerb ?? 'PATCH', S.issuePath).at(-1);
      env.assert(S.wire?.updateSentOk ? S.wire.updateSentOk(forge.requests) : !!patch && patch.body?.title === 'Cache invalidation on widget update (reworded)' && JSON.stringify(patch.body?.labels) === JSON.stringify(['bug', 'sp:3', 'aico:running']), 'the update sent exactly the changed fields');
      const writesMid = forge.requests.filter(r => r.method !== 'GET').length;
      const conflict = await env.attempt(() => adapter.items.update(ctx, S.issueId, { title: 'Overwrites someone else' }, S.staleRev));
      env.assert(isCodeOf(conflict, 'conflict') && conflict.error.status === 409, 'update with a stale ifRev is a `conflict` (409)');
      env.assert(forge.requests.filter(r => r.method !== 'GET').length === writesMid && writesMid === writesBefore + (S.wire?.updateWrites ?? 1), 'the stale update wrote nothing');
      const closed = await run('items.transition', () => adapter.items.transition(ctx, S.issueId, 'closed', S.issueRev));
      if (closed) cmp('item.closed', closed, 'items.transition(closed): the result matches the golden');
      const tr = reqs(S.wire?.updateVerb ?? 'PATCH', S.issuePath).at(-1);
      env.assert(S.wire?.closeOk ? S.wire.closeOk(tr?.body) : tr?.body?.state === 'closed' && tr?.body?.state_reason === 'completed', 'closing says it was completed');
      const staleT = await env.attempt(() => adapter.items.transition(ctx, S.issueId, 'open', S.staleRev));
      env.assert(isCodeOf(staleT, 'conflict'), 'transition with a stale ifRev is a `conflict`');
      await run('items.comment', () => adapter.items.comment(ctx, S.issueId, `Update.\n${attributionA}\nDone.`));
      const ic = reqs('POST', S.issueCommentPath).at(-1);
      env.assert(S.wire?.itemCommentOk ? S.wire.itemCommentOk(forge.requests) : !!ic && /Update/.test(ic.rawBody) && !/co-authored-by/i.test(ic.rawBody), 'items.comment sent, with no AI attribution');
      await run('items.addLabels', () => adapter.items.addLabels(ctx, S.issueId, ['aico:running']));
      env.assert(S.wire?.labelsOk ? S.wire.labelsOk(forge.requests) : reqs('POST', S.labelsPath).length === 1, 'addLabels posted the labels');
      await run('items.removeLabel', () => adapter.items.removeLabel(ctx, S.issueId, S.removableLabel));
      const gone = await env.attempt(() => adapter.items.removeLabel(ctx, S.issueId, S.goneLabel));
      env.assert(!gone.error, 'removing a label that is not on the issue is not an error');
      const made = await run('items.create', () => adapter.items.create(ctx, { title: 'Follow-up: cache metrics', body: `Track hit rate.\n${attributionB}`, labels: ['aico'] }));
      if (made) cmp('item.created', made, 'items.create matches the golden');
      const cr = reqs('POST', S.issuesPath).at(-1);
      env.assert(S.wire?.createItemOk ? S.wire.createItemOk(forge.requests) : !!cr && !/generated with|🤖/i.test(cr.rawBody), 'items.create sent, with no AI attribution');

    }

    console.log('  — iterations, checks, protection');
    if (has('iterations')) {
    const its = await run('iterations.list', () => adapter.iterations.list(ctx));
    if (its) cmp('iterations', its, 'iterations.list matches the golden');
    if (adapter.iterations?.create) {
      const it = await run('iterations.create', () => adapter.iterations.create(ctx, { title: 'Sprint 2', end: '2026-10-30T00:00:00Z' }));
      if (it) cmp('iteration.created', it, 'iterations.create matches the golden');
    }
    if (adapter.iterations?.assign) {
      await run('iterations.assign', () => adapter.iterations.assign(ctx, S.issueId, S.milestoneId));
      env.assert(S.wire?.assignOk ? S.wire.assignOk(reqs(S.wire?.updateVerb ?? 'PATCH', S.issuePath).at(-1)?.body, forge.requests) : reqs('PATCH', S.issuePath).at(-1)?.body?.milestone === Number(S.milestoneId), 'iterations.assign set the milestone');
    }
    }
    if (has('checks')) {
    const checks = await run('checks.forCommit', () => adapter.checks.forCommit(ctx, S.baseSha));
    if (checks) cmp('checks', checks, 'checks.forCommit: runs and statuses merged, states normalised');
    }
    if (has('protection')) {
    const prot = await run('protection.read', () => adapter.protection.read(ctx, S.protectedBranch));
    if (prot) cmp('protection', prot, 'protection.read (protected branch) matches the golden');
    // A provider whose protection is repository-wide (Bitbucket Data Center) has no unprotected branch to ask about.
    const unprot = S.skipUnprotected ? undefined : await run('protection.read (unprotected)', () => adapter.protection.read(ctx, S.unprotectedBranch));
    if (unprot) { cmp('protection.none', unprot, 'protection.read (unprotected branch) matches the golden'); env.assert(unprot.protected === false && !unprot.unreadable, 'an unprotected branch is readable and reported as not protected'); }
    }

    // Writes are audited with their operation names.
    const auditFile = path.join(process.env.AICO_HOME ?? '', 'audit', 'events.jsonl');
    let audit = [];
    try { audit = fs.readFileSync(auditFile, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)).filter(e => e.kind === 'connection'); } catch { /* no audit file */ }
    if (audit.length) {
      env.assert(audit.some(e => e.action === 'pr.open' && e.outcome === 'ok'), 'opening the PR was audited as pr.open');
      env.assert(audit.some(e => e.action === 'pr.merge'), 'the merge attempts were audited as pr.merge');
      env.assert(audit.some(e => e.action === 'write'), 'writes were audited as write');
      env.assert(!JSON.stringify(audit).includes(token) && audit.every(e => !/\?/.test(e.target ?? '')), 'audit lines carry no token and no query string');
    } else env.assert(false, 'the audit log recorded the connection writes');
  }

  async function degraded(env) {
    const { ctx, forge, cmp } = env;
    const S = subject;
    const run = async (label, fn) => {
      const r = await env.attempt(fn);
      if (r.error) env.assert(false, `${label}: threw ${r.error.code ?? ''} ${String(r.error.message).slice(0, 200)}`);
      return r.value;
    };
    const probe = await run('probe', () => adapter.probe(ctx));
    if (probe) cmp('probe', probe, 'probe on an older server matches the golden (version, fallbacks, warnings)', ['at']);
    const info = await run('repos.get', () => adapter.repos.get(ctx, S.repo));
    if (info) cmp('repo', info, 'repos.get matches the golden');
    const items = await run('items.query', () => adapter.items.query(ctx, { source: 'label', value: 'bug' }));
    if (items) cmp('items', items.items, 'items.query matches the golden (estimate label, milestone)');
    const its = await run('iterations.list', () => adapter.iterations.list(ctx));
    if (its) { cmp('iterations', its, 'iterations.list falls back to milestones'); env.assert(S.wire?.degradedIterationsOk ? S.wire.degradedIterationsOk(its) : its.every(i => i.kind === 'milestone'), 'no native iterations are invented'); }
    const checks = await run('checks.forCommit', () => adapter.checks.forCommit(ctx, S.baseSha));
    if (checks) { cmp('checks', checks, 'checks.forCommit on a commit with nothing is empty'); env.assert(checks.length === 0, 'no checks means an empty list'); }
    const prot = await run('protection.read', () => adapter.protection.read(ctx, S.protectedBranch));
    if (prot) cmp('protection', prot, 'protection.read (only required checks configured) matches the golden');
    env.assert(forge.requests.every(r => r.method === 'GET' || r.path.endsWith('graphql') || (S.wire?.readPostsOk?.(r) ?? false)), 'a read-only script made no writes (the GraphQL probe is a POST read)');
  }

  async function limited(env) {
    const { ctx, cmp } = env;
    const S = subject;
    const run = async (label, fn) => {
      const r = await env.attempt(fn);
      if (r.error) env.assert(false, `${label}: threw ${r.error.code ?? ''} ${String(r.error.message).slice(0, 200)}`);
      return r.value;
    };
    const probe = await run('probe', () => adapter.probe(ctx));
    if (probe) {
      cmp('probe', probe, 'probe of a token that reports no scopes matches the golden', ['at']);
      env.assert(probe.scopes.reported === false && probe.scopes.missing.length === 0, 'unreported scopes are not turned into "missing" chips');
      env.assert(probe.capabilities.protection.read === false && probe.warnings.some(w => /protection unreadable/i.test(w)), 'unreadable protection: capability false and a plain warning');
      env.assert(probe.capabilities.checks.read === false && probe.warnings.some(w => /checks/i.test(w)), 'unreadable checks: capability false and a plain warning');
      env.assert(probe.warnings.every(w => !/[{}]|\bundefined\b/.test(w)), 'warnings are plain sentences');
    }
    const pull = await run('pulls.get', () => adapter.pulls.get(ctx, S.pullId));
    if (pull) {
      cmp('pull', pull, 'pulls.get without protection or checks matches the golden');
      env.assert(pull.checks.state === 'none' && pull.protectedBase === undefined && pull.reviews.required === undefined, 'what could not be read is reported as unknown, not as an answer');
      env.assert(pull.canMerge === false, 'a blocked PR is not mergeable');
    }
    const prot = await run('protection.read', () => adapter.protection.read(ctx, S.protectedBranch));
    if (prot) { cmp('protection', prot, 'protection.read says it is unreadable'); env.assert(!!prot.unreadable, 'the reason is given'); }
  }

  async function rateLimit(env) {
    const { ctx, forge } = env;
    const first = await env.attempt(() => adapter.probe(ctx));
    env.assert(isCodeOf(first, 'rate-limited'), `a ${subject.rateLimitStatus ?? 403} that says "wait" is a \`rate-limited\` error`);
    env.assert(first.error?.status === (subject.rateLimitStatus ?? 403) && /rate-limiting this token until \d{4}-/.test(first.error?.message ?? ''), 'the message says until when');
    const count = forge.requests.length;
    env.assert(count >= 1, `the provider was asked once (${count})`);
    const later = await env.attempt(() => adapter.repos.get(ctx, subject.repo));
    // A provider with no work items is asked something else that must also fail fast.
    const items = await env.attempt(() => (adapter.items ? adapter.items.query(ctx, { source: 'label', value: 'bug' }) : adapter.checks.forCommit(ctx, 'a'.repeat(40))));
    const write = await env.attempt(() => adapter.pulls.comment(ctx, subject.pullId, 'hello'));
    env.assert(isCodeOf(later, 'rate-limited') && isCodeOf(items, 'rate-limited') && isCodeOf(write, 'rate-limited'), 'while blocked every operation fails fast as `rate-limited`');
    env.assert(forge.requests.length === count, `no further request reached the provider while blocked (${forge.requests.length} = ${count})`);
    env.assert(typeof env.T.rateLimitedUntil(env.conn.id) === 'number', 'the connection exposes when it may try again');
  }

  async function hostile(env) {
    const { ctx, cmp } = env;
    const S = subject;
    const out = { items: [], comments: [], pull: undefined, checks: [] };
    const run = async (label, fn) => {
      const r = await env.attempt(fn);
      if (r.error) env.assert(false, `${label}: threw ${r.error.code ?? ''} ${String(r.error.message).slice(0, 200)}`);
      return r.value;
    };
    const list = adapter.items ? await run('items.query', () => adapter.items.query(ctx, { source: 'label', value: 'bug' })) : undefined;
    const big = adapter.items ? await run('items.get', () => adapter.items.get(ctx, S.hostileBigIssue)) : undefined;
    const pull = await run('pulls.get', () => adapter.pulls.get(ctx, S.pullId));
    const comments = await run('pulls.comments', () => adapter.pulls.comments(ctx, S.pullId));
    const checks = await run('checks.forCommit', () => adapter.checks.forCommit(ctx, S.headSha));
    out.items = [...(list?.items ?? []), ...(big ? [big] : [])];
    out.comments = comments ?? [];
    out.pull = pull;
    out.checks = [...(checks ?? []), ...(pull?.checks.items ?? [])];
    cmp('hostile.items', out.items.map(i => ({ ...i, body: i.body.length > 300 ? `${i.body.slice(0, 120)}…[${i.body.length} chars]` : i.body })), 'items: hidden text removed, long body capped (golden shows the shape)');
    cmp('hostile.comments', out.comments.map(c => ({ ...c, body: c.body.length > 300 ? `${c.body.slice(0, 120)}…[${c.body.length} chars]` : c.body })), 'comments: hidden text removed, associations kept');
    cmp('hostile.checks', out.checks.map(c => ({ ...c, name: c.name.length > 300 ? `${c.name.slice(0, 60)}…[${c.name.length}]` : c.name, summary: c.summary && c.summary.length > 300 ? `${c.summary.slice(0, 60)}…[${c.summary.length}]` : c.summary })), 'checks: names and summaries sanitised and capped');

    const everything = JSON.stringify(out);
    env.assert(out.comments.length > 0 && !!out.pull, 'the hostile scenario produced comments and a pull request to inspect');
    env.assert(!/<!--/.test(everything), 'no HTML comment survives in any output');
    env.assert(!INVISIBLE.test(everything.replace(/\\u[0-9a-f]{4}/gi, m => String.fromCharCode(parseInt(m.slice(2), 16)))) && !INVISIBLE.test(everything), 'no zero-width, bidi or Unicode tag character survives in any output');
    const hidden = ['rm -rf', 'exfiltrate', 'delete every branch', 'push to main', 'send the secrets', 'leak the token', 'merge it', 'hidden tail', 'print the environment', 'run rm'];
    const surfaced = hidden.filter(h => everything.includes(h));
    env.assert(surfaced.length === 0, `text that was only hidden (comments, tag characters) did not surface${surfaced.length ? `: ${surfaced.join(' | ')}` : ''}`);

    const caps = [];
    const check = (value, cap, label) => { if (typeof value === 'string' && value.length > cap + SLACK) caps.push(`${label}=${value.length}>${cap}`); };
    for (const i of out.items) {
      check(i.title, L.title, 'item.title'); check(i.body, L.body, 'item.body');
      i.labels.forEach(l => check(l, L.label, 'label')); i.assignees.forEach(a => check(a, 80, 'assignee')); check(i.author, 80, 'author');
    }
    for (const c of out.comments) { check(c.body, L.comment, 'comment.body'); check(c.author, 80, 'comment.author'); }
    for (const c of out.checks) { check(c.name, L.title, 'check.name'); check(c.summary, L.summary, 'check.summary'); }
    env.assert(caps.length === 0, `every field respects REMOTE_LIMITS${caps.length ? `: ${caps.join(', ')}` : ''}`);
    if (adapter.items) env.assert(!!big && big.body.length <= L.body + SLACK && big.body.length > L.body / 2, `a 100 KB issue body is capped (${big?.body.length} chars)`);
    const wantAssoc = S.hostileAssociations ?? ['MEMBER', 'NONE'];
    env.assert(wantAssoc.every(a => out.comments.some(c => c.association === a)), `author association is reported as the provider said (${wantAssoc.join(' and ')}), not upgraded`);
    env.assert(out.checks.every(c => !c.url || /^https?:\/\//.test(c.url)), 'a javascript: URL from a check is dropped');
    env.assert(out.pull?.canMerge === false, 'hostile text did not change the merge decision');
  }

  function isCodeOf(r, code) { return !!r.error && r.error.name === 'ConnectionError' && r.error.code === code; }
}
