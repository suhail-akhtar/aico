package com.example.system.tasks.api;

import com.example.system.tasks.domain.Attachment;
import java.time.Instant;
import java.util.UUID;

/** The JSON shape of attachment metadata. The storage key is internal and never exposed. */
public record AttachmentResponse(
    UUID id, String fileName, String contentType, long sizeBytes, Instant createdAt) {

  static AttachmentResponse from(Attachment attachment) {
    return new AttachmentResponse(
        attachment.id(),
        attachment.fileName(),
        attachment.contentType(),
        attachment.sizeBytes(),
        attachment.createdAt());
  }
}
