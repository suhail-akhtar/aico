package com.example.system.shared.web;

import java.util.List;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.data.redis.core.script.DefaultRedisScript;

/**
 * Fixed-window counter in Valkey, one key per client and window. {@code INCR} and the first {@code
 * EXPIRE} run in one Lua script, so a crash between them cannot leave a counter that never expires
 * (which would lock a client out forever). Every replica increments the same key, so the budget is
 * per client, not per pod.
 *
 * <p>Fixed windows allow up to twice the limit across a window boundary; that is accepted for a
 * coarse abuse limiter and documented. If Valkey cannot be reached the decision falls back to a
 * per-process limiter: degraded accuracy, not an outage.
 */
public final class ValkeyRateLimiter implements RateLimiter {

  private static final Logger LOG = LoggerFactory.getLogger(ValkeyRateLimiter.class);
  private static final int WINDOW_SECONDS = 60;

  @SuppressWarnings("rawtypes")
  private static final DefaultRedisScript<List> SCRIPT =
      new DefaultRedisScript<>(
          """
          local count = redis.call('INCR', KEYS[1])
          if count == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
          return {count, redis.call('TTL', KEYS[1])}
          """,
          List.class);

  private final StringRedisTemplate valkey;
  private final String namespace;
  private final int limitPerWindow;
  private final RateLimiter fallback;

  public ValkeyRateLimiter(
      StringRedisTemplate valkey, String namespace, int limitPerMinute, RateLimiter fallback) {
    this.valkey = valkey;
    this.namespace = namespace;
    this.limitPerWindow = limitPerMinute;
    this.fallback = fallback;
  }

  @Override
  public Decision tryAcquire(String key) {
    try {
      long window = System.currentTimeMillis() / 1000 / WINDOW_SECONDS;
      @SuppressWarnings("rawtypes")
      List result =
          valkey.execute(
              SCRIPT,
              List.of("rl:" + namespace + ":" + key + ":" + window),
              Integer.toString(WINDOW_SECONDS + 1));
      if (result == null || result.size() < 2) {
        return fallback.tryAcquire(key);
      }
      long count = ((Number) result.get(0)).longValue();
      long ttl = Math.max(1, ((Number) result.get(1)).longValue());
      return count <= limitPerWindow ? new Decision(true, 0) : new Decision(false, ttl);
    } catch (RuntimeException e) {
      LOG.warn("Rate limiter fell back to local counting: {}", e.getClass().getSimpleName());
      return fallback.tryAcquire(key);
    }
  }
}
