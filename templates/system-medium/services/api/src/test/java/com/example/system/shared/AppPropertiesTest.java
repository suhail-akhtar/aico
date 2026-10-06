package com.example.system.shared;

import static org.assertj.core.api.Assertions.assertThat;

import com.example.system.shared.config.AppProperties;
import jakarta.validation.ConstraintViolation;
import jakarta.validation.Validation;
import jakarta.validation.Validator;
import java.time.Duration;
import java.util.Set;
import java.util.stream.Collectors;
import org.junit.jupiter.api.Test;
import org.springframework.util.unit.DataSize;

/** Startup validation: weak or inconsistent settings must be caught before the first request. */
class AppPropertiesTest {

  private static final Validator VALIDATOR =
      Validation.buildDefaultValidatorFactory().getValidator();

  private static AppProperties with(
      AppProperties.Storage storage, AppProperties.Flags flags, AppProperties.Jobs jobs) {
    return new AppProperties(
        new AppProperties.Security(false),
        new AppProperties.RateLimit(true, 300, 30),
        new AppProperties.Http(DataSize.ofKilobytes(256), DataSize.ofMegabytes(5)),
        jobs,
        storage,
        flags,
        new AppProperties.Mail("noreply@example.test", "http://localhost:8080"));
  }

  private static AppProperties.Storage s3(String endpoint, String access, String secret) {
    return new AppProperties.Storage(
        "s3", endpoint, "us-east-1", "attachments", access, secret, false, true);
  }

  private static AppProperties.Jobs jobs(Duration completed, Duration processed) {
    return new AppProperties.Jobs(
        false, Duration.ofSeconds(30), Duration.ofSeconds(30), completed, processed);
  }

  private static AppProperties sound() {
    return with(
        s3("http://s3:8333", "key", "secret"),
        new AppProperties.Flags("flagd", "flagd", 8013),
        jobs(Duration.ofDays(7), Duration.ofDays(30)));
  }

  private static Set<String> messages(AppProperties props) {
    return VALIDATOR.validate(props).stream()
        .map(ConstraintViolation::getMessage)
        .collect(Collectors.toSet());
  }

  @Test
  void aSoundConfigurationHasNoViolations() {
    assertThat(VALIDATOR.validate(sound())).isEmpty();
  }

  @Test
  void theS3StoreNeedsAnEndpointAndBothKeys() {
    var props =
        with(
            s3("", "key", "secret"),
            new AppProperties.Flags("flagd", "flagd", 8013),
            jobs(Duration.ofDays(7), Duration.ofDays(30)));

    assertThat(messages(props)).anyMatch(m -> m.contains("S3_ENDPOINT"));
    assertThat(messages(with(s3("http://s3", null, "secret"), props.flags(), props.jobs())))
        .anyMatch(m -> m.contains("S3_ACCESS_KEY"));
  }

  @Test
  void theMemoryStoreNeedsNoCredentials() {
    var memory =
        new AppProperties.Storage("memory", null, "us-east-1", "b", null, null, false, true);

    assertThat(VALIDATOR.validate(with(memory, sound().flags(), sound().jobs()))).isEmpty();
  }

  @Test
  void anUnknownProviderIsRejected() {
    var storage = new AppProperties.Storage("ftp", null, "us-east-1", "b", null, null, false, true);
    var flags = new AppProperties.Flags("launchdarkly", "h", 1);

    assertThat(messages(with(storage, flags, sound().jobs())))
        .anyMatch(m -> m.contains("app.storage.provider"))
        .anyMatch(m -> m.contains("app.flags.provider"));
  }

  @Test
  void deduplicationMustOutliveRedelivery() {
    var props =
        with(sound().storage(), sound().flags(), jobs(Duration.ofDays(30), Duration.ofDays(7)));

    assertThat(messages(props)).anyMatch(m -> m.contains("APP_KEEP_PROCESSED"));
  }

  @Test
  void aPortOutOfRangeIsRejected() {
    var flags = new AppProperties.Flags("flagd", "flagd", 70000);

    assertThat(VALIDATOR.validate(with(sound().storage(), flags, sound().jobs()))).isNotEmpty();
  }
}
