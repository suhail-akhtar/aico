"""The `users` feature: the account record. Its public surface is what other features may import.

It has no router of its own: registration, login and "who am I" are authentication
concerns and live in `auth`. A user-management API (admin list, deactivate, delete
for erasure requests) would be added here.
"""

from app.features.users.models import User
from app.features.users.repository import UserRepository
from app.features.users.schemas import UserRead

__all__ = ["User", "UserRead", "UserRepository"]
