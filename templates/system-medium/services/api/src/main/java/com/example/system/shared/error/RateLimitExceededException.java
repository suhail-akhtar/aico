package com.example.system.shared.error;

/** The caller exceeded its request budget. Answers 429 with {@code Retry-After}. */
public class RateLimitExceededException extends DomainException {

  private static final long serialVersionUID = 1L;

  private final long retryAfterSeconds;

  public RateLimitExceededException(long retryAfterSeconds) {
    super("rate_limited", "Too many requests");
    this.retryAfterSeconds = retryAfterSeconds;
  }

  public long retryAfterSeconds() {
    return retryAfterSeconds;
  }
}
