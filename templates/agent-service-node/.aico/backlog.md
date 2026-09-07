# Backlog — __APP_TITLE__

Stories are vertical slices: tool → loop → route → test. Tick a box only when
its "Done when" was observed. Append iterations; never rewrite the ones above.

## Iteration 0 — from the template

- [x] Agent loop with tool calls fed back, bounded in steps, events for a listener.
      Done when: the four loop tests pass.
- [x] `calculate` and `now` tools; errors returned as text.
      Done when: the calculator test passes.
- [x] Conversations persisted; JSON and SSE message routes; health and readiness.
      Done when: the route tests pass.
- [x] Image builds and answers `/healthz`.
      Done when: `node deploy/docker.mjs` then `curl :3000/healthz` says ok.

## Iteration 1 — make it this agent

- [ ] Replace the system prompt with this agent's job, in one paragraph.
      Done when: a real model answers a domain question in `npm run dev`.
- [ ] Add the first real tool by copying `calculate` (an API call, a lookup, a file).
      Done when: a test drives it through the scripted model and the tool's own errors come back as text.
- [ ] Decide auth for the routes with the user (bearer token, or none behind a gateway).
      Done when: an unauthenticated POST answers 401 in a test.
