package com.example.app.support;

import com.nimbusds.jose.JOSEException;
import com.nimbusds.jose.JOSEObjectType;
import com.nimbusds.jose.JWSAlgorithm;
import com.nimbusds.jose.JWSHeader;
import com.nimbusds.jose.crypto.MACSigner;
import com.nimbusds.jose.crypto.RSASSASigner;
import com.nimbusds.jose.jwk.JWKSet;
import com.nimbusds.jose.jwk.RSAKey;
import com.nimbusds.jose.jwk.gen.RSAKeyGenerator;
import com.nimbusds.jwt.JWTClaimsSet;
import com.nimbusds.jwt.PlainJWT;
import com.nimbusds.jwt.SignedJWT;
import com.sun.net.httpserver.HttpServer;
import java.io.IOException;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.Date;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * A stand-in for an OIDC provider that exists only inside the test JVM: a JDK HTTP server on a
 * loopback port that serves a JWKS document, plus a builder for access tokens signed with keys
 * generated on the spot. Nothing leaves the machine and no real provider (Keycloak) is involved, so
 * the resource-server tests are deterministic and need no network.
 *
 * <p>The tests drive it like an operator drives a real provider: publish a different key set to
 * simulate a rotation, make the endpoint fail to simulate an outage, and count how often the
 * service fetched keys to prove the refetch rate limit.
 */
public final class FakeIdentityProvider implements AutoCloseable {

  /** What the service under test is configured to expect (not a URL anything fetches). */
  public static final String ISSUER = "http://localhost:8080/idp/realms/app";

  public static final String AUDIENCE = "app-api";

  private final HttpServer server;
  private final AtomicInteger fetches = new AtomicInteger();
  private volatile String body = "{\"keys\":[]}";
  private volatile int status = 200;
  private volatile RSAKey signingKey;

  private FakeIdentityProvider(HttpServer server) {
    this.server = server;
  }

  /** Starts the server with one freshly generated signing key published (kid {@code key-1}). */
  public static FakeIdentityProvider start() {
    try {
      HttpServer server =
          HttpServer.create(new InetSocketAddress(InetAddress.getLoopbackAddress(), 0), 0);
      FakeIdentityProvider idp = new FakeIdentityProvider(server);
      server.createContext(
          "/certs",
          exchange -> {
            idp.fetches.incrementAndGet();
            byte[] bytes = idp.body.getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().add("Content-Type", "application/json");
            exchange.sendResponseHeaders(idp.status, idp.status == 200 ? bytes.length : -1);
            if (idp.status == 200) {
              exchange.getResponseBody().write(bytes);
            }
            exchange.close();
          });
      server.start();
      idp.signingKey = newKey("key-1");
      idp.publish(idp.signingKey);
      return idp;
    } catch (IOException e) {
      throw new IllegalStateException("could not start the fake identity provider", e);
    }
  }

  public static RSAKey newKey(String kid) {
    try {
      return new RSAKeyGenerator(2048).keyID(kid).generate();
    } catch (JOSEException e) {
      throw new IllegalStateException(e);
    }
  }

  public String jwksUri() {
    return "http://"
        + server.getAddress().getHostString()
        + ":"
        + server.getAddress().getPort()
        + "/certs";
  }

  /** Replaces the published key set (public halves only, like a real provider). */
  public void publish(RSAKey... keys) {
    JWKSet set = new JWKSet(List.of(keys)).toPublicJWKSet();
    this.body = set.toString();
    this.status = 200;
    this.signingKey = keys[0];
  }

  /** Serves the given raw body with the given HTTP status, to simulate an outage or garbage. */
  public void serve(int httpStatus, String rawBody) {
    this.status = httpStatus;
    this.body = rawBody;
  }

  public RSAKey signingKey() {
    return signingKey;
  }

  public int fetchCount() {
    return fetches.get();
  }

  @Override
  public void close() {
    server.stop(0);
  }

  /** A token valid in every respect; each method breaks exactly one thing. */
  public Token token() {
    return new Token(signingKey);
  }

  /** Builds and signs access tokens. */
  public static final class Token {

    private final RSAKey key;
    private String subject = UUID.randomUUID().toString();
    private String email = null;
    private boolean emailSet = false;
    private String issuer = ISSUER;
    private Object audience = AUDIENCE;
    private Instant issuedAt = Instant.now().minusSeconds(10);
    private Instant expires = Instant.now().plusSeconds(300);
    private Instant notBefore = null;
    private boolean omitSubject = false;
    private boolean omitExpiry = false;
    private String kid;
    private JWSAlgorithm algorithm = JWSAlgorithm.RS256;

    private Token(RSAKey key) {
      this.key = key;
      this.kid = key.getKeyID();
    }

    public Token subject(String value) {
      this.subject = value;
      return this;
    }

    public Token subject(UUID value) {
      return subject(value.toString());
    }

    public Token withoutSubject() {
      this.omitSubject = true;
      return this;
    }

    public Token email(String value) {
      this.email = value;
      this.emailSet = true;
      return this;
    }

    public Token issuer(String value) {
      this.issuer = value;
      return this;
    }

    public Token audience(Object valueOrList) {
      this.audience = valueOrList;
      return this;
    }

    public Token expiresAt(Instant value) {
      this.expires = value;
      return this;
    }

    public Token withoutExpiry() {
      this.omitExpiry = true;
      return this;
    }

    public Token notBefore(Instant value) {
      this.notBefore = value;
      return this;
    }

    public Token keyId(String value) {
      this.kid = value;
      return this;
    }

    public Token algorithm(JWSAlgorithm value) {
      this.algorithm = value;
      return this;
    }

    public Token signedWith(RSAKey other) {
      return new Token(other).copyClaimsFrom(this);
    }

    private Token copyClaimsFrom(Token o) {
      this.subject = o.subject;
      this.email = o.email;
      this.emailSet = o.emailSet;
      this.issuer = o.issuer;
      this.audience = o.audience;
      this.issuedAt = o.issuedAt;
      this.expires = o.expires;
      this.notBefore = o.notBefore;
      this.omitSubject = o.omitSubject;
      this.omitExpiry = o.omitExpiry;
      return this;
    }

    public String subjectValue() {
      return subject;
    }

    JWTClaimsSet claims() {
      JWTClaimsSet.Builder claims =
          new JWTClaimsSet.Builder()
              .issuer(issuer)
              .issueTime(
                  Date.from(
                      issuedAt.isBefore(expires.minusSeconds(2))
                          ? issuedAt
                          : expires.minusSeconds(60)))
              .jwtID(UUID.randomUUID().toString());
      if (audience instanceof List<?> list) {
        claims.audience(list.stream().map(String::valueOf).toList());
      } else {
        claims.audience(String.valueOf(audience));
      }
      if (!omitSubject) {
        claims.subject(subject);
      }
      if (!omitExpiry) {
        claims.expirationTime(Date.from(expires));
      }
      if (notBefore != null) {
        claims.notBeforeTime(Date.from(notBefore));
      }
      if (emailSet) {
        claims.claim("email", email);
      }
      claims.claim("preferred_username", "someone");
      return claims.build();
    }

    /** Signed with the key's private half, RS256 unless {@link #algorithm} says otherwise. */
    public String build() {
      try {
        SignedJWT jwt =
            new SignedJWT(
                new JWSHeader.Builder(algorithm).keyID(kid).type(JOSEObjectType.JWT).build(),
                claims());
        jwt.sign(new RSASSASigner(key));
        return jwt.serialize();
      } catch (JOSEException e) {
        throw new IllegalStateException(e);
      }
    }

    /** {@code alg: none}: an unsigned token carrying valid claims. */
    public String buildUnsigned() {
      return new PlainJWT(claims()).serialize();
    }

    /**
     * The classic algorithm-confusion forgery: HS256, with the provider's PUBLIC key bytes as the
     * HMAC secret, under the real key's id. A verifier that lets the token choose the algorithm
     * would accept it.
     */
    public String buildHs256WithThePublicKeyAsSecret() {
      try {
        byte[] secret = key.toRSAPublicKey().getEncoded();
        SignedJWT jwt =
            new SignedJWT(
                new JWSHeader.Builder(JWSAlgorithm.HS256)
                    .keyID(kid)
                    .type(JOSEObjectType.JWT)
                    .build(),
                claims());
        jwt.sign(new MACSigner(secret));
        return jwt.serialize();
      } catch (JOSEException e) {
        throw new IllegalStateException(e);
      }
    }

    /** A valid token whose payload was swapped for another subject after signing. */
    public String buildTamperedPayload(String otherSubject) {
      String[] parts = build().split("\\.");
      JWTClaimsSet forged = new JWTClaimsSet.Builder(claims()).subject(otherSubject).build();
      String payload =
          java.util.Base64.getUrlEncoder()
              .withoutPadding()
              .encodeToString(forged.toString().getBytes(StandardCharsets.UTF_8));
      return parts[0] + "." + payload + "." + parts[2];
    }
  }
}
