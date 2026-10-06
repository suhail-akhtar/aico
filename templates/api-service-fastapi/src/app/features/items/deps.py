"""Wiring for the items feature: how a request gets an `ItemService`."""

from typing import Annotated

from fastapi import Depends

from app.core.deps import ClockDep, SessionDep
from app.features.items.repository import ItemRepository
from app.features.items.service import ItemService


def get_item_service(session: SessionDep, clock: ClockDep) -> ItemService:
    return ItemService(session, ItemRepository(session), clock)


ItemServiceDep = Annotated[ItemService, Depends(get_item_service)]
