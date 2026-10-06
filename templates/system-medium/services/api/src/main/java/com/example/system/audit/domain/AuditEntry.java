package com.example.system.audit.domain;

import java.time.Instant;
import java.util.UUID;
import org.jspecify.annotations.Nullable;

/**
 * One line of the audit trail. {@code detail} is a small JSON object with what a reader needs (a
 * title, an assignee); it is written once and never changed. {@code requestId} ties the line to the
 * request logs and the trace.
 */
public record AuditEntry(
    long id,
    Instant occurredAt,
    UUID actorId,
    String actorLabel,
    String action,
    String targetType,
    String targetId,
    String detail,
    @Nullable String requestId) {}
