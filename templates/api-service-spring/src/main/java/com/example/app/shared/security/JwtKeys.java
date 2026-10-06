package com.example.app.shared.security;

import com.example.app.shared.config.AppProperties;
import java.nio.charset.StandardCharsets;
import java.util.Objects;
import javax.crypto.SecretKey;
import javax.crypto.spec.SecretKeySpec;

/**
 * Derives the HMAC key from configuration, shared by the local issuer (signs) and the resource
 * server (verifies) so the two cannot drift apart. HS256 with a 32-byte-minimum secret is enough
 * while one service both issues and checks tokens; move to an asymmetric key (or an external OIDC
 * issuer) when other services must verify tokens without being able to mint them. Only used in
 * {@code APP_AUTH_MODE=local}; in oidc mode there is no secret and nothing here is called.
 */
public final class JwtKeys {

  private JwtKeys() {}

  public static SecretKey secretKey(AppProperties.Jwt jwt) {
    String secret = Objects.requireNonNull(jwt.secret(), "APP_JWT_SECRET is not set");
    return new SecretKeySpec(secret.getBytes(StandardCharsets.UTF_8), "HmacSHA256");
  }
}
