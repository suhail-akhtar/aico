# Deploying __APP_TITLE__

The whole site is the `public/` directory. Any static host serves it unchanged.

| Host | What to do |
|---|---|
| Netlify / Vercel / Cloudflare Pages | Point the project at this repo; publish directory `public`; no build command. |
| GitHub Pages | Push `public/` to a `gh-pages` branch, or set Pages to serve from `/public` on `main`. |
| S3 + CloudFront | `aws s3 sync public s3://<bucket> --delete`; set `index.html` as the default root object. |
| Any VPS or Kubernetes | Build the image below; it listens on 8080 and answers `/healthz`. |

## Docker

```sh
node deploy/docker.mjs            # docker build -t __APP_SLUG__ .
docker run --rm -p 8080:8080 __APP_SLUG__
```

Then open http://localhost:8080. The image is nginx plus the files; there is
nothing to configure. `compose.yaml` does the same with `docker compose up`.

## Before going live

- Replace every placeholder (grep for the word).
- Wire the contact form; the README explains where.
- Check the CSP still holds after adding images: everything must load from `/`.
