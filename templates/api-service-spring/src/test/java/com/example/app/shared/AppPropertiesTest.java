package com.example.app.shared;

import static org.assertj.core.api.Assertions.assertThat;

import com.example.app.shared.config.AppProperties;
import jakarta.validation.ConstraintViolation;
import jakarta.validation.Validation;
import jakarta.validation.Validator;
import java.time.Duration;
import java.util.List;
import java.util.Set;
import org.junit.jupiter.api.Test;
import org.springframework.util.unit.DataSize;

/** Startup validation: weak or missing settings must be caught before the first request. */
class AppPropertiesTest {

  private static final Validator VALIDATOR =
      Validation.buildDefaultValidatorFactory().getValidator();
  private static final String GOOD_SECRET = "0123456789abcdef0123456789abcdef";

  private static AppProperties with(String secret, Duration ttl, int bcryptCost) {
    return new AppProperties(
        new AppProperties.Auth(AppProperties.Auth.Mode.LOCAL, oidc(null, null, null)),
        new AppProperties.Jwt(secret, "iss", "aud", ttl),
        new AppProperties.Security(bcryptCost),
        new AppProperties.Cors(List.of()),
        new AppProperties.RateLimit(1, 1, 1, 1),
        new AppProperties.Http(DataSize.ofKilobytes(1)));
  }

  private static AppProperties.Oidc oidc(String issuer, String jwksUri, String audience) {
    return new AppProperties.Oidc(
        issuer, jwksUri, audience, Duration.ofSeconds(30), Duration.ofSeconds(30));
  }

  private static AppProperties oidcMode(AppProperties.Oidc oidc) {
    return new AppProperties(
        new AppProperties.Auth(AppProperties.Auth.Mode.OIDC, oidc),
        new AppProperties.Jwt(null, "iss", "aud", Duration.ofMinutes(15)),
        new AppProperties.Security(12),
        new AppProperties.Cors(List.of()),
        new AppProperties.RateLimit(1, 1, 1, 1),
        new AppProperties.Http(DataSize.ofKilobytes(1)));
  }

  private static Set<String> messages(AppProperties props) {
    return VALIDATOR.validate(props).stream()
        .map(ConstraintViolation::getMessage)
        .collect(java.util.stream.Collectors.toSet());
  }

  @Test
  void aSoundConfigurationHasNoViolations() {
    assertThat(VALIDATOR.validate(with(GOOD_SECRET, Duration.ofMinutes(15), 12))).isEmpty();
  }

  @Test
  void aShortSecretIsRejectedByName() {
    assertThat(messages(with("short", Duration.ofMinutes(15), 12)))
        .anyMatch(m -> m.contains("APP_JWT_SECRET must be at least 32"));
  }

  @Test
  void theExamplePlaceholderIsRejected() {
    assertThat(messages(with("change-me-" + GOOD_SECRET, Duration.ofMinutes(15), 12)))
        .anyMatch(m -> m.contains("placeholder"));
  }

  @Test
  void aTokenLifetimeOutsideOneMinuteToOneDayIsRejected() {
    assertThat(messages(with(GOOD_SECRET, Duration.ofSeconds(5), 12)))
        .anyMatch(m -> m.contains("APP_JWT_TTL"));
    assertThat(messages(with(GOOD_SECRET, Duration.ofDays(30), 12)))
        .anyMatch(m -> m.contains("APP_JWT_TTL"));
  }

  @Test
  void aBcryptCostBelowTheOwaspFloorIsRejected() {
    assertThat(VALIDATOR.validate(with(GOOD_SECRET, Duration.ofMinutes(15), 9))).isNotEmpty();
    assertThat(VALIDATOR.validate(with(GOOD_SECRET, Duration.ofMinutes(15), 10))).isEmpty();
  }

  @Test
  void localModeNeedsTheSecretAndNoOidcSettings() {
    assertThat(messages(with(null, Duration.ofMinutes(15), 12)))
        .containsExactly("APP_JWT_SECRET is required when APP_AUTH_MODE=local");
    assertThat(messages(with("   ", Duration.ofMinutes(15), 12)))
        .contains("APP_JWT_SECRET is required when APP_AUTH_MODE=local");
  }

  @Test
  void oidcModeNeedsTheThreeSettingsAndNoSecret() {
    var complete = oidc("https://idp.example/realms/app", "http://idp/certs", "app-api");

    assertThat(VALIDATOR.validate(oidcMode(complete))).isEmpty();
    assertThat(messages(oidcMode(oidc(null, null, null))))
        .contains(
            "OIDC_ISSUER is required when APP_AUTH_MODE=oidc",
            "OIDC_AUDIENCE is required when APP_AUTH_MODE=oidc",
            "OIDC_JWKS_URI must be an absolute http or https URL");
  }

  @Test
  void theJwksUriMustBeAnAbsoluteHttpOrHttpsUrl() {
    for (String bad :
        List.of(
            "keycloak:8080/certs",
            "ftp://idp/certs",
            "file:///etc/passwd",
            "http://",
            "not a url")) {
      assertThat(messages(oidcMode(oidc("iss", bad, "aud"))))
          .as(bad)
          .contains("OIDC_JWKS_URI must be an absolute http or https URL");
    }
    assertThat(messages(oidcMode(oidc("iss", "HTTPS://idp.example/certs", "aud")))).isEmpty();
  }

  @Test
  void clockSkewAboveSixtySecondsAndTinyRefreshIntervalsAreRejected() {
    var skewy =
        new AppProperties.Oidc(
            "iss", "http://idp/certs", "aud", Duration.ofSeconds(61), Duration.ofSeconds(30));
    var hammering =
        new AppProperties.Oidc(
            "iss", "http://idp/certs", "aud", Duration.ofSeconds(30), Duration.ZERO);

    assertThat(messages(oidcMode(skewy)))
        .contains("OIDC_CLOCK_SKEW must be between 0 and 60 seconds");
    assertThat(messages(oidcMode(hammering)))
        .contains("OIDC_JWKS_MIN_REFRESH must be between 1 second and 1 hour");
  }

  @Test
  void theModeReportsWhetherOidcIsOn() {
    assertThat(with(GOOD_SECRET, Duration.ofMinutes(15), 12).auth().oidcEnabled()).isFalse();
    assertThat(oidcMode(oidc("i", "http://x/c", "a")).auth().oidcEnabled()).isTrue();
  }
}
