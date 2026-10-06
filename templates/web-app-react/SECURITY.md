# Security policy

## Reporting a vulnerability

Do not open a public issue. Report it privately to the maintainers (use the repository's
"Report a vulnerability" security advisory form, or the contact in `CODEOWNERS`). Include what you
found, how to reproduce it, and the version. You will get an acknowledgement within three working days.

## Supported versions

The latest released minor version receives security fixes.

## What this app already does

| Concern | Control | Where |
|---|---|---|
| Tokens | none in the browser: a gateway keeps the session behind an `HttpOnly` cookie (BFF, RFC 10017) | `docs/BFF.md`, `src/auth` |
| CSRF | `SameSite=Lax` session cookie plus `X-Requested-With: fetch` required on unsafe methods; the e2e suite proves a forged request is refused | `src/api/client.ts`, `e2e/auth.spec.ts` |
| XSS | React escaping, no `dangerouslySetInnerHTML` (lint error), strict CSP without `unsafe-inline` or `unsafe-eval`; the e2e suite fails on any violation | `nginx/security-headers.conf`, `mock/security-headers.ts` |
| Open redirect | a return address survives sign-in only if it is a path on this origin (`safeReturnTo`, unit-tested with hostile inputs) | `src/auth/auth.ts` |
| Misdirected cookie | config URLs must be same-origin paths; checked by the container entrypoint and again by the client | `nginx/entrypoint.sh`, `src/config/runtime-config.ts` |
| Clickjacking | `frame-ancestors 'none'` and `X-Frame-Options: DENY` | nginx |
| Information leaks | server version hidden, source maps removed from the image and refused by the server, dotfiles refused | `nginx/nginx.conf`, `Dockerfile` |
| Supply chain | exact versions and a lockfile, `npm audit` gate (high and critical) with a reviewed, expiring allow-list, osv-scanner, Dependabot, SBOM, image and actions pinned by digest or SHA | CI, `scripts/audit.ts` |
| Runtime | non-root (uid 101), read-only root filesystem, no capabilities, `no-new-privileges` | `Dockerfile`, `compose.yaml` |
| Secrets | none in the repository or the image (only same-origin paths are configured); gitleaks in the pre-commit hook and CI | `.pre-commit-config.yaml`, CI |

## What it does not do (decide before going live)

- **TLS and HSTS** belong to whatever terminates HTTPS in front of the container. Set
  `Strict-Transport-Security` there. The session cookie must be `Secure` in production.
- **Authentication and authorization are the gateway's and the API's.** The route guard in the
  app is a convenience, not a control: every API call is authorized server-side.
- **Rate limiting** is not done here; do it at the gateway.
- **CSP reporting** is not configured. Add `report-to` and an endpoint if you want to learn about
  violations in the field.
- **Subresource integrity** is not needed (no third-party scripts); if you add one, add SRI and its host to the CSP.
