package com.example.system.identity;

import java.util.Collection;
import java.util.Set;
import java.util.UUID;
import java.util.stream.Collectors;
import org.jspecify.annotations.Nullable;
import org.springframework.security.access.AccessDeniedException;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.GrantedAuthority;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.security.oauth2.core.oidc.user.OidcUser;
import org.springframework.security.oauth2.jwt.Jwt;

/**
 * The caller, read from the verified credential: an OIDC session (browsers) or a bearer token
 * (machine clients). Features take the caller from here and never from a request body or path,
 * which is what makes ownership checks trustworthy. The id is the identity provider's subject,
 * which Keycloak issues as a UUID.
 */
public record AuthenticatedUser(UUID id, @Nullable String email, String name, Set<String> roles) {

  public static final String ADMIN = "ADMIN";

  public AuthenticatedUser {
    roles = Set.copyOf(roles);
  }

  /** The caller of the current request; throws {@link AccessDeniedException} if there is none. */
  public static AuthenticatedUser current() {
    Authentication authentication = SecurityContextHolder.getContext().getAuthentication();
    if (authentication == null || !authentication.isAuthenticated()) {
      throw new AccessDeniedException("Authentication required");
    }
    return from(authentication);
  }

  public static AuthenticatedUser from(Authentication authentication) {
    Object principal = authentication.getPrincipal();
    Set<String> roles = roles(authentication.getAuthorities());
    if (principal instanceof OidcUser oidc) {
      return new AuthenticatedUser(
          subject(oidc.getSubject()),
          oidc.getEmail(),
          firstNonBlank(oidc.getFullName(), oidc.getPreferredUsername(), oidc.getSubject()),
          roles);
    }
    if (principal instanceof Jwt jwt) {
      return new AuthenticatedUser(
          subject(jwt.getSubject()),
          jwt.getClaimAsString("email"),
          firstNonBlank(
              jwt.getClaimAsString("name"),
              jwt.getClaimAsString("preferred_username"),
              jwt.getSubject()),
          roles);
    }
    throw new AccessDeniedException("Unsupported credential");
  }

  private static UUID subject(@Nullable String subject) {
    if (subject == null) {
      throw new AccessDeniedException("The credential has no subject");
    }
    try {
      return UUID.fromString(subject);
    } catch (IllegalArgumentException e) {
      throw new AccessDeniedException("The credential subject is not a UUID");
    }
  }

  public boolean isAdmin() {
    return roles.contains(ADMIN);
  }

  /** A human-readable label for audit trails and mail: the email if known, else the name. */
  public String label() {
    return email == null || email.isBlank() ? name : email;
  }

  private static Set<String> roles(Collection<? extends GrantedAuthority> authorities) {
    return authorities.stream()
        .map(GrantedAuthority::getAuthority)
        .filter(a -> a.startsWith("ROLE_"))
        .map(a -> a.substring("ROLE_".length()))
        .collect(Collectors.toUnmodifiableSet());
  }

  private static String firstNonBlank(@Nullable String... values) {
    for (String value : values) {
      if (value != null && !value.isBlank()) {
        return value;
      }
    }
    return "unknown";
  }
}
