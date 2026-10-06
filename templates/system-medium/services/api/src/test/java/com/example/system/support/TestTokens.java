package com.example.system.support;

import com.example.system.identity.security.AudienceValidator;
import com.nimbusds.jose.jwk.source.ImmutableSecret;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.List;
import java.util.UUID;
import javax.crypto.SecretKey;
import javax.crypto.spec.SecretKeySpec;
import org.springframework.security.oauth2.jose.jws.MacAlgorithm;
import org.springframework.security.oauth2.jwt.JwsHeader;
import org.springframework.security.oauth2.jwt.JwtClaimsSet;
import org.springframework.security.oauth2.jwt.JwtDecoder;
import org.springframework.security.oauth2.jwt.JwtEncoderParameters;
import org.springframework.security.oauth2.jwt.NimbusJwtDecoder;
import org.springframework.security.oauth2.jwt.NimbusJwtEncoder;

/**
 * Real, signed bearer tokens for the tests. The identity provider signs with RSA keys it publishes;
 * here a throwaway HMAC key stands in so the tests need no network, but the decoder uses the same
 * validators as production ({@link AudienceValidator#forIssuer}), so expiry, issuer and audience
 * are genuinely enforced.
 */
public final class TestTokens {

  public static final String ISSUER = "http://idp.test/realms/app";
  public static final String AUDIENCE = "system-api";

  /** A fake key that exists only in the test JVM. */
  private static final SecretKey KEY =
      new SecretKeySpec(
          "test-only-fake-signing-key-0123456789abcdef".getBytes(StandardCharsets.UTF_8),
          "HmacSHA256");

  private TestTokens() {}

  public static JwtDecoder decoder() {
    NimbusJwtDecoder decoder =
        NimbusJwtDecoder.withSecretKey(KEY).macAlgorithm(MacAlgorithm.HS256).build();
    decoder.setJwtValidator(AudienceValidator.forIssuer(ISSUER, AUDIENCE));
    return decoder;
  }

  /** A valid token for {@code subject}, expiring in an hour, minted for this API. */
  public static String valid(UUID subject, String email, List<String> roles) {
    return mint(subject, email, roles, ISSUER, List.of(AUDIENCE), Instant.now().plusSeconds(3600));
  }

  public static String mint(
      UUID subject,
      String email,
      List<String> roles,
      String issuer,
      List<String> audience,
      Instant expiresAt) {
    // Always before the expiry, even for a token minted already expired.
    Instant issuedAt = Instant.now().minusSeconds(10);
    if (!issuedAt.isBefore(expiresAt)) {
      issuedAt = expiresAt.minusSeconds(60);
    }
    JwtClaimsSet claims =
        JwtClaimsSet.builder()
            .issuer(issuer)
            .audience(audience)
            .subject(subject.toString())
            .issuedAt(issuedAt)
            .expiresAt(expiresAt)
            .claim("email", email)
            .claim("roles", roles)
            .build();
    return new NimbusJwtEncoder(new ImmutableSecret<>(KEY))
        .encode(JwtEncoderParameters.from(JwsHeader.with(MacAlgorithm.HS256).build(), claims))
        .getTokenValue();
  }

  /** The same token with one character of its signature changed. */
  public static String tampered(String token) {
    char last = token.charAt(token.length() - 1);
    return token.substring(0, token.length() - 1) + (last == 'A' ? 'B' : 'A');
  }
}
