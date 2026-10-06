package com.example.system.shared.web;

import static org.assertj.core.api.Assertions.assertThat;

import com.example.system.support.TestInfrastructure;
import java.time.Clock;
import java.util.UUID;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.springframework.data.redis.connection.RedisStandaloneConfiguration;
import org.springframework.data.redis.connection.lettuce.LettuceClientConfiguration;
import org.springframework.data.redis.connection.lettuce.LettuceConnectionFactory;
import org.springframework.data.redis.core.StringRedisTemplate;

/**
 * The shared limiter against a real Valkey: the script is atomic, two limiter instances (two
 * replicas) spend one budget, and an unreachable Valkey degrades to local counting instead of
 * failing requests.
 */
class ValkeyRateLimiterIT {

  private static LettuceConnectionFactory factory;
  private static StringRedisTemplate valkey;

  private final Clock clock = Clock.systemUTC();

  @BeforeAll
  static void connect() {
    var props = TestInfrastructure.properties();
    factory =
        new LettuceConnectionFactory(
            new RedisStandaloneConfiguration(
                props.get("spring.data.redis.host"),
                Integer.parseInt(props.get("spring.data.redis.port"))),
            LettuceClientConfiguration.defaultConfiguration());
    factory.afterPropertiesSet();
    valkey = new StringRedisTemplate(factory);
    valkey.afterPropertiesSet();
  }

  @AfterAll
  static void disconnect() {
    factory.destroy();
  }

  private ValkeyRateLimiter limiter(StringRedisTemplate template, int perMinute) {
    return new ValkeyRateLimiter(
        template,
        "it-" + UUID.randomUUID(),
        perMinute,
        new InMemoryRateLimiter(perMinute, perMinute, clock));
  }

  @Test
  void allowsTheBudgetThenRefusesWithATtlBasedRetryAfter() {
    var limiter = limiter(valkey, 3);

    for (int i = 0; i < 3; i++) {
      assertThat(limiter.tryAcquire("client").allowed()).isTrue();
    }
    RateLimiter.Decision refused = limiter.tryAcquire("client");

    assertThat(refused.allowed()).isFalse();
    assertThat(refused.retryAfterSeconds()).isBetween(1L, 61L);
  }

  @Test
  void keysAreIndependent() {
    var limiter = limiter(valkey, 1);

    assertThat(limiter.tryAcquire("a").allowed()).isTrue();
    assertThat(limiter.tryAcquire("a").allowed()).isFalse();
    assertThat(limiter.tryAcquire("b").allowed()).isTrue();
  }

  @Test
  void twoInstancesSpendOneSharedBudget() {
    String namespace = "shared-" + UUID.randomUUID();
    var replicaA =
        new ValkeyRateLimiter(valkey, namespace, 4, new InMemoryRateLimiter(4, 4, clock));
    var replicaB =
        new ValkeyRateLimiter(valkey, namespace, 4, new InMemoryRateLimiter(4, 4, clock));

    int allowed = 0;
    for (int i = 0; i < 6; i++) {
      var limiter = i % 2 == 0 ? replicaA : replicaB;
      if (limiter.tryAcquire("client").allowed()) {
        allowed++;
      }
    }

    assertThat(allowed).as("4 shared, not 4 per replica").isEqualTo(4);
  }

  @Test
  void aCounterAlwaysCarriesAnExpiry() {
    String namespace = "ttl-" + UUID.randomUUID();
    new ValkeyRateLimiter(valkey, namespace, 5, new InMemoryRateLimiter(5, 5, clock))
        .tryAcquire("client");

    var keys = valkey.keys("rl:" + namespace + ":*");

    assertThat(keys).hasSize(1);
    assertThat(valkey.getExpire(keys.iterator().next())).isBetween(1L, 61L);
  }

  @Test
  void anUnreachableValkeyFallsBackToLocalCountingInsteadOfFailing() {
    var dead =
        new LettuceConnectionFactory(
            new RedisStandaloneConfiguration("127.0.0.1", 1),
            LettuceClientConfiguration.builder()
                .commandTimeout(java.time.Duration.ofMillis(300))
                .build());
    dead.afterPropertiesSet();
    var template = new StringRedisTemplate(dead);
    template.afterPropertiesSet();
    try {
      var limiter = limiter(template, 2);

      assertThat(limiter.tryAcquire("client").allowed()).isTrue();
      assertThat(limiter.tryAcquire("client").allowed()).isTrue();
      assertThat(limiter.tryAcquire("client").allowed())
          .as("the local fallback still limits")
          .isFalse();
    } finally {
      dead.destroy();
    }
  }
}
