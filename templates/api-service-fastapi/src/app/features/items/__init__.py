"""The `items` feature: the worked resource. Copy it to add a new one (docs/EXTENDING.md)."""

from app.features.items.models import Item
from app.features.items.router import router

__all__ = ["Item", "router"]
