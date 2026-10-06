package com.example.app.shared.error;

/**
 * The resource does not exist, or exists but is not the caller's. Both answer 404 so a client
 * cannot probe which ids belong to other users.
 */
public class NotFoundException extends DomainException {

  private static final long serialVersionUID = 1L;

  public NotFoundException(String resource) {
    super("not_found", resource + " not found");
  }
}
