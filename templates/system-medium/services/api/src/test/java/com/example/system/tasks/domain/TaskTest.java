package com.example.system.tasks.domain;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.example.system.shared.error.FieldViolation;
import com.example.system.shared.error.ValidationException;
import java.time.Instant;
import java.util.UUID;
import org.junit.jupiter.api.Test;

/** The rules that hold for every task however it was made. No Spring, no database. */
class TaskTest {

  private static final Instant NOW = Instant.parse("2026-10-06T10:00:00Z");
  private static final UUID OWNER = UUID.randomUUID();

  private static Task make(String title, String description, String assignee) {
    return Task.create(OWNER, title, description, assignee, NOW);
  }

  private static java.util.List<FieldViolation> violations(Runnable action) {
    try {
      action.run();
    } catch (ValidationException e) {
      return e.violations();
    }
    return java.util.List.of();
  }

  @Test
  void aNewTaskIsOpenAndTrimmed() {
    Task task = make("  Write the report  ", null, "  bob@example.com ");

    assertThat(task.title()).isEqualTo("Write the report");
    assertThat(task.assigneeEmail()).isEqualTo("bob@example.com");
    assertThat(task.status()).isEqualTo(TaskStatus.OPEN);
    assertThat(task.isDone()).isFalse();
    assertThat(task.version()).isZero();
  }

  @Test
  void aBlankAssigneeMeansNoAssignee() {
    assertThat(make("t", null, "   ").assigneeEmail()).isNull();
  }

  @Test
  void aBlankTitleIsRejected() {
    assertThat(violations(() -> make("   ", null, null)))
        .extracting(FieldViolation::field)
        .containsExactly("title");
  }

  @Test
  void aTooLongTitleIsRejected() {
    assertThat(violations(() -> make("x".repeat(Task.TITLE_MAX + 1), null, null)))
        .extracting(FieldViolation::field)
        .containsExactly("title");
    assertThat(make("x".repeat(Task.TITLE_MAX), null, null).title()).hasSize(Task.TITLE_MAX);
  }

  @Test
  void controlCharactersAreRejectedInTheTitleButNewlinesSurviveInTheDescription() {
    assertThat(violations(() -> make("a\u0000b", null, null))).isNotEmpty();
    assertThat(violations(() -> make("a\nb", null, null))).isNotEmpty();
    assertThat(violations(() -> make("t", "line one\nline two\tindented", null))).isEmpty();
    assertThat(violations(() -> make("t", "bad\u0000nul", null))).isNotEmpty();
  }

  @Test
  void aTooLongDescriptionIsRejected() {
    assertThat(violations(() -> make("t", "d".repeat(Task.DESCRIPTION_MAX + 1), null)))
        .extracting(FieldViolation::field)
        .containsExactly("description");
  }

  @Test
  void anAssigneeMustLookLikeAnEmailAddressAndCannotCarryAHeaderInjection() {
    assertThat(violations(() -> make("t", null, "not-an-email"))).isNotEmpty();
    assertThat(violations(() -> make("t", null, "a@b"))).isNotEmpty();
    assertThat(violations(() -> make("t", null, "bob@example.com\nBcc: evil@example.com")))
        .isNotEmpty();
    assertThat(violations(() -> make("t", null, "a b@example.com"))).isNotEmpty();
    assertThat(violations(() -> make("t", null, "x".repeat(250) + "@example.com"))).isNotEmpty();
  }

  @Test
  void everyViolationIsReportedAtOnce() {
    assertThat(violations(() -> make("", "d".repeat(Task.DESCRIPTION_MAX + 1), "nope")))
        .extracting(FieldViolation::field)
        .containsExactlyInAnyOrder("title", "description", "assigneeEmail");
  }

  @Test
  void completeKeepsContentAndMovesTheTimestamp() {
    Task done = make("t", "d", "bob@example.com").complete(NOW.plusSeconds(5));

    assertThat(done.isDone()).isTrue();
    assertThat(done.title()).isEqualTo("t");
    assertThat(done.updatedAt()).isEqualTo(NOW.plusSeconds(5));
    assertThat(done.createdAt()).isEqualTo(NOW);
  }

  @Test
  void withDetailsRevalidates() {
    Task task = make("t", null, null);

    assertThat(task.withDetails("new", "desc", "a@example.com", NOW).title()).isEqualTo("new");
    assertThatThrownBy(() -> task.withDetails("", null, null, NOW))
        .isInstanceOf(ValidationException.class);
  }
}
