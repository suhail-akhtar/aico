package com.example.system.shared.jobs;

import static org.assertj.core.api.Assertions.assertThat;
import static org.awaitility.Awaitility.await;

import com.example.system.support.IntegrationTest;
import com.example.system.tasks.domain.event.TaskAssigned;
import java.time.Duration;
import java.time.Instant;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.context.ApplicationEventPublisher;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.test.context.TestPropertySource;
import org.springframework.transaction.support.TransactionTemplate;

/**
 * The worker: advisory locking keeps scheduled work single-run, the republish job delivers what a
 * failed consumer left in the outbox, and the purge job forgets what is old enough to forget. Runs
 * in its own context with the jobs switched on and no waiting for the scheduler: the job methods
 * are called directly.
 */
@TestPropertySource(properties = {"app.jobs.enabled=true", "app.jobs.republish-after=0s"})
class JobsIT extends IntegrationTest {

  @Autowired AdvisoryLock lock;
  @Autowired MaintenanceJobs jobs;
  @Autowired JdbcClient jdbc;
  @Autowired TransactionTemplate transaction;
  @Autowired ApplicationEventPublisher publisher;

  @Test
  void onlyOneCallerHoldsALockAtATimeAndItIsReleasedAfterwards() throws Exception {
    String name = "it-lock-" + UUID.randomUUID();
    CountDownLatch holding = new CountDownLatch(1);
    CountDownLatch release = new CountDownLatch(1);

    CompletableFuture<Boolean> first =
        CompletableFuture.supplyAsync(
            () ->
                lock.runExclusively(
                    name,
                    () -> {
                      holding.countDown();
                      try {
                        release.await(10, TimeUnit.SECONDS);
                      } catch (InterruptedException e) {
                        Thread.currentThread().interrupt();
                      }
                    }));
    assertThat(holding.await(10, TimeUnit.SECONDS)).isTrue();

    boolean second = lock.runExclusively(name, () -> {});
    boolean otherName = lock.runExclusively(name + "-other", () -> {});
    release.countDown();

    assertThat(first.get(10, TimeUnit.SECONDS)).isTrue();
    assertThat(second).as("same name while held").isFalse();
    assertThat(otherName).as("a different name is independent").isTrue();
    assertThat(lock.runExclusively(name, () -> {})).as("free again once released").isTrue();
  }

  @Test
  void theRepublishJobDeliversWhatAFailedConsumerLeftBehind() {
    String to = "job-" + UUID.randomUUID() + "@example.com";
    var event =
        new TaskAssigned(
            UUID.randomUUID(),
            UUID.randomUUID(),
            UUID.randomUUID(),
            "a@example.com",
            Instant.now(),
            "t",
            to);
    mails.clear();
    mails.failNext(1);
    transaction.executeWithoutResult(status -> publisher.publishEvent(event));
    await()
        .atMost(Duration.ofSeconds(15))
        .untilAsserted(() -> assertThat(pending(event)).isEqualTo(1));
    assertThat(mails.sentTo(to)).isEmpty();

    jobs.republishIncomplete();

    await()
        .atMost(Duration.ofSeconds(15))
        .untilAsserted(() -> assertThat(mails.sentTo(to)).hasSize(1));
    await().atMost(Duration.ofSeconds(15)).untilAsserted(() -> assertThat(pending(event)).isZero());
  }

  @Test
  void thePurgeJobDeletesOldCompletedPublicationsAndOldInboxRowsButKeepsRecentOnes() {
    UUID oldPublication = UUID.randomUUID();
    UUID recentPublication = UUID.randomUUID();
    UUID oldMessage = UUID.randomUUID();
    UUID recentMessage = UUID.randomUUID();
    insertPublication(oldPublication, "now() - interval '10 days'");
    insertPublication(recentPublication, "now() - interval '1 day'");
    jdbc.sql("insert into processed_events values ('it', :id, now() - interval '40 days')")
        .param("id", oldMessage)
        .update();
    jdbc.sql("insert into processed_events values ('it', :id, now() - interval '2 days')")
        .param("id", recentMessage)
        .update();

    jobs.purge();

    assertThat(publicationExists(oldPublication)).isFalse();
    assertThat(publicationExists(recentPublication)).isTrue();
    assertThat(messageExists(oldMessage)).isFalse();
    assertThat(messageExists(recentMessage)).isTrue();
  }

  private void insertPublication(UUID id, String completedExpression) {
    jdbc.sql(
            "insert into event_publication (id, listener_id, event_type, serialized_event,"
                + " publication_date, completion_date, status) values (:id, 'it', 'it', '{}',"
                + " now() - interval '11 days', "
                + completedExpression
                + ", 'COMPLETED')")
        .param("id", id)
        .update();
  }

  private boolean publicationExists(UUID id) {
    return jdbc.sql("select count(*) from event_publication where id = :id")
            .param("id", id)
            .query(Long.class)
            .single()
        == 1;
  }

  private boolean messageExists(UUID id) {
    return jdbc.sql("select count(*) from processed_events where event_id = :id")
            .param("id", id)
            .query(Long.class)
            .single()
        == 1;
  }

  private long pending(TaskAssigned event) {
    return jdbc.sql(
            "select count(*) from event_publication"
                + " where completion_date is null and serialized_event like :needle")
        .param("needle", "%" + event.eventId() + "%")
        .query(Long.class)
        .single();
  }
}
