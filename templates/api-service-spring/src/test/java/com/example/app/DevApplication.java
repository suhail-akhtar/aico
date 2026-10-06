package com.example.app;

import com.example.app.identity.app.AuthService;
import com.example.app.items.app.ItemService;
import com.example.app.support.TestDatabase;
import java.security.SecureRandom;
import java.util.HexFormat;
import java.util.List;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.ApplicationRunner;
import org.springframework.boot.SpringApplication;

/**
 * Local development entry point: {@code ./mvnw spring-boot:test-run} (see the Makefile). It lives
 * in the test sources so none of it ships in the production jar.
 *
 * <p>It starts the real application on a throwaway database (PostgreSQL in a container if Docker is
 * running, otherwise H2), generates a signing key if none is configured, and seeds one demo user
 * with a few items so the API has something to show. Nothing here runs in production.
 */
public final class DevApplication {

  private static final Logger LOG = LoggerFactory.getLogger(DevApplication.class);
  static final String DEMO_EMAIL = "demo@example.com";
  // Dev-only demo login, printed at startup. standards-allow: secret
  static final String DEMO_PASSWORD = "demo-password-1234";

  private DevApplication() {}

  public static void main(String[] args) {
    TestDatabase.properties().forEach(System::setProperty);
    boolean oidc = oidcMode();
    // OIDC mode has no signing secret and no sign-up: tokens and accounts come from the provider.
    if (!oidc
        && System.getenv("APP_JWT_SECRET") == null
        && System.getProperty("app.jwt.secret") == null) {
      byte[] key = new byte[32];
      new SecureRandom().nextBytes(key);
      System.setProperty("app.jwt.secret", HexFormat.of().formatHex(key));
    }
    SpringApplication app = new SpringApplication(Application.class);
    app.addInitializers(
        context ->
            context
                .getBeanFactory()
                .registerSingleton(
                    "devSeed",
                    (ApplicationRunner)
                        runnerArgs -> {
                          if (oidc) {
                            LOG.info(
                                "Dev seed ready: nothing seeded in APP_AUTH_MODE=oidc, send a token"
                                    + " from your provider");
                          } else {
                            seed(
                                context.getBean(AuthService.class),
                                context.getBean(ItemService.class));
                          }
                        }));
    app.run(args);
  }

  private static boolean oidcMode() {
    String mode = System.getenv("APP_AUTH_MODE");
    if (mode == null) {
      mode = System.getProperty("app.auth.mode");
    }
    return mode != null && mode.strip().equalsIgnoreCase("oidc");
  }

  private static void seed(AuthService auth, ItemService items) {
    var account = auth.register(DEMO_EMAIL, DEMO_PASSWORD);
    for (String name : List.of("First item", "Second item", "Third item")) {
      items.create(account.id(), name, "Seeded by DevApplication", 5);
    }
    LOG.info("Dev seed ready: log in as {} with the demo password {}", DEMO_EMAIL, DEMO_PASSWORD);
  }
}
