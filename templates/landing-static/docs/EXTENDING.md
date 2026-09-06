# Extending this page

## Add a section

1. Copy an existing `<section id="…">` in `public/index.html` and give it a new
   id and heading. Keep heading order (`h2` for a section, `h3` inside it).
2. Add a link to it in the `<nav>` list, in the same order as on the page.
3. If it needs styling beyond the existing components, add a block at the end of
   `public/styles.css` named after the section (`.section-team`), using tokens.
4. Open the page with `VerifyApp` and check: the nav link scrolls to it, it reads
   on a 390px viewport, nothing overflows horizontally.

## Add a page

Create `public/<name>.html` by copying `index.html`'s `<head>`, header and footer.
Link it from the footer. Every page keeps the same `styles.css` and `main.js`.

## Add an image

Put it under `public/img/`, reference it as `/img/<file>`, always with `alt`.
Prefer SVG for illustrations and logos; compress photographs before adding them.
Set `width` and `height` attributes so the layout does not shift while loading.

## Change the look

Edit the tokens at the top of `public/styles.css` — `--brand`, `--ink`, `--bg`,
`--radius`, the type scale. Nothing else should need to change for a rebrand.

## What not to do

- No CDN scripts, fonts or images: the CSP forbids them and they break offline.
- No inline styles or event handlers: they defeat the CSP and the token system.
- No framework: if the page grows real state, it is no longer a landing page —
  create an app from the `web-saas-next` template and link to it from here.
