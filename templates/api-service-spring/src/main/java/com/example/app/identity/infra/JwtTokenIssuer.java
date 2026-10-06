package com.example.app.identity.infra;

import com.example.app.identity.domain.Account;
import com.example.app.identity.domain.TokenIssuer;
import com.example.app.shared.config.AppProperties;
import com.example.app.shared.security.JwtKeys;
import com.nimbusds.jose.jwk.source.ImmutableSecret;
import java.time.Clock;
import java.time.Instant;
import java.util.List;
import java.util.UUID;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.security.oauth2.jose.jws.MacAlgorithm;
import org.springframework.security.oauth2.jwt.JwsHeader;
import org.springframework.security.oauth2.jwt.JwtClaimsSet;
import org.springframework.security.oauth2.jwt.JwtEncoder;
import org.springframework.security.oauth2.jwt.JwtEncoderParameters;
import org.springframework.security.oauth2.jwt.NimbusJwtEncoder;
import org.springframework.stereotype.Component;

/**
 * The local token issuer: signs short-lived HS256 JWTs with the key the resource server verifies.
 * Swap this adapter (and the decoder bean) for an external OIDC provider without touching any use
 * case; see docs/EXTENDING.md. Exists only in {@code APP_AUTH_MODE=local}: in oidc mode there is no
 * signing secret, so there is nothing to build (see {@link DisabledTokenIssuer}).
 */
@Component
@ConditionalOnProperty(
    prefix = "app.auth",
    name = "mode",
    havingValue = "local",
    matchIfMissing = true)
class JwtTokenIssuer implements TokenIssuer {

  private final JwtEncoder encoder;
  private final AppProperties.Jwt config;
  private final Clock clock;

  JwtTokenIssuer(AppProperties props, Clock clock) {
    this.config = props.jwt();
    this.clock = clock;
    this.encoder = new NimbusJwtEncoder(new ImmutableSecret<>(JwtKeys.secretKey(config)));
  }

  @Override
  public IssuedToken issue(Account account) {
    Instant now = clock.instant();
    JwtClaimsSet claims =
        JwtClaimsSet.builder()
            .issuer(config.issuer())
            .audience(List.of(config.audience()))
            .subject(account.id().toString())
            .issuedAt(now)
            .expiresAt(now.plus(config.ttl()))
            .id(UUID.randomUUID().toString())
            .claim("email", account.email())
            .build();
    JwsHeader header = JwsHeader.with(MacAlgorithm.HS256).build();
    String token = encoder.encode(JwtEncoderParameters.from(header, claims)).getTokenValue();
    return new IssuedToken(token, config.ttl().toSeconds());
  }
}
