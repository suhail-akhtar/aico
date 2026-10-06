package com.example.app.shared.error;

/** One invalid field, as shown in the {@code errors} member of a validation problem. */
public record FieldViolation(String field, String message) {}
