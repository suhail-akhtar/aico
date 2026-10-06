package com.example.system.identity.security;

import static org.assertj.core.api.Assertions.assertThat;

import java.time.Instant;
import java.util.List;
import org.junit.jupiter.api.Test;
import org.springframework.security.core.GrantedAuthority;
import org.springframework.security.oauth2.jwt.Jwt;

/** The two small rules the security model leans on: role mapping and the audience check. */
class SecurityRulesTest {

  private static Jwt token(Object audience) {
    Jwt.Builder builder =
        Jwt.withTokenValue("t")
            .header("alg", "none")
            .subject("2f1c0d2e-0000-4000-8000-000000000001")
            .issuedAt(Instant.now())
            .expiresAt(Instant.now().plusSeconds(60));
    if (audience != null) {
      builder.claim("aud", audience);
    }
    return builder.build();
  }

  @Test
  void rolesBecomeUpperCaseAuthorities() {
    assertThat(Roles.fromClaim(List.of("admin", "member")))
        .extracting(GrantedAuthority::getAuthority)
        .containsExactly("ROLE_ADMIN", "ROLE_MEMBER");
  }

  @Test
  void aMissingClaimMeansNoRoles() {
    assertThat(Roles.fromClaim(null)).isEmpty();
  }

  @Test
  void aRoleThatIsNotAPlainIdentifierIsIgnored() {
    assertThat(
            Roles.fromClaim(
                List.of("ok", "bad role", "x;y", "", "9starts-with-digit", "a".repeat(100))))
        .extracting(GrantedAuthority::getAuthority)
        .containsExactly("ROLE_OK");
  }

  @Test
  void aTokenForThisApiPasses() {
    var validator = new AudienceValidator("system-api");

    assertThat(validator.validate(token(List.of("account", "system-api"))).hasErrors()).isFalse();
  }

  @Test
  void aTokenForAnotherClientOrWithoutAnAudienceIsRefused() {
    var validator = new AudienceValidator("system-api");

    assertThat(validator.validate(token(List.of("some-other-app"))).hasErrors()).isTrue();
    assertThat(validator.validate(token(null)).hasErrors()).isTrue();
    assertThat(validator.validate(token(List.of("system-api-evil"))).hasErrors()).isTrue();
  }
}
