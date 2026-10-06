"""Configuration: environment variables only, validated once at startup.

The process refuses to start on a bad value (a short JWT secret, a placeholder
secret in production, a SQLite URL in production) rather than failing on the
first request, which is how a misconfigured deployment gets noticed in a rollout
instead of by a user. `.env` and `.env.local` are read for local development
only; the same image runs everywhere from real environment variables.

Argon2 cost parameters live here so a test can pin them and an operator can raise
them, but they cannot be lowered below the OWASP minimum outside APP_ENV=test.

AUTH_MODE picks who vouches for the caller. `local` (the default) is this service's own
accounts and tokens. `oidc` makes it a resource server behind an identity provider: it
then needs OIDC_ISSUER, OIDC_JWKS_URI and OIDC_AUDIENCE and refuses to start without
them, and JWT_SECRET is no longer needed because nothing is signed locally.
"""

from typing import Annotated, Literal, Self
from urllib.parse import urlsplit

from limits import parse
from pydantic import Field, SecretStr, field_validator, model_validator
from pydantic_settings import BaseSettings, NoDecode, SettingsConfigDict

Environment = Literal["development", "test", "production"]
AuthMode = Literal["local", "oidc"]

PLACEHOLDER_PREFIX = "change-me"
# OWASP Password Storage Cheat Sheet: Argon2id minimum m=19 MiB, t=2, p=1.
OWASP_MIN_MEMORY_KIB = 19_456
OWASP_MIN_TIME_COST = 2
DEV_DATABASE_URL = "sqlite+aiosqlite:///./data/app.db"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=(".env", ".env.local"),
        env_file_encoding="utf-8",
        extra="ignore",
        frozen=True,
    )

    app_env: Environment = "development"
    service_name: str = "api-service"

    # Database. SQLite is for development and tests only; production is PostgreSQL.
    database_url: str | None = None
    db_pool_size: int = Field(default=10, ge=1, le=200)
    db_max_overflow: int = Field(default=10, ge=0, le=200)
    auto_migrate: bool = False

    # Authentication. `local`: this service issues and verifies its own tokens (HS256).
    # `oidc`: an identity provider issues them (RS256) and this service only verifies.
    auth_mode: AuthMode = "local"
    jwt_secret: SecretStr | None = None  # required when auth_mode=local
    jwt_issuer: str = "api-service"
    jwt_audience: str = "api-service-clients"
    access_token_ttl_seconds: int = Field(default=900, ge=60, le=3600)
    refresh_token_ttl_days: int = Field(default=14, ge=1, le=90)
    registration_enabled: bool = True
    argon2_time_cost: int = Field(default=3, ge=1, le=10)
    argon2_memory_cost_kib: int = Field(default=65_536, ge=8, le=1_048_576)
    argon2_parallelism: int = Field(default=2, ge=1, le=16)

    # OIDC resource-server mode (auth_mode=oidc). The first three are required there.
    oidc_issuer: str | None = None  # the exact `iss` the provider puts in its tokens
    oidc_jwks_uri: str | None = None  # where the signing keys are; often an internal URL
    oidc_audience: str | None = None  # the `aud` value this API requires
    oidc_clock_skew_seconds: int = Field(default=30, ge=0, le=60)
    oidc_jwks_cache_seconds: int = Field(default=600, ge=30, le=86_400)
    # Floor between two fetches of the key set, so unknown `kid`s cannot hammer the provider.
    oidc_jwks_min_refetch_seconds: int = Field(default=30, ge=1, le=3_600)
    oidc_jwks_timeout_seconds: int = Field(default=5, ge=1, le=30)

    # HTTP edge.
    allowed_origins: Annotated[list[str], NoDecode] = Field(default_factory=list)
    max_body_bytes: int = Field(default=1_048_576, ge=1_024, le=100 * 1_048_576)
    rate_limit_enabled: bool = True
    rate_limit_default: str = "120/minute"
    rate_limit_auth: str = "10/minute"
    docs_enabled: bool = True

    # Logging.
    log_level: Literal["DEBUG", "INFO", "WARNING", "ERROR"] = "INFO"
    log_format: Literal["json", "console"] = "json"

    # Development seed only.
    seed_password: SecretStr | None = None

    @field_validator("allowed_origins", mode="before")
    @classmethod
    def _split_origins(cls, value: object) -> object:
        if isinstance(value, str):
            return [part.strip() for part in value.split(",") if part.strip()]
        return value

    @field_validator("allowed_origins")
    @classmethod
    def _no_wildcard_origin(cls, value: list[str]) -> list[str]:
        if "*" in value:
            msg = "ALLOWED_ORIGINS must list explicit origins; '*' is not accepted"
            raise ValueError(msg)
        return value

    @field_validator("rate_limit_default", "rate_limit_auth")
    @classmethod
    def _valid_rate(cls, value: str) -> str:
        parse(value)  # raises ValueError on e.g. "lots"
        return value

    @field_validator("database_url")
    @classmethod
    def _normalise_database_url(cls, value: str | None) -> str | None:
        if value is None:
            return None
        # Platforms hand out postgres:// or postgresql://; the async driver needs the suffix.
        for prefix in ("postgres://", "postgresql://"):
            if value.startswith(prefix):
                return "postgresql+psycopg://" + value[len(prefix) :]
        return value

    @model_validator(mode="after")
    def _check_auth(self) -> Self:
        if self.auth_mode == "oidc":
            required = {
                "OIDC_ISSUER": self.oidc_issuer,
                "OIDC_JWKS_URI": self.oidc_jwks_uri,
                "OIDC_AUDIENCE": self.oidc_audience,
            }
            missing = [name for name, value in required.items() if not (value or "").strip()]
            if missing:
                msg = f"AUTH_MODE=oidc requires {', '.join(missing)}"
                raise ValueError(msg)
            jwks = urlsplit(self.oidc_jwks_uri or "")
            if jwks.scheme not in {"http", "https"} or not jwks.hostname:
                msg = "OIDC_JWKS_URI must be an http:// or https:// URL"
                raise ValueError(msg)
            return self
        if self.jwt_secret is None:
            msg = "JWT_SECRET is required when AUTH_MODE=local (try: openssl rand -hex 32)"
            raise ValueError(msg)
        secret = self.jwt_secret.get_secret_value()
        if len(secret) < 32:
            msg = "JWT_SECRET must be at least 32 characters (try: openssl rand -hex 32)"
            raise ValueError(msg)
        if self.app_env == "production" and secret.startswith(PLACEHOLDER_PREFIX):
            msg = "JWT_SECRET is still the placeholder from .env.example"
            raise ValueError(msg)
        return self

    @model_validator(mode="after")
    def _check_environment(self) -> Self:
        if self.app_env == "production" and (
            not self.database_url or not self.database_url.startswith("postgresql+psycopg://")
        ):
            msg = "DATABASE_URL must be a postgresql+psycopg:// URL in production"
            raise ValueError(msg)
        if self.app_env != "test" and (
            self.argon2_memory_cost_kib < OWASP_MIN_MEMORY_KIB
            or self.argon2_time_cost < OWASP_MIN_TIME_COST
        ):
            msg = "Argon2 parameters are below the OWASP minimum (m>=19456 KiB, t>=2)"
            raise ValueError(msg)
        return self

    @property
    def effective_database_url(self) -> str:
        """The URL to connect to; development falls back to a local SQLite file."""
        return self.database_url or DEV_DATABASE_URL

    @property
    def is_production(self) -> bool:
        return self.app_env == "production"


def load_settings() -> Settings:
    """Read and validate the environment. The one place the required fields are
    supplied implicitly (from the environment, not from arguments)."""
    return Settings()
