package com.example.app.shared.config;

import jakarta.validation.Valid;
import jakarta.validation.constraints.AssertTrue;
import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotBlank;
import java.net.URI;
import java.time.Duration;
import java.util.List;
import java.util.Locale;
import org.jspecify.annotations.Nullable;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.boot.context.properties.bind.DefaultValue;
import org.springframework.util.unit.DataSize;
import org.springframework.validation.annotation.Validated;

/**
 * Every setting the application reads, bound from environment variables (see {@code
 * application.properties}) and validated at startup, so a missing or weak value stops the process
 * with a message that names the setting instead of failing on the first request.
 *
 * <p>Which settings are required depends on {@code APP_AUTH_MODE}: {@code local} (the default)
 * needs the signing secret and no OIDC settings, {@code oidc} needs the three OIDC settings and no
 * secret, because in that mode nothing here ever signs a token.
 */
@Validated
@ConfigurationProperties(prefix = "app")
public record AppProperties(
    @Valid @DefaultValue Auth auth,
    @Valid @DefaultValue Jwt jwt,
    @Valid @DefaultValue Security security,
    @Valid @DefaultValue Cors cors,
    @Valid @DefaultValue RateLimit rateLimit,
    @Valid @DefaultValue Http http) {

  private static boolean blank(@Nullable String value) {
    return value == null || value.isBlank();
  }

  /** Local mode only: the secret must be present, long enough and not the example value. */
  @AssertTrue(message = "APP_JWT_SECRET is required when APP_AUTH_MODE=local")
  public boolean isJwtSecretPresent() {
    return auth.mode() == Auth.Mode.OIDC || !blank(jwt.secret());
  }

  @AssertTrue(message = "APP_JWT_SECRET must be at least 32 characters")
  public boolean isJwtSecretLongEnough() {
    String secret = jwt.secret();
    return auth.mode() == Auth.Mode.OIDC
        || secret == null
        || secret.isBlank()
        || secret.length() >= Jwt.SECRET_MIN;
  }

  @AssertTrue(message = "APP_JWT_SECRET still holds the .env.example placeholder")
  public boolean isJwtSecretNotPlaceholder() {
    String secret = jwt.secret();
    return secret == null || !secret.startsWith("change-me");
  }

  /**
   * How callers are authenticated. {@code local}: this service registers users, logs them in and
   * signs HS256 tokens. {@code oidc}: it only verifies RS256 access tokens issued by an external
   * provider (behind a gateway or BFF) and creates the account on first sight of a subject.
   */
  public record Auth(@DefaultValue("local") Mode mode, @Valid @DefaultValue Oidc oidc) {

    /** The two ways to run. Anything else fails startup. */
    public enum Mode {
      LOCAL,
      OIDC
    }

    public boolean oidcEnabled() {
      return mode == Mode.OIDC;
    }

    @AssertTrue(message = "OIDC_ISSUER is required when APP_AUTH_MODE=oidc")
    public boolean isOidcIssuerSet() {
      return mode != Mode.OIDC || !blank(oidc.issuer());
    }

    @AssertTrue(message = "OIDC_AUDIENCE is required when APP_AUTH_MODE=oidc")
    public boolean isOidcAudienceSet() {
      return mode != Mode.OIDC || !blank(oidc.audience());
    }

    @AssertTrue(message = "OIDC_JWKS_URI must be an absolute http or https URL")
    public boolean isOidcJwksUriUsable() {
      if (mode != Mode.OIDC) {
        return true;
      }
      String uri = oidc.jwksUri();
      if (blank(uri)) {
        return false;
      }
      try {
        URI parsed = URI.create(uri);
        String scheme =
            parsed.getScheme() == null ? "" : parsed.getScheme().toLowerCase(Locale.ROOT);
        return (scheme.equals("http") || scheme.equals("https")) && parsed.getHost() != null;
      } catch (IllegalArgumentException malformed) {
        return false;
      }
    }
  }

  /**
   * Settings for verifying tokens from an external OIDC provider (Keycloak, Entra, Auth0, ...). The
   * issuer is the exact {@code iss} the tokens carry (usually the provider's public URL); the JWKS
   * URI is where the signing keys are fetched and is deliberately separate, because inside a
   * container network the provider is reached at a different address than the browser sees.
   */
  public record Oidc(
      @Nullable String issuer,
      @Nullable String jwksUri,
      @Nullable String audience,
      @DefaultValue("30s") Duration clockSkew,
      @DefaultValue("30s") Duration jwksMinRefresh) {

    @AssertTrue(message = "OIDC_CLOCK_SKEW must be between 0 and 60 seconds")
    public boolean isClockSkewSane() {
      return clockSkew.compareTo(Duration.ZERO) >= 0
          && clockSkew.compareTo(Duration.ofSeconds(60)) <= 0;
    }

    @AssertTrue(message = "OIDC_JWKS_MIN_REFRESH must be between 1 second and 1 hour")
    public boolean isJwksMinRefreshSane() {
      return jwksMinRefresh.compareTo(Duration.ofSeconds(1)) >= 0
          && jwksMinRefresh.compareTo(Duration.ofHours(1)) <= 0;
    }
  }

  /**
   * Local token signing and validation. The same key signs (local issuer) and verifies. The secret
   * is nullable only because {@code oidc} mode has none; {@link AppProperties} enforces it in local
   * mode.
   */
  public record Jwt(
      @Nullable String secret,
      @NotBlank @DefaultValue("api-service") String issuer,
      @NotBlank @DefaultValue("api-service") String audience,
      @DefaultValue("15m") Duration ttl) {

    public static final int SECRET_MIN = 32;

    @AssertTrue(message = "APP_JWT_TTL must be between 1 minute and 24 hours")
    public boolean isTtlSane() {
      return ttl.compareTo(Duration.ofMinutes(1)) >= 0 && ttl.compareTo(Duration.ofHours(24)) <= 0;
    }
  }

  /** Password hashing work factor. OWASP's floor for bcrypt is 10. */
  public record Security(@Min(10) @Max(16) @DefaultValue("12") int bcryptCost) {}

  /** Browser origins allowed to call the API. Empty means no cross-origin access. */
  public record Cors(@DefaultValue List<String> allowedOrigins) {}

  /** Token buckets per client address: general traffic and the stricter auth endpoints. */
  public record RateLimit(
      @Min(1) @DefaultValue("120") int capacity,
      @Min(1) @DefaultValue("120") int refillPerMinute,
      @Min(1) @DefaultValue("10") int authCapacity,
      @Min(1) @DefaultValue("10") int authRefillPerMinute) {}

  /** Request size ceiling, enforced before the body is parsed. */
  public record Http(@DefaultValue("256KB") DataSize maxBodySize) {}
}
