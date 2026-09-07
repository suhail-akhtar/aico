# Deploying __APP_TITLE__

`npm run build` writes the whole site to `dist/`. Any static host serves it unchanged.

| Host | What to do |
|---|---|
| Netlify / Vercel / Cloudflare Pages | Build command `npm run build`, publish directory `dist`. |
| GitHub Pages | Build in an Action and publish `dist/`; set `site` and `base` in `astro.config.mjs` if the site lives under a path. |
| S3 + CloudFront | `aws s3 sync dist s3://<bucket> --delete`. |
| Any VPS or Kubernetes | The image below: nginx serving `dist/`, port 8080, `/healthz`. |

## Docker

```sh
node deploy/docker.mjs            # docker build -t __APP_SLUG__ .
docker run --rm -p 8080:8080 __APP_SLUG__
```

`compose.yaml` does the same with `docker compose up`.
