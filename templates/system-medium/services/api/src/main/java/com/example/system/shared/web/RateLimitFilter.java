package com.example.system.shared.web;

import com.example.system.shared.error.RateLimitExceededException;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import org.springframework.web.filter.OncePerRequestFilter;
import org.springframework.web.servlet.HandlerExceptionResolver;

/**
 * Applies a per-client request budget, with a smaller one on the login endpoints where guessing and
 * redirect-spam are the threat. The client key is the address Spring resolved: behind the proxy,
 * {@code server.forward-headers-strategy} makes it the proxy's {@code X-Forwarded-For} (the proxy
 * overwrites that header, and the API is not reachable except through it). Probes are exempt so a
 * throttled client can never make the platform think the service is down.
 */
public class RateLimitFilter extends OncePerRequestFilter {

  private final RateLimiter api;
  private final RateLimiter auth;
  private final HandlerExceptionResolver resolver;

  public RateLimitFilter(RateLimiter api, RateLimiter auth, HandlerExceptionResolver resolver) {
    this.api = api;
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
    String path = request.getRequestURI();
    boolean login = path.startsWith("/oauth2/") || path.startsWith("/login/");
    RateLimiter.Decision decision = (login ? auth : api).tryAcquire(request.getRemoteAddr());
    if (!decision.allowed()) {
      resolver.resolveException(
          request, response, null, new RateLimitExceededException(decision.retryAfterSeconds()));
      return;
    }
    chain.doFilter(request, response);
  }
}
