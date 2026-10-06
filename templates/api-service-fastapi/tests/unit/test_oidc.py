"""The OIDC token verifier, without HTTP or a database: every way a token can be wrong.

The provider is `FakeJwks` (a generated RSA key and an injected fetcher), so there is no
network and no Keycloak. Time is the manual clock, so expiry and the refetch floor are
exact, not slept through.
"""

import asyncio
from typing import Any
from uuid import UUID, uuid4

import jwt
import pytest
from pydantic import ValidationError

from app.core.errors import ServiceUnavailableError, UnauthorizedError
from app.core.oidc import MAX_TOKEN_LENGTH, OidcVerifier
from tests.oidc_support import (
    KID,
    FakeJwks,
    claims_for,
    forge_hs256_with_public_key,
    forge_unsigned,
    mint,
    oidc_settings,
    public_jwk,
    rsa_key,
    subject_of,
    tamper_payload,
)
from tests.support import ManualClock


def verifier(clock: ManualClock, jwks: FakeJwks, **settings: Any) -> OidcVerifier:
    return OidcVerifier(oidc_settings(**settings), clock, jwks)


async def refused(oidc: OidcVerifier, token: str) -> None:
    with pytest.raises(UnauthorizedError) as caught:
        await oidc.verify(token)
    assert caught.value.status_code == 401
    assert caught.value.headers["WWW-Authenticate"] == "Bearer"
    assert len(token) < 8 or token not in str(caught.value.detail)


async def test_a_valid_token_gives_the_subject_and_a_lower_cased_email() -> None:
    clock, jwks = ManualClock(), FakeJwks()
    token = mint(clock, email="  Alice@Example.COM ")
    identity = await verifier(clock, jwks).verify(token)
    assert identity.subject == subject_of(token)
    assert identity.email == "alice@example.com"


@pytest.mark.parametrize("email", [None, "", "not an address", 42, "a@b@c", "a" * 400 + "@x.io"])
async def test_without_a_usable_email_the_placeholder_for_the_subject_is_used(
    email: object,
) -> None:
    clock = ManualClock()
    token = mint(clock, email=email)
    identity = await verifier(clock, FakeJwks()).verify(token)
    assert identity.email == f"{identity.subject}@oidc.invalid"


async def test_the_audience_may_be_one_of_several() -> None:
    clock = ManualClock()
    oidc = verifier(clock, FakeJwks())
    await oidc.verify(mint(clock, aud=["account", "app-api"]))
    await refused(oidc, mint(clock, aud=["account", "somebody-else"]))


@pytest.mark.parametrize(
    "overrides",
    [
        {"iss": "http://evil.example/realms/app"},
        {"iss": "http://localhost:8080/idp/realms/app/"},  # exact match: no trailing-slash grace
        {"iss": None},
        {"aud": "another-api"},
        {"aud": None},
        {"exp": None},
        {"sub": None},
    ],
    ids=["issuer", "issuer-slash", "no-iss", "audience", "no-aud", "no-exp", "no-sub"],
)
async def test_a_wrong_or_missing_claim_is_refused(overrides: dict[str, Any]) -> None:
    clock = ManualClock()
    await refused(verifier(clock, FakeJwks()), mint(clock, **overrides))


async def test_expiry_is_enforced_against_the_injected_clock_with_the_configured_skew() -> None:
    clock = ManualClock()
    oidc = verifier(clock, FakeJwks(), oidc_clock_skew_seconds=10)
    token = mint(clock)  # exp = now + 300
    clock.advance(seconds=300 + 9)
    await oidc.verify(token)  # inside the skew
    clock.advance(seconds=1)
    await refused(oidc, token)  # exp + skew <= now


async def test_a_token_that_is_not_valid_yet_is_refused_until_its_nbf() -> None:
    clock = ManualClock()
    oidc = verifier(clock, FakeJwks(), oidc_clock_skew_seconds=0)
    now = int(clock.now().timestamp())
    token = mint(clock, nbf=now + 60)
    await refused(oidc, token)
    clock.advance(seconds=60)
    await oidc.verify(token)


@pytest.mark.parametrize("value", ["soon", True, float("nan"), float("inf"), [1]])
async def test_a_non_numeric_or_non_finite_time_claim_is_refused(value: object) -> None:
    """`nan <= now` is false, so without an explicit finite check NaN reads as "not expired"."""
    clock = ManualClock()
    oidc = verifier(clock, FakeJwks())
    await refused(oidc, mint(clock, exp=value))
    await refused(oidc, mint(clock, nbf=value))


def test_the_skew_cannot_exceed_a_minute() -> None:
    with pytest.raises(ValidationError, match="oidc_clock_skew_seconds"):
        oidc_settings(oidc_clock_skew_seconds=61)


@pytest.mark.parametrize(
    "subject",
    [
        "not-a-uuid",
        "",
        str(uuid4()).replace("-", ""),
        f"urn:uuid:{uuid4()}",
        "{" + str(uuid4()) + "}",
        12345,
        ["a"],
    ],
)
async def test_a_subject_that_is_not_a_canonical_uuid_is_refused(subject: object) -> None:
    clock = ManualClock()
    await refused(verifier(clock, FakeJwks()), mint(clock, sub=subject))


async def test_an_upper_case_uuid_subject_is_accepted_as_the_same_person() -> None:
    clock = ManualClock()
    sub = uuid4()
    identity = await verifier(clock, FakeJwks()).verify(mint(clock, sub=str(sub).upper()))
    assert identity.subject == sub


async def test_alg_none_is_refused_before_any_key_is_fetched() -> None:
    clock, jwks = ManualClock(), FakeJwks()
    await refused(verifier(clock, jwks), forge_unsigned(claims_for(clock)))
    assert jwks.calls == 0


async def test_hs256_signed_with_the_public_key_is_refused_algorithm_confusion() -> None:
    clock, jwks = ManualClock(), FakeJwks()
    await refused(verifier(clock, jwks), forge_hs256_with_public_key(claims_for(clock)))
    assert jwks.calls == 0


async def test_a_tampered_payload_fails_the_signature() -> None:
    clock = ManualClock()
    token = mint(clock)
    await refused(verifier(clock, FakeJwks()), tamper_payload(token, sub=str(uuid4())))


async def test_a_token_signed_by_another_key_with_a_known_kid_is_refused() -> None:
    clock = ManualClock()
    await refused(verifier(clock, FakeJwks()), mint(clock, key=rsa_key("attacker")))


async def test_a_token_without_a_kid_is_refused() -> None:
    clock, jwks = ManualClock(), FakeJwks()
    await refused(verifier(clock, jwks), mint(clock, kid=None))
    assert jwks.calls == 0


async def test_an_absurd_kid_is_refused_without_a_fetch() -> None:
    clock, jwks = ManualClock(), FakeJwks()
    await refused(verifier(clock, jwks), mint(clock, kid="k" * 1000))
    assert jwks.calls == 0


@pytest.mark.parametrize(
    "garbage", ["", "x", "a.b.c", "Bearer abc", "ey.ey.ey", "a" * (MAX_TOKEN_LENGTH + 1)]
)
async def test_garbage_is_a_401_not_a_crash(garbage: str) -> None:
    clock, jwks = ManualClock(), FakeJwks()
    await refused(verifier(clock, jwks), garbage)
    assert jwks.calls == 0


async def test_a_payload_that_is_not_a_json_object_is_refused() -> None:
    clock = ManualClock()
    header, _payload, signature = mint(clock).split(".")
    token = f"{header}.WzEsMl0.{signature}"  # the payload is base64url of [1,2]
    await refused(verifier(clock, FakeJwks()), token)


# ------------------------------------------------------------------ key set: rotation and limits


async def test_an_unknown_kid_fetches_the_rotated_key_but_only_after_the_floor() -> None:
    clock, jwks = ManualClock(), FakeJwks()
    oidc = verifier(clock, jwks, oidc_jwks_min_refetch_seconds=30)
    await oidc.verify(mint(clock))
    assert jwks.calls == 1
    jwks.keys = {"key-2": rsa_key("rotated")}  # the provider rotates
    token = mint(clock, key=rsa_key("rotated"), kid="key-2")
    await refused(oidc, token)  # inside the floor: no refetch, so the new key is not known yet
    assert jwks.calls == 1
    clock.advance(seconds=30)
    await oidc.verify(token)  # the floor passed: refetched, verified
    assert jwks.calls == 2


async def test_a_flood_of_random_kids_cannot_hammer_the_provider() -> None:
    clock, jwks = ManualClock(), FakeJwks()
    oidc = verifier(clock, jwks)
    await oidc.verify(mint(clock))
    for i in range(50):
        await refused(oidc, mint(clock, kid=f"made-up-{i}"))
    assert jwks.calls == 1  # not one extra fetch in the whole flood
    clock.advance(seconds=31)
    for i in range(50):
        await refused(oidc, mint(clock, kid=f"made-up-again-{i}"))
    assert jwks.calls == 2  # one per floor, however many bad tokens


async def test_concurrent_first_requests_share_one_fetch() -> None:
    clock, jwks = ManualClock(), FakeJwks()
    oidc = verifier(clock, jwks)
    tokens = [mint(clock) for _ in range(20)]
    identities = await asyncio.gather(*(oidc.verify(t) for t in tokens))
    assert len(identities) == 20
    assert jwks.calls == 1


async def test_keys_older_than_the_cache_are_refetched_and_a_revoked_key_stops_working() -> None:
    clock, jwks = ManualClock(), FakeJwks()
    oidc = verifier(clock, jwks, oidc_jwks_cache_seconds=60)
    token = mint(clock)
    await oidc.verify(token)
    clock.advance(seconds=59)
    await oidc.verify(token)
    assert jwks.calls == 1
    jwks.keys = {"key-2": rsa_key("rotated")}  # key-1 is withdrawn
    clock.advance(seconds=2)
    await refused(oidc, token)
    assert jwks.calls == 2


async def test_a_provider_outage_keeps_the_last_good_keys_working() -> None:
    clock, jwks = ManualClock(), FakeJwks()
    oidc = verifier(clock, jwks, oidc_jwks_cache_seconds=60)
    token = mint(clock, exp=int(clock.now().timestamp()) + 3600)
    await oidc.verify(token)
    jwks.fail = True
    clock.advance(seconds=120)  # the cache is stale and the refresh fails
    await oidc.verify(token)
    assert jwks.calls == 2
    await oidc.verify(token)  # and the failed attempt is not repeated inside the floor
    assert jwks.calls == 2


async def test_with_no_keys_at_all_the_answer_is_503_not_401() -> None:
    clock, jwks = ManualClock(), FakeJwks()
    jwks.fail = True
    oidc = verifier(clock, jwks)
    with pytest.raises(ServiceUnavailableError):
        await oidc.verify(mint(clock))
    jwks.fail = False
    clock.advance(seconds=31)
    await oidc.verify(mint(clock))  # recovers once the provider is back


async def test_a_document_without_a_usable_key_does_not_replace_a_working_cache() -> None:
    clock, jwks = ManualClock(), FakeJwks()
    oidc = verifier(clock, jwks, oidc_jwks_cache_seconds=60)
    token = mint(clock, exp=int(clock.now().timestamp()) + 3600)
    await oidc.verify(token)
    jwks.keys = {}  # a bad deploy at the provider: an empty key set
    clock.advance(seconds=61)
    await oidc.verify(token)  # still served from the last good set
    assert jwks.calls == 2


async def test_unusable_entries_are_skipped_and_the_rest_still_work() -> None:
    clock, jwks = ManualClock(), FakeJwks()
    primary = rsa_key("primary")
    jwks.extra_entries = [
        "not an object",
        {"kty": "RSA", "kid": "enc-1", "use": "enc", "n": "AQAB", "e": "AQAB"},
        {"kty": "EC", "kid": "ec-1", "crv": "P-256", "x": "AA", "y": "AA"},
        {"kty": "RSA", "use": "sig", "n": "AQAB", "e": "AQAB"},  # no kid
        {**public_jwk("rs512", primary), "alg": "RS512"},
        {"kty": "RSA", "kid": "broken", "use": "sig", "n": "!!", "e": "AQAB"},
    ]
    oidc = verifier(clock, jwks)
    await oidc.verify(mint(clock))
    clock.advance(seconds=31)  # past the floor, so each unknown kid below really looks again
    for kid in ("enc-1", "ec-1", "rs512", "broken"):
        await refused(oidc, mint(clock, kid=kid))


async def test_a_jwks_document_that_is_not_a_key_list_is_an_outage() -> None:
    clock = ManualClock()

    async def not_jwks() -> dict[str, Any]:
        return {"keys": "nope"}

    oidc = OidcVerifier(oidc_settings(), clock, not_jwks)
    with pytest.raises(ServiceUnavailableError):
        await oidc.verify(mint(clock))


async def test_a_clock_stepped_back_does_not_freeze_the_refresh() -> None:
    clock, jwks = ManualClock(), FakeJwks()
    oidc = verifier(clock, jwks)
    await oidc.verify(mint(clock))
    clock.advance(seconds=-3600)
    jwks.keys = {"key-2": rsa_key("rotated")}
    await oidc.verify(mint(clock, key=rsa_key("rotated"), kid="key-2"))
    assert jwks.calls == 2


def test_the_verifier_refuses_incomplete_settings() -> None:
    settings = oidc_settings().model_copy(update={"oidc_issuer": None})
    with pytest.raises(ValueError, match="OIDC_ISSUER"):
        OidcVerifier(settings, ManualClock(), FakeJwks())


def test_the_helper_mints_what_the_verifier_accepts_so_the_negatives_above_mean_something() -> None:
    clock = ManualClock()
    token = mint(clock)
    header = jwt.get_unverified_header(token)
    assert header["alg"] == "RS256"
    assert header["kid"] == KID
    assert isinstance(subject_of(token), UUID)
