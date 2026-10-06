package com.example.app.shared.web;

import java.io.IOException;

/** A request body went over the configured limit. Answers 413. */
public class PayloadTooLargeException extends IOException {

  private static final long serialVersionUID = 1L;

  public PayloadTooLargeException(long limitBytes) {
    super("Request body exceeds " + limitBytes + " bytes");
  }
}
