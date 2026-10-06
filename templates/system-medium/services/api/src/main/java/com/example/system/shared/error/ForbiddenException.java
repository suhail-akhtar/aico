package com.example.system.shared.error;

/**
 * The caller is known but not allowed to do this right now (a switched-off feature). Answers 403.
 */
public class ForbiddenException extends DomainException {

  private static final long serialVersionUID = 1L;

  public ForbiddenException(String code, String message) {
    super(code, message);
  }
}
