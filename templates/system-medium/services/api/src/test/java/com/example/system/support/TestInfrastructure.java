package com.example.system.support;

import java.util.Map;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.testcontainers.DockerClientFactory;
import org.testcontainers.containers.GenericContainer;
import org.testcontainers.postgresql.PostgreSQLContainer;
import org.testcontainers.utility.DockerImageName;

/**
 * The real PostgreSQL and Valkey every integration test (and the dev runner) uses.
 *
 * <p>Default: one throwaway container of each, per JVM, from the same images compose runs, so
 * migrations, constraints, triggers, advisory locks and the rate limiter script are proven on the
 * engines production uses. There is no H2 fallback on purpose: row-level behaviour, {@code jsonb},
 * triggers and {@code ON CONFLICT} are exactly what these tests exist to check.
 *
 * <p>Where containers cannot be started from the test process (a CI job that already provides
 * services, a build inside a container without a Docker socket), set {@code TEST_DATABASE_URL},
 * {@code TEST_DATABASE_USER}, {@code TEST_DATABASE_PASSWORD} and {@code TEST_VALKEY_HOST} (and
 * optionally {@code TEST_VALKEY_PORT}); those win. Tests only ever create their own uniquely named
 * users and rows, so a shared database is safe.
 */
public final class TestInfrastructure {

  /** Keep in step with compose.yaml. */
  static final String POSTGRES_IMAGE = "postgres:18.6-alpine";

  static final String VALKEY_IMAGE = "valkey/valkey:9.1.2-alpine";

  private static final Object LOCK = new Object();
  private static PostgreSQLContainer postgres;
  private static GenericContainer<?> valkey;

  private TestInfrastructure() {}

  public static void register(DynamicPropertyRegistry registry) {
    Map<String, String> props = properties();
    props.forEach((key, value) -> registry.add(key, () -> value));
  }

  /** Spring properties pointing the application at the test PostgreSQL and Valkey. */
  public static Map<String, String> properties() {
    String url = System.getenv("TEST_DATABASE_URL");
    String valkeyHost = System.getenv("TEST_VALKEY_HOST");
    Map<String, String> props = new java.util.LinkedHashMap<>();
    if (url != null && !url.isBlank()) {
      props.put("spring.datasource.url", url);
      props.put(
          "spring.datasource.username", System.getenv().getOrDefault("TEST_DATABASE_USER", "app"));
      props.put(
          "spring.datasource.password", System.getenv().getOrDefault("TEST_DATABASE_PASSWORD", ""));
    } else {
      requireDocker();
      PostgreSQLContainer db = postgres();
      props.put("spring.datasource.url", db.getJdbcUrl());
      props.put("spring.datasource.username", db.getUsername());
      props.put("spring.datasource.password", db.getPassword());
    }
    if (valkeyHost != null && !valkeyHost.isBlank()) {
      props.put("spring.data.redis.host", valkeyHost);
      props.put("spring.data.redis.port", System.getenv().getOrDefault("TEST_VALKEY_PORT", "6379"));
    } else {
      requireDocker();
      GenericContainer<?> cache = valkey();
      props.put("spring.data.redis.host", cache.getHost());
      props.put("spring.data.redis.port", String.valueOf(cache.getMappedPort(6379)));
    }
    return props;
  }

  private static void requireDocker() {
    if (!DockerClientFactory.instance().isDockerAvailable()) {
      throw new IllegalStateException(
          "Docker is not available. Start Docker, or provide TEST_DATABASE_URL,"
              + " TEST_DATABASE_USER, TEST_DATABASE_PASSWORD and TEST_VALKEY_HOST.");
    }
  }

  private static PostgreSQLContainer postgres() {
    synchronized (LOCK) {
      if (postgres == null) {
        // One container per JVM, stopped by the Testcontainers reaper when the JVM exits.
        postgres = new PostgreSQLContainer(POSTGRES_IMAGE);
        postgres.start();
      }
      return postgres;
    }
  }

  private static GenericContainer<?> valkey() {
    synchronized (LOCK) {
      if (valkey == null) {
        valkey = new GenericContainer<>(DockerImageName.parse(VALKEY_IMAGE)).withExposedPorts(6379);
        valkey.start();
      }
      return valkey;
    }
  }
}
