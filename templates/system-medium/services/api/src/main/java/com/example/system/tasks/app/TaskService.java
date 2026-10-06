package com.example.system.tasks.app;

import com.example.system.identity.AuthenticatedUser;
import com.example.system.shared.error.ConflictException;
import com.example.system.shared.error.NotFoundException;
import com.example.system.shared.flags.FeatureFlags;
import com.example.system.shared.page.PageQuery;
import com.example.system.shared.page.PageResult;
import com.example.system.tasks.domain.Task;
import com.example.system.tasks.domain.TaskRepository;
import com.example.system.tasks.domain.TaskStatus;
import com.example.system.tasks.domain.event.TaskAssigned;
import com.example.system.tasks.domain.event.TaskCompleted;
import com.example.system.tasks.domain.event.TaskCreated;
import com.example.system.tasks.domain.event.TaskDeleted;
import com.example.system.tasks.domain.event.TaskEvent;
import dev.openfeature.sdk.EvaluationContext;
import java.time.Clock;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.Objects;
import java.util.UUID;
import org.jspecify.annotations.Nullable;
import org.springframework.context.ApplicationEventPublisher;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * Use cases for tasks. One public method per thing a caller can do; each is one transaction, and
 * each state change publishes its event inside that transaction. That is the transactional outbox:
 * the event is stored (in the event publication registry) in the same commit as the task row, so a
 * crash can lose neither, and a failed listener is retried later instead of being dropped.
 *
 * <p>The caller always arrives as a parameter taken from the verified credential, never from user
 * input, and every lookup is scoped to the caller, so a foreign id is indistinguishable from a
 * missing one.
 */
@Service
@Transactional
public class TaskService {

  private final TaskRepository tasks;
  private final AttachmentService attachments;
  private final ApplicationEventPublisher events;
  private final FeatureFlags flags;
  private final Clock clock;

  public TaskService(
      TaskRepository tasks,
      AttachmentService attachments,
      ApplicationEventPublisher events,
      FeatureFlags flags,
      Clock clock) {
    this.tasks = tasks;
    this.attachments = attachments;
    this.events = events;
    this.flags = flags;
    this.clock = clock;
  }

  public Task create(
      AuthenticatedUser actor,
      String title,
      @Nullable String description,
      @Nullable String assigneeEmail) {
    int limit = flags.number(FeatureFlags.MAX_OPEN_TASKS_PER_USER, context(actor));
    if (tasks.countByOwnerAndStatus(actor.id(), TaskStatus.OPEN) >= limit) {
      throw new ConflictException(
          "task_limit_reached", "You already have " + limit + " open tasks; finish some first.");
    }
    Task created = tasks.insert(Task.create(actor.id(), title, description, assigneeEmail, now()));
    publish(
        new TaskCreated(
            UUID.randomUUID(), created.id(), actor.id(), actor.label(), now(), created.title()));
    announceAssignment(actor, created);
    return created;
  }

  @Transactional(readOnly = true)
  public Task get(AuthenticatedUser actor, UUID id) {
    return tasks.findByIdAndOwner(id, actor.id()).orElseThrow(TaskService::notFound);
  }

  @Transactional(readOnly = true)
  public PageResult<Task> list(
      AuthenticatedUser actor,
      @Nullable TaskStatus status,
      @Nullable String titleContains,
      PageQuery page) {
    String filter = titleContains == null || titleContains.isBlank() ? null : titleContains.strip();
    return tasks.findByOwner(actor.id(), status, filter, page);
  }

  /** Administrators only (enforced at the edge and again by the controller's method security). */
  @Transactional(readOnly = true)
  public PageResult<Task> listAll(PageQuery page) {
    return tasks.findAll(page);
  }

  /**
   * Updates a task. If the caller passes the version it last saw and the task has moved on, the
   * update is refused (409) instead of silently overwriting the other change. Assigning to a new
   * address publishes {@code TaskAssigned}; saving the same address again does not.
   */
  public Task update(
      AuthenticatedUser actor,
      UUID id,
      String title,
      @Nullable String description,
      @Nullable String assigneeEmail,
      @Nullable Long expectedVersion) {
    Task current = get(actor, id);
    if (expectedVersion != null && expectedVersion != current.version()) {
      throw new ConflictException(
          "version_conflict", "The task changed since version " + expectedVersion + "; reload it.");
    }
    Task updated = tasks.update(current.withDetails(title, description, assigneeEmail, now()));
    if (updated.assigneeEmail() != null
        && !Objects.equals(updated.assigneeEmail(), current.assigneeEmail())) {
      announceAssignment(actor, updated);
    }
    return updated;
  }

  /** Marks a task done. Completing a task that is already done changes nothing and says nothing. */
  public Task complete(AuthenticatedUser actor, UUID id) {
    Task current = get(actor, id);
    if (current.isDone()) {
      return current;
    }
    Task done = tasks.update(current.complete(now()));
    publish(
        new TaskCompleted(
            UUID.randomUUID(), done.id(), actor.id(), actor.label(), now(), done.title()));
    return done;
  }

  public void delete(AuthenticatedUser actor, UUID id) {
    Task current = get(actor, id);
    attachments.removeAllObjects(current.id());
    if (!tasks.deleteByIdAndOwner(id, actor.id())) {
      throw notFound();
    }
    publish(new TaskDeleted(UUID.randomUUID(), id, actor.id(), actor.label(), now()));
  }

  private void announceAssignment(AuthenticatedUser actor, Task task) {
    if (task.assigneeEmail() != null) {
      publish(
          new TaskAssigned(
              UUID.randomUUID(),
              task.id(),
              actor.id(),
              actor.label(),
              now(),
              task.title(),
              task.assigneeEmail()));
    }
  }

  private void publish(TaskEvent event) {
    events.publishEvent(event);
  }

  private static EvaluationContext context(AuthenticatedUser actor) {
    return FeatureFlags.contextFor(actor.id().toString(), actor.email(), actor.roles());
  }

  private Instant now() {
    // Postgres stores microseconds; truncating keeps what we return equal to what we stored.
    return clock.instant().truncatedTo(ChronoUnit.MICROS);
  }

  private static NotFoundException notFound() {
    return new NotFoundException("Task");
  }
}
