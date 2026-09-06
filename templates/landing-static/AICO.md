# __APP_TITLE__

A static landing page. No build step, no framework, no server code: everything
under `public/` is served as-is by the aico apps host, and later by any static
host or the nginx image in `deploy/`.

## Layout

- `public/index.html` — the page. Sections in order: header, hero, features,
  pricing, FAQ, contact, footer. Each section is a `<section id="…">`.
- `public/styles.css` — design tokens at the top (`:root`), then components.
  Change colours and type there, not inline.
- `public/main.js` — progressive enhancement only: the mobile menu, the FAQ
  accordion, the contact form's client-side validation. The page must read
  and work with JavaScript off.

## Conventions

- Content Security Policy is `'self'`: no CDN, no web fonts, no remote images.
  Put assets under `public/` and reference them relatively.
- Semantic HTML first (`header`, `nav`, `main`, `section`, `footer`), one `h1`,
  headings in order, every image with `alt`, every form control with a label.
- The contact form posts nowhere by default (`action="#"`). Wire it to a real
  endpoint or a form service before shipping; say so in the README.
- Verify in a browser after every change: `VerifyApp` on the served URL, with a
  check per interaction (menu opens, FAQ toggles, invalid email is refused).

## Checks

There are none to run: `RunChecks` will find no manifest, which is correct for
static files. Verification is the browser.
