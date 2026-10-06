package com.example.system.shared.jobs;

import com.example.system.shared.config.AppProperties;
import com.example.system.shared.inbox.Inbox;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.modulith.events.CompletedEventPublications;
import org.springframework.modulith.events.IncompleteEventPublications;
import org.springframework.scheduling.annotation.EnableScheduling;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

/**
 * The background worker's jobs. They run only where {@code APP_JOBS_ENABLED=true} (the worker
 * deployment), so scaling the web tier never multiplies them, and each is additionally guarded by
 * an advisory lock so two worker replicas never run the same round.
 *
 * <ul>
 *   <li><b>Republish</b>: event publications still incomplete after {@code republishAfter} (the
 *       listener failed, or the process died mid-handling) are handed to their listeners again.
 *       Together with the consumers' {@link Inbox} this makes delivery at-least-once and handling
 *       effectively-once.
 *   <li><b>Purge</b>: completed publications and old inbox rows are deleted. The inbox keeps
 *       messages longer than the registry keeps publications, so a late redelivery is still
 *       recognised.
 * </ul>
 *
 * Durable work in this design is "an outbox row plus a retry loop", not an in-memory queue: nothing
 * is lost on restart, and nothing needs a scheduler library.
 */
@Component
@EnableScheduling
@ConditionalOnProperty(name = "app.jobs.enabled", havingValue = "true")
class MaintenanceJobs {

  private static final Logger LOG = LoggerFactory.getLogger(MaintenanceJobs.class);

  private final IncompleteEventPublications incomplete;
  private final CompletedEventPublications completed;
  private final Inbox inbox;
  private final AdvisoryLock lock;
  private final AppProperties props;

  MaintenanceJobs(
      IncompleteEventPublications incomplete,
      CompletedEventPublications completed,
      Inbox inbox,
      AdvisoryLock lock,
      AppProperties props) {
    this.incomplete = incomplete;
    this.completed = completed;
    this.inbox = inbox;
    this.lock = lock;
    this.props = props;
  }

  @Scheduled(
      fixedDelayString = "${app.jobs.republish-every:30s}",
      initialDelayString = "${app.jobs.republish-every:30s}")
  void republishIncomplete() {
    lock.runExclusively(
        "republish-incomplete-events",
        () -> {
          incomplete.resubmitIncompletePublicationsOlderThan(props.jobs().republishAfter());
          LOG.debug("Resubmitted incomplete event publications");
        });
  }

  @Scheduled(cron = "${app.jobs.purge-cron:0 17 * * * *}")
  void purge() {
    lock.runExclusively(
        "purge-delivered-messages",
        () -> {
          completed.deletePublicationsOlderThan(props.jobs().keepCompletedEvents());
          int forgotten = inbox.forgetOlderThan(props.jobs().keepProcessedMessages());
          LOG.info("Purged delivered messages, forgot {} processed ids", forgotten);
        });
  }
}
