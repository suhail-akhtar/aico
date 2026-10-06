"""Registration, login, refresh rotation and logout.

The rules that matter are all here, in code that can be unit-tested without HTTP:
- Login answers the same 401 for an unknown address, a wrong password and a
  disabled account, and spends the same time doing it.
- A refresh token works exactly once. Presenting a retired one revokes its whole
  family (theft detected) and answers 401.
- Every use case commits explicitly, so the transaction boundary is the method.
"""

from datetime import timedelta
from uuid import UUID

import structlog
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.clock import Clock
from app.core.config import Settings
from app.core.errors import ConflictError, ForbiddenError, UnauthorizedError
from app.core.ids import new_id
from app.core.security import (
    PasswordService,
    TokenService,
    generate_refresh_token,
    hash_refresh_token,
)
from app.features.auth.models import RefreshToken
from app.features.auth.repository import RefreshTokenRepository
from app.features.auth.schemas import TokenPair
from app.features.users import User, UserRepository

log = structlog.get_logger(__name__)


def _bad_credentials() -> UnauthorizedError:
    return UnauthorizedError("Incorrect email or password.")


def _bad_refresh() -> UnauthorizedError:
    return UnauthorizedError("Invalid or expired refresh token.")


class AuthService:
    def __init__(
        self,
        *,
        session: AsyncSession,
        users: UserRepository,
        refresh_tokens: RefreshTokenRepository,
        passwords: PasswordService,
        tokens: TokenService,
        clock: Clock,
        settings: Settings,
    ) -> None:
        self._session = session
        self._users = users
        self._refresh_tokens = refresh_tokens
        self._passwords = passwords
        self._tokens = tokens
        self._clock = clock
        self._settings = settings

    async def register(self, email: str, password: str) -> User:
        if not self._settings.registration_enabled:
            raise ForbiddenError("Registration is disabled.")
        email = email.lower()
        if await self._users.get_by_email(email):
            raise ConflictError("An account with this email already exists.")
        user = User(
            id=new_id(),
            email=email,
            password_hash=await self._passwords.hash(password),
            is_active=True,
            created_at=self._clock.now(),
        )
        try:
            await self._users.add(user)
            await self._session.commit()
        except IntegrityError:  # lost a race with a concurrent registration
            await self._session.rollback()
            raise ConflictError("An account with this email already exists.") from None
        return user

    async def login(self, email: str, password: str) -> TokenPair:
        user = await self._users.get_by_email(email.lower())
        if user is None:
            await self._passwords.burn(password)
            raise _bad_credentials()
        valid, upgraded_hash = await self._passwords.verify(password, user.password_hash)
        if not valid or not user.is_active:
            raise _bad_credentials()
        if upgraded_hash:
            user.password_hash = upgraded_hash
        pair = await self._issue(user.id, family_id=new_id())
        await self._session.commit()
        return pair

    async def refresh(self, raw_token: str) -> TokenPair:
        now = self._clock.now()
        row = await self._refresh_tokens.get_by_hash(hash_refresh_token(raw_token))
        if row is None:
            raise _bad_refresh()
        if row.revoked_at is not None:
            await self._reuse_detected(row)
            raise _bad_refresh()
        if row.expires_at <= now:
            raise _bad_refresh()
        if not await self._refresh_tokens.claim(row.id, now):
            await self._reuse_detected(row)  # a concurrent request rotated it first
            raise _bad_refresh()
        user = await self._users.get(row.user_id)
        if user is None or not user.is_active:
            await self._refresh_tokens.revoke_family(row.family_id, now)
            await self._session.commit()
            raise _bad_refresh()
        pair = await self._issue(user.id, family_id=row.family_id)
        await self._session.commit()
        return pair

    async def logout(self, raw_token: str) -> None:
        """Revoke the token's family. Idempotent: an unknown token is not an error."""
        row = await self._refresh_tokens.get_by_hash(hash_refresh_token(raw_token))
        if row is not None:
            await self._refresh_tokens.revoke_family(row.family_id, self._clock.now())
            await self._session.commit()

    async def purge_expired_tokens(self) -> int:
        removed = await self._refresh_tokens.delete_expired(self._clock.now())
        await self._session.commit()
        return removed

    async def _reuse_detected(self, row: RefreshToken) -> None:
        log.warning("auth.refresh_token_reuse", user_id=str(row.user_id), family=str(row.family_id))
        await self._refresh_tokens.revoke_family(row.family_id, self._clock.now())
        await self._session.commit()

    async def _issue(self, user_id: UUID, *, family_id: UUID) -> TokenPair:
        now = self._clock.now()
        raw, digest = generate_refresh_token()
        await self._refresh_tokens.add(
            RefreshToken(
                id=new_id(),
                user_id=user_id,
                family_id=family_id,
                token_hash=digest,
                created_at=now,
                expires_at=now + timedelta(days=self._settings.refresh_token_ttl_days),
            )
        )
        return TokenPair(
            access_token=self._tokens.issue_access_token(user_id),
            refresh_token=raw,
            expires_in=self._tokens.access_ttl_seconds,
        )
