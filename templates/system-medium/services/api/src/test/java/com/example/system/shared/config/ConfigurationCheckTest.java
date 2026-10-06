package com.example.system.shared.config;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.util.List;
import org.junit.jupiter.api.Test;
import org.springframework.boot.diagnostics.FailureAnalysis;
import org.springframework.core.env.StandardEnvironment;
import org.springframework.mock.env.MockEnvironment;

/**
 * The friendly startup failure. The stock one for a missing URL is "'url' must start with jdbc",
 * and Spring Boot's report for a bad value would print the value.
 */
class ConfigurationCheckTest {

  private static MockEnvironment complete() {
    return new MockEnvironment()
        .withProperty("spring.datasource.url", "jdbc:postgresql://db/app")
        .withProperty("spring.datasource.username", "app")
        .withProperty("spring.datasource.password", "x")
        .withProperty(
            "spring.security.oauth2.client.provider.keycloak.issuer-uri", "http://idp/realms/app")
        .withProperty("spring.security.oauth2.client.registration.keycloak.client-secret", "s")
        .withProperty("spring.data.redis.host", "valkey")
        .withProperty("app.storage.provider", "memory");
  }

  @Test
  void everyMissingSettingIsNamedByItsEnvironmentVariable() {
    assertThat(ConfigurationCheck.problems(new MockEnvironment()))
        .containsExactly(
            "DATABASE_URL is not set",
            "DATABASE_USER is not set",
            "DATABASE_PASSWORD is not set",
            "OIDC_ISSUER_URI is not set",
            "OIDC_CLIENT_SECRET is not set",
            "VALKEY_HOST is not set");
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

  @Test
  void aCompleteEnvironmentPasses() {
    assertThat(ConfigurationCheck.problems(complete())).isEmpty();
  }

  @Test
  void anIncompleteS3SettingIsReportedByRuleNotByValue() {
    var env =
        complete()
            .withProperty("app.storage.provider", "s3")
            .withProperty("app.storage.endpoint", "http://s3:8333")
            .withProperty("app.storage.access-key", "AKIA-fake-access-key");

    List<String> problems = ConfigurationCheck.problems(env);

    assertThat(problems).anyMatch(p -> p.contains("S3_SECRET_KEY"));
    assertThat(String.join(" ", problems)).doesNotContain("AKIA-fake-access-key");
  }

  @Test
  void aBadValueOfTheWrongKindIsReportedByNameNotValue() {
    var env = complete().withProperty("app.jobs.republish-after", "not-a-duration-secret-text");

    List<String> problems = ConfigurationCheck.problems(env);

    assertThat(problems).anyMatch(p -> p.contains("app.jobs.republish-after"));
    assertThat(String.join(" ", problems)).doesNotContain("not-a-duration-secret-text");
  }

  @Test
  void anOutOfRangeSettingIsReported() {
    var env = complete().withProperty("app.rate-limit.api-per-minute", "0");

    assertThat(ConfigurationCheck.problems(env)).anyMatch(p -> p.contains("apiPerMinute"));
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
    assertThat(analysis.getAction()).contains(".env");
  }
}
