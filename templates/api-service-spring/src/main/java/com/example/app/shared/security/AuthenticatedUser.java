package com.example.app.shared.security;

import java.util.Objects;
import java.util.UUID;
import org.springframework.security.oauth2.jwt.Jwt;

/**
 * Reads the caller out of a validated token. Features take the id from here and never from the
 * request body or path, which is what makes ownership checks trustworthy.
 */
public final class AuthenticatedUser {

  private AuthenticatedUser() {}

  public static UUID id(Jwt jwt) {
    return UUID.fromString(Objects.requireNonNull(jwt.getSubject(), "token has no subject"));
  }
}
