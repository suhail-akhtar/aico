package com.example.system.identity.security;

import java.util.Collection;
import java.util.List;
import java.util.Locale;
import java.util.regex.Pattern;
import org.jspecify.annotations.Nullable;
import org.springframework.security.core.GrantedAuthority;
import org.springframework.security.core.authority.SimpleGrantedAuthority;

/**
 * Turns the identity provider's {@code roles} claim into Spring authorities. The provider is the
 * only place roles are granted: nothing in this application assigns one. A role name that is not a
 * plain identifier is ignored, so a hostile claim value cannot smuggle in an odd authority string.
 */
final class Roles {

  private static final Pattern SAFE = Pattern.compile("[A-Za-z][A-Za-z0-9_-]{0,63}");

  private Roles() {}

  static Collection<GrantedAuthority> fromClaim(@Nullable List<String> roles) {
    if (roles == null) {
      return List.of();
    }
    return roles.stream()
        .filter(role -> SAFE.matcher(role).matches())
        .map(
            role ->
                (GrantedAuthority)
                    new SimpleGrantedAuthority("ROLE_" + role.toUpperCase(Locale.ROOT)))
        .toList();
  }
}
