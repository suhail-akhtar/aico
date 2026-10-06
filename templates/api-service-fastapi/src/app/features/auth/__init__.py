"""The `auth` feature: register, login, refresh rotation, logout, and `CurrentUser`.

Other features import only what is exported here (a test enforces it).
"""

from app.features.auth.deps import AuthServiceDep, CurrentUser, build_auth_service
from app.features.auth.models import RefreshToken
from app.features.auth.router import router

__all__ = ["AuthServiceDep", "CurrentUser", "RefreshToken", "build_auth_service", "router"]
