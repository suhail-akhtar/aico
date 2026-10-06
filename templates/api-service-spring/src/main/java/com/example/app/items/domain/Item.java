package com.example.app.items.domain;

import com.example.app.shared.error.FieldViolation;
import com.example.app.shared.error.ValidationException;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import org.jspecify.annotations.Nullable;

/**
 * An item owned by one user. Plain Java: no JPA, no Spring, so the rules below are unit-testable
 * without a container and survive a change of persistence technology. The constructor enforces the
 * invariants, which means an invalid {@code Item} cannot exist, whether it was just created or
 * rebuilt from a database row.
 */
public record Item(
    UUID id,
    UUID ownerId,
    String name,
    @Nullable String description,
    int quantity,
    Instant createdAt,
    Instant updatedAt,
    long version) {

  public static final int NAME_MAX = 120;
  public static final int DESCRIPTION_MAX = 2000;
  public static final int QUANTITY_MAX = 1_000_000;

  public Item {
    name = name.strip();
    List<FieldViolation> violations = new ArrayList<>();
    if (name.isEmpty()) {
      violations.add(new FieldViolation("name", "must not be blank"));
    } else if (name.length() > NAME_MAX) {
      violations.add(new FieldViolation("name", "must be at most " + NAME_MAX + " characters"));
    } else if (hasControlCharacters(name, false)) {
      violations.add(new FieldViolation("name", "must not contain control characters"));
    }
    if (description != null && description.length() > DESCRIPTION_MAX) {
      violations.add(
          new FieldViolation("description", "must be at most " + DESCRIPTION_MAX + " characters"));
    }
    if (description != null && hasControlCharacters(description, true)) {
      violations.add(new FieldViolation("description", "must not contain control characters"));
    }
    if (quantity < 0 || quantity > QUANTITY_MAX) {
      violations.add(new FieldViolation("quantity", "must be between 0 and " + QUANTITY_MAX));
    }
    if (!violations.isEmpty()) {
      throw new ValidationException(violations);
    }
  }

  /**
   * Control characters (NUL above all) are never legitimate in these fields and PostgreSQL refuses
   * NUL outright, which would surface as a confusing database error. A description may keep line
   * breaks and tabs.
   */
  private static boolean hasControlCharacters(String value, boolean allowWhitespace) {
    return value
        .chars()
        .anyMatch(
            c -> Character.isISOControl(c) && !(allowWhitespace && (c == 10 || c == 13 || c == 9)));
  }

  /** A brand-new item. Its version is assigned by the store on first save. */
  public static Item create(
      UUID ownerId, String name, @Nullable String description, int quantity, Instant now) {
    return new Item(UUID.randomUUID(), ownerId, name, description, quantity, now, now, 0L);
  }

  /** The same item with new content and a fresh modification time. */
  public Item withDetails(
      String newName, @Nullable String newDescription, int newQuantity, Instant now) {
    return new Item(id, ownerId, newName, newDescription, newQuantity, createdAt, now, version);
  }
}
