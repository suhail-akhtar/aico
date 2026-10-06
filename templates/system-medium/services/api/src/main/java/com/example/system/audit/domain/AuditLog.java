package com.example.system.audit.domain;

import com.example.system.shared.page.PageQuery;
import com.example.system.shared.page.PageResult;
import java.time.Instant;
import java.util.UUID;
import org.jspecify.annotations.Nullable;

/**
 * Port: append a line, read lines. There is deliberately no update and no delete: the audit trail
 * is write-once, and the database enforces that too.
 */
public interface AuditLog {

  void append(
      Instant occurredAt,
      UUID actorId,
      String actorLabel,
      String action,
      String targetType,
      String targetId,
      String detailJson,
      @Nullable String requestId);

  /** Newest first. */
  PageResult<AuditEntry> page(PageQuery query);
}
