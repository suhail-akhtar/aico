package com.example.app.support;

import java.util.Map;
import java.util.UUID;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.testcontainers.DockerClientFactory;
import org.testcontainers.postgresql.PostgreSQLContainer;

/**
 * Chooses the database every integration test (and the dev runner) uses.
 *
 * <p>Default is a real PostgreSQL in a Testcontainers container, the same engine production runs,
 * so migrations, constraints and queries are proven on it. When Docker is not available the tests
 * fall back to H2 in PostgreSQL mode so the suite still runs (a weaker proof: H2 is not
 * PostgreSQL). Force a choice with {@code AICO_TEST_DB=postgres|h2}; {@code postgres} fails loudly
 * instead of silently falling back, which is what CI sets.
 */
public final class TestDatabase {

  /** Keep in step with compose.yaml. */
  static final String POSTGRES_IMAGE = "postgres:18-alpine";

  private static final Object LOCK = new Object();
  private static PostgreSQLContainer container;

  private TestDatabase() {}

  /** True when tests run against real PostgreSQL. */
  public static boolean usesPostgres() {
    String choice = System.getenv().getOrDefault("AICO_TEST_DB", "auto").toLowerCase();
    return switch (choice) {
      case "h2" -> false;
      case "postgres" -> {
        if (!DockerClientFactory.instance().isDockerAvailable()) {
          throw new IllegalStateException(
              "AICO_TEST_DB=postgres but Docker is not available. Start Docker or use h2.");
        }
        yield true;
      }
      default -> DockerClientFactory.instance().isDockerAvailable();
    };
  }

  /** Spring datasource properties for the chosen engine, starting the container if needed. */
  public static Map<String, String> properties() {
    if (usesPostgres()) {
      PostgreSQLContainer postgres = postgres();
      return Map.of(
          "spring.datasource.url", postgres.getJdbcUrl(),
          "spring.datasource.username", postgres.getUsername(),
          "spring.datasource.password", postgres.getPassword());
    }
    return Map.of(
        "spring.datasource.url",
        "jdbc:h2:mem:app-"
            + UUID.randomUUID()
            + ";MODE=PostgreSQL;DATABASE_TO_LOWER=TRUE;DEFAULT_NULL_ORDERING=HIGH;DB_CLOSE_DELAY=-1",
        "spring.datasource.username",
        "sa",
        "spring.datasource.password",
        "");
  }

  public static void register(DynamicPropertyRegistry registry) {
    Map<String, String> props = properties();
    props.forEach((key, value) -> registry.add(key, () -> value));
  }

  private static PostgreSQLContainer postgres() {
    synchronized (LOCK) {
      if (container == null) {
        // One container per JVM, stopped by Testcontainers' reaper when the JVM exits.
        container = new PostgreSQLContainer(POSTGRES_IMAGE);
        container.start();
      }
      return container;
    }
  }
}
