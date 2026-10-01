---
name: test-strategy
description: Choose what to test at which level, write tests that would catch a wrong implementation, and run them. Use when adding or fixing tests, raising coverage, or fixing a flaky test.
author: aico
version: 1.0.0
trigger: \b((write|add|improve|missing|more|fix)( \w+){0,3} tests?|test (coverage|strategy|plan|suite)|coverage|flaky|unit tests?|integration tests?|e2e|end.to.end tests?|regression tests?)\b
---
A test is evidence that behaviour is right and stays right. {args}

## 1. Use what the project uses

Find the runner, the folder layout and the helpers from the manifest and two existing tests, and copy their style. No new framework unless the existing one cannot do what is needed — say what.

## 2. Pick the level by what can break

- Pure logic (calculation, parsing, rules, state transitions): unit tests, many cases, fast.
- Code at a boundary (queries, HTTP handlers, queues, files): integration tests against the real thing where it is cheap (an in-memory or temporary database, a local server), not a mock of it.
- A user-visible flow: one end-to-end test per critical path, not one per screen.
- A contract with another service: a test on the shape both sides rely on.

Mock only what is slow, non-deterministic or outside (network, clock, randomness), and inject it rather than patching globals.

## 3. Cases that earn their place

For each behaviour: the expected path, each boundary (zero, one, maximum, empty, missing), each error the code handles, and each rule from the requirements by name. A bug fix starts with a test that fails on the old code — run it and watch it fail before fixing. Name each test as a sentence about behaviour.

## 4. Would it catch a wrong implementation?

For each test, name a plausible bug that would still pass it — a missing guard, an unsorted list, an update lost on reload. If one would, strengthen the assertion. A test that only checks something exists, or computes its expected value with the code under test, proves nothing.

## 5. Deterministic, or it is a bug

No sleeps (wait on a condition), no wall clock or randomness without injection or a seed, no order dependence between tests, no real network. For a flaky test, find the shared state or timing it depends on; adding retries hides the bug.

## 6. Run and report

Run the narrowest suite while iterating, then RunChecks. Report the tests added (file, what each proves), the command, the pass count, and what is still untested.
