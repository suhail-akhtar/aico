"""The items table: the worked example every other resource copies."""

from datetime import datetime
from uuid import UUID

from sqlalchemy import CheckConstraint, ForeignKey, Index, Integer, String
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base
from app.db.types import UTCDateTime


class Item(Base):
    __tablename__ = "items"
    __table_args__ = (
        # The database enforces what the schema promises; the API is not the only writer.
        CheckConstraint("quantity >= 0", name="quantity_non_negative"),
        # Serves "my items, newest first, after this cursor" without a sort.
        Index("ix_items_owner_id_id", "owner_id", "id"),
    )

    id: Mapped[UUID] = mapped_column(primary_key=True)
    owner_id: Mapped[UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    name: Mapped[str] = mapped_column(String(120))
    description: Mapped[str | None] = mapped_column(String(2000), default=None)
    quantity: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime)
    updated_at: Mapped[datetime] = mapped_column(UTCDateTime)
