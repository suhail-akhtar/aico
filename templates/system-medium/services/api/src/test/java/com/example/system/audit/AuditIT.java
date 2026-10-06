package com.example.system.audit;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.example.system.support.IntegrationTest;
import com.example.system.tasks.domain.event.TaskCreated;
import java.time.Instant;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.context.ApplicationEventPublisher;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.transaction.support.TransactionTemplate;
import tools.jackson.databind.JsonNode;

/** The audit trail: complete, atomic with the change, readable by admins, and immutable. */
class AuditIT extends IntegrationTest {

  @Autowired JdbcClient jdbc;
  @Autowired TransactionTemplate transaction;
  @Autowired ApplicationEventPublisher publisher;

  private long rowsFor(String taskId) {
    return jdbc.sql("select count(*) from audit_log where target_id = :id")
        .param("id", taskId)
        .query(Long.class)
        .single();
  }

  @Test
  void everyChangeToATaskLeavesOneAuditLineWithTheActorAndRequestContext() {
    var alice = newMember();
    var admin = newAdmin();
    String id =
        body(post(
                "/api/v1/tasks",
                alice,
                Map.of("title", "Audited", "assigneeEmail", "b@example.com")))
            .path("id")
            .asString();
    post("/api/v1/tasks/" + id + "/complete", alice, null);
    delete("/api/v1/tasks/" + id, alice);

    JsonNode page = body(get("/api/v1/admin/audit?size=100", admin));
    var lines = page.path("items");
    var mine = new java.util.ArrayList<JsonNode>();
    lines.forEach(
        line -> {
          if (line.path("targetId").asString().equals(id)) {
            mine.add(line);
          }
        });

    assertThat(mine)
        .extracting(l -> l.path("action").asString())
        .containsExactlyInAnyOrder(
            "task.created", "task.assigned", "task.completed", "task.deleted");
    assertThat(mine)
        .allSatisfy(
            l -> {
              assertThat(l.path("actorId").asString()).isEqualTo(alice.id().toString());
              assertThat(l.path("actorLabel").asString()).isEqualTo(alice.email());
              assertThat(l.path("targetType").asString()).isEqualTo("task");
              assertThat(l.path("detail").isObject()).isTrue();
            });
    JsonNode assigned =
        mine.stream()
            .filter(l -> l.path("action").asString().equals("task.assigned"))
            .findFirst()
            .orElseThrow();
    assertThat(assigned.path("detail").path("assigneeEmail").asString()).isEqualTo("b@example.com");
    assertThat(assigned.path("detail").path("title").asString()).isEqualTo("Audited");
  }

  @Test
  void aMemberCannotReadTheTrail() {
    assertProblem(get("/api/v1/admin/audit", newMember()), HttpStatus.FORBIDDEN, "forbidden");
  }

  @Test
  void auditLinesCannotBeUpdatedDeletedOrTruncatedNotEvenByTheApplicationUser() {
    String id = createTask(newMember(), "immutable");
    assertThat(rowsFor(id)).isEqualTo(1);

    assertThatThrownBy(
            () ->
                jdbc.sql("update audit_log set action = 'forged' where target_id = :id")
                    .param("id", id)
                    .update())
        .hasMessageContaining("append-only");
    assertThatThrownBy(
            () -> jdbc.sql("delete from audit_log where target_id = :id").param("id", id).update())
        .hasMessageContaining("append-only");
    assertThatThrownBy(() -> jdbc.sql("truncate audit_log").update())
        .hasMessageContaining("append-only");
    assertThat(rowsFor(id)).isEqualTo(1);
  }

  @Test
  void aRolledBackChangeLeavesNoAuditLineBecauseTheyShareATransaction() {
    UUID task = UUID.randomUUID();
    var event =
        new TaskCreated(
            UUID.randomUUID(), task, UUID.randomUUID(), "x@example.com", Instant.now(), "t");

    transaction.executeWithoutResult(
        status -> {
          publisher.publishEvent(event);
          assertThat(rowsFor(task.toString())).as("visible inside the transaction").isEqualTo(1);
          status.setRollbackOnly();
        });

    assertThat(rowsFor(task.toString())).isZero();
  }
}
