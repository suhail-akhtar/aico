/**
 * Identity: who is calling. Sign-in is delegated to the OIDC identity provider (Keycloak); this
 * module turns the result into a server-side session for browsers (the backend-for-frontend
 * pattern, RFC 10017) and accepts bearer tokens from machine clients. The only type other modules
 * may use is {@link com.example.system.identity.AuthenticatedUser}.
 */
@ApplicationModule(displayName = "Identity", allowedDependencies = "shared")
package com.example.system.identity;

import org.springframework.modulith.ApplicationModule;
