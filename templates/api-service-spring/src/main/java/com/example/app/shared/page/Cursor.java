package com.example.app.shared.page;

import com.example.app.shared.error.FieldViolation;
import com.example.app.shared.error.ValidationException;
import java.nio.charset.StandardCharsets;
import java.time.DateTimeException;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.Base64;
import java.util.List;
import java.util.UUID;

/**
 * A position in a newest-first list: the creation time and id of the last row a client has seen.
 * The next page is "everything after this row" in the order (created_at descending, id ascending),
 * answered by an index range scan, so page 500 costs the same as page 1 and a row inserted or
 * deleted meanwhile cannot shift, repeat or skip an item the way an offset would.
 *
 * <p>On the wire it is an opaque URL-safe string. It is not signed: it carries nothing but a
 * position inside the caller's own rows (every query is already scoped to the owner), so forging
 * one can only move the caller to a different place in their own list. Clients must not parse it;
 * the format may change.
 */
public record Cursor(Instant createdAt, UUID id) {

  private static final String SEPARATOR = "_";

  /** Timestamps are stored with microsecond precision; the cursor says exactly what is stored. */
  public Cursor {
    createdAt = createdAt.truncatedTo(ChronoUnit.MICROS);
  }

  /** The opaque token a client sends back as {@code cursor}. */
  public String encode() {
    String raw = ChronoUnit.MICROS.between(Instant.EPOCH, createdAt) + SEPARATOR + id;
    return Base64.getUrlEncoder()
        .withoutPadding()
        .encodeToString(raw.getBytes(StandardCharsets.UTF_8));
  }

  /**
   * Reads a token produced by {@link #encode()}.
   *
   * @throws ValidationException (field {@code cursor}) for anything else, so a mangled or stale
   *     token is the caller's 400 and never a server error
   */
  public static Cursor decode(String token) {
    try {
      String raw = new String(Base64.getUrlDecoder().decode(token), StandardCharsets.UTF_8);
      int split = raw.indexOf(SEPARATOR);
      long micros = Long.parseLong(raw.substring(0, split));
      UUID id = UUID.fromString(raw.substring(split + 1));
      return new Cursor(Instant.EPOCH.plus(micros, ChronoUnit.MICROS), id);
    } catch (IllegalArgumentException
        | IndexOutOfBoundsException
        | ArithmeticException
        | DateTimeException e) {
      throw new ValidationException(List.of(new FieldViolation("cursor", "is not a valid cursor")));
    }
  }
}
