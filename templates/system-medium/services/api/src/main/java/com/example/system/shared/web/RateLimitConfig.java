package com.example.system.shared.web;

import com.example.system.shared.config.AppProperties;
import java.time.Clock;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.data.redis.core.StringRedisTemplate;

/**
 * Builds the two request budgets. They are exposed as a pair rather than as filter beans because a
 * {@code Filter} bean would be registered with the servlet container as well as in the security
 * chain and run twice; the security configuration places {@link RateLimitFilter} itself.
 */
@Configuration(proxyBeanMethods = false)
public class RateLimitConfig {

  /** The two budgets: general API traffic and the login endpoints. */
  public record RateLimiters(RateLimiter api, RateLimiter auth) {}

  @Bean
  RateLimiters rateLimiters(AppProperties props, StringRedisTemplate valkey, Clock clock) {
    AppProperties.RateLimit cfg = props.rateLimit();
    if (!cfg.enabled()) {
      RateLimiter open = key -> new RateLimiter.Decision(true, 0);
      return new RateLimiters(open, open);
    }
    return new RateLimiters(
        new ValkeyRateLimiter(
            valkey,
            "api",
            cfg.apiPerMinute(),
            new InMemoryRateLimiter(cfg.apiPerMinute(), cfg.apiPerMinute(), clock)),
        new ValkeyRateLimiter(
            valkey,
            "auth",
            cfg.authPerMinute(),
            new InMemoryRateLimiter(cfg.authPerMinute(), cfg.authPerMinute(), clock)));
  }
}
