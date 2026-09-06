# __APP_TITLE__

__APP_DESCRIPTION__

A static landing page: HTML, CSS and a little JavaScript under `public/`. No
build step. Open `public/index.html` in a browser, or let aico serve it.

## Run

Nothing to install. aico's apps host serves `public/` at the URL shown on the
app's card. To serve it yourself:

```sh
npx serve public
```

## Deploy

Any static host takes the `public/` directory as-is: Netlify, Vercel, Cloudflare
Pages, GitHub Pages, S3 + CloudFront. A container is in `deploy/`:

```sh
node deploy/docker.mjs        # builds an nginx image and prints the run command
```

See `deploy/README.md` for the per-host notes.

## Structure

```
public/index.html   the page
public/styles.css   tokens, then components
public/main.js      menu, FAQ, form validation — enhancement only
.aico/backlog.md    what is planned, ticked as it lands
.aico/decisions.md  what was decided and why
docs/EXTENDING.md   how to add a section, a page, an asset
```
