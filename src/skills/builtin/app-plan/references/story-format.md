# Story format

A story is one vertical slice, in the user's words, with a check that decides it.

```
- [ ] A customer can mark an invoice paid from the list.
      Done when: VerifyApp check "mark paid" — clicking Paid on a row flips its status pill to green and the open total drops.
```

Good "Done when" lines name something observable:

- a VerifyApp check by name, describing what is clicked and what is seen
- a RunChecks pass after the change ("typecheck and test pass with the new items.test.ts")
- a test by name ("test/items.test.ts: scopes toggle and delete to the owner")

Bad ones restate the story ("the feature works") or name an implementation ("add a column").

## PRD shape (one page)

```
# <App name> — PRD

## Purpose
One sentence, in the user's words.

## Users and the primary action
Who. The thing they do most often (tenth visit, not first).

## Scope
In: …  Out (deliberately): …

## Data
Noun (fields…) — relation — Noun (fields…)

## Done when
- … (checkable in a browser or by a test)

## Open questions / assumptions
- Assumed X because Y.
```
