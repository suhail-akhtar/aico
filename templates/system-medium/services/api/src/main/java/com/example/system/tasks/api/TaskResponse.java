package com.example.system.tasks.api;

import com.example.system.tasks.domain.Task;
import com.example.system.tasks.domain.TaskStatus;
import java.time.Instant;
import java.util.UUID;
import org.jspecify.annotations.Nullable;

/** The JSON shape of a task. Never carries anything the caller cannot already see. */
public record TaskResponse(
    UUID id,
    String title,
    @Nullable String description,
    TaskStatus status,
    @Nullable String assigneeEmail,
    Instant createdAt,
    Instant updatedAt,
    long version) {

  static TaskResponse from(Task task) {
    return new TaskResponse(
        task.id(),
        task.title(),
        task.description(),
        task.status(),
        task.assigneeEmail(),
        task.createdAt(),
        task.updatedAt(),
        task.version());
  }
}
