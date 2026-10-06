package com.example.app.shared.web;

import com.example.app.shared.error.AccountDisabledException;
import com.example.app.shared.error.ConflictException;
import com.example.app.shared.error.FieldViolation;
import com.example.app.shared.error.InvalidCredentialsException;
import com.example.app.shared.error.LocalAuthDisabledException;
import com.example.app.shared.error.NotFoundException;
import com.example.app.shared.error.RateLimitExceededException;
import com.example.app.shared.error.ValidationException;
import java.net.URI;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Objects;
import org.jspecify.annotations.Nullable;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.slf4j.MDC;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.dao.OptimisticLockingFailureException;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.HttpStatusCode;
import org.springframework.http.ProblemDetail;
import org.springframework.http.ResponseEntity;
import org.springframework.http.converter.HttpMessageNotReadableException;
import org.springframework.security.access.AccessDeniedException;
import org.springframework.security.core.AuthenticationException;
import org.springframework.security.oauth2.core.OAuth2AuthenticationException;
import org.springframework.web.bind.MethodArgumentNotValidException;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;
import org.springframework.web.context.request.WebRequest;
import org.springframework.web.method.annotation.HandlerMethodValidationException;
import org.springframework.web.servlet.mvc.method.annotation.ResponseEntityExceptionHandler;

/**
 * The single place errors become responses. Every failure, from a bad field to a crashed handler,
 * leaves as an RFC 9457 {@code application/problem+json} body with a stable {@code type} URN, a
 * machine-readable {@code code} and the request id ({@code request_id}, snake_case like every other
 * JSON name in this API) for log correlation. Nothing internal (stack traces, SQL, class names) is
 * ever put in a body: unexpected errors are logged here and answered with a generic 500.
 *
 * <p>Filters (security, rate limit, body size) reach this class too, by handing their exception to
 * the {@code HandlerExceptionResolver}, so a 401 from the filter chain looks like a 404 from a
 * controller.
 */
@RestControllerAdvice
public class ProblemDetailsAdvice extends ResponseEntityExceptionHandler {

  private static final Logger LOG = LoggerFactory.getLogger(ProblemDetailsAdvice.class);

  @ExceptionHandler(ValidationException.class)
  ResponseEntity<ProblemDetail> validation(ValidationException ex) {
    ProblemDetail problem = problem(HttpStatus.BAD_REQUEST, ex.code(), ex.getMessage());
    problem.setProperty("errors", ex.violations());
    return ResponseEntity.badRequest().body(problem);
  }

  @ExceptionHandler(NotFoundException.class)
  ResponseEntity<ProblemDetail> notFound(NotFoundException ex) {
    return respond(HttpStatus.NOT_FOUND, ex.code(), ex.getMessage());
  }

  @ExceptionHandler(LocalAuthDisabledException.class)
  ResponseEntity<ProblemDetail> localAuthDisabled(LocalAuthDisabledException ex) {
    return respond(HttpStatus.NOT_FOUND, ex.code(), ex.getMessage());
  }

  @ExceptionHandler(AccountDisabledException.class)
  ResponseEntity<ProblemDetail> accountDisabled(AccountDisabledException ex) {
    return respond(HttpStatus.FORBIDDEN, ex.code(), ex.getMessage());
  }

  @ExceptionHandler(ConflictException.class)
  ResponseEntity<ProblemDetail> conflict(ConflictException ex) {
    return respond(HttpStatus.CONFLICT, ex.code(), ex.getMessage());
  }

  @ExceptionHandler({
    OptimisticLockingFailureException.class,
    DataIntegrityViolationException.class
  })
  ResponseEntity<ProblemDetail> dataConflict(Exception ex) {
    LOG.warn("Data conflict: {}", ex.getClass().getSimpleName());
    return respond(
        HttpStatus.CONFLICT, "conflict", "The resource was changed by someone else; reload it.");
  }

  @ExceptionHandler(InvalidCredentialsException.class)
  ResponseEntity<ProblemDetail> invalidCredentials(InvalidCredentialsException ex) {
    return respond(HttpStatus.UNAUTHORIZED, ex.code(), ex.getMessage());
  }

  @ExceptionHandler(RateLimitExceededException.class)
  ResponseEntity<ProblemDetail> rateLimited(RateLimitExceededException ex) {
    return ResponseEntity.status(HttpStatus.TOO_MANY_REQUESTS)
        .header(HttpHeaders.RETRY_AFTER, Long.toString(ex.retryAfterSeconds()))
        .body(problem(HttpStatus.TOO_MANY_REQUESTS, ex.code(), ex.getMessage()));
  }

  @ExceptionHandler(AuthenticationException.class)
  ResponseEntity<ProblemDetail> unauthenticated(AuthenticationException ex) {
    boolean badToken = ex instanceof OAuth2AuthenticationException;
    String challenge = badToken ? "Bearer error=\"invalid_token\"" : "Bearer";
    return ResponseEntity.status(HttpStatus.UNAUTHORIZED)
        .header(HttpHeaders.WWW_AUTHENTICATE, challenge)
        .body(
            problem(
                HttpStatus.UNAUTHORIZED,
                "unauthenticated",
                badToken ? "The access token is invalid or expired." : "Authentication required."));
  }

  @ExceptionHandler(AccessDeniedException.class)
  ResponseEntity<ProblemDetail> forbidden(AccessDeniedException ex) {
    return respond(HttpStatus.FORBIDDEN, "forbidden", "You are not allowed to do that.");
  }

  @ExceptionHandler(PayloadTooLargeException.class)
  ResponseEntity<ProblemDetail> tooLarge(PayloadTooLargeException ex) {
    return respond(HttpStatus.CONTENT_TOO_LARGE, "payload_too_large", ex.getMessage());
  }

  @ExceptionHandler(Exception.class)
  ResponseEntity<ProblemDetail> unexpected(Exception ex) {
    LOG.error("Unhandled exception", ex);
    return respond(
        HttpStatus.INTERNAL_SERVER_ERROR, "internal_error", "An unexpected error occurred.");
  }

  @Override
  protected @Nullable ResponseEntity<Object> handleMethodArgumentNotValid(
      MethodArgumentNotValidException ex,
      HttpHeaders headers,
      HttpStatusCode status,
      WebRequest request) {
    List<FieldViolation> violations = new ArrayList<>();
    ex.getBindingResult()
        .getFieldErrors()
        .forEach(
            e -> violations.add(new FieldViolation(e.getField(), message(e.getDefaultMessage()))));
    ex.getBindingResult()
        .getGlobalErrors()
        .forEach(
            e ->
                violations.add(
                    new FieldViolation(e.getObjectName(), message(e.getDefaultMessage()))));
    ex.getBody().setDetail("Request validation failed");
    ex.getBody().setProperty("errors", violations);
    return handleExceptionInternal(ex, null, headers, status, request);
  }

  @Override
  protected @Nullable ResponseEntity<Object> handleHandlerMethodValidationException(
      HandlerMethodValidationException ex,
      HttpHeaders headers,
      HttpStatusCode status,
      WebRequest request) {
    List<FieldViolation> violations = new ArrayList<>();
    ex.getParameterValidationResults()
        .forEach(
            result -> {
              String name =
                  Objects.requireNonNullElse(
                      result.getMethodParameter().getParameterName(), "parameter");
              result
                  .getResolvableErrors()
                  .forEach(
                      e ->
                          violations.add(new FieldViolation(name, message(e.getDefaultMessage()))));
            });
    ex.getBody().setDetail("Request validation failed");
    ex.getBody().setProperty("errors", violations);
    return handleExceptionInternal(ex, null, headers, status, request);
  }

  @Override
  protected @Nullable ResponseEntity<Object> handleHttpMessageNotReadable(
      HttpMessageNotReadableException ex,
      HttpHeaders headers,
      HttpStatusCode status,
      WebRequest request) {
    for (Throwable t = ex; t != null; t = t.getCause()) {
      if (t instanceof PayloadTooLargeException tooLarge) {
        HttpStatus large = HttpStatus.CONTENT_TOO_LARGE;
        ProblemDetail problem = problem(large, "payload_too_large", tooLarge.getMessage());
        return ResponseEntity.status(large).body(problem);
      }
    }
    return ResponseEntity.badRequest()
        .body(
            problem(
                HttpStatus.BAD_REQUEST,
                "bad_request",
                "The request body is missing or malformed."));
  }

  /** Adds the code and the request id to the problems Spring MVC builds itself. */
  @Override
  protected @Nullable ResponseEntity<Object> handleExceptionInternal(
      Exception ex,
      @Nullable Object body,
      HttpHeaders headers,
      HttpStatusCode statusCode,
      WebRequest request) {
    ResponseEntity<Object> response =
        super.handleExceptionInternal(ex, body, headers, statusCode, request);
    if (response != null && response.getBody() instanceof ProblemDetail problem) {
      enrich(problem, codeFor(statusCode));
    }
    return response;
  }

  private static ResponseEntity<ProblemDetail> respond(
      HttpStatus status, String code, @Nullable String detail) {
    return ResponseEntity.status(status).body(problem(status, code, detail));
  }

  private static ProblemDetail problem(HttpStatus status, String code, @Nullable String detail) {
    ProblemDetail problem = ProblemDetail.forStatusAndDetail(status, detail);
    problem.setTitle(status.getReasonPhrase());
    enrich(problem, code);
    return problem;
  }

  private static void enrich(ProblemDetail problem, String code) {
    problem.setType(URI.create("urn:problem-type:" + code.replace('_', '-')));
    problem.setProperty("code", code);
    String correlationId = MDC.get(RequestIdFilter.MDC_KEY);
    if (correlationId != null) {
      problem.setProperty("request_id", correlationId);
    }
  }

  private static String codeFor(HttpStatusCode status) {
    HttpStatus resolved = HttpStatus.resolve(status.value());
    return resolved == null
        ? "error"
        : resolved.getReasonPhrase().toLowerCase(Locale.ROOT).replace(' ', '_');
  }

  private static String message(@Nullable String message) {
    return message == null ? "invalid" : message;
  }
}
