"""HTTP routes for items: the pattern to copy for the next resource."""

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Query, Request, Response, status

from app.core.pagination import Page
from app.core.problems import problem_responses
from app.features.auth import CurrentUser
from app.features.items.deps import ItemServiceDep
from app.features.items.schemas import ItemInput, ItemListQuery, ItemRead

router = APIRouter(prefix="/items", tags=["items"])


@router.post(
    "",
    status_code=status.HTTP_201_CREATED,
    responses=problem_responses(401, 422),
)
async def create_item(
    body: ItemInput,
    user: CurrentUser,
    service: ItemServiceDep,
    request: Request,
    response: Response,
) -> ItemRead:
    item = await service.create(user.id, body)
    response.headers["Location"] = f"{request.url.path.rstrip('/')}/{item.id}"
    return ItemRead.model_validate(item)


@router.get("", responses=problem_responses(400, 401, 422))
async def list_items(
    user: CurrentUser, service: ItemServiceDep, query: Annotated[ItemListQuery, Query()]
) -> Page[ItemRead]:
    items, next_cursor = await service.list(user.id, query.params(), query.q)
    return Page[ItemRead](
        items=[ItemRead.model_validate(i) for i in items], next_cursor=next_cursor
    )


@router.get("/{item_id}", responses=problem_responses(401, 404, 422))
async def get_item(item_id: UUID, user: CurrentUser, service: ItemServiceDep) -> ItemRead:
    return ItemRead.model_validate(await service.get(user.id, item_id))


@router.put("/{item_id}", responses=problem_responses(401, 404, 422))
async def replace_item(
    item_id: UUID, body: ItemInput, user: CurrentUser, service: ItemServiceDep
) -> ItemRead:
    return ItemRead.model_validate(await service.replace(user.id, item_id, body))


@router.delete(
    "/{item_id}", status_code=status.HTTP_204_NO_CONTENT, responses=problem_responses(401, 404, 422)
)
async def delete_item(item_id: UUID, user: CurrentUser, service: ItemServiceDep) -> Response:
    await service.delete(user.id, item_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)
