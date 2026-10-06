package com.example.app.shared;

import static org.assertj.core.api.Assertions.assertThat;

import com.example.app.support.IntegrationTest;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.test.context.TestPropertySource;
import org.springframework.test.web.servlet.assertj.MvcTestResult;

/** Small budgets so the limit is reached in a few calls. Runs in its own application context. */
@TestPropertySource(
    properties = {
      "app.rate-limit.capacity=5",
      "app.rate-limit.refill-per-minute=1",
      "app.rate-limit.auth-capacity=3",
      "app.rate-limit.auth-refill-per-minute=1"
    })
class RateLimitIT extends IntegrationTest {

  @Test
  void loginAttemptsBeyondTheAuthBudgetAre429WithRetryAfter() {
    MvcTestResult last = null;
    for (int i = 0; i < 4; i++) {
      last =
          post("/api/v1/auth/login", null, Map.of("email", "x@example.com", "password", PASSWORD));
    }

    assertProblem(last, HttpStatus.TOO_MANY_REQUESTS, "rate_limited");
    assertThat(Long.parseLong(last.getResponse().getHeader(HttpHeaders.RETRY_AFTER))).isPositive();
  }

  @Test
  void healthProbesStayAvailableWhenTheBudgetIsSpent() {
    for (int i = 0; i < 10; i++) {
      get("/api/v1/items", null);
    }

    assertThat(get("/healthz", null)).hasStatus(HttpStatus.OK);
    assertThat(get("/readyz", null)).hasStatus(HttpStatus.OK);
  }
}
