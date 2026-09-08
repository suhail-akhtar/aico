---
name: app-design
description: Make a screen look and behave like a product people pay for — one shell, a clear hierarchy, tokens not hex, real empty, loading and error states, forms and tables that read at a glance, proven at 1280px and 390px. Use when asked to design, style, polish or make a UI look professional, or when building any screen a person will use.
author: aico
version: 1.0.0
trigger: \b(design|ui|ux|look and feel|looks? (good|bad|professional|ugly)|polish|professional|beautiful|good.looking|layout|styling|theme|responsive|dashboard)\b
---
Design is decided before the first component and checked in a screenshot after the last. A screen is done when a stranger can tell what it is for, what to do first, and what just happened. Sketches: `references/patterns.md`. {args}

## 1. One shell, chosen once

Signed-out pages sell: one hero, one primary action, a short feature list. Signed-in pages work: side navigation on wide screens (a menu button under `md`), a page header — title, one line of context, the primary action on the right — then the content. The shell lives in the layout, never per page. Working screens in a column ≤ 1,200px; reading ≤ 72ch.

## 2. Hierarchy and rhythm

- One primary button per screen; the rest are ghost buttons or links. Destructive is never the primary colour.
- Spacing on a 4px scale (4/8/12/16/24/32/48): related things close, sections further apart than what is inside them.
- Type on a scale — 12 meta, 14 tables and forms, 16 body, 20 section, 24–30 page title — two weights at most. Secondary text is muted, not smaller *and* muted.
- Numbers right-aligned with `tabular-nums`; money grouped, with currency and two decimals; one date format.

## 3. Colour through tokens

Components use the theme's tokens (`brand`, `ink`, `ink-muted`, `surface`, `surface-alt`, `line`, `danger`, `success`, `warning`), never a raw hex. One brand hue. Status colours mean status only and always come with a word. Contrast ≥ 4.5:1 in light and dark; dark mode is the same tokens, other values.

## 4. Every state is a real screen

- **Empty**: what the list is for, and the action that makes the first thing — never a bare "No results".
- **Loading**: skeletons in the content's shape, never a blank page.
- **Error**: what went wrong, where, in the user's words, and what to do; inline for a field, a banner for a page.
- **Success**: the screen visibly changes — the row appears, the count moves.

## 5. Forms and tables

Labels above fields, help below, required marked. The button says the verb ("Create invoice"). Errors beside the field, the first one focused. Tables: ≤ 7 columns, the name first and widest, money `text-right tabular-nums` always, status as a pill with a word, actions last, the row a link when a detail page exists. Destructive actions take two steps.

## 6. Responsive and reachable

At 390px the navigation collapses, tables scroll in their own box or become cards, nothing overflows, tap targets ≥ 40px. Keyboard reaches everything, focus is visible, Escape closes, Enter submits. Landmarks, one `h1`, labelled controls, `alt` on images.

## 7. Prove it, then write it down

`VerifyApp` at 1280px and 390px with a screenshot each, plus one check that an empty or error state renders. Record the shell and any departure in `.aico/decisions.md`.

## Do not

- Ship placeholder copy (lorem, "Item 1") or emoji as icons.
- Shadow every card, gradient every heading, vary the radius.
- The admin-panel look: dense grey tables, no hierarchy, no empty states.
- A modal where a page will do; tokens restyled per feature.
