# Extending this site

## Add a page (the main move)

Create `src/content/docs/<id>.md`:

```md
---
title: Deploying
description: One sentence for the sidebar tooltip and search engines.
section: Guide
order: 3
---

## First heading
```

That is all: the route is `/docs/<id>/`, the sidebar entry appears under its
section in `order`. Two `##` or more get an on-this-page list. Draft it with
`draft: true` until it is ready.

## Add a section

Use a new `section` value in frontmatter; it appears when its first page does.
Keep to three or four sections; more is a second site.

## Add search

`npx astro add pagefind` (or `@pagefind/default-ui`) after `astro build`; wire
the UI into `Docs.astro`. Do this when the page count makes browsing slow.

## Add a landing page or a blog

Another collection in `src/content.config.ts` with its own loader and schema,
a route under `src/pages/`, and a layout that extends `Docs.astro` or replaces it.

## Change the look

`src/styles/site.css` tokens in `:root` (and the dark block). Components below
them. No CSS in the pages.

## What not to do

- No hand-maintained navigation list; the sidebar comes from frontmatter.
- No client-side rendering of content; it is static HTML.
- No CDN scripts or fonts.
- No page without a `title`; the build refuses it on purpose.
