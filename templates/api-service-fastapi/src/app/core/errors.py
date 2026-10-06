"""Application errors that map one-to-one onto RFC 9457 problem responses.

Services raise these; `problems.py` turns them into `application/problem+json`.
Nothing here knows about FastAPI, so a service can be unit-tested without it.
Each class has a stable `code` that clients can switch on; the `detail` is for
people and may change.
"""

from typing import Any


class AppError(Exception):
    status_code = 500
    code = "internal_error"
    title = "Internal Server Error"

    def __init__(
        self,
        detail: str | None = None,
        *,
        headers: dict[str, str] | None = None,
        extra: dict[str, Any] | None = None,
    ) -> None:
        super().__init__(detail or self.title)
        self.detail = detail
        self.headers = headers or {}
        self.extra = extra or {}


class BadRequestError(AppError):
    status_code = 400
    code = "bad_request"
    title = "Bad Request"


class UnauthorizedError(AppError):
    status_code = 401
    code = "unauthorized"
    title = "Unauthorized"

    def __init__(self, detail: str | None = None, *, extra: dict[str, Any] | None = None) -> None:
        super().__init__(detail, headers={"WWW-Authenticate": "Bearer"}, extra=extra)


class ForbiddenError(AppError):
    status_code = 403
    code = "forbidden"
    title = "Forbidden"


class NotFoundError(AppError):
    status_code = 404
    code = "not_found"
    title = "Not Found"


class ConflictError(AppError):
    status_code = 409
    code = "conflict"
    title = "Conflict"


class IdentityConflictError(ConflictError):
    """The identity provider's account would take an email another account already owns.

    Never resolved by merging: two people can share an email string, an attacker can
    register someone else's address at a provider that does not verify it, and merging
    on that string hands the attacker the victim's account.
    """

    code = "identity_conflict"
    title = "Identity Conflict"


class LocalAuthDisabledError(NotFoundError):
    """Register, login, refresh and logout do not exist when AUTH_MODE=oidc."""

    code = "local_auth_disabled"
    title = "Local Authentication Disabled"

    def __init__(self) -> None:
        super().__init__("Local authentication is disabled: AUTH_MODE=oidc")


class PayloadTooLargeError(AppError):
    status_code = 413
    code = "payload_too_large"
    title = "Payload Too Large"


class RateLimitedError(AppError):
    status_code = 429
    code = "rate_limited"
    title = "Too Many Requests"


class ServiceUnavailableError(AppError):
    status_code = 503
    code = "unavailable"
    title = "Service Unavailable"
