package com.example.app.items.infra;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
import jakarta.persistence.Version;
import java.time.Instant;
import java.util.UUID;
import org.jspecify.annotations.Nullable;

/**
 * Persistence shape of an item. It stays inside {@code infra}: the rest of the application sees
 * {@link com.example.app.items.domain.Item}. The owner is a plain id, not a JPA association, so
 * this feature does not reach into the identity feature's tables (the foreign key lives in SQL).
 */
@Entity
@Table(name = "items")
class ItemEntity {

  @Id private UUID id;

  @Column(name = "owner_id", nullable = false, updatable = false)
  private UUID ownerId;

  @Column(nullable = false, length = 120)
  private String name;

  @Column(length = 2000)
  private @Nullable String description;

  @Column(nullable = false)
  private int quantity;

  @Column(name = "created_at", nullable = false, updatable = false)
  private Instant createdAt;

  @Column(name = "updated_at", nullable = false)
  private Instant updatedAt;

  /** Optimistic lock. Null until the first insert so Spring Data knows the row is new. */
  @Version private @Nullable Long version;

  /** Required by JPA. */
  protected ItemEntity() {}

  ItemEntity(
      UUID id,
      UUID ownerId,
      String name,
      @Nullable String description,
      int quantity,
      Instant createdAt,
      Instant updatedAt) {
    this.id = id;
    this.ownerId = ownerId;
    this.name = name;
    this.description = description;
    this.quantity = quantity;
    this.createdAt = createdAt;
    this.updatedAt = updatedAt;
  }

  UUID getId() {
    return id;
  }

  UUID getOwnerId() {
    return ownerId;
  }

  String getName() {
    return name;
  }

  @Nullable String getDescription() {
    return description;
  }

  int getQuantity() {
    return quantity;
  }

  Instant getCreatedAt() {
    return createdAt;
  }

  Instant getUpdatedAt() {
    return updatedAt;
  }

  long getVersion() {
    return version == null ? 0L : version;
  }

  void change(String newName, @Nullable String newDescription, int newQuantity, Instant now) {
    this.name = newName;
    this.description = newDescription;
    this.quantity = newQuantity;
    this.updatedAt = now;
  }
}
