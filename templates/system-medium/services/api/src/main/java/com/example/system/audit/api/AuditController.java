package com.example.system.audit.api;

import com.example.system.audit.domain.AuditEntry;
import com.example.system.audit.domain.AuditLog;
import com.example.system.shared.page.PageQuery;
import com.example.system.shared.page.PageResult;
import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.responses.ApiResponse;
import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import java.time.Instant;
import java.util.UUID;
import org.jspecify.annotations.Nullable;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

/** Read-only access to the audit trail, for administrators (URL rule and method security). */
@RestController
@RequestMapping("/api/v1/admin/audit")
public class AuditController {

  /** One audit line as JSON; {@code detail} is a nested object, not an escaped string. */
  public record AuditResponse(
      long id,
      Instant occurredAt,
      UUID actorId,
      String actorLabel,
      String action,
      String targetType,
      String targetId,
      JsonNode detail,
      @Nullable String requestId) {}

  private final AuditLog log;
  private final JsonMapper json;

  public AuditController(AuditLog log, JsonMapper json) {
    this.log = log;
    this.json = json;
  }

  @Operation(summary = "The audit trail, newest first (administrators only)")
  @ApiResponse(responseCode = "403", description = "The caller is not an administrator")
  @PreAuthorize("hasRole('ADMIN')")
  @GetMapping
  public PageResult<AuditResponse> page(
      @RequestParam(defaultValue = "0") @Min(0) int page,
      @RequestParam(defaultValue = "20") @Min(1) @Max(PageQuery.MAX_SIZE) int size) {
    return log.page(new PageQuery(page, size)).map(this::view);
  }

  private AuditResponse view(AuditEntry e) {
    return new AuditResponse(
        e.id(),
        e.occurredAt(),
        e.actorId(),
        e.actorLabel(),
        e.action(),
        e.targetType(),
        e.targetId(),
        json.readTree(e.detail()),
        e.requestId());
  }
}
