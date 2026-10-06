package com.example.system.tasks.infra;

import com.example.system.shared.error.NotFoundException;
import com.example.system.shared.page.PageQuery;
import com.example.system.shared.page.PageResult;
import com.example.system.tasks.domain.Task;
import com.example.system.tasks.domain.TaskRepository;
import com.example.system.tasks.domain.TaskStatus;
import java.util.Objects;
import java.util.Optional;
import java.util.UUID;
import org.jspecify.annotations.Nullable;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.PageRequest;
import org.springframework.data.domain.Sort;
import org.springframework.stereotype.Repository;
import org.springframework.transaction.annotation.Transactional;

/** Adapter: implements the domain port {@link TaskRepository} with Spring Data JPA. */
@Repository
class TaskRepositoryAdapter implements TaskRepository {

  /** Newest first; the id breaks ties so paging is stable. */
  private static final Sort NEWEST_FIRST =
      Sort.by(Sort.Order.desc("createdAt"), Sort.Order.asc("id"));

  private final TaskJpaRepository jpa;

  TaskRepositoryAdapter(TaskJpaRepository jpa) {
    this.jpa = jpa;
  }

  @Override
  public Task insert(Task task) {
    TaskEntity entity =
        new TaskEntity(
            task.id(),
            task.ownerId(),
            task.title(),
            task.description(),
            task.status(),
            task.assigneeEmail(),
            task.createdAt(),
            task.updatedAt());
    return toDomain(jpa.saveAndFlush(entity));
  }

  @Override
  public Optional<Task> findByIdAndOwner(UUID id, UUID ownerId) {
    return jpa.findByIdAndOwnerId(id, ownerId).map(TaskRepositoryAdapter::toDomain);
  }

  @Override
  public Task update(Task task) {
    TaskEntity entity =
        jpa.findByIdAndOwnerId(task.id(), task.ownerId())
            .orElseThrow(() -> new NotFoundException("Task"));
    entity.change(
        task.title(), task.description(), task.status(), task.assigneeEmail(), task.updatedAt());
    return toDomain(jpa.saveAndFlush(entity));
  }

  @Override
  @Transactional
  public boolean deleteByIdAndOwner(UUID id, UUID ownerId) {
    return jpa.deleteByIdAndOwnerId(id, ownerId) > 0;
  }

  @Override
  public PageResult<Task> findByOwner(
      UUID ownerId, @Nullable TaskStatus status, @Nullable String titleContains, PageQuery query) {
    PageRequest request = PageRequest.of(query.page(), query.size(), NEWEST_FIRST);
    Page<TaskEntity> page;
    if (status == null && titleContains == null) {
      page = jpa.findByOwnerId(ownerId, request);
    } else if (titleContains == null) {
      page = jpa.findByOwnerIdAndStatus(ownerId, Objects.requireNonNull(status), request);
    } else if (status == null) {
      page = jpa.findByOwnerIdAndTitleContainingIgnoreCase(ownerId, titleContains, request);
    } else {
      page =
          jpa.findByOwnerIdAndStatusAndTitleContainingIgnoreCase(
              ownerId, status, titleContains, request);
    }
    return toResult(page, query);
  }

  @Override
  public long countByOwnerAndStatus(UUID ownerId, TaskStatus status) {
    return jpa.countByOwnerIdAndStatus(ownerId, status);
  }

  @Override
  public PageResult<Task> findAll(PageQuery query) {
    return toResult(jpa.findAll(PageRequest.of(query.page(), query.size(), NEWEST_FIRST)), query);
  }

  private static PageResult<Task> toResult(Page<TaskEntity> page, PageQuery query) {
    return PageResult.of(
        page.getContent().stream().map(TaskRepositoryAdapter::toDomain).toList(),
        query,
        page.getTotalElements());
  }

  private static Task toDomain(TaskEntity e) {
    return new Task(
        e.getId(),
        e.getOwnerId(),
        e.getTitle(),
        e.getDescription(),
        e.getStatus(),
        e.getAssigneeEmail(),
        e.getCreatedAt(),
        e.getUpdatedAt(),
        e.getVersion());
  }
}
