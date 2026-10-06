"""Queries for refresh tokens. The one subtle statement is `claim`."""

from datetime import datetime
from typing import Any, cast
from uuid import UUID

from sqlalchemy import delete, select, update
from sqlalchemy.engine import CursorResult
from sqlalchemy.ext.asyncio import AsyncSession

from app.features.auth.models import RefreshToken


class RefreshTokenRepository:
    def __init__(self, session: AsyncSession) -> None:
        self._session = session

    async def add(self, token: RefreshToken) -> None:
        self._session.add(token)
        await self._session.flush()

    async def get_by_hash(self, token_hash: str) -> RefreshToken | None:
        return await self._session.scalar(
            select(RefreshToken).where(RefreshToken.token_hash == token_hash)
        )

    async def claim(self, token_id: UUID, now: datetime) -> bool:
        """Retire a token if, and only if, nobody else has. True means this caller won.

        A single conditional UPDATE: of two concurrent refreshes with the same
        token, the database lets exactly one see a row change, so a stolen token
        cannot be rotated twice.
        """
        result = await self._session.execute(
            update(RefreshToken)
            .where(RefreshToken.id == token_id, RefreshToken.revoked_at.is_(None))
            .values(revoked_at=now)
        )
        return cast("CursorResult[Any]", result).rowcount == 1

    async def revoke_family(self, family_id: UUID, now: datetime) -> None:
        await self._session.execute(
            update(RefreshToken)
            .where(RefreshToken.family_id == family_id, RefreshToken.revoked_at.is_(None))
            .values(revoked_at=now)
        )

    async def delete_expired(self, now: datetime) -> int:
        result = await self._session.execute(
            delete(RefreshToken).where(RefreshToken.expires_at < now)
        )
        return cast("CursorResult[Any]", result).rowcount
