package com.example.app.shared.error;

/**
 * A local credential endpoint (register, login) was called while the service runs in {@code
 * APP_AUTH_MODE=oidc}: accounts and passwords belong to the identity provider then, and this
 * service has no key to sign a token with. Answers 404, as if the route did not exist, so a client
 * cannot mistake it for a bad password.
 */
public class LocalAuthDisabledException extends DomainException {

  private static final long serialVersionUID = 1L;

  public LocalAuthDisabledException() {
    super("local_auth_disabled", "Local authentication is disabled: APP_AUTH_MODE=oidc");
  }
}
