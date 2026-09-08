---
name: app-architecture
description: Decide where a feature lives before writing it — data model first, one layout per stack, feature slices, boundaries, reuse before new code — and record the decision. Use when adding a feature, module, table or integration to an app.
author: aico
version: 1.0.0
trigger: \b(where should|structure|architect|architecture|organi[sz]e|layout|data model|schema|boundar|module|add (a|the) (feature|table|route|endpoint|page|integration))\b
---
Place the work before doing it. This is a short pass, not a design document. {args}

## 1. Profile first, files second

Read the project profile in your context (stack, commands). If there is none, read `AICO.md` if the app has one, then the manifest. Do not re-derive what is already stated.

## 2. Data model first

Name the nouns this feature adds or changes and their fields, constraints and relations — in one short block, before any route or screen. A constraint the database holds (NOT NULL, CHECK, REFERENCES, UNIQUE) is one the code cannot forget; prefer it to validation in three places. Migrations are append-only: a deployed database has already run the earlier ones.

## 3. One layout per stack — follow the worked feature

Find the feature that already exists (a templated app names it in `docs/EXTENDING.md`; otherwise the most recently changed feature) and copy its shape exactly: same folder pattern, same file names by role, same test location. A feature is a **slice** — data, logic, interface, test — kept together by name, not spread across layer folders. New code that does not match the neighbouring code is wrong even when it works.

## 4. Boundaries

- Interface reads and calls; it never holds SQL or business rules.
- Logic takes the store and the acting user as parameters; it never reads the request.
- Anything that talks to the outside (HTTP, filesystem, clock, random) is at the edge and injectable, so tests run in memory.
- Authorisation is checked where the action runs, never only where the button is drawn.

## 5. Reuse before write

Before adding a helper, component or utility, search for one: Grep the name, the concept, and the neighbouring feature. When one exists, name it and use it — never write a second beside it. Extending what exists beats a second copy; a second copy beats a premature abstraction. A placement question is answered in words: it needs no edit, and about eight tool calls.

## 6. Record the decision

When a choice is not obvious from the code — a new table instead of a column, a queue instead of a call, a library instead of the built-in — append one line to `.aico/decisions.md`: what, and why. Compaction keeps that file when it drops the transcript.

## 7. Stop if the ground is unclear

If more than two questions remain open after 1–5 (which noun owns the data, whether this is one feature or two, whether an existing module should change), list them with AskUserQuestion and stop. Building on a guess costs more than asking.

## Do not

- Start with the screen, or with an endpoint, before the data is named.
- Introduce a second pattern for something the codebase already does one way.
- Add a dependency for what the standard library or the existing stack provides.
- Spread one feature across `models/`, `services/`, `controllers/` folders when the codebase keeps features together — or the reverse.
