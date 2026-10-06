package com.example.system.tasks.domain.event;

import java.time.Instant;
import java.util.UUID;

/** A task was assigned to someone, who is told by email. */
public record TaskAssigned(
    UUID eventId,
    UUID taskId,
    UUID actorId,
    String actorLabel,
    Instant occurredAt,
    String title,
    String assigneeEmail)
    implements TaskEvent {

  @Override
  public String type() {
    return "task.assigned";
  }
}
