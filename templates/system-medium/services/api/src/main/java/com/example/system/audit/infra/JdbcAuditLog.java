package com.example.system.audit.infra;

import com.example.system.audit.domain.AuditEntry;
import com.example.system.audit.domain.AuditLog;
import com.example.system.shared.page.PageQuery;
import com.example.system.shared.page.PageResult;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.List;
import java.util.UUID;
import org.jspecify.annotations.Nullable;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;

/**
 * Adapter: plain SQL over the {@code audit_log} table. Appending requires an existing transaction
 * ({@code MANDATORY}), because an audit row written outside the transaction of the change it
 * describes could outlive a rollback or be missing after a commit.
 */
@Repository
class JdbcAuditLog implements AuditLog {

  private final JdbcClient jdbc;

  JdbcAuditLog(JdbcClient jdbc) {
    this.jdbc = jdbc;
  }

  @Override
  @Transactional(propagation = Propagation.MANDATORY)
  public void append(
      Instant occurredAt,
      UUID actorId,
      String actorLabel,
      String action,
      String targetType,
      String targetId,
      String detailJson,
      @Nullable String requestId) {
    jdbc.sql(
            """
            insert into audit_log
              (occurred_at, actor_id, actor_label, action, target_type, target_id, detail, request_id)
            values
              (:at, :actor, :label, :action, :type, :target, cast(:detail as jsonb), :request)
            """)
        .param("at", Timestamp.from(occurredAt))
        .param("actor", actorId)
        .param("label", actorLabel)
        .param("action", action)
        .param("type", targetType)
        .param("target", targetId)
        .param("detail", detailJson)
        .param("request", requestId)
        .update();
  }

  @Override
  @Transactional(readOnly = true)
  public PageResult<AuditEntry> page(PageQuery query) {
    long total = jdbc.sql("select count(*) from audit_log").query(Long.class).single();
    List<AuditEntry> rows =
        jdbc.sql(
                """
                select id, occurred_at, actor_id, actor_label, action, target_type, target_id,
                       detail::text as detail, request_id
                from audit_log
                order by id desc
                limit :limit offset :offset
                """)
            .param("limit", query.size())
            .param("offset", (long) query.page() * query.size())
            .query(
                (rs, n) ->
                    new AuditEntry(
                        rs.getLong("id"),
                        rs.getTimestamp("occurred_at").toInstant(),
                        rs.getObject("actor_id", UUID.class),
                        rs.getString("actor_label"),
                        rs.getString("action"),
                        rs.getString("target_type"),
                        rs.getString("target_id"),
                        rs.getString("detail"),
                        rs.getString("request_id")))
            .list();
    return PageResult.of(rows, query, total);
  }
}
