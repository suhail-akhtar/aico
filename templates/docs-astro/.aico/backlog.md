# Backlog — __APP_TITLE__

Stories are vertical slices: a page → its sidebar entry → checked in the
browser. Tick a box only when its "Done when" was observed.

## Iteration 0 — from the template

- [x] Markdown pages with validated frontmatter become routes with a generated sidebar.
      Done when: `npm run build` emits `/docs/getting-started/` and `/docs/reference/`.
- [x] Sidebar grouping, ordering, drafts, prev/next.
      Done when: the nav tests pass.
- [x] Mobile menu, dark mode, on-this-page list.
      Done when: VerifyApp at 390px opens the menu; a page with three `##` shows the list.
- [x] Image builds and serves the site.
      Done when: `node deploy/docker.mjs` then `curl :8080/` returns the home page.

## Iteration 1 — make it this site

- [ ] Replace the two placeholder pages with the real first section (three to five pages).
      Done when: no page contains the word "placeholder" (Grep).
- [ ] Decide the sections with the user (Guide / Reference / …).
      Done when: every page has a `section` and the sidebar reads in the intended order.
- [ ] Add the site's name and a favicon.
      Done when: the tab shows both.
