package com.example.app.items.app;

import com.example.app.items.domain.Item;
import com.example.app.items.domain.ItemRepository;
import com.example.app.shared.error.ConflictException;
import com.example.app.shared.error.NotFoundException;
import com.example.app.shared.page.CursorPage;
import com.example.app.shared.page.PageQuery;
import java.time.Clock;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.UUID;
import org.jspecify.annotations.Nullable;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * Use cases for items. One public method per thing a caller can do; each is one transaction. The
 * owner always arrives as a parameter taken from the verified token, never from user input.
 */
@Service
@Transactional
public class ItemService {

  private final ItemRepository items;
  private final Clock clock;

  public ItemService(ItemRepository items, Clock clock) {
    this.items = items;
    this.clock = clock;
  }

  public Item create(UUID ownerId, String name, @Nullable String description, int quantity) {
    return items.insert(Item.create(ownerId, name, description, quantity, now()));
  }

  @Transactional(readOnly = true)
  public Item get(UUID ownerId, UUID id) {
    return items.findByIdAndOwner(id, ownerId).orElseThrow(ItemService::notFound);
  }

  @Transactional(readOnly = true)
  public CursorPage<Item> list(UUID ownerId, @Nullable String nameContains, PageQuery page) {
    String filter = nameContains == null || nameContains.isBlank() ? null : nameContains.strip();
    return items.findByOwner(ownerId, filter, page);
  }

  /**
   * Updates an item. If the caller passes the version it last saw and the item has moved on, the
   * update is refused (409) instead of silently overwriting the other change.
   */
  public Item update(
      UUID ownerId,
      UUID id,
      String name,
      @Nullable String description,
      int quantity,
      @Nullable Long expectedVersion) {
    Item current = get(ownerId, id);
    if (expectedVersion != null && expectedVersion != current.version()) {
      throw new ConflictException(
          "version_conflict", "The item changed since version " + expectedVersion + "; reload it.");
    }
    return items.update(current.withDetails(name, description, quantity, now()));
  }

  public void delete(UUID ownerId, UUID id) {
    if (!items.deleteByIdAndOwner(id, ownerId)) {
      throw notFound();
    }
  }

  private Instant now() {
    // Postgres stores microseconds; truncating here keeps what we return equal to what we stored.
    return clock.instant().truncatedTo(ChronoUnit.MICROS);
  }

  private static NotFoundException notFound() {
    return new NotFoundException("Item");
  }
}
