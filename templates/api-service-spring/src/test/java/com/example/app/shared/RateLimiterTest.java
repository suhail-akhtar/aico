package com.example.app.shared;

import static org.assertj.core.api.Assertions.assertThat;

import com.example.app.shared.web.RateLimiter;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneId;
import org.junit.jupiter.api.Test;

class RateLimiterTest {

  /** A clock the test moves by hand, so no test sleeps. */
  static final class ManualClock extends Clock {
    private Instant now = Instant.parse("2026-10-06T10:00:00Z");

    void advance(Duration d) {
      now = now.plus(d);
    }

    @Override
    public ZoneId getZone() {
      return ZoneId.of("UTC");
    }

    @Override
    public Clock withZone(ZoneId zone) {
      return this;
    }

    @Override
    public Instant instant() {
      return now;
    }
  }

  @Test
  void allowsUpToCapacityThenRefuses() {
    var limiter = new RateLimiter(3, 60, new ManualClock());

    for (int i = 0; i < 3; i++) {
      assertThat(limiter.tryAcquire("a").allowed()).isTrue();
    }
    RateLimiter.Decision refused = limiter.tryAcquire("a");

    assertThat(refused.allowed()).isFalse();
    assertThat(refused.retryAfterSeconds()).isEqualTo(1);
  }

  @Test
  void keysAreIndependent() {
    var limiter = new RateLimiter(1, 60, new ManualClock());

    assertThat(limiter.tryAcquire("a").allowed()).isTrue();
    assertThat(limiter.tryAcquire("a").allowed()).isFalse();
    assertThat(limiter.tryAcquire("b").allowed()).isTrue();
  }

  @Test
  void refillsOverTimeButNeverBeyondCapacity() {
    var clock = new ManualClock();
    var limiter = new RateLimiter(2, 60, clock);
    limiter.tryAcquire("a");
    limiter.tryAcquire("a");
    assertThat(limiter.tryAcquire("a").allowed()).isFalse();

    clock.advance(Duration.ofSeconds(1));
    assertThat(limiter.tryAcquire("a").allowed()).isTrue();

    clock.advance(Duration.ofHours(1));
    assertThat(limiter.tryAcquire("a").allowed()).isTrue();
    assertThat(limiter.tryAcquire("a").allowed()).isTrue();
    assertThat(limiter.tryAcquire("a").allowed()).isFalse();
  }

  @Test
  void retryAfterReflectsTheSlowRefillRate() {
    var limiter = new RateLimiter(1, 6, new ManualClock()); // one token per 10 s
    limiter.tryAcquire("a");

    assertThat(limiter.tryAcquire("a").retryAfterSeconds()).isEqualTo(10);
  }

  @Test
  void aHugeNumberOfDistinctKeysIsBoundedByDroppingIdleBuckets() {
    var clock = new ManualClock();
    var limiter = new RateLimiter(1, 60, clock);
    for (int i = 0; i < 50_010; i++) {
      limiter.tryAcquire("ip-" + i);
    }
    clock.advance(Duration.ofMinutes(5));

    // The next call sees a full map and sweeps buckets that have refilled; it must still work.
    assertThat(limiter.tryAcquire("fresh").allowed()).isTrue();
  }
}
