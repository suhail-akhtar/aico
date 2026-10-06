package com.example.system.tasks.infra;

import com.example.system.tasks.domain.TaskStatus;
import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.EnumType;
import jakarta.persistence.Enumerated;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
import jakarta.persistence.Version;
import java.time.Instant;
import java.util.UUID;
import org.jspecify.annotations.Nullable;

/**
 * Persistence shape of a task. It stays inside {@code infra}: the rest of the application sees
 * {@link com.example.system.tasks.domain.Task}. The owner is a plain id, not a JPA association, so
 * this module does not reach into the identity module tables (the foreign key lives in SQL).
 */
@Entity
@Table(name = "tasks")
class TaskEntity {

  @Id private UUID id;

  @Column(name = "owner_id", nullable = false, updatable = false)
  private UUID ownerId;

  @Column(nullable = false, length = 120)
  private String title;

  @Column(length = 2000)
  private @Nullable String description;

  @Enumerated(EnumType.STRING)
  @Column(nullable = false, length = 16)
  private TaskStatus status;

  @Column(name = "assignee_email", length = 254)
  private @Nullable String assigneeEmail;

  @Column(name = "created_at", nullable = false, updatable = false)
  private Instant createdAt;

  @Column(name = "updated_at", nullable = false)
  private Instant updatedAt;

  /** Optimistic lock. Null until the first insert so Spring Data knows the row is new. */
  @Version private @Nullable Long version;

  /** Required by JPA. */
  protected TaskEntity() {}

  TaskEntity(
      UUID id,
      UUID ownerId,
      String title,
      @Nullable String description,
      TaskStatus status,
      @Nullable String assigneeEmail,
      Instant createdAt,
      Instant updatedAt) {
    this.id = id;
    this.ownerId = ownerId;
    this.title = title;
    this.description = description;
    this.status = status;
    this.assigneeEmail = assigneeEmail;
    this.createdAt = createdAt;
    this.updatedAt = updatedAt;
  }

  UUID getId() {
    return id;
  }

  UUID getOwnerId() {
    return ownerId;
  }

  String getTitle() {
    return title;
  }

  @Nullable String getDescription() {
    return description;
  }

  TaskStatus getStatus() {
    return status;
  }

  @Nullable String getAssigneeEmail() {
    return assigneeEmail;
  }

  Instant getCreatedAt() {
    return createdAt;
  }

  Instant getUpdatedAt() {
    return updatedAt;
  }

  long getVersion() {
    return version == null ? 0L : version;
  }

  void change(
      String newTitle,
      @Nullable String newDescription,
      TaskStatus newStatus,
      @Nullable String newAssignee,
      Instant now) {
    this.title = newTitle;
    this.description = newDescription;
    this.status = newStatus;
    this.assigneeEmail = newAssignee;
    this.updatedAt = now;
  }
}
