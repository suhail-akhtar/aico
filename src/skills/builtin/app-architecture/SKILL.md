---
name: app-architecture
description: Decide where a feature lives before writing it — data model, layout, slices, boundaries, reuse — and record the decision. Use when adding a feature, module, table or integration.
author: aico
version: 1.0.0
trigger: \b(where should|structure|architect|architecture|organi[sz]e|layout|data model|schema|boundar|module|add (a|the) (feature|table|route|endpoint|page|integration))\b
---
Place the work before doing it. This is a short pass, not a design document. {args}

## 1. Profile first, files second

Read the project profile in context (stack, commands), or `AICO.md`, or the manifest. Do not re-derive what is already stated.

## 2. Data model first

Name the nouns this feature adds or changes, their fields, constraints and relations — one short block, before any route or screen. A constraint the database holds (NOT NULL, CHECK, REFERENCES, UNIQUE) is one the code cannot forget. Migrations are append-only: a deployed database already ran the earlier ones.

## 3. One layout per stack — follow the worked feature

Find the feature that already exists (a template names it in `docs/EXTENDING.md`; otherwise the most recently changed) and copy its shape: folder pattern, file names by role, test location. A feature is a **slice** — data, logic, interface, test — kept together, not spread across layers. Code that does not match neighbouring code is wrong even when it works.

State the new feature's file paths by name — the worked feature's own real paths, resource swapped, never a remembered example from another stack — and where it wires in. Prose without named paths has not placed anything.

## 4. A concern touching many features is not a feature slice

When one behaviour cuts across several resources — pagination, an auth check, rate limiting — there is no single worked feature to copy. Name one shared file, state it by path, and name each call site that would use it — never duplicate per resource. Carry every number in the brief (a cap, a default) into the design; dropping one is a silent scope cut. Record it in `.aico/decisions.md` (step 7) — centralising is not obvious from the code.

## 5. Boundaries

- Interface reads and calls; never holds SQL or business rules.
- Logic takes the store and acting user as parameters; never reads the request.
- Anything touching the outside (HTTP, filesystem, clock, random) is at the edge and injectable, so tests run in memory.
- Authorisation is checked where the action runs, not only where the button is drawn.

## 6. Reuse before write

Before adding a helper or utility, search: Grep the name, the concept, the neighbouring feature. When one exists, name and use it — never write a second. Extending beats a copy; a copy beats a premature abstraction. Answered in words — no edit, about eight tool calls.

## 7. Record the decision

Record decisions not obvious from the code (a table vs a column, a queue vs a call, a library vs the built-in) in `.aico/decisions.md`, one line: what and why. It survives compaction.

## 8. Stop if the ground is unclear

If more than two questions remain after 1–6, list them with AskUserQuestion and stop. Building on a guess costs more than asking.

## Do not

- Start with the screen, or an endpoint, before the data is named.
- Introduce a second pattern for something the codebase already does one way.
- Add a dependency for what the standard library or existing stack provides.
- Spread one feature across `models/`, `services/`, `controllers/` when the codebase keeps features together — or the reverse.
