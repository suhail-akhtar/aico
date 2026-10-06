package com.example.system.shared.web;

/**
 * A request budget per key. {@link InMemoryRateLimiter} counts in one process; {@link
 * ValkeyRateLimiter} counts for every replica at once, which is the one that matters once the API
 * runs more than one copy.
 */
public interface RateLimiter {

  /** Outcome of one attempt. {@code retryAfterSeconds} is 0 when allowed. */
  record Decision(boolean allowed, long retryAfterSeconds) {}

  Decision tryAcquire(String key);
}
