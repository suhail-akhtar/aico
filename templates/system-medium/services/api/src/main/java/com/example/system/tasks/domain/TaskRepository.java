package com.example.system.tasks.domain;

import com.example.system.shared.page.PageQuery;
import com.example.system.shared.page.PageResult;
import java.util.Optional;
import java.util.UUID;
import org.jspecify.annotations.Nullable;

/**
 * Port: what the application needs from storage, in domain terms. Every owner-facing lookup takes
 * the owner, so "someone else's task" and "no such task" are the same empty result by construction;
 * the service cannot forget an ownership check because there is no such method without one.
 */
public interface TaskRepository {

  Task insert(Task task);

  Optional<Task> findByIdAndOwner(UUID id, UUID ownerId);

  /** Replaces the stored content of a task the owner already has. */
  Task update(Task task);

  /** Returns false when the owner has no such task. */
  boolean deleteByIdAndOwner(UUID id, UUID ownerId);

  /** Newest first. {@code titleContains} is a case-insensitive literal match, or null for all. */
  PageResult<Task> findByOwner(
      UUID ownerId, @Nullable TaskStatus status, @Nullable String titleContains, PageQuery page);

  long countByOwnerAndStatus(UUID ownerId, TaskStatus status);

  /** Administrators only: every task, whoever owns it, newest first. */
  PageResult<Task> findAll(PageQuery page);
}
