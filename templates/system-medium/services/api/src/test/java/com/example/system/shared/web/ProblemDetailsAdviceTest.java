package com.example.system.shared.web;

import static org.assertj.core.api.Assertions.assertThat;

import com.example.system.shared.error.ConflictException;
import com.example.system.shared.error.FieldViolation;
import com.example.system.shared.error.NotFoundException;
import com.example.system.shared.error.RateLimitExceededException;
import com.example.system.shared.error.ValidationException;
import java.util.List;
import org.junit.jupiter.api.Test;
import org.slf4j.MDC;
import org.springframework.dao.OptimisticLockingFailureException;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.ProblemDetail;
import org.springframework.http.ResponseEntity;
import org.springframework.security.access.AccessDeniedException;
import org.springframework.security.authentication.BadCredentialsException;
import org.springframework.security.authentication.InsufficientAuthenticationException;
import org.springframework.security.core.AuthenticationException;
import org.springframework.security.oauth2.core.OAuth2AuthenticationException;

/** Status, code and shape of each handler, without a web layer. */
class ProblemDetailsAdviceTest {

  private final ProblemDetailsAdvice advice = new ProblemDetailsAdvice();

  private static ProblemDetail problem(ResponseEntity<ProblemDetail> response) {
    ProblemDetail body = response.getBody();
    assertThat(body).isNotNull();
    return body;
  }

  private static Object property(ProblemDetail problem, String name) {
    return problem.getProperties() == null ? null : problem.getProperties().get(name);
  }

  @Test
  void validationCarriesTheFieldList() {
    var response =
        advice.validation(new ValidationException(List.of(new FieldViolation("name", "blank"))));

    assertThat(response.getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
    assertThat(property(problem(response), "errors"))
        .isEqualTo(List.of(new FieldViolation("name", "blank")));
    assertThat(property(problem(response), "code")).isEqualTo("validation_failed");
  }

  @Test
  void notFoundAndConflictMapToTheirStatuses() {
    assertThat(advice.notFound(new NotFoundException("Item")).getStatusCode())
        .isEqualTo(HttpStatus.NOT_FOUND);
    assertThat(advice.conflict(new ConflictException("x", "y")).getStatusCode())
        .isEqualTo(HttpStatus.CONFLICT);
  }

  @Test
  void anOptimisticLockFailureIsAConflictThatNamesNoInternals() {
    var response = advice.dataConflict(new OptimisticLockingFailureException("row 17 of items"));

    assertThat(response.getStatusCode()).isEqualTo(HttpStatus.CONFLICT);
    assertThat(String.valueOf(problem(response).getDetail())).doesNotContain("row 17");
  }

  @Test
  void rateLimitSetsRetryAfter() {
    var response = advice.rateLimited(new RateLimitExceededException(7));

    assertThat(response.getStatusCode()).isEqualTo(HttpStatus.TOO_MANY_REQUESTS);
    assertThat(response.getHeaders().getFirst(HttpHeaders.RETRY_AFTER)).isEqualTo("7");
  }

  @Test
  void unauthenticatedChallengesWithBearerAndFlagsAnInvalidToken() {
    var missing = advice.unauthenticated(new InsufficientAuthenticationException("no token"));
    var bad = advice.unauthenticated(new OAuth2AuthenticationException("invalid_token"));
    AuthenticationException other = new BadCredentialsException("x");

    assertThat(missing.getHeaders().getFirst(HttpHeaders.WWW_AUTHENTICATE)).isEqualTo("Bearer");
    assertThat(bad.getHeaders().getFirst(HttpHeaders.WWW_AUTHENTICATE))
        .isEqualTo("Bearer error=\"invalid_token\"");
    assertThat(advice.unauthenticated(other).getStatusCode()).isEqualTo(HttpStatus.UNAUTHORIZED);
  }

  @Test
  void forbiddenIsGeneric() {
    var response = advice.forbidden(new AccessDeniedException("secret reason"));

    assertThat(response.getStatusCode()).isEqualTo(HttpStatus.FORBIDDEN);
    assertThat(String.valueOf(problem(response).getDetail())).doesNotContain("secret reason");
  }

  @Test
  void anUnexpectedErrorIsAGenericFiveHundredWithoutTheMessage() {
    var response =
        advice.unexpected(new IllegalStateException("password=hunter2 jdbc:postgresql://db"));

    assertThat(response.getStatusCode()).isEqualTo(HttpStatus.INTERNAL_SERVER_ERROR);
    assertThat(String.valueOf(problem(response).getDetail())).doesNotContain("hunter2", "jdbc");
  }

  @Test
  void tooLargeIsFourThirteen() {
    assertThat(advice.tooLarge(new PayloadTooLargeException(10)).getStatusCode())
        .isEqualTo(HttpStatus.CONTENT_TOO_LARGE);
  }

  @Test
  void problemsCarryTheRequestIdFromTheLoggingContext() {
    MDC.put(RequestIdFilter.MDC_KEY, "req-1");
    try {
      var response = advice.notFound(new NotFoundException("Item"));

      assertThat(property(problem(response), "requestId")).isEqualTo("req-1");
      assertThat(problem(response).getType().toString()).isEqualTo("urn:problem-type:not-found");
    } finally {
      MDC.remove(RequestIdFilter.MDC_KEY);
    }
  }
}
