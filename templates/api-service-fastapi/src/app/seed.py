"""Development seed: one demo user with a few items, so a fresh database is not empty.

Refuses to run in production. The password comes from SEED_PASSWORD (in
`.env.local` after AICO creates the app, or `.env` from `.env.example`); there is
no default password, because a default in code is a default in production.
Idempotent: running it twice leaves one demo user. With AUTH_MODE=oidc there are no
local accounts, so there is nothing to seed and no demo user is created.
"""

from app.core.config import Settings
from app.core.container import build_container
from app.features.auth import build_auth_service
from app.features.items.repository import ItemRepository
from app.features.items.schemas import ItemInput
from app.features.items.service import ItemService
from app.features.users import UserRepository

DEMO_EMAIL = "demo@example.com"
DEMO_ITEMS = (("Notebook", 12), ("Desk lamp", 3), ("Stapler", 0))


async def seed(settings: Settings) -> str:
    if settings.is_production:
        msg = "Refusing to seed a production database."
        raise SystemExit(msg)
    if settings.auth_mode == "oidc":
        return "AUTH_MODE=oidc: accounts come from the identity provider; nothing to seed."
    if settings.seed_password is None:
        msg = "Set SEED_PASSWORD (at least 12 characters) to create the demo user."
        raise SystemExit(msg)
    container = build_container(settings)
    try:
        async with container.session_factory() as session:
            if await UserRepository(session).get_by_email(DEMO_EMAIL):
                return f"{DEMO_EMAIL} already exists; nothing to do."
            auth = build_auth_service(session, container)
            user = await auth.register(DEMO_EMAIL, settings.seed_password.get_secret_value())
            items = ItemService(session, ItemRepository(session), container.clock)
            for name, quantity in DEMO_ITEMS:
                await items.create(user.id, ItemInput(name=name, quantity=quantity))
            return f"Created {DEMO_EMAIL} with {len(DEMO_ITEMS)} items."
    finally:
        await container.engine.dispose()


__all__ = ["DEMO_EMAIL", "seed"]
