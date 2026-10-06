package com.example.system.shared.config;

import jakarta.validation.Valid;
import jakarta.validation.constraints.AssertTrue;
import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotBlank;
import java.time.Duration;
import org.jspecify.annotations.Nullable;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.boot.context.properties.bind.DefaultValue;
import org.springframework.util.unit.DataSize;
import org.springframework.validation.annotation.Validated;

/**
 * Every setting the application reads beyond Spring Boot's own, bound from environment variables
 * (see {@code application.properties}) and validated at startup, so a missing or weak value stops
 * the process with a message that names the setting instead of failing on the first request.
 */
@Validated
@ConfigurationProperties(prefix = "app")
public record AppProperties(
    @Valid @DefaultValue Security security,
    @Valid @DefaultValue RateLimit rateLimit,
    @Valid @DefaultValue Http http,
    @Valid @DefaultValue Jobs jobs,
    @Valid @DefaultValue Storage storage,
    @Valid @DefaultValue Flags flags,
    @Valid @DefaultValue Mail mail) {

  /** Cookie hardening that depends on whether TLS terminates in front of the service. */
  public record Security(@DefaultValue("false") boolean secureCookies) {}

  /** Fixed-window budgets per client address, shared by every replica through Valkey. */
  public record RateLimit(
      @DefaultValue("true") boolean enabled,
      @Min(1) @DefaultValue("300") int apiPerMinute,
      @Min(1) @DefaultValue("30") int authPerMinute) {}

  /** Request size ceilings, enforced before the body is parsed. */
  public record Http(
      @DefaultValue("256KB") DataSize maxBodySize, @DefaultValue("5MB") DataSize maxUploadSize) {}

  /** Background maintenance. Exactly one deployment (the worker) turns it on. */
  public record Jobs(
      @DefaultValue("false") boolean enabled,
      @DefaultValue("30s") Duration republishAfter,
      @DefaultValue("30s") Duration republishEvery,
      @DefaultValue("7d") Duration keepCompletedEvents,
      @DefaultValue("30d") Duration keepProcessedMessages) {

    @AssertTrue(message = "APP_KEEP_PROCESSED must be longer than APP_KEEP_COMPLETED_EVENTS")
    public boolean isDeduplicationOutlivesRedelivery() {
      return keepProcessedMessages.compareTo(keepCompletedEvents) > 0;
    }
  }

  /** The S3-compatible object store for attachments. {@code memory} exists for tests. */
  public record Storage(
      @NotBlank @DefaultValue("s3") String provider,
      @Nullable String endpoint,
      @DefaultValue("us-east-1") String region,
      @DefaultValue("attachments") String bucket,
      @Nullable String accessKey,
      @Nullable String secretKey,
      @DefaultValue("false") boolean createBucket,
      @DefaultValue("true") boolean pathStyle) {

    @AssertTrue(
        message = "S3_ENDPOINT, S3_ACCESS_KEY and S3_SECRET_KEY are required for the s3 store")
    public boolean isS3Configured() {
      return !"s3".equals(provider) || (has(endpoint) && has(accessKey) && has(secretKey));
    }

    @AssertTrue(message = "app.storage.provider must be s3 or memory")
    public boolean isKnownProvider() {
      return "s3".equals(provider) || "memory".equals(provider);
    }

    private static boolean has(@Nullable String value) {
      return value != null && !value.isBlank();
    }
  }

  /** The feature-flag provider. {@code flagd} in production, {@code memory} (defaults) in tests. */
  public record Flags(
      @NotBlank @DefaultValue("flagd") String provider,
      @DefaultValue("localhost") String flagdHost,
      @Min(1) @Max(65535) @DefaultValue("8013") int flagdPort) {

    @AssertTrue(message = "app.flags.provider must be flagd or memory")
    public boolean isKnownProvider() {
      return "flagd".equals(provider) || "memory".equals(provider);
    }
  }

  /** Sender address of notification emails, and the public address links in them point to. */
  public record Mail(
      @NotBlank @DefaultValue("noreply@system.example.test") String from,
      @NotBlank @DefaultValue("http://localhost:8080") String baseUrl) {}
}
