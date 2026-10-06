package com.example.system.tasks.domain.event;

import java.time.Instant;
import java.util.UUID;

/**
 * Anything that happened to a task. {@code eventId} identifies this occurrence and is what
 * consumers de-duplicate on: the same event delivered twice carries the same id. {@code actorId}
 * and {@code actorLabel} are who did it, copied into the event so a consumer never has to read the
 * identity module's data.
 */
public sealed interface TaskEvent permits TaskCreated, TaskAssigned, TaskCompleted, TaskDeleted {

  UUID eventId();

  UUID taskId();

  UUID actorId();

  String actorLabel();

  Instant occurredAt();

  /** A stable name for the audit trail, for example {@code task.created}. */
  String type();
}
