package com.example.system.shared.web;

import java.time.Clock;
import java.util.concurrent.ConcurrentHashMap;

/**
 * In-memory token bucket per key. One instance guards one budget. It is correct for a single
 * process; behind several replicas each keeps its own count, so {@link ValkeyRateLimiter} is the
 * primary limiter and this one is its fallback when Valkey is unreachable (a limiter must degrade,
 * not take the API down with it). Idle buckets are dropped once the map grows large so a client
 * that rotates addresses cannot grow memory without bound.
 */
public final class InMemoryRateLimiter implements RateLimiter {

  private static final int MAX_KEYS = 50_000;

  private final int capacity;
  private final double refillPerMilli;
  private final Clock clock;
  private final ConcurrentHashMap<String, Bucket> buckets = new ConcurrentHashMap<>();

  public InMemoryRateLimiter(int capacity, int refillPerMinute, Clock clock) {
    this.capacity = capacity;
    this.refillPerMilli = refillPerMinute / 60_000.0;
    this.clock = clock;
  }

  @Override
  public Decision tryAcquire(String key) {
    long now = clock.millis();
    if (buckets.size() > MAX_KEYS) {
      buckets.values().removeIf(bucket -> bucket.isFull(now, refillPerMilli, capacity));
    }
    Bucket bucket = buckets.computeIfAbsent(key, k -> new Bucket(capacity, now));
    return bucket.take(now, refillPerMilli, capacity);
  }

  private static final class Bucket {
    private double tokens;
    private long updatedAt;

    Bucket(double tokens, long updatedAt) {
      this.tokens = tokens;
      this.updatedAt = updatedAt;
    }

    synchronized Decision take(long now, double refillPerMilli, int capacity) {
      refill(now, refillPerMilli, capacity);
      if (tokens >= 1) {
        tokens -= 1;
        return new Decision(true, 0);
      }
      long waitMillis = (long) Math.ceil((1 - tokens) / refillPerMilli);
      return new Decision(false, Math.max(1, (waitMillis + 999) / 1000));
    }

    synchronized boolean isFull(long now, double refillPerMilli, int capacity) {
      refill(now, refillPerMilli, capacity);
      return tokens >= capacity;
    }

    private void refill(long now, double refillPerMilli, int capacity) {
      long elapsed = Math.max(0, now - updatedAt);
      tokens = Math.min(capacity, tokens + elapsed * refillPerMilli);
      updatedAt = now;
    }
  }
}
