package com.example.system.identity;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.springframework.security.access.AccessDeniedException;
import org.springframework.security.authentication.TestingAuthenticationToken;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.core.authority.SimpleGrantedAuthority;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.security.oauth2.core.oidc.OidcIdToken;
import org.springframework.security.oauth2.core.oidc.user.DefaultOidcUser;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.security.oauth2.server.resource.authentication.JwtAuthenticationToken;

/** Reading the caller out of either credential, and refusing anything else. */
class AuthenticatedUserTest {

  private final UUID id = UUID.randomUUID();

  @AfterEach
  void clear() {
    SecurityContextHolder.clearContext();
  }

  @Test
  void aBrowserSessionYieldsTheSubjectNameAndRoles() {
    var idToken =
        new OidcIdToken(
            "t",
            Instant.now(),
            Instant.now().plusSeconds(60),
            Map.of("sub", id.toString(), "email", "a@example.com", "name", "Alice A"));
    var user = new DefaultOidcUser(List.of(new SimpleGrantedAuthority("ROLE_ADMIN")), idToken);
    var auth = new TestingAuthenticationToken(user, "n", "ROLE_ADMIN");

    AuthenticatedUser caller = AuthenticatedUser.from(auth);

    assertThat(caller.id()).isEqualTo(id);
    assertThat(caller.email()).isEqualTo("a@example.com");
    assertThat(caller.name()).isEqualTo("Alice A");
    assertThat(caller.roles()).containsExactly("ADMIN");
    assertThat(caller.isAdmin()).isTrue();
    assertThat(caller.label()).isEqualTo("a@example.com");
  }

  @Test
  void aBearerTokenYieldsTheSameShapeAndFallsBackToTheUsername() {
    Jwt jwt =
        Jwt.withTokenValue("t")
            .header("alg", "none")
            .subject(id.toString())
            .claim("preferred_username", "service-account-automation")
            .build();
    var auth = new JwtAuthenticationToken(jwt, List.of(new SimpleGrantedAuthority("ROLE_MEMBER")));

    AuthenticatedUser caller = AuthenticatedUser.from(auth);

    assertThat(caller.id()).isEqualTo(id);
    assertThat(caller.email()).isNull();
    assertThat(caller.name()).isEqualTo("service-account-automation");
    assertThat(caller.label()).isEqualTo("service-account-automation");
    assertThat(caller.isAdmin()).isFalse();
  }

  @Test
  void currentReadsTheSecurityContext() {
    Jwt jwt = Jwt.withTokenValue("t").header("alg", "none").subject(id.toString()).build();
    SecurityContextHolder.getContext()
        .setAuthentication(new JwtAuthenticationToken(jwt, List.of()));

    assertThat(AuthenticatedUser.current().id()).isEqualTo(id);
  }

  @Test
  void noAuthenticationIsAccessDenied() {
    assertThatThrownBy(AuthenticatedUser::current).isInstanceOf(AccessDeniedException.class);
  }

  @Test
  void anUnknownKindOfCredentialIsAccessDenied() {
    var auth = new UsernamePasswordAuthenticationToken("someone", "x", List.of());

    assertThatThrownBy(() -> AuthenticatedUser.from(auth))
        .isInstanceOf(AccessDeniedException.class);
  }

  @Test
  void theRoleSetCannotBeChangedAfterwards() {
    var caller = new AuthenticatedUser(id, null, "n", Set.of("MEMBER"));

    assertThatThrownBy(() -> caller.roles().add("ADMIN"))
        .isInstanceOf(UnsupportedOperationException.class);
  }
}
