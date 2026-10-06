package com.example.system.shared.error;

/** A dependency the request needs (the object store) is not answering. Answers 503. */
public class UnavailableException extends DomainException {

  private static final long serialVersionUID = 1L;

  public UnavailableException(String code, String message) {
    super(code, message);
  }
}
