package com.example.app.items.api;

import com.example.app.items.domain.Item;
import java.time.Instant;
import java.util.UUID;
import org.jspecify.annotations.Nullable;

/**
 * What the API returns for an item. The owner id is not exposed: callers only ever see their own.
 * JSON names are snake_case ({@code created_at}), applied once by the Jackson naming strategy in
 * {@code application.properties} rather than per field.
 */
public record ItemResponse(
    UUID id,
    String name,
    @Nullable String description,
    int quantity,
    Instant createdAt,
    Instant updatedAt,
    long version) {

  static ItemResponse from(Item item) {
    return new ItemResponse(
        item.id(),
        item.name(),
        item.description(),
        item.quantity(),
        item.createdAt(),
        item.updatedAt(),
        item.version());
  }
}
