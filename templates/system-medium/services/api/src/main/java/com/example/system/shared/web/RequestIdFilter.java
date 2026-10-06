package com.example.system.shared.web;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.util.UUID;
import java.util.regex.Pattern;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.slf4j.MDC;
import org.springframework.core.Ordered;
import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

/**
 * Gives every request an id, puts it in the logging context and echoes it in the response. A
 * caller-supplied {@code X-Request-Id} is kept only if it is short and plain, because the value
 * lands in logs and a hostile one could forge log lines.
 */
@Component
@Order(Ordered.HIGHEST_PRECEDENCE)
public class RequestIdFilter extends OncePerRequestFilter {

  public static final String HEADER = "X-Request-Id";
  public static final String MDC_KEY = "requestId";
  private static final Logger LOG = LoggerFactory.getLogger(RequestIdFilter.class);
  private static final Pattern SAFE = Pattern.compile("[A-Za-z0-9._-]{1,64}");

  @Override
  protected void doFilterInternal(
      HttpServletRequest request, HttpServletResponse response, FilterChain chain)
      throws ServletException, IOException {
    String supplied = request.getHeader(HEADER);
    String id =
        supplied != null && SAFE.matcher(supplied).matches()
            ? supplied
            : UUID.randomUUID().toString();
    MDC.put(MDC_KEY, id);
    response.setHeader(HEADER, id);
    long started = System.nanoTime();
    try {
      chain.doFilter(request, response);
    } finally {
      if (!isProbe(request)) {
        // One line per request, with the request id from the logging context and no user data
        // beyond the method (the path is left out: it can carry ids or personal data).
        LOG.info(
            "request completed method={} status={} durationMs={}",
            request.getMethod(),
            response.getStatus(),
            (System.nanoTime() - started) / 1_000_000);
      }
      MDC.remove(MDC_KEY);
    }
  }

  /** Orchestrator probes arrive every few seconds; logging them is noise. */
  private static boolean isProbe(HttpServletRequest request) {
    String path = request.getRequestURI();
    return "/healthz".equals(path) || "/readyz".equals(path);
  }
}
