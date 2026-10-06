package com.example.app.identity.infra;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
import jakarta.persistence.Version;
import java.time.Instant;
import java.util.UUID;
import org.jspecify.annotations.Nullable;

/** Persistence shape of an account; never leaves {@code infra}. */
@Entity
@Table(name = "accounts")
class AccountEntity {

  @Id private UUID id;

  @Column(nullable = false, length = 254, updatable = false)
  private String email;

  @Column(name = "password_hash", nullable = false, length = 255)
  private String passwordHash;

  @Column(name = "created_at", nullable = false, updatable = false)
  private Instant createdAt;

  @Column(name = "is_active", nullable = false)
  private boolean active;

  @Version private @Nullable Long version;

  /** Required by JPA. */
  protected AccountEntity() {}

  AccountEntity(UUID id, String email, String passwordHash, Instant createdAt, boolean active) {
    this.id = id;
    this.email = email;
    this.passwordHash = passwordHash;
    this.createdAt = createdAt;
    this.active = active;
  }

  UUID getId() {
    return id;
  }

  String getEmail() {
    return email;
  }

  String getPasswordHash() {
    return passwordHash;
  }

  Instant getCreatedAt() {
    return createdAt;
  }

  boolean isActive() {
    return active;
  }

  void setPasswordHash(String passwordHash) {
    this.passwordHash = passwordHash;
  }
}
