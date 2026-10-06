# syntax=docker/dockerfile:1.7
#
# Static single-page app on nginx: multi-stage, pinned by version and digest (Dependabot's docker
# ecosystem keeps both fresh), non-root, no shell tools beyond busybox, read-only-filesystem friendly.
#   docker build -t web-app .
#   docker run --rm -p 8080:8080 --read-only --tmpfs /tmp --cap-drop ALL \
#     --security-opt no-new-privileges web-app

ARG NODE_IMAGE=node:24.21.0-alpine3.24@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1
ARG NGINX_IMAGE=nginxinc/nginx-unprivileged:1.30.5-alpine3.24@sha256:15c994d10d6d78658721c3bcafff14cb281fba2a4bdf9d5ba92c416a472516e3

FROM ${NODE_IMAGE} AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --no-audit --no-fund
COPY . .
# Source maps are for an error tracker, not for visitors: upload them from CI before this step
# if you use one. The server also refuses to serve *.map.
RUN npm run build && find dist -name '*.map' -delete

FROM ${NGINX_IMAGE}
COPY nginx/nginx.conf /etc/nginx/nginx.conf
COPY nginx/security-headers.conf /etc/nginx/security-headers.conf
COPY --chmod=0755 nginx/entrypoint.sh /usr/local/bin/entrypoint.sh
COPY --from=build /app/dist /usr/share/nginx/html
# The base image already runs as the unprivileged `nginx` user (101).
USER 101
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:8080/healthz || exit 1
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
