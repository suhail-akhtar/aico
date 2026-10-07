---
name: ui-craft
description: Decide how a UI should look and feel before building it, then build it with real craft — a stated direction, a type pair, a palette with one accent, composition, depth, motion and finished details; for any interface, browser, desktop app, site or dashboard where taste matters. Use when asked to design, redesign or make something beautiful, modern, premium or unlike a template, and before building any UI from scratch.
author: aico
version: 1.0.0
trigger: \b(beautiful|gorgeous|stunning|modern|premium|elegant|aesthetic|stylish|sleek|slick|awful|ugly|bland|generic|look(s)? (cheap|boring|dated|like a template)|design (a|the|my|an)|redesign|ui ?/ ?ux|ux|from scratch|custom browser|desktop app|landing page|portfolio|brand)\b
antiTrigger: \b(bugs?|root cause|regression|stack ?trace|traceback|crash(es|ed|ing)?|data loss|sql|cli|no ui)\b
---
A generic interface is a failure even when it works. Decide the look, write it down, build to it, then look at it and fix what is weak. {args}

## 1. Direction first (three lines, before any code)

Write these in `.aico/decisions.md` (or the reply): **Purpose and person** (who uses it, doing what, how often); **Tone** — one committed word pair, e.g. "calm and exact", "warm editorial", "dense and technical", "playful but trustworthy" (never "clean and modern" — that is the default, not a choice); **The one memorable thing** (a signature: an unusual layout, a distinctive header, a motion, a texture). Everything below serves these lines. Match ambition to the job: a tool people live in is quiet and fast; a landing page or product shell earns one bold move.

## 2. Type is most of the design

One pair, loaded for real (a bundled or `@fontsource` font, never a hope that the system has it): a characterful display face for titles and a plain, readable text face. Not Inter/Roboto/Arial/system as the whole identity. A scale with a clear ratio (1.2–1.333), tight tracking on large titles, line-height 1.5 body and 1.15 titles, `tabular-nums` for numbers, measure ≤ 72ch. Weight and size carry hierarchy; colour does not do it alone.

## 3. Colour with a plan

Neutrals with a hint of the brand hue (not pure grey), one accent used for the primary action and focus only, status colours kept for status. Build the palette as tokens in both light and dark from the start (HSL/OKLCH steps, not eleven unrelated hexes). Check contrast ≥ 4.5:1. Avoid the default purple-to-blue gradient on white; avoid a gradient on every surface.

## 4. Composition and depth

Align to a grid and let one element break it on purpose. Use scale contrast (a very large number or title beside small meta text), generous space around the primary thing, asymmetry over three identical cards in a row. Depth from layered surfaces, a hairline border and one soft shadow level, not a shadow on everything. One radius family. Real imagery, illustration or a generated texture beats an empty rectangle; no emoji as icons — use one icon set at one stroke width.

## 5. Motion that means something

150–250 ms ease-out for state changes, one orchestrated entrance on load (staggered, not everything at once), hover and focus feedback on every control, skeletons shaped like content, and `prefers-reduced-motion` respected. Motion shows cause and effect; decoration that loops is noise.

## 6. A browser, a desktop shell, a tool (not a page)

Chrome is part of the product: title/tab strip with clear active state and close/overflow behaviour, a toolbar with grouped, consistently sized controls and visible disabled states, a command surface (palette or address bar) that is fast and focused, sensible empty and error states (a blank new tab is a designed screen), keyboard shortcuts shown in tooltips, resizable panes with remembered sizes, and light/dark that both look intended. It must open, load a real page, and survive a resize before it is called done.

## 7. Look at it, then fix it

Open the real thing (`VerifyApp` or a screenshot) at 1280px and 390px and critique it against §1 in writing: what is generic, cramped, misaligned, low-contrast, unfinished? Fix the three worst, look again. Done is when a stranger can name the tone you chose.

## Do not

Ship default browser styles, lorem or "Item 1", an unstyled `<button>`, a centred hero over a stock gradient as the whole design, ten font sizes, borders and shadows on every box, or a long task's first screen as "good enough" — design is where long builds fail first, so do it at the start, not as a last pass.
