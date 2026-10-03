# 0018 — Recall (memory by meaning) and "About you" (a learner the person controls)

- **Status:** Accepted (2026-10-03)
- **Deciders:** owner (asked for the best semantic memory and for AICO to learn the user deeply in the background)
- **Related:** [ADR 0001](0001-append-only-session-log.md), [ADR 0016](0016-learning-preferences.md), [ADR 0017](0017-model-roles.md), desktop `browser-learn*`, `browser-memory*`

## Context

An honest audit (2026-10-03) found four gaps.

1. **Engine memory has no relevance.** Every enabled memory is injected
   whole. Search is substring AND. There is no dedupe on write, no handling
   of contradictions, no recency weighting, and no recall of what happened in
   past sessions.
2. **Browser "memory by meaning" is lexical.** It is BM25 with synonyms and
   typo tolerance, and has no embeddings.
3. **No embeddings exist anywhere.**
4. **Signals are not combined into a picture of the person.** The browser
   already learns sites, routines, research threads and reading depth
   (`learn.json`). The engine already learns working preferences (ADR 0016).
   Nothing turns these into one picture: interests, expertise, stack, working
   style, likes and dislikes, browsing style.

What the field shows:

- Memory that works is hybrid retrieval, fusing lexical and vector results
  with recency and importance (Generative Agents; MemGPT/Letta; Mem0).
- Writes are consolidated: dedupe, update on contradiction, decay.
- The person can always see and edit what is kept, as in ChatGPT and Claude
  memories.

The failure modes are creepiness and over-reach (inferring sensitive traits),
stale facts, and memory as an injection surface.

## Decision

### Recall store (`src/recall/`)

- **One local store** in `aicoHome()/recall/recall.db` (`node:sqlite` with
  FTS5; no new dependency). It indexes:
  - memories and knowledge, mirrored from their files, which stay the truth;
  - **episodes**, one per finished session (title, the request, outcome,
    files and tools touched, built from the log with no model call);
  - About-you facts.
- **Hybrid retrieval.** FTS5 BM25 ⊕ cosine over embeddings, fused with
  reciprocal rank fusion. The result is multiplied by:
  - recency decay (half-life 30 days for episodes; none for memories the
    person wrote);
  - importance;
  - use.

  Embeddings exist only when the `embed` role resolves (ADR 0017). Words-only
  search is the default and works without any model.
- **Injection is ranked, and leaves the cached prefix alone for small
  stores.** At or below 30 memories (≤ 1,500 tokens), today's behaviour
  stands. Above that, pinned and global user memories stay in the prefix and
  the rest are recalled per turn into the volatile tail, budgeted at about
  600 tokens with relevance threshold, so nothing irrelevant is sent.
- **A `Recall` tool** searches past sessions, memories, knowledge and About
  you. It sits in a deferred group, and "what did we do last week…" style
  requests load it.
- **Write hygiene.**
  - A near-duplicate updates the existing entry instead of adding `-2`.
  - The same subject with a different value marks the older entry
    superseded and keeps its history.
  - Nightly upkeep (background role, cheap) merges duplicates and archives
    stale, low-importance, unused entries. Nothing is deleted.

### About you (`src/profile/` engine, desktop page)

- **A background learner, not a chat feature.** It runs at most every six
  hours when the machine is idle, with a daily spend cap (default $0.02),
  through the work supervisor. It reads:
  - **Engine sources:** languages, frameworks and tools from files and
    commands; active hours; project kinds; models chosen; ADR 0016 rules and
    feedback.
  - **Browser source:** a digest the desktop writes,
    `desktop/browser/profile-digest.json`. It is aggregates only: domains by
    category with time spent, research-thread topic terms, routines,
    reading depth (skims or reads), content kinds, and search *topic terms*,
    never full queries or URLs with paths.
- **Deterministic first.** Code turns the aggregates into candidate facts
  with evidence counts. One cheap call through the `background` role phrases
  and categorises them:
  - interests, expertise and stack, work patterns;
  - communication style, likes, dislikes;
  - browsing style, routines.

  The call receives aggregates only, redacted. With no model available,
  facts stay in their deterministic wording.
- **Never inferred: health, religion, politics, sexuality, ethnicity,
  finances, precise location, family or relationships.** A code filter drops
  any candidate or model output in these categories. The prompt is not the
  enforcement.
- **Each fact has a status:**
  - `inferred` facts with confidence ≥ 0.7 are used;
  - `confirmed` facts are always used;
  - `hidden` facts are never used;
  - forgotten facts leave only a fingerprint so they are not learned again.

  Every fact keeps its evidence: source, count and when last seen.
- **Use.** Facts relevant to the turn (via Recall) go into the volatile tail
  as `<about_user>`, at most about 250 tokens, framed as context and never as
  instructions. The browser copilot gets the browsing-relevant ones. Facts
  are never passed to third-party MCP servers.
- **Control.**
  - A switch for each source (work, browsing), pause, export and wipe.
  - The `private` preset (ADR 0017) keeps the learner local, or runs it with
    no model at all.
  - Incognito-like sessions, excluded sites and agent-driven pages never
    reach the digest; the browser learner already excludes them.
  - The desktop "About you" page shows every fact with its evidence and
    confirm, edit, hide and forget controls.

## Consequences

- Recall must be rebuilt from the files and logs when the database is
  missing. It is an index, not a source of truth (ADR 0001).
- Above the 30-memory threshold, memory injection changes from all to ranked.
  A memory the person wants always present must be pinned.
- The learner adds one cheap call every six hours at most.
