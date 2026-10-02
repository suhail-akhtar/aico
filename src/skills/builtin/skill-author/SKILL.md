---
name: skill-author
description: Drafts a new skill with its own evals, measures it against a no-skill baseline and tunes its description before anyone registers it. Use when asked to make a skill or capture conventions as one.
author: aico
version: 1.0.0
trigger: \b((make|create|write|generate|draft|author|build)( \w+){0,3} skills?|skills? (for|from) (our|the|my|team)|capture( \w+){0,3} conventions)\b
---
A skill is worth installing only if it measurably helps. This procedure drafts one, proves it against the same model without it, and stops at the person's decision. {args}

## 1. Capture the intent

- From the conversation: the task the skill is for, what "done well" looks like, and what it must not do. Ask one question if the purpose is unclear; do not guess a domain.
- From a repository's conventions, read sources rather than inventing rules: `CodebaseMap`, then ADRs, CONTRIBUTING, lint/format configs, CI files, and two or three representative files. Note each rule with the file it came from.
- Keep only what the model would get wrong without being told. General good practice it already follows is noise that costs tokens on every use.

## 2. Draft

Write with `SkillManage action:"create"`, which makes an unregistered draft:

- `name`: lowercase, hyphens, ≤ 64 characters.
- `description`: third person; what it does, then "Use when …" with the kinds of request. Under 200 characters. This line is the whole selection decision.
- `prompt` (the body): the steps in order, imperative, specific to this project. Under 500 lines; aim for far less. Put long reference material in `references/<topic>.md` (one level deep) and say when to read it.
- `scripts/` only for deterministic steps (a check, a generator), never for judgement.
- Ship the evals (step 3) as `resources` in the same call.

## 3. Write the evals

`evals/evals.json`, skill-creator's shape plus AICO's checks:

```json
{
  "skill_name": "<name>",
  "evals": [
    {
      "id": 1,
      "prompt": "A realistic request this skill is for, as a person would type it.",
      "files": { "src/example.ts": "fixture content the task works on" },
      "expectations": ["/regex the reply must match/i", "!/regex it must not match/i"],
      "checks": [
        { "kind": "file-matches", "path": "src/example.ts", "pattern": "…", "why": "what a miss means" },
        { "kind": "max-tool-calls", "limit": 12, "why": "it should not need more" }
      ]
    }
  ],
  "triggers": [
    { "query": "a request that should open this skill", "should_trigger": true },
    { "query": "a nearby request that should not", "should_trigger": false }
  ]
}
```

- At least three tasks. Every task needs a deterministic check: `output-matches`, `output-lacks`, `file-exists`, `file-matches`, `no-file-changed`, `max-tool-calls`, or an expectation written as `/regex/`. Prose expectations are reported, not scored.
- Each task must test what the skill adds — a convention the bare model would miss. A task the model passes anyway proves nothing.
- Ten or more trigger queries, about half should trigger. Make the negatives near misses (same area, different job), not unrelated chatter.
- Show the person the tasks and the trigger list before measuring, since the author of a skill grading its own tasks is the weak spot.

## 4. Verify, then measure

1. `SkillManage action:"verify"` — fix every problem it lists.
2. `SkillManage action:"eval" name:"<name>"` — runs each task with and without the skill on the current model, scores triggering on held-out queries, and tunes the description. It spends money within a ceiling (default $0.25); say the ceiling before running.

## 5. Iterate, boundedly

- Uplift ≤ 0: the skill does not help. Cut what the model already does, sharpen what it misses, then measure again. If two rounds do not help, say so and recommend not installing it.
- Low trigger precision or recall: the eval already tries a better description; otherwise rewrite the "Use when" clause yourself.
- Any edit changes the files, so measure again — `register` refuses a report for different files.

## 6. Show the person

Report the numbers as the eval returned them: with vs without per task and the mean uplift, trigger precision/recall on held-out queries, the description before and after, and the cost. Then stop. Registering is the person's decision; `register` refuses a draft whose evals are unmeasured or stale, and only a person can register one that did not beat the baseline.
