"""Verify an identity provider's access tokens (AUTH_MODE=oidc): the resource-server half of OIDC.

The provider (Keycloak, Entra ID, Auth0, ...) signs a JWT with its private key; this
service holds only the public keys, fetched from the provider's JWKS endpoint, and
checks every request itself. A gateway in front may already have checked the same
token, and this code does not rely on that: it is a defence in depth, and the only
check that exists when the service is reached some other way.

What is checked, in this order, and why:
- size, then the unverified header: `alg` must be exactly RS256 and a `kid` must be
  present. Anything else (`none`, HS256 signed with the public key as the secret, a
  missing `kid`) is refused before any key is looked up, so a forged header can never
  select a verification algorithm and never causes a network call;
- the signature, with the algorithm list pinned to RS256 again inside PyJWT;
- `iss` equal to OIDC_ISSUER, `aud` containing OIDC_AUDIENCE, and `exp`, `sub`, `iss`,
  `aud` present;
- `exp` and `nbf` against the injected Clock (not the wall clock, so a test can move
  time) with at most 60 seconds of skew; a non-numeric or NaN time is refused, because
  `nan <= now` is false and would read as "not expired";
- `sub` must be a UUID in canonical form (Keycloak's subjects are), since it becomes
  the user's primary key.

The key set is cached and refetched at most once per OIDC_JWKS_MIN_REFETCH_SECONDS:
on an unknown `kid` (the provider rotated keys), when the cache is older than
OIDC_JWKS_CACHE_SECONDS (so a revoked key stops working), never more often. PyJWT's own
`PyJWKClient` refetches on every unknown `kid`, which lets one client with random
`kid`s turn this service into a load generator against the provider, and it blocks the
event loop; this module does neither. While the provider is unreachable the last good
keys keep working (a short outage must not log everyone out); with no keys at all the
answer is 503, not 401, because the caller did nothing wrong.

Every rejection is the same generic 401 for the client; the reason (an exception class
name, never the token) goes to the log, which is where an operator finds a wrong
issuer in minutes.

What it deliberately does not do: discovery (`/.well-known/openid-configuration`; the
issuer and key URL are configured, because the key URL is often an internal address
that differs from the public issuer), opaque-token introspection, or role mapping.
"""

import asyncio
import json
import math
import re
import urllib.error
import urllib.request
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import datetime
from http.client import HTTPException
from typing import Any, Protocol
from urllib.parse import urlsplit
from uuid import UUID

import jwt
import structlog

from app.core.clock import Clock
from app.core.config import Settings
from app.core.errors import ServiceUnavailableError, UnauthorizedError

log = structlog.get_logger(__name__)

ALGORITHM = "RS256"
# Larger than the local token cap: a provider puts roles, groups and profile claims in it.
MAX_TOKEN_LENGTH = 8192
MAX_JWKS_BYTES = 262_144
MAX_KEYS = 32
_MAX_KID_LENGTH = 256
_REQUIRED_CLAIMS = ["exp", "sub", "iss", "aud"]
_EMAIL_SHAPE = re.compile(r"^[^@\s\x00-\x1f]{1,64}@[^@\s\x00-\x1f]{1,255}$")


@dataclass(frozen=True)
class OidcIdentity:
    """Who the token says the caller is."""

    subject: UUID
    email: str


class JwksFetcher(Protocol):
    """Returns the provider's JWKS document. Raises on any failure to get one."""

    async def __call__(self) -> Mapping[str, Any]: ...


class _NoRedirects(urllib.request.HTTPRedirectHandler):
    """A key endpoint that redirects is misconfigured or hijacked: fail, do not follow."""

    def redirect_request(self, *_args: Any, **_kwargs: Any) -> None:
        return None


class HttpJwksFetcher:
    """GET the JWKS over HTTP(S) with a deadline, a size cap and no redirects.

    Standard library only (`urllib`), run in a worker thread so the event loop never waits
    on the network: one GET every few minutes does not justify an HTTP client dependency.
    """

    def __init__(self, uri: str, timeout_seconds: float) -> None:
        if urlsplit(uri).scheme not in {"http", "https"}:
            msg = "the JWKS URI must be http:// or https://"
            raise ValueError(msg)
        self._uri = uri
        self._timeout = timeout_seconds
        self._opener = urllib.request.build_opener(_NoRedirects)

    async def __call__(self) -> Mapping[str, Any]:
        # urllib's timeout bounds each socket operation; this bounds the whole fetch.
        async with asyncio.timeout(self._timeout * 2):
            return await asyncio.to_thread(self._get)

    def _get(self) -> Mapping[str, Any]:
        request = urllib.request.Request(  # noqa: S310  # nosec B310 - scheme checked in __init__
            self._uri, headers={"Accept": "application/json"}
        )
        try:
            with self._opener.open(request, timeout=self._timeout) as response:  # nosec B310
                if response.status != 200:
                    msg = f"the JWKS endpoint answered {response.status}"
                    raise ValueError(msg)
                raw = response.read(MAX_JWKS_BYTES + 1)
        except urllib.error.HTTPError as exc:  # 3xx (not followed), 4xx, 5xx
            exc.close()  # an HTTPError holds the response body open until closed
            msg = f"the JWKS endpoint answered {exc.code}"
            raise ValueError(msg) from None
        if len(raw) > MAX_JWKS_BYTES:
            msg = "the JWKS document is too large"
            raise ValueError(msg)
        document = json.loads(raw)
        if not isinstance(document, dict):
            msg = "the JWKS document is not a JSON object"
            raise TypeError(msg)
        return document


def _reject(reason: str) -> UnauthorizedError:
    log.info("auth.oidc_rejected", reason=reason)
    return UnauthorizedError("Invalid or expired access token.")


def _timestamp(value: object, reason: str) -> float:
    if isinstance(value, bool) or not isinstance(value, int | float) or not math.isfinite(value):
        raise _reject(reason)
    return float(value)


def _subject(value: object) -> UUID:
    if not isinstance(value, str):
        raise _reject("subject")
    try:
        parsed = UUID(value)
    except ValueError:
        raise _reject("subject") from None
    if str(parsed) != value.lower():  # `{...}`, `urn:uuid:...`, un-hyphenated: not canonical
        raise _reject("subject")
    return parsed


def _email(value: object, subject: UUID) -> str:
    """The `email` claim lower-cased, or a stable placeholder when absent or not an address.

    `.invalid` is reserved (RFC 2606): it can never be a real mailbox, and it is unique per
    subject, so two address-less accounts never collide on the unique email column.
    """
    if isinstance(value, str):
        email = value.strip().lower()
        if _EMAIL_SHAPE.fullmatch(email):
            return email
    return f"{subject}@oidc.invalid"


def _required(value: str | None, name: str) -> str:
    if not value:
        msg = f"{name} is required when AUTH_MODE=oidc"
        raise ValueError(msg)
    return value


class OidcVerifier:
    def __init__(
        self, settings: Settings, clock: Clock, fetcher: JwksFetcher | None = None
    ) -> None:
        self._issuer = _required(settings.oidc_issuer, "OIDC_ISSUER")
        self._audience = _required(settings.oidc_audience, "OIDC_AUDIENCE")
        jwks_uri = _required(settings.oidc_jwks_uri, "OIDC_JWKS_URI")
        self._skew = settings.oidc_clock_skew_seconds
        self._cache_seconds = settings.oidc_jwks_cache_seconds
        self._min_refetch_seconds = settings.oidc_jwks_min_refetch_seconds
        self._clock = clock
        self._fetch: JwksFetcher = fetcher or HttpJwksFetcher(
            jwks_uri, settings.oidc_jwks_timeout_seconds
        )
        self._keys: dict[str, jwt.PyJWK] = {}
        self._loaded_at: datetime | None = None
        self._last_attempt_at: datetime | None = None
        self._lock = asyncio.Lock()

    async def verify(self, token: str) -> OidcIdentity:
        if len(token) > MAX_TOKEN_LENGTH:
            raise _reject("too_long")
        try:
            header = jwt.get_unverified_header(token)
        except jwt.InvalidTokenError as exc:
            raise _reject("malformed") from exc
        kid = header.get("kid")
        if header.get("alg") != ALGORITHM:
            raise _reject("algorithm")
        if not isinstance(kid, str) or not 0 < len(kid) <= _MAX_KID_LENGTH:
            raise _reject("kid")
        key = await self._key_for(kid)
        try:
            claims = jwt.decode(
                token,
                key,
                algorithms=[ALGORITHM],
                audience=self._audience,
                issuer=self._issuer,
                # Time is checked below against our own clock.
                options={
                    "require": _REQUIRED_CLAIMS,
                    "verify_exp": False,
                    "verify_nbf": False,
                    "verify_iat": False,
                },
            )
        except (jwt.InvalidTokenError, ValueError, TypeError) as exc:
            raise _reject(type(exc).__name__) from exc
        self._check_times(claims)
        subject = _subject(claims["sub"])
        return OidcIdentity(subject=subject, email=_email(claims.get("email"), subject))

    def _check_times(self, claims: Mapping[str, Any]) -> None:
        now = self._clock.now().timestamp()
        if _timestamp(claims["exp"], "exp") + self._skew <= now:
            raise _reject("expired")
        if "nbf" in claims and _timestamp(claims["nbf"], "nbf") - self._skew > now:
            raise _reject("not_yet_valid")

    # ---------------------------------------------------------------- key set

    def _fresh_key(self, kid: str) -> jwt.PyJWK | None:
        key = self._keys.get(kid)
        if key is None or self._loaded_at is None:
            return None
        age = (self._clock.now() - self._loaded_at).total_seconds()
        return key if age < self._cache_seconds else None

    def _may_refetch(self) -> bool:
        if self._last_attempt_at is None:
            return True
        since = (self._clock.now() - self._last_attempt_at).total_seconds()
        return since < 0 or since >= self._min_refetch_seconds  # a clock stepped back: allow

    async def _key_for(self, kid: str) -> jwt.PyJWK:
        key = self._fresh_key(kid)
        if key is not None:  # the hot path: no lock, no network
            return key
        async with self._lock:
            # A concurrent request may have refreshed while this one waited for the lock.
            key = self._fresh_key(kid)
            if key is not None:
                return key
            if self._may_refetch():
                await self._refresh()
        key = self._keys.get(kid)  # a stale key is still used until a refresh replaces it
        if key is not None:
            return key
        if not self._keys:
            raise ServiceUnavailableError("The identity provider's signing keys are unavailable.")
        raise _reject("unknown_kid")

    async def _refresh(self) -> None:
        """Replace the key set, or keep the old one: this never raises."""
        self._last_attempt_at = self._clock.now()
        try:
            document = await self._fetch()
            keys = _parse_keys(document)
        except (OSError, HTTPException, ValueError, TypeError, TimeoutError) as exc:
            log.warning("auth.oidc_jwks_unavailable", error=f"{type(exc).__name__}: {exc}"[:200])
            return
        self._keys = keys
        self._loaded_at = self._last_attempt_at
        log.info("auth.oidc_jwks_loaded", keys=len(keys))


def _parse_keys(document: Mapping[str, Any]) -> dict[str, jwt.PyJWK]:
    """The usable signing keys by `kid`: RSA, for signatures, for RS256, with a `kid`.

    Keycloak's set also holds encryption keys (`use: enc`) and keys for other
    algorithms; those are skipped, as is any single malformed entry. A document with no
    usable key at all is an error: it must not replace a working cache with nothing.
    """
    entries = document.get("keys")
    if not isinstance(entries, list):
        msg = "the JWKS document has no `keys` list"
        raise TypeError(msg)
    keys: dict[str, jwt.PyJWK] = {}
    for entry in entries[:MAX_KEYS]:
        if not isinstance(entry, dict):
            continue
        kid = entry.get("kid")
        if (
            entry.get("kty") != "RSA"
            or entry.get("use", "sig") != "sig"
            or entry.get("alg", ALGORITHM) != ALGORITHM
            or not isinstance(kid, str)
            or not kid
        ):
            continue
        try:
            keys[kid] = jwt.PyJWK.from_dict(entry, algorithm=ALGORITHM)
        except jwt.PyJWTError, ValueError, TypeError, KeyError:
            continue
    if not keys:
        msg = "the JWKS document has no usable RS256 signing key"
        raise ValueError(msg)
    return keys
