package com.example.app.identity.domain;

/** Port: mints an access token for an account. The local JWT issuer is one adapter. */
public interface TokenIssuer {

  /** The token and how long it lives. */
  record IssuedToken(String value, long expiresInSeconds) {}

  IssuedToken issue(Account account);
}
