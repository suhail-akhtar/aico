package com.example.system.tasks.domain;

import java.time.Instant;
import java.util.UUID;

/**
 * File metadata. The bytes live in object storage under {@code objectKey}, which is derived from
 * ids, never from the file name, so a hostile name cannot choose where bytes go.
 */
public record Attachment(
    UUID id,
    UUID taskId,
    String fileName,
    String contentType,
    long sizeBytes,
    String objectKey,
    Instant createdAt) {}
