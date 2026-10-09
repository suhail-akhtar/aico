/**
 * An in-memory provider adapter for tests of the GENERIC connection code (sync, PR-mode landing)
 * that must not depend on how GitHub spells anything (ADR 0039). It implements the same
 * `ProviderAdapter` interface the real adapters do, keeps issues and pull requests in plain
 * objects a test can edit between calls, and records every write so a test can assert on what
 * AICO sent and in which order. It makes no HTTP request: the pull-request test pairs it with a
 * real `git http-backend` for the one thing that must be real, the push.
 *
 * It registers as provider `github` (the only provider the catalogue marks supported) and the
 * test restores the real adapter afterwards.
 */

import { T } from './dist.mjs';

const { ConnectionError } = T;

/** @param {{ cloneUrl?: string }} [opts] */
export function makeFakeForge(opts = {}) {
  const state = {
    user: 'octo-dev',
    cloneUrl: opts.cloneUrl ?? 'http://127.0.0.1:1/octo/widgets.git',
    defaultBranch: 'main',
    /** id -> item */
    items: new Map(),
    /** number -> pull */
    pulls: new Map(),
    comments: new Map(),
    writes: [],
    nextPull: 1,
    failTransition: false,
    createdBodies: [],
  };
  const rev = () => `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const touch = (i) => { i.rev = rev(); };
  const pullState = (p) => ({
    connection: 'fake', id: String(p.number), url: `https://forge.test/octo/widgets/pull/${p.number}`, state: p.state, draft: false,
    headSha: p.headSha ?? 'abc123', mergeable: p.mergeable ?? 'mergeable', checks: p.checks ?? { state: 'none', items: [] },
    reviews: p.reviews ?? { state: 'none', approved: 0, changesRequested: 0 }, canMerge: Boolean(p.canMerge), mergeBlockers: p.mergeBlockers ?? [],
    ...(p.protectedBase ? { protectedBase: true } : {}), ...(p.mergedSha ? { mergedSha: p.mergedSha } : {}), observedAt: new Date().toISOString(),
  });
  const adapter = {
    id: 'github',
    apiBase: (c) => c.baseUrl,
    hostsFor: (baseUrl) => [new URL(baseUrl).host],
    clientOptions: (c) => ({ apiBase: c.baseUrl, auth: { kind: 'bearer' } }),
    parseRemote: (url) => {
      const m = /[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?$/.exec(url.trim());
      return m ? { owner: m[1], name: m[2] } : undefined;
    },
    probe: async () => ({
      at: new Date().toISOString(), user: state.user, version: 'fake-1',
      capabilities: {
        repos: true, pulls: { create: true, comment: true, merge: true, draft: true, bodyMax: 65000 },
        items: { query: true, create: true, transition: true, comment: true, estimate: 'label', parentLink: false },
        iterations: 'milestone', checks: { read: true, rerun: false, logsUrl: false }, protection: { read: true },
      },
      scopes: { found: [], needed: [], missing: [], extra: [], reported: false }, warnings: [],
    }),
    repos: {
      get: async (_ctx, ref) => ({ ref, defaultBranch: state.defaultBranch, cloneUrl: state.cloneUrl, htmlUrl: `https://forge.test/${ref.owner}/${ref.name}`, private: false }),
      list: async () => [],
    },
    pulls: {
      find: async (_ctx, head) => { const p = [...state.pulls.values()].find(x => x.head === head && x.state === 'open'); return p ? pullState(p) : undefined; },
      create: async (_ctx, input) => {
        const p = { number: state.nextPull++, head: input.head, base: input.base, title: input.title, body: input.body, state: 'open', canMerge: false, mergeBlockers: ['required checks have not passed'] };
        state.pulls.set(p.number, p); state.createdBodies.push(input.body); state.writes.push(['pr.create', p.number, input.head, input.base]);
        return { pull: pullState(p) };
      },
      update: async (_ctx, id, patch) => { const p = state.pulls.get(Number(id)); Object.assign(p, patch); state.writes.push(['pr.update', Number(id)]); return pullState(p); },
      comment: async (_ctx, id, md) => { state.writes.push(['pr.comment', Number(id), md]); },
      get: async (_ctx, id) => pullState(state.pulls.get(Number(id))),
      comments: async (_ctx, id) => state.comments.get(Number(id)) ?? [],
      merge: async (_ctx, id, o) => { const p = state.pulls.get(Number(id)); state.writes.push(['pr.merge', Number(id), o.method, o.sha]); p.state = 'merged'; p.mergedSha = p.mergedSha ?? o.sha; return { sha: o.sha }; },
    },
    items: {
      query: async (_ctx, q) => {
        let list = [...state.items.values()].filter(i => i.state === 'open');
        if (q.source === 'label') list = list.filter(i => i.labels.includes(q.value));
        return { items: list.map(i => ({ ...i, labels: [...i.labels] })), notModified: false };
      },
      get: async (_ctx, id) => { const i = state.items.get(String(id)); if (!i) throw new ConnectionError('not found', 'not-found', 404); return { ...i, labels: [...i.labels] }; },
      create: async () => { throw new Error('not used'); },
      update: async () => { throw new Error('AICO must not edit a human field'); },
      transition: async (_ctx, id, to, ifRev) => {
        if (state.failTransition) throw new ConnectionError('revision changed', 'conflict', 409);
        const i = state.items.get(String(id));
        if (i.rev !== ifRev) throw new ConnectionError('revision changed', 'conflict', 409);
        i.state = to; touch(i); state.writes.push(['item.transition', String(id), to]); return { ...i, labels: [...i.labels] };
      },
      comment: async (_ctx, id, md) => { state.writes.push(['item.comment', String(id), md]); },
      addLabels: async (_ctx, id, labels) => { const i = state.items.get(String(id)); for (const l of labels) if (!i.labels.includes(l)) i.labels.push(l); touch(i); state.writes.push(['item.addLabels', String(id), labels.join(',')]); },
      removeLabel: async (_ctx, id, label) => { const i = state.items.get(String(id)); i.labels = i.labels.filter(l => l !== label); touch(i); state.writes.push(['item.removeLabel', String(id), label]); },
    },
  };
  const addItem = (n, over = {}) => {
    const item = {
      id: String(n), number: n, title: `Issue ${n}`, body: '', state: 'open', labels: [], assignees: [], author: 'octo-dev',
      url: `https://forge.test/octo/widgets/issues/${n}`, rev: rev(), ...over,
    };
    state.items.set(item.id, item);
    return item;
  };
  return { adapter, state, addItem, touch };
}
