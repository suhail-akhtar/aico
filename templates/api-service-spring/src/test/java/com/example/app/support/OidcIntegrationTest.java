package com.example.app.support;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.BeforeEach;
import org.springframework.http.HttpStatus;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

/**
 * Base for tests that boot the whole application in {@code APP_AUTH_MODE=oidc} against the
 * in-process {@link FakeIdentityProvider}. All subclasses share one provider and one application
 * context (same properties), so the extra startup is paid once. No signing secret is configured on
 * purpose: oidc mode must run without one.
 */
public abstract class OidcIntegrationTest extends IntegrationTest {

  protected static final FakeIdentityProvider IDP = FakeIdentityProvider.start();

  static {
    // The provider's dispatcher thread would otherwise keep a forked test JVM alive.
    Runtime.getRuntime().addShutdownHook(new Thread(IDP::close));
  }

  /**
   * Loads the provider's keys into the service's cache before each test. The service refetches keys
   * at most once per rate-limit window, so a test that makes the provider fail must not leave the
   * next test as the one that has to fetch them.
   */
  @BeforeEach
  void warmTheKeyCache() {
    assertThat(get("/api/v1/auth/me", IDP.token().build())).hasStatus(HttpStatus.OK);
  }

  @DynamicPropertySource
  static void oidcProperties(DynamicPropertyRegistry registry) {
    registry.add("app.auth.mode", () -> "oidc");
    registry.add("app.auth.oidc.issuer", () -> FakeIdentityProvider.ISSUER);
    registry.add("app.auth.oidc.jwks-uri", IDP::jwksUri);
    registry.add("app.auth.oidc.audience", () -> FakeIdentityProvider.AUDIENCE);
    // Short, so the rotation and outage tests do not wait half a minute for the refetch window.
    registry.add("app.auth.oidc.jwks-min-refresh", () -> "1s");
    registry.add("app.jwt.secret", () -> "");
  }
}
