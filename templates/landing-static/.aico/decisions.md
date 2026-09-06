# Decisions — __APP_TITLE__

One line per decision: what, and why. Append; do not edit old lines. Compaction
keeps this file when it drops the transcript, so a decision written here survives
a long build.

- Static HTML with no framework and no build step — the page has no state worth a
  framework's cost, and "saved is served" keeps the feedback loop instant.
- CSP `default-src 'self'` — no CDN fonts or scripts, so the page works offline,
  in restricted networks, and never breaks because a third party changed.
- JavaScript is enhancement only — the menu, FAQ and form validation all degrade
  to working HTML, so the page is readable by every crawler and reader.
- Design tokens in `:root` — one place to change colour and type; the sections
  never hard-code a colour.
