package com.example.app.shared.error;

/**
 * Login failed. The message is deliberately the same whether the email is unknown or the password
 * is wrong, so the endpoint cannot be used to enumerate accounts. Answers 401.
 */
public class InvalidCredentialsException extends DomainException {

  private static final long serialVersionUID = 1L;

  public InvalidCredentialsException() {
    super("invalid_credentials", "Invalid email or password");
  }
}
