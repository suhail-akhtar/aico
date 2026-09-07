# __APP_TITLE__

__APP_DESCRIPTION__

A documentation site on [Astro](https://astro.build). Write a Markdown file,
get a page with a sidebar entry; build to static files; serve from anywhere.

## Run

```sh
npm install
npm run dev                     # http://localhost:4321
```

Add a page: `src/content/docs/my-topic.md` with `title:` in its frontmatter.

## Check

```sh
npm run typecheck               # astro check
npm test                        # the sidebar logic
npm run build && npm run preview
```

## Deploy

Static files in `dist/` after `npm run build`. Any static host takes the folder
as-is. `node deploy/docker.mjs` builds an nginx image. See `deploy/README.md`.

## Structure

```
src/content/docs/     the pages (Markdown + frontmatter)
src/content.config.ts frontmatter schema
src/lib/nav.ts        sidebar and prev/next, tested
src/layouts/Docs.astro
src/pages/            index and the doc route
src/styles/site.css   tokens, light and dark
```
