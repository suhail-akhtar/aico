"""Just-in-time provisioning: the first valid token for a subject creates its user row.

In AUTH_MODE=oidc the identity provider owns accounts. This service keeps a row per
person anyway, because items refer to `users.id` and ownership is checked against it, so
the row is created the first time a verified token arrives for a subject that has none.

The decisions that matter:
- The row's id IS the token's `sub` (a UUID). No mapping table, no second identifier: the
  same person is the same owner everywhere, including after a re-deploy.
- Nothing is ever merged. If another row already owns the email, the answer is a 409
  (`identity_conflict`), not "link the accounts": an email string is not proof of
  identity at a provider that does not verify addresses, and merging on it would give an
  attacker the victim's items. A person resolves it (change the email at the provider,
  or remove the stale local account); the service never guesses.
- Race-safe without a lock: two first requests insert the same primary key, the database
  lets one win, and the loser re-reads the winner's row and carries on. A unique violation
  where no row with this id exists means the email was taken in that instant: 409.
- The row stores a password hash nobody can satisfy (`UNUSABLE_PASSWORD_HASH`), so a local
  login attempt for it is the ordinary 401, never an exception.
- An existing row is returned as it is. The email is captured at first sight and not
  re-synced; updating it on change is a deliberate growth step (it needs the same
  collision rule), not something to do silently on every request.
"""

import structlog
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.clock import Clock
from app.core.errors import IdentityConflictError
from app.core.oidc import OidcIdentity
from app.core.security import UNUSABLE_PASSWORD_HASH
from app.features.users import User, UserRepository

log = structlog.get_logger(__name__)


def _conflict() -> IdentityConflictError:
    return IdentityConflictError(
        "Another account already uses this email address. Ask an administrator to resolve it."
    )


async def provision_user(
    session: AsyncSession, users: UserRepository, clock: Clock, identity: OidcIdentity
) -> User:
    """Return the user for this identity, creating it on first sight."""
    existing = await users.get(identity.subject)
    if existing is not None:
        return existing
    owner = await users.get_by_email(identity.email)
    if owner is not None:
        if owner.id == identity.subject:  # a concurrent first request has just created our row
            return owner
        raise _conflict()
    user = User(
        id=identity.subject,
        email=identity.email,
        password_hash=UNUSABLE_PASSWORD_HASH,
        is_active=True,
        created_at=clock.now(),
    )
    try:
        await users.add(user)
        await session.commit()
    except IntegrityError:
        await session.rollback()
        winner = await users.get(identity.subject)
        if winner is None:  # not our own concurrent twin: the email was taken meanwhile
            raise _conflict() from None
        return winner
    log.info("auth.user_provisioned", user_id=str(user.id))
    return user
