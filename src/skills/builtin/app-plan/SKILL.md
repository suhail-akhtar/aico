---
name: app-plan
description: Turn a brief for an app, site, service or API into a one-page PRD and a backlog of vertical slices with "Done when" checks — before writing code. Use when asked to build, create, plan or design an application.
author: aico
version: 1.0.0
trigger: \b(build|create|make|plan|design|scaffold)\b.{0,40}\b(app|application|saas|site|website|service|api|dashboard|portal|tool|bot|platform)\b
---
Plan the app before building it. Small brief, small plan: the whole of this fits on one page and takes one turn. {args}

## 1. The brief — three questions at most

If the brief does not answer these, ask them with AskUserQuestion, all in one call, and stop until answered:
- Who uses it, and what do they do on their **tenth** visit (not their first)? That action is the primary one.
- What must be true when it is done? One sentence a person could check.
- What already exists — data, accounts, an API, a design — that this must fit?

Do not ask about the stack: an app made from a template already has one (read its `AICO.md`); otherwise the project profile says.

## 2. `docs/PRD.md` — one page

Write it with Write. Sections, each a few lines:
- **Purpose** — one sentence, the user's words.
- **Users and the primary action** — who, and the thing done most often.
- **Scope** — in this iteration / deliberately not.
- **Data** — the two to five nouns and how they relate. Real fields, not "etc."
- **Done when** — three to six statements, each checkable in a browser or by a test.
- **Open questions** — anything you assumed; say what you assumed.

## 3. `.aico/backlog.md` — vertical slices

Append an iteration to `.aico/backlog.md` (create it if absent). Each story is a **vertical slice** — data → logic → screen → check — never "build the backend" then "build the frontend". Format, exactly:

```
## Iteration N — <what the reader can do at the end>

- [ ] <Story in the user's words>.
      Done when: <a VerifyApp check by name, or a RunChecks pass, or a test name>.
```

Order by the reader's tenth visit: the primary action first, sign-in and settings last. Three to seven stories; more is a second iteration.

## 4. Mirror into TodoWrite

Put every story in TodoWrite with the same words, so the completion gate holds the turn to the plan. Tick a todo only when its "Done when" was observed.

## 5. Then build

For each story in order: copy the worked feature in `docs/EXTENDING.md`, run RunChecks, then AppManage start and VerifyApp with a check named after the story's "Done when". Tick the story in `.aico/backlog.md` and the todo. When you settle a design choice that is not obvious from the code, append one line to `.aico/decisions.md`: what, and why.

## Do not

- Write code before the PRD and backlog exist.
- Ask more than three questions, or ask any that the template's `AICO.md` answers.
- Plan a second iteration's stories in detail; name them in one line each under "Later".
- Use a sub-agent team. One agent builds; `Investigate` may research.
