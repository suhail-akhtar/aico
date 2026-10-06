package com.example.app.identity.app;

import com.example.app.identity.domain.Account;
import com.example.app.identity.domain.AccountRepository;
import com.example.app.identity.domain.Credentials;
import com.example.app.identity.domain.PasswordHasher;
import com.example.app.identity.domain.TokenIssuer;
import com.example.app.identity.domain.TokenIssuer.IssuedToken;
import com.example.app.shared.error.ConflictException;
import com.example.app.shared.error.InvalidCredentialsException;
import com.example.app.shared.error.NotFoundException;
import java.time.Clock;
import java.time.temporal.ChronoUnit;
import java.util.UUID;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * Registration and login. Login is built to leak nothing: an unknown email and a wrong password
 * produce the same error, and the unknown-email path still performs a hash comparison so the two
 * take about the same time.
 */
@Service
@Transactional
public class AuthService {

  private final AccountRepository accounts;
  private final PasswordHasher hasher;
  private final TokenIssuer tokens;
  private final Clock clock;

  /** Compared against when the email is unknown, to even out response time. */
  private final String decoyHash;

  public AuthService(
      AccountRepository accounts, PasswordHasher hasher, TokenIssuer tokens, Clock clock) {
    this.accounts = accounts;
    this.hasher = hasher;
    this.tokens = tokens;
    this.clock = clock;
    this.decoyHash = hasher.hash(UUID.randomUUID().toString());
  }

  public Account register(String email, String password) {
    Credentials.validateForRegistration(email, password);
    String normalised = Credentials.normaliseEmail(email);
    if (accounts.findByEmail(normalised).isPresent()) {
      throw emailTaken();
    }
    var account =
        new Account(
            UUID.randomUUID(),
            normalised,
            hasher.hash(password),
            clock.instant().truncatedTo(ChronoUnit.MICROS));
    return accounts.insert(account);
  }

  public IssuedToken login(String email, String password) {
    var found = accounts.findByEmail(Credentials.normaliseEmail(email));
    boolean fits = Credentials.fitsHashLimit(password);
    // An unknown email, an over-long password, a switched-off account and an account with no local
    // password (created from an OIDC token) all look the same to the caller, and all still pay for
    // a hash comparison so they take about as long as a wrong password.
    if (found.isEmpty() || !fits || !found.get().canLogInLocally()) {
      hasher.matches(fits ? password : "x", decoyHash);
      throw new InvalidCredentialsException();
    }
    Account account = found.get();
    if (!hasher.matches(password, account.passwordHash())) {
      throw new InvalidCredentialsException();
    }
    if (hasher.needsRehash(account.passwordHash())) {
      accounts.updatePasswordHash(account.id(), hasher.hash(password));
    }
    return tokens.issue(account);
  }

  @Transactional(readOnly = true)
  public Account get(UUID id) {
    return accounts.findById(id).orElseThrow(() -> new NotFoundException("Account"));
  }

  static ConflictException emailTaken() {
    return new ConflictException("email_taken", "An account with this email already exists");
  }
}
