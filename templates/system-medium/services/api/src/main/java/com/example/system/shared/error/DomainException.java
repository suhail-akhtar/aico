package com.example.system.shared.error;

/**
 * Base of every error the domain and application layers raise on purpose. It carries a stable
 * machine-readable {@code code}; the web layer decides the HTTP status, so no layer below the API
 * knows about HTTP.
 */
public abstract class DomainException extends RuntimeException {

  private static final long serialVersionUID = 1L;

  private final String code;

  protected DomainException(String code, String message) {
    super(message);
    this.code = code;
  }

  public String code() {
    return code;
  }
}
