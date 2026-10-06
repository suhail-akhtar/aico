package com.example.app.shared.error;

/** The request conflicts with current state (duplicate, stale version). Answers 409. */
public class ConflictException extends DomainException {

  private static final long serialVersionUID = 1L;

  public ConflictException(String code, String message) {
    super(code, message);
  }
}
