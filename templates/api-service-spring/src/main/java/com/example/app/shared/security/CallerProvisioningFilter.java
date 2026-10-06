package com.example.app.shared.security;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.security.oauth2.server.resource.authentication.JwtAuthenticationToken;
import org.springframework.web.filter.OncePerRequestFilter;
import org.springframework.web.servlet.HandlerExceptionResolver;

/**
 * Runs right after the bearer token has been verified (OIDC mode only) and gives the verified
 * caller an account row, or refuses them, before a controller runs. It is a filter rather than a
 * token-to-authentication converter because a converter's failures are not routed through {@code
 * ProblemDetailsAdvice}; here a conflict or a disabled account leaves as the same RFC 9457 problem
 * as every other error.
 *
 * <p>It costs one primary-key read per authenticated request. Cache the "known and active" answer
 * for a few seconds if that ever shows up in a profile; correctness does not depend on it.
 */
public class CallerProvisioningFilter extends OncePerRequestFilter {

  private final CallerProvisioner provisioner;
  private final HandlerExceptionResolver resolver;

  public CallerProvisioningFilter(
      CallerProvisioner provisioner, HandlerExceptionResolver resolver) {
    this.provisioner = provisioner;
    this.resolver = resolver;
  }

  @Override
  protected void doFilterInternal(
      HttpServletRequest request, HttpServletResponse response, FilterChain chain)
      throws ServletException, IOException {
    Authentication authentication = SecurityContextHolder.getContext().getAuthentication();
    if (authentication instanceof JwtAuthenticationToken token) {
      try {
        provisioner.ensureKnown(
            AuthenticatedUser.id(token.getToken()), token.getToken().getClaimAsString("email"));
      } catch (RuntimeException e) {
        // Domain errors become their problem response; anything unexpected becomes the generic 500.
        resolver.resolveException(request, response, null, e);
        return;
      }
    }
    chain.doFilter(request, response);
  }
}
