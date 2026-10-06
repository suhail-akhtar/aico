package com.example.app.identity;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.example.app.identity.domain.Account;
import com.example.app.identity.domain.AccountRepository;
import com.example.app.identity.domain.TokenIssuer;
import com.example.app.shared.error.LocalAuthDisabledException;
import com.example.app.shared.security.CallerProvisioner;
import com.example.app.support.FakeIdentityProvider;
import com.example.app.support.OidcIntegrationTest;
import com.nimbusds.jose.JWSAlgorithm;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CyclicBarrier;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.context.ApplicationContext;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.security.oauth2.jwt.JwtDecoder;
import org.springframework.test.web.servlet.assertj.MvcTestResult;

/**
 * The service as a resource server behind a gateway: tokens come from the (fake) provider, accounts
 * are created on first sight, the local credential endpoints are off. Everything here goes through
 * HTTP and a real database, the way the gateway would call it.
 */
class OidcModeIT extends OidcIntegrationTest {

  @Autowired JdbcTemplate jdbc;
  @Autowired AccountRepository accounts;
  @Autowired CallerProvisioner provisioner;
  @Autowired ApplicationContext context;

  private int accountRows(UUID id) {
    return jdbc.queryForObject("select count(*) from accounts where id = ?", Integer.class, id);
  }

  private String tokenFor(UUID subject, String email) {
    return IDP.token().subject(subject).email(email).build();
  }

  // ---- identity mapping and just-in-time provisioning -----------------------------------------

  @Test
  void theFirstRequestCreatesTheAccountFromTheTokenAndLaterOnesReuseIt() {
    UUID sub = UUID.randomUUID();
    String token = tokenFor(sub, "Mixed.Case@Example.COM");
    assertThat(accountRows(sub)).isZero();

    MvcTestResult first = get("/api/v1/auth/me", token);
    MvcTestResult second = get("/api/v1/auth/me", token);

    assertThat(first).hasStatus(HttpStatus.OK);
    assertThat(body(first).path("id").asString()).isEqualTo(sub.toString());
    assertThat(body(first).path("email").asString()).isEqualTo("mixed.case@example.com");
    assertThat(body(first).propertyNames()).contains("id", "email");
    assertThat(second).hasStatus(HttpStatus.OK);
    assertThat(accountRows(sub)).isEqualTo(1);
    Map<String, Object> row =
        jdbc.queryForMap(
            "select password_hash, is_active, version, created_at from accounts where id = ?", sub);
    assertThat(row.get("password_hash")).isEqualTo(Account.NO_LOCAL_PASSWORD);
    assertThat(row.get("is_active")).isEqualTo(true);
    assertThat(row.get("version")).isNotNull();
    assertThat(row.get("created_at")).isNotNull();
  }

  @Test
  void aMissingOrUnusableEmailClaimFallsBackToAnInvalidAddressUniquePerSubject() {
    UUID noClaim = UUID.randomUUID();
    UUID notAnEmail = UUID.randomUUID();

    assertThat(get("/api/v1/auth/me", IDP.token().subject(noClaim).build()))
        .hasStatus(HttpStatus.OK);
    assertThat(get("/api/v1/auth/me", tokenFor(notAnEmail, "not an email")))
        .hasStatus(HttpStatus.OK);

    assertThat(accounts.findById(noClaim).orElseThrow().email())
        .isEqualTo(noClaim + "@oidc.invalid");
    assertThat(accounts.findById(notAnEmail).orElseThrow().email())
        .isEqualTo(notAnEmail + "@oidc.invalid");
  }

  @Test
  void aProvisionedUserOwnsItsItemsAndCannotSeeAnotherUsersItems() {
    String alice = tokenFor(UUID.randomUUID(), "alice-" + UUID.randomUUID() + "@example.com");
    String bob = tokenFor(UUID.randomUUID(), "bob-" + UUID.randomUUID() + "@example.com");

    String id = createItem(alice, "alice's");

    assertThat(get("/api/v1/items/" + id, alice)).hasStatus(HttpStatus.OK);
    assertProblem(get("/api/v1/items/" + id, bob), HttpStatus.NOT_FOUND, "not_found");
    assertThat(body(get("/api/v1/items", alice)).path("items")).hasSize(1);
    assertThat(body(get("/api/v1/items", bob)).path("items")).isEmpty();
  }

  @Test
  void anEmailAlreadyOwnedByAnotherAccountIsAConflictAndNothingIsMerged() {
    String email = uniqueEmail();
    Account existing =
        accounts.insert(
            new Account(
                UUID.randomUUID(), email, "hash", Instant.now().truncatedTo(ChronoUnit.MICROS)));
    UUID newcomer = UUID.randomUUID();

    MvcTestResult clash = get("/api/v1/auth/me", tokenFor(newcomer, email.toUpperCase()));
    MvcTestResult again = get("/api/v1/items", tokenFor(newcomer, email));

    assertProblem(clash, HttpStatus.CONFLICT, "identity_conflict");
    assertThat(body(clash).path("type").asString()).isEqualTo("urn:problem-type:identity-conflict");
    assertProblem(again, HttpStatus.CONFLICT, "identity_conflict");
    assertThat(accountRows(newcomer)).isZero();
    assertThat(accounts.findById(existing.id()).orElseThrow().email()).isEqualTo(email);
  }

  @Test
  void aSwitchedOffAccountIsRefusedWith403() {
    UUID sub = UUID.randomUUID();
    String token = tokenFor(sub, uniqueEmail());
    assertThat(get("/api/v1/auth/me", token)).hasStatus(HttpStatus.OK);

    jdbc.update("update accounts set is_active = false where id = ?", sub);

    MvcTestResult refused = get("/api/v1/items", token);
    assertProblem(refused, HttpStatus.FORBIDDEN, "account_disabled");
    assertProblem(get("/api/v1/auth/me", token), HttpStatus.FORBIDDEN, "account_disabled");

    jdbc.update("update accounts set is_active = true where id = ?", sub);
    assertThat(get("/api/v1/items", token)).hasStatus(HttpStatus.OK);
  }

  @Test
  void twoSimultaneousFirstRequestsBothSucceedAndCreateExactlyOneRow() throws Exception {
    int threads = 16;
    UUID sub = UUID.randomUUID();
    String email = uniqueEmail();
    CyclicBarrier startTogether = new CyclicBarrier(threads);
    List<Throwable> failures = Collections.synchronizedList(new ArrayList<>());
    try (ExecutorService pool = Executors.newFixedThreadPool(threads)) {
      List<Future<?>> done = new ArrayList<>();
      for (int i = 0; i < threads; i++) {
        done.add(
            pool.submit(
                () -> {
                  try {
                    startTogether.await();
                    provisioner.ensureKnown(sub, email);
                  } catch (Exception | AssertionError e) {
                    failures.add(e);
                  }
                }));
      }
      for (Future<?> f : done) {
        f.get();
      }
    }

    assertThat(failures).isEmpty();
    assertThat(accountRows(sub)).isEqualTo(1);
  }

  @Test
  void simultaneousFirstRequestsOverHttpAllGetTheirAnswer() throws Exception {
    int threads = 8;
    UUID sub = UUID.randomUUID();
    String token = tokenFor(sub, uniqueEmail());
    CyclicBarrier startTogether = new CyclicBarrier(threads);
    List<Integer> statuses = Collections.synchronizedList(new ArrayList<>());
    try (ExecutorService pool = Executors.newFixedThreadPool(threads)) {
      List<Future<?>> done = new ArrayList<>();
      for (int i = 0; i < threads; i++) {
        done.add(
            pool.submit(
                () -> {
                  try {
                    startTogether.await();
                    statuses.add(get("/api/v1/auth/me", token).getResponse().getStatus());
                  } catch (Exception e) {
                    statuses.add(-1);
                  }
                }));
      }
      for (Future<?> f : done) {
        f.get();
      }
    }

    assertThat(statuses).hasSize(threads).containsOnly(200);
    assertThat(accountRows(sub)).isEqualTo(1);
  }

  // ---- the local credential endpoints are off
  // ----------------------------------------------------

  @Test
  void registerAndLoginAnswer404WithAProblemWhateverIsSentAndCreateNothing() {
    String email = uniqueEmail();

    for (String path : List.of("/api/v1/auth/register", "/api/v1/auth/login")) {
      for (Object payload :
          List.of(Map.of("email", email, "password", PASSWORD), "{\"broken\":", "{}")) {
        MvcTestResult result = post(path, null, payload);
        assertProblem(result, HttpStatus.NOT_FOUND, "local_auth_disabled");
        assertThat(body(result).path("detail").asString())
            .startsWith("Local authentication is disabled")
            .contains("oidc");
      }
    }
    assertThat(
            jdbc.queryForObject(
                "select count(*) from accounts where email = ?", Integer.class, email))
        .isZero();
  }

  @Test
  void theServiceCannotMintATokenInThisMode() {
    TokenIssuer issuer = context.getBean(TokenIssuer.class);

    assertThatThrownBy(
            () -> issuer.issue(new Account(UUID.randomUUID(), "a@b.co", "x", Instant.now())))
        .isInstanceOf(LocalAuthDisabledException.class);
    assertThat(context.getBeansOfType(JwtDecoder.class)).containsOnlyKeys("oidcJwtDecoder");
  }

  @Test
  void healthProbesAndTheApiDocumentStayPublic() {
    assertThat(get("/healthz", null)).hasStatus(HttpStatus.OK);
    assertThat(get("/readyz", null)).hasStatus(HttpStatus.OK);
    assertThat(get("/v3/api-docs", null)).hasStatus(HttpStatus.OK);
  }

  // ---- every bad token is a 401 problem, never a 500
  // -----------------------------------------------

  private void assertUnauthenticated(String token) {
    MvcTestResult result = get("/api/v1/items", token);
    assertProblem(result, HttpStatus.UNAUTHORIZED, "unauthenticated");
    assertThat(result.getResponse().getHeader(HttpHeaders.WWW_AUTHENTICATE))
        .contains("invalid_token");
  }

  @Test
  void aMissingTokenIs401() {
    assertProblem(get("/api/v1/items", null), HttpStatus.UNAUTHORIZED, "unauthenticated");
  }

  @Test
  void everyKindOfBadTokenIs401() {
    FakeIdentityProvider.Token base = IDP.token();

    assertUnauthenticated(base.expiresAt(Instant.now().minusSeconds(3600)).build());
    assertUnauthenticated(IDP.token().notBefore(Instant.now().plusSeconds(3600)).build());
    assertUnauthenticated(IDP.token().issuer("http://evil.example/realms/app").build());
    assertUnauthenticated(IDP.token().audience("someone-else").build());
    assertUnauthenticated(IDP.token().buildUnsigned());
    assertUnauthenticated(IDP.token().buildHs256WithThePublicKeyAsSecret());
    assertUnauthenticated(IDP.token().buildTamperedPayload(UUID.randomUUID().toString()));
    assertUnauthenticated(IDP.token().withoutSubject().build());
    assertUnauthenticated(IDP.token().subject("not-a-uuid").build());
    assertUnauthenticated(IDP.token().keyId("never-published").build());
    assertUnauthenticated("garbage");
    assertUnauthenticated("a.b.c");
  }

  @Test
  void aTokenSignedWithAnotherRsaAlgorithmIsRefused() {
    assertUnauthenticated(IDP.token().algorithm(JWSAlgorithm.RS384).build());
  }

  @Test
  void aProviderOutageIsA401NotA500AndTheServiceRecovers() {
    var original = IDP.signingKey();
    String stranger = IDP.token().keyId("not-cached").build();
    try {
      IDP.serve(503, "");
      assertUnauthenticated(stranger);
    } finally {
      IDP.publish(original);
    }

    String good = IDP.token().subject(UUID.randomUUID()).email(uniqueEmail()).build();
    assertThat(get("/api/v1/auth/me", good)).hasStatus(HttpStatus.OK);
  }
}
