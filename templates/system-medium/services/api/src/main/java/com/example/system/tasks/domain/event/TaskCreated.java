package com.example.system.tasks.domain.event;

import java.time.Instant;
import java.util.UUID;

/** A task was created. */
public record TaskCreated(
    UUID eventId, UUID taskId, UUID actorId, String actorLabel, Instant occurredAt, String title)
    implements TaskEvent {

  @Override
  public String type() {
    return "task.created";
  }
}
