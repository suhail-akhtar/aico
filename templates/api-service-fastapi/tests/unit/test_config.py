"""Configuration fails fast on bad values, and the security-relevant defaults are pinned."""

import pytest
from pydantic import SecretStr, ValidationError

from app.core.config import OWASP_MIN_MEMORY_KIB, OWASP_MIN_TIME_COST, Settings
from tests.support import JWT_SECRET

PG = "postgresql+psycopg://user:pw@db:5432/app"  # standards-allow: secret (fake URL)


def settings(**overrides: object) -> Settings:
    values: dict[str, object] = {"jwt_secret": SecretStr(JWT_SECRET), "_env_file": None}
    values.update(overrides)
    return Settings(**values)  # type: ignore[arg-type]


def test_the_argon2_defaults_are_pinned_and_above_the_owasp_minimum() -> None:
    s = settings()
    assert (s.argon2_time_cost, s.argon2_memory_cost_kib, s.argon2_parallelism) == (3, 65_536, 2)
    assert s.argon2_memory_cost_kib >= OWASP_MIN_MEMORY_KIB
    assert s.argon2_time_cost >= OWASP_MIN_TIME_COST


def test_the_token_lifetimes_are_short_by_default() -> None:
    s = settings()
    assert s.access_token_ttl_seconds == 900
    assert s.refresh_token_ttl_days == 14


def test_a_short_jwt_secret_is_refused() -> None:
    with pytest.raises(ValidationError, match="at least 32"):
        settings(jwt_secret=SecretStr("too-short"))


def test_a_missing_jwt_secret_is_refused(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("JWT_SECRET", raising=False)
    with pytest.raises(ValidationError, match="JWT_SECRET is required"):
        Settings(_env_file=None)


def test_production_refuses_the_placeholder_secret() -> None:
    placeholder = SecretStr("change-me-" + "0" * 40)
    with pytest.raises(ValidationError, match="placeholder"):
        settings(app_env="production", jwt_secret=placeholder, database_url=PG)
    assert settings(app_env="development", jwt_secret=placeholder)  # fine locally


def test_production_requires_postgres() -> None:
    with pytest.raises(ValidationError, match="postgresql"):
        settings(app_env="production")
    with pytest.raises(ValidationError, match="postgresql"):
        settings(app_env="production", database_url="sqlite+aiosqlite:///x.db")
    assert settings(app_env="production", database_url=PG).is_production


@pytest.mark.parametrize("scheme", ["postgres://", "postgresql://"])
def test_platform_style_urls_are_normalised_for_the_driver(scheme: str) -> None:
    s = settings(database_url=f"{scheme}user:pw@db/app")
    assert s.effective_database_url == "postgresql+psycopg://user:pw@db/app"


def test_development_falls_back_to_a_local_sqlite_file() -> None:
    assert settings().effective_database_url.startswith("sqlite+aiosqlite:///")


def test_argon2_cannot_be_weakened_outside_the_test_environment() -> None:
    with pytest.raises(ValidationError, match="OWASP"):
        settings(argon2_memory_cost_kib=8)
    with pytest.raises(ValidationError, match="OWASP"):
        settings(argon2_time_cost=1, app_env="production", database_url=PG)
    assert settings(argon2_memory_cost_kib=8, argon2_time_cost=1, app_env="test")


def test_origins_are_a_comma_separated_allow_list_and_never_a_wildcard() -> None:
    s = settings(allowed_origins="https://a.example, https://b.example")
    assert s.allowed_origins == ["https://a.example", "https://b.example"]
    with pytest.raises(ValidationError, match="explicit origins"):
        settings(allowed_origins="*")


def test_a_bad_rate_limit_rule_is_refused_at_startup() -> None:
    with pytest.raises(ValidationError):
        settings(rate_limit_auth="lots")
    assert settings(rate_limit_auth="5/second")


def test_settings_are_immutable() -> None:
    with pytest.raises(ValidationError):
        settings().app_env = "production"  # type: ignore[misc]


def test_the_environment_is_the_source(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("JWT_SECRET", JWT_SECRET)
    monkeypatch.setenv("ALLOWED_ORIGINS", "https://app.example")
    monkeypatch.setenv("MAX_BODY_BYTES", "2048")
    s = Settings(_env_file=None)  # type: ignore[call-arg]
    assert s.allowed_origins == ["https://app.example"]
    assert s.max_body_bytes == 2048


# ------------------------------------------------------------------ AUTH_MODE=oidc

OIDC = {
    "auth_mode": "oidc",
    "oidc_issuer": "http://localhost:8080/idp/realms/app",
    "oidc_jwks_uri": "http://keycloak:8080/idp/realms/app/protocol/openid-connect/certs",
    "oidc_audience": "app-api",
}


def oidc_settings(**overrides: object) -> Settings:
    return Settings(**{**OIDC, **overrides, "_env_file": None})  # type: ignore[arg-type]


def test_local_is_the_default_so_a_standalone_starter_is_unchanged() -> None:
    s = settings()
    assert s.auth_mode == "local"
    assert s.oidc_issuer is None
    assert (s.oidc_clock_skew_seconds, s.oidc_jwks_cache_seconds) == (30, 600)
    assert (s.oidc_jwks_min_refetch_seconds, s.oidc_jwks_timeout_seconds) == (30, 5)


def test_oidc_mode_needs_no_local_signing_secret() -> None:
    assert oidc_settings().jwt_secret is None
    assert oidc_settings(jwt_secret=SecretStr("short")).auth_mode == "oidc"  # unused, so not judged


@pytest.mark.parametrize("variable", ["OIDC_ISSUER", "OIDC_JWKS_URI", "OIDC_AUDIENCE"])
@pytest.mark.parametrize("blank", [None, "", "   "])
def test_oidc_mode_refuses_to_start_without_each_required_variable_and_names_it(
    variable: str, blank: str | None
) -> None:
    with pytest.raises(ValidationError, match=variable):
        oidc_settings(**{variable.lower(): blank})


def test_every_missing_oidc_variable_is_named_at_once() -> None:
    with pytest.raises(ValidationError) as caught:
        Settings(auth_mode="oidc", _env_file=None)  # type: ignore[call-arg]
    for variable in ("OIDC_ISSUER", "OIDC_JWKS_URI", "OIDC_AUDIENCE"):
        assert variable in str(caught.value)


@pytest.mark.parametrize(
    "uri", ["file:///etc/passwd", "ftp://keycloak/certs", "keycloak:8080/certs", "http://"]
)
def test_the_jwks_uri_must_be_an_http_or_https_url(uri: str) -> None:
    with pytest.raises(ValidationError, match="OIDC_JWKS_URI must be"):
        oidc_settings(oidc_jwks_uri=uri)
    assert oidc_settings(oidc_jwks_uri="https://idp.example/certs")


def test_local_mode_requires_the_secret_and_says_so() -> None:
    with pytest.raises(ValidationError, match="JWT_SECRET is required when AUTH_MODE=local"):
        Settings(auth_mode="local", _env_file=None)  # type: ignore[call-arg]


@pytest.mark.parametrize(
    "overrides",
    [
        {"oidc_clock_skew_seconds": 61},
        {"oidc_clock_skew_seconds": -1},
        {"oidc_jwks_cache_seconds": 1},
        {"oidc_jwks_min_refetch_seconds": 0},
        {"oidc_jwks_timeout_seconds": 0},
        {"auth_mode": "saml"},
    ],
)
def test_oidc_tuning_is_bounded(overrides: dict[str, object]) -> None:
    with pytest.raises(ValidationError):
        oidc_settings(**overrides)


def test_production_with_oidc_still_requires_postgres() -> None:
    with pytest.raises(ValidationError, match="postgresql"):
        oidc_settings(app_env="production")
    assert oidc_settings(app_env="production", database_url=PG).is_production


def test_the_oidc_variables_are_read_from_the_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("JWT_SECRET", raising=False)
    monkeypatch.setenv("AUTH_MODE", "oidc")
    monkeypatch.setenv("OIDC_ISSUER", OIDC["oidc_issuer"])
    monkeypatch.setenv("OIDC_JWKS_URI", OIDC["oidc_jwks_uri"])
    monkeypatch.setenv("OIDC_AUDIENCE", "app-api")
    s = Settings(_env_file=None)
    assert (s.auth_mode, s.oidc_audience, s.oidc_issuer) == (
        "oidc",
        "app-api",
        "http://localhost:8080/idp/realms/app",
    )
