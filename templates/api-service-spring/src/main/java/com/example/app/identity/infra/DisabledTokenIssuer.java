package com.example.app.identity.infra;

import com.example.app.identity.domain.Account;
import com.example.app.identity.domain.TokenIssuer;
import com.example.app.shared.error.LocalAuthDisabledException;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.stereotype.Component;

/**
 * The {@link TokenIssuer} in {@code APP_AUTH_MODE=oidc}: tokens come from the identity provider, so
 * this service must never mint one. The login endpoint already answers 404 in this mode; this is
 * the second lock, so a route added later by mistake still cannot hand out a token.
 */
@Component
@ConditionalOnProperty(prefix = "app.auth", name = "mode", havingValue = "oidc")
class DisabledTokenIssuer implements TokenIssuer {

  @Override
  public IssuedToken issue(Account account) {
    throw new LocalAuthDisabledException();
  }
}
