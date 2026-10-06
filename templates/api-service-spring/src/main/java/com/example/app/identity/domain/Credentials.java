package com.example.app.identity.domain;

import com.example.app.shared.error.FieldViolation;
import com.example.app.shared.error.ValidationException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.UUID;
import java.util.regex.Pattern;
import org.jspecify.annotations.Nullable;

/**
 * Rules for the two things a person types to register: the email and the password. The password
 * policy follows OWASP: length over composition rules (12 characters minimum), no maximum below the
 * hash algorithm's own limit (bcrypt reads 72 bytes, so more would be silently ignored).
 */
public final class Credentials {

  public static final int PASSWORD_MIN = 12;
  public static final int PASSWORD_MAX_BYTES = 72;
  public static final int EMAIL_MAX = 254;

  private static final Pattern EMAIL = Pattern.compile("^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$");

  private Credentials() {}

  /** Emails compare case-insensitively; store and look up the lower-case, trimmed form. */
  public static String normaliseEmail(String email) {
    return email.strip().toLowerCase(Locale.ROOT);
  }

  /** Checks a new registration; throws a {@link ValidationException} naming every bad field. */
  public static void validateForRegistration(String email, String password) {
    List<FieldViolation> violations = new ArrayList<>();
    String normalised = normaliseEmail(email);
    if (normalised.length() > EMAIL_MAX || !EMAIL.matcher(normalised).matches()) {
      violations.add(new FieldViolation("email", "must be a valid email address"));
    }
    if (password.length() < PASSWORD_MIN) {
      violations.add(
          new FieldViolation("password", "must be at least " + PASSWORD_MIN + " characters"));
    } else if (password.getBytes(StandardCharsets.UTF_8).length > PASSWORD_MAX_BYTES) {
      violations.add(
          new FieldViolation("password", "must be at most " + PASSWORD_MAX_BYTES + " bytes"));
    }
    if (!violations.isEmpty()) {
      throw new ValidationException(violations);
    }
  }

  /**
   * The email to store for an account created from an OIDC token: the token's {@code email} claim,
   * lower-cased, when it looks like an email, otherwise a placeholder that cannot collide with a
   * real address ({@code .invalid} is reserved by RFC 2606) and is unique per subject.
   */
  public static String emailForSubject(UUID subject, @Nullable String claim) {
    if (claim != null) {
      String normalised = normaliseEmail(claim);
      if (normalised.length() <= EMAIL_MAX && EMAIL.matcher(normalised).matches()) {
        return normalised;
      }
    }
    return subject + "@oidc.invalid";
  }

  /** True if the password is short enough for bcrypt to read in full. */
  public static boolean fitsHashLimit(String password) {
    return password.getBytes(StandardCharsets.UTF_8).length <= PASSWORD_MAX_BYTES;
  }
}
