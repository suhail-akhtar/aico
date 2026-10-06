package com.example.system.tasks.domain;

import com.example.system.shared.error.FieldViolation;
import com.example.system.shared.error.ValidationException;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import java.util.regex.Pattern;
import org.jspecify.annotations.Nullable;

/**
 * A task owned by one user. Plain Java: no JPA, no Spring, so the rules below are unit-testable
 * without a container. The constructor enforces the invariants, so an invalid {@code Task} cannot
 * exist, whether it was just created or rebuilt from a row.
 */
public record Task(
    UUID id,
    UUID ownerId,
    String title,
    @Nullable String description,
    TaskStatus status,
    @Nullable String assigneeEmail,
    Instant createdAt,
    Instant updatedAt,
    long version) {

  public static final int TITLE_MAX = 120;
  public static final int DESCRIPTION_MAX = 2000;
  public static final int EMAIL_MAX = 254;
  private static final Pattern EMAIL = Pattern.compile("[^@\\s]+@[^@\\s]+\\.[^@\\s]+");

  public Task {
    title = title.strip();
    assigneeEmail = assigneeEmail == null || assigneeEmail.isBlank() ? null : assigneeEmail.strip();
    List<FieldViolation> violations = new ArrayList<>();
    if (title.isEmpty()) {
      violations.add(new FieldViolation("title", "must not be blank"));
    } else if (title.length() > TITLE_MAX) {
      violations.add(new FieldViolation("title", "must be at most " + TITLE_MAX + " characters"));
    } else if (hasControlCharacters(title, false)) {
      violations.add(new FieldViolation("title", "must not contain control characters"));
    }
    if (description != null && description.length() > DESCRIPTION_MAX) {
      violations.add(
          new FieldViolation("description", "must be at most " + DESCRIPTION_MAX + " characters"));
    }
    if (description != null && hasControlCharacters(description, true)) {
      violations.add(new FieldViolation("description", "must not contain control characters"));
    }
    if (assigneeEmail != null
        && (assigneeEmail.length() > EMAIL_MAX
            || !EMAIL.matcher(assigneeEmail).matches()
            || hasControlCharacters(assigneeEmail, false))) {
      violations.add(new FieldViolation("assigneeEmail", "must be a valid email address"));
    }
    if (!violations.isEmpty()) {
      throw new ValidationException(violations);
    }
  }

  /**
   * Control characters (NUL above all) are never legitimate in these fields, PostgreSQL refuses NUL
   * outright, and a line break in a title or address would let a value forge a mail header. A
   * description may keep line breaks and tabs.
   */
  private static boolean hasControlCharacters(String value, boolean allowWhitespace) {
    return value
        .chars()
        .anyMatch(
            c -> Character.isISOControl(c) && !(allowWhitespace && (c == 10 || c == 13 || c == 9)));
  }

  /** A new open task. Its version is assigned by the store on first save. */
  public static Task create(
      UUID ownerId,
      String title,
      @Nullable String description,
      @Nullable String assigneeEmail,
      Instant now) {
    return new Task(
        UUID.randomUUID(),
        ownerId,
        title,
        description,
        TaskStatus.OPEN,
        assigneeEmail,
        now,
        now,
        0L);
  }

  /** The same task with new content and a fresh modification time. */
  public Task withDetails(
      String newTitle, @Nullable String newDescription, @Nullable String newAssignee, Instant now) {
    return new Task(
        id, ownerId, newTitle, newDescription, status, newAssignee, createdAt, now, version);
  }

  public Task complete(Instant now) {
    return new Task(
        id, ownerId, title, description, TaskStatus.DONE, assigneeEmail, createdAt, now, version);
  }

  public boolean isDone() {
    return status == TaskStatus.DONE;
  }
}
