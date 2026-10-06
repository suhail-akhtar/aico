package com.example.app.identity.app;

import com.example.app.identity.domain.Account;
import com.example.app.identity.domain.AccountRepository;
import com.example.app.identity.domain.Credentials;
import com.example.app.shared.error.AccountDisabledException;
import com.example.app.shared.error.ConflictException;
import com.example.app.shared.security.CallerProvisioner;
import java.time.Clock;
import java.time.temporal.ChronoUnit;
import java.util.UUID;
import org.jspecify.annotations.Nullable;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.stereotype.Service;

/**
 * Just-in-time provisioning for {@code APP_AUTH_MODE=oidc}: the first request carrying a new
 * subject creates the account (id = the token's {@code sub}, email from the {@code email} claim),
 * later requests find it. No sign-up step exists in this mode, so without this an item's owner
 * foreign key would point at nothing.
 *
 * <p>Decisions worth knowing:
 *
 * <ul>
 *   <li><b>Accounts are never merged by email.</b> If a different account already owns the email (a
 *       local registration from before the switch, or another subject), the answer is a 409 {@code
 *       identity_conflict}. Merging on an email claim would let whoever can set an email at the
 *       provider take over the existing account's data; a person has to resolve it.
 *   <li><b>Race-safe without locks.</b> Two first requests both see "no account"; the primary key
 *       lets exactly one insert win and the loser re-reads and carries on. The unique email index
 *       decides the same way for two different subjects claiming one address.
 *   <li><b>Deliberately not {@code @Transactional}.</b> A failed insert aborts a PostgreSQL
 *       transaction, so the re-read after a lost race must happen in a new one: each repository
 *       call here is its own transaction.
 *   <li>The email is stored once, at first sight; later changes at the provider are not synced (the
 *       {@code sub} is the identity, the email is a label).
 * </ul>
 */
@Service
@ConditionalOnProperty(prefix = "app.auth", name = "mode", havingValue = "oidc")
public class OidcAccountProvisioner implements CallerProvisioner {

  private final AccountRepository accounts;
  private final Clock clock;

  public OidcAccountProvisioner(AccountRepository accounts, Clock clock) {
    this.accounts = accounts;
    this.clock = clock;
  }

  @Override
  public void ensureKnown(UUID subject, @Nullable String emailClaim) {
    var existing = accounts.findById(subject);
    if (existing.isPresent()) {
      requireActive(existing.get());
      return;
    }
    String email = Credentials.emailForSubject(subject, emailClaim);
    var owner = accounts.findByEmail(email);
    if (owner.isPresent()) {
      if (!owner.get().id().equals(subject)) {
        throw identityConflict();
      }
      // The same subject: a simultaneous first request inserted it between our two reads.
      requireActive(owner.get());
      return;
    }
    try {
      accounts.insert(
          Account.provisioned(subject, email, clock.instant().truncatedTo(ChronoUnit.MICROS)));
    } catch (ConflictException lostTheRace) {
      var winner = accounts.findById(subject);
      if (winner.isEmpty()) {
        // The row that beat us belongs to someone else: the email, not the subject, collided.
        throw identityConflict();
      }
      requireActive(winner.get());
    }
  }

  private static void requireActive(Account account) {
    if (!account.active()) {
      throw new AccountDisabledException();
    }
  }

  static ConflictException identityConflict() {
    return new ConflictException(
        "identity_conflict", "Another account already uses this email address.");
  }
}
