package com.example.system.identity;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.oidcLogin;

import com.example.system.support.IntegrationTest;
import com.example.system.support.TestTokens;
import java.net.URI;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.test.web.servlet.assertj.MvcTestResult;
import tools.jackson.databind.JsonNode;

/**
 * The security model end to end: who gets in, with what, and what the headers say. Browser sessions
 * use Spring Security's OIDC test support (the identity provider itself is faked); bearer tokens
 * are real signed JWTs checked by the production validators.
 */
class SecurityIT extends IntegrationTest {

  private MvcTestResult bearer(String method, String path, String token, Object body) {
    var builder =
        switch (method) {
          case "POST" -> mvc.post().uri(URI.create(path));
          case "DELETE" -> mvc.delete().uri(URI.create(path));
          default -> mvc.get().uri(URI.create(path));
        };
    if (token != null) {
      builder.header(HttpHeaders.AUTHORIZATION, "Bearer " + token);
    }
    if (body != null) {
      builder.contentType(MediaType.APPLICATION_JSON).content(json.writeValueAsString(body));
    }
    return builder.exchange();
  }

  private String tokenFor(Caller caller) {
    return TestTokens.valid(caller.id(), caller.email(), caller.roles());
  }

  // ---- anonymous -----------------------------------------------------------------------------

  @Test
  void anonymousApiCallsAreAProblemJson401NotARedirect() {
    MvcTestResult result = get("/api/v1/tasks", null);

    assertProblem(result, HttpStatus.UNAUTHORIZED, "unauthenticated");
    assertThat(result.getResponse().getHeader(HttpHeaders.WWW_AUTHENTICATE)).isNotNull();
    assertProblem(get("/api/v1/admin/audit", null), HttpStatus.UNAUTHORIZED, "unauthenticated");
  }

  @Test
  void anonymousBrowserNavigationToAProtectedPageStartsTheLogin() {
    MvcTestResult result = mvc.get().uri("/dashboard").accept(MediaType.TEXT_HTML).exchange();

    assertThat(result).hasStatus(HttpStatus.FOUND);
    assertThat(result.getResponse().getHeader(HttpHeaders.LOCATION))
        .endsWith("/oauth2/authorization/keycloak");
  }

  @Test
  void theSessionEndpointIsPublicAndSaysNotSignedIn() {
    MvcTestResult result = get("/api/v1/session", null);

    assertThat(result).hasStatus(HttpStatus.OK);
    assertThat(body(result).path("authenticated").asBoolean()).isFalse();
    JsonNode user = body(result).path("user");
    assertThat(user.isNull() || user.isMissingNode()).isTrue();
  }

  @Test
  void theSessionEndpointShowsTheCallerTheirRolesAndFlags() {
    var admin = newAdmin();

    MvcTestResult result = get("/api/v1/session", admin);
    JsonNode session = body(result);

    assertThat(session.path("authenticated").asBoolean()).isTrue();
    assertThat(session.path("user").path("id").asString()).isEqualTo(admin.id().toString());
    assertThat(session.path("user").path("email").asString()).isEqualTo(admin.email());
    assertThat(session.path("user").path("roles").toString()).contains("ADMIN").contains("MEMBER");
    assertThat(session.path("features").path("attachmentsEnabled").asBoolean()).isTrue();
    assertThat(session.path("features").path("maxOpenTasksPerUser").asInt()).isEqualTo(100);
    assertThat(result.getResponse().getHeader(HttpHeaders.CACHE_CONTROL)).contains("no-store");
  }

  @Test
  void probesAreOpenAndAnythingElseUnlistedIsDenied() {
    assertThat(get("/healthz", null)).hasStatus(HttpStatus.OK);
    assertThat(get("/readyz", null)).hasStatus(HttpStatus.OK);
    // /actuator is not exposed, and the catch-all rule denies what no route claims.
    assertThat(mvc.get().uri("/actuator/env").exchange().getResponse().getStatus())
        .isIn(302, 401, 403, 404);
    assertThat(get("/api/v1/nothing-here", newMember())).hasStatus(HttpStatus.NOT_FOUND);
  }

  // ---- login ---------------------------------------------------------------------------------

  @Test
  void theLoginRedirectCarriesPkceAndState() {
    MvcTestResult result = mvc.get().uri("/oauth2/authorization/keycloak").exchange();

    assertThat(result).hasStatus(HttpStatus.FOUND);
    String location = result.getResponse().getHeader(HttpHeaders.LOCATION);
    assertThat(location)
        .startsWith("http://idp.test/realms/app/protocol/openid-connect/auth")
        .contains("response_type=code")
        .contains("code_challenge_method=S256")
        .contains("code_challenge=")
        .contains("state=")
        .contains("scope=openid");
    assertThat(location).doesNotContain("client_secret");
  }

  // ---- CSRF ----------------------------------------------------------------------------------

  @Test
  void aSessionRequestThatChangesStateNeedsTheCsrfToken() {
    var alice = newMember();

    MvcTestResult withoutToken =
        mvc.post()
            .uri("/api/v1/tasks")
            .with(alice.session())
            .contentType(MediaType.APPLICATION_JSON)
            .content("{\"title\":\"forged\"}")
            .exchange();

    assertThat(withoutToken).hasStatus(HttpStatus.FORBIDDEN);
    assertThat(body(get("/api/v1/tasks", alice)).path("totalElements").asLong()).isZero();
    assertThat(post("/api/v1/tasks", alice, Map.of("title", "real"))).hasStatus(HttpStatus.CREATED);
  }

  @Test
  void aBearerTokenNeedsNoCsrfTokenBecauseABrowserCannotAttachIt() {
    var robot = newCaller("MEMBER");

    MvcTestResult result =
        bearer("POST", "/api/v1/tasks", tokenFor(robot), Map.of("title", "from a machine"));

    assertThat(result).hasStatus(HttpStatus.CREATED);
  }

  // ---- bearer tokens -------------------------------------------------------------------------

  @Test
  void aValidTokenIsAcceptedAndOwnsWhatItCreates() {
    var robot = newCaller("MEMBER");
    String token = tokenFor(robot);
    String id =
        body(bearer("POST", "/api/v1/tasks", token, Map.of("title", "mine"))).path("id").asString();

    assertThat(bearer("GET", "/api/v1/tasks/" + id, token, null)).hasStatus(HttpStatus.OK);
    assertProblem(
        bearer("GET", "/api/v1/tasks/" + id, tokenFor(newMember()), null),
        HttpStatus.NOT_FOUND,
        "not_found");
  }

  @Test
  void aTokenForADifferentAudienceIssuerOrWithABadSignatureOrExpiredIsRefused() {
    UUID id = newMember().id();
    List<String> roles = List.of("MEMBER");
    String[] bad =
        new String[] {
          TestTokens.mint(
              id,
              "a@example.com",
              roles,
              TestTokens.ISSUER,
              List.of("other-app"),
              Instant.now().plusSeconds(600)),
          TestTokens.mint(
              id,
              "a@example.com",
              roles,
              "http://evil.example/realms/app",
              List.of(TestTokens.AUDIENCE),
              Instant.now().plusSeconds(600)),
          TestTokens.mint(
              id,
              "a@example.com",
              roles,
              TestTokens.ISSUER,
              List.of(TestTokens.AUDIENCE),
              Instant.now().minusSeconds(600)),
          TestTokens.tampered(TestTokens.valid(id, "a@example.com", roles)),
          "not-a-jwt",
        };

    for (String token : bad) {
      MvcTestResult result = bearer("GET", "/api/v1/tasks", token, null);
      assertProblem(result, HttpStatus.UNAUTHORIZED, "unauthenticated");
      assertThat(result.getResponse().getHeader(HttpHeaders.WWW_AUTHENTICATE))
          .contains("invalid_token");
    }
  }

  @Test
  void aTokenWithoutAnAdminRoleCannotUseTheAdminApiAndOneWithItCan() {
    var member = newMember();
    var admin = newAdmin();

    assertProblem(
        bearer("GET", "/api/v1/admin/tasks", tokenFor(member), null),
        HttpStatus.FORBIDDEN,
        "forbidden");
    assertThat(bearer("GET", "/api/v1/admin/tasks", tokenFor(admin), null))
        .hasStatus(HttpStatus.OK);
  }

  // ---- roles ---------------------------------------------------------------------------------

  @Test
  void adminEndpointsAreForbiddenToMembersAndOpenToAdmins() {
    var member = newMember();
    var admin = newAdmin();

    for (String path : new String[] {"/api/v1/admin/tasks", "/api/v1/admin/audit"}) {
      assertProblem(get(path, member), HttpStatus.FORBIDDEN, "forbidden");
      assertThat(get(path, admin)).hasStatus(HttpStatus.OK);
    }
  }

  @Test
  void anAdminSeesEveryonesTasksButAMemberNeverDoes() {
    var alice = newMember();
    var admin = newAdmin();
    String id = createTask(alice, "visible to admins");

    JsonNode all = body(get("/api/v1/admin/tasks?size=100", admin));

    assertThat(all.path("items").toString()).contains(id);
    // The admin role does not widen the ordinary endpoints: it is a separate, explicit door.
    assertProblem(get("/api/v1/tasks/" + id, admin), HttpStatus.NOT_FOUND, "not_found");
  }

  // ---- headers -------------------------------------------------------------------------------

  @Test
  void apiResponsesCarryTheSecurityHeaders() {
    var response = get("/api/v1/tasks", newMember()).getResponse();

    assertThat(response.getHeader("X-Content-Type-Options")).isEqualTo("nosniff");
    assertThat(response.getHeader("X-Frame-Options")).isEqualTo("DENY");
    assertThat(response.getHeader("Content-Security-Policy"))
        .isEqualTo("default-src 'none'; frame-ancestors 'none'");
    assertThat(response.getHeader("Referrer-Policy")).isEqualTo("strict-origin-when-cross-origin");
    assertThat(response.getHeader("Cross-Origin-Opener-Policy")).isEqualTo("same-origin");
    assertThat(response.getHeader("Permissions-Policy")).contains("camera=()");
    assertThat(response.getHeader("Server")).isNull();
    assertThat(response.getHeader("X-Powered-By")).isNull();
  }

  @Test
  void errorsNeverCarryStackTracesOrInternals() {
    MvcTestResult result = get("/api/v1/tasks/not-a-uuid", newMember());

    assertThat(text(result)).doesNotContain("Exception", "org.springframework", "at com.");
  }

  @Test
  void aSessionWithoutTheAdminAuthorityIsNotPromotedByAnOidcClaimAlone() {
    // The roles come from the provider claim mapped by the login flow; a login that arrives
    // with no roles (here: Spring's own test login with no authorities) is an ordinary member.
    var stranger = newMember();
    MvcTestResult result =
        mvc.get()
            .uri("/api/v1/admin/audit")
            .with(
                oidcLogin()
                    .idToken(t -> t.subject(stranger.id().toString()))
                    .authorities(
                        new org.springframework.security.core.authority.SimpleGrantedAuthority(
                            "ROLE_MEMBER")))
            .exchange();

    assertThat(result).hasStatus(HttpStatus.FORBIDDEN);
  }
}
