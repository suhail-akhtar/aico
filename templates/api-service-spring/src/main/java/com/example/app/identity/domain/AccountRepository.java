package com.example.app.identity.domain;

import java.util.Optional;
import java.util.UUID;

/** Port: account storage as the application needs it. */
public interface AccountRepository {

  Optional<Account> findByEmail(String normalisedEmail);

  Optional<Account> findById(UUID id);

  /**
   * Inserts a new account.
   *
   * @throws com.example.app.shared.error.ConflictException if the email is already taken (also when
   *     two registrations race: the database's unique index is the real guard)
   */
  Account insert(Account account);

  /** Replaces the stored hash, used when a login finds an older work factor. */
  void updatePasswordHash(UUID id, String newHash);
}
