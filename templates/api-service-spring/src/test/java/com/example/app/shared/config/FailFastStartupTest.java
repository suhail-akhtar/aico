package com.example.app.shared.config;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.catchThrowable;

import com.example.app.Application;
import org.junit.jupiter.api.Test;
import org.springframework.boot.WebApplicationType;
import org.springframework.boot.builder.SpringApplicationBuilder;

/**
 * Boots the real application with incomplete settings and checks that it refuses to start, naming
 * the variable. The unit tests cover the rules; this proves the check is actually wired in front of
 * everything else (no database is reachable here, so a start that got past it would fail
 * differently).
 */
class FailFastStartupTest {

  /**
   * Command-line arguments, not builder properties: the builder's are defaults, which {@code
   * application.properties} (mapping {@code ${DATABASE_URL}}) would outrank.
   */
  private static Throwable startWith(String... settings) {
    String[] args = new String[settings.length + 3];
    args[0] = "--spring.datasource.url=jdbc:postgresql://127.0.0.1:1/none";
    args[1] = "--spring.datasource.username=nobody";
    args[2] = "--spring.main.banner-mode=off";
    for (int i = 0; i < settings.length; i++) {
      args[i + 3] = "--" + settings[i];
    }
    return catchThrowable(
        () ->
            new SpringApplicationBuilder(Application.class).web(WebApplicationType.NONE).run(args));
  }

  private static Throwable rootOf(Throwable t) {
    Throwable root = t;
    while (root.getCause() != null) {
      root = root.getCause();
    }
    return root;
  }

  @Test
  void oidcModeWithoutTheOidcVariablesDoesNotStart() {
    Throwable failure = startWith("app.auth.mode=oidc");

    assertThat(failure).isNotNull();
    assertThat(rootOf(failure)).isInstanceOf(InvalidConfigurationException.class);
    assertThat(rootOf(failure).getMessage())
        .contains("OIDC_ISSUER is not set", "OIDC_JWKS_URI is not set", "OIDC_AUDIENCE is not set")
        .doesNotContain("APP_JWT_SECRET");
  }

  @Test
  void localModeWithoutTheSecretStillDoesNotStart() {
    Throwable failure = startWith();

    assertThat(rootOf(failure)).isInstanceOf(InvalidConfigurationException.class);
    assertThat(rootOf(failure).getMessage()).contains("APP_JWT_SECRET is not set");
  }

  @Test
  void anUnknownModeDoesNotStart() {
    Throwable failure = startWith("app.auth.mode=ldap");

    assertThat(rootOf(failure)).isInstanceOf(InvalidConfigurationException.class);
    assertThat(rootOf(failure).getMessage()).contains("APP_AUTH_MODE must be local or oidc");
  }
}
