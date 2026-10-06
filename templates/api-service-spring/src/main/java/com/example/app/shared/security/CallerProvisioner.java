package com.example.app.shared.security;

import java.util.UUID;
import org.jspecify.annotations.Nullable;

/**
 * Port: makes sure the person behind a verified external token exists in this service's own tables
 * before any feature acts for them, and refuses a person whose account has been switched off. Items
 * hold a foreign key to accounts, so the account row has to be there first.
 *
 * <p>The shared kernel declares the port and the identity feature implements it, which keeps the
 * kernel free of any feature (ArchitectureTest) while the security filter chain can still call
 * "whoever provisions accounts". Only used in {@code APP_AUTH_MODE=oidc}; in local mode accounts
 * are created by registering.
 */
public interface CallerProvisioner {

  /**
   * Creates the account for {@code subject} on first sight (a no-op afterwards).
   *
   * @param subject the token's {@code sub}, which is the account id
   * @param email the token's {@code email} claim, if it carried one
   * @throws com.example.app.shared.error.ConflictException if another account already owns that
   *     email (accounts are never merged)
   * @throws com.example.app.shared.error.AccountDisabledException if the account is switched off
   */
  void ensureKnown(UUID subject, @Nullable String email);
}
