"""Keyset (cursor) pagination on the primary key.

Offset pagination rescans and skips rows, so page 5,000 is slow, and rows
inserted while a client pages make it see duplicates or miss items. A keyset
cursor ("the rows after this id") costs the same on every page and is stable.
Ids are UUIDv7, so ordering by id is ordering by creation time.

The cursor is opaque to clients (base64url of the 16 id bytes). It carries no
authority: every query is also scoped to the caller, so a forged cursor can only
move within the caller's own rows. A malformed one is a 400, never a 500.
"""

import base64
import binascii
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field

from app.core.errors import BadRequestError

MAX_LIMIT = 100
DEFAULT_LIMIT = 20


class Page[T](BaseModel):
    items: list[T]
    next_cursor: str | None = None


@dataclass(frozen=True)
class PageParams:
    limit: int
    after: UUID | None


class PageQuery(BaseModel):
    """The query string of a paginated endpoint. Declare it with `Annotated[..., Query()]`.

    `extra="forbid"`: an unknown parameter (a typo such as `?limt=5`) is a 422, not
    silently ignored, so a client never believes a filter it mistyped was applied.
    Extend it per endpoint with that endpoint's own filters.
    """

    model_config = ConfigDict(extra="forbid")

    limit: int = Field(DEFAULT_LIMIT, ge=1, le=MAX_LIMIT, description="Page size.")
    cursor: str | None = Field(
        None, max_length=32, description="Opaque cursor from the previous page's `next_cursor`."
    )

    def params(self) -> PageParams:
        return PageParams(
            limit=self.limit, after=decode_cursor(self.cursor) if self.cursor else None
        )


def encode_cursor(value: UUID) -> str:
    return base64.urlsafe_b64encode(value.bytes).rstrip(b"=").decode()


def decode_cursor(cursor: str) -> UUID:
    problem = BadRequestError("The cursor is not valid.", extra={"field": "cursor"})
    try:
        raw = base64.b64decode(
            cursor.replace("-", "+").replace("_", "/") + "=" * (-len(cursor) % 4), validate=True
        )
        value = UUID(bytes=raw)
    except (binascii.Error, ValueError) as exc:
        raise problem from exc
    if encode_cursor(value) != cursor:  # reject non-canonical spellings of the same bytes
        raise problem
    return value


def slice_page[T](
    rows: Sequence[T], limit: int, id_of: Callable[[T], UUID]
) -> tuple[list[T], str | None]:
    """Cut `limit + 1` fetched rows to a page and the cursor for the next one.

    Fetching one row more than asked is how a keyset query knows there is a next
    page without a COUNT.
    """
    items = list(rows[:limit])
    next_cursor = encode_cursor(id_of(items[-1])) if len(rows) > limit and items else None
    return items, next_cursor
