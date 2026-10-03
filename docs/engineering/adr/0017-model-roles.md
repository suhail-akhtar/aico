# 0017 — Model roles: one table decides which model does which job

- **Status:** Accepted (2026-10-03)
- **Deciders:** owner (asked for mixing models per operation, "designed very carefully")
- **Related:** [ADR 0015](0015-sentinel-reviewer.md) (Sentinel independence), [ADR 0016](0016-learning-preferences.md), [ADR 0018](0018-recall-and-about-you.md), `src/models/roles.ts`

## Context

Nine features already ran on a model other than the chat's, and each chose
it in its own way:

- `sessionTitles.model`, `learning.model`, `brief.model` and `sentinel.model`;
- `agentModels[type]`;
- `imageGeneration.model`;
- the judge's hard-coded default;
- `pickNamingModel`.

Nothing showed the person which model, provider or price each job used. A
typo fell back to the work model without a word. The features that read
personal data, the learner and soon embeddings, could be sent to any
provider without the person being told.

What can go wrong when models are mixed:

1. **Data goes to a provider the person did not choose.** A role pointed at a
   cloud model reads browsing or memories.
2. **A safety role gets weaker.** A project file picks a tiny Sentinel, or
   the Sentinel is the same model as the agent it reviews.
3. **A silent capability mismatch.** A vision role that cannot see, an
   embedder that is a chat model, or a coding sub-agent on a model too weak
   to edit.
4. **Cache loss.** Summarising on a different model throws away the cached
   prefix that made summaries cheap.
5. **Cost surprise.** A role pointed at an expensive model.

## Decision

1. **Eleven fixed roles** (`src/models/roles.ts` `ROLES`):
   - main, coding, explore, review;
   - background (titles, brief, learner, memory upkeep);
   - sentinel, judge;
   - vision (describes images for a text-only main model), image;
   - embed, compact.

   Each role declares what it **needs** (chat, vision, image-out or
   embedding) and whether it is **personal** (reads the person's own data
   beyond this turn).
2. **One resolver, one order:**
   1. a per-call override (an agent's `model:`, a CLI flag, `Task.model`);
   2. `models.roles[role]`;
   3. the legacy per-feature key, which keeps working;
   4. the preset;
   5. the role's default.

   Every caller asks `resolveRole`. None picks a model on its own.
3. **Presets change roles, never turns:**
   - `balanced` is the default and today's behaviour.
   - `economy` sends explore and review to the family's cheap model.
   - `quality` uses the main model everywhere.
   - `private` keeps personal roles local.

   Per-request routing by difficulty is rejected for now. It needs an eval
   per task type, and a wrong guess on a hard step costs more than it saves.
4. **A broken choice falls back with a reason, never silently.** The reason
   (`fellBack`) appears in Settings and `/doctor`.
5. **Personal data never falls back to a cloud provider.** With
   `localOnlyPersonal` (or the `private` preset), a personal role that does
   not resolve to a local endpoint comes back `ok: false`. The feature then
   runs without a model (deterministic) or pauses. It is never re-routed to
   the work model's vendor.
6. **Only the person's own settings choose.** `models` in a project's
   `.aico/settings.json` is ignored, so a cloned repository cannot re-route
   personal data or pick the Sentinel.
7. **Independence is preferred and reported.** The Sentinel and the judge
   default to a different model from the agent's when one is reachable. Using
   the same model is allowed but flagged.
8. **Compaction defaults to the main model.** Moving it is allowed, and the
   page says it costs the cache.
9. **Vision fallback.** When the main model cannot accept images and a vision
   role resolves, the attached image is described by the vision model. The
   description enters the turn as text marked as a description. The image is
   sent only to the provider the person chose for vision.
10. **Visible cost.** The settings page shows each role's model, provider,
    local or cloud, price per million tokens, and its source (set, legacy,
    preset or default). Spend is recorded per role.

## Consequences

- Legacy keys keep working, so no settings migration is needed.
- New features must add a role rather than a key.
- The project-layer rule means a team cannot share role choices in the repo.
  That is deliberate, and per-user settings remain.
