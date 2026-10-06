package com.example.system.shared.web;

import static org.assertj.core.api.Assertions.assertThat;

import com.example.system.support.IntegrationTest;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.test.context.TestPropertySource;
import org.springframework.test.web.servlet.assertj.MvcTestResult;
import org.springframework.test.web.servlet.request.RequestPostProcessor;

/**
 * Small budgets, counted in the real Valkey, so the limit is reached in a few calls. Every test
 * calls from its own made-up client address, so counters from other tests (or earlier runs against
 * the same Valkey) cannot interfere.
 */
@TestPropertySource(
    properties = {"app.rate-limit.api-per-minute=5", "app.rate-limit.auth-per-minute=3"})
class RateLimitIT extends IntegrationTest {

  private static final AtomicInteger NEXT = new AtomicInteger(1);

  /** A distinct documentation-range address per test; the filter keys on it. */
  private static String freshAddress() {
    return "198.51.100." + NEXT.getAndIncrement() % 250 + "-" + UUID.randomUUID();
  }

  private static RequestPostProcessor from(String address) {
    return request -> {
      request.setRemoteAddr(address);
      return request;
    };
  }

  private MvcTestResult api(String address) {
    return mvc.get().uri("/api/v1/tasks").with(from(address)).exchange();
  }

  private MvcTestResult login(String address) {
    return mvc.get().uri("/oauth2/authorization/keycloak").with(from(address)).exchange();
  }

  @Test
  void apiCallsBeyondTheBudgetAre429WithRetryAfter() {
    String client = freshAddress();
    for (int i = 0; i < 5; i++) {
      assertThat(api(client)).hasStatus(HttpStatus.UNAUTHORIZED);
    }

    MvcTestResult limited = api(client);

    assertProblem(limited, HttpStatus.TOO_MANY_REQUESTS, "rate_limited");
    long retryAfter = Long.parseLong(limited.getResponse().getHeader(HttpHeaders.RETRY_AFTER));
    assertThat(retryAfter).isBetween(1L, 61L);
  }

  @Test
  void loginAttemptsHaveTheirOwnSmallerBudgetThatDoesNotSpendTheApiOne() {
    String client = freshAddress();
    for (int i = 0; i < 3; i++) {
      assertThat(login(client)).hasStatus(HttpStatus.FOUND);
    }

    assertProblem(login(client), HttpStatus.TOO_MANY_REQUESTS, "rate_limited");
    assertThat(api(client)).hasStatus(HttpStatus.UNAUTHORIZED);
  }

  @Test
  void eachClientHasItsOwnBudget() {
    String noisy = freshAddress();
    String quiet = freshAddress();
    for (int i = 0; i < 6; i++) {
      api(noisy);
    }

    assertProblem(api(noisy), HttpStatus.TOO_MANY_REQUESTS, "rate_limited");
    assertThat(api(quiet)).hasStatus(HttpStatus.UNAUTHORIZED);
  }

  @Test
  void healthProbesStayAvailableWhenTheBudgetIsSpent() {
    String client = freshAddress();
    for (int i = 0; i < 10; i++) {
      api(client);
    }

    assertThat(mvc.get().uri("/healthz").with(from(client)).exchange()).hasStatus(HttpStatus.OK);
    assertThat(mvc.get().uri("/readyz").with(from(client)).exchange()).hasStatus(HttpStatus.OK);
  }
}
