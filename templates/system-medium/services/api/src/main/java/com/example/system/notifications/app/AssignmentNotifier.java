package com.example.system.notifications.app;

import com.example.system.notifications.domain.Mail;
import com.example.system.notifications.domain.MailSender;
import com.example.system.shared.config.AppProperties;
import com.example.system.shared.flags.FeatureFlags;
import com.example.system.shared.inbox.Inbox;
import com.example.system.tasks.domain.event.TaskAssigned;
import java.util.List;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.modulith.events.ApplicationModuleListener;
import org.springframework.stereotype.Component;

/**
 * Emails the assignee when a task is assigned to them.
 *
 * <p>{@link ApplicationModuleListener} runs the method after the publishing transaction committed,
 * on another thread, in its own transaction, and records the delivery in the event publication
 * registry (the outbox) until the method returns without throwing. So: the task row and the pending
 * delivery were committed together; if this method throws (SMTP down) the delivery stays pending
 * and the worker hands it over again later; and the {@link Inbox} makes a repeated delivery of the
 * same event a no-op.
 *
 * <p>A flag, {@code email-notifications-enabled}, is the kill switch for incidents (a runaway loop,
 * a provider outage you want to stop hammering): when off, events are dropped with a log line, not
 * queued, because a backlog released later would be worse than the silence.
 */
@Component
public class AssignmentNotifier {

  static final String CONSUMER = "assignment-mail";
  private static final Logger LOG = LoggerFactory.getLogger(AssignmentNotifier.class);

  private final Inbox inbox;
  private final MailSender mailer;
  private final FeatureFlags flags;
  private final AppProperties props;

  AssignmentNotifier(Inbox inbox, MailSender mailer, FeatureFlags flags, AppProperties props) {
    this.inbox = inbox;
    this.mailer = mailer;
    this.flags = flags;
    this.props = props;
  }

  @ApplicationModuleListener
  public void on(TaskAssigned event) {
    if (!flags.enabled(
        FeatureFlags.EMAIL_NOTIFICATIONS_ENABLED,
        FeatureFlags.contextFor("system", null, List.of()))) {
      LOG.info("Email notifications are switched off; dropping event {}", event.eventId());
      return;
    }
    if (!inbox.firstDelivery(CONSUMER, event.eventId())) {
      LOG.info("Event {} was already handled; skipping", event.eventId());
      return;
    }
    mailer.send(
        new Mail(
            event.assigneeEmail(),
            "Task assigned to you: " + event.title(),
            event.actorLabel()
                + " assigned a task to you.\n\n"
                + "Task: "
                + event.title()
                + "\n\nOpen "
                + props.mail().baseUrl()
                + " to see it.\n"));
  }
}
