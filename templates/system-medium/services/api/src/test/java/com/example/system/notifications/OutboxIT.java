package com.example.system.notifications;

import static org.assertj.core.api.Assertions.assertThat;
import static org.awaitility.Awaitility.await;

import com.example.system.support.IntegrationTest;
import com.example.system.tasks.domain.event.TaskAssigned;
import java.time.Duration;
import java.time.Instant;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.context.ApplicationEventPublisher;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.modulith.events.IncompleteEventPublications;
import org.springframework.transaction.support.TransactionTemplate;

/**
 * The outbox and the idempotent consumer, proven against real PostgreSQL:
 *
 * <ul>
 *   <li>an assignment commits the task and a pending delivery together and results in one email;
 *   <li>the same event delivered twice sends one email (the inbox);
 *   <li>a failing consumer leaves the delivery pending, and a later resubmission delivers it
 *       exactly once, however many times it is resubmitted afterwards.
 * </ul>
 */
class OutboxIT extends IntegrationTest {

  private static final Duration WAIT = Duration.ofSeconds(15);

  @Autowired ApplicationEventPublisher publisher;
  @Autowired TransactionTemplate transaction;
  @Autowired IncompleteEventPublications incomplete;
  @Autowired JdbcClient jdbc;

  @BeforeEach
  void reset() {
    mails.clear();
  }

  private TaskAssigned assignment(String to) {
    return new TaskAssigned(
        UUID.randomUUID(),
        UUID.randomUUID(),
        UUID.randomUUID(),
        "alice@example.com",
        Instant.now(),
        "Review the plan",
        to);
  }

  private void publishInATransaction(TaskAssigned... events) {
    transaction.executeWithoutResult(
        status -> {
          for (TaskAssigned event : events) {
            publisher.publishEvent(event);
          }
        });
  }

  private long pendingFor(TaskAssigned event) {
    return jdbc.sql(
            "select count(*) from event_publication"
                + " where completion_date is null and serialized_event like :needle")
        .param("needle", "%" + event.eventId() + "%")
        .query(Long.class)
        .single();
  }

  private long completedFor(TaskAssigned event) {
    return jdbc.sql(
            "select count(*) from event_publication"
                + " where completion_date is not null and serialized_event like :needle")
        .param("needle", "%" + event.eventId() + "%")
        .query(Long.class)
        .single();
  }

  @Test
  void assigningATaskThroughTheApiEmailsTheAssigneeOnce() {
    var alice = newMember();
    String to = "assignee-" + UUID.randomUUID() + "@example.com";

    post("/api/v1/tasks", alice, Map.of("title", "Prepare the demo", "assigneeEmail", to));

    await().atMost(WAIT).untilAsserted(() -> assertThat(mails.sentTo(to)).hasSize(1));
    var mail = mails.sentTo(to).getFirst();
    assertThat(mail.subject()).isEqualTo("Task assigned to you: Prepare the demo");
    assertThat(mail.body()).contains(alice.email()).contains("Prepare the demo");
  }

  @Test
  void theSameEventDeliveredTwiceSendsOneEmail() {
    String to = "dup-" + UUID.randomUUID() + "@example.com";
    TaskAssigned event = assignment(to);

    publishInATransaction(event, event);
    publishInATransaction(event);

    await().atMost(WAIT).untilAsserted(() -> assertThat(mails.sentTo(to)).hasSize(1));
    // Nothing arrives late: give any stray duplicate time to show up.
    await()
        .during(Duration.ofSeconds(2))
        .atMost(Duration.ofSeconds(4))
        .untilAsserted(() -> assertThat(mails.sentTo(to)).hasSize(1));
    assertThat(
            jdbc.sql("select count(*) from processed_events where event_id = :id")
                .param("id", event.eventId())
                .query(Long.class)
                .single())
        .isEqualTo(1);
  }

  @Test
  void aFailedDeliveryStaysInTheOutboxAndIsDeliveredOnceWhenRetried() {
    String to = "retry-" + UUID.randomUUID() + "@example.com";
    TaskAssigned event = assignment(to);
    mails.failNext(1);

    publishInATransaction(event);

    // The mail server was down: nothing was sent and the delivery is still pending.
    await().atMost(WAIT).untilAsserted(() -> assertThat(pendingFor(event)).isEqualTo(1));
    assertThat(mails.sentTo(to)).isEmpty();
    assertThat(
            jdbc.sql("select count(*) from processed_events where event_id = :id")
                .param("id", event.eventId())
                .query(Long.class)
                .single())
        .as("the failed attempt must not have claimed the event")
        .isZero();

    // The worker's job: hand it over again.
    incomplete.resubmitIncompletePublications(
        p -> p.getEvent() instanceof TaskAssigned e && e.eventId().equals(event.eventId()));

    await().atMost(WAIT).untilAsserted(() -> assertThat(mails.sentTo(to)).hasSize(1));
    await().atMost(WAIT).untilAsserted(() -> assertThat(completedFor(event)).isEqualTo(1));
    assertThat(pendingFor(event)).isZero();

    // Resubmitting again changes nothing: it is complete, and the inbox would refuse a repeat.
    incomplete.resubmitIncompletePublications(
        p -> p.getEvent() instanceof TaskAssigned e && e.eventId().equals(event.eventId()));
    await()
        .during(Duration.ofSeconds(2))
        .atMost(Duration.ofSeconds(4))
        .untilAsserted(() -> assertThat(mails.sentTo(to)).hasSize(1));
  }

  @Test
  void aRolledBackChangeLeavesNoDeliveryBehind() {
    String to = "rolledback-" + UUID.randomUUID() + "@example.com";
    TaskAssigned event = assignment(to);

    transaction.executeWithoutResult(
        status -> {
          publisher.publishEvent(event);
          status.setRollbackOnly();
        });

    await()
        .during(Duration.ofSeconds(2))
        .atMost(Duration.ofSeconds(4))
        .untilAsserted(
            () -> {
              assertThat(mails.sentTo(to)).isEmpty();
              assertThat(pendingFor(event) + completedFor(event)).isZero();
            });
  }
}
