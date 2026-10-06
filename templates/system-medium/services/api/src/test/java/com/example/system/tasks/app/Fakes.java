package com.example.system.tasks.app;

import com.example.system.shared.error.NotFoundException;
import com.example.system.shared.flags.FeatureFlags;
import com.example.system.shared.page.PageQuery;
import com.example.system.shared.page.PageResult;
import com.example.system.tasks.domain.Attachment;
import com.example.system.tasks.domain.AttachmentRepository;
import com.example.system.tasks.domain.Task;
import com.example.system.tasks.domain.TaskRepository;
import com.example.system.tasks.domain.TaskStatus;
import dev.openfeature.sdk.OpenFeatureAPI;
import dev.openfeature.sdk.providers.memory.Flag;
import dev.openfeature.sdk.providers.memory.InMemoryProvider;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.function.Supplier;
import org.jspecify.annotations.Nullable;

/** In-memory stand-ins for the repository ports, so the use cases are tested without a database. */
final class Fakes {

  private Fakes() {}

  /** A flag service with the given values, isolated in its own OpenFeature domain. */
  static FeatureFlags flags(String domain, Map<String, Object> values) {
    Map<String, Flag<?>> flags = new ConcurrentHashMap<>();
    FeatureFlags.DEFAULTS.forEach(
        (key, value) ->
            flags.put(
                key,
                Flag.builder()
                    .variant("v", values.getOrDefault(key, value))
                    .defaultVariant("v")
                    .build()));
    OpenFeatureAPI api = OpenFeatureAPI.getInstance();
    api.setProviderAndWait(domain, new InMemoryProvider(flags));
    return new FeatureFlags(api.getClient(domain));
  }

  static final class Tasks implements TaskRepository {
    final Map<UUID, Task> rows = new ConcurrentHashMap<>();

    @Override
    public Task insert(Task task) {
      rows.put(task.id(), task);
      return task;
    }

    @Override
    public Optional<Task> findByIdAndOwner(UUID id, UUID ownerId) {
      return Optional.ofNullable(rows.get(id)).filter(t -> t.ownerId().equals(ownerId));
    }

    @Override
    public Task update(Task task) {
      if (!rows.containsKey(task.id())) {
        throw new NotFoundException("Task");
      }
      Task bumped =
          new Task(
              task.id(),
              task.ownerId(),
              task.title(),
              task.description(),
              task.status(),
              task.assigneeEmail(),
              task.createdAt(),
              task.updatedAt(),
              task.version() + 1);
      rows.put(task.id(), bumped);
      return bumped;
    }

    @Override
    public boolean deleteByIdAndOwner(UUID id, UUID ownerId) {
      return findByIdAndOwner(id, ownerId).isPresent() && rows.remove(id) != null;
    }

    @Override
    public PageResult<Task> findByOwner(
        UUID ownerId, @Nullable TaskStatus status, @Nullable String titleContains, PageQuery page) {
      List<Task> all =
          rows.values().stream()
              .filter(t -> t.ownerId().equals(ownerId))
              .filter(t -> status == null || t.status() == status)
              .filter(
                  t ->
                      titleContains == null
                          || t.title().toLowerCase().contains(titleContains.toLowerCase()))
              .sorted(Comparator.comparing(Task::createdAt).reversed())
              .toList();
      return PageResult.of(all, page, all.size());
    }

    @Override
    public long countByOwnerAndStatus(UUID ownerId, TaskStatus status) {
      return rows.values().stream()
          .filter(t -> t.ownerId().equals(ownerId) && t.status() == status)
          .count();
    }

    @Override
    public PageResult<Task> findAll(PageQuery page) {
      List<Task> all = new ArrayList<>(rows.values());
      return PageResult.of(all, page, all.size());
    }
  }

  static final class Attachments implements AttachmentRepository {
    final Map<UUID, Attachment> rows = new ConcurrentHashMap<>();
    @Nullable Supplier<RuntimeException> failInsert;

    @Override
    public Attachment insert(Attachment attachment) {
      if (failInsert != null) {
        throw failInsert.get();
      }
      rows.put(attachment.id(), attachment);
      return attachment;
    }

    @Override
    public List<Attachment> findByTask(UUID taskId) {
      return rows.values().stream().filter(a -> a.taskId().equals(taskId)).toList();
    }

    @Override
    public Optional<Attachment> findByIdAndTask(UUID id, UUID taskId) {
      return Optional.ofNullable(rows.get(id)).filter(a -> a.taskId().equals(taskId));
    }

    @Override
    public long countByTask(UUID taskId) {
      return findByTask(taskId).size();
    }

    @Override
    public boolean deleteByIdAndTask(UUID id, UUID taskId) {
      return findByIdAndTask(id, taskId).isPresent() && rows.remove(id) != null;
    }
  }

  static Instant at() {
    return Instant.parse("2026-10-06T10:00:00Z");
  }
}
