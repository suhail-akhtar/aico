# 0016 — Learn how the user works as reviewed, scoped rules injected in the tail

- **Status:** Accepted (2026-10-03)
- **Deciders:** owner (asked for continuous learning from feedback, lean and cheap)
- **Related:** [ADR 0001](0001-append-only-session-log.md) (the log is the truth), AICO.md "everything volatile lives in the tail", `src/learning/` (proposals, `USER.md`)

## Context

AICO already turns a turn's log into *proposals* (knowledge entries, profile
facts, `USER.md` lines) that a person keeps or dismisses. What it did not do
was learn the person's *working preferences* from what they do every day —
the 👎 with "never use var", the "no, use pnpm", the file they re-indent by
hand a minute after the agent wrote it, the package manager they pick every
time — and apply them to the next task.

What the field shows (brief survey): assistants that remember do it with
**explicit memory the user can see and edit** (ChatGPT and Claude memories);
learning latent preferences **from user edits** works when the edit is
distilled into a short natural-language preference and retrieved by context
(CIPHER, "Aligning LLM Agents by Learning Latent Preference from User Edits",
Gao et al., 2024); and the known failure modes are **drift** (stale or
contradictory rules piling up) and **sycophancy** (personalisation teaching
the model to agree rather than to work well). Memory that writes itself into
the prompt without review is also a prompt-injection surface.

Constraints: the always-sent prefix must stay flat (cache); spend must be
negligible; nothing secret or personal may be stored or sent.

## Decision

1. **Signals, not rules, are captured automatically** (`src/learning/signals.ts`):
   👍/👎 *with a note* (`RunManager.rate`), correction sentences in the
   person's own messages (never a plugin's, never a question), a *diff summary*
   of hand edits to files/canvases the agent wrote in the last 30 minutes
   (before-images in memory only), and choices repeated ≥3 times across ≥2
   sessions at ≥75%. Every excerpt passes the vault sink redactor and the
   secret scanner; home paths and emails are masked.
2. **Distillation is one cheap call, off the critical path** (`src/learning/distill.ts`):
   debounced 4 s after a turn or rating with new signals, plus a 6-hourly
   batch for leftovers. The naming model (cheapest in the family, reasoning
   off, 800-token cap). The reply is parsed as data; without a usable reply a
   deterministic fallback keeps only the person's own standing statements and
   habits, word for word. Signals are consumed either way (no re-billing loop).
3. **Merging is deterministic code** (`mergeCandidates`): same rule (word
   overlap *and* order) → merged evidence; same topic + scope, different
   rule → a contradiction: a proposed rule is replaced at once, an active one
   only when the person accepts the replacement. Forgetting keeps a
   fingerprint so the identical rule is not proposed again. Rules that look
   like secrets, personal data, or instructions to agree/flatter are refused.
4. **Nothing is in force until a person accepts it.** Accept/enable/edit/add
   need a person (`human()` in `api-system.ts`; desktop: `HUMAN_ROUTES`), so a
   model holding the API token cannot write its own prompt. The opt-in
   `learning.autoAcceptStyle` (default off) auto-accepts only rules that
   `isLowRiskStyle` — decided in code by vocabulary, never by the model's label.
5. **Use: the volatile tail, capped** (`agent.ts` → `preferencesForTask`):
   active rules in scope (this project > this project's languages > global),
   ordered by scope, task-word overlap, evidence, recency; at most 400 tokens.
   Never in the system prompt; `USER.md` is untouched.
6. **One page in every client**: `web/src/components/settings/LearnedPane.tsx`,
   used by web Settings and desktop Settings ("What AICO learned"): view with
   evidence links, accept, decline, edit, disable, enable, forget, add, export.

## Alternatives considered

| Option | Why not |
|---|---|
| Write accepted rules into `USER.md` (cached prefix) | Scope and task decide which rules apply; per-project churn in the prefix re-bills every cached transcript. |
| Auto-apply distilled rules, let the user undo | A model's guess in the prompt without review is the drift and injection risk the survey warns about. |
| Embedding retrieval for relevance | A model call and an index before every turn for ≤400 tokens of rules; scope + word overlap is enough at this size (same trade as `knowledge/match.ts`). |
| Distil on every turn | Most turns carry no signal; a call per turn is cost for nothing. Signal-gated + debounced instead. |
| Store full edit diffs | File contents in `~/.aico` and in a model call for a style hint; a summary carries the preference. |

## Consequences

- **Good:** corrections stick across sessions and projects; the person sees
  and owns every rule; prefix caching is unaffected; cost is one small call
  per turn that carries a signal.
- **Bad / costs:** up to 400 tokens per step in the tail when rules exist; a
  second "learned" surface beside the older proposals (they overlap for 👎
  notes — knowledge is task-triggered, a preference rule applies by scope).
- **Honest limits:** correction detection is pattern-based (misses subtle
  steers; a 👎 note covers them); canvas edits count only the first save after
  an agent version; the topic for contradiction is the model's word except for
  the five topics code recognises (package manager, indentation, quotes,
  semicolons, test order); relevance is word overlap, not semantics.
- **Migration:** none — new files under `AICO_HOME/learning/preferences/`
  (`rules.json`, `signals.jsonl`, `choices.json`); `learning.preferences:
  false` switches the whole feature off.

## Threat model

- *Prompt injection via learned rules:* signals come only from the person's
  acts (human messages, their ratings, their edits); the distiller's output is
  a proposal; activation needs a person (not the token); auto-accept is
  limited to formatting vocabulary with no command/tool/permission words.
- *Secret/personal leakage:* redactor + scanner on every signal and rule text;
  refusal patterns for secret shapes, emails, phone numbers, personal topics.
- *Residual:* a person can accept a bad rule; the page shows evidence and
  what a rule replaces, and disable/forget need nothing.

## Verification

- `scripts/preferences-test.mjs` (in `npm test`): capture, parsing, merging,
  contradictions, refusals, auto-accept limits, scope selection, the cap, and
  an offline eval through `runAgent` showing an accepted "use pnpm, not npm"
  reaches the tail (not the prefix) and changes the next answer.
- `npm run test:preferences:live` (costs ~$0.01): real distillation proposes
  the pnpm rule; the same task answers `npm install lodash` before and
  `pnpm add lodash` after acceptance.
