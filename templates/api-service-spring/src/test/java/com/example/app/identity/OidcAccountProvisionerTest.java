package com.example.app.identity;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatCode;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.example.app.identity.app.OidcAccountProvisioner;
import com.example.app.identity.domain.Account;
import com.example.app.identity.domain.AccountRepository;
import com.example.app.shared.error.AccountDisabledException;
import com.example.app.shared.error.ConflictException;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.Optional;
import java.util.UUID;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.ArgumentCaptor;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

/** Every branch of first-sight provisioning, including the race outcomes a database makes rare. */
@ExtendWith(MockitoExtension.class)
class OidcAccountProvisionerTest {

  private static final Instant NOW = Instant.parse("2026-10-06T10:00:00.123456789Z");

  @Mock AccountRepository accounts;
  OidcAccountProvisioner provisioner;
  UUID sub = UUID.randomUUID();

  @BeforeEach
  void setUp() {
    provisioner = new OidcAccountProvisioner(accounts, Clock.fixed(NOW, ZoneOffset.UTC));
  }

  private Account inserted() {
    ArgumentCaptor<Account> captor = ArgumentCaptor.forClass(Account.class);
    verify(accounts).insert(captor.capture());
    return captor.getValue();
  }

  @Test
  void aKnownActiveSubjectIsLeftAloneWithoutAnyWrite() {
    when(accounts.findById(sub))
        .thenReturn(Optional.of(new Account(sub, "a@example.com", "hash", NOW)));

    provisioner.ensureKnown(sub, "other@example.com");

    verify(accounts, never()).insert(any());
    verify(accounts, never()).findByEmail(any());
  }

  @Test
  void aKnownButSwitchedOffSubjectIsRefused() {
    when(accounts.findById(sub))
        .thenReturn(Optional.of(new Account(sub, "a@example.com", "hash", NOW, false)));

    assertThatThrownBy(() -> provisioner.ensureKnown(sub, "a@example.com"))
        .isInstanceOf(AccountDisabledException.class);
    verify(accounts, never()).insert(any());
  }

  @Test
  void aNewSubjectGetsAnActiveAccountWithItsIdAsTheSubjectAndNoUsablePassword() {
    when(accounts.findById(sub)).thenReturn(Optional.empty());
    when(accounts.findByEmail("ada@example.com")).thenReturn(Optional.empty());

    provisioner.ensureKnown(sub, "  Ada@Example.com ");

    Account created = inserted();
    assertThat(created.id()).isEqualTo(sub);
    assertThat(created.email()).isEqualTo("ada@example.com");
    assertThat(created.passwordHash()).isEqualTo(Account.NO_LOCAL_PASSWORD);
    assertThat(created.active()).isTrue();
    assertThat(created.canLogInLocally()).isFalse();
    // Stored with microsecond precision, like every other timestamp.
    assertThat(created.createdAt()).isEqualTo(Instant.parse("2026-10-06T10:00:00.123456Z"));
  }

  @Test
  void aSubjectWithoutAUsableEmailGetsTheInvalidAddress() {
    String placeholder = sub + "@oidc.invalid";
    when(accounts.findById(sub)).thenReturn(Optional.empty());
    when(accounts.findByEmail(placeholder)).thenReturn(Optional.empty());

    provisioner.ensureKnown(sub, null);

    assertThat(inserted().email()).isEqualTo(placeholder);
  }

  @Test
  void anEmailOwnedByAnotherAccountIsAConflictWithoutAnInsert() {
    when(accounts.findById(sub)).thenReturn(Optional.empty());
    when(accounts.findByEmail("taken@example.com"))
        .thenReturn(Optional.of(new Account(UUID.randomUUID(), "taken@example.com", "h", NOW)));

    assertThatThrownBy(() -> provisioner.ensureKnown(sub, "taken@example.com"))
        .isInstanceOfSatisfying(
            ConflictException.class, e -> assertThat(e.code()).isEqualTo("identity_conflict"));
    verify(accounts, never()).insert(any());
  }

  @Test
  void anEmailOwnedByTheSameSubjectIsASimultaneousFirstRequestNotAConflict() {
    when(accounts.findById(sub)).thenReturn(Optional.empty());
    when(accounts.findByEmail("a@example.com"))
        .thenReturn(Optional.of(new Account(sub, "a@example.com", "x", NOW)));

    assertThatCode(() -> provisioner.ensureKnown(sub, "a@example.com")).doesNotThrowAnyException();
    verify(accounts, never()).insert(any());
  }

  @Test
  void anEmailOwnedByTheSameButSwitchedOffSubjectIsRefused() {
    when(accounts.findById(sub)).thenReturn(Optional.empty());
    when(accounts.findByEmail("a@example.com"))
        .thenReturn(Optional.of(new Account(sub, "a@example.com", "x", NOW, false)));

    assertThatThrownBy(() -> provisioner.ensureKnown(sub, "a@example.com"))
        .isInstanceOf(AccountDisabledException.class);
  }

  @Test
  void losingTheRaceToTheSameSubjectIsFine() {
    when(accounts.findById(sub))
        .thenReturn(Optional.empty(), Optional.of(new Account(sub, "a@example.com", "x", NOW)));
    when(accounts.findByEmail("a@example.com")).thenReturn(Optional.empty());
    when(accounts.insert(any())).thenThrow(new ConflictException("email_taken", "x"));

    assertThatCode(() -> provisioner.ensureKnown(sub, "a@example.com")).doesNotThrowAnyException();
  }

  @Test
  void losingTheRaceToTheSameSubjectWhoIsSwitchedOffIsRefused() {
    when(accounts.findById(sub))
        .thenReturn(
            Optional.empty(), Optional.of(new Account(sub, "a@example.com", "x", NOW, false)));
    when(accounts.findByEmail("a@example.com")).thenReturn(Optional.empty());
    when(accounts.insert(any())).thenThrow(new ConflictException("email_taken", "x"));

    assertThatThrownBy(() -> provisioner.ensureKnown(sub, "a@example.com"))
        .isInstanceOf(AccountDisabledException.class);
  }

  @Test
  void losingTheRaceToADifferentSubjectWithTheSameEmailIsAConflict() {
    when(accounts.findById(sub)).thenReturn(Optional.empty(), Optional.empty());
    when(accounts.findByEmail("a@example.com")).thenReturn(Optional.empty());
    when(accounts.insert(any())).thenThrow(new ConflictException("email_taken", "x"));

    assertThatThrownBy(() -> provisioner.ensureKnown(sub, "a@example.com"))
        .isInstanceOfSatisfying(
            ConflictException.class, e -> assertThat(e.code()).isEqualTo("identity_conflict"));
  }
}
