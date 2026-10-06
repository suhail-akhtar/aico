"""The API shapes for items, kept apart from the table model on purpose.

`ItemInput` is what a client may send (create and full replace); `ItemRead` is
what it gets back. `owner_id` is in neither: it is set from the authenticated
user, so a client cannot create an item for someone else (no mass assignment),
and it is not exposed.
"""

from datetime import datetime
from typing import Annotated
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, StringConstraints

from app.core.pagination import PageQuery
from app.core.validators import NoNul, Text

Name = Annotated[
    str,
    StringConstraints(strip_whitespace=True, min_length=1, max_length=120),
    NoNul,
]
Description = Annotated[str, StringConstraints(strip_whitespace=True, max_length=2000), NoNul]


class ItemInput(BaseModel):
    # strict: `"quantity": false` or `"5"` is a 422, not silently coerced to 0 or 5.
    model_config = ConfigDict(extra="forbid", strict=True)

    name: Name
    description: Description | None = None
    quantity: int = Field(default=0, ge=0, le=1_000_000)


class ItemListQuery(PageQuery):
    q: Text | None = Field(None, min_length=1, max_length=100, description="Name contains.")


class ItemRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    name: str
    description: str | None
    quantity: int
    created_at: datetime
    updated_at: datetime
