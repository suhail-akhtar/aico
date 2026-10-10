# AICO Control (ADR 0040). Build from the repository root so the server can bundle the engine's
# policy schema (src/policy/managed.ts):
#   docker build -f control/Dockerfile -t aico-control .
FROM node:22-slim AS build
WORKDIR /repo
COPY src ./src
COPY shared ./shared
COPY control ./control
WORKDIR /repo/control
RUN npm ci && npm run build

FROM node:22-slim
ENV NODE_ENV=production CONTROL_DATA_DIR=/data
WORKDIR /app
COPY --from=build /repo/control/dist ./dist
RUN mkdir /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 7350
# TLS terminates at a proxy (see compose.yaml), hence --behind-proxy; PUBLIC_URL must be the https address.
CMD ["sh", "-c", "exec node dist/index.js serve --host 0.0.0.0 --port 7350 --behind-proxy --public-url \"$PUBLIC_URL\" --data-dir /data"]
