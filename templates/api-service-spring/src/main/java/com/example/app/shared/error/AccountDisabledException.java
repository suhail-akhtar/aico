package com.example.app.shared.error;

/**
 * The token is valid but the account it maps to has been switched off. Answers 403, not 401: the
 * caller is who they say they are, signing in again would not help, and a 401 would send a
 * single-page app into an endless re-login loop.
 */
public class AccountDisabledException extends DomainException {

  private static final long serialVersionUID = 1L;

  public AccountDisabledException() {
    super("account_disabled", "This account is disabled.");
  }
}
