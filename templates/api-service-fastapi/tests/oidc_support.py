"""Test doubles for AUTH_MODE=oidc: RSA keys, a fake JWKS endpoint, and token minting.

No network and no identity provider. The "provider" is a generated RSA key pair and an
async callable that returns its public half as a JWKS document, injected into the app
where the real service would fetch from Keycloak. The forging helpers build the tokens
an attacker would: unsigned (`alg: none`), and HS256 signed with the public key used as
the HMAC secret (the algorithm-confusion attack).
"""

import asyncio
import base64
import hashlib
import hmac
import json
from collections.abc import Mapping
from functools import cache
from typing import Any
from uuid import UUID, uuid4

import jwt
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa

from app.core.config import Settings
from tests.support import ManualClock, make_settings

ISSUER = "http://localhost:8080/idp/realms/app"
AUDIENCE = "app-api"
JWKS_URI = "http://keycloak.test:8080/idp/realms/app/protocol/openid-connect/certs"
KID = "key-1"


@cache
def rsa_key(name: str) -> rsa.RSAPrivateKey:
    """A 2048-bit key per name, generated once per test session."""
    return rsa.generate_private_key(public_exponent=65_537, key_size=2048)


def public_jwk(kid: str, key: rsa.RSAPrivateKey, **extra: Any) -> dict[str, Any]:
    jwk: dict[str, Any] = json.loads(jwt.algorithms.RSAAlgorithm.to_jwk(key.public_key()))
    return {**jwk, "kid": kid, "use": "sig", "alg": "RS256", **extra}


class FakeJwks:
    """The provider's JWKS endpoint. `keys` can be changed to rotate; `fail` simulates an outage."""

    def __init__(self, **keys: rsa.RSAPrivateKey) -> None:
        self.keys: dict[str, rsa.RSAPrivateKey] = keys or {KID: rsa_key("primary")}
        self.fail = False
        self.calls = 0
        self.extra_entries: list[Any] = []

    async def __call__(self) -> Mapping[str, Any]:
        self.calls += 1
        await asyncio.sleep(0)  # a real fetch yields: concurrent requests really do interleave
        if self.fail:
            msg = "the provider is down"
            raise OSError(msg)
        return {"keys": [public_jwk(kid, k) for kid, k in self.keys.items()] + self.extra_entries}


def oidc_settings(**overrides: Any) -> Settings:
    values: dict[str, Any] = {
        "auth_mode": "oidc",
        "jwt_secret": None,
        "oidc_issuer": ISSUER,
        "oidc_jwks_uri": JWKS_URI,
        "oidc_audience": AUDIENCE,
    }
    values.update(overrides)
    return make_settings(**values)


def claims_for(clock: ManualClock, **overrides: Any) -> dict[str, Any]:
    """A valid access-token payload; an override of None removes that claim."""
    now = int(clock.now().timestamp())
    claims: dict[str, Any] = {
        "iss": ISSUER,
        "aud": AUDIENCE,
        "sub": str(uuid4()),
        "email": "alice@example.com",
        "iat": now,
        "exp": now + 300,
    }
    claims.update(overrides)
    return {k: v for k, v in claims.items() if v is not None}


def mint(
    clock: ManualClock,
    *,
    key: rsa.RSAPrivateKey | None = None,
    kid: str | None = KID,
    **overrides: Any,
) -> str:
    """A token signed like the provider signs it (RS256, with a `kid`)."""
    headers = {"kid": kid} if kid is not None else {}
    return jwt.encode(
        claims_for(clock, **overrides),
        key or rsa_key("primary"),
        algorithm="RS256",
        headers=headers,
    )


def subject_of(token: str) -> UUID:
    return UUID(jwt.decode(token, options={"verify_signature": False})["sub"])


def _b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def _segment(value: Mapping[str, Any]) -> str:
    return _b64(json.dumps(value, separators=(",", ":")).encode())


def forge_unsigned(claims: Mapping[str, Any], kid: str = KID) -> str:
    return f"{_segment({'alg': 'none', 'kid': kid, 'typ': 'JWT'})}.{_segment(claims)}."


def forge_hs256_with_public_key(claims: Mapping[str, Any], kid: str = KID) -> str:
    """The algorithm-confusion attack: HMAC-SHA256 keyed with the provider's PUBLIC key PEM."""
    pem = (
        rsa_key("primary")
        .public_key()
        .public_bytes(serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo)
    )
    signing_input = f"{_segment({'alg': 'HS256', 'kid': kid, 'typ': 'JWT'})}.{_segment(claims)}"
    signature = hmac.new(pem, signing_input.encode(), hashlib.sha256).digest()
    return f"{signing_input}.{_b64(signature)}"


def tamper_payload(token: str, **changes: Any) -> str:
    """Change claims but keep the original signature: the signature must no longer match."""
    header, payload, signature = token.split(".")
    claims = json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)))
    claims.update(changes)
    return f"{header}.{_segment(claims)}.{signature}"
