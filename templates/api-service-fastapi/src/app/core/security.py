"""Password hashing and tokens: the two primitives authentication is built from.

Passwords: Argon2id through pwdlib with explicit parameters (m=64 MiB, t=3, p=2
by default, above the OWASP minimum of m=19 MiB, t=2, p=1). Hashing is
CPU-bound and deliberately slow, so it runs in a worker thread; on the event
loop it would stall every other request. `verify_and_update` returns a fresh hash
when the stored one used weaker parameters, so raising the cost upgrades users
as they log in.

Access tokens: short-lived HS256 JWTs. Verification pins the algorithm list (no
`none`, no algorithm confusion), requires `exp iat sub iss aud jti`, checks the
`typ: at+jwt` header (RFC 9068) so another kind of JWT cannot be replayed here,
and compares expiry against the injected Clock, not the wall clock, so tests can
move time.

Accounts created from an identity provider's token (AUTH_MODE=oidc) have no password.
Their stored hash is `UNUSABLE_PASSWORD_HASH`, which no hasher recognises, so
`PasswordService.verify` answers "not valid" (after spending the usual time) instead of
raising: a local login attempt against such an account is the same 401 as any wrong password.

Refresh tokens are opaque random strings, stored only as a SHA-256 digest: they
carry 384 bits of entropy, so a fast hash is enough and a database leak does not
yield usable tokens.
"""

import asyncio
import hashlib
import secrets
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from uuid import UUID, uuid4

import jwt
from pwdlib import PasswordHash
from pwdlib.exceptions import UnknownHashError
from pwdlib.hashers.argon2 import Argon2Hasher

from app.core.clock import Clock
from app.core.config import Settings
from app.core.errors import UnauthorizedError

ALGORITHM = "HS256"
# Stored for accounts that exist only through an identity provider. It is not a hash of
# anything: it does not start with `$argon2`, so no hasher can ever accept a password for it.
UNUSABLE_PASSWORD_HASH = "!no-local-password"  # noqa: S105  # nosec B105 - a sentinel, not a secret
# A media-type name (RFC 9068), not a secret.
ACCESS_TOKEN_TYPE = "at+jwt"  # noqa: S105  # nosec B105
MAX_TOKEN_LENGTH = 4096
_REQUIRED_CLAIMS = ["exp", "iat", "sub", "iss", "aud", "jti"]


class PasswordService:
    def __init__(self, settings: Settings) -> None:
        self._hasher = PasswordHash(
            (
                Argon2Hasher(
                    time_cost=settings.argon2_time_cost,
                    memory_cost=settings.argon2_memory_cost_kib,
                    parallelism=settings.argon2_parallelism,
                ),
            )
        )
        self._dummy_hash: str | None = None

    async def hash(self, password: str) -> str:
        return await asyncio.to_thread(self._hasher.hash, password)

    async def verify(self, password: str, stored_hash: str) -> tuple[bool, str | None]:
        """Return (valid, replacement_hash). A replacement means the stored hash is outdated."""
        try:
            return await asyncio.to_thread(self._hasher.verify_and_update, password, stored_hash)
        except UnknownHashError:
            # A sentinel (`UNUSABLE_PASSWORD_HASH`) or a hash from a scheme this service
            # does not use: never valid. Burn the time of a real check so the answer
            # cannot tell an identity-provider account from a password account.
            await self.burn(password)
            return False, None

    async def burn(self, password: str) -> None:
        """Spend the same time as a real verification, for an account that does not exist.

        Without it, "unknown email" answers measurably faster than "wrong
        password" and the login endpoint becomes an account-existence oracle.
        """
        if self._dummy_hash is None:
            self._dummy_hash = await self.hash(secrets.token_urlsafe(16))
        await self.verify(password, self._dummy_hash)


@dataclass(frozen=True)
class AccessClaims:
    user_id: UUID
    jti: str
    expires_at: datetime


class TokenService:
    def __init__(self, settings: Settings, clock: Clock) -> None:
        if settings.jwt_secret is None:  # Settings guarantees it in AUTH_MODE=local
            msg = "TokenService needs JWT_SECRET (AUTH_MODE=local)"
            raise ValueError(msg)
        self._secret = settings.jwt_secret.get_secret_value()
        self._issuer = settings.jwt_issuer
        self._audience = settings.jwt_audience
        self._ttl = timedelta(seconds=settings.access_token_ttl_seconds)
        self._clock = clock

    @property
    def access_ttl_seconds(self) -> int:
        return int(self._ttl.total_seconds())

    def issue_access_token(self, user_id: UUID) -> str:
        now = self._clock.now()
        claims = {
            "iss": self._issuer,
            "aud": self._audience,
            "sub": str(user_id),
            "iat": int(now.timestamp()),
            "exp": int((now + self._ttl).timestamp()),
            "jti": uuid4().hex,
        }
        return jwt.encode(
            claims, self._secret, algorithm=ALGORITHM, headers={"typ": ACCESS_TOKEN_TYPE}
        )

    def verify_access_token(self, token: str) -> AccessClaims:
        invalid = UnauthorizedError("Invalid or expired access token.")
        if len(token) > MAX_TOKEN_LENGTH:
            raise invalid
        try:
            if jwt.get_unverified_header(token).get("typ") != ACCESS_TOKEN_TYPE:
                raise invalid
            claims = jwt.decode(
                token,
                self._secret,
                algorithms=[ALGORITHM],
                audience=self._audience,
                issuer=self._issuer,
                # Expiry is checked below against our own clock.
                options={
                    "require": _REQUIRED_CLAIMS,
                    "verify_exp": False,
                    "verify_iat": False,
                    "verify_nbf": False,
                },
            )
            expires_at = datetime.fromtimestamp(int(claims["exp"]), UTC)
            user_id = UUID(claims["sub"])
        except (jwt.InvalidTokenError, ValueError, TypeError) as exc:
            raise invalid from exc
        if expires_at <= self._clock.now():
            raise invalid
        return AccessClaims(user_id=user_id, jti=str(claims["jti"]), expires_at=expires_at)


def generate_refresh_token() -> tuple[str, str]:
    """Return (raw token to give the client, digest to store)."""
    raw = secrets.token_urlsafe(48)
    return raw, hash_refresh_token(raw)


def hash_refresh_token(raw: str) -> str:
    return hashlib.sha256(raw.encode()).hexdigest()
