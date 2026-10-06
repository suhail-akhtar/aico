# syntax=docker/dockerfile:1.7
#
# Three stages:
#   tools    the toolchain + linters + scanners, pinned. Used by `docker compose
#            run tools make check`, so no Go install is needed on the host.
#   build    compiles a static binary (CGO off, trimpath, version stamped).
#   runtime  distroless static, non-root, one file. No shell, no package manager.
#
# Every base is pinned by version AND digest; Dependabot keeps both fresh.

# ---- tools ------------------------------------------------------------------
FROM golang:1.27.1-bookworm@sha256:69a7b9788769bec032d238959b61854e9ae87f57be9029ec04e9885fabf99195 AS tools
COPY --from=golangci/golangci-lint:v2.14.0@sha256:ad862ba6b3798cbe0fd9fd7408d498fd74fbd2623a92406b2fd3898faf0bf98f /usr/bin/golangci-lint /usr/local/bin/golangci-lint
COPY --from=sqlc/sqlc:1.31.1@sha256:70f53171d27b2424e9358869975455a6e955a5aa8e58a998a270a6e34e525537 /workspace/sqlc /usr/local/bin/sqlc
RUN --mount=type=cache,target=/go/pkg/mod --mount=type=cache,target=/root/.cache/go-build \
    GOBIN=/usr/local/bin go install golang.org/x/vuln/cmd/govulncheck@v1.8.0 \
 && GOBIN=/usr/local/bin go install github.com/CycloneDX/cyclonedx-gomod/cmd/cyclonedx-gomod@v1.12.0 \
 && GOBIN=/usr/local/bin go install github.com/oapi-codegen/oapi-codegen/v2/cmd/oapi-codegen@v2.8.0
# The Makefile runs these instead of `go run pkg@version` when they are set.
ENV GOLANGCI_LINT=golangci-lint GOVULNCHECK=govulncheck CYCLONEDX=cyclonedx-gomod OAPI_CODEGEN=oapi-codegen SQLC=sqlc \
    GOFLAGS=-buildvcs=false \
    GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=safe.directory GIT_CONFIG_VALUE_0=/src
WORKDIR /src

# ---- build ------------------------------------------------------------------
FROM golang:1.27.1-alpine@sha256:8a5910f31396cd4d89662f56c68b3ae31d374308270a1c3bd96672ee5ed43414 AS build
ENV CGO_ENABLED=0 GOFLAGS=-mod=readonly
WORKDIR /src
COPY go.mod go.sum ./
RUN --mount=type=cache,target=/go/pkg/mod go mod download && go mod verify
COPY . .
ARG VERSION=dev
ARG COMMIT=unknown
ARG DATE=unknown
RUN --mount=type=cache,target=/go/pkg/mod --mount=type=cache,target=/root/.cache/go-build \
    go build -trimpath \
      -ldflags "-s -w \
        -X example.com/api-service/internal/platform/version.Version=${VERSION} \
        -X example.com/api-service/internal/platform/version.Commit=${COMMIT} \
        -X example.com/api-service/internal/platform/version.Date=${DATE}" \
      -o /out/server ./cmd/server

# ---- runtime ----------------------------------------------------------------
FROM gcr.io/distroless/static-debian13:nonroot@sha256:e2e927ec666bae08560abb3c55d0659eceabb657f56b6782ab500a9fc7f555e3 AS runtime
ARG VERSION=dev
LABEL org.opencontainers.image.title="api-service" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.description="Go REST API starter"
COPY --from=build /out/server /server
ENV APP_ENV=production HOST=0.0.0.0 PORT=8080
EXPOSE 8080
USER nonroot:nonroot
# Distroless has no curl or wget: the binary probes itself.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD ["/server", "healthcheck"]
ENTRYPOINT ["/server"]
