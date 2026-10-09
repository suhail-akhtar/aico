---
name: design-board
description: Produce a clickable UI mockup as a design board — standalone HTML screens on a zoomable canvas, grouped in sections, linked to each other, with Play and Present. Use when asked for a mockup, prototype, wireframe, screen designs, a UX or user flow, or "show me what the app would look like" before (or instead of) building it.
author: aico
version: 1.0.0
trigger: \b(mock[- ]?ups?|wire-?frames?|prototypes?|clickable (demo|design|flow)|ux flows?|user flows?|screen (designs?|flows?)|design board|(design|mock) (the |some |a few )?screens)\b
antiTrigger: \b(bugs?|root cause|regression|stack ?trace|traceback|crash(es|ed|ing)?|unit tests?|mock (data|server|api|function|object)s?|jest\.mock|vi\.mock)\b
---
A board shows a product before it exists: real screens a person can click through, not pictures of boxes. Tool: `DesignBoard`. {args}

## 1. Decide before drawing

Write the direction first (skill ui-craft §1): purpose and person, a tone word pair, the one memorable thing. Then list the screens as a flow, grouped into 2–4 sections named for what the person is doing ("Today and the start", "Making things", "Settings and account"). Five to ten screens is a board; thirty is a backlog.

## 2. Build it in this order

1. `create {title}` — the board.
2. `write_file {path: "styles.css"}` — the whole visual system once: tokens (type pair and scale, neutrals with a hint of the brand hue, one accent, radius, spacing, shadow) as CSS variables, then the shared shell (sidebar, top bar, buttons, inputs, cards, tables). Every screen links it; no screen restyles the basics.
3. `add_frame` once per screen, in flow order, with the section, a title people would use, `file` like `Workspace.html`, and one device for the board (`desktop` 1440×900 unless the product is mobile — then `mobile`). Add a `note` naming the state shown ("empty", "after first save").
4. `get` — fix every broken link, unreachable screen and missing file it lists.

## 3. What makes the screens real

- Realistic content: names, dates, amounts, messages a real customer would have — never lorem, "Item 1" or "John Doe".
- Every screen reachable: the nav links to its peers, primary buttons go where they would go, a detail has a way back. Plain relative links: `<a href="Settings.html">`. Hash links and scripts for local state (tabs, a menu) are fine.
- No network in previews: no remote pictures, fonts or APIs. Use inline SVG, CSS shapes, data: URLs, or copy files in with `write_file {from}`. Fonts: a system stack, or a font copied in. Scripts and styles may come only from cdnjs, jsDelivr or unpkg.
- States worth seeing get their own frame (empty, filled, error) rather than a toggle nobody finds.

## 4. Look, then fix

`export {format: "png"}` and Read the pictures. Critique against the direction in writing — alignment, hierarchy, contrast, spacing rhythm, does each screen show what it is for at a glance — fix the three worst with `update_frame`, and look again. Tell the person the board is in the Artifacts panel: Play opens a screen full size and its links work; Present walks the screens in order.

## Do not

Draw boxes with "Image here", vary the device size between screens of one flow, restyle buttons per screen, leave a dead link, or build the real app's code when a mockup was asked for.
