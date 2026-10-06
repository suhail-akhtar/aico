package com.example.system.tasks.infra;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
import java.time.Instant;
import java.util.UUID;

/** Persistence shape of attachment metadata; immutable once written. */
@Entity
@Table(name = "task_attachments")
class AttachmentEntity {

  @Id private UUID id;

  @Column(name = "task_id", nullable = false, updatable = false)
  private UUID taskId;

  @Column(name = "file_name", nullable = false, updatable = false, length = 200)
  private String fileName;

  @Column(name = "content_type", nullable = false, updatable = false, length = 100)
  private String contentType;

  @Column(name = "size_bytes", nullable = false, updatable = false)
  private long sizeBytes;

  @Column(name = "object_key", nullable = false, updatable = false, length = 200)
  private String objectKey;

  @Column(name = "created_at", nullable = false, updatable = false)
  private Instant createdAt;

  /** Required by JPA. */
  protected AttachmentEntity() {}

  AttachmentEntity(
      UUID id,
      UUID taskId,
      String fileName,
      String contentType,
      long sizeBytes,
      String objectKey,
      Instant createdAt) {
    this.id = id;
    this.taskId = taskId;
    this.fileName = fileName;
    this.contentType = contentType;
    this.sizeBytes = sizeBytes;
    this.objectKey = objectKey;
    this.createdAt = createdAt;
  }

  UUID getId() {
    return id;
  }

  UUID getTaskId() {
    return taskId;
  }

  String getFileName() {
    return fileName;
  }

  String getContentType() {
    return contentType;
  }

  long getSizeBytes() {
    return sizeBytes;
  }

  String getObjectKey() {
    return objectKey;
  }

  Instant getCreatedAt() {
    return createdAt;
  }
}
