package com.example.system.tasks.domain;

import java.util.List;
import java.util.Optional;
import java.util.UUID;

/** Port for attachment metadata. Ownership is checked through the task, in the service. */
public interface AttachmentRepository {

  Attachment insert(Attachment attachment);

  List<Attachment> findByTask(UUID taskId);

  Optional<Attachment> findByIdAndTask(UUID id, UUID taskId);

  long countByTask(UUID taskId);

  /** Returns false when the task has no such attachment. */
  boolean deleteByIdAndTask(UUID id, UUID taskId);
}
