package com.example.system.shared.inbox;

import java.time.Duration;
import java.util.UUID;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Component;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;

/**
 * The consumer side of the outbox: remembers which messages a consumer has already handled, so a
 * redelivery does nothing.
 *
 * <p>The outbox (the Spring Modulith event publication registry) is at-least-once: a listener that
 * crashes or fails is invoked again. A consumer is therefore only correct if handling a message
 * twice equals handling it once. The recipe is one row per (consumer, event id) with a unique key,
 * inserted in the same transaction as the handler's own writes: {@code ON CONFLICT DO NOTHING}
 * returns 0 for a message already seen. The method refuses to run outside a transaction, because a
 * claim that outlives a rolled-back handler would silently drop the message.
 *
 * <p>What it cannot do: make an external side effect (an email) exactly-once. If the handler sends
 * and the transaction then fails to commit, the retry sends again. Use the provider's idempotency
 * key where one exists; otherwise accept and document at-least-once for that effect.
 */
@Component
public class Inbox {

  private final JdbcClient jdbc;

  Inbox(JdbcClient jdbc) {
    this.jdbc = jdbc;
  }

  /** True the first time this consumer sees this event, false for every redelivery. */
  @Transactional(propagation = Propagation.MANDATORY)
  public boolean firstDelivery(String consumer, UUID eventId) {
    return jdbc.sql(
                "insert into processed_events (consumer, event_id, processed_at)"
                    + " values (:consumer, :eventId, now()) on conflict do nothing")
            .param("consumer", consumer)
            .param("eventId", eventId)
            .update()
        == 1;
  }

  /** Housekeeping: forget messages older than any redelivery could still arrive. */
  @Transactional
  public int forgetOlderThan(Duration age) {
    return jdbc.sql(
            "delete from processed_events where processed_at < now() - make_interval(secs => :secs)")
        .param("secs", (double) age.toSeconds())
        .update();
  }
}
