package com.example.app.items.domain;

import com.example.app.shared.page.CursorPage;
import com.example.app.shared.page.PageQuery;
import java.util.Optional;
import java.util.UUID;
import org.jspecify.annotations.Nullable;

/**
 * Port: what the application needs from storage, in domain terms. Every lookup takes the owner, so
 * "someone else's item" and "no such item" are the same empty result by construction; the service
 * cannot forget an ownership check because there is no method without one.
 */
public interface ItemRepository {

  Item insert(Item item);

  Optional<Item> findByIdAndOwner(UUID id, UUID ownerId);

  /** Replaces the stored content of an item the owner already has. */
  Item update(Item item);

  /** Returns false when the owner has no such item. */
  boolean deleteByIdAndOwner(UUID id, UUID ownerId);

  /**
   * One page, newest first (creation time descending, then id ascending as the tie-break), starting
   * after the row the query's cursor names. {@code nameContains} is a case-insensitive literal
   * match, or null for all.
   */
  CursorPage<Item> findByOwner(UUID ownerId, @Nullable String nameContains, PageQuery page);
}
