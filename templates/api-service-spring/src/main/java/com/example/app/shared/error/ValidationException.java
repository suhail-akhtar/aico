package com.example.app.shared.error;

import java.util.List;

/** One or more fields broke a business rule. Answers 400 with an {@code errors} list. */
public class ValidationException extends DomainException {

  private static final long serialVersionUID = 1L;

  private final transient List<FieldViolation> violations;

  public ValidationException(List<FieldViolation> violations) {
    super("validation_failed", "Request validation failed");
    this.violations = List.copyOf(violations);
  }

  public List<FieldViolation> violations() {
    return violations;
  }
}
