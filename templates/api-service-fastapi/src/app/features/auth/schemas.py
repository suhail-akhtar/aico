"""Request and response shapes for authentication.

`extra="forbid"` everywhere: an unknown field is a 422, not silently ignored, so
a client that sends `is_admin: true` finds out it does nothing instead of
believing it worked. Password length is bounded above (hashing a megabyte of
input is a denial-of-service lever) and, at registration only, below.
"""

from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, EmailStr, Field

Email = Annotated[EmailStr, Field(max_length=320)]


class RegisterRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    email: Email
    password: Annotated[str, Field(min_length=12, max_length=128)]


class LoginRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    email: Email
    # No minimum here: login must not reveal the password policy.
    password: Annotated[str, Field(min_length=1, max_length=128)]


class RefreshRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    refresh_token: Annotated[str, Field(min_length=1, max_length=512)]


class TokenPair(BaseModel):
    access_token: str
    refresh_token: str
    token_type: Literal["bearer"] = "bearer"  # noqa: S105 - the OAuth token type, not a secret
    expires_in: int = Field(description="Access token lifetime in seconds.")
