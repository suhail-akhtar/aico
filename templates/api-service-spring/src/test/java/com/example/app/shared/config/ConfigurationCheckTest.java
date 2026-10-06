package com.example.app.shared.config;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.util.List;
import org.junit.jupiter.api.Test;
import org.springframework.boot.diagnostics.FailureAnalysis;
import org.springframework.core.env.StandardEnvironment;
import org.springframework.mock.env.MockEnvironment;

/**
 * The friendly startup failure. The stock one for a missing URL is "'url' must start with jdbc",
 * and Spring Boot's report for a bad secret would print the secret.
 */
class ConfigurationCheckTest {

  private static final String GOOD_SECRET = "0123456789abcdef0123456789abcdef";

  private static MockEnvironment complete() {
    return new MockEnvironment()
        .withProperty("spring.datasource.url", "jdbc:postgresql://db/app")
        .withProperty("spring.datasource.username", "app")
        .withProperty("app.jwt.secret", GOOD_SECRET);
  }

  @Test
  void everyMissingSettingIsNamedByItsEnvironmentVariable() {
    assertThat(ConfigurationCheck.problems(new MockEnvironment()))
        .containsExactly(
            "DATABASE_URL is not set", "DATABASE_USER is not set", "APP_JWT_SECRET is not set");
  }

  @Test
  void anUnresolvedPlaceholderCountsAsMissing() {
    var env = complete().withProperty("spring.datasource.url", "${DATABASE_URL}");

    assertThat(ConfigurationCheck.problems(env)).containsExactly("DATABASE_URL is not set");
  }

  @Test
  void aBlankValueCountsAsMissing() {
    var env = complete().withProperty("spring.datasource.username", "  ");

    assertThat(ConfigurationCheck.problems(env)).containsExactly("DATABASE_USER is not set");
  }

  private static MockEnvironment completeOidc() {
    return new MockEnvironment()
        .withProperty("spring.datasource.url", "jdbc:postgresql://db/app")
        .withProperty("spring.datasource.username", "app")
        .withProperty("app.auth.mode", "oidc")
        .withProperty("app.auth.oidc.issuer", "http://localhost:8080/idp/realms/app")
        .withProperty("app.auth.oidc.jwks-uri", "http://keycloak:8080/certs")
        .withProperty("app.auth.oidc.audience", "app-api");
  }

  @Test
  void oidcModeNamesEachMissingOidcVariableAndDoesNotAskForTheSecret() {
    var env =
        new MockEnvironment()
            .withProperty("spring.datasource.url", "jdbc:postgresql://db/app")
            .withProperty("spring.datasource.username", "app")
            .withProperty("app.auth.mode", "oidc");

    assertThat(ConfigurationCheck.problems(env))
        .containsExactly(
            "OIDC_ISSUER is not set", "OIDC_JWKS_URI is not set", "OIDC_AUDIENCE is not set");
  }

  @Test
  void oidcModeNeedsNoSigningSecret() {
    assertThat(ConfigurationCheck.problems(completeOidc())).isEmpty();
    assertThat(ConfigurationCheck.problems(completeOidc().withProperty("app.auth.mode", "OIDC")))
        .isEmpty();
  }

  @Test
  void blankOidcValuesCountAsMissing() {
    var env = completeOidc().withProperty("app.auth.oidc.issuer", "  ");

    assertThat(ConfigurationCheck.problems(env)).containsExactly("OIDC_ISSUER is not set");
  }

  @Test
  void anUnknownModeIsRejectedByName() {
    var env = complete().withProperty("app.auth.mode", "ldap");

    assertThat(ConfigurationCheck.problems(env)).contains("APP_AUTH_MODE must be local or oidc");
  }

  @Test
  void localModeDoesNotAskForOidcVariables() {
    assertThat(ConfigurationCheck.problems(complete().withProperty("app.auth.mode", "local")))
        .isEmpty();
  }

  @Test
  void aBadJwksUriIsReportedByVariable() {
    var env = completeOidc().withProperty("app.auth.oidc.jwks-uri", "keycloak:8080/certs");

    assertThat(ConfigurationCheck.problems(env))
        .contains("OIDC_JWKS_URI must be an absolute http or https URL");
  }

  @Test
  void aCompleteEnvironmentPasses() {
    assertThat(ConfigurationCheck.problems(complete())).isEmpty();
  }

  @Test
  void aWeakSecretIsRejectedWithoutPrintingIt() {
    var env = complete().withProperty("app.jwt.secret", "hunter2-too-short");

    List<String> problems = ConfigurationCheck.problems(env);

    assertThat(problems).isNotEmpty().anyMatch(p -> p.contains("APP_JWT_SECRET"));
    assertThat(String.join(" ", problems)).doesNotContain("hunter2");
  }

  @Test
  void thePlaceholderSecretIsRejected() {
    var env = complete().withProperty("app.jwt.secret", "change-me-" + GOOD_SECRET);

    assertThat(ConfigurationCheck.problems(env)).anyMatch(p -> p.contains("placeholder"));
  }

  @Test
  void aBadValueOfTheWrongKindIsReportedByNameNotValue() {
    var env = complete().withProperty("app.jwt.ttl", "not-a-duration-secret-text");

    List<String> problems = ConfigurationCheck.problems(env);

    assertThat(problems).anyMatch(p -> p.contains("app.jwt.ttl"));
    assertThat(String.join(" ", problems)).doesNotContain("not-a-duration-secret-text");
  }

  @Test
  void anOutOfRangeSettingIsReported() {
    var env = complete().withProperty("app.security.bcrypt-cost", "4");

    assertThat(ConfigurationCheck.problems(env)).anyMatch(p -> p.contains("bcryptCost"));
  }

  @Test
  void theCheckBeanFailsStartupWithTheProblems() {
    var check = ConfigurationCheck.startupCheck();
    check.setEnvironment(new StandardEnvironment());

    assertThatThrownBy(() -> check.postProcessBeanFactory(null))
        .isInstanceOf(InvalidConfigurationException.class)
        .hasMessageContaining("DATABASE_URL");
    assertThat(check.getOrder()).isEqualTo(org.springframework.core.Ordered.HIGHEST_PRECEDENCE);
  }

  @Test
  void theAnalyzerListsEachProblemAndPointsAtTheFix() {
    var failure = new InvalidConfigurationException(List.of("DATABASE_URL is not set"));

    FailureAnalysis analysis = new InvalidConfigurationAnalyzer().analyze(failure);

    assertThat(analysis).isNotNull();
    assertThat(analysis.getDescription()).contains("  - DATABASE_URL is not set");
    assertThat(analysis.getAction()).contains(".env.local");
  }
}
