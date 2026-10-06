package com.example.app.identity.domain;

import java.time.Instant;
import java.util.UUID;

/**
 * A user. The hash is an opaque string produced by a {@link PasswordHasher}, or {@link
 * #NO_LOCAL_PASSWORD} for an account that exists only because an external identity provider vouched
 * for it. {@code active} false means the account has been switched off.
 */
public record Account(
    UUID id, String email, String passwordHash, Instant createdAt, boolean active) {

  /**
   * Stored instead of a hash for accounts provisioned from an OIDC token. It is deliberately not
   * the shape of any hash the hasher produces (bcrypt hashes start with {@code $2}), so no password
   * can ever verify against it, and {@link #canLogInLocally()} refuses it before a hasher is asked.
   */
  public static final String NO_LOCAL_PASSWORD = "!no-local-password";

  /** An active account, the common case (registration, tests). */
  public Account(UUID id, String email, String passwordHash, Instant createdAt) {
    this(id, email, passwordHash, createdAt, true);
  }

  /** The account created on first sight of an OIDC subject: the id IS the subject. */
  public static Account provisioned(UUID subject, String email, Instant now) {
    return new Account(subject, email, NO_LOCAL_PASSWORD, now, true);
  }

  /** Only active accounts that registered a password can log in with one. */
  public boolean canLogInLocally() {
    return active && !NO_LOCAL_PASSWORD.equals(passwordHash);
  }
}
