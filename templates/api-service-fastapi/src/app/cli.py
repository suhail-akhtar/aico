"""Operational commands: `python -m app.cli <command>`.

    migrate         apply database migrations (the compose `migrate` service runs this)
    seed            create the development demo user (never in production)
    purge-tokens    delete expired refresh tokens (run it daily from a scheduler; a no-op
                    with AUTH_MODE=oidc, where none are issued)
    openapi         write the OpenAPI document; `--check` fails if the file is stale

Kept to the standard library (`argparse`) on purpose: an extra CLI framework for
four commands is a dependency to audit for no gain.
"""

import argparse
import asyncio
import json
import sys
from pathlib import Path

from pydantic import SecretStr

from app.core.config import Settings, load_settings
from app.core.container import build_container
from app.db import migrate
from app.features.auth import build_auth_service
from app.main import create_app
from app.seed import seed

OPENAPI_FILE = Path("openapi.json")


def render_openapi() -> str:
    """The OpenAPI document as stable text: the same app always renders identically."""
    settings = Settings(
        app_env="test",
        jwt_secret=SecretStr("openapi-export-not-a-real-secret-0000"),
        database_url="sqlite+aiosqlite://",
        log_level="ERROR",
        _env_file=None,
    )
    document = create_app(settings).openapi()
    return json.dumps(document, indent=2, sort_keys=True) + "\n"


async def _migrate(revision: str) -> None:
    container = build_container(load_settings())
    try:
        await migrate.upgrade(container.engine, revision)
    finally:
        await container.engine.dispose()


async def _purge_tokens() -> int:
    settings = load_settings()
    if settings.auth_mode == "oidc":
        return 0
    container = build_container(settings)
    try:
        async with container.session_factory() as session:
            return await build_auth_service(session, container).purge_expired_tokens()
    finally:
        await container.engine.dispose()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m app.cli", description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    up = commands.add_parser("migrate", help="apply database migrations")
    up.add_argument("--revision", default="head")
    commands.add_parser("seed", help="create the development demo user")
    commands.add_parser("purge-tokens", help="delete expired refresh tokens")
    spec = commands.add_parser("openapi", help="write or check openapi.json")
    spec.add_argument("--out", type=Path, default=OPENAPI_FILE)
    spec.add_argument("--check", action="store_true", help="exit 1 if the file is out of date")
    args = parser.parse_args(argv)

    if args.command == "migrate":
        asyncio.run(_migrate(args.revision))
        print(f"database is at {args.revision}")
    elif args.command == "seed":
        print(asyncio.run(seed(load_settings())))
    elif args.command == "purge-tokens":
        print(f"removed {asyncio.run(_purge_tokens())} expired refresh tokens")
    elif args.command == "openapi":
        text = render_openapi()
        if args.check:
            if not args.out.exists() or args.out.read_text(encoding="utf-8") != text:
                print(f"{args.out} is out of date: run `make openapi`", file=sys.stderr)
                return 1
            print(f"{args.out} is up to date")
        else:
            args.out.write_text(text, encoding="utf-8", newline="\n")
            print(f"wrote {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
