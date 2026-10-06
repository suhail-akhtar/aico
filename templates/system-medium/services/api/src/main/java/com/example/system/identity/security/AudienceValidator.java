package com.example.system.identity.security;

import java.util.List;
import org.springframework.security.oauth2.core.DelegatingOAuth2TokenValidator;
import org.springframework.security.oauth2.core.OAuth2Error;
import org.springframework.security.oauth2.core.OAuth2TokenValidator;
import org.springframework.security.oauth2.core.OAuth2TokenValidatorResult;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.security.oauth2.jwt.JwtValidators;

/**
 * Refuses a token that was not minted for this API. A realm can hold many clients; a valid
 * signature and issuer only prove the token came from the same identity provider, not that its
 * holder meant to talk to this service. Without this check, a token issued to any other application
 * in the realm would open this API (the "confused deputy" problem).
 */
public final class AudienceValidator implements OAuth2TokenValidator<Jwt> {

  private static final OAuth2Error WRONG_AUDIENCE =
      new OAuth2Error("invalid_token", "The token was not issued for this API", null);

  private final String audience;

  AudienceValidator(String audience) {
    this.audience = audience;
  }

  /**
   * Everything a bearer token must satisfy: the default checks (expiry, not-before), the issuer,
   * and this audience. One definition, used by the production decoder and by the tests that mint
   * tokens, so the rule that is tested is the rule that runs.
   */
  public static OAuth2TokenValidator<Jwt> forIssuer(String issuer, String audience) {
    return new DelegatingOAuth2TokenValidator<>(
        JwtValidators.createDefaultWithIssuer(issuer), new AudienceValidator(audience));
  }

  @Override
  public OAuth2TokenValidatorResult validate(Jwt token) {
    List<String> audiences = token.getAudience();
    return audiences != null && audiences.contains(audience)
        ? OAuth2TokenValidatorResult.success()
        : OAuth2TokenValidatorResult.failure(WRONG_AUDIENCE);
  }
}
