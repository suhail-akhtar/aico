package com.example.app.shared;

import static org.assertj.core.api.Assertions.assertThat;

import com.example.app.shared.config.AppProperties;
import com.example.app.shared.security.JwtKeys;
import com.example.app.support.IntegrationTest;
import com.nimbusds.jose.jwk.source.ImmutableSecret;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import javax.crypto.spec.SecretKeySpec;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.security.oauth2.jose.jws.MacAlgorithm;
import org.springframework.security.oauth2.jwt.JwsHeader;
import org.springframework.security.oauth2.jwt.JwtClaimsSet;
import org.springframework.security.oauth2.jwt.JwtEncoderParameters;
import org.springframework.security.oauth2.jwt.NimbusJwtEncoder;
import org.springframework.test.web.servlet.assertj.MvcTestResult;

/**
 * Attacker's-eye tests: missing, forged, expired or foreign tokens; one user reaching for another's
 * data; hostile input; oversized bodies; the headers and CORS policy a browser will see.
 */
class SecurityIT extends IntegrationTest {

  @Autowired AppProperties props;
  @Autowired org.springframework.context.ApplicationContext context;

  /** A token signed with the real key, so only the claim under test is wrong. */
  private String token(String subject, String issuer, String audience, Instant expires) {
    var encoder = new NimbusJwtEncoder(new ImmutableSecret<>(JwtKeys.secretKey(props.jwt())));
    Instant issued = expires.minusSeconds(600);
    JwtClaimsSet claims =
        JwtClaimsSet.builder()
            .issuer(issuer)
            .audience(List.of(audience))
            .subject(subject)
            .issuedAt(issued)
            .expiresAt(expires)
            .build();
    return encoder
        .encode(JwtEncoderParameters.from(JwsHeader.with(MacAlgorithm.HS256).build(), claims))
        .getTokenValue();
  }

  // ---- authentication ---------------------------------------------------------------------

  @Test
  void aProtectedRouteWithoutATokenIs401WithABearerChallenge() {
    MvcTestResult result = get("/api/v1/items", null);

    assertProblem(result, HttpStatus.UNAUTHORIZED, "unauthenticated");
    assertThat(result.getResponse().getHeader(HttpHeaders.WWW_AUTHENTICATE)).isEqualTo("Bearer");
  }

  @Test
  void anUnknownPathWithoutATokenIsAlso401NotA404() {
    assertThat(get("/no/such/route", null)).hasStatus(HttpStatus.UNAUTHORIZED);
  }

  @Test
  void garbageInTheAuthorizationHeaderIsRefused() {
    MvcTestResult result = get("/api/v1/items", "not.a.jwt");

    assertProblem(result, HttpStatus.UNAUTHORIZED, "unauthenticated");
    assertThat(result.getResponse().getHeader(HttpHeaders.WWW_AUTHENTICATE))
        .contains("invalid_token");
  }

  @Test
  void anExpiredTokenIsRefused() {
    String expired =
        token(
            UUID.randomUUID().toString(),
            "api-service",
            "api-service",
            Instant.now().minusSeconds(3600));

    assertProblem(get("/api/v1/items", expired), HttpStatus.UNAUTHORIZED, "unauthenticated");
  }

  @Test
  void aTokenSignedWithAnotherKeyIsRefused() {
    var other =
        new NimbusJwtEncoder(
            new ImmutableSecret<>(
                new SecretKeySpec(
                    "a-completely-different-signing-key-0123456789"
                        .getBytes(StandardCharsets.UTF_8),
                    "HmacSHA256")));
    Instant now = Instant.now();
    JwtClaimsSet claims =
        JwtClaimsSet.builder()
            .issuer("api-service")
            .audience(List.of("api-service"))
            .subject(UUID.randomUUID().toString())
            .issuedAt(now)
            .expiresAt(now.plusSeconds(600))
            .build();
    String forged =
        other
            .encode(JwtEncoderParameters.from(JwsHeader.with(MacAlgorithm.HS256).build(), claims))
            .getTokenValue();

    assertProblem(get("/api/v1/items", forged), HttpStatus.UNAUTHORIZED, "unauthenticated");
  }

  @Test
  void aTokenWithTheAlgorithmSetToNoneIsRefused() {
    String header =
        java.util.Base64.getUrlEncoder()
            .withoutPadding()
            .encodeToString("{\"alg\":\"none\"}".getBytes(StandardCharsets.UTF_8));
    String payload =
        java.util.Base64.getUrlEncoder()
            .withoutPadding()
            .encodeToString(
                ("{\"sub\":\""
                        + UUID.randomUUID()
                        + "\",\"iss\":\"api-service\",\"aud\":\"api-service\",\"exp\":"
                        + (Instant.now().getEpochSecond() + 600)
                        + "}")
                    .getBytes(StandardCharsets.UTF_8));

    assertThat(get("/api/v1/items", header + "." + payload + "."))
        .hasStatus(HttpStatus.UNAUTHORIZED);
  }

  @Test
  void aTokenForAnotherAudienceOrIssuerIsRefused() {
    Instant exp = Instant.now().plusSeconds(600);
    String subject = UUID.randomUUID().toString();

    assertThat(get("/api/v1/items", token(subject, "api-service", "billing-service", exp)))
        .hasStatus(HttpStatus.UNAUTHORIZED);
    assertThat(get("/api/v1/items", token(subject, "evil-issuer", "api-service", exp)))
        .hasStatus(HttpStatus.UNAUTHORIZED);
  }

  @Test
  void localModeKnowsNothingOfOidcAndRefusesAnRs256Token() {
    var provider = com.example.app.support.FakeIdentityProvider.start();
    try {
      String rs256 = provider.token().build();

      assertProblem(get("/api/v1/items", rs256), HttpStatus.UNAUTHORIZED, "unauthenticated");
    } finally {
      provider.close();
    }
    assertThat(context.getBeanNamesForType(com.example.app.shared.security.CallerProvisioner.class))
        .isEmpty();
    assertThat(context.getBeansOfType(org.springframework.security.oauth2.jwt.JwtDecoder.class))
        .containsOnlyKeys("jwtDecoder");
  }

  @Test
  void aTamperedTokenIsRefused() {
    String good = newUserToken();
    String[] parts = good.split("\\.");
    String tampered =
        parts[0] + "." + parts[1] + "." + parts[2].substring(0, parts[2].length() - 2) + "AA";

    assertThat(get("/api/v1/items", tampered)).hasStatus(HttpStatus.UNAUTHORIZED);
  }

  // ---- authorisation: one user must never reach another's data ----------------------------

  @Test
  void anotherUsersItemIs404ForReadUpdateAndDelete() {
    String owner = newUserToken();
    String intruder = newUserToken();
    String id = createItem(owner, "Private");

    assertProblem(get("/api/v1/items/" + id, intruder), HttpStatus.NOT_FOUND, "not_found");
    assertProblem(
        put("/api/v1/items/" + id, intruder, Map.of("name", "Hijacked")),
        HttpStatus.NOT_FOUND,
        "not_found");
    assertProblem(delete("/api/v1/items/" + id, intruder), HttpStatus.NOT_FOUND, "not_found");
    // Still intact for its owner.
    assertThat(body(get("/api/v1/items/" + id, owner)).path("name").asString())
        .isEqualTo("Private");
  }

  @Test
  void listsOnlyContainTheCallersOwnItems() {
    String alice = newUserToken();
    String bob = newUserToken();
    createItem(alice, "alice-1");
    createItem(bob, "bob-1");

    assertThat(body(get("/api/v1/items", alice)).path("items")).hasSize(1);
    assertThat(body(get("/api/v1/items?q=bob", alice)).path("items")).isEmpty();
  }

  @Test
  void anOwnerIdSmuggledIntoTheBodyIsIgnored() {
    String alice = newUserToken();
    String bob = newUserToken();
    String bobsAccount = body(get("/api/v1/auth/me", bob)).path("id").asString();

    MvcTestResult created =
        post("/api/v1/items", alice, "{\"name\":\"mine\",\"ownerId\":\"" + bobsAccount + "\"}");

    assertThat(created).hasStatus(HttpStatus.CREATED);
    assertThat(body(get("/api/v1/items", bob)).path("items")).isEmpty();
    assertThat(body(get("/api/v1/items", alice)).path("items")).hasSize(1);
  }

  // ---- hostile input ----------------------------------------------------------------------

  @ParameterizedTest
  @ValueSource(
      strings = {
        "'; DROP TABLE items; --",
        "\" OR \"1\"=\"1",
        "Robert'); DELETE FROM accounts;--",
        "<script>alert(1)</script>",
        "${jndi:ldap://x/a}",
        "../../etc/passwd"
      })
  void hostileStringsAreStoredAndSearchedAsPlainData(String evil) {
    String token = newUserToken();
    String id = createItem(token, evil);

    assertThat(body(get("/api/v1/items/" + id, token)).path("name").asString()).isEqualTo(evil);
    assertThat(
            get(
                "/api/v1/items?q=" + java.net.URLEncoder.encode(evil, StandardCharsets.UTF_8),
                token))
        .hasStatus(HttpStatus.OK);
    // The tables are still there and the owner still sees exactly their item.
    assertThat(body(get("/api/v1/items", token)).path("items")).hasSize(1);
  }

  @Test
  void controlCharactersAreRejectedNotPassedToTheDatabase() {
    String token = newUserToken();

    assertProblem(
        post("/api/v1/items", token, Map.of("name", "bad" + (char) 0 + "name")),
        HttpStatus.BAD_REQUEST,
        "validation_failed");
    assertThat(get("/api/v1/items?q=a%00b", token)).hasStatus(HttpStatus.BAD_REQUEST);
    // Line breaks stay legal in a description.
    assertThat(
            post(
                "/api/v1/items",
                token,
                Map.of("name", "ok", "description", "line1" + (char) 10 + "line2")))
        .hasStatus(HttpStatus.CREATED);
  }

  @Test
  void anOversizedBodyIs413() {
    String token = newUserToken();
    String huge = "{\"name\":\"" + "x".repeat(20_000) + "\"}"; // limit in the test profile is 16KB

    MvcTestResult result = post("/api/v1/items", token, huge);

    assertProblem(result, HttpStatus.CONTENT_TOO_LARGE, "payload_too_large");
  }

  @Test
  void aWrongContentTypeIs415() {
    MvcTestResult result =
        mvc.post()
            .uri("/api/v1/items")
            .header(HttpHeaders.AUTHORIZATION, "Bearer " + newUserToken())
            .contentType(MediaType.TEXT_PLAIN)
            .content("name=x")
            .exchange();

    assertThat(result).hasStatus(HttpStatus.UNSUPPORTED_MEDIA_TYPE);
  }

  @Test
  void aWrongMethodIs405() {
    assertThat(delete("/api/v1/items", newUserToken())).hasStatus(HttpStatus.METHOD_NOT_ALLOWED);
  }

  // ---- headers, CORS, health --------------------------------------------------------------

  @Test
  void securityHeadersAreOnEveryResponse() {
    MvcTestResult result = get("/api/v1/items", newUserToken());

    var response = result.getResponse();
    assertThat(response.getHeader("X-Content-Type-Options")).isEqualTo("nosniff");
    assertThat(response.getHeader("X-Frame-Options")).isEqualTo("DENY");
    assertThat(response.getHeader("Content-Security-Policy")).contains("default-src 'none'");
    assertThat(response.getHeader("Referrer-Policy")).isEqualTo("no-referrer");
    assertThat(response.getHeader("Cross-Origin-Opener-Policy")).isEqualTo("same-origin");
    assertThat(response.getHeader("Permissions-Policy")).contains("camera=()");
    assertThat(response.getHeader(HttpHeaders.CACHE_CONTROL)).contains("no-store");
    assertThat(response.getHeader("X-Request-Id")).isNotBlank();
    assertThat(response.getHeader("Server")).isNull();
    assertThat(response.getHeader("X-Powered-By")).isNull();
  }

  @Test
  void aCallerSuppliedRequestIdIsEchoedAndAppearsInProblems() {
    MvcTestResult result =
        mvc.get().uri("/api/v1/items").header("X-Request-Id", "trace-me-42").exchange();

    assertThat(result.getResponse().getHeader("X-Request-Id")).isEqualTo("trace-me-42");
    assertThat(body(result).path("request_id").asString()).isEqualTo("trace-me-42");
  }

  @Test
  void corsAllowsTheConfiguredOriginOnly() {
    MvcTestResult allowed =
        mvc.options()
            .uri("/api/v1/items")
            .header(HttpHeaders.ORIGIN, "https://app.example.com")
            .header(HttpHeaders.ACCESS_CONTROL_REQUEST_METHOD, "POST")
            .header(HttpHeaders.ACCESS_CONTROL_REQUEST_HEADERS, "authorization,content-type")
            .exchange();
    MvcTestResult denied =
        mvc.options()
            .uri("/api/v1/items")
            .header(HttpHeaders.ORIGIN, "https://evil.example.org")
            .header(HttpHeaders.ACCESS_CONTROL_REQUEST_METHOD, "POST")
            .exchange();

    assertThat(allowed).hasStatus(HttpStatus.OK);
    assertThat(allowed.getResponse().getHeader(HttpHeaders.ACCESS_CONTROL_ALLOW_ORIGIN))
        .isEqualTo("https://app.example.com");
    assertThat(allowed.getResponse().getHeader(HttpHeaders.ACCESS_CONTROL_ALLOW_CREDENTIALS))
        .isNull();
    assertThat(denied).hasStatus(HttpStatus.FORBIDDEN);
    assertThat(denied.getResponse().getHeader(HttpHeaders.ACCESS_CONTROL_ALLOW_ORIGIN)).isNull();
  }

  @Test
  void livenessAndReadinessArePublicAndReportUp() {
    MvcTestResult live = get("/healthz", null);
    MvcTestResult ready = get("/readyz", null);

    assertThat(live).hasStatus(HttpStatus.OK).bodyJson().extractingPath("$.status").isEqualTo("UP");
    assertThat(ready)
        .hasStatus(HttpStatus.OK)
        .bodyJson()
        .extractingPath("$.status")
        .isEqualTo("UP");
    // Health bodies carry no component details.
    assertThat(text(live)).doesNotContain("db", "diskSpace");
  }

  @Test
  void otherActuatorEndpointsAreNotExposed() {
    String token = newUserToken();

    assertThat(get("/actuator/env", token)).hasStatus(HttpStatus.NOT_FOUND);
    assertThat(get("/actuator/beans", token)).hasStatus(HttpStatus.NOT_FOUND);
    assertThat(get("/actuator/heapdump", token)).hasStatus(HttpStatus.NOT_FOUND);
  }
}
