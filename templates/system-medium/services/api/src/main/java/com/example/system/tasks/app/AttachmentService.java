package com.example.system.tasks.app;

import com.example.system.identity.AuthenticatedUser;
import com.example.system.shared.config.AppProperties;
import com.example.system.shared.error.ConflictException;
import com.example.system.shared.error.FieldViolation;
import com.example.system.shared.error.ForbiddenException;
import com.example.system.shared.error.NotFoundException;
import com.example.system.shared.error.UnavailableException;
import com.example.system.shared.error.ValidationException;
import com.example.system.shared.flags.FeatureFlags;
import com.example.system.shared.storage.ObjectStore;
import com.example.system.tasks.domain.Attachment;
import com.example.system.tasks.domain.AttachmentRepository;
import com.example.system.tasks.domain.Task;
import com.example.system.tasks.domain.TaskRepository;
import java.io.IOException;
import java.io.InputStream;
import java.time.Clock;
import java.time.temporal.ChronoUnit;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * File attachments on a task. The metadata is a database row, the bytes are an object in the store,
 * and the two are written in an order that never leaves a row without bytes: bytes first, then the
 * row, and a failed row insert removes the bytes again. A feature flag can switch uploads off
 * without a deployment. Everything about the file that came from the client (name, type, size) is
 * validated or discarded: the stored key is built from ids only, and the type must be on a short
 * allow-list so the store cannot be used to host arbitrary active content.
 */
@Service
@Transactional
public class AttachmentService {

  private static final Logger LOG = LoggerFactory.getLogger(AttachmentService.class);
  static final int MAX_PER_TASK = 5;
  static final int NAME_MAX = 200;
  static final Set<String> ALLOWED_TYPES =
      Set.of("image/png", "image/jpeg", "image/gif", "image/webp", "application/pdf", "text/plain");

  /** An attachment ready to stream: metadata plus an open stream the caller must close. */
  public record Download(Attachment attachment, InputStream content) {}

  private final TaskRepository tasks;
  private final AttachmentRepository attachments;
  private final ObjectStore store;
  private final FeatureFlags flags;
  private final AppProperties props;
  private final Clock clock;

  public AttachmentService(
      TaskRepository tasks,
      AttachmentRepository attachments,
      ObjectStore store,
      FeatureFlags flags,
      AppProperties props,
      Clock clock) {
    this.tasks = tasks;
    this.attachments = attachments;
    this.store = store;
    this.flags = flags;
    this.props = props;
    this.clock = clock;
  }

  @Transactional(readOnly = true)
  public List<Attachment> list(AuthenticatedUser actor, UUID taskId) {
    ownedTask(actor, taskId);
    return attachments.findByTask(taskId);
  }

  public Attachment add(
      AuthenticatedUser actor,
      UUID taskId,
      String fileName,
      String contentType,
      long size,
      InputStream content) {
    if (!flags.enabled(
        FeatureFlags.ATTACHMENTS_ENABLED,
        FeatureFlags.contextFor(actor.id().toString(), actor.email(), actor.roles()))) {
      throw new ForbiddenException("feature_disabled", "Attachments are switched off.");
    }
    ownedTask(actor, taskId);
    String type = contentType.toLowerCase(Locale.ROOT).strip();
    validate(size, type);
    if (attachments.countByTask(taskId) >= MAX_PER_TASK) {
      throw new ConflictException(
          "attachment_limit_reached", "A task can have at most " + MAX_PER_TASK + " attachments.");
    }
    UUID id = UUID.randomUUID();
    String key = "tasks/" + taskId + "/" + id;
    try {
      store.put(key, content, size, type);
    } catch (IOException e) {
      LOG.warn("Object store write failed: {}", e.getClass().getSimpleName());
      throw new UnavailableException("storage_unavailable", "File storage is not available.");
    }
    try {
      return attachments.insert(
          new Attachment(
              id,
              taskId,
              cleanName(fileName),
              type,
              size,
              key,
              clock.instant().truncatedTo(ChronoUnit.MICROS)));
    } catch (RuntimeException e) {
      discard(key);
      throw e;
    }
  }

  /** Opens an attachment for download. The caller must close the returned stream. */
  @Transactional(readOnly = true)
  public Download open(AuthenticatedUser actor, UUID taskId, UUID attachmentId) {
    ownedTask(actor, taskId);
    Attachment attachment =
        attachments
            .findByIdAndTask(attachmentId, taskId)
            .orElseThrow(() -> new NotFoundException("Attachment"));
    try {
      return new Download(attachment, store.get(attachment.objectKey()));
    } catch (IOException e) {
      LOG.warn("Object store read failed: {}", e.getClass().getSimpleName());
      throw new UnavailableException("storage_unavailable", "File storage is not available.");
    }
  }

  public void delete(AuthenticatedUser actor, UUID taskId, UUID attachmentId) {
    ownedTask(actor, taskId);
    Attachment attachment =
        attachments
            .findByIdAndTask(attachmentId, taskId)
            .orElseThrow(() -> new NotFoundException("Attachment"));
    try {
      store.delete(attachment.objectKey());
    } catch (IOException e) {
      LOG.warn("Object store delete failed: {}", e.getClass().getSimpleName());
      throw new UnavailableException("storage_unavailable", "File storage is not available.");
    }
    attachments.deleteByIdAndTask(attachmentId, taskId);
  }

  /** Called by the task service before a task is deleted: no object may outlive its row. */
  void removeAllObjects(UUID taskId) {
    for (Attachment attachment : attachments.findByTask(taskId)) {
      try {
        store.delete(attachment.objectKey());
      } catch (IOException e) {
        LOG.warn("Object store delete failed: {}", e.getClass().getSimpleName());
        throw new UnavailableException("storage_unavailable", "File storage is not available.");
      }
    }
  }

  private Task ownedTask(AuthenticatedUser actor, UUID taskId) {
    return tasks
        .findByIdAndOwner(taskId, actor.id())
        .orElseThrow(() -> new NotFoundException("Task"));
  }

  private void validate(long size, String type) {
    long max = props.http().maxUploadSize().toBytes();
    if (size < 1 || size > max) {
      throw new ValidationException(
          List.of(new FieldViolation("body", "must be between 1 byte and " + max + " bytes")));
    }
    if (!ALLOWED_TYPES.contains(type)) {
      throw new ValidationException(
          List.of(
              new FieldViolation(
                  "contentType",
                  "must be one of "
                      + String.join(", ", ALLOWED_TYPES.stream().sorted().toList()))));
    }
  }

  /**
   * The name is only ever shown to people and sent back in a download header, never used as a path,
   * but it is still reduced to a plain file name: directory parts, control characters and quotes
   * go.
   */
  static String cleanName(String raw) {
    String name = raw.replace('\\', '/');
    name = name.substring(name.lastIndexOf('/') + 1);
    name = name.replaceAll("[\\p{Cntrl}\"<>:|?*]", "_").strip();
    if (name.isEmpty() || name.equals(".") || name.equals("..")) {
      name = "file";
    }
    return name.length() <= NAME_MAX ? name : name.substring(0, NAME_MAX);
  }

  private void discard(String key) {
    try {
      store.delete(key);
    } catch (IOException e) {
      LOG.warn("Could not remove orphaned object after a failed insert");
    }
  }
}
