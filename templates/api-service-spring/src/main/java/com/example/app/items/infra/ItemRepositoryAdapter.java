package com.example.app.items.infra;

import com.example.app.items.domain.Item;
import com.example.app.items.domain.ItemRepository;
import com.example.app.shared.error.NotFoundException;
import com.example.app.shared.page.Cursor;
import com.example.app.shared.page.CursorPage;
import com.example.app.shared.page.PageQuery;
import java.time.Instant;
import java.util.List;
import java.util.Locale;
import java.util.Optional;
import java.util.UUID;
import org.jspecify.annotations.Nullable;
import org.springframework.data.domain.Sort;
import org.springframework.data.jpa.domain.Specification;
import org.springframework.stereotype.Repository;
import org.springframework.transaction.annotation.Transactional;

/** Adapter: implements the domain's {@link ItemRepository} port with Spring Data JPA. */
@Repository
class ItemRepositoryAdapter implements ItemRepository {

  /**
   * Newest first; the id breaks ties so paging is stable. This is exactly the order of {@code
   * idx_items_owner_created (owner_id, created_at desc, id)}, so a page is an index range scan.
   */
  private static final Sort NEWEST_FIRST =
      Sort.by(Sort.Order.desc("createdAt"), Sort.Order.asc("id"));

  private final ItemJpaRepository jpa;

  ItemRepositoryAdapter(ItemJpaRepository jpa) {
    this.jpa = jpa;
  }

  @Override
  public Item insert(Item item) {
    ItemEntity entity =
        new ItemEntity(
            item.id(),
            item.ownerId(),
            item.name(),
            item.description(),
            item.quantity(),
            item.createdAt(),
            item.updatedAt());
    return toDomain(jpa.saveAndFlush(entity));
  }

  @Override
  public Optional<Item> findByIdAndOwner(UUID id, UUID ownerId) {
    return jpa.findByIdAndOwnerId(id, ownerId).map(ItemRepositoryAdapter::toDomain);
  }

  @Override
  public Item update(Item item) {
    ItemEntity entity =
        jpa.findByIdAndOwnerId(item.id(), item.ownerId())
            .orElseThrow(() -> new NotFoundException("Item"));
    entity.change(item.name(), item.description(), item.quantity(), item.updatedAt());
    return toDomain(jpa.saveAndFlush(entity));
  }

  @Override
  @Transactional
  public boolean deleteByIdAndOwner(UUID id, UUID ownerId) {
    return jpa.deleteByIdAndOwnerId(id, ownerId) > 0;
  }

  @Override
  public CursorPage<Item> findByOwner(
      UUID ownerId, @Nullable String nameContains, PageQuery query) {
    Specification<ItemEntity> spec = ownedBy(ownerId);
    if (nameContains != null) {
      spec = spec.and(nameContains(nameContains));
    }
    Cursor after = query.after();
    if (after != null) {
      spec = spec.and(after(after));
    }
    // One row more than asked for tells the page whether there is a next one.
    List<ItemEntity> rows =
        jpa.findBy(spec, q -> q.sortBy(NEWEST_FIRST).limit(query.limit() + 1).all());
    return CursorPage.of(
        rows.stream().map(ItemRepositoryAdapter::toDomain).toList(),
        query.limit(),
        item -> new Cursor(item.createdAt(), item.id()));
  }

  private static Specification<ItemEntity> ownedBy(UUID ownerId) {
    return (root, q, cb) -> cb.equal(root.get("ownerId"), ownerId);
  }

  /**
   * Case-insensitive literal "contains": the search text's own {@code %}, {@code _} and escape
   * character are escaped so they match themselves, and it travels as a bound parameter.
   */
  private static Specification<ItemEntity> nameContains(String text) {
    String escaped =
        text.toLowerCase(Locale.ROOT).replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_");
    return (root, q, cb) -> cb.like(cb.lower(root.get("name")), "%" + escaped + "%", '\\');
  }

  /** Rows after the cursor in (created_at desc, id asc) order. */
  private static Specification<ItemEntity> after(Cursor cursor) {
    return (root, q, cb) ->
        cb.or(
            cb.lessThan(root.<Instant>get("createdAt"), cursor.createdAt()),
            cb.and(
                cb.equal(root.get("createdAt"), cursor.createdAt()),
                cb.greaterThan(root.<UUID>get("id"), cursor.id())));
  }

  private static Item toDomain(ItemEntity e) {
    return new Item(
        e.getId(),
        e.getOwnerId(),
        e.getName(),
        e.getDescription(),
        e.getQuantity(),
        e.getCreatedAt(),
        e.getUpdatedAt(),
        e.getVersion());
  }
}
