package com.example.app.identity;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.example.app.identity.app.AuthService;
import com.example.app.identity.domain.Account;
import com.example.app.identity.domain.AccountRepository;
import com.example.app.identity.domain.PasswordHasher;
import com.example.app.identity.domain.TokenIssuer;
import com.example.app.identity.domain.TokenIssuer.IssuedToken;
import com.example.app.shared.error.ConflictException;
import com.example.app.shared.error.InvalidCredentialsException;
import com.example.app.shared.error.NotFoundException;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.Optional;
import java.util.UUID;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

@ExtendWith(MockitoExtension.class)
class AuthServiceTest {

  private static final Instant NOW = Instant.parse("2026-10-06T10:00:00Z");
  private static final String PASSWORD = "correct horse battery";

  @Mock AccountRepository accounts;
  @Mock PasswordHasher hasher;
  @Mock TokenIssuer tokens;
  AuthService service;

  @BeforeEach
  void setUp() {
    when(hasher.hash(anyString())).thenAnswer(call -> "hashed:" + call.getArgument(0));
    service = new AuthService(accounts, hasher, tokens, Clock.fixed(NOW, ZoneOffset.UTC));
  }

  private Account account() {
    return new Account(UUID.randomUUID(), "ada@example.com", "hashed:" + PASSWORD, NOW);
  }

  @Test
  void registerStoresANormalisedEmailAndAHashNotThePassword() {
    when(accounts.findByEmail("ada@example.com")).thenReturn(Optional.empty());
    when(accounts.insert(any(Account.class))).thenAnswer(call -> call.getArgument(0));

    Account created = service.register("  Ada@Example.com ", PASSWORD);

    assertThat(created.email()).isEqualTo("ada@example.com");
    assertThat(created.passwordHash()).isEqualTo("hashed:" + PASSWORD).isNotEqualTo(PASSWORD);
  }

  @Test
  void registerRefusesATakenEmail() {
    when(accounts.findByEmail("ada@example.com")).thenReturn(Optional.of(account()));

    assertThatThrownBy(() -> service.register("ada@example.com", PASSWORD))
        .isInstanceOfSatisfying(
            ConflictException.class, e -> assertThat(e.code()).isEqualTo("email_taken"));
    verify(accounts, never()).insert(any());
  }

  @Test
  void loginIssuesATokenForTheRightPassword() {
    Account account = account();
    when(accounts.findByEmail("ada@example.com")).thenReturn(Optional.of(account));
    when(hasher.matches(PASSWORD, account.passwordHash())).thenReturn(true);
    when(hasher.needsRehash(account.passwordHash())).thenReturn(false);
    when(tokens.issue(account)).thenReturn(new IssuedToken("token", 900));

    assertThat(service.login("ADA@example.com", PASSWORD).value()).isEqualTo("token");
    verify(accounts, never()).updatePasswordHash(any(), anyString());
  }

  @Test
  void loginWithAWrongPasswordAndLoginWithAnUnknownEmailLookIdentical() {
    Account account = account();
    when(accounts.findByEmail("ada@example.com")).thenReturn(Optional.of(account));
    when(accounts.findByEmail("nobody@example.com")).thenReturn(Optional.empty());
    when(hasher.matches(anyString(), anyString())).thenReturn(false);

    Throwable wrongPassword =
        org.assertj.core.api.Assertions.catchThrowable(
            () -> service.login("ada@example.com", "not the password"));
    Throwable unknownEmail =
        org.assertj.core.api.Assertions.catchThrowable(
            () -> service.login("nobody@example.com", "not the password"));

    assertThat(wrongPassword).isInstanceOf(InvalidCredentialsException.class);
    assertThat(unknownEmail)
        .isInstanceOf(InvalidCredentialsException.class)
        .hasMessage(wrongPassword.getMessage());
    // The unknown-email path still paid for a hash comparison (timing equalisation).
    String decoy = "hashed:" + decoyArgument();
    verify(hasher).matches("not the password", decoy);
  }

  @Test
  void anAccountWithNoLocalPasswordNeverReachesTheHasherForARealComparison() {
    Account provisioned = Account.provisioned(UUID.randomUUID(), "ada@example.com", NOW);
    when(accounts.findByEmail("ada@example.com")).thenReturn(Optional.of(provisioned));
    String decoy = "hashed:" + decoyArgument();

    assertThatThrownBy(() -> service.login("ada@example.com", PASSWORD))
        .isInstanceOf(InvalidCredentialsException.class);

    // Only the decoy was compared against, never the sentinel, and no token was minted.
    verify(hasher).matches(PASSWORD, decoy);
    verify(hasher, never())
        .matches(anyString(), org.mockito.ArgumentMatchers.eq(Account.NO_LOCAL_PASSWORD));
    verify(tokens, never()).issue(any());
  }

  @Test
  void aSwitchedOffAccountCannotLogInEvenWithTheRightPassword() {
    Account off =
        new Account(UUID.randomUUID(), "ada@example.com", "hashed:" + PASSWORD, NOW, false);
    when(accounts.findByEmail("ada@example.com")).thenReturn(Optional.of(off));

    assertThatThrownBy(() -> service.login("ada@example.com", PASSWORD))
        .isInstanceOf(InvalidCredentialsException.class);
    verify(tokens, never()).issue(any());
  }

  @Test
  void loginRehashesWhenTheStoredHashIsWeaker() {
    Account account = account();
    when(accounts.findByEmail("ada@example.com")).thenReturn(Optional.of(account));
    when(hasher.matches(PASSWORD, account.passwordHash())).thenReturn(true);
    when(hasher.needsRehash(account.passwordHash())).thenReturn(true);
    when(tokens.issue(account)).thenReturn(new IssuedToken("token", 900));

    service.login("ada@example.com", PASSWORD);

    verify(accounts).updatePasswordHash(account.id(), "hashed:" + PASSWORD);
  }

  @Test
  void loginRefusesAPasswordBcryptCouldNotReadInFull() {
    when(accounts.findByEmail("ada@example.com")).thenReturn(Optional.of(account()));

    assertThatThrownBy(() -> service.login("ada@example.com", "p".repeat(100)))
        .isInstanceOf(InvalidCredentialsException.class);
  }

  @Test
  void getOfAMissingAccountIsNotFound() {
    UUID id = UUID.randomUUID();
    when(accounts.findById(id)).thenReturn(Optional.empty());

    assertThatThrownBy(() -> service.get(id)).isInstanceOf(NotFoundException.class);
  }

  /** The decoy is whatever the constructor hashed; read it back from the stubbed hasher. */
  private String decoyArgument() {
    var captor = org.mockito.ArgumentCaptor.forClass(String.class);
    verify(hasher, org.mockito.Mockito.atLeastOnce()).hash(captor.capture());
    return captor.getAllValues().get(0);
  }
}
