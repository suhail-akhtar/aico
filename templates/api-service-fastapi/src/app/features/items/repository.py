"""Queries for items. Every one takes `owner_id`: ownership is part of the query.

Scoping in the WHERE clause (not a check after loading) means another user's item
is simply absent: a lookup answers "not found", with no 403 that would confirm the
id exists, and a forgotten check cannot leak a row.
"""

from collections.abc import Sequence
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.features.items.models import Item


class ItemRepository:
    def __init__(self, session: AsyncSession) -> None:
        self._session = session

    async def add(self, item: Item) -> None:
        self._session.add(item)
        await self._session.flush()

    async def get(self, owner_id: UUID, item_id: UUID) -> Item | None:
        return await self._session.scalar(
            select(Item).where(Item.owner_id == owner_id, Item.id == item_id)
        )

    async def list(
        self, owner_id: UUID, *, limit: int, after: UUID | None, search: str | None
    ) -> Sequence[Item]:
        """Newest first. Fetches `limit + 1` rows so the caller can tell if a page follows."""
        statement = select(Item).where(Item.owner_id == owner_id)
        if after is not None:
            statement = statement.where(Item.id < after)
        if search:
            # autoescape: `%` and `_` in the search text match themselves, not wildcards.
            statement = statement.where(Item.name.icontains(search, autoescape=True))
        return (
            await self._session.scalars(statement.order_by(Item.id.desc()).limit(limit + 1))
        ).all()

    async def delete(self, item: Item) -> None:
        await self._session.delete(item)
        await self._session.flush()
