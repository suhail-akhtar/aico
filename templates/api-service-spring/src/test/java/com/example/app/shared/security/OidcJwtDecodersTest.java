package com.example.app.shared.security;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatCode;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.awaitility.Awaitility.await;

import com.example.app.shared.config.AppProperties;
import com.example.app.support.FakeIdentityProvider;
import com.nimbusds.jose.JWSAlgorithm;
import com.nimbusds.jose.jwk.RSAKey;
import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.UUID;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.springframework.security.oauth2.jwt.BadJwtException;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.security.oauth2.jwt.JwtDecoder;
import org.springframework.security.oauth2.jwt.JwtException;

/**
 * The OIDC token checks, one attack or mistake per test, against a throwaway provider that lives in
 * this JVM (no network, no Keycloak). Every rejection must be a {@link BadJwtException}: that is
 * what the filter chain turns into a 401, while any other exception would become a server error.
 */
class OidcJwtDecodersTest {

  private static FakeIdentityProvider idp;
  private static JwtDecoder decoder;

  @BeforeAll
  static void startProvider() {
    idp = FakeIdentityProvider.start();
    decoder = decoderFor(idp, Duration.ofSeconds(1), Duration.ofSeconds(30));
  }

  @AfterAll
  static void stopProvider() {
    idp.close();
  }

  private static JwtDecoder decoderFor(
      FakeIdentityProvider provider, Duration minRefresh, Duration skew) {
    return OidcJwtDecoders.create(
        new AppProperties.Oidc(
            FakeIdentityProvider.ISSUER,
            provider.jwksUri(),
            FakeIdentityProvider.AUDIENCE,
            skew,
            minRefresh));
  }

  private static void assertRejected(String token) {
    assertThatThrownBy(() -> decoder.decode(token)).isInstanceOf(BadJwtException.class);
  }

  @Test
  void aValidTokenIsAcceptedAndExposesItsClaims() {
    UUID subject = UUID.randomUUID();

    Jwt jwt = decoder.decode(idp.token().subject(subject).email("Ada@Example.com").build());

    assertThat(jwt.getSubject()).isEqualTo(subject.toString());
    assertThat(jwt.getClaimAsString("email")).isEqualTo("Ada@Example.com");
    assertThat(jwt.getAudience()).containsExactly(FakeIdentityProvider.AUDIENCE);
  }

  @Test
  void anAudienceListContainingTheExpectedValueIsAccepted() {
    assertThatCode(
            () ->
                decoder.decode(
                    idp.token()
                        .audience(List.of("account", FakeIdentityProvider.AUDIENCE))
                        .build()))
        .doesNotThrowAnyException();
  }

  @Test
  void anExpiredTokenIsRejected() {
    assertRejected(idp.token().expiresAt(Instant.now().minusSeconds(3600)).build());
  }

  @Test
  void aTokenJustInsideTheClockSkewIsAcceptedAndJustOutsideIsNot() {
    assertThatCode(
            () -> decoder.decode(idp.token().expiresAt(Instant.now().minusSeconds(10)).build()))
        .doesNotThrowAnyException();
    assertRejected(idp.token().expiresAt(Instant.now().minusSeconds(120)).build());
  }

  @Test
  void aTokenThatIsNotYetValidIsRejected() {
    assertRejected(idp.token().notBefore(Instant.now().plusSeconds(3600)).build());
  }

  @Test
  void aTokenWithoutAnExpiryIsRejected() {
    assertRejected(idp.token().withoutExpiry().build());
  }

  @Test
  void aWrongIssuerIsRejectedEvenIfItDiffersOnlyByATrailingSlash() {
    assertRejected(idp.token().issuer("http://localhost:8080/idp/realms/other").build());
    assertRejected(idp.token().issuer(FakeIdentityProvider.ISSUER + "/").build());
    assertRejected(idp.token().issuer(FakeIdentityProvider.ISSUER.toUpperCase()).build());
  }

  @Test
  void aWrongAudienceIsRejected() {
    assertRejected(idp.token().audience("billing-api").build());
    assertRejected(idp.token().audience(List.of("account", "billing-api")).build());
  }

  @Test
  void aTokenWithoutASubjectOrWithANonUuidSubjectIsRejected() {
    assertRejected(idp.token().withoutSubject().build());
    assertRejected(idp.token().subject("alice").build());
    assertRejected(idp.token().subject("").build());
    assertRejected(idp.token().subject("12345").build());
  }

  @Test
  void algNoneIsRejected() {
    assertRejected(idp.token().buildUnsigned());
  }

  @Test
  void anHs256TokenSignedWithThePublicKeyAsTheSecretIsRejected() {
    assertRejected(idp.token().buildHs256WithThePublicKeyAsSecret());
  }

  @Test
  void anRsaTokenWithAnotherAlgorithmThanRs256IsRejected() {
    assertRejected(idp.token().algorithm(JWSAlgorithm.RS384).build());
    assertRejected(idp.token().algorithm(JWSAlgorithm.PS256).build());
  }

  @Test
  void aTamperedPayloadIsRejected() {
    assertRejected(idp.token().buildTamperedPayload(UUID.randomUUID().toString()));
  }

  @Test
  void aTokenSignedWithAnUnpublishedKeyUnderARealKeyIdIsRejected() {
    RSAKey rogue = FakeIdentityProvider.newKey("key-1");

    assertRejected(idp.token().signedWith(rogue).build());
  }

  @Test
  void garbageAndEmptyInputAreRejectedNotCrashed() {
    for (String garbage : List.of("", "not.a.jwt", "a.b.c", "....", "eyJhbGciOiJSUzI1NiJ9.e30.")) {
      assertRejected(garbage);
    }
  }

  @Test
  void aKeyRotationIsPickedUpThroughAnUnknownKeyIdOnceTheRefetchWindowAllowsIt() {
    try (var provider = FakeIdentityProvider.start()) {
      JwtDecoder local = decoderFor(provider, Duration.ofSeconds(1), Duration.ofSeconds(30));
      assertThatCode(() -> local.decode(provider.token().build())).doesNotThrowAnyException();

      RSAKey rotated = FakeIdentityProvider.newKey("key-2");
      provider.publish(rotated);
      String token = provider.token().build();

      // Inside the rate-limit window the unknown kid is refused rather than refetched; once the
      // window has passed the refetch happens, finds key-2 and the very same token verifies.
      await()
          .atMost(Duration.ofSeconds(10))
          .pollInterval(Duration.ofMillis(200))
          .untilAsserted(() -> assertThat(local.decode(token).getSubject()).isNotBlank());
    }
  }

  @Test
  void aFloodOfTokensWithInventedKeyIdsDoesNotHammerTheProvider() {
    try (var provider = FakeIdentityProvider.start()) {
      JwtDecoder local = decoderFor(provider, Duration.ofSeconds(30), Duration.ofSeconds(30));
      assertThatCode(() -> local.decode(provider.token().build())).doesNotThrowAnyException();
      int before = provider.fetchCount();

      for (int i = 0; i < 100; i++) {
        String bad = provider.token().keyId("invented-" + i).build();
        assertThatThrownBy(() -> local.decode(bad)).isInstanceOf(BadJwtException.class);
      }

      assertThat(provider.fetchCount() - before).isLessThanOrEqualTo(1);
    }
  }

  @Test
  void aProviderOutageIsA401NotAServerErrorAndTheServiceRecovers() {
    try (var provider = FakeIdentityProvider.start()) {
      JwtDecoder local = decoderFor(provider, Duration.ofSeconds(1), Duration.ofSeconds(30));
      RSAKey fresh = FakeIdentityProvider.newKey("after-outage");
      provider.serve(503, "");
      String token = provider.token().keyId("after-outage").build();

      assertThatThrownBy(() -> local.decode(token)).isInstanceOf(BadJwtException.class);

      provider.publish(fresh);
      String good = provider.token().build();
      await()
          .atMost(Duration.ofSeconds(10))
          .pollInterval(Duration.ofMillis(200))
          .untilAsserted(() -> assertThat(local.decode(good).getSubject()).isNotBlank());
    }
  }

  @Test
  void aMalformedKeySetIsA401NotAServerError() {
    try (var provider = FakeIdentityProvider.start()) {
      JwtDecoder local = decoderFor(provider, Duration.ofSeconds(1), Duration.ofSeconds(30));
      String token = provider.token().build();
      provider.serve(200, "this is not json");

      assertThatThrownBy(() -> local.decode(token)).isInstanceOf(BadJwtException.class);
    }
  }

  @Test
  void aBadJwksUriFailsStartupInsteadOfAtTheFirstRequest() {
    var bad =
        new AppProperties.Oidc(
            "iss", "not a uri", "aud", Duration.ofSeconds(30), Duration.ofSeconds(30));

    assertThatThrownBy(() -> OidcJwtDecoders.create(bad))
        .isInstanceOf(IllegalStateException.class)
        .hasMessageContaining("OIDC_JWKS_URI");
  }

  @Test
  void theFailClosedWrapperTurnsEveryNonBadFailureIntoABadToken() {
    JwtDecoder throwsPlain =
        token -> {
          throw new JwtException("keys unavailable");
        };
    JwtDecoder throwsRuntime =
        token -> {
          throw new IllegalStateException("boom");
        };
    JwtDecoder throwsBad =
        token -> {
          throw new BadJwtException("bad");
        };
    JwtDecoder rateLimited =
        token -> {
          throw new JwtException("x", new RateLimitReachedException());
        };

    for (JwtDecoder inner : List.of(throwsPlain, throwsRuntime, throwsBad, rateLimited)) {
      var wrapped = new OidcJwtDecoders.FailClosedJwtDecoder(inner);
      assertThatThrownBy(() -> wrapped.decode("t")).isInstanceOf(BadJwtException.class);
    }
    assertThatThrownBy(() -> new OidcJwtDecoders.FailClosedJwtDecoder(throwsBad).decode("t"))
        .hasMessage("bad");
  }

  /** Named like Nimbus's own exception, which the wrapper recognises by name. */
  private static final class RateLimitReachedException extends RuntimeException {
    private static final long serialVersionUID = 1L;
  }
}
