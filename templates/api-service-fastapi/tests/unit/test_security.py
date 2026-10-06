"""Password hashing and tokens, without HTTP or a database."""

import re
from datetime import timedelta
from uuid import uuid4

import jwt
import pytest
from pydantic import SecretStr

from app.core.errors import UnauthorizedError
from app.core.security import (
    ACCESS_TOKEN_TYPE,
    PasswordService,
    TokenService,
    generate_refresh_token,
    hash_refresh_token,
)
from tests.support import JWT_SECRET, ManualClock, make_settings
from tests.unit.test_config import settings as production_like_settings


async def test_the_default_argon2_parameters_appear_in_the_hash() -> None:
    """Pins what OWASP asks for: Argon2id with m>=19456 KiB, t>=2. Changing a default
    must be a deliberate edit to this test, not a side effect."""
    service = PasswordService(production_like_settings())
    hashed = await service.hash("a password")
    match = re.match(r"^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$", hashed)
    assert match, hashed
    memory, time_cost, parallelism = map(int, match.groups())
    assert (memory, time_cost, parallelism) == (65_536, 3, 2)
    assert memory >= 19_456
    assert time_cost >= 2


async def test_verify_accepts_the_right_password_and_rejects_the_wrong_one() -> None:
    service = PasswordService(make_settings())
    hashed = await service.hash("correct horse")
    assert (await service.verify("correct horse", hashed))[0] is True
    assert (await service.verify("wrong horse", hashed))[0] is False


async def test_two_hashes_of_one_password_differ_because_the_salt_is_random() -> None:
    service = PasswordService(make_settings())
    assert await service.hash("same") != await service.hash("same")


async def test_a_hash_with_weaker_parameters_comes_back_upgraded() -> None:
    old = PasswordService(make_settings(argon2_memory_cost_kib=8, argon2_time_cost=1))
    new = PasswordService(make_settings(argon2_memory_cost_kib=16, argon2_time_cost=2))
    valid, replacement = await new.verify("pw", await old.hash("pw"))
    assert valid
    assert replacement is not None
    assert "m=16,t=2" in replacement
    assert (await new.verify("pw", replacement))[1] is None  # now current: nothing to upgrade


async def test_burn_spends_time_without_an_account() -> None:
    await PasswordService(make_settings()).burn("anything")  # must not raise


def _tokens(clock: ManualClock | None = None, **overrides: object) -> TokenService:
    return TokenService(make_settings(**overrides), clock or ManualClock())


def test_an_access_token_round_trips() -> None:
    user_id = uuid4()
    tokens = _tokens()
    claims = tokens.verify_access_token(tokens.issue_access_token(user_id))
    assert claims.user_id == user_id


def test_the_token_header_marks_it_as_an_access_token() -> None:
    token = _tokens().issue_access_token(uuid4())
    header = jwt.get_unverified_header(token)
    assert header == {"alg": "HS256", "typ": ACCESS_TOKEN_TYPE}


def test_an_expired_token_is_refused_against_the_injected_clock() -> None:
    clock = ManualClock()
    tokens = _tokens(clock)
    token = tokens.issue_access_token(uuid4())
    clock.advance(seconds=899)
    tokens.verify_access_token(token)
    clock.advance(seconds=1)
    with pytest.raises(UnauthorizedError):
        tokens.verify_access_token(token)


def _forge(claims: dict[str, object], key: str = JWT_SECRET, **kwargs: object) -> str:
    return jwt.encode(claims, key, algorithm="HS256", headers={"typ": ACCESS_TOKEN_TYPE}, **kwargs)  # type: ignore[arg-type]


def _good_claims(clock: ManualClock) -> dict[str, object]:
    now = int(clock.now().timestamp())
    return {
        "iss": "api-service",
        "aud": "api-service-clients",
        "sub": str(uuid4()),
        "iat": now,
        "exp": now + 600,
        "jti": "abc",
    }


def test_the_helper_forges_a_valid_token_so_the_negative_cases_below_mean_something() -> None:
    clock = ManualClock()
    _tokens(clock).verify_access_token(_forge(_good_claims(clock)))


@pytest.mark.parametrize(
    "mutation",
    [
        lambda c: {**c, "iss": "someone-else"},
        lambda c: {**c, "aud": "another-audience"},
        lambda c: {**c, "sub": "not-a-uuid"},
        lambda c: {k: v for k, v in c.items() if k != "exp"},
        lambda c: {k: v for k, v in c.items() if k != "jti"},
        lambda c: {k: v for k, v in c.items() if k != "aud"},
    ],
    ids=["issuer", "audience", "subject", "no-exp", "no-jti", "no-aud"],
)
def test_a_token_with_a_wrong_or_missing_claim_is_refused(mutation: object) -> None:
    clock = ManualClock()
    claims = mutation(_good_claims(clock))  # type: ignore[operator]
    with pytest.raises(UnauthorizedError):
        _tokens(clock).verify_access_token(_forge(claims))


def test_a_token_signed_with_another_key_is_refused() -> None:
    clock = ManualClock()
    token = _forge(_good_claims(clock), key="a-different-key-that-is-long-enough-0123456789")
    with pytest.raises(UnauthorizedError):
        _tokens(clock).verify_access_token(token)


def test_alg_none_is_refused() -> None:
    clock = ManualClock()
    unsigned = jwt.encode(
        _good_claims(clock), None, algorithm="none", headers={"typ": ACCESS_TOKEN_TYPE}
    )
    with pytest.raises(UnauthorizedError):
        _tokens(clock).verify_access_token(unsigned)


def test_a_jwt_without_the_access_token_type_is_refused() -> None:
    clock = ManualClock()
    plain = jwt.encode(_good_claims(clock), JWT_SECRET, algorithm="HS256")  # typ: JWT
    with pytest.raises(UnauthorizedError):
        _tokens(clock).verify_access_token(plain)


@pytest.mark.parametrize("garbage", ["", "x", "a.b.c", "a" * 5000, "Bearer abc", "ey.ey.ey"])
def test_garbage_is_a_401_not_a_crash(garbage: str) -> None:
    with pytest.raises(UnauthorizedError):
        _tokens().verify_access_token(garbage)


def test_token_lifetime_follows_the_setting() -> None:
    clock = ManualClock()
    tokens = _tokens(clock, access_token_ttl_seconds=60)
    token = tokens.issue_access_token(uuid4())
    claims = jwt.decode(
        token,
        JWT_SECRET,
        algorithms=["HS256"],
        audience="api-service-clients",
        options={"verify_exp": False, "verify_iat": False},
    )
    assert claims["exp"] - claims["iat"] == 60
    assert tokens.access_ttl_seconds == 60
    clock.advance(seconds=61)
    with pytest.raises(UnauthorizedError):
        tokens.verify_access_token(token)


def test_refresh_tokens_are_random_and_stored_only_as_a_digest() -> None:
    raw1, digest1 = generate_refresh_token()
    raw2, _ = generate_refresh_token()
    assert raw1 != raw2
    assert len(raw1) >= 64  # 48 random bytes, base64url
    assert digest1 == hash_refresh_token(raw1)
    assert digest1 != raw1
    assert re.fullmatch(r"[0-9a-f]{64}", digest1)


def test_secret_value_is_not_in_the_repr_of_settings() -> None:
    assert JWT_SECRET not in repr(make_settings())
    assert isinstance(make_settings().jwt_secret, SecretStr)
    assert timedelta(seconds=make_settings().access_token_ttl_seconds) <= timedelta(hours=1)
