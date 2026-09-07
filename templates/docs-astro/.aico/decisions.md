# Decisions — __APP_TITLE__

One line per decision: what, and why. Append; do not edit old lines. Compaction
keeps this file when it drops the transcript.

- Astro with content collections, no docs framework — a sidebar and a Markdown
  renderer are forty lines; a framework brings a theme to fight and a search index
  to host.
- Static output — the site is files; nginx or any static host serves it, and there
  is nothing to keep running.
- Sidebar from frontmatter (`section`, `order`) rather than a hand-kept list —
  adding a page is adding a file, and the list cannot drift from the pages.
- The sidebar logic is a pure module with tests — the one piece of behaviour on
  the site is tested without a browser.
- No search — a docs site under fifty pages is browsed, not searched; add Pagefind
  when the count says otherwise.
