package com.example.app.shared.web;

import com.example.app.shared.error.RateLimitExceededException;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import org.springframework.web.filter.OncePerRequestFilter;
import org.springframework.web.servlet.HandlerExceptionResolver;

/**
 * Applies a per-client request budget, with a smaller one on the credential endpoints where
 * guessing passwords is the threat. The client key is the socket address: behind a proxy, set
 * {@code server.forward-headers-strategy} deliberately so the proxy's header is trusted, never
 * trust {@code X-Forwarded-For} blindly (a client could pick its own bucket).
 */
public class RateLimitFilter extends OncePerRequestFilter {

  private static final String AUTH_PREFIX = "/api/v1/auth/";

  private final RateLimiter general;
  private final RateLimiter auth;
  private final HandlerExceptionResolver resolver;

  public RateLimitFilter(RateLimiter general, RateLimiter auth, HandlerExceptionResolver resolver) {
    this.general = general;
    this.auth = auth;
    this.resolver = resolver;
  }

  @Override
  protected boolean shouldNotFilter(HttpServletRequest request) {
    String path = request.getRequestURI();
    return path.equals("/healthz") || path.equals("/readyz");
  }

  @Override
  protected void doFilterInternal(
      HttpServletRequest request, HttpServletResponse response, FilterChain chain)
      throws ServletException, IOException {
    String key = request.getRemoteAddr();
    boolean credentialEndpoint =
        request.getRequestURI().startsWith(AUTH_PREFIX) && "POST".equals(request.getMethod());
    RateLimiter.Decision decision =
        credentialEndpoint ? auth.tryAcquire(key) : general.tryAcquire(key);
    if (!decision.allowed()) {
      resolver.resolveException(
          request, response, null, new RateLimitExceededException(decision.retryAfterSeconds()));
      return;
    }
    chain.doFilter(request, response);
  }
}
