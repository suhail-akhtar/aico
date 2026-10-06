# Multi-stage, reproducible, non-root. Base images are pinned by tag AND digest;
# Dependabot (docker ecosystem) proposes new digests as pull requests.
#
#   build   resolves the locked dependencies into /opt/venv (uv, --locked: fails if
#           uv.lock is out of date) and byte-compiles them
#   tools   build + dev dependencies + tests: `docker compose --profile tools run tools`
#   runtime the default target: the venv and nothing else (no uv, no compiler, no tests)

FROM ghcr.io/astral-sh/uv:0.12.23@sha256:61d393e44e249f2e4b526b6c7ddcecce245946826e608e11c93ad4f5bba55b21 AS uv

FROM python:3.14-slim@sha256:c3e521df8b2b498a7a682e7e18676771cb80c6b75b8699af886b2d554ce40151 AS build
COPY --from=uv /uv /bin/uv
ENV UV_LINK_MODE=copy \
    UV_COMPILE_BYTECODE=1 \
    UV_PYTHON_DOWNLOADS=never \
    UV_PROJECT_ENVIRONMENT=/opt/venv
WORKDIR /app
# Dependencies first, so editing source does not reinstall them.
COPY pyproject.toml uv.lock README.md LICENSE ./
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --locked --no-dev --no-install-project
COPY src ./src
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --locked --no-dev --no-editable

FROM build AS tools
RUN --mount=type=cache,target=/root/.cache/uv uv sync --locked
COPY tests ./tests
COPY scripts ./scripts
COPY alembic.ini openapi.json .env.example .pip-audit-ignore ./
ENV PATH="/opt/venv/bin:$PATH"
CMD ["sh", "-c", "ruff format --check . && ruff check . && mypy && bandit -q -c pyproject.toml -r src && pytest --cov && python scripts/audit.py"]

FROM python:3.14-slim@sha256:c3e521df8b2b498a7a682e7e18676771cb80c6b75b8699af886b2d554ce40151 AS runtime
# - apt upgrade: the pinned base digest can lag Debian security fixes by days; this picks
#   them up at build time (image scanning in CI fails the build on a fixable HIGH).
# - pip is removed: the service does not need it, and its vendored copies of urllib3 and
#   msgpack are what image scanners flag. Dependencies are installed in the build stage.
RUN apt-get update \
    && apt-get -y --no-install-recommends upgrade \
    && rm -rf /var/lib/apt/lists/* /usr/local/lib/python3.14/site-packages/pip* /usr/local/bin/pip* \
    && useradd --system --uid 10001 --no-create-home --shell /usr/sbin/nologin app
COPY --from=build /opt/venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH" \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONFAULTHANDLER=1 \
    APP_ENV=production
USER 10001
EXPOSE 8000
# Liveness only (no database): a flapping database must not restart the container.
# Written in Python because the slim image has neither curl nor wget.
HEALTHCHECK --interval=30s --timeout=3s --start-period=15s --retries=3 \
    CMD ["python", "-c", "import sys, urllib.request; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/healthz', timeout=2).status == 200 else 1)"]
# One process per container (scale with replicas); set WEB_CONCURRENCY=N to run N
# workers in a single container instead. --proxy-headers trusts X-Forwarded-* only
# from FORWARDED_ALLOW_IPS (default 127.0.0.1): set it to your proxy's address.
CMD ["uvicorn", "app.main:create_app", "--factory", "--host", "0.0.0.0", "--port", "8000", \
     "--proxy-headers", "--no-server-header", "--no-access-log", "--timeout-graceful-shutdown", "20"]
