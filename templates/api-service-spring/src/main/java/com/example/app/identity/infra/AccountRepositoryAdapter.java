package com.example.app.identity.infra;

import com.example.app.identity.domain.Account;
import com.example.app.identity.domain.AccountRepository;
import com.example.app.shared.error.ConflictException;
import java.util.Optional;
import java.util.UUID;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.stereotype.Repository;

/** Adapter: the domain's {@link AccountRepository} port on Spring Data JPA. */
@Repository
class AccountRepositoryAdapter implements AccountRepository {

  private final AccountJpaRepository jpa;

  AccountRepositoryAdapter(AccountJpaRepository jpa) {
    this.jpa = jpa;
  }

  @Override
  public Optional<Account> findByEmail(String normalisedEmail) {
    return jpa.findByEmail(normalisedEmail).map(AccountRepositoryAdapter::toDomain);
  }

  @Override
  public Optional<Account> findById(UUID id) {
    return jpa.findById(id).map(AccountRepositoryAdapter::toDomain);
  }

  @Override
  public Account insert(Account account) {
    try {
      return toDomain(
          jpa.saveAndFlush(
              new AccountEntity(
                  account.id(),
                  account.email(),
                  account.passwordHash(),
                  account.createdAt(),
                  account.active())));
    } catch (DataIntegrityViolationException e) {
      // Two registrations raced past the existence check; the unique index decided.
      throw new ConflictException("email_taken", "An account with this email already exists");
    }
  }

  @Override
  public void updatePasswordHash(UUID id, String newHash) {
    jpa.findById(id)
        .ifPresent(
            entity -> {
              entity.setPasswordHash(newHash);
              jpa.save(entity);
            });
  }

  private static Account toDomain(AccountEntity e) {
    return new Account(
        e.getId(), e.getEmail(), e.getPasswordHash(), e.getCreatedAt(), e.isActive());
  }
}
