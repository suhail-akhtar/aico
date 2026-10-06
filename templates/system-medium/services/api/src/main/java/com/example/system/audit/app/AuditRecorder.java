package com.example.system.audit.app;

import com.example.system.audit.domain.AuditLog;
import com.example.system.shared.web.RequestIdFilter;
import com.example.system.tasks.domain.event.TaskAssigned;
import com.example.system.tasks.domain.event.TaskCompleted;
import com.example.system.tasks.domain.event.TaskCreated;
import com.example.system.tasks.domain.event.TaskDeleted;
import com.example.system.tasks.domain.event.TaskEvent;
import java.util.LinkedHashMap;
import java.util.Map;
import org.slf4j.MDC;
import org.springframework.context.event.EventListener;
import org.springframework.stereotype.Component;
import tools.jackson.databind.json.JsonMapper;

/**
 * Writes one audit line per task event. It is a plain synchronous {@code @EventListener}, not an
 * {@code @ApplicationModuleListener}: it must run inside the publisher transaction so the audit row
 * commits or rolls back with the change. If this method throws, the change is refused, which is the
 * right trade for an audit trail (no unaudited changes).
 */
@Component
class AuditRecorder {

  private final AuditLog log;
  private final JsonMapper json;

  AuditRecorder(AuditLog log, JsonMapper json) {
    this.log = log;
    this.json = json;
  }

  @EventListener
  void on(TaskEvent event) {
    Map<String, Object> detail = new LinkedHashMap<>();
    switch (event) {
      case TaskCreated e -> detail.put("title", e.title());
      case TaskAssigned e -> {
        detail.put("title", e.title());
        detail.put("assigneeEmail", e.assigneeEmail());
      }
      case TaskCompleted e -> detail.put("title", e.title());
      case TaskDeleted e -> {
        // Nothing beyond the id: the task is gone.
      }
    }
    log.append(
        event.occurredAt(),
        event.actorId(),
        event.actorLabel(),
        event.type(),
        "task",
        event.taskId().toString(),
        json.writeValueAsString(detail),
        MDC.get(RequestIdFilter.MDC_KEY));
  }
}
