package com.example.app.identity;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatCode;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.example.app.identity.domain.Credentials;
import com.example.app.shared.error.ValidationException;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;

class CredentialsTest {

  @Test
  void emailsAreTrimmedAndLowerCased() {
    assertThat(Credentials.normaliseEmail("  Ada@Example.COM ")).isEqualTo("ada@example.com");
  }

  @Test
  void theOidcEmailIsTheLowerCasedClaimWhenItLooksLikeOne() {
    UUID sub = UUID.randomUUID();

    assertThat(Credentials.emailForSubject(sub, "  Ada@Example.COM ")).isEqualTo("ada@example.com");
  }

  @ParameterizedTest
  @ValueSource(
      strings = {"", "   ", "not an email", "no-at-sign.example.com", "a@b", "two@@example.com"})
  void anUnusableOidcEmailClaimFallsBackToAPerSubjectInvalidAddress(String claim) {
    UUID sub = UUID.randomUUID();

    assertThat(Credentials.emailForSubject(sub, claim)).isEqualTo(sub + "@oidc.invalid");
  }

  @Test
  void aMissingOrOverlongOidcEmailClaimFallsBack() {
    UUID sub = UUID.randomUUID();
    String tooLong = "a".repeat(250) + "@example.com";

    assertThat(Credentials.emailForSubject(sub, null)).isEqualTo(sub + "@oidc.invalid");
    assertThat(Credentials.emailForSubject(sub, tooLong)).isEqualTo(sub + "@oidc.invalid");
  }

  @Test
  void aTwelveCharacterPasswordPasses() {
    assertThatCode(() -> Credentials.validateForRegistration("a@example.com", "123456789012"))
        .doesNotThrowAnyException();
  }

  @Test
  void aShortPasswordIsRejectedAndNamed() {
    assertThatThrownBy(() -> Credentials.validateForRegistration("a@example.com", "short"))
        .isInstanceOfSatisfying(
            ValidationException.class,
            e -> assertThat(e.violations()).extracting("field").containsExactly("password"));
  }

  @Test
  void aPasswordBcryptWouldTruncateIsRejected() {
    String tooLong = "p".repeat(Credentials.PASSWORD_MAX_BYTES + 1);

    assertThat(Credentials.fitsHashLimit(tooLong)).isFalse();
    assertThatThrownBy(() -> Credentials.validateForRegistration("a@example.com", tooLong))
        .isInstanceOf(ValidationException.class);
  }

  @Test
  void theLimitIsInBytesNotCharacters() {
    // 37 two-byte characters = 74 bytes: fewer than 72 characters, but too long for bcrypt.
    String multiByte = "é".repeat(37);

    assertThat(Credentials.fitsHashLimit(multiByte)).isFalse();
  }

  @ParameterizedTest
  @ValueSource(strings = {"", "plain", "a@b", "@example.com", "two words@example.com", "a@@b.com"})
  void malformedEmailsAreRejected(String email) {
    assertThatThrownBy(() -> Credentials.validateForRegistration(email, "123456789012"))
        .isInstanceOfSatisfying(
            ValidationException.class,
            e -> assertThat(e.violations()).extracting("field").contains("email"));
  }

  @Test
  void anEmailOverTheLengthLimitIsRejected() {
    String email = "a".repeat(Credentials.EMAIL_MAX) + "@example.com";

    assertThatThrownBy(() -> Credentials.validateForRegistration(email, "123456789012"))
        .isInstanceOf(ValidationException.class);
  }
}
