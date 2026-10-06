package com.example.app.shared.security;

import com.example.app.shared.config.AppProperties;
import com.nimbusds.jose.jwk.source.JWKSource;
import com.nimbusds.jose.jwk.source.JWKSourceBuilder;
import com.nimbusds.jose.proc.SecurityContext;
import com.nimbusds.jose.util.DefaultResourceRetriever;
import java.net.MalformedURLException;
import java.net.URI;
import java.net.URL;
import java.time.Duration;
import java.util.List;
import java.util.Objects;
import java.util.UUID;
import org.jspecify.annotations.Nullable;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.security.oauth2.core.DelegatingOAuth2TokenValidator;
import org.springframework.security.oauth2.core.OAuth2TokenValidator;
import org.springframework.security.oauth2.jose.jws.SignatureAlgorithm;
import org.springframework.security.oauth2.jwt.BadJwtException;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.security.oauth2.jwt.JwtClaimNames;
import org.springframework.security.oauth2.jwt.JwtClaimValidator;
import org.springframework.security.oauth2.jwt.JwtDecoder;
import org.springframework.security.oauth2.jwt.JwtException;
import org.springframework.security.oauth2.jwt.JwtIssuerValidator;
import org.springframework.security.oauth2.jwt.JwtTimestampValidator;
import org.springframework.security.oauth2.jwt.NimbusJwtDecoder;

/**
 * Builds the decoder for {@code APP_AUTH_MODE=oidc}: verifies access tokens an external provider
 * signed, entirely in this process (a gateway that already checked them is never taken at its
 * word).
 *
 * <p>What is checked, and why each is explicit rather than left to a default:
 *
 * <ul>
 *   <li><b>Signature, RS256 only.</b> The key selector is pinned to RS256, so {@code alg: none},
 *       HS256 "signed with the public key as the secret" and every other algorithm find no matching
 *       key and are rejected. Keys come from the JWKS URI, which is configured separately from the
 *       issuer because inside a container network the provider is reached at a different address
 *       than the browser sees.
 *   <li><b>Key fetching is bounded.</b> The key set is cached; an unknown {@code kid} triggers one
 *       refetch (that is how a key rotation is picked up) but refetches are rate limited, so a
 *       flood of tokens with invented key ids cannot turn this service into a load generator
 *       against the provider. Each fetch has connect and read timeouts and a size cap.
 *   <li><b>Claims.</b> {@code exp} is required (Spring's timestamp validator alone ignores a
 *       missing one), {@code nbf} is honoured, the clock-skew leeway is capped at 60 s, {@code iss}
 *       must equal the configured issuer exactly, {@code aud} must contain the configured audience
 *       and {@code sub} must be a UUID (it becomes the account id).
 * </ul>
 *
 * <p>Every failure to verify, including the provider being unreachable, ends as a 401 rather than a
 * 500: {@link FailClosedJwtDecoder} turns the exceptions Spring Security would leave to become a
 * server error into the same invalid-token answer.
 */
final class OidcJwtDecoders {

  private static final Logger LOG = LoggerFactory.getLogger(OidcJwtDecoders.class);

  private static final int JWKS_CONNECT_TIMEOUT_MS = 2_000;
  private static final int JWKS_READ_TIMEOUT_MS = 3_000;
  private static final int JWKS_SIZE_LIMIT_BYTES = 128 * 1024;
  private static final long JWKS_CACHE_TTL_MS = Duration.ofMinutes(5).toMillis();
  private static final long JWKS_CACHE_REFRESH_TIMEOUT_MS = Duration.ofSeconds(10).toMillis();

  private OidcJwtDecoders() {}

  static JwtDecoder create(AppProperties.Oidc oidc) {
    return new FailClosedJwtDecoder(delegate(oidc));
  }

  private static JwtDecoder delegate(AppProperties.Oidc oidc) {
    NimbusJwtDecoder decoder =
        NimbusJwtDecoder.withJwkSource(jwkSource(oidc))
            .jwsAlgorithm(SignatureAlgorithm.RS256)
            .build();
    decoder.setJwtValidator(validators(oidc));
    return decoder;
  }

  private static JWKSource<SecurityContext> jwkSource(AppProperties.Oidc oidc) {
    URL url;
    try {
      url = URI.create(Objects.requireNonNull(oidc.jwksUri(), "OIDC_JWKS_URI")).toURL();
    } catch (MalformedURLException | IllegalArgumentException e) {
      // AppProperties validates this at startup; reaching here means it was bypassed.
      throw new IllegalStateException("OIDC_JWKS_URI is not a usable URL", e);
    }
    return JWKSourceBuilder.create(
            url,
            new DefaultResourceRetriever(
                JWKS_CONNECT_TIMEOUT_MS, JWKS_READ_TIMEOUT_MS, JWKS_SIZE_LIMIT_BYTES))
        .cache(JWKS_CACHE_TTL_MS, JWKS_CACHE_REFRESH_TIMEOUT_MS)
        .rateLimited(oidc.jwksMinRefresh().toMillis())
        .retrying(false)
        .build();
  }

  static OAuth2TokenValidator<Jwt> validators(AppProperties.Oidc oidc) {
    String audience = Objects.requireNonNull(oidc.audience(), "OIDC_AUDIENCE");
    return new DelegatingOAuth2TokenValidator<>(
        new JwtTimestampValidator(oidc.clockSkew()),
        new JwtClaimValidator<Object>(JwtClaimNames.EXP, Objects::nonNull),
        new JwtIssuerValidator(Objects.requireNonNull(oidc.issuer(), "OIDC_ISSUER")),
        new JwtClaimValidator<List<String>>(
            JwtClaimNames.AUD, aud -> aud != null && aud.contains(audience)),
        new JwtClaimValidator<String>(JwtClaimNames.SUB, OidcJwtDecoders::isUuid));
  }

  private static boolean isUuid(@Nullable String subject) {
    if (subject == null) {
      return false;
    }
    try {
      UUID.fromString(subject);
      return true;
    } catch (IllegalArgumentException notAUuid) {
      return false;
    }
  }

  /**
   * Spring Security answers "this token is bad" with a {@link BadJwtException} (a 401) but a
   * failure to even look the key up, such as the provider being down or a refetch being rate
   * limited, with a plain {@link JwtException}, which its filter rethrows as a server error. A
   * caller cannot be authenticated in either case, so both are the same invalid-token 401; the
   * cause is logged for the operator and never sent to the caller.
   */
  static final class FailClosedJwtDecoder implements JwtDecoder {

    private final JwtDecoder delegate;

    FailClosedJwtDecoder(JwtDecoder delegate) {
      this.delegate = delegate;
    }

    @Override
    public Jwt decode(String token) throws JwtException {
      try {
        return delegate.decode(token);
      } catch (BadJwtException bad) {
        throw bad;
      } catch (RuntimeException unverifiable) {
        // Rate-limited refetches are expected under a bad-kid flood: keep them out of WARN.
        if (rateLimited(unverifiable)) {
          LOG.debug("Token refused: key set refetch is rate limited");
        } else {
          LOG.warn("Token could not be verified: {}", unverifiable.getMessage());
        }
        throw new BadJwtException("The token could not be verified", unverifiable);
      }
    }

    private static boolean rateLimited(Throwable failure) {
      for (Throwable t = failure; t != null; t = t.getCause()) {
        if (t.getClass().getSimpleName().equals("RateLimitReachedException")) {
          return true;
        }
      }
      return false;
    }
  }
}
