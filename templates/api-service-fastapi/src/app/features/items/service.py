"""Use cases for items. Owns the transaction boundary and the "not found" rule."""

from uuid import UUID

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.clock import Clock
from app.core.errors import NotFoundError
from app.core.ids import new_id
from app.core.pagination import PageParams, slice_page
from app.features.items.models import Item
from app.features.items.repository import ItemRepository
from app.features.items.schemas import ItemInput


class ItemService:
    def __init__(self, session: AsyncSession, repository: ItemRepository, clock: Clock) -> None:
        self._session = session
        self._repository = repository
        self._clock = clock

    async def create(self, owner_id: UUID, data: ItemInput) -> Item:
        now = self._clock.now()
        item = Item(
            id=new_id(),
            owner_id=owner_id,
            name=data.name,
            description=data.description,
            quantity=data.quantity,
            created_at=now,
            updated_at=now,
        )
        await self._repository.add(item)
        await self._session.commit()
        return item

    async def list(
        self, owner_id: UUID, params: PageParams, search: str | None
    ) -> tuple[list[Item], str | None]:
        rows = await self._repository.list(
            owner_id, limit=params.limit, after=params.after, search=search
        )
        return slice_page(rows, params.limit, lambda item: item.id)

    async def get(self, owner_id: UUID, item_id: UUID) -> Item:
        item = await self._repository.get(owner_id, item_id)
        if item is None:
            raise NotFoundError("Item not found.")
        return item

    async def replace(self, owner_id: UUID, item_id: UUID, data: ItemInput) -> Item:
        item = await self.get(owner_id, item_id)
        item.name = data.name
        item.description = data.description
        item.quantity = data.quantity
        item.updated_at = self._clock.now()
        await self._session.commit()
        return item

    async def delete(self, owner_id: UUID, item_id: UUID) -> None:
        item = await self.get(owner_id, item_id)
        await self._repository.delete(item)
        await self._session.commit()
