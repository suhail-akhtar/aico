# __APP_TITLE__

A documentation site on Astro. Markdown files under `src/content/docs/` are
pages; the sidebar is generated from their frontmatter; the build is static
files served by nginx in the image or by any static host.

## Layout

- `src/content/docs/*.md` — the pages. Frontmatter: `title` (required),
  `description`, `section` (sidebar heading, default "Guide"), `order` (lower
  first), `draft` (hidden). Validated by `src/content.config.ts`.
- `src/lib/nav.ts` — `buildNav` and `neighbours`: the sidebar and prev/next,
  pure and tested in `test/`.
- `src/layouts/Docs.astro` — header, sidebar, content, pager, mobile menu.
- `src/pages/index.astro` — the home page; `src/pages/docs/[...slug].astro` —
  every doc page, with an on-this-page list when there are more than two `##`.
- `src/styles/site.css` — tokens in `:root`, light and dark, then components.

## Conventions

- One page per topic; `##` headings for sections (they become the on-page list).
- Sections are frontmatter `section` values; keep to three or four.
- Code blocks fenced with a language. Relative links between pages as `/docs/<id>/`.
- No client JavaScript beyond the menu toggle; no CDN.

## Checks

`npm run typecheck` (astro check), `npm test`, `npm run build`. Then
`AppManage start` and `VerifyApp`: the sidebar lists every page, a page
renders, the prev/next links work, the menu opens at 390px.
